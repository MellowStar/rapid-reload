# rapid-reload

Keeps a local Docker Compose stack running the latest commit of a Git branch. Push to the branch and, within a minute,
the stack on your machine is rebuilt and restarted. Only the services whose images changed are recreated, and your
databases are wiped only when you say a change needs it.

It is made for a branch such as `pre-merge` that collects work before it reaches `main`. Anyone can then click through
the result on a real stack without checking anything out.

> [!WARNING]
> The poller container mounts the Docker socket, which gives it full control of your machine's Docker, and so of the
> machine. It builds and runs whatever the followed branch contains. Point it only at a branch that people you trust
> push to. Read [SECURITY.md](SECURITY.md) before using it.

## How it works

Every minute (`pollIntervalSeconds`) the poller fetches the branch. When the branch has moved, it compares the new
commit with the last one that deployed successfully, and picks one of three updates:

| Changed paths | Update |
| --- | --- |
| All match `paths.ignore` | Nothing is rebuilt or restarted |
| Any match `paths.reset` | Build everything, remove the stack and its volumes, run `hooks.reset`, start, run `hooks.afterReset` |
| Anything else | Build, then `docker compose up -d`. Compose recreates only the containers whose image or config changed. Services with a changed bind-mounted file are restarted. Then `hooks.afterUpdate` runs |

The very first update is always a reset.

What gets rebuilt comes from Docker, not from path rules. BuildKit's cache knows each image's real inputs: a commit
that touches none of the files an image copies leaves that image, and its container, untouched.

These behaviours keep the stack usable:

- **The build always runs first.** If it fails, the old stack keeps running and the status page shows the failed step.
- **A failed commit isn't retried every minute.** The poller waits for the next push, or for `rapid-reload retry`.
- **Updates are compared with the last good one,** so a failed commit's changes are still covered by the next update.
- **If the branch is force-pushed** so the last good commit is gone, the poller resets when `paths.reset` is set, and
  rebuilds otherwise.
- **It survives restarts.** It starts again with Docker and restarts any stopped containers in the stack.

## Requirements

- Docker with Compose v2: Docker Desktop on macOS or Windows, or Docker Engine on Linux.
- Node.js 24 or later, only for the `rapid-reload` command. The poller itself runs in a container.
- A Compose file for the project. If you only have a Dockerfile, three lines of Compose are enough; see
  [examples/single-dockerfile](examples/single-dockerfile).
- An `https://` Git remote. SSH remotes aren't supported; private repos use a read-only token.

## Quick start

In the root of the repo you want to follow:

```bash
npx rapid-reload init      # writes rapid-reload.config.json from your Compose file
# edit the config: the branch, ports, reset paths and hooks
npx rapid-reload doctor    # checks Docker, the config, the token and the Compose files
npx rapid-reload start     # builds and starts the poller
```

Then open the status page, at <http://127.0.0.1:18091> by default.

Commit the config so everyone on the team runs the same stack, and pin the version in your docs, for example
`npx rapid-reload@0.1.0 start`.

## Create a token

Skip this for a public repo, and remove `git.tokenFile` from the config.

