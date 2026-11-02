#!/usr/bin/env bash
# hooks.reset: runs after the wipe, before the services start. The poller sets COMPOSE_PROJECT_NAME, COMPOSE_FILE and
# COMPOSE_PROFILES, so plain `docker compose` commands target the pre-merge stack. Migrations would go here.
set -euo pipefail
docker compose up -d --wait db
