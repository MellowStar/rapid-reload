// Status page. Reads only the state files named here, so the token is never served. Listens on 8080 inside the
// container; the container publishes it on 127.0.0.1 only, because build output is unauthenticated.
// It can change one setting, git.branch in the config file, and ask for a rebuild. Both are POSTs that need a JSON body,
// a custom header and a loopback Host, so another web page open in the browser can't trigger them.
import { createServer } from 'node:http';
import { chmodSync, chownSync, readFileSync, renameSync, statSync, writeFileSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { basename, dirname, join } from 'node:path';
import { withBranch } from './config.mjs';

const tail = (text, n) => text.trimEnd().split('\n').slice(-n).filter(Boolean);
const LOOPBACK = /^(127\.0\.0\.1|localhost|\[::1\])(:\d+)?$/;

/** Rewrites the config file with a new git.branch, keeping its owner and mode. Throws with a readable message. */
function saveBranch(file, branch) {
  let raw;
  try {
    raw = JSON.parse(readFileSync(file, 'utf8'));
  } catch (e) {
    throw new Error(`Couldn't read the config file: ${e.message}`);
  }
  const { raw: next, errors } = withBranch(raw, branch);
  if (errors.length) throw new Error(errors.join('; '));
  const tmp = join(dirname(file), `.${basename(file)}.tmp`);
  try {
    const st = statSync(file);
    writeFileSync(tmp, JSON.stringify(next, null, 2) + '\n');
    chmodSync(tmp, st.mode & 0o7777);
    try {
      chownSync(tmp, st.uid, st.gid);
    } catch {}
    renameSync(tmp, file);
  } catch (e) {
    throw new Error(`Couldn't write the config file: ${e.code === 'EROFS' ? 'its folder is mounted read-only; rerun rapid-reload start' : e.message}`);
  }
  return next.git.branch;
}

export function serveStatus(cfg, dir, { port = 8080, sourceConfig = '', onRebuild = () => {} } = {}) {
  const read = (name) => readFile(join(dir, name), 'utf8').catch(() => '');
  const liveBranch = async () => {
    try {
      return JSON.parse(await readFile(sourceConfig, 'utf8')).git?.branch ?? cfg.git.branch;
    } catch {
      return cfg.git.branch;
    }
  };
  const containers = () =>
    new Promise((resolve) => {
      execFile(
        'docker',
        ['ps', '-a', '--filter', `label=com.docker.compose.project=${cfg.compose.project}`, '--format', '{{.Names}}\t{{.Status}}'],
        (err, out) => resolve(err ? [] : tail(out, 50).map((l) => l.split('\t')).sort()),
      );
    });

  async function status() {
    const [raw, events, build, deployed, lastCheck, incoming, planned, stack, branch, rebuild] = await Promise.all([
      read('status.json'),
      read('events.log'),
      read('build.log'),
      read('deployed'),
      read('last-check'),
      read('incoming'),
      read('plan'),
      containers(),
      liveBranch(),
      read('rebuild'),
    ]);
    let s = {};
    let p = {};
    try {
      s = JSON.parse(raw);
    } catch {}
    try {
      p = JSON.parse(planned);
    } catch {}
    const sha = deployed.trim();
    return {
      name: cfg.name,
      state: s.state ?? 'starting',
      step: s.step ?? 'Starting',
      since: s.since ?? null,
      branch,
      canEditBranch: Boolean(sourceConfig),
      rebuildQueued: Boolean(rebuild),
      deployed: sha.slice(0, 7),
      // Saved as "<commit> <branch>"; ignored unless it describes the running commit.
      incoming: sha && incoming.startsWith(sha + ' ') ? incoming.trim().slice(sha.length + 1) : '',
      plan: p.action ? `${p.action} (${p.reason})` : '',
      lastCheck: Number(lastCheck) || null,
      links: cfg.statusPage.links,
      containers: stack,
      events: tail(events, 25).reverse().map((l) => [Number(l.slice(0, l.indexOf(' '))), l.slice(l.indexOf(' ') + 1)]),
      build: tail(build, 40),
    };
  }

  const body = (req) =>
    new Promise((resolve, reject) => {
      let data = '';
      req.on('data', (c) => {
        data += c;
        if (data.length > 4096) reject(new Error('Request too large'));
      });
      req.on('end', () => {
        try {
          resolve(data ? JSON.parse(data) : {});
        } catch {
          reject(new Error('Request body is not JSON'));
        }
      });
      req.on('error', reject);
    });
  const reply = (res, code, payload) => {
    res.statusCode = code;
    res.setHeader('content-type', 'application/json');
    res.end(JSON.stringify(payload));
  };
  const allowed = (req) =>
    LOOPBACK.test(req.headers.host ?? '') &&
    req.headers['x-rapid-reload'] === '1' &&
    (req.headers['content-type'] ?? '').startsWith('application/json') &&
    (!req.headers.origin || req.headers.origin === `http://${req.headers.host}`);

  async function action(req, res) {
    if (!allowed(req)) return reply(res, 403, { ok: false, error: 'Refused: only the status page itself can do this.' });
    try {
      const input = await body(req);
      if (req.url === '/api/branch') {
        if (!sourceConfig) throw new Error('This poller has no config file to write to; rerun rapid-reload start.');
        const branch = saveBranch(sourceConfig, input.branch);
        writeFileSync(join(dir, 'events.log'), `${Math.floor(Date.now() / 1000)} Branch set to ${branch} from the status page\n`, { flag: 'a' });
        onRebuild();
        return reply(res, 200, { ok: true, branch });
      }
      writeFileSync(join(dir, 'rebuild'), String(Math.floor(Date.now() / 1000)));
      writeFileSync(join(dir, 'events.log'), `${Math.floor(Date.now() / 1000)} Rebuild requested from the status page\n`, { flag: 'a' });
      onRebuild();
      return reply(res, 200, { ok: true });
    } catch (e) {
      return reply(res, 400, { ok: false, error: e.message });
    }
  }

  const server = createServer(async (req, res) => {
    if (req.method === 'POST' && (req.url === '/api/branch' || req.url === '/api/rebuild')) {
      await action(req, res);
    } else if (req.method !== 'GET') {
      res.statusCode = 405;
      res.end();
    } else if (req.url === '/status.json') {
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify(await status()));
    } else if (req.url === '/') {
      res.setHeader('content-type', 'text/html; charset=utf-8');
      res.end(PAGE);
    } else {
      res.statusCode = 404;
      res.end();
    }
  });
  server.listen(port);
  return server;
}

