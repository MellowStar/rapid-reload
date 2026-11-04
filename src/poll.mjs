// Runs inside the poller container and keeps a Compose stack on the latest commit of one branch. Only reads the branch.
//   poll.mjs run          status page, plus a check every pollIntervalSeconds (the container's command)
//   poll.mjs once         one check; updates the stack if the branch moved
//   poll.mjs wipe-state   delete everything in the state folder (used by `rapid-reload uninstall`)
// The state folder is mounted at the same path as on the host, because Compose runs on the host's Docker and must
// find the paths it is given.
import { spawn, spawnSync } from 'node:child_process';
import { appendFileSync, createWriteStream, existsSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { join, relative, isAbsolute } from 'node:path';
import { fileURLToPath } from 'node:url';
import { setTimeout as sleep } from 'node:timers/promises';
import { bindRestarts, branchesAt, mergeSource, plan } from './plan.mjs';
import { serveStatus } from './status-server.mjs';
import { MARKER, liveConfig, liveFingerprint } from './config.mjs';

const TOKEN_FILE = process.env.RAPID_RELOAD_TOKEN_FILE ?? '/run/rapid-reload/token';
const SOURCE_CONFIG = process.env.RAPID_RELOAD_SOURCE_CONFIG ?? '';
const stored = JSON.parse(readFileSync(process.env.RAPID_RELOAD_CONFIG, 'utf8'));
// Replaced at the start of each check by the live config file (see reloadConfig).
let cfg = stored;
const DIR = cfg.stateDir;
const REPO = join(DIR, 'repo');
let COMPOSE_DIR = join(REPO, cfg.compose.dir);
let SERVICES = cfg.compose.services;
const now = () => Math.floor(Date.now() / 1000);
const file = (name) => join(DIR, name);

const read = (name) => {
  try {
    return readFileSync(file(name), 'utf8').trim();
  } catch {
    return '';
  }
};
const write = (name, text) => {
  writeFileSync(file(name) + '.tmp', text);
  renameSync(file(name) + '.tmp', file(name));
};
const token = () => {
  try {
    return readFileSync(TOKEN_FILE, 'utf8').trim();
  } catch {
    return '';
  }
};
const usesToken = () => cfg.git.remote.startsWith('https://') && Boolean(cfg.git.tokenFile || cfg.git.tokenEnv);
const scrub = (text) => {
  const t = token();
  return t.length >= 8 ? text.split(t).join('***') : text;
};

let current = '';
const publish = (state, step) => write('status.json', JSON.stringify({ state, step, since: now() }));
const note = (message) => {
  console.log(`${new Date().toISOString()} ${message}`);
  appendFileSync(file('events.log'), `${now()} ${message}\n`);
};

// The token never reaches a URL, .git/config or the process list: git asks this helper, which reads the mounted file.
const gitAuth = () =>
  usesToken()
    ? ['-c', 'credential.helper=', '-c', `credential.helper=!f() { test "$1" = get || exit 0; echo username=${cfg.git.tokenUsername}; echo "password=$(cat ${TOKEN_FILE})"; }; f`]
    : [];
const gitEnv = { ...process.env, GIT_TERMINAL_PROMPT: '0' };
const git = (args, cwd = REPO) => {
  const r = spawnSync('git', [...gitAuth(), ...args], { cwd, env: gitEnv, encoding: 'utf8' });
  if (r.status !== 0) throw new Error(scrub(`git ${args[0]} failed: ${r.stderr.trim()}`));
  return r.stdout.trim();
};

const composeEnv = () => ({ ...process.env, ...cfg.compose.env });
const dc = (withProfiles = false) => [
  'compose',
  '-p',
  cfg.compose.project,
  ...cfg.compose.files.flatMap((f) => ['-f', join(COMPOSE_DIR, f)]),
  ...(withProfiles ? cfg.compose.profiles.flatMap((p) => ['--profile', p]) : []),
];
const waitArgs = () => (cfg.compose.wait ? ['--wait', '--wait-timeout', String(cfg.compose.waitTimeoutSeconds)] : []);
const capture = (cmd, args, env = composeEnv()) => {
  const r = spawnSync(cmd, args, { cwd: REPO, env, encoding: 'utf8', maxBuffer: 64 << 20 });
  return r.status === 0 ? r.stdout : '';
};

/** Runs a command with its output in build.log (token scrubbed). Rejects on a non-zero exit. */
function run(cmd, args, env = composeEnv()) {
  return new Promise((resolve, reject) => {
    const log = createWriteStream(file('build.log'), { flags: 'a' });
    const child = spawn(cmd, args, { cwd: REPO, env, stdio: ['ignore', 'pipe', 'pipe'] });
    const out = (chunk) => log.write(scrub(chunk.toString()));
    child.stdout.on('data', out);
    child.stderr.on('data', out);
    child.on('error', (e) => log.end(() => reject(e)));
    child.on('close', (code) => log.end(() => (code === 0 ? resolve() : reject(new Error(`${cmd} exited with ${code}`)))));
  });
}

async function step(label, cmd, args, env) {
  current = label;
  publish('working', label);
  note(label);
  await run(cmd, args, env);
}

const hookEnv = (sha) => ({
  ...composeEnv(),
  COMPOSE_PROJECT_NAME: cfg.compose.project,
  COMPOSE_FILE: cfg.compose.files.map((f) => join(COMPOSE_DIR, f)).join(':'),
  COMPOSE_PROFILES: cfg.compose.profiles.join(','),
  RAPID_RELOAD_REPO: REPO,
  RAPID_RELOAD_BRANCH: cfg.git.branch,
  RAPID_RELOAD_COMMIT: sha,
});
async function hooks(list, sha) {
  for (const h of list) await step(h.label, 'bash', ['-c', h.run], hookEnv(sha));
}

/** service -> container id, for reporting which containers an update recreated. */
function containers() {
  const out = capture('docker', ['ps', '-a', '--filter', `label=com.docker.compose.project=${cfg.compose.project}`, '--format', '{{.Label "com.docker.compose.service"}}\t{{.ID}}']);
  return Object.fromEntries(out.split('\n').filter(Boolean).map((l) => l.split('\t')));
}

/** Repo-relative bind-mount sources per service, from the resolved Compose config. */
function bindMounts() {
  let config;
  try {
    config = JSON.parse(capture('docker', [...dc(), 'config', '--format', 'json']));
  } catch {
    return [];
  }
  const binds = [];
  for (const [service, s] of Object.entries(config.services ?? {}))
    for (const v of s.volumes ?? []) {
      if (v.type !== 'bind' || !v.source) continue;
      const rel = relative(REPO, v.source);
      if (rel && !rel.startsWith('..') && !isAbsolute(rel)) binds.push({ service, source: rel });
    }
  return binds;
}

async function reset(sha) {
  // Build first: if it fails, the previous stack keeps running.
  await step('Building all images', 'docker', [...dc(true), 'build']);
  // From here the stack may be down, so a failure must make the next update a reset too.
  rmSync(file('deployed'), { force: true });
  await step('Removing the stack and its data', 'docker', [...dc(true), 'down', '-v', '--remove-orphans']);
  await hooks(cfg.hooks.reset, sha);
  await step('Starting the services', 'docker', [...dc(), 'up', '-d', ...waitArgs(), ...SERVICES]);
  await hooks(cfg.hooks.afterReset, sha);
}

async function update(sha, changed) {
  const before = containers();
  await step('Building images', 'docker', [...dc(), 'build', ...SERVICES]);
  // Compose recreates only the containers whose image or configuration changed.
  await step('Starting changed services', 'docker', [...dc(), 'up', '-d', ...waitArgs(), ...SERVICES]);
  const after = containers();
  const recreated = Object.keys(after).filter((s) => before[s] !== after[s]).sort();
  note(recreated.length ? `Recreated: ${recreated.join(', ')}` : 'No containers needed recreating');
  // Compose doesn't notice a changed file behind a bind mount, so restart those services.
  const restart = bindRestarts(changed ?? [], bindMounts()).filter(
    (s) => !recreated.includes(s) && (!SERVICES.length || SERVICES.includes(s)) && after[s],
  );
  if (restart.length) await step(`Restarting ${restart.join(', ')} (bind-mounted file changed)`, 'docker', [...dc(), 'restart', ...restart]);
  await hooks(cfg.hooks.afterUpdate, sha);
}

// After Docker restarts, stopped services come back without a rebuild.
async function ensureUp() {
  const stopped = capture('docker', [...dc(), 'ps', '-a', '--status', 'exited', '--status', 'created', '--services']).trim();
  if (stopped) await step('Restarting stopped containers', 'docker', [...dc(), 'up', '-d', '--no-build', '--no-recreate', ...SERVICES]);
}

// The branch that brought this commit in: another branch's tip at this commit or its merged parent, else the merge
// message (the branch may be deleted by now). Best effort, saved per commit because branch tips move on.
function describe(sha) {
  const saved = read('incoming');
  let name = saved.startsWith(sha + ' ') ? saved.slice(sha.length + 1) : '';
  if (!name) {
    try {
      const parent = spawnSync('git', ['rev-parse', '-q', '--verify', `${sha}^2`], { cwd: REPO, encoding: 'utf8' }).stdout.trim();
      const heads = git(['ls-remote', '--heads', cfg.git.remote]);
      name = branchesAt(heads, sha, parent, cfg.git.branch).join(', ');
    } catch {
      name = '';
    }
    name ||= mergeSource(git(['log', '-1', '--format=%s', sha])) || 'unknown';
    write('incoming', `${sha} ${name}`);
  }
  return `${cfg.git.branch} ${sha.slice(0, 7)} (from ${name})`;
}

// Agents and people switch the branch, or change compose, paths and hooks, by editing the config file in the project
// folder; no restart and no push to the followed branch needed. Settings that only apply on start are reported.
function reloadConfig() {
  if (!SOURCE_CONFIG || !existsSync(SOURCE_CONFIG)) return;
  current = 'Reading the config file';
  let raw;
  try {
    raw = JSON.parse(readFileSync(SOURCE_CONFIG, 'utf8'));
  } catch (e) {
    throw new Error(`The config file is not valid JSON: ${e.message}`);
  }
  const { config, errors, needsRestart } = liveConfig(stored, raw);
  if (errors.length) throw new Error(`The config file has problems:\n  - ${errors.join('\n  - ')}`);
  const warned = needsRestart.join(', ');
  if (warned && read('needs-restart') !== warned) note(`Config changes that need \`rapid-reload start\`: ${warned}`);
  write('needs-restart', warned);
  cfg = config;
  COMPOSE_DIR = join(REPO, cfg.compose.dir);
  SERVICES = cfg.compose.services;
}

async function check() {
  write('last-check', String(now()));
  reloadConfig();
  const fingerprint = liveFingerprint(cfg);
  // Missing for a state folder from an older version: treat as unchanged, so upgrading doesn't redeploy.
  const attemptedConfig = existsSync(file('attempted-config')) ? read('attempted-config') : fingerprint;
  const configChanged = attemptedConfig !== fingerprint;
  if (usesToken() && !token()) {
    publish('blocked', `Waiting for a Git token in ${cfg.git.tokenFile ?? '$' + cfg.git.tokenEnv}. Rerun start after adding it.`);
    return;
  }
  current = 'Reading the branch';
  if (!existsSync(join(REPO, '.git'))) git(['clone', '-q', cfg.git.remote, REPO], DIR);
  git(['fetch', '-q', cfg.git.remote, cfg.git.branch]);
  const sha = git(['rev-parse', 'FETCH_HEAD']);
  const deployed = read('deployed');
  const label = describe(sha);
  // Recorded before the attempt, so a commit that fails is not rebuilt every minute.
  if (sha === read('attempted') && !configChanged) {
    if (sha === deployed) {
      current = 'Restarting stopped containers';
      await ensureUp();
      publish('idle', `Up to date at ${label}`);
    } else {
      publish('failed', `${label} failed at: ${read('failed') || 'unknown step'}. Waiting for the next push or retry.`);
    }
    return;
  }
  write('attempted', sha);
  write('attempted-config', fingerprint);
  writeFileSync(file('build.log'), '');
  rmSync(file('failed'), { force: true });
  note(`Updating to ${label}${configChanged ? ' (config file changed)' : ''}`);
  current = 'Checking out the code';
  git(['checkout', '-qf', '--detach', sha]);
  git(['clean', '-qffdx', ...cfg.git.keepOnClean.flatMap((p) => ['-e', p])]);
  // Compared with the last good update, so a failed one is still covered by the next.
  let changed = null;
  if (deployed) {
    const r = spawnSync('git', ['diff', '--name-only', deployed, sha], { cwd: REPO, encoding: 'utf8' });
    if (r.status === 0) changed = r.stdout.split('\n').filter(Boolean);
  }
  const decision = plan({ changed, deployed, ...cfg.paths, configChanged });
  write('plan', JSON.stringify(decision));
  note(`Plan: ${decision.action} (${decision.reason})`);
  if (decision.action === 'reset') await reset(sha);
  else if (decision.action === 'update') await update(sha, changed);
  write('deployed', sha);
  publish('idle', `Up to date at ${label}`);
  note(`Running ${label}`);
}

async function once() {
  try {
    mkdirSync(file('lock'));
  } catch {
    console.log('Another check is running.');
    return;
  }
  try {
    await check();
  } catch (e) {
    const at = current || 'unknown step';
    write('failed', at);
    publish('failed', `Failed at: ${at}`);
    note(`FAILED at: ${at}`);
    appendFileSync(file('build.log'), scrub(`\n${e.message}\n`));
    process.exitCode = 1;
  } finally {
    rmSync(file('lock'), { recursive: true, force: true });
  }
}

async function loop() {
  rmSync(file('lock'), { recursive: true, force: true }); // left over if the container stopped mid-check
  serveStatus(cfg, DIR);
  const self = fileURLToPath(import.meta.url);
  for (;;) {
    // A child per check, so state never leaks between checks and a crash doesn't stop the loop.
    await new Promise((resolve) => spawn(process.execPath, [self, 'once'], { stdio: 'inherit' }).on('close', resolve));
    await sleep(cfg.pollIntervalSeconds * 1000);
  }
}

function wipeState() {
  if (!existsSync(file(MARKER))) {
    console.error(`${DIR} has no ${MARKER} marker; not deleting anything.`);
    process.exitCode = 1;
    return;
  }
  for (const entry of readdirSync(DIR)) rmSync(join(DIR, entry), { recursive: true, force: true });
}

const command = process.argv[2];
if (command === 'run') await loop();
else if (command === 'once') await once();
else if (command === 'wipe-state') wipeState();
else {
  console.error('usage: poll.mjs run|once|wipe-state');
  process.exitCode = 2;
}
