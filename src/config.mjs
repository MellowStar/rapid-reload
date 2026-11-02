// Loads, validates and normalises rapid-reload.config.json. Runs on the host; the container reads the normalised copy.
import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, isAbsolute, join, resolve, sep } from 'node:path';

export const CONFIG_FILE = 'rapid-reload.config.json';
export const DEFAULT_STATUS_PORT = 18091;
/** Written by `start` into the state folder. Nothing is ever deleted from a folder without it. */
export const MARKER = '.rapid-reload';

export class ConfigError extends Error {}

const NAME = /^[a-z0-9][a-z0-9_-]{0,39}$/;
const PROJECT = /^[a-z0-9][a-z0-9_-]{0,62}$/;
const ENV_KEY = /^[A-Za-z_][A-Za-z0-9_]*$/;
const USERNAME = /^[A-Za-z0-9._-]+$/;
const BRANCH = /^(?!-)(?!.*\.\.)[A-Za-z0-9._/-]+$/;
// Common token formats. A config file is meant to be committed, so a token in it is always a mistake.
const TOKEN_LIKE =
  /(gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,}|glpat-[A-Za-z0-9_-]{20,}|xox[abp]-[A-Za-z0-9-]{10,})/;

const str = (extra = {}) => ({ type: 'string', ...extra });
const strings = { type: 'array', items: str() };
const repoPath = str({ repoPath: true });
const hooks = {
  type: 'array',
  items: { type: 'object', fields: { label: str({ required: true }), run: str({ required: true }) } },
};

const SCHEMA = {
  type: 'object',
  fields: {
    $schema: str(),
    name: str({ required: true, pattern: NAME, hint: 'lowercase letters, digits, - and _' }),
    stateDir: str(),
    pollIntervalSeconds: { type: 'integer', min: 10 },
    git: {
      type: 'object',
      required: true,
      fields: {
        remote: str({ required: true }),
        branch: str({ required: true, pattern: BRANCH, hint: 'a branch name' }),
        tokenFile: str(),
        tokenEnv: str({ pattern: ENV_KEY, hint: 'an environment variable name' }),
        tokenUsername: str({ pattern: USERNAME, hint: 'letters, digits, . _ -' }),
        keepOnClean: { type: 'array', items: repoPath },
      },
    },
    compose: {
      type: 'object',
      required: true,
      fields: {
        project: str({ required: true, pattern: PROJECT, hint: 'lowercase letters, digits, - and _' }),
        dir: repoPath,
        files: { type: 'array', items: repoPath },
        profiles: strings,
        services: strings,
        env: { type: 'map', keys: ENV_KEY, values: str() },
        envFile: str(),
        wait: { type: 'boolean' },
        waitTimeoutSeconds: { type: 'integer', min: 1 },
      },
    },
    paths: { type: 'object', fields: { ignore: strings, reset: strings } },
    hooks: { type: 'object', fields: { reset: hooks, afterReset: hooks, afterUpdate: hooks } },
    statusPage: {
      type: 'object',
      fields: {
        port: { type: 'integer', min: 1, max: 65535 },
        links: {
          type: 'array',
          items: {
            type: 'object',
            fields: {
              label: str({ required: true }),
              url: str({ required: true, pattern: /^https?:\/\/\S+$/, hint: 'an http(s) URL' }),
            },
          },
        },
      },
    },
  },
};

function check(value, spec, path, errors) {
  const at = path || 'config';
  switch (spec.type) {
    case 'string':
      if (typeof value !== 'string' || value === '') return errors.push(`${at} must be a non-empty string`);
      if (spec.pattern && !spec.pattern.test(value)) errors.push(`${at} must be ${spec.hint ?? spec.pattern}`);
      if (spec.repoPath && (isAbsolute(value) || value.split(/[\\/]/).includes('..')))
        errors.push(`${at} must be a path inside the repo, without ..`);
      return;
    case 'integer':
      if (!Number.isInteger(value)) return errors.push(`${at} must be a whole number`);
      if (spec.min !== undefined && value < spec.min) errors.push(`${at} must be at least ${spec.min}`);
      if (spec.max !== undefined && value > spec.max) errors.push(`${at} must be at most ${spec.max}`);
      return;
    case 'boolean':
      if (typeof value !== 'boolean') errors.push(`${at} must be true or false`);
      return;
    case 'array':
      if (!Array.isArray(value)) return errors.push(`${at} must be a list`);
      value.forEach((v, i) => check(v, spec.items, `${at}[${i}]`, errors));
      return;
    case 'map':
      if (!value || typeof value !== 'object' || Array.isArray(value)) return errors.push(`${at} must be an object`);
      for (const [k, v] of Object.entries(value)) {
        if (!spec.keys.test(k)) errors.push(`${at}.${k} is not a valid environment variable name`);
        check(v, spec.values, `${at}.${k}`, errors);
      }
      return;
    case 'object': {
      if (!value || typeof value !== 'object' || Array.isArray(value)) return errors.push(`${at} must be an object`);
      for (const k of Object.keys(value))
        if (!(k in spec.fields)) errors.push(`${path ? path + '.' : ''}${k} is not a known setting`);
      for (const [k, s] of Object.entries(spec.fields)) {
        const p = path ? `${path}.${k}` : k;
        if (value[k] === undefined) {
          if (s.required) errors.push(`${p} is required`);
        } else check(value[k], s, p, errors);
      }
    }
  }
}

