// Pure decisions: no I/O, so every rule is unit-tested.
import { matchesGlob } from 'node:path';

const matches = (path, globs) => globs.some((g) => matchesGlob(path, g));

/**
 * What an update should do.
 *   changed:  paths changed since the last good update, or null when that can't be worked out
 *   deployed: the last good commit, or '' when nothing has deployed yet
 *   configChanged: the live config settings differ from the last attempted update's
 *   rebuild: someone asked for a rebuild (status page), so an update runs even when nothing changed
 * Returns { action: 'none' | 'update' | 'reset', reason }.
 */
export function plan({ changed, deployed, ignore = [], reset = [], configChanged = false, rebuild = false }) {
  if (!deployed) return { action: 'reset', reason: 'first update' };
  if (changed === null)
    return reset.length
      ? { action: 'reset', reason: 'the last good commit is no longer in the branch history' }
      : { action: 'update', reason: 'the last good commit is no longer in the branch history' };
  // Ignore wins over reset, so a README next to the migrations never wipes data.
  const relevant = changed.filter((p) => p && !matches(p, ignore));
  if (!relevant.length && configChanged) return { action: 'update', reason: 'the config file changed' };
  if (!relevant.length && rebuild) return { action: 'update', reason: 'rebuild requested' };
  if (!relevant.length)
    return { action: 'none', reason: changed.length ? 'only ignored paths changed' : 'nothing changed' };
  const hit = relevant.find((p) => matches(p, reset));
  if (hit) return { action: 'reset', reason: `${hit} matches paths.reset` };
  return { action: 'update', reason: `${relevant.length} changed path${relevant.length === 1 ? '' : 's'}` };
}

/** Services to restart because a file they bind-mount changed. binds: [{ service, source }] with repo-relative sources. */
export function bindRestarts(changed, binds) {
  const hit = new Set();
  for (const { service, source } of binds)
    if (changed.some((p) => p === source || p.startsWith(source.replace(/\/$/, '') + '/'))) hit.add(service);
  return [...hit].sort();
}

/** The merged branch from a merge commit subject, or ''. */
export function mergeSource(subject) {
  const m = subject.match(/^Merge (?:remote-tracking )?branch '([^']+)'/);
  return m ? m[1].replace(/^origin\//, '') : '';
}

/** Branches (other than the followed one) whose tip is the commit or its merged parent. heads: `git ls-remote --heads` output. */
export function branchesAt(heads, sha, parent, branch) {
  return heads
    .split('\n')
    .map((l) => l.split('\t'))
    .filter(([id, ref]) => ref && ref !== `refs/heads/${branch}` && (id === sha || (parent && id === parent)))
    .map(([, ref]) => ref.replace('refs/heads/', ''));
}

/** Compose project name Compose would use for a folder when the file sets none. */
export function defaultProjectName(folderName) {
  return folderName.toLowerCase().replace(/[^a-z0-9_-]/g, '');
}

/** Top-level `name:` from a Compose file, or ''. */
export function composeFileName(text) {
  const m = text.match(/^name:\s*['"]?([^'"\s#]+)/m);
  return m ? m[1] : '';
}

export const COMPOSE_FILES = ['compose.yaml', 'compose.yml', 'docker-compose.yaml', 'docker-compose.yml'];

/** Folders (repo-relative, '.' for the root) holding a Compose file, from a list of repo paths. Shallowest first. */
export function composeDirs(paths) {
  const dirs = new Set();
  for (const p of paths) {
    const parts = p.split('/');
    if (COMPOSE_FILES.includes(parts.at(-1)) && !parts.includes('node_modules'))
      dirs.add(parts.slice(0, -1).join('/') || '.');
  }
  const depth = (d) => (d === '.' ? 0 : d.split('/').length);
  return [...dirs].sort((a, b) => depth(a) - depth(b) || a.localeCompare(b));
}

/** True when a Dockerfile copies its whole build context, so any file change rebuilds the image. */
export function copiesWholeContext(dockerfile) {
  return /^\s*(COPY|ADD)\s+(--\S+\s+)*\.\/?\s+\S+\s*$/im.test(dockerfile);
}
