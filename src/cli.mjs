// Host-side commands. The update loop itself runs in the poller container (src/poll.mjs).
import { spawnSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:net';
import { basename, dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { CONFIG_FILE, ConfigError, DEFAULT_STATUS_PORT, MARKER, loadConfig, parseEnvFile } from './config.mjs';
import { COMPOSE_FILES, composeDirs, composeFileName, copiesWholeContext, defaultProjectName } from './plan.mjs';

const PKG = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const POLLER_COMPOSE = join(PKG, 'container', 'compose.yaml');
const VERSION = JSON.parse(readFileSync(join(PKG, 'package.json'), 'utf8')).version;

const HELP = `rapid-reload ${VERSION}: keeps a local Docker Compose stack on the latest commit of a Git branch.

Usage: rapid-reload <command> [--config <file>]

  init       write a starter ${CONFIG_FILE} for the repo in this folder
  doctor     check Docker, the config, the token and the Compose files
  start      validate the config and start (or restart) the poller
  status     show what the poller is doing (--json for machine output)
  check      run a check now instead of waiting for the next one
  retry      retry the current commit after a failed update
  logs       follow the poller's log
  stop       stop the poller; the stack keeps running
  uninstall  remove the stack, its data and all poller state (needs --yes)

Options:
  --config <file>  config file (default: ./${CONFIG_FILE})
  --adopt          start: take over an existing state folder without a marker (moving from an older poller)
  --branch <name>  init: branch to follow (default: the remote's default branch)
  --dir <dir>      init: folder holding the Compose file (default: the repo root)
  --force          init: overwrite an existing config
  --yes            uninstall: confirm
`;

const sh = (cmd, args, opts = {}) => {
  const r = spawnSync(cmd, args, { encoding: 'utf8', maxBuffer: 64 << 20, ...opts });
  return { ok: r.status === 0, out: (r.stdout ?? '').trim(), err: (r.stderr ?? '').trim() || r.error?.message || '' };
};

function parseArgs(argv) {
  const flags = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (['--config', '--branch', '--dir'].includes(a)) flags[a.slice(2)] = argv[++i];
    else if (a.startsWith('--')) flags[a.slice(2)] = true;
    else flags._.push(a);
  }
  return flags;
}

const pollerProject = (cfg) => `rapid-reload-${cfg.name}`;
const tokenMount = (cfg) =>
  cfg.git.tokenFile ?? join(cfg.stateDir, cfg.git.tokenEnv ? '.token-from-env' : '.no-token');
const pollerEnv = (cfg) => ({
  ...process.env,
  RAPID_RELOAD_STATE_DIR: cfg.stateDir,
  RAPID_RELOAD_STATUS_PORT: String(cfg.statusPage.port),
  RAPID_RELOAD_TOKEN_FILE: tokenMount(cfg),
});
const dcPoller = (cfg, args, opts = {}) =>
  sh('docker', ['compose', '-p', pollerProject(cfg), '-f', POLLER_COMPOSE, ...args], { env: pollerEnv(cfg), ...opts });
const pollerRunning = (cfg) => Boolean(dcPoller(cfg, ['ps', '-q', 'poller']).out);

function repoRoot(dir) {
  const r = sh('git', ['-C', dir, 'rev-parse', '--show-toplevel']);
  return r.ok ? r.out : dir;
}

function token(cfg) {
  if (cfg.git.tokenEnv) return process.env[cfg.git.tokenEnv]?.trim() ?? '';
  if (!cfg.git.tokenFile) return '';
  try {
    return readFileSync(cfg.git.tokenFile, 'utf8').trim();
  } catch {
    return '';
  }
}
const needsToken = (cfg) => cfg.git.remote.startsWith('https://') && Boolean(cfg.git.tokenFile || cfg.git.tokenEnv);

/** Compose project names the developer's own stack would use; the poller must never share one, or a reset wipes it. */
function clashingNames(cfg, root) {
  const dir = join(root, cfg.compose.dir);
  const names = new Set([defaultProjectName(basename(dir))]);
  if (process.env.COMPOSE_PROJECT_NAME) names.add(process.env.COMPOSE_PROJECT_NAME);
  for (const f of cfg.compose.files) {
    try {
      const n = composeFileName(readFileSync(join(dir, f), 'utf8'));
      if (n) names.add(n);
    } catch {}
  }
  return names;
}

const portFree = (port) =>
  new Promise((resolve) => {
    const s = createServer();
    s.once('error', () => resolve(false));
    s.listen(port, '127.0.0.1', () => s.close(() => resolve(true)));
  });

async function statusPortProblem(cfg) {
  if (await portFree(cfg.statusPage.port)) return '';
  const ours = dcPoller(cfg, ['port', 'poller', '8080']).out;
  if (ours.endsWith(`:${cfg.statusPage.port}`)) return '';
  return `Status port ${cfg.statusPage.port} is already in use. Pick another statusPage.port (each project needs its own).`;
}

function localComposeConfig(cfg, root) {
  const dir = join(root, cfg.compose.dir);
  if (!existsSync(dir)) return { error: `${dir} doesn't exist. Keep the config inside the repo it describes.` };
  const env = { ...process.env, ...cfg.compose.env, ...envFile(cfg) };
  const r = sh('docker', ['compose', '-p', cfg.compose.project, ...cfg.compose.files.flatMap((f) => ['-f', join(dir, f)]), ...cfg.compose.profiles.flatMap((p) => ['--profile', p]), 'config', '--format', 'json'], { env, cwd: dir });
  if (!r.ok) return { error: r.err.split('\n').slice(-3).join(' ') };
  return { config: JSON.parse(r.out) };
}

function envFile(cfg) {
  if (!cfg.compose.envFile) return {};
  return parseEnvFile(readFileSync(cfg.compose.envFile, 'utf8'));
}

function configPath(flags) {
  return resolve(flags.config ?? CONFIG_FILE);
}

// ---------------------------------------------------------------------------------------------------------------- init

function init(flags) {
  const root = repoRoot(process.cwd());
  const target = join(root, CONFIG_FILE);
  if (existsSync(target) && !flags.force) throw new Error(`${target} already exists (use --force to overwrite)`);
  let dir = flags.dir ?? '.';
  if (!flags.dir && !COMPOSE_FILES.some((f) => existsSync(join(root, f)))) {
    // Not in the root: look through the repo's files, so a Compose file in a subfolder is found without --dir.
    const files = sh('git', ['-C', root, 'ls-files', '--cached', '--others', '--exclude-standard']).out.split('\n');
    const found = composeDirs(files).filter((d) => !d.startsWith('examples/'));
    if (found.length === 1) {
      dir = found[0];
      console.log(`Using the Compose file in ${dir}/`);
    } else if (found.length > 1)
      throw new Error(`Compose files in several folders. Pick one with --dir:\n${found.map((d) => `  --dir ${d}`).join('\n')}`);
  }
  const file = COMPOSE_FILES.find((f) => existsSync(join(root, dir, f)));
  if (!file)
    throw new Error(`No Compose file (${COMPOSE_FILES.join(', ')}) in ${join(root, dir)}. Use --dir to point at the folder that has one.`);
  const services = sh('docker', ['compose', '-f', join(root, dir, file), 'config', '--services'], { cwd: join(root, dir) });
  if (!services.ok) throw new Error(`docker compose config failed: ${services.err}`);
  let remote = sh('git', ['-C', root, 'remote', 'get-url', 'origin']).out;
  remote = remote.replace(/^git@([^:]+):/, 'https://$1/').replace(/^ssh:\/\/git@([^/]+)\//, 'https://$1/');
  try {
    const u = new URL(remote);
    u.username = '';
    u.password = '';
    remote = u.toString();
  } catch {
    remote ||= 'https://github.com/OWNER/REPO.git';
  }
  const head = sh('git', ['-C', root, 'symbolic-ref', '--short', 'refs/remotes/origin/HEAD']).out.replace(/^origin\//, '');
  const name = defaultProjectName(basename(root)).slice(0, 40) || 'app';
  const config = {
    name,
    git: { remote, branch: flags.branch ?? (head || 'main'), tokenFile: `~/.cache/rapid-reload/${name}/git-token` },
    compose: { project: `${name}-reload`, dir, files: [file], services: services.out.split('\n').filter(Boolean) },
    paths: { ignore: ['docs/**', '**/*.md'], reset: [] },
    hooks: { reset: [], afterReset: [], afterUpdate: [] },
    statusPage: { port: DEFAULT_STATUS_PORT, links: [] },
  };
  writeFileSync(target, JSON.stringify(config, null, 2) + '\n');
  console.log(`Wrote ${target}

Next:
  1. Check git.branch, and remove git.tokenFile if the repo is public.
  2. If your Compose file publishes ports, set compose.env so this stack doesn't clash with your dev stack.
  3. Add paths.reset and hooks if a change (such as a migration) needs fresh databases.
  4. npx rapid-reload doctor`);
}

// -------------------------------------------------------------------------------------------------------------- doctor

async function doctor(flags) {
  let failed = false;
  const ok = (m) => console.log(`  ok    ${m}`);
  const warn = (m) => console.log(`  warn  ${m}`);
  const fail = (m) => {
    failed = true;
    console.log(`  FAIL  ${m}`);
  };
  const file = configPath(flags);
  let cfg;
  try {
    cfg = loadConfig(file);
    ok(`Config ${file}`);
  } catch (e) {
    fail(e.message);
    return 1;
  }
  const root = repoRoot(dirname(file));

  const docker = sh('docker', ['info', '--format', '{{.ServerVersion}}']);
  docker.ok ? ok(`Docker ${docker.out}`) : fail(`Docker is not reachable: ${docker.err}`);
  const compose = sh('docker', ['compose', 'version', '--short']);
  compose.ok ? ok(`Docker Compose ${compose.out}`) : fail('Docker Compose v2 is not installed');

  const missing = cfg.compose.files.filter((f) => !existsSync(join(root, cfg.compose.dir, f)));
  missing.length ? warn(`Compose files not found in this checkout: ${missing.join(', ')}`) : ok('Compose files found');
  clashingNames(cfg, root).has(cfg.compose.project)
    ? fail(`compose.project "${cfg.compose.project}" is the name your dev stack uses; a reset would wipe its data`)
    : ok(`Compose project ${cfg.compose.project} is separate from the dev stack`);

  if (needsToken(cfg)) {
    const t = token(cfg);
    if (!t) fail(cfg.git.tokenEnv ? `$${cfg.git.tokenEnv} is not set` : `No token in ${cfg.git.tokenFile}`);
    else {
      ok('Token found');
      if (cfg.git.tokenFile && statSync(cfg.git.tokenFile).mode & 0o077)
        warn(`${cfg.git.tokenFile} is readable by other users: chmod 600 it`);
    }
  }
  const helper = `!f() { test "$1" = get || exit 0; echo username=${cfg.git.tokenUsername}; echo "password=$RAPID_RELOAD_GIT_TOKEN"; }; f`;
  const remote = sh('git', ['-c', 'credential.helper=', '-c', `credential.helper=${helper}`, 'ls-remote', '--heads', cfg.git.remote, cfg.git.branch], {
    env: { ...process.env, RAPID_RELOAD_GIT_TOKEN: token(cfg), GIT_TERMINAL_PROMPT: '0' },
  });
  if (!remote.ok) fail(`Can't read ${cfg.git.remote}: ${remote.err.split('\n')[0]}`);
  else if (!remote.out) warn(`Branch ${cfg.git.branch} doesn't exist yet on the remote; the poller waits for it`);
  else ok(`Can read ${cfg.git.branch} from the remote`);

  const port = await statusPortProblem(cfg);
  port ? fail(port) : ok(`Status port ${cfg.statusPage.port} is free (or already ours)`);

  if (existsSync(cfg.stateDir) && readdirSync(cfg.stateDir).length && !existsSync(join(cfg.stateDir, MARKER)))
    warn(`${cfg.stateDir} has files but no ${MARKER} marker: start needs --adopt to use it`);

  const resolved = localComposeConfig(cfg, root);
  if (resolved.error) warn(`Couldn't resolve the Compose config: ${resolved.error}`);
  else {
    for (const [name, s] of Object.entries(resolved.config.services ?? {})) {
      if (cfg.compose.services.length && !cfg.compose.services.includes(name) && !s.profiles) continue;
      if (s.build && relative(root, s.build.context) === '') {
        const df = join(s.build.context, s.build.dockerfile ?? 'Dockerfile');
        if (existsSync(df) && copiesWholeContext(readFileSync(df, 'utf8')))
          warn(`${name} builds from the repo root with COPY . . : every non-ignored commit rebuilds it. See README "Faster updates".`);
      }
    }
    const unknown = cfg.compose.services.filter((s) => !(s in (resolved.config.services ?? {})));
    unknown.length ? fail(`compose.services not in the Compose files: ${unknown.join(', ')}`) : ok('compose.services all exist');
  }

  for (const h of [...cfg.hooks.reset, ...cfg.hooks.afterReset, ...cfg.hooks.afterUpdate]) {
    const script = h.run.match(/^(?:bash|sh|node)\s+(\S+)/)?.[1];
    if (script && !existsSync(join(root, script))) warn(`Hook "${h.label}": ${script} not found in this checkout`);
  }
  if (!cfg.paths.reset.length) ok('paths.reset is empty: data is only wiped on the first update');
  console.log(failed ? '\nFix the FAIL lines, then run doctor again.' : '\nReady: npx rapid-reload start');
  return failed ? 1 : 0;
}

// --------------------------------------------------------------------------------------------------------------- start

async function start(flags) {
  const file = configPath(flags);
  const cfg = loadConfig(file);
  const root = repoRoot(dirname(file));
  const docker = sh('docker', ['info', '--format', '{{.ServerVersion}}']);
  if (!docker.ok) throw new Error(`Docker is not reachable: ${docker.err}`);
  if (clashingNames(cfg, root).has(cfg.compose.project))
    throw new Error(`compose.project "${cfg.compose.project}" is the name your dev stack uses, and a reset would wipe its data. Pick another, such as "${cfg.compose.project}-reload".`);
  const port = await statusPortProblem(cfg);
  if (port) throw new Error(port);
  if (needsToken(cfg) && !token(cfg))
    throw new Error(cfg.git.tokenEnv ? `$${cfg.git.tokenEnv} is not set.` : `No token in ${cfg.git.tokenFile}. See README: "Create a token".`);

  if (existsSync(cfg.stateDir) && readdirSync(cfg.stateDir).length && !existsSync(join(cfg.stateDir, MARKER)) && !flags.adopt)
    throw new Error(`${cfg.stateDir} already has files and wasn't created by rapid-reload. Use an empty folder, or --adopt if it is an older poller's state folder.`);
  mkdirSync(cfg.stateDir, { recursive: true, mode: 0o700 });
  writeFileSync(join(cfg.stateDir, MARKER), `${cfg.name}\n`);
  const stored = { ...cfg, compose: { ...cfg.compose, env: { ...envFile(cfg), ...cfg.compose.env } } };
  writeFileSync(join(cfg.stateDir, 'config.json'), JSON.stringify(stored, null, 2) + '\n', { mode: 0o600 });
  chmodSync(join(cfg.stateDir, 'config.json'), 0o600);
  if (!cfg.git.tokenFile) {
    writeFileSync(tokenMount(cfg), cfg.git.tokenEnv ? token(cfg) : '', { mode: 0o600 });
    chmodSync(tokenMount(cfg), 0o600);
  }

  console.log(`Starting the poller for ${cfg.name} (${cfg.git.branch} -> Compose project ${cfg.compose.project})`);
  const up = dcPoller(cfg, ['up', '-d', '--build', '--remove-orphans'], { stdio: 'inherit' });
  if (!up.ok) throw new Error('docker compose up failed for the poller');
  console.log(`Status page: http://127.0.0.1:${cfg.statusPage.port}`);
  return 0;
}

// ------------------------------------------------------------------------------------------------- the small commands

function status(flags) {
  const cfg = loadConfig(configPath(flags));
  const read = (n) => {
    try {
      return readFileSync(join(cfg.stateDir, n), 'utf8').trim();
    } catch {
      return '';
    }
  };
  let s = {};
  try {
    s = JSON.parse(read('status.json'));
  } catch {}
  const result = {
    name: cfg.name,
    running: pollerRunning(cfg),
    state: s.state ?? 'not started',
    step: s.step ?? '',
    deployed: read('deployed'),
    statusPage: `http://127.0.0.1:${cfg.statusPage.port}`,
  };
  if (flags.json) console.log(JSON.stringify(result, null, 2));
  else
    console.log(
      `${result.name}: ${result.state}${result.step ? ` - ${result.step}` : ''}\n` +
        `Poller: ${result.running ? 'running' : 'stopped'} · Deployed: ${result.deployed.slice(0, 7) || 'none'} · ${result.statusPage}`,
    );
  return 0;
}

function check(flags) {
  const cfg = loadConfig(configPath(flags));
  if (!pollerRunning(cfg)) throw new Error('The poller is not running. Run start first.');
  return dcPoller(cfg, ['exec', '-T', 'poller', 'node', '/poller/src/poll.mjs', 'once'], { stdio: 'inherit' }).ok ? 0 : 1;
}

function retry(flags) {
  const cfg = loadConfig(configPath(flags));
  rmSync(join(cfg.stateDir, 'attempted'), { force: true });
  return check(flags);
}

function logs(flags) {
  const cfg = loadConfig(configPath(flags));
  return dcPoller(cfg, ['logs', '-f', '--tail', '100', 'poller'], { stdio: 'inherit' }).ok ? 0 : 1;
}

function stop(flags) {
  const cfg = loadConfig(configPath(flags));
  return dcPoller(cfg, ['stop'], { stdio: 'inherit' }).ok ? 0 : 1;
}

function uninstall(flags) {
  const cfg = loadConfig(configPath(flags));
  if (!flags.yes) {
    console.log(`This removes:
  - the Compose project ${cfg.compose.project}, with its volumes (all its data)
  - everything in ${cfg.stateDir}, including a token stored there
  - the poller container ${pollerProject(cfg)}
Run again with --yes to go ahead.`);
    return 1;
  }
  dcPoller(cfg, ['stop'], { stdio: 'inherit' });
  const clone = join(cfg.stateDir, 'repo', cfg.compose.dir);
  const files = cfg.compose.files.filter((f) => existsSync(join(clone, f)));
  const env = { ...process.env, ...cfg.compose.env, ...envFile(cfg) };
  // --rmi local removes only images Compose named after the project, never ones with an image: tag the dev stack may share.
  const down = files.length
    ? ['compose', '-p', cfg.compose.project, ...files.flatMap((f) => ['-f', join(clone, f)]), ...cfg.compose.profiles.flatMap((p) => ['--profile', p]), 'down', '-v', '--rmi', 'local', '--remove-orphans']
    : ['compose', '-p', cfg.compose.project, 'down', '-v', '--remove-orphans'];
  if (!sh('docker', down, { env, cwd: files.length ? clone : process.cwd(), stdio: 'inherit' }).ok)
    throw new Error(`Couldn't remove the stack ${cfg.compose.project}; nothing else was removed.`);
  if (existsSync(join(cfg.stateDir, MARKER))) {
    // Inside the container: files it created may belong to root on Linux hosts.
    const wiped = dcPoller(cfg, ['run', '--rm', '--no-deps', '-T', 'poller', 'node', '/poller/src/poll.mjs', 'wipe-state'], { stdio: 'inherit' });
    if (!wiped.ok) for (const e of readdirSync(cfg.stateDir)) rmSync(join(cfg.stateDir, e), { recursive: true, force: true });
    rmSync(cfg.stateDir, { recursive: true, force: true });
  } else console.log(`${cfg.stateDir} has no ${MARKER} marker, so it was left alone.`);
  dcPoller(cfg, ['down', '--rmi', 'local', '--remove-orphans'], { stdio: 'inherit' });
  console.log('Removed.');
  return 0;
}

const COMMANDS = { init, doctor, start, status, check, retry, logs, stop, uninstall };

export async function main(argv) {
  const flags = parseArgs(argv);
  const [command] = flags._;
  if (!command || command === 'help' || flags.help) {
    console.log(HELP);
    return command || flags.help ? 0 : 2;
  }
  if (command === 'version' || flags.version) {
    console.log(VERSION);
    return 0;
  }
  const fn = COMMANDS[command];
  if (!fn) {
    console.error(`Unknown command: ${command}\n\n${HELP}`);
    return 2;
  }
  try {
    return (await fn(flags)) ?? 0;
  } catch (e) {
    console.error(e instanceof ConfigError ? e.message : `rapid-reload ${command}: ${e.message}`);
    return 1;
  }
}