/** Errors for a parsed config, as readable lines. Empty means valid. */
export function validate(raw) {
  const errors = [];
  check(raw, SCHEMA, '', errors);
  if (errors.length) return errors;
  if (TOKEN_LIKE.test(JSON.stringify(raw)))
    errors.push('The config contains what looks like a token. Put it in a file and use git.tokenFile, or use git.tokenEnv.');
  if (raw.git.tokenFile && raw.git.tokenEnv) errors.push('Set git.tokenFile or git.tokenEnv, not both');
  errors.push(...remoteErrors(raw.git.remote));
  if (raw.compose.project.startsWith('rapid-reload-'))
    errors.push('compose.project must not start with rapid-reload- (that prefix is the poller itself)');
  return errors;
}

function remoteErrors(remote) {
  if (remote.startsWith('https://')) {
    let url;
    try {
      url = new URL(remote);
    } catch {
      return ['git.remote is not a valid URL'];
    }
    if (url.username || url.password)
      return ['git.remote must not contain a user name or password. Use git.tokenFile or git.tokenEnv.'];
    return [];
  }
  if (remote.startsWith('file://') || isAbsolute(remote)) return [];
  return ['git.remote must be an https:// URL (or a local path, for testing). SSH remotes are not supported: use https with a read-only token.'];
}

export function expandHome(p, base) {
  const s = p === '~' ? homedir() : p.startsWith('~/') ? join(homedir(), p.slice(2)) : p;
  return isAbsolute(s) ? resolve(s) : resolve(base, s);
}

/** Refuses folders where deleting the contents would be a disaster: /, the home folder, or anything shallow. */
export function stateDirErrors(dir) {
  const home = homedir();
  const parts = dir.split(sep).filter(Boolean);
  if (!isAbsolute(dir)) return [`stateDir must be absolute: ${dir}`];
  if (dir === home || (home + sep).startsWith(dir + sep) || parts.length < 3)
    return [`stateDir ${dir} is not safe: use a dedicated folder at least three levels deep, such as ~/.cache/rapid-reload/<name>`];
  return [];
}

/** Applies defaults and resolves host paths. `configDir` is where relative host paths start. */
export function normalize(raw, configDir) {
  const c = raw.compose;
  return {
    name: raw.name,
    stateDir: expandHome(raw.stateDir ?? `~/.cache/rapid-reload/${raw.name}`, configDir),
    pollIntervalSeconds: raw.pollIntervalSeconds ?? 60,
    git: {
      remote: raw.git.remote,
      branch: raw.git.branch,
      tokenFile: raw.git.tokenFile ? expandHome(raw.git.tokenFile, configDir) : null,
      tokenEnv: raw.git.tokenEnv ?? null,
      tokenUsername: raw.git.tokenUsername ?? 'x-access-token',
      keepOnClean: raw.git.keepOnClean ?? [],
    },
    compose: {
      project: c.project,
      dir: c.dir ?? '.',
      files: c.files ?? ['compose.yaml'],
      profiles: c.profiles ?? [],
      services: c.services ?? [],
      env: c.env ?? {},
      envFile: c.envFile ? expandHome(c.envFile, configDir) : null,
      wait: c.wait ?? true,
      waitTimeoutSeconds: c.waitTimeoutSeconds ?? 600,
    },
    paths: { ignore: raw.paths?.ignore ?? [], reset: raw.paths?.reset ?? [] },
    hooks: {
      reset: raw.hooks?.reset ?? [],
      afterReset: raw.hooks?.afterReset ?? [],
      afterUpdate: raw.hooks?.afterUpdate ?? [],
    },
    statusPage: { port: raw.statusPage?.port ?? DEFAULT_STATUS_PORT, links: raw.statusPage?.links ?? [] },
  };
}

/** Reads and validates a config file. Throws ConfigError listing every problem. */
export function loadConfig(file) {
  let text;
  try {
    text = readFileSync(file, 'utf8');
  } catch {
    throw new ConfigError(`No config at ${file}. Run: npx rapid-reload init`);
  }
  let raw;
  try {
    raw = JSON.parse(text);
  } catch (e) {
    throw new ConfigError(`${file} is not valid JSON: ${e.message}`);
  }
  const errors = validate(raw);
  if (errors.length) throw new ConfigError(`${file}:\n  - ${errors.join('\n  - ')}`);
  const config = normalize(raw, dirname(resolve(file)));
  const unsafe = stateDirErrors(config.stateDir);
  if (unsafe.length) throw new ConfigError(unsafe.join('\n'));
  return config;
}

/** KEY=VALUE lines; blank lines and # comments are skipped, surrounding quotes removed. */
export function parseEnvFile(text) {
  const env = {};
  for (const line of text.split('\n')) {
    const m = line.match(/^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*?)\s*$/);
    if (!m) continue;
    env[m[1]] = m[2].replace(/^(['"])(.*)\1$/, '$2');
  }
  return env;
}
