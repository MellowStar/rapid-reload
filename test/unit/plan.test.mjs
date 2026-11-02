import { test } from 'node:test';
import assert from 'node:assert/strict';
import { bindRestarts, branchesAt, composeFileName, copiesWholeContext, defaultProjectName, mergeSource, plan } from '../../src/plan.mjs';

const rules = { ignore: ['docs/**', '**/*.md'], reset: ['db/**', 'migrations/**'] };
const action = (changed, extra = {}) => plan({ changed, deployed: 'abc', ...rules, ...extra }).action;

test('first update is always a reset', () => {
  assert.equal(plan({ changed: null, deployed: '', ...rules }).action, 'reset');
  assert.equal(plan({ changed: [], deployed: '' }).action, 'reset');
});

test('only ignored paths, or nothing, means no update', () => {
  assert.equal(action(['README.md', 'docs/a.txt', 'web/NOTES.md']), 'none');
  assert.equal(action([]), 'none');
});

test('a reset path wipes, even mixed with other changes', () => {
  assert.equal(action(['db/init.sql']), 'reset');
  assert.equal(action(['web/a.js', 'migrations/002.sql']), 'reset');
  assert.match(plan({ changed: ['web/a.js', 'db/x.sql'], deployed: 'abc', ...rules }).reason, /db\/x\.sql/);
});

test('ignore wins over reset', () => {
  assert.equal(action(['db/README.md']), 'none');
});

test('anything else is an update, never a wipe', () => {
  assert.equal(action(['web/a.js']), 'update');
  assert.equal(action(['package.json', 'tests/x.test.js']), 'update');
});

test('unknown changes reset only when the project opted into resets', () => {
  assert.equal(plan({ changed: null, deployed: 'abc', ...rules }).action, 'reset');
  assert.equal(plan({ changed: null, deployed: 'abc', ignore: [], reset: [] }).action, 'update');
});

test('dotfiles need an explicit pattern', () => {
  assert.equal(action(['.github/x.md']), 'update');
  assert.equal(action(['.github/x.md'], { ignore: ['.github/**'] }), 'none');
});

test('bind-mounted files restart their service', () => {
  const binds = [
    { service: 'web', source: 'web-config/message.txt' },
    { service: 'proxy', source: 'proxy' },
    { service: 'db', source: 'db/init.sql' },
  ];
  assert.deepEqual(bindRestarts(['web-config/message.txt'], binds), ['web']);
  assert.deepEqual(bindRestarts(['proxy/Caddyfile', 'db/init.sql'], binds), ['db', 'proxy']);
  assert.deepEqual(bindRestarts(['proxyfile', 'web-config/other.txt'], binds), []);
});

test('merge subjects name the merged branch', () => {
  assert.equal(mergeSource("Merge branch 'feature/x' into HEAD"), 'feature/x');
  assert.equal(mergeSource("Merge remote-tracking branch 'origin/fix/y' into pre-merge"), 'fix/y');
  assert.equal(mergeSource('feat: something'), '');
});

test('branches at the commit or its merged parent, excluding the followed branch', () => {
  const heads = 'aaa\trefs/heads/pre-merge\naaa\trefs/heads/feature/a\nbbb\trefs/heads/feature/b\nccc\trefs/heads/main\n';
  assert.deepEqual(branchesAt(heads, 'aaa', 'bbb', 'pre-merge'), ['feature/a', 'feature/b']);
  assert.deepEqual(branchesAt(heads, 'zzz', '', 'pre-merge'), []);
});

test('Compose project names', () => {
  assert.equal(defaultProjectName('My.App'), 'myapp');
  assert.equal(composeFileName('# x\nname: shop\nservices: {}\n'), 'shop');
  assert.equal(composeFileName("name: 'shop'\n"), 'shop');
  assert.equal(composeFileName('services:\n  web:\n    name: x\n'), '');
});

test('whole-context copies are spotted', () => {
  assert.equal(copiesWholeContext('FROM node\nCOPY . .\n'), true);
  assert.equal(copiesWholeContext('FROM node\nCOPY --chown=node:node . /app\n'), true);
  assert.equal(copiesWholeContext('FROM node\nADD ./ /app\n'), true);
  assert.equal(copiesWholeContext('FROM node\nCOPY package.json ./\nCOPY src/ ./src/\n'), false);
});
