// Read-only status page. Reads only the state files named here, so the token is never served. Listens on 8080 inside
// the container; the container publishes it on 127.0.0.1 only, because build output is unauthenticated.
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { join } from 'node:path';

const tail = (text, n) => text.trimEnd().split('\n').slice(-n).filter(Boolean);

export function serveStatus(cfg, dir, port = 8080) {
  const read = (name) => readFile(join(dir, name), 'utf8').catch(() => '');
  const containers = () =>
    new Promise((resolve) => {
      execFile(
        'docker',
        ['ps', '-a', '--filter', `label=com.docker.compose.project=${cfg.compose.project}`, '--format', '{{.Names}}\t{{.Status}}'],
        (err, out) => resolve(err ? [] : tail(out, 50).map((l) => l.split('\t')).sort()),
      );
    });

  async function status() {
    const [raw, events, build, deployed, lastCheck, incoming, planned, stack] = await Promise.all([
      read('status.json'),
      read('events.log'),
      read('build.log'),
      read('deployed'),
      read('last-check'),
      read('incoming'),
      read('plan'),
      containers(),
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
      branch: cfg.git.branch,
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

  const server = createServer(async (req, res) => {
    if (req.url === '/status.json') {
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

const PAGE = `<!doctype html><html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Reload status</title><style>
:root{color-scheme:light dark}body{font:15px system-ui;margin:0 auto;max-width:860px;padding:16px;background:Canvas;color:CanvasText}
#badge{display:inline-block;padding:2px 10px;border-radius:9px;color:#fff;background:#666;font-weight:600}
#badge.idle{background:#1a7f37}#badge.working{background:#0969da}#badge.failed{background:#cf222e}#badge.blocked{background:#9a6700}
pre{overflow-x:auto;background:#8882;padding:8px;font-size:12px}table{border-collapse:collapse}td{padding:2px 16px 2px 0}h2{font-size:15px;margin:20px 0 6px}
#links a{margin-right:12px}
</style><h1 id="title">Reload stack</h1><p><span id="badge"></span> <span id="step"></span></p>
<p id="meta"></p><p id="links"></p>
<h2>Containers</h2><table id="containers"></table><h2>Recent activity</h2><table id="events"></table><h2>Latest build output</h2><pre id="build"></pre>
<script>
const $=(id)=>document.getElementById(id);
const time=(s)=>s?new Date(s*1000).toLocaleTimeString():'never';
const rows=(el,data)=>el.replaceChildren(...data.map((cells)=>{const r=document.createElement('tr');
  for(const c of cells){const d=document.createElement('td');d.textContent=c;r.append(d)}return r}));
async function tick(){try{const s=await(await fetch('/status.json')).json();
  document.title='Reload: '+s.name;$('title').textContent='Reload: '+s.name;
  $('badge').textContent=s.state;$('badge').className=s.state;$('step').textContent=s.step;
  const mins=s.since?Math.floor((Date.now()/1000-s.since)/60):0;
  $('meta').textContent='Running: '+(s.deployed?s.branch+' '+s.deployed+(s.incoming?' (from '+s.incoming+')':''):'none')
    +(s.plan?' · Last plan: '+s.plan:'')+' · Last check: '+time(s.lastCheck)+(s.state==='working'?' · This step: '+mins+' min':'');
  $('links').replaceChildren(...s.links.map((l)=>{const a=document.createElement('a');a.href=l.url;a.textContent=l.label;return a}));
  rows($('containers'),s.containers);rows($('events'),s.events.map(([t,m])=>[time(t),m]));
  $('build').textContent=s.build.join('\\n')}catch{$('badge').textContent='poller not responding';$('badge').className='failed';$('step').textContent=''}}
tick();setInterval(tick,3000);
</script></html>`;
