# AGENTS.md

Instructions for coding agents. There are two cases: setting the poller up in a project, and changing this package.

## Setting it up in a project

1. **Ask the owner before you start the poller.** It mounts the Docker socket, which is full control of the machine,
   and a reset deletes the stack's volumes. Starting it is their decision; preparing the config is yours.
2. From the repo root, run `npx rapid-reload@<version> init`. If the Compose file isn't in the root, add
   `--dir <folder>`.
3. Edit `rapid-reload.config.json`:
   - `git.branch`: the branch to follow. Any branch works (no pre-merge or integration branch is needed), but never
     one that untrusted people can push to. The poller re-reads the config on every check, so changing this later
     switches the stack to the new branch without rerunning `start`.
   - `compose.project`: must differ from the dev stack's project name. `start` refuses a clash.
   - `compose.services`: the long-running services only. Leave out one-shot jobs; run those from hooks.
   - `compose.env`: published ports that differ from the dev stack's, if the Compose file reads them from variables.
   - `paths.ignore`: docs and other files no image uses.
   - `paths.reset`: only what really needs empty databases, such as migrations, database init scripts and the Compose
     files that define the databases.
   - `hooks.reset`: start the databases and run migrations. `hooks.afterReset`: seed and test data. Hook scripts must
     use plain `docker compose` (the poller sets `COMPOSE_PROJECT_NAME`, `COMPOSE_FILE` and `COMPOSE_PROFILES`) and
     must be safe to re-run.
   - `statusPage.port` and `statusPage.links`.
4. **Never write a token into the config or any committed file.** Use `git.tokenFile` pointing outside the repo. The
   owner creates the token and puts it in that file.
5. Run `npx rapid-reload doctor` and fix every `FAIL`. Report each `warn` to the owner, especially images that
   rebuild on every commit.
6. Commit the config and any hook scripts. Document the `start` command, pinned to an exact version, in the project's
   README.

## Changing this package

- **Layout:** `src/plan.mjs` holds pure decisions, `src/config.mjs` validation, `src/poll.mjs` the update loop that
  runs in the container, `src/status-server.mjs` the page and `src/cli.mjs` the host commands.
- **Keep `plan.mjs` pure,** with no I/O. Every rule in it has a unit test in `test/unit/`.
- **Keep the safety properties:**
  - build before wipe
  - record the attempted commit before updating
  - compare with the last good commit
  - the token never reaches a URL, `.git/config`, the process list, logs or the status page
  - the status page binds to loopback only
  - nothing is deleted from a folder without the `.rapid-reload` marker
  - `compose.project` can't equal the dev stack's
- **No runtime dependencies.** Node's standard library only, because this tool holds the Docker socket and every
  dependency would be supply chain with host access.
- **Nothing project-specific:** no project names, hosts, ports or passwords from a project that uses the tool. Those
  belong in that project's config.
- **Before you finish, run:**
  - `npm test` for unit tests, which take seconds
  - `npm run test:e2e` if `poll.mjs`, `cli.mjs` or `container/` changed; it needs Docker and takes a few minutes
  - `npm run check:clean`
- Update `README.md` for any behaviour or config change, and add a line to `CHANGELOG.md`.
- Don't publish, tag or push. Releases are the maintainer's job (see CONTRIBUTING.md).
