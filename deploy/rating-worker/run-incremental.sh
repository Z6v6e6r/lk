#!/usr/bin/env bash
set -euo pipefail
umask 027

INSTALL_ROOT=/opt/padlhub-rating-worker
LOG_DIR=/var/log/padlhub-rating-worker
mkdir -p "$LOG_DIR"

exec flock -n /var/lock/padlhub-rating-worker.lock \
  /usr/bin/env node \
  "$INSTALL_ROOT/current/scripts/run_rating_worker_147.mjs" \
  --mode incremental >> "$LOG_DIR/incremental.log" 2>&1