// Styled after the TanStack sites (slate surfaces, gradient title, rounded cards), inline and dependency-free.
const PAGE = `<!doctype html><html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Reload status</title><style>
:root{color-scheme:light dark;--bg:#f8fafc;--card:#fff;--line:#e2e8f0;--text:#0f172a;--muted:#64748b;--code:#f1f5f9;
  --accent:#0ea5e9;--ok:#10b981;--work:#3b82f6;--bad:#ef4444;--warn:#f59e0b}
@media (prefers-color-scheme:dark){:root{--bg:#020617;--card:#0f172a;--line:#1e293b;--text:#e2e8f0;--muted:#94a3b8;--code:#020617}}
*{box-sizing:border-box}
body{margin:0;background:var(--bg);color:var(--text);font:15px/1.5 Inter,ui-sans-serif,system-ui,-apple-system,"Segoe UI",sans-serif}
main{max-width:960px;margin:0 auto;padding:32px 16px 48px}
h1{margin:0 0 4px;font-size:clamp(26px,5vw,38px);font-weight:900;letter-spacing:-.03em;
  background:linear-gradient(90deg,#f59e0b,#ef4444,#ec4899,#8b5cf6);-webkit-background-clip:text;background-clip:text;color:transparent}
.sub{color:var(--muted);margin:0 0 24px}
.grid{display:grid;gap:16px;grid-template-columns:repeat(auto-fit,minmax(280px,1fr))}
.card{background:var(--card);border:1px solid var(--line);border-radius:14px;padding:18px;box-shadow:0 1px 2px #0000000d;margin-bottom:16px;min-width:0}
.card h2{margin:0 0 12px;font-size:12px;font-weight:700;text-transform:uppercase;letter-spacing:.08em;color:var(--muted)}
.badge{display:inline-flex;align-items:center;gap:6px;padding:3px 12px;border-radius:999px;font-size:13px;font-weight:700;color:#fff;background:var(--muted)}
.badge::before{content:"";width:7px;height:7px;border-radius:50%;background:currentColor;opacity:.8}
.idle{background:var(--ok)}.working{background:var(--work)}.failed{background:var(--bad)}.blocked{background:var(--warn)}
#step{margin:10px 0 0;font-weight:600}#meta{color:var(--muted);font-size:13px;margin:6px 0 0;overflow-wrap:anywhere}
form{display:flex;gap:8px;flex-wrap:wrap}
input{flex:1 1 180px;min-width:0;padding:9px 12px;border-radius:10px;border:1px solid var(--line);background:var(--bg);color:var(--text);font:inherit}
input:focus{outline:2px solid var(--accent);outline-offset:1px}
button{padding:9px 16px;border-radius:10px;border:0;font:inherit;font-weight:700;cursor:pointer;color:#fff;background:var(--text)}
@media (prefers-color-scheme:dark){button{color:#020617}}
button.primary{background:linear-gradient(90deg,#0ea5e9,#8b5cf6);color:#fff}
button:disabled{opacity:.55;cursor:wait}
.msg{margin:10px 0 0;font-size:13px;min-height:1.2em}.msg.err{color:var(--bad)}.msg.ok{color:var(--ok)}
.hint{color:var(--muted);font-size:13px;margin:8px 0 0}
#links{display:flex;flex-wrap:wrap;gap:8px}#links a{padding:4px 12px;border-radius:999px;border:1px solid var(--line);color:var(--accent);text-decoration:none;font-weight:600;font-size:13px}
table{border-collapse:collapse;width:100%;font-size:13px}td{padding:6px 12px 6px 0;border-top:1px solid var(--line);vertical-align:top;overflow-wrap:anywhere}
tr:first-child td{border-top:0}td:first-child{white-space:nowrap;color:var(--muted)}
pre{margin:0;overflow-x:auto;background:var(--code);border:1px solid var(--line);border-radius:10px;padding:12px;font:12px/1.5 ui-monospace,SFMono-Regular,Menlo,monospace}
</style><main>
<h1 id="title">Reload stack</h1><p class="sub">Keeps this stack on the latest commit of a branch.</p>
<section class="card"><span id="badge" class="badge">loading</span><p id="step"></p><p id="meta"></p></section>
<div class="grid">
<section class="card"><h2>Branch</h2><form id="branchForm"><input id="branch" name="branch" autocomplete="off" spellcheck="false" aria-label="Git branch" required>
<button id="save" type="submit">Save</button></form><p class="hint">Saved to git.branch in the config file. The stack switches on the next check, which starts now.</p><p id="branchMsg" class="msg" role="status"></p></section>
<section class="card"><h2>Rebuild</h2><button id="rebuild" class="primary" type="button">Rebuild now</button>
<p class="hint">Builds and restarts the services at the branch's latest commit, even if nothing changed. Data is kept unless paths.reset matches.</p><p id="rebuildMsg" class="msg" role="status"></p></section>
</div>
<section class="card" id="linksCard" hidden><h2>Links</h2><div id="links"></div></section>
<section class="card"><h2>Containers</h2><table id="containers"></table></section>
<section class="card"><h2>Recent activity</h2><table id="events"></table></section>
<section class="card"><h2>Latest build output</h2><pre id="build"></pre></section>
</main>
<script>
const $=(id)=>document.getElementById(id);
const time=(s)=>s?new Date(s*1000).toLocaleTimeString():'never';
const rows=(el,data)=>el.replaceChildren(...data.map((cells)=>{const r=document.createElement('tr');
  for(const c of cells){const d=document.createElement('td');d.textContent=c;r.append(d)}return r}));
const say=(el,text,ok)=>{el.textContent=text;el.className='msg '+(ok?'ok':'err')};
let editing=false;
async function post(path,payload){
  let r;try{r=await fetch(path,{method:'POST',headers:{'content-type':'application/json','x-rapid-reload':'1'},body:JSON.stringify(payload)})}
  catch{throw new Error('The poller is not responding.')}
  const out=await r.json().catch(()=>({}));
  if(!r.ok||!out.ok)throw new Error(out.error||('Request failed ('+r.status+')'));
  return out}
$('branch').addEventListener('input',()=>{editing=true});
$('branchForm').addEventListener('submit',async(e)=>{e.preventDefault();const b=$('branch').value.trim();if(!b)return;
  $('save').disabled=true;say($('branchMsg'),'Saving…',true);
  try{const out=await post('/api/branch',{branch:b});editing=false;$('branch').value=out.branch;say($('branchMsg'),'Saved. Now following '+out.branch+'.',true);tick()}
  catch(err){say($('branchMsg'),'Failed to update the branch: '+err.message,false)}
  finally{$('save').disabled=false}});
$('rebuild').addEventListener('click',async()=>{$('rebuild').disabled=true;say($('rebuildMsg'),'Requesting…',true);
  try{await post('/api/rebuild',{});say($('rebuildMsg'),'Rebuild requested. Progress shows above.',true);tick()}
  catch(err){say($('rebuildMsg'),'Failed to request a rebuild: '+err.message,false)}
  finally{$('rebuild').disabled=false}});
async function tick(){try{const s=await(await fetch('/status.json')).json();
  document.title='Reload: '+s.name;$('title').textContent='Reload: '+s.name;
  $('badge').textContent=s.state;$('badge').className='badge '+s.state;$('step').textContent=s.step;
  if(!editing&&document.activeElement!==$('branch'))$('branch').value=s.branch;
  $('branch').disabled=$('save').disabled=!s.canEditBranch;
  const mins=s.since?Math.floor((Date.now()/1000-s.since)/60):0;
  $('meta').textContent='Following: '+s.branch+' · Running: '+(s.deployed?s.deployed+(s.incoming?' (from '+s.incoming+')':''):'none')
    +(s.plan?' · Last plan: '+s.plan:'')+' · Last check: '+time(s.lastCheck)+(s.state==='working'?' · This step: '+mins+' min':'')
    +(s.rebuildQueued?' · Rebuild queued':'');
  $('linksCard').hidden=!s.links.length;
  $('links').replaceChildren(...s.links.map((l)=>{const a=document.createElement('a');a.href=l.url;a.textContent=l.label;return a}));
  rows($('containers'),s.containers);rows($('events'),s.events.map(([t,m])=>[time(t),m]));
  $('build').textContent=s.build.join('\\n')}catch{$('badge').textContent='poller not responding';$('badge').className='badge failed';$('step').textContent=''}}
tick();setInterval(tick,3000);
</script></html>`;
