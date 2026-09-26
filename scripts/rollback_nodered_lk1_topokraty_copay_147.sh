#!/usr/bin/env bash

# Ordered rollback of the LK1 «Дружба Топократы» co-pay generation.
#
# The order is not optional. The generation replaced the plan-rules writer with the guarded
# `LK1_PLAN_RULES_DESIRED -> LK1_PLAN_RULES_WITH_TOPOKRATY` transition, so the runtime global
# currently names eight rules. Restoring the previous flow first would leave that global in
# place while the restored gateway initialize writes the seven installed rules against a club
# prior: the initialize would refuse to start (prior mismatch) and a direction-6233 training
# would lose the quarter-of-court co-pay.
#
# Step 1 (this script, first half): deploy the revert candidate — the same co-pay generation
#   with the plan-rules writer replaced by the guarded
#   `LK1_PLAN_RULES_WITH_TOPOKRATY -> LK1_PLAN_RULES_DESIRED` block, so the global goes back
#   to the installed seven rules.
# Step 2 (this script, second half): restore the recorded preimage flow and restart; the
#   restored initialize now finds its exact seven-rule prior.
#
# Requires the explicit confirmation variable, a clean main checkout equal to origin/main and
# the deployment stamp printed by the forward run.

set -euo pipefail
umask 077

if [[ "${NODE_RED_LK1_TOPOKRATY_COPAY_ROLLBACK:-}" != "CONFIRM_147" ]]; then
  echo "Usage: NODE_RED_LK1_TOPOKRATY_COPAY_ROLLBACK=CONFIRM_147 npm run nodered:lk1-topokraty-copay:rollback-147 -- <stamp>" >&2
  exit 2
