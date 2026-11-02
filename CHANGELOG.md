# Changelog

## 0.1.0 (unreleased)

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
