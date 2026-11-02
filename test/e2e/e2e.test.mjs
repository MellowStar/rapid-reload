// End to end against real Docker: copies examples/basic into a Git repo, pushes it to a local bare remote, starts the
// poller and checks what each kind of commit does. Run with `npm run test:e2e`. Takes a few minutes the first time.
import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { appendFileSync, cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { setTimeout as sleep } from 'node:timers/promises';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
// RAPID_RELOAD_BIN tests an installed copy (for example from `npm pack`) instead of this checkout.
const BIN = process.env.RAPID_RELOAD_BIN ?? join(ROOT, 'bin', 'rapid-reload.mjs');
const skip = process.env.RAPID_RELOAD_E2E !== '1' && 'set RAPID_RELOAD_E2E=1 (npm run test:e2e)';

const sh = (cmd, args, opts = {}) => {
  const r = spawnSync(cmd, args, { encoding: 'utf8', ...opts });
  return { code: r.status, out: (r.stdout ?? '').trim(), err: (r.stderr ?? '').trim() };
};
const must = (cmd, args, opts) => {
  const r = sh(cmd, args, opts);
  if (r.code !== 0) throw new Error(`${cmd} ${args.join(' ')}: ${r.err || r.out}`);
  return r.out;
};
const freePort = () =>
  new Promise((resolve) => {
    const s = createServer();
    s.listen(0, '127.0.0.1', () => {
      const { port } = s.address();
      s.close(() => resolve(port));
    });
  });

let tmp, work, state, cfgFile, project, webPort;
const id = Math.random().toString(16).slice(2, 8);
const read = (name) => (existsSync(join(state, name)) ? readFileSync(join(state, name), 'utf8').trim() : '');
const cli = (...args) => sh(process.execPath, [BIN, ...args, '--config', cfgFile]);
const planned = () => JSON.parse(read('plan') || '{}').action;
const status = () => JSON.parse(read('status.json') || '{}');

function commit(files, message) {
  for (const [path, content] of Object.entries(files)) {
    const full = join(work, path);
    if (content === null) rmSync(full, { force: true });
    else {
      mkdirSync(dirname(full), { recursive: true });
      writeFileSync(full, content);
    }
  }
  must('git', ['add', '-A'], { cwd: work });
  must('git', ['commit', '-qm', message], { cwd: work });
  must('git', ['push', '-q', 'origin', 'HEAD:pre-merge'], { cwd: work });
  return must('git', ['rev-parse', 'HEAD'], { cwd: work });
}

/** service -> { id, started } */
function containers() {
  const ids = must('docker', ['ps', '-aq', '--filter', `label=com.docker.compose.project=${project}`]).split('\n').filter(Boolean);
  if (!ids.length) return {};
  const out = must('docker', ['inspect', '-f', '{{index .Config.Labels "com.docker.compose.service"}} {{.Id}} {{.State.StartedAt}}', ...ids]);
  return Object.fromEntries(out.split('\n').map((l) => l.split(' ')).map(([s, i, t]) => [s, { id: i, started: t }]));
}
const marks = () =>
  must('docker', ['compose', '-p', project, 'exec', '-T', 'db', 'psql', '-U', 'postgres', '-Atc', 'SELECT name FROM marks ORDER BY 1']).split('\n').filter(Boolean);

async function waitForDeployed(sha, minutes = 15) {
  const end = Date.now() + minutes * 60_000;
  while (Date.now() < end) {
    if (read('deployed') === sha && status().state === 'idle') return;
    if (status().state === 'failed') throw new Error(`update failed: ${status().step}\n${read('build.log').split('\n').slice(-30).join('\n')}`);
    await sleep(2000);
  }
  throw new Error(`timed out waiting for ${sha}`);
}

before(async () => {
  if (skip) return;
  tmp = realpathSync(mkdtempSync(join(tmpdir(), 'ppe2e-')));
  work = join(tmp, 'work');
  state = join(tmp, 'state');
  project = `ppe2e-${id}`;
  webPort = await freePort();
  cpSync(join(ROOT, 'examples', 'basic'), work, { recursive: true });
  rmSync(join(work, 'rapid-reload.config.json'));
  mkdirSync(state);
  must('git', ['init', '-q', '--bare', '-b', 'pre-merge', join(state, 'remote.git')]);
  must('git', ['init', '-q', '-b', 'main'], { cwd: work });
  must('git', ['config', 'user.email', 'e2e@example.test'], { cwd: work });
  must('git', ['config', 'user.name', 'e2e'], { cwd: work });
  must('git', ['remote', 'add', 'origin', join(state, 'remote.git')], { cwd: work });
  cfgFile = join(tmp, 'rapid-reload.config.json');
  writeFileSync(
    cfgFile,
    JSON.stringify({
      name: `e2e-${id}`,
      stateDir: state,
      pollIntervalSeconds: 3600,
      git: { remote: join(state, 'remote.git'), branch: 'pre-merge' },
      compose: { project, services: ['web', 'worker', 'db'], env: { WEB_PORT: String(webPort) } },
      paths: { ignore: ['**/*.md'], reset: ['db/**'] },
      hooks: {
        reset: [{ label: 'Starting the database', run: 'bash scripts/reset.sh' }],
        afterReset: [{ label: 'Adding test data', run: 'bash scripts/seed.sh' }],
        afterUpdate: [{ label: 'Checking the hook switch', run: 'test ! -e fail-hook' }],
      },
      statusPage: { port: await freePort() },
    }),
  );
});

after(() => {
  if (skip || !cfgFile) return;
  cli('uninstall', '--yes');
  sh('docker', ['compose', '-p', project, 'down', '-v', '--remove-orphans']);
  rmSync(tmp, { recursive: true, force: true });
});

test('start refuses the dev stack project name and a busy status port', { skip }, async () => {
  const base = JSON.parse(readFileSync(cfgFile, 'utf8'));
  const other = join(tmp, 'other.config.json');
  const otherCli = (...args) => sh(process.execPath, [BIN, ...args, '--config', other]);
  writeFileSync(join(tmp, 'compose.yaml'), 'name: devstack\nservices: {}\n');
  writeFileSync(other, JSON.stringify({ ...base, name: 'other', stateDir: join(tmp, 'other-state'), compose: { project: 'devstack' } }));
  const clash = otherCli('start');
  assert.equal(clash.code, 1);
  assert.match(clash.err, /name your dev stack uses/);
  const busy = createServer().listen(0, '127.0.0.1');
  await new Promise((r) => busy.once('listening', r));
  writeFileSync(other, JSON.stringify({ ...base, name: 'other', stateDir: join(tmp, 'other-state'), compose: { project: 'other-reload' }, statusPage: { port: busy.address().port } }));
  const taken = otherCli('start');
  busy.close();
  assert.equal(taken.code, 1);
  assert.match(taken.err, /already in use/);
  assert.equal(existsSync(join(tmp, 'other-state')), false, 'nothing created');
});

test('rapid-reload end to end', { skip }, async (t) => {
  const first = commit({ '.keep': '' }, 'initial');
  const started = cli('start', '--adopt');
  assert.equal(started.code, 0, started.err || started.out);
  await waitForDeployed(first);
  assert.equal(planned(), 'reset');
  assert.deepEqual(marks(), ['seeded'], 'afterReset hook added test data');
  must('docker', ['compose', '-p', project, 'exec', '-T', 'db', 'psql', '-U', 'postgres', '-qc', "INSERT INTO marks VALUES ('marker')"]);
  const html = await (await fetch(`http://127.0.0.1:${JSON.parse(readFileSync(cfgFile)).statusPage.port}/status.json`)).json();
  assert.equal(html.state, 'idle');

  await t.test('a Markdown-only commit changes nothing', () => {
    const before = containers();
    const sha = commit({ 'README.md': '# hi\n' }, 'docs');
    assert.equal(cli('check').code, 0);
    assert.equal(read('deployed'), sha);
    assert.equal(planned(), 'none');
    assert.deepEqual(containers(), before);
  });

  await t.test('a commit outside every image source builds from cache and recreates nothing', () => {
    const before = containers();
    const sha = commit({ 'notes/todo.txt': 'x\n' }, 'notes');
    assert.equal(cli('check').code, 0);
    assert.equal(read('deployed'), sha);
    assert.equal(planned(), 'update');
    assert.deepEqual(containers(), before);
    assert.deepEqual(marks(), ['marker', 'seeded']);
  });

  await t.test("a service's source recreates only that service", () => {
    const before = containers();
    commit({ 'web/server.mjs': readFileSync(join(work, 'web/server.mjs'), 'utf8') + '// changed\n' }, 'web');
    assert.equal(cli('check').code, 0);
    const now = containers();
    assert.notEqual(now.web.id, before.web.id);
    assert.deepEqual(now.worker, before.worker);
    assert.deepEqual(now.db, before.db);
    assert.deepEqual(marks(), ['marker', 'seeded']);
  });

  await t.test('a bind-mounted file restarts only its service', async () => {
    const before = containers();
    commit({ 'web-config/message.txt': 'Changed message\n' }, 'message');
    assert.equal(cli('check').code, 0);
    const now = containers();
    assert.equal(now.web.id, before.web.id);
    assert.notEqual(now.web.started, before.web.started);
    assert.deepEqual(now.worker, before.worker);
    assert.deepEqual(now.db, before.db);
    assert.equal((await (await fetch(`http://127.0.0.1:${webPort}`)).text()).trim(), 'Changed message');
  });

  await t.test('a broken build leaves the old stack running and is not retried every check', () => {
    const before = containers();
    const deployed = read('deployed');
    const dockerfile = readFileSync(join(work, 'web/Dockerfile'), 'utf8');
    commit({ 'web/Dockerfile': dockerfile + 'RUN exit 1\n' }, 'broken');
    assert.equal(cli('check').code, 1);
    assert.equal(status().state, 'failed');
    assert.equal(read('deployed'), deployed);
    assert.deepEqual(containers(), before);
    const events = read('events.log');
    assert.equal(cli('check').code, 0);
    assert.equal(read('events.log'), events, 'no second attempt');
    assert.match(status().step, /failed at: Building images/);
  });

  await t.test('a failing hook marks the update failed and names the step', () => {
    const dockerfile = readFileSync(join(work, 'web/Dockerfile'), 'utf8').replace('RUN exit 1\n', '');
    commit({ 'web/Dockerfile': dockerfile, 'fail-hook': '' }, 'fixed build, failing hook');
    assert.equal(cli('check').code, 1);
    assert.match(status().step, /Checking the hook switch/);
    const sha = commit({ 'fail-hook': null }, 'hook fixed');
    assert.equal(cli('check').code, 0);
    assert.equal(read('deployed'), sha);
  });

  await t.test('a paths.reset match wipes the data and reruns the hooks', () => {
    const sha = commit({ 'db/init.sql': readFileSync(join(work, 'db/init.sql'), 'utf8') + '-- changed\n' }, 'schema');
    assert.equal(cli('check').code, 0);
    assert.equal(read('deployed'), sha);
    assert.equal(planned(), 'reset');
    assert.deepEqual(marks(), ['seeded']);
  });

  await t.test('uninstall removes the stack and the state folder', () => {
    assert.equal(cli('uninstall').code, 1, 'refuses without --yes');
    assert.equal(cli('uninstall', '--yes').code, 0);
    assert.deepEqual(containers(), {});
    assert.equal(existsSync(state), false);
    assert.equal(must('docker', ['images', '-q', '--filter', `reference=${project}-*`]), '', 'built images removed');
    appendFileSync(join(tmp, 'done'), '');
  });
});
