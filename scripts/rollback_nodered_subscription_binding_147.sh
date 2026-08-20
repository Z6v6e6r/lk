#!/usr/bin/env bash

set -euo pipefail
umask 077

if [[ $# -ne 1 || "${NODE_RED_SUBSCRIPTION_BINDING_ROLLBACK:-}" != "CONFIRM_147" ]]; then
  echo "Usage: NODE_RED_SUBSCRIPTION_BINDING_ROLLBACK=CONFIRM_147 npm run nodered:subscription-binding:rollback-147 -- YYYYMMDDTHHMMSS+ZZZZ" >&2
  exit 2
fi

stamp="$1"
if [[ ! "$stamp" =~ ^[0-9]{8}T[0-9]{6}[+-][0-9]{4}$ ]]; then
  echo "Rollback timestamp must use YYYYMMDDTHHMMSS+ZZZZ" >&2
  exit 3
fi

host="lk-primary-147"
deployment_id="subscription-binding"
repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd -P)"
cd "$repo_root"
if [[ "$(git branch --show-current)" != "main" || -n "$(git status --porcelain)" ]]; then
  echo "Rollback requires a clean main checkout" >&2
  exit 4
fi
git fetch --quiet origin main
if [[ "$(git rev-parse HEAD)" != "$(git rev-parse origin/main)" ]]; then
  echo "Local main and origin/main differ" >&2
  exit 5
fi

remote_stage="/root/.node-red/.padlhub-reviewed-flow-stage-$(date '+%Y%m%dT%H%M%S%z')-$$"
remote_helper="$remote_stage/deploy_reviewed_flow_147_remote.mjs"
remote_runtime="$remote_stage/runtime_contract.mjs"
remote_backup_dir="/root/.node-red/.padlhub-reviewed-flow-backups"
remote_flow_backup="$remote_backup_dir/flows-pre-$deployment_id-$stamp.json"
remote_contract_backup="$remote_backup_dir/contract-$deployment_id-$stamp.json"
remote_stage_created=0

cleanup() {
  if [[ "$remote_stage_created" == "1" ]]; then
    ssh "$host" "rm -f '$remote_helper' '$remote_runtime'; rmdir '$remote_stage' 2>/dev/null || true" >/dev/null 2>&1 || true
  fi
}
trap cleanup EXIT
trap 'exit 130' INT
trap 'exit 143' TERM HUP

ssh "$host" "test ! -e '$remote_stage' && install -d -m 700 '$remote_stage'"
remote_stage_created=1
scp -q \
  scripts/nodered_reviewed_flow_deploy/runtime_contract.mjs \
  scripts/nodered_reviewed_flow_deploy/deploy_reviewed_flow_147_remote.mjs \
  "$host:$remote_stage/"
ssh "$host" "chmod 600 '$remote_runtime'; chmod 700 '$remote_helper'"
ssh "$host" "node '$remote_helper' rollback --deployment-id '$deployment_id' --flow-backup '$remote_flow_backup' --contract-backup '$remote_contract_backup'"
public_games_status="$(curl --retry 5 --retry-delay 2 --retry-connrefused --max-time 20 -sS -o /dev/null -w '%{http_code}' 'https://padlhub.su/lk/games?public=true&available=true&limit=1&offset=0' || true)"
if [[ "$public_games_status" != "200" ]]; then
  echo "Rollback completed, but public games postcheck failed" >&2
  exit 6
fi
echo "publicGamesStatus=$public_games_status"
