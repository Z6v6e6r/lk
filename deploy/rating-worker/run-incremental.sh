#!/usr/bin/env bash
set -euo pipefail

INSTALL_ROOT=${RATING_WORKER_INSTALL_ROOT:-/opt/padlhub-rating-worker}
exec /usr/bin/env bash \
  "$INSTALL_ROOT/current/deploy/rating-worker/run-with-watchdog.sh" \
  incremental