For GitHub, create a [fine-grained personal access token](https://github.com/settings/personal-access-tokens/new):

- Repository access: only the repo you're following.
- Permissions: **Contents: Read-only**, nothing else.

Then save it where `git.tokenFile` points:

```bash
mkdir -p ~/.cache/rapid-reload/my-app
(umask 077; pbpaste > ~/.cache/rapid-reload/my-app/git-token)   # macOS, with the token copied
```

On Linux, replace `pbpaste` with `xclip -o`, or paste it into `cat > file` and press Ctrl-D.

For other Git hosts, use a read-only token and set `git.tokenUsername` to what that host expects. For GitLab, this is
`oauth2`.

Instead of a file, you can set `git.tokenEnv` to the name of an environment variable that holds the token when you run
`start`. Never put the token itself in the config: `doctor` and `start` refuse a config that contains one.

## Configuration

`rapid-reload.config.json`, in your repo root, or anywhere you pass with `--config`.

```json
{
  "name": "shop",
  "git": {
    "remote": "https://github.com/acme/shop.git",
    "branch": "pre-merge",
    "tokenFile": "~/.cache/rapid-reload/shop/git-token"
  },
  "compose": {
    "project": "shop-reload",
    "dir": "deploy",
    "files": ["compose.yaml"],
    "services": ["web", "api", "db"],
    "env": { "WEB_PORT": "18080" }
  },
  "paths": {
    "ignore": ["docs/**", "**/*.md"],
    "reset": ["db/migrations/**"]
  },
  "hooks": {
    "reset": [{ "label": "Migrating", "run": "bash scripts/migrate.sh" }],
    "afterReset": [{ "label": "Adding test data", "run": "bash scripts/seed-test-data.sh" }]
  },
  "statusPage": {
    "port": 18091,
    "links": [{ "label": "Shop", "url": "http://127.0.0.1:18080" }]
  }
}
```

| Setting | Default | Meaning |
| --- | --- | --- |
| `name` | required | Short id for this poller: lowercase letters, digits, `-`, `_`. Each project on a machine needs its own. |
| `stateDir` | `~/.cache/rapid-reload/<name>` | Where the poller keeps its clone, logs and state. Must be a dedicated folder. |
| `pollIntervalSeconds` | `60` | How often to check the branch. Minimum 10. |
| `git.remote` | required | `https://` URL of the repo. Never include credentials. |
| `git.branch` | required | The branch to follow. |
| `git.tokenFile` | none | File holding a read-only token. `~` is expanded. Relative paths start at the config's folder. |
| `git.tokenEnv` | none | Or: environment variable holding the token when you run `start`. |
| `git.tokenUsername` | `x-access-token` | User name sent with the token. GitHub ignores it; GitLab wants `oauth2`. |
| `git.keepOnClean` | `[]` | Paths that `git clean` must leave alone in the poller's clone, such as a gitignored data folder. |
| `compose.project` | required | Compose project name for this stack. Must differ from your dev stack's: `start` refuses otherwise. |
| `compose.dir` | `.` | Folder holding the Compose files, relative to the repo root. |
| `compose.files` | `["compose.yaml"]` | Compose files, relative to `compose.dir`. Later files override earlier ones. |
| `compose.profiles` | `[]` | Profiles active while building and resetting, such as one holding migration jobs. |
| `compose.services` | all default services | The services to build, start and keep running. |
| `compose.env` | `{}` | Variables for Compose interpolation, such as ports that differ from your dev stack's. |
| `compose.envFile` | none | A `KEY=VALUE` file read by `start` on your machine, for values that differ per machine. |
| `compose.wait` | `true` | Wait for services to be running and healthy before an update counts as done. |
| `compose.waitTimeoutSeconds` | `600` | How long to wait. |
| `paths.ignore` | `[]` | Globs for paths that never need an update, such as docs. |
| `paths.reset` | `[]` | Globs for paths that need fresh data, such as migrations or database init scripts. Empty means data is only wiped on the first update. |
| `hooks.reset` | `[]` | Steps run after the wipe, before services start: start databases, run migrations. |
| `hooks.afterReset` | `[]` | Steps run once services are up on fresh data: test data, an admin login. |
| `hooks.afterUpdate` | `[]` | Steps run after every non-reset update. They must be safe to re-run. |
| `statusPage.port` | `18091` | Status page port, on 127.0.0.1 only. |
| `statusPage.links` | `[]` | Links shown on the status page, such as the apps in the stack. |

**Globs** use Node's [`path.matchesGlob`](https://nodejs.org/api/path.html#pathmatchesglobpath-pattern): `*` within one
folder, `**` across folders. Paths starting with a dot need the dot in the pattern: `**/*.md` doesn't match
`.github/x.md`, so add `.github/**` if you want it ignored. When a path matches both lists, `ignore` wins.

**Hooks** are shell commands run with `bash -c` from the repo root of the poller's clone, inside the poller container.
That container has bash, git, Node.js 24 and the Docker CLI. Each hook gets these variables, so a plain
`docker compose ...` targets the pre-merge stack:

| Variable | Value |
| --- | --- |
| `COMPOSE_PROJECT_NAME`, `COMPOSE_FILE`, `COMPOSE_PROFILES` | The stack's project, files and profiles |
| `RAPID_RELOAD_REPO` | The clone's path |
| `RAPID_RELOAD_BRANCH`, `RAPID_RELOAD_COMMIT` | What is being deployed |
| Everything in `compose.env` | |

A failing hook fails the update, and the status page names it.

**The poller re-reads your local config file on every check,** never the copy in the branch, so a pushed commit can't
change it. Editing `git.branch`, `git.keepOnClean`, `compose`, `paths` or `hooks` takes effect on the next check with
no restart: a new branch is fetched and deployed, and a config change with no code change still updates the stack
(a `paths.reset` match in the code diff still resets). This lets an agent point the stack at its own branch by editing
the config instead of pushing to a shared one. The poller mounts the config's folder read-only for this. Other
settings (`name`, `git.remote` and token settings, `compose.envFile`, `pollIntervalSeconds`, `statusPage`) apply only
after `start`; the events log says when one of them changed. An invalid edit fails the check until it is fixed, and the
running stack is left alone. Hook scripts come from the branch.

## Commands

| Command | What it does |
| --- | --- |
| `init` | Writes a starter config from your Compose file and Git remote. `--dir <folder>` if the Compose file isn't in the root, `--branch <name>`, `--force` to overwrite. |
| `doctor` | Checks Docker, the config, the token, access to the branch, the status port, your Compose services and hook scripts. It also warns about images that rebuild on every commit. |
| `start` | Validates the config, then builds and starts the poller. Safe to rerun. `--adopt` takes over a state folder from an older poller. |
| `status` | One-line summary. `--json` for scripts. |
| `check` | Checks the branch now instead of waiting. |
| `retry` | Retries the current commit after a failed update. |
| `logs` | Follows the poller's log. |
| `stop` | Stops the poller. The stack keeps running; `start` resumes it. |
| `uninstall --yes` | Removes the stack and its volumes and built images, the state folder (including a token kept there) and the poller. |

All commands take `--config <file>`.

## Status page

The status page shows the current step, the running commit and the branch that brought it in, the last plan, the
containers, recent activity and the latest build output. It refreshes itself.

| Status | Meaning |
| --- | --- |
| `idle` | The stack runs the latest commit |
| `working` | An update is running. The old containers serve until they are replaced |
| `failed` | The update failed. The page shows the step; the next push or `retry` tries again |
| `blocked` | The token is missing |

## Faster updates: narrow your image sources

If a Dockerfile builds from the repo root and runs `COPY . .`, every file is an input to that image, so every commit
rebuilds and restarts it. `doctor` warns about these. Copy only what each image needs:

```dockerfile
# Before: any change anywhere rebuilds this image
COPY . .

# After: only these paths are inputs
COPY package.json package-lock.json ./
COPY shared/ shared/
COPY services/api/ services/api/
```

Or keep `COPY . .` and give the image its own ignore file, `<Dockerfile name>.dockerignore` next to the Dockerfile,
that excludes the other services. This also speeds up your normal builds.

## Several projects on one machine

Give each project its own `name`, `compose.project`, `statusPage.port`, and published ports through `compose.env`.
Each poller runs as its own Compose project, `rapid-reload-<name>`, with its own state folder. `start` refuses a
status port that is already in use.

## Troubleshooting

- **`blocked`:** the token file is missing or empty. Add it, then rerun `start`.
- **Port already allocated:** the pre-merge stack publishes the same ports as your dev stack. Set different ports
  through `compose.env`, if your Compose file reads them from variables.
- **The stack has data from an earlier branch:** non-reset updates keep volumes. Add the paths that need fresh data to
  `paths.reset`, or run `uninstall --yes` and `start` to start over.
- **Changed the token:** rerun `start` so the container mounts the new file.
- **Something else:** `rapid-reload logs`, then the build output on the status page.

## Stop or remove it

```bash
npx rapid-reload stop             # pause; the stack keeps running
npx rapid-reload start            # resume
npx rapid-reload uninstall --yes  # remove the stack, its data, all poller state and the poller
```

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md). Coding agents: see [AGENTS.md](AGENTS.md).

## Licence

[MIT](LICENSE)
