#!/usr/bin/env bash
# hooks.afterReset: test data for the fresh databases. Safe to re-run.
set -euo pipefail
docker compose exec -T db psql -U postgres -q -v ON_ERROR_STOP=1 \
  -c "INSERT INTO marks VALUES ('seeded') ON CONFLICT DO NOTHING"
