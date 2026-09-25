#!/usr/bin/env bash

# Plain rollback of the LK1 Topokraty rejection/reclaim generation.
#
# The generation changes only `func` of two nodes: it neither rewrites the plan-rules writer
# (`initialize`) nor touches any activation global. There is therefore NO ordered step and no
# global revert here: the recorded preimage flow is restored verbatim from the backup the
# forward run printed, and Node-RED is restarted by the same reviewed remote helper. The
# restored `initialize` still finds the same runtime global it wrote before this generation.
#
# Requires the explicit confirmation variable, a clean main checkout equal to origin/main and
# the deployment stamp printed by the forward run.

set -euo pipefail
umask 077

if [[ "${NODE_RED_LK1_TOPOKRATY_RECLAIM_ROLLBACK:-}" != "CONFIRM_147" ]]; then
  echo "Usage: NODE_RED_LK1_TOPOKRATY_RECLAIM_ROLLBACK=CONFIRM_147 npm run nodered:lk1-topokraty-reclaim:rollback-147 -- <stamp>" >&2
  exit 2
fi
if [[ $# -ne 1 || ! "$1" =~ ^[0-9]{8}T[0-9]{6}[+-][0-9]{4}$ ]]; then
  echo "Usage: ... rollback-147 -- <stamp>  (the stamp printed by the forward deploy)" >&2
  exit 2
fi

stamp="$1"
host="lk-primary-147"
deployment_id="lk1-topokraty-rejection-reclaim"
applied_flow_sha="9d2487a470a86bd0f8d3104aa029b81a6292a738209338740fe3f2d37dc0ed8d"
preimage_flow_sha="d6df38f3148c576a1602f9d6e9509345d668a725044f0e536411c5b5bcb73dbe"
smoke_url="https://padlhub.su/lk/advertising/split-payment-promo"
repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd -P)"
cd "$repo_root"

if [[ "$(git branch --show-current)" != "main" || -n "$(git status --porcelain)" ]]; then
  echo "Rollback requires a clean main checkout" >&2
  exit 3
fi
git fetch --quiet origin main
if [[ "$(git rev-parse HEAD)" != "$(git rev-parse origin/main)" ]]; then
  echo "Local main and origin/main differ" >&2
  exit 4
fi

remote_backup_dir="/root/.node-red/.padlhub-reviewed-flow-backups"
remote_flow_backup="$remote_backup_dir/flows-pre-$deployment_id-$stamp.json"
remote_contract_backup="$remote_backup_dir/contract-$deployment_id-$stamp.json"
remote_live_flow="/root/.node-red/flows.json"
remote_stamp="$(date '+%Y%m%dT%H%M%S%z')"

stage_root="$(mktemp -d /private/tmp/padlhub-lk1-topokraty-reclaim-rollback.XXXXXX)"
ssh_control_root="$(mktemp -d /private/tmp/lk1tkrr.XXXXXX)"
workspace="$stage_root/live"
source_flow="$workspace/input/source.flow.json"
preimage_copy="$stage_root/preimage.flow.json"
remote_stage="/root/.node-red/.padlhub-reviewed-flow-stage-$remote_stamp-$$"
remote_helper="$remote_stage/deploy_reviewed_flow_147_remote.mjs"
remote_runtime="$remote_stage/runtime_contract.mjs"
remote_stage_created=0

ssh_opts=(
  -o BatchMode=yes
  -o ConnectTimeout=20
  -o ServerAliveInterval=10
  -o ServerAliveCountMax=3
  -o ControlMaster=auto
  -o ControlPath="$ssh_control_root/c-%C"
  -o ControlPersist=120
)
ssh_retry_attempts="${NODE_RED_LK1_TOPOKRATY_RECLAIM_SSH_ATTEMPTS:-5}"
retry_idempotent() {
  local attempt
  for ((attempt = 1; attempt <= ssh_retry_attempts; attempt++)); do
    if "$@"; then return 0; fi
    sleep $((attempt * 2))
  done
  return 1
}
remote_ssh() { retry_idempotent ssh "${ssh_opts[@]}" "$host" "$@"; }
remote_scp_to() { retry_idempotent scp -q -P 22 "${ssh_opts[@]}" "$@"; }
remote_scp_from() { retry_idempotent scp -q -P 22 "${ssh_opts[@]}" "$@"; }
remote_ssh_capture() {
  local outfile="$1" attempt
  shift
  for ((attempt = 1; attempt <= ssh_retry_attempts; attempt++)); do
    if ssh "${ssh_opts[@]}" "$host" "$@" >"$outfile.tmp"; then mv "$outfile.tmp" "$outfile"; return 0; fi
    sleep $((attempt * 2))
  done
  rm -f "$outfile.tmp"
  return 1
}
pull_live_workspace() {
  local attempt
  for ((attempt = 1; attempt <= ssh_retry_attempts; attempt++)); do
    rm -rf "$workspace"
    if bash scripts/pull_nodered_source_from_147.sh "$workspace"; then return 0; fi
    sleep $((attempt * 2))
  done
  return 1
}
file_sha256() {
  node -e 'const fs=require("node:fs");const crypto=require("node:crypto");process.stdout.write(crypto.createHash("sha256").update(fs.readFileSync(process.argv[1])).digest("hex"))' "$1"
}

cleanup() {
  if [[ "$remote_stage_created" == "1" ]]; then
    ssh "${ssh_opts[@]}" "$host" "rm -f '$remote_helper' '$remote_runtime'; rmdir '$remote_stage' 2>/dev/null || true" >/dev/null 2>&1 || true
  fi
  ssh "${ssh_opts[@]}" -O exit "$host" >/dev/null 2>&1 || true
  rm -f "$ssh_control_root"/c-* 2>/dev/null || true
  rmdir "$ssh_control_root" 2>/dev/null || true
  rm -rf "$stage_root" 2>/dev/null || true
}
trap cleanup EXIT
trap 'exit 130' INT
trap 'exit 143' TERM HUP

# The recorded backups must exist before anything is touched.
remote_ssh "test -s '$remote_flow_backup' && test -s '$remote_contract_backup'"

# The live flow must be the exact generation this rollback was prepared for, otherwise the
# reviewed helper would refuse a foreign flow (or, worse, restore the wrong preimage later).
remote_ssh_capture "$stage_root/active-readback.txt" "sha256sum '$remote_live_flow' | cut -d' ' -f1"
active_sha="$(tr -d '\n' < "$stage_root/active-readback.txt")"
if [[ "$active_sha" != "$applied_flow_sha" ]]; then
  echo "Live flow is not the applied rejection/reclaim generation ($active_sha != $applied_flow_sha); rollback refused" >&2
  exit 5
fi

# The reviewed preimage is re-pulled and pinned before the restore, so a stale or foreign
# backup can never be written over the live flow.
pull_live_workspace
if [[ "$(file_sha256 "$source_flow")" != "$applied_flow_sha" ]]; then
  echo "Pulled live workspace is not the applied rejection/reclaim generation; rollback refused" >&2
  exit 5
fi
remote_scp_from "$host:$remote_flow_backup" "$preimage_copy"
if [[ "$(file_sha256 "$preimage_copy")" != "$preimage_flow_sha" ]]; then
  echo "Recorded flow backup is not the reviewed preimage; rollback refused" >&2
  exit 6
fi

remote_ssh "test ! -e '$remote_stage' && install -d -m 700 '$remote_stage'"
remote_stage_created=1
remote_scp_to \
  scripts/nodered_reviewed_flow_deploy/runtime_contract.mjs \
  scripts/nodered_reviewed_flow_deploy/deploy_reviewed_flow_147_remote.mjs \
  "$host:$remote_stage/"
remote_ssh "chmod 700 '$remote_helper'"

remote_ssh_capture "$stage_root/rollback.json" \
  "node '$remote_helper' rollback --deployment-id '$deployment_id' --flow-backup '$remote_flow_backup' --contract-backup '$remote_contract_backup'"
node -e '
  const value=JSON.parse(require("fs").readFileSync(process.argv[1],"utf8"));
  if (!value.ok || value.action !== "rollback" || value.deploymentId !== process.argv[2]
    || value.restoredFlowSha256 !== process.argv[3]
    || value.flowBackup !== process.argv[4] || value.contractBackup !== process.argv[5]
    || value.nodeRedOnline !== true) process.exit(1);
' "$stage_root/rollback.json" "$deployment_id" "$preimage_flow_sha" "$remote_flow_backup" "$remote_contract_backup"

remote_ssh_capture "$stage_root/readback.txt" "sha256sum '$remote_live_flow' | cut -d' ' -f1"
restored_sha="$(tr -d '\n' < "$stage_root/readback.txt")"
if [[ "$restored_sha" != "$preimage_flow_sha" ]]; then
  echo "Restore readback mismatch ($restored_sha != $preimage_flow_sha); stop and inspect" >&2
  exit 7
fi

# The restored gateway setup must be the untouched preimage: no plan-rules writer rewrite and
# no Topokraty exclusion module from this generation.
if ! remote_ssh "node -e 'const fs=require(\"node:fs\");const flow=JSON.parse(fs.readFileSync(\"/root/.node-red/flows.json\",\"utf8\"));const node=id=>flow.find(row=>row.id===id)||{};const func=n=>(typeof n.func===\"string\"?n.func:\"\");const init=n=>(typeof n.initialize===\"string\"?n.initialize:\"\");const booking=node(\"lk_subscription_booking_router_20260804\");const preview=node(\"lk_subscription_price_preview_20260908_router\");if(func(booking).includes(\"TOPOKRATY_SUBSCRIPTION_UNAVAILABLE\"))process.exit(1);if(func(booking).includes(\"lk1ReclaimableAttempt(operation)\"))process.exit(1);if(func(preview).includes(\"isTopokratyExercise(exercise)\"))process.exit(1);if(init(booking).includes(\"LK1_PLAN_RULES_WITH_TOPOKRATY\"))process.exit(1);'"; then
  echo "Restored nodes still carry this generation; stop and inspect" >&2
  exit 8
fi

smoke_ok=0
for ((smoke_attempt = 1; smoke_attempt <= 30; smoke_attempt++)); do
  if curl -sS --max-time 15 -o "$stage_root/smoke.json" -w '%{http_code}' "$smoke_url" > "$stage_root/smoke.status" \
    && [[ "$(tr -d '\n' < "$stage_root/smoke.status")" == "200" ]]; then
    smoke_ok=1
    break
  fi
  sleep 3
done
if [[ "$smoke_ok" != "1" ]]; then
  echo "LK backend smoke failed after the rollback; flow restored, endpoint needs inspection" >&2
  exit 9
fi

echo "rollback=complete"
echo "deploymentId=$deployment_id"
echo "rolledBackFromSha256=$applied_flow_sha"
echo "restoredFlowSha256=$preimage_flow_sha"
echo "smokeUrl=$smoke_url"
echo "flowBackup=$remote_flow_backup"
echo "contractBackup=$remote_contract_backup"
