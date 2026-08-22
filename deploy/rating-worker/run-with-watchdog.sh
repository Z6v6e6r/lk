#!/usr/bin/env bash
set -euo pipefail
umask 027

RUN_KIND=${1:-}
INSTALL_ROOT=${RATING_WORKER_INSTALL_ROOT:-/opt/padlhub-rating-worker}
LOG_DIR=${RATING_WORKER_LOG_DIR:-/var/log/padlhub-rating-worker}
LOCK_FILE=${RATING_WORKER_LOCK_FILE:-/var/lock/padlhub-rating-worker.lock}

case "$RUN_KIND" in
  game-results)
    LOG_FILE="$LOG_DIR/game-results.log"
    HARD_TIMEOUT_SECONDS=${RATING_WORKER_GAME_RESULTS_HARD_TIMEOUT_SECONDS:-55}
    WORKER_ARGS=(--game-results-only)
    ;;
  incremental)
    LOG_FILE="$LOG_DIR/incremental.log"
    HARD_TIMEOUT_SECONDS=${RATING_WORKER_INCREMENTAL_HARD_TIMEOUT_SECONDS:-780}
    WORKER_ARGS=(--mode incremental)
    ;;
  full)
    LOG_FILE="$LOG_DIR/full.log"
    HARD_TIMEOUT_SECONDS=${RATING_WORKER_FULL_HARD_TIMEOUT_SECONDS:-780}
    WORKER_ARGS=(--mode full)
    ;;
  *)
    echo "Usage: run-with-watchdog.sh <game-results|incremental|full>" >&2
    exit 64
    ;;
esac

if [[ ! "$HARD_TIMEOUT_SECONDS" =~ ^[1-9][0-9]*$ ]]; then
  echo "Invalid hard timeout for $RUN_KIND: $HARD_TIMEOUT_SECONDS" >&2
  exit 64
fi

mkdir -p "$LOG_DIR" "$(dirname "$LOCK_FILE")"

{
  for dependency in flock timeout; do
    if ! command -v "$dependency" >/dev/null 2>&1; then
      printf '{"event":"rating_worker_dependency_missing","runKind":"%s","dependency":"%s","at":"%s"}\n' \
        "$RUN_KIND" "$dependency" "$(date -u +%Y-%m-%dT%H:%M:%SZ)"
      exit 69
    fi
  done

  if ! flock -n 9; then
    printf '{"event":"rating_worker_lock_skipped","runKind":"%s","at":"%s"}\n' \
      "$RUN_KIND" "$(date -u +%Y-%m-%dT%H:%M:%SZ)"
    exit 0
  fi

  set +e
  timeout --signal=TERM --kill-after=30s "${HARD_TIMEOUT_SECONDS}s" \
    /usr/bin/env node \
    "$INSTALL_ROOT/current/scripts/run_rating_worker_147.mjs" \
    "${WORKER_ARGS[@]}"
  status=$?
  set -e

  case "$status" in
    124|137)
      printf '{"event":"rating_worker_watchdog_timeout","runKind":"%s","timeoutSeconds":%s,"exitCode":%s,"at":"%s"}\n' \
        "$RUN_KIND" "$HARD_TIMEOUT_SECONDS" "$status" "$(date -u +%Y-%m-%dT%H:%M:%SZ)"
      ;;
  esac
  exit "$status"
} 9>"$LOCK_FILE" >> "$LOG_FILE" 2>&1
