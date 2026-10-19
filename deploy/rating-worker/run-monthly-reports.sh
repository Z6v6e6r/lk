#!/usr/bin/env bash
set -euo pipefail
umask 077
release_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd -P)"
lock_file=${RATING_WORKER_LOCK_FILE:-/var/lock/padlhub-rating-worker.lock}
mkdir -p "$(dirname "$lock_file")"
{
  flock -w 840 -E 75 9
  /usr/bin/env RATING_WORKER_SHARED_LOCK_HELD=1 \
    timeout --signal=TERM --kill-after=30s 780s \
    node --experimental-strip-types "$release_root/scripts/community_monthly_reports.mjs" --apply
} 9>"$lock_file"
