# The poller. It holds the Docker socket, which is host-level access: local use only. See SECURITY.md.
# Base images are pinned by digest; Dependabot proposes updates.
FROM docker:29-cli@sha256:5e6baf67325a79f64ed3bed6863954d5e05d0f3d4e57cbdb14809346814bbfdb AS docker
FROM node:26-slim@sha256:e4db4c914bf8ad241bd24804fc25d272d89bad97e68cdc8a1414862790a02c39
COPY --from=docker /usr/local/bin/docker /usr/local/bin/docker
COPY --from=docker /usr/local/libexec/docker/cli-plugins/docker-compose /usr/local/libexec/docker/cli-plugins/docker-compose
COPY --from=docker /usr/local/libexec/docker/cli-plugins/docker-buildx /usr/local/libexec/docker/cli-plugins/docker-buildx
RUN apt-get update && apt-get install -y --no-install-recommends ca-certificates git \
  && rm -rf /var/lib/apt/lists/* \
  && git config --system --add safe.directory '*'
COPY src/ /poller/src/
CMD ["node", "/poller/src/poll.mjs", "run"]
