# Changelog

## 0.3.0

- Status page: a form to change `git.branch` (written to the config file) and a "Rebuild now" button, with failures
  shown on the page. New look. The config file's folder is now mounted read-write; rerun `start` after upgrading.

## 0.2.0

- The poller re-reads the config file on every check: change `git.branch`, `compose`, `paths` or `hooks` and the next
  check deploys it, with no `start` and no push to the followed branch. Settings that need `start` are logged.
- Docs: any branch can be followed; a dedicated `pre-merge` branch is no longer assumed.

## 0.1.1

- `init` finds a Compose file in a subfolder, such as `platform/compose.yaml`, without `--dir`. When several folders
  have one, it lists them.
- Package metadata: `repository`, `homepage` and `bugs`, needed for npm provenance.
- Restored `.gitignore`, `.dockerignore` and the GitHub workflows (CI, release, Dependabot), which were missing from
  the first push.

## 0.1.0 (2026-11-02)

First version, generalised from a poller used in one project.

- Follows one branch and keeps a Compose stack on its latest commit.
- Lets BuildKit's cache decide what to rebuild, so only services whose images changed are recreated.
- Restarts services whose bind-mounted files changed.
- `paths.ignore` and `paths.reset` choose between no update, an update that keeps data, and a reset with fresh data.
- Hooks: `reset`, `afterReset` and `afterUpdate`.
- Status page on loopback.
- Commands: `init`, `doctor`, `start`, `status`, `check`, `retry`, `logs`, `stop` and `uninstall`.
- Safety:
  - refuses a token in the config
  - refuses a Compose project that matches the dev stack's
  - deletes nothing from a folder without its marker
