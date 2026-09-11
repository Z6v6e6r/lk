#!/usr/bin/env bash

# Guarded deployment of the focused subscription status-price generation.
# Publishes one reviewed flow whose only change is the func body of
# 8fdc7076a0c436a2 (Prepare tournament subscription status), so the storefront
# receives the configured price for counters that have no sale rows yet.
#
# Requires an explicit confirmation variable, a clean main checkout equal to
# origin/main, and the exact live preimage. Everything else fails closed.

set -euo pipefail
umask 077

if [[ $# -ne 0 || "${NODE_RED_SUBSCRIPTION_STATUS_PRICE_DEPLOY:-}" != "CONFIRM_147" ]]; then
  echo "Usage: NODE_RED_SUBSCRIPTION_STATUS_PRICE_DEPLOY=CONFIRM_147 npm run nodered:subscription-status-price:deploy-147" >&2
  exit 2
fi

host="lk-primary-147"
deployment_id="subscription-status-price"
target_node_id="8fdc7076a0c436a2"
expected_price_minor="2380000"
repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd -P)"
cd "$repo_root"

if [[ "$(git branch --show-current)" != "main" || -n "$(git status --porcelain)" ]]; then
  echo "Deploy requires a clean main checkout" >&2
  exit 3
fi
git fetch --quiet origin main
local_sha="$(git rev-parse HEAD)"
remote_sha="$(git rev-parse origin/main)"
if [[ "$local_sha" != "$remote_sha" ]]; then
  echo "Local main and origin/main differ" >&2
  exit 4
fi

stage_root="$(mktemp -d /private/tmp/padlhub-subscription-status-price-deploy.XXXXXX)"
workspace="$stage_root/live"
candidate_dir="$workspace/candidate-status-price"
source_flow="$workspace/input/source.flow.json"
candidate_flow="$candidate_dir/candidate.flow.json"
candidate_import="$candidate_dir/import.nodes.json"
candidate_report="$candidate_dir/report.json"
contract_file="$candidate_dir/contract.json"
preflight_result="$stage_root/preflight.json"
apply_result="$stage_root/apply.json"
postcheck_result="$stage_root/postcheck.json"
remote_stamp="$(date '+%Y%m%dT%H%M%S%z')"
remote_stage="/root/.node-red/.padlhub-reviewed-flow-stage-$remote_stamp-$$"
remote_candidate="$remote_stage/candidate.flow.json"
remote_contract="$remote_stage/contract.json"
remote_helper="$remote_stage/deploy_reviewed_flow_147_remote.mjs"
remote_runtime="$remote_stage/runtime_contract.mjs"
remote_live_flow="/root/.node-red/flows.json"
remote_backup_dir="/root/.node-red/.padlhub-reviewed-flow-backups"
remote_flow_backup="$remote_backup_dir/flows-pre-$deployment_id-$remote_stamp.json"
remote_contract_backup="$remote_backup_dir/contract-$deployment_id-$remote_stamp.json"
remote_stage_created=0
apply_started=0
completed=0

# Intermittent SSH to the production host is a real failure mode: one deploy opens
# many connections and a single dropped connection aborts it. Reuse one
# multiplexed connection and bound retries for idempotent steps only. apply is
# never retried: a partially applied flow must fail closed and be reconciled.
ssh_opts=(
  -o BatchMode=yes
  -o ConnectTimeout=20
  -o ServerAliveInterval=10
  -o ServerAliveCountMax=3
  -o ControlMaster=auto
  -o ControlPath="$stage_root/ssh-control-%C"
  -o ControlPersist=120
)
ssh_retry_attempts="${NODE_RED_SUBSCRIPTION_STATUS_PRICE_SSH_ATTEMPTS:-5}"
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
# Only a fully successful attempt publishes its output, so a dropped connection
# can never leave a truncated receipt behind.
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

cleanup() {
  if [[ "$apply_started" == "1" && "$completed" != "1" ]]; then
    ssh "${ssh_opts[@]}" "$host" "node '$remote_helper' rollback --deployment-id '$deployment_id' --flow-backup '$remote_flow_backup' --contract-backup '$remote_contract_backup'" >/dev/null 2>&1 || true
  fi
  if [[ "$remote_stage_created" == "1" ]]; then
    ssh "${ssh_opts[@]}" "$host" "rm -f '$remote_candidate' '$remote_contract' '$remote_helper' '$remote_runtime'; rmdir '$remote_stage' 2>/dev/null || true" >/dev/null 2>&1 || true
  fi
  ssh "${ssh_opts[@]}" -O exit "$host" >/dev/null 2>&1 || true
  rm -f "$stage_root"/ssh-control-* 2>/dev/null || true
  rm -f "$candidate_flow" "$candidate_import" "$candidate_report" "$contract_file" 2>/dev/null || true
  # Receipts are the failure evidence: keep them (and the stage directory) once an
  # apply started, so a manual rollback has its stamp and the recorded receipts.
  if [[ "$apply_started" != "1" ]]; then
    rm -f "$preflight_result" "$apply_result" "$postcheck_result" 2>/dev/null || true
  fi
  rm -f "$workspace/input/source.flow.json" "$workspace/input/source.flow.meta.json" 2>/dev/null || true
  rmdir "$candidate_dir" "$workspace/input" "$workspace" "$stage_root" 2>/dev/null || true
}
trap cleanup EXIT
trap 'exit 130' INT
trap 'exit 143' TERM HUP

# Full-flow preimage: the focused generation validates node order, HTTP inputs
# and the exact live function body, so a tab-scoped extraction is not enough.
pull_live_workspace

node scripts/patch_live_subscription_status_price.mjs \
  --workspace "$workspace" \
  --output "$candidate_flow" \
  --import "$candidate_import" \
  --report "$candidate_report" >/dev/null

# Independent function-only contract; never reuse the patcher's own contract.
node scripts/nodered_reviewed_flow_deploy/prepare_contract.mjs \
  --live "$source_flow" \
  --candidate "$candidate_flow" \
  --output "$contract_file" \
  --deployment-id "$deployment_id" \
  --allow-node "$target_node_id" >/dev/null

source_sha="$(node -e 'const value=JSON.parse(require("fs").readFileSync(process.argv[1],"utf8")); process.stdout.write(value.sourceSha256)' "$contract_file")"
candidate_sha="$(node -e 'const value=JSON.parse(require("fs").readFileSync(process.argv[1],"utf8")); process.stdout.write(value.candidateSha256)' "$contract_file")"

remote_ssh "test ! -e '$remote_stage' && install -d -m 700 '$remote_stage'"
remote_stage_created=1
remote_scp_to "$candidate_flow" "$host:$remote_candidate"
remote_scp_to "$contract_file" "$host:$remote_contract"
remote_scp_to \
  scripts/nodered_reviewed_flow_deploy/runtime_contract.mjs \
  scripts/nodered_reviewed_flow_deploy/deploy_reviewed_flow_147_remote.mjs \
  "$host:$remote_stage/"
remote_ssh "chmod 600 '$remote_candidate' '$remote_contract' '$remote_runtime'; chmod 700 '$remote_helper'"

remote_ssh_capture "$preflight_result" \
  "node '$remote_helper' preflight --candidate '$remote_candidate' --contract '$remote_contract' --deployment-id '$deployment_id'"
node -e '
  const value=JSON.parse(require("fs").readFileSync(process.argv[1],"utf8"));
  if (!value.ok || value.action !== "preflight" || value.sourceSha256 !== process.argv[2]
    || value.candidateSha256 !== process.argv[3] || value.changedNodeCount !== 1) process.exit(1);
' "$preflight_result" "$source_sha" "$candidate_sha"

apply_started=1
# Publish the recovery identifiers before the mutation: on a failed postcheck the
# operator needs the stamp to run the rollback wrapper.
echo "stamp=$remote_stamp"
echo "flowBackup=$remote_flow_backup"
echo "contractBackup=$remote_contract_backup"
# Single attempt by design: apply is mutated state, so a dropped connection is
# reconciled or rolled back instead of replayed.
ssh "${ssh_opts[@]}" "$host" "node '$remote_helper' apply --candidate '$remote_candidate' --contract '$remote_contract' --deployment-id '$deployment_id' --stamp '$remote_stamp'" >"$apply_result"
node -e '
  const value=JSON.parse(require("fs").readFileSync(process.argv[1],"utf8"));
  if (!value.ok || value.action !== "apply" || value.sourceSha256 !== process.argv[2]
    || value.activeFlowSha256 !== process.argv[3] || value.flowBackup !== process.argv[4]
    || value.contractBackup !== process.argv[5]) process.exit(1);
' "$apply_result" "$source_sha" "$candidate_sha" "$remote_flow_backup" "$remote_contract_backup"

# Authoritative postcheck: read the installed flow back from the host and require
# the exact reviewed candidate bytes. The apply receipt alone is not independent.
remote_ssh_capture "$stage_root/readback.txt" "sha256sum '$remote_live_flow' | cut -d' ' -f1"
installed_sha="$(tr -d '\n' < "$stage_root/readback.txt")"
if [[ "$installed_sha" != "$candidate_sha" ]]; then
  echo "Installed flow readback does not match the candidate; automatic rollback requested" >&2
  exit 5
fi

# Functional smoke for the storefront. This alone is NOT proof of the deploy:
# the status response also fills the price from the newest paid or pending sale
# row, so an absent fix can still show the configured price while reservations
# exist. It is recorded here only as an end-to-end observation next to the
# installed-flow readback above.
curl --retry 5 --retry-delay 2 --retry-connrefused --max-time 20 -sS \
  'https://padlhub.su/lk/tournaments/summer-subscription/status?counterKey=ra' -o "$postcheck_result" || true
node -e '
  const value=JSON.parse(require("fs").readFileSync(process.argv[1],"utf8"));
  const status=Array.isArray(value) ? value[0] : value;
  if (!status || status.counterKey !== "ra" || status.canPurchase !== true
    || status.priceMinor !== Number(process.argv[2])) process.exit(1);
' "$postcheck_result" "$expected_price_minor" || {
  echo "RA status smoke check failed; automatic rollback requested" >&2
  exit 6
}

completed=1
echo "deployedGitSha=$local_sha"
echo "sourceFlowSha256=$source_sha"
echo "activeFlowSha256=$candidate_sha"
echo "installedFlowReadbackSha256=$installed_sha"
echo "flowBackup=$remote_flow_backup"
echo "contractBackup=$remote_contract_backup"
echo "raPriceMinor=$expected_price_minor"
