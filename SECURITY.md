# Security

## Trust model

rapid-reload is a local development tool. Know what it can do before you run it.

- **It has full control of your machine.** The poller container mounts the Docker socket. Anything that controls
  Docker can start a privileged container that mounts the host's file system, so this equals root on the machine, or,
  on Docker Desktop, full control of the Docker VM and the folders it shares.
- **It runs whatever the branch contains.** Each update builds the branch's Dockerfiles, starts its Compose services
  and runs its hook scripts. Anyone who can push to the followed branch can run code on your machine. Follow only
  branches that people you trust push to, and never a branch that takes unreviewed code from forks.
- **Its own settings come from your machine, not the branch.** The config is read when you run `start`, so a pushed
  commit can't change the remote, the branch, the hooks list or the project name. The hook scripts themselves come
  from the branch.
- **The status page has no login.** It listens on 127.0.0.1 only and can't be exposed to the network from the config.
  Anything on your machine can read it, including build output. Don't print secrets in your builds or hooks.

## How the token is handled

- The config holds only a path or a variable name. `start` and `doctor` refuse a config that looks like it contains a
  token, or a remote URL with a password in it.
- In the container, the token is a read-only mounted file. Git reads it through a credential helper each time, so it
  never appears in a URL, in `.git/config` or in a process's arguments.
- The token's value is removed from build output before it is written to the log.
- With `git.tokenEnv`, `start` writes the token to a file in the state folder with mode 600, so the container can
  mount it. `uninstall` deletes that file.
- Use a fine-grained token with read-only access to one repo. Nothing more is needed.

## Data safety

- **Resets delete the stack's volumes.** `start` refuses a `compose.project` that matches your dev stack's name, so a
  reset can't delete your dev data. Still, check `compose.project` carefully.
- **`uninstall` deletes only what the poller created.** It removes files only from a state folder that holds the
  marker file written by `start`, and the config refuses `/`, your home folder and other shallow paths.

## Reporting a vulnerability

Use GitHub's private vulnerability reporting: open the repo's **Security** tab and select **Report a vulnerability**.
Please don't open a public issue for security problems. Expect a reply within a week.

## Releases

- Releases are published to npm from GitHub Actions with provenance, so you can check that a version was built from
  this repo: `npm audit signatures`.
- The package has no runtime dependencies.
- The container's base images are pinned by digest.
