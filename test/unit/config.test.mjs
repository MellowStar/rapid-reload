import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { ConfigError, loadConfig, normalize, parseEnvFile, stateDirErrors, validate } from '../../src/config.mjs';

const base = () => ({
  name: 'shop',
  git: { remote: 'https://github.com/acme/shop.git', branch: 'pre-merge', tokenFile: '~/.cache/shop/token' },
  compose: { project: 'shop-reload' },
});
const errorsFor = (mutate) => {
  const c = base();
  mutate(c);
  return validate(c).join('\n');
};

test('a minimal config is valid and gets defaults', () => {
  assert.deepEqual(validate(base()), []);
  const n = normalize(base(), '/repo');
  assert.equal(n.stateDir, join(homedir(), '.cache/rapid-reload/shop'));
  assert.equal(n.git.tokenFile, join(homedir(), '.cache/shop/token'));
  assert.equal(n.git.tokenUsername, 'x-access-token');
  assert.deepEqual(n.compose.files, ['compose.yaml']);
  assert.deepEqual(n.paths.reset, []);
  assert.equal(n.pollIntervalSeconds, 60);
});

test('a token in the config is refused', () => {
  assert.match(errorsFor((c) => (c.git.tokenEnv = undefined, (c.compose.env = { X: 'ghp_' + 'a'.repeat(36) }))), /looks like a token/);
  assert.match(errorsFor((c) => (c.git.remote = 'https://x:secret@github.com/acme/shop.git')), /user name or password/);
});

test('remotes must be https or local', () => {
  assert.match(errorsFor((c) => (c.git.remote = 'git@github.com:acme/shop.git')), /SSH remotes are not supported/);
  assert.equal(errorsFor((c) => (c.git.remote = '/srv/git/shop.git')), '');
});

test('names, unknown keys and paths are checked', () => {
  assert.match(errorsFor((c) => (c.name = 'Shop App')), /name must be/);
  assert.match(errorsFor((c) => (c.compose.project = 'rapid-reload-shop')), /rapid-reload-/);
  assert.match(errorsFor((c) => (c.compose.servces = ['web'])), /compose\.servces is not a known setting/);
  assert.match(errorsFor((c) => (c.compose.dir = '../other')), /inside the repo/);
  assert.match(errorsFor((c) => (c.git.tokenEnv = 'TOKEN')), /not both/);
  assert.match(errorsFor((c) => (c.statusPage = { links: [{ label: 'x', url: 'javascript:alert(1)' }] })), /http\(s\) URL/);
  assert.match(errorsFor((c) => (c.hooks = { reset: [{ label: 'x' }] })), /hooks\.reset\[0\]\.run is required/);
});

test('unsafe state folders are refused', () => {
  assert.notDeepEqual(stateDirErrors('/'), []);
  assert.notDeepEqual(stateDirErrors(homedir()), []);
  assert.notDeepEqual(stateDirErrors('/tmp'), []);
  assert.deepEqual(stateDirErrors(join(homedir(), '.cache/rapid-reload/shop')), []);
});

test('loadConfig reports every problem at once', () => {
  const dir = mkdtempSync(join(tmpdir(), 'ppcfg-'));
  const file = join(dir, 'c.json');
  writeFileSync(file, JSON.stringify({ name: 'x' }));
  assert.throws(() => loadConfig(file), (e) => e instanceof ConfigError && /git is required/.test(e.message) && /compose is required/.test(e.message));
  writeFileSync(file, '{ nope');
  assert.throws(() => loadConfig(file), /not valid JSON/);
});

test('env files', () => {
  assert.deepEqual(parseEnvFile('# c\nA=1\nexport B="two"\n\nC = \'3\'\nnot a line\n'), { A: '1', B: 'two', C: '3' });
});

test('liveConfig takes branch, compose, paths and hooks from the live file and keeps the rest', async () => {
  const { liveConfig, liveFingerprint, normalize } = await import('../../src/config.mjs');
  const raw = base();
  const stored = { ...normalize(raw, '/repo'), configFile: '/repo/rapid-reload.config.json', envFileEnv: { A: '1' } };
  const live = structuredClone(raw);
  live.git.branch = 'agent/feature-x';
  live.compose.env = { B: '2' };
  live.paths = { reset: ['db/**'] };
  const { config, errors, needsRestart } = liveConfig(stored, live);
  assert.deepEqual(errors, []);
  assert.deepEqual(needsRestart, []);
  assert.equal(config.git.branch, 'agent/feature-x');
  assert.equal(config.git.remote, stored.git.remote);
  assert.deepEqual(config.compose.env, { A: '1', B: '2' });
  assert.deepEqual(config.paths.reset, ['db/**']);
  assert.notEqual(liveFingerprint(config), liveFingerprint(stored));

  live.statusPage = { port: 19999 };
  live.git.remote = 'https://example.com/other.git';
  const r = liveConfig(stored, live);
  assert.deepEqual(r.needsRestart, ['git.remote', 'statusPage']);
  assert.equal(r.config.git.remote, stored.git.remote);
  assert.equal(r.config.statusPage.port, stored.statusPage.port);

  live.git.branch = '--bad';
  assert.ok(liveConfig(stored, live).errors.length);
});
