#!/usr/bin/env bash
# Scheduled release of dead subscription holds (ADR 0004, stage 2).
# One tick: CONFIRMED operations whose Viva booking is explicitly cancelled are
# released together with the daily-visit guard they own (exact CAS, one transaction
# per operation). `near` covers today and tomorrow every 5 minutes, `full` the next
# 14 days every 30 minutes. Both share one lock, so ticks never overlap.
set -euo pipefail

MODE="${1:-}"
case "$MODE" in
  near) DAYS_AHEAD=1 ;;
  full) DAYS_AHEAD=14 ;;
  *) echo "usage: $0 near|full" >&2; exit 64 ;;
esac

BASE=/root/.node-red/dead-hold-release
STATE="$BASE/state"
BACKUPS="$BASE/backups"
NODE=/usr/local/bin/node
MONGODB_MODULE=/root/.node-red/node_modules/mongodb
FLOWS=/root/.node-red/flows.json
# Read-only reuse of the token the confirmed-claim job mints and refreshes daily.
TOKEN=/root/.node-red/confirmed-claim-release/state/viva.token
MAX_TARGETS=80
now() { date -u +%Y-%m-%dT%H:%M:%SZ; }

mkdir -p "$STATE" "$BACKUPS"
chmod 700 "$BASE" "$STATE" "$BACKUPS"

exec 9>"$STATE/lock"
if ! flock -n 9; then
  printf '{"tick":"%s","result":"SKIPPED_LOCK_BUSY","at":"%s"}\n' "$MODE" "$(now)" >>"$STATE/run.log"
  exit 0
fi

if [ ! -s "$TOKEN" ] || [ -n "$(find "$TOKEN" -mmin +1500 -print -quit 2>/dev/null)" ]; then
  printf '{"tick":"%s","result":"TOKEN_STALE","at":"%s"}\n' "$MODE" "$(now)" >>"$STATE/run.log"
  exit 0
fi

rm -f "$STATE/report-$MODE.json"
set +e
"$NODE" "$BASE/scripts/release_dead_subscription_holds.mjs" \
  --flows "$FLOWS" --mongodb-module "$MONGODB_MODULE" --token-file "$TOKEN" \
  --days-ahead "$DAYS_AHEAD" --max-targets "$MAX_TARGETS" \
  --scheduled --backup-dir "$BACKUPS" --report "$STATE/report-$MODE.json" >"$STATE/tick-$MODE.raw" 2>&1
STATUS=$?
set -e

# The tick writes its report only after it finished; a missing report means it failed early.
if [ -s "$STATE/report-$MODE.json" ]; then
  "$NODE" -e '
    const r = JSON.parse(require("fs").readFileSync(process.argv[1], "utf8"));
    console.log(JSON.stringify({ tick: process.argv[2], result: r.result, at: r.at, targets: r.targets,
      outcomes: r.outcomes ?? {}, postcheckMismatches: r.postcheckMismatches ?? 0,
      providerUnreadable: r.providerUnreadable, exercisesRead: r.exercisesRead, byReason: r.byReason }));
  ' "$STATE/report-$MODE.json" "$MODE" >>"$STATE/run.log" 2>/dev/null || true
fi
if [ "$STATUS" -ne 0 ]; then
  printf '{"tick":"%s","result":"FAILED","exit":%s,"at":"%s"}\n' "$MODE" "$STATUS" "$(now)" >>"$STATE/run.log"
  grep -v -E 'MONGODB DRIVER|trace-warnings|deprecated' "$STATE/tick-$MODE.raw" | tail -n 3 >>"$STATE/run.log" || true
fi

if [ "$(wc -l <"$STATE/run.log")" -gt 6000 ]; then
  tail -n 6000 "$STATE/run.log" >"$STATE/run.log.tmp"
  mv "$STATE/run.log.tmp" "$STATE/run.log"
fi
find "$BACKUPS" -type f -mtime +30 -delete
chmod 600 "$STATE"/* 2>/dev/null || true
exit 0
