#!/usr/bin/env bash

set -euo pipefail
umask 077

if [[ $# -ne 0 || "${NODE_RED_MANAGED_SUBSCRIPTION_RULES_DEPLOY:-}" != "CONFIRM_147" ]]; then
  echo "Usage: NODE_RED_MANAGED_SUBSCRIPTION_RULES_DEPLOY=CONFIRM_147 npm run nodered:managed-subscription-rules:deploy-147" >&2
  exit 2
fi

host="lk-primary-147"
deployment_id="managed-subscription-rules"
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

stage_root="$(mktemp -d /private/tmp/padlhub-managed-subscription-rules.XXXXXX)"
workspace="$stage_root/live"
source_flow="$workspace/input/source.flow.json"
candidate_dir="$stage_root/candidate"
candidate_flow="$candidate_dir/flows.candidate.json"
candidate_import="$candidate_dir/lk_subscription_booking.nodes.import.json"
candidate_ready="$candidate_flow.ready.json"
contract_file="$candidate_dir/contract.json"
preflight_result="$stage_root/preflight.json"
apply_result="$stage_root/apply.json"
remote_stamp="$(date '+%Y%m%dT%H%M%S%z')"
remote_stage="/root/.node-red/.padlhub-reviewed-flow-stage-$remote_stamp-$$"
remote_candidate="$remote_stage/candidate.flow.json"
remote_contract="$remote_stage/contract.json"
remote_helper="$remote_stage/deploy_reviewed_flow_147_remote.mjs"
remote_runtime="$remote_stage/runtime_contract.mjs"
remote_backup_dir="/root/.node-red/.padlhub-reviewed-flow-backups"
remote_flow_backup="$remote_backup_dir/flows-pre-$deployment_id-$remote_stamp.json"
remote_contract_backup="$remote_backup_dir/contract-$deployment_id-$remote_stamp.json"
remote_stage_created=0
apply_started=0
completed=0

cleanup() {
  if [[ "$apply_started" == "1" && "$completed" != "1" ]]; then
    ssh "$host" "node '$remote_helper' rollback --deployment-id '$deployment_id' --flow-backup '$remote_flow_backup' --contract-backup '$remote_contract_backup'" >/dev/null 2>&1 || true
  fi
  if [[ "$remote_stage_created" == "1" ]]; then
    ssh "$host" "rm -f '$remote_candidate' '$remote_contract' '$remote_helper' '$remote_runtime'; rmdir '$remote_stage' 2>/dev/null || true" >/dev/null 2>&1 || true
  fi
  rm -f "$preflight_result" "$apply_result" 2>/dev/null || true
  rm -f "$candidate_flow" "$candidate_import" "$candidate_ready" "$contract_file" 2>/dev/null || true
  rm -f "$workspace/input/source.flow.json" "$workspace/input/source.flow.meta.json" 2>/dev/null || true
  rmdir "$candidate_dir" "$workspace/input" "$workspace" "$stage_root" 2>/dev/null || true
}
trap cleanup EXIT
trap 'exit 130' INT
trap 'exit 143' TERM HUP

bash scripts/pull_nodered_source_from_147.sh "$workspace"
node scripts/patch_nodered_subscription_booking_flow.mjs \
  "$source_flow" \
  "$candidate_flow" \
  "$candidate_import" >/dev/null
node -e '
  const fs=require("fs"),crypto=require("crypto");
  const hash=(file)=>crypto.createHash("sha256").update(fs.readFileSync(file)).digest("hex");
  const ready=JSON.parse(fs.readFileSync(process.argv[1],"utf8"));
  if (ready.formatVersion !== 1 || ready.sourceSha256 !== hash(process.argv[4])
    || ready.candidateSha256 !== hash(process.argv[2])
    || ready.importSha256 !== hash(process.argv[3])) process.exit(1);
' "$candidate_ready" "$candidate_flow" "$candidate_import" "$source_flow"

node scripts/nodered_reviewed_flow_deploy/prepare_exact_graph_contract.mjs \
  --live "$source_flow" \
  --candidate "$candidate_flow" \
  --output "$contract_file" \
  --deployment-id "$deployment_id" \
  --allow-change 8f7bd5b482fe9763:func \
  --allow-change lk_subscription_booking_http_20260804:headers,requestTimeout \
  --allow-change lk_subscription_booking_router_20260804:func,outputs,wires \
  --allow-add lk_subscription_managed_policy_20260820 \
  --allow-add lk_subscription_managed_policy_blocked_20260820 >/dev/null

source_sha="$(node -e 'const value=JSON.parse(require("fs").readFileSync(process.argv[1],"utf8")); process.stdout.write(value.sourceSha256)' "$contract_file")"
candidate_sha="$(node -e 'const value=JSON.parse(require("fs").readFileSync(process.argv[1],"utf8")); process.stdout.write(value.candidateSha256)' "$contract_file")"
source_node_count="$(node -e 'const value=JSON.parse(require("fs").readFileSync(process.argv[1],"utf8")); process.stdout.write(String(value.sourceNodeCount))' "$contract_file")"
candidate_node_count="$(node -e 'const value=JSON.parse(require("fs").readFileSync(process.argv[1],"utf8")); process.stdout.write(String(value.candidateNodeCount))' "$contract_file")"

ssh "$host" "test ! -e '$remote_stage' && install -d -m 700 '$remote_stage'"
remote_stage_created=1
scp -q "$candidate_flow" "$host:$remote_candidate"
scp -q "$contract_file" "$host:$remote_contract"
scp -q \
  scripts/nodered_reviewed_flow_deploy/runtime_contract.mjs \
  scripts/nodered_reviewed_flow_deploy/deploy_reviewed_flow_147_remote.mjs \
  "$host:$remote_stage/"
ssh "$host" "chmod 600 '$remote_candidate' '$remote_contract' '$remote_runtime'; chmod 700 '$remote_helper'"

ssh "$host" "node '$remote_helper' preflight --candidate '$remote_candidate' --contract '$remote_contract' --deployment-id '$deployment_id'" >"$preflight_result"
node -e '
  const value=JSON.parse(require("fs").readFileSync(process.argv[1],"utf8"));
  if (
    !value.ok
    || value.action !== "preflight"
    || value.sourceSha256 !== process.argv[2]
    || value.candidateSha256 !== process.argv[3]
    || String(value.nodeCount) !== process.argv[4]
    || String(value.candidateNodeCount) !== process.argv[5]
    || value.changedNodeCount !== 3
    || value.addedNodeCount !== 2
  ) process.exit(1);
' "$preflight_result" "$source_sha" "$candidate_sha" "$source_node_count" "$candidate_node_count"

apply_started=1
ssh "$host" "node '$remote_helper' apply --candidate '$remote_candidate' --contract '$remote_contract' --deployment-id '$deployment_id' --stamp '$remote_stamp'" >"$apply_result"
node -e '
  const value=JSON.parse(require("fs").readFileSync(process.argv[1],"utf8"));
  if (
    !value.ok
    || value.action !== "apply"
    || value.sourceSha256 !== process.argv[2]
    || value.activeFlowSha256 !== process.argv[3]
    || value.flowBackup !== process.argv[4]
    || value.contractBackup !== process.argv[5]
  ) process.exit(1);
' "$apply_result" "$source_sha" "$candidate_sha" "$remote_flow_backup" "$remote_contract_backup"

public_games_status="$(curl --retry 5 --retry-delay 2 --retry-connrefused --max-time 20 -sS -o /dev/null -w '%{http_code}' 'https://padlhub.su/lk/games?public=true&available=true&limit=1&offset=0' || true)"
subscription_options_status="$(curl --retry 5 --retry-delay 2 --retry-connrefused --max-time 20 -sS -o /dev/null -w '%{http_code}' -X OPTIONS -H 'Origin: https://padlhub.ru' -H 'Access-Control-Request-Method: POST' -H 'Access-Control-Request-Headers: authorization,content-type' 'https://padlhub.su/lk/subscription-bookings' || true)"
if [[ "$public_games_status" != "200" || "$subscription_options_status" != "204" ]]; then
  echo "Public postcheck failed; automatic rollback requested" >&2
  exit 5
fi

completed=1
echo "deployedGitSha=$local_sha"
echo "sourceFlowSha256=$source_sha"
echo "activeFlowSha256=$candidate_sha"
echo "flowBackup=$remote_flow_backup"
echo "contractBackup=$remote_contract_backup"
echo "publicGamesStatus=$public_games_status"
echo "subscriptionOptionsStatus=$subscription_options_status"