fi
if [[ $# -ne 1 || ! "$1" =~ ^[0-9]{8}T[0-9]{6}[+-][0-9]{4}$ ]]; then
  echo "Usage: ... rollback-147 -- <stamp>  (the stamp printed by the forward deploy)" >&2
  exit 2
fi

stamp="$1"
host="lk-primary-147"
deployment_id="lk1-topokraty-copay"
allow_nodes=(lk_subscription_booking_router_20260804)
expected_changed_nodes=1
allow_changes=("lk_subscription_booking_router_20260804:initialize")
expected_node_fields='{"lk_subscription_booking_router_20260804":["initialize"]}'
applied_flow_sha="70b9350fedee6b0ab8555d0a47ebcbeb2c7d43ec7a241e3e7fafa8e40750cbf1"
preimage_flow_sha="9d2487a470a86bd0f8d3104aa029b81a6292a738209338740fe3f2d37dc0ed8d"
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

stage_root="$(mktemp -d /private/tmp/padlhub-lk1-topokraty-copay-rollback.XXXXXX)"
ssh_control_root="$(mktemp -d /private/tmp/lk1tkc.XXXXXX)"
workspace="$stage_root/live"
candidate_dir="$stage_root/candidate"
source_flow="$workspace/input/source.flow.json"
revert_flow="$candidate_dir/revert.flow.json"
revert_report="$candidate_dir/revert-report.json"
revert_contract="$candidate_dir/revert-contract.json"
stage2_dir="$stage_root/restore"
stage2_candidate="$stage2_dir/candidate.flow.json"
stage2_contract="$stage2_dir/contract.json"
remote_stage="/root/.node-red/.padlhub-reviewed-flow-stage-$remote_stamp-$$"
remote_candidate="$remote_stage/candidate.flow.json"
remote_contract="$remote_stage/contract.json"
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
ssh_retry_attempts="${NODE_RED_LK1_TOPOKRATY_FRIENDSHIP_SSH_ATTEMPTS:-5}"
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
  if [[ "$remote_stage_created" == "1" ]]; then
    ssh "${ssh_opts[@]}" "$host" "rm -f '$remote_candidate' '$remote_contract' '$remote_helper' '$remote_runtime'; rmdir '$remote_stage' 2>/dev/null || true" >/dev/null 2>&1 || true
  fi
  ssh "${ssh_opts[@]}" -O exit "$host" >/dev/null 2>&1 || true
  rm -f "$ssh_control_root"/c-* 2>/dev/null || true
  rmdir "$ssh_control_root" 2>/dev/null || true
  rm -rf "$stage_root" 2>/dev/null || true
}
trap cleanup EXIT
trap 'exit 130' INT
trap 'exit 143' TERM HUP

node -e '
  const expected=JSON.parse(process.argv[1]);
  const nodes=process.argv.slice(2).sort();
  if (JSON.stringify(Object.keys(expected).sort()) !== JSON.stringify(nodes)) process.exit(1);
' "$expected_node_fields" "${allow_nodes[@]}"

remote_ssh "test -s '$remote_flow_backup' && test -s '$remote_contract_backup'"

# ---------------------------------------------------------------- step 1: the global
pull_live_workspace
mkdir -m 700 "$candidate_dir"
node scripts/patch_live_lk1_topokraty_copay_hotfix.mjs \
  --mode revert \
  --workspace "$workspace" \
  --output "$revert_flow" \
  --report "$revert_report" >/dev/null

node -e '
  const value=JSON.parse(require("fs").readFileSync(process.argv[1],"utf8"));
  if (value.deploymentPerformed !== false || value.liveMutationPerformed !== false) process.exit(1);
  if (value.changedNodeCount !== 1 || value.addedNodeCount !== 0) process.exit(1);
  const change=value.changes[0];
  if (!change || change.id !== "lk_subscription_booking_router_20260804"
    || JSON.stringify(change.fields) !== JSON.stringify(["initialize"])) process.exit(1);
  if (value.planRulesActivation?.expectedPriorRuleCount !== 8
    || value.planRulesActivation?.desiredRuleCount !== 7
    || value.planRulesActivation?.orderedRollbackStep !== 1) process.exit(1);
' "$revert_report"

node scripts/nodered_reviewed_flow_deploy/prepare_exact_graph_contract.mjs \
  --live "$source_flow" \
  --candidate "$revert_flow" \
  --output "$revert_contract" \
  --deployment-id "$deployment_id-revert" \
  $(printf -- "--allow-change %s " "${allow_changes[@]}") >/dev/null

revert_source_sha="$(node -e 'const v=JSON.parse(require("fs").readFileSync(process.argv[1],"utf8"));process.stdout.write(v.sourceSha256)' "$revert_contract")"
revert_candidate_sha="$(node -e 'const v=JSON.parse(require("fs").readFileSync(process.argv[1],"utf8"));process.stdout.write(v.candidateSha256)' "$revert_contract")"
if [[ "$revert_source_sha" != "$applied_flow_sha" ]]; then
  echo "Live flow is not the applied club generation; ordered rollback cannot start" >&2
  exit 5
fi

remote_ssh "test ! -e '$remote_stage' && install -d -m 700 '$remote_stage'"
remote_stage_created=1
remote_scp_to "$revert_flow" "$host:$remote_candidate"
remote_scp_to "$revert_contract" "$host:$remote_contract"
remote_scp_to \
  scripts/nodered_reviewed_flow_deploy/runtime_contract.mjs \
  scripts/nodered_reviewed_flow_deploy/deploy_reviewed_flow_147_remote.mjs \
  "$host:$remote_stage/"
remote_ssh "chmod 600 '$remote_candidate' '$remote_contract' '$remote_runtime'; chmod 700 '$remote_helper'"

remote_ssh_capture "$stage_root/revert-preflight.json" \
  "node '$remote_helper' preflight --candidate '$remote_candidate' --contract '$remote_contract' --deployment-id '$deployment_id-revert'"
node -e '
  const value=JSON.parse(require("fs").readFileSync(process.argv[1],"utf8"));
  if (!value.ok || value.action !== "preflight" || value.sourceSha256 !== process.argv[2]
    || value.candidateSha256 !== process.argv[3] || value.changedNodeCount !== 1
    || value.addedNodeCount !== 0) process.exit(1);
' "$stage_root/revert-preflight.json" "$revert_source_sha" "$revert_candidate_sha"

ssh "${ssh_opts[@]}" "$host" "node '$remote_helper' apply --candidate '$remote_candidate' --contract '$remote_contract' --deployment-id '$deployment_id-revert' --stamp '$remote_stamp'" >"$stage_root/revert-apply.json"
node -e '
  const value=JSON.parse(require("fs").readFileSync(process.argv[1],"utf8"));
  if (!value.ok || value.action !== "apply" || value.activeFlowSha256 !== process.argv[2]) process.exit(1);
' "$stage_root/revert-apply.json" "$revert_candidate_sha"
remote_ssh_capture "$stage_root/revert-readback.txt" "sha256sum '$remote_live_flow' | cut -d' ' -f1"
if [[ "$(tr -d '\n' < "$stage_root/revert-readback.txt")" != "$revert_candidate_sha" ]]; then
  echo "Revert readback mismatch: the plan-rules global was not restored; stop and inspect" >&2
  exit 6
fi
if ! remote_ssh "node -e 'const fs=require(\"node:fs\");const flow=JSON.parse(fs.readFileSync(\"/root/.node-red/flows.json\",\"utf8\"));const g=flow.find(r=>r.id===\"lk_subscription_booking_router_20260804\");const i=typeof g.initialize===\"string\"?g.initialize:\"\";const key=\"const lk1DesiredPlanRules = \";const at=i.indexOf(key);if(at<0)process.exit(1);const desired=JSON.parse(i.slice(at+key.length).split(\";\n\")[0]);if(desired.rules.length!==7)process.exit(1);if(desired.rules.some(r=>r.productId===\"14692232-12be-4218-9fa1-2d5b79b62035\"))process.exit(1);if(!i.includes(\"const lk1PlanRulesExpectedPrior = {\"))process.exit(1);if(!i.includes(\"14692232-12be-4218-9fa1-2d5b79b62035\"))process.exit(1);'"; then
  echo "Installed initialize does not carry the club prior; stop and inspect" >&2
  exit 7
fi
echo "step1PlanRulesGlobal=restored(7 rules)"

# ------------------------------------------------------- step 2: the resolver generation
mkdir -m 700 "$stage2_dir"
remote_ssh_capture "$stage2_candidate" "cat '$remote_flow_backup'"
local_backup_sha="$(node -e 'const fs=require("node:fs");const crypto=require("node:crypto");process.stdout.write(crypto.createHash("sha256").update(fs.readFileSync(process.argv[1])).digest("hex"))' "$stage2_candidate")"
if [[ "$local_backup_sha" != "$preimage_flow_sha" ]]; then
  echo "Recorded flow backup is not the reviewed preimage; stop before restoring it" >&2
  exit 8
fi
node scripts/nodered_reviewed_flow_deploy/prepare_exact_graph_contract.mjs \
  --live "$source_flow" \
  --candidate "$stage2_candidate" \
  --output "$stage2_contract" \
  --deployment-id "$deployment_id-restore" \
  $(printf -- "--allow-change %s " "lk_subscription_booking_router_20260804:func,initialize"
    "lk_subscription_managed_policy_20260820:func"
    "lk_subscription_price_preview_20260908_router:func") >/dev/null

remote_scp_to "$stage2_candidate" "$host:$remote_candidate"
remote_scp_to "$stage2_contract" "$host:$remote_contract"
ssh "${ssh_opts[@]}" "$host" "node '$remote_helper' apply --candidate '$remote_candidate' --contract '$remote_contract' --deployment-id '$deployment_id-restore' --stamp '$remote_stamp'" >"$stage_root/restore-apply.json"
node -e '
  const value=JSON.parse(require("fs").readFileSync(process.argv[1],"utf8"));
  if (!value.ok || value.action !== "apply" || value.activeFlowSha256 !== process.argv[2]) process.exit(1);
' "$stage_root/restore-apply.json" "$preimage_flow_sha"
remote_ssh_capture "$stage_root/restore-readback.txt" "sha256sum '$remote_live_flow' | cut -d' ' -f1"
if [[ "$(tr -d '\n' < "$stage_root/restore-readback.txt")" != "$preimage_flow_sha" ]]; then
  echo "Restore readback mismatch; stop and inspect" >&2
  exit 9
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
  exit 10
fi

echo "rollback=complete"
echo "restoredFlowSha256=$preimage_flow_sha"
echo "revertCandidateSha256=$revert_candidate_sha"
echo "flowBackup=$remote_flow_backup"
echo "contractBackup=$remote_contract_backup"
