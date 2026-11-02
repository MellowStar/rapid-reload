// Fails if the package contains token-shaped strings, or any string listed in .forbidden-strings (one per line,
// gitignored: list names, hosts and passwords from projects that use the tool, so none leak into this public repo).
import { readFileSync, existsSync } from 'node:fs';
import { execFileSync } from 'node:child_process';

const TOKEN = /(gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,}|glpat-[A-Za-z0-9_-]{20,}|-----BEGIN [A-Z ]*PRIVATE KEY-----)/;
const forbidden = existsSync('.forbidden-strings')
  ? readFileSync('.forbidden-strings', 'utf8').split('\n').map((s) => s.trim()).filter((s) => s && !s.startsWith('#'))
  : [];
const files = execFileSync('git', ['ls-files', '--cached', '--others', '--exclude-standard'], { encoding: 'utf8' })
  .split('\n')
  .filter(Boolean);
const problems = [];
for (const f of files) {
  let text;
  try {
    text = readFileSync(f, 'utf8');
  } catch {
    continue;
  }
  if (TOKEN.test(text)) problems.push(`${f}: looks like it contains a secret`);
  for (const s of forbidden) if (text.toLowerCase().includes(s.toLowerCase())) problems.push(`${f}: contains a forbidden string`);
}
if (problems.length) {
  console.error(problems.join('\n'));
  process.exit(1);
}
console.log(`Clean: ${files.length} files checked${forbidden.length ? `, ${forbidden.length} forbidden strings` : ''}.`);
