#!/usr/bin/env bash

# Guarded deployment of the focused LK1 «Дружба Топократы» generation.
#
#   * lk_subscription_booking_router_20260804.func — the reviewed `exerciseDirectionId`
#     helper, `directionId` in the server-resolved target and the decision-percent
#     comparison (`lk1ExpectedEventDiscountPercent`), so a client quote is checked against
#     the percent the decision itself fixed (club full price 0 %, the quarter-of-court
#     co-pay share, or the configured event discount);
#   * lk_subscription_booking_router_20260804.initialize — the plan-rules writer is
#     REPLACED by the guarded `LK1_PLAN_RULES_DESIRED -> LK1_PLAN_RULES_WITH_TOPOKRATY`
#     transition (7 rules -> 8 rules, club product 14692232-…, planKey `topocraty`);
#   * lk_subscription_managed_policy_20260820.func — the reviewed evaluator with the club
#     training branch (shared free hour + quarter-of-court co-pay, full price when the hour
#     is unavailable);
#   * lk_subscription_price_preview_20260908_router.func — recomposed on the patched
#     generation so the advisory quote and the write path agree.
#
# The candidate changes exactly three nodes (five fields); every other node, route and the
# existing activation globals stay byte-identical, and no node is added.
#
# This generation is stacked on the installed plan-rules generation (its reviewed preimage
# is that generation's postimage `d6df38f3…`), so it refuses any other live flow.
#
# The rollback is ORDERED and is NOT the plain flow restore: the plan-rules global must go
# back to the installed 7-rule payload first (`npm run nodered:lk1-topokraty-friendship:rollback-147`),
# and only then the resolver generation is restored. The reverse order would leave the global
# naming the club product while the restored evaluator has no club branch, and a direction-6233
# training would be priced at the ordinary 50 %.
#
# Requires an explicit confirmation variable, a clean main checkout equal to origin/main,
# and the exact upstream preimage. Everything else fails closed.

set -euo pipefail
umask 077

if [[ $# -ne 0 || "${NODE_RED_LK1_TOPOKRATY_FRIENDSHIP_DEPLOY:-}" != "CONFIRM_147" ]]; then
  echo "Usage: NODE_RED_LK1_TOPOKRATY_FRIENDSHIP_DEPLOY=CONFIRM_147 npm run nodered:lk1-topokraty-friendship:deploy-147" >&2
  exit 2
fi

host="lk-primary-147"
deployment_id="lk1-topokraty-friendship"
allow_nodes=(lk_subscription_booking_router_20260804 lk_subscription_managed_policy_20260820 lk_subscription_price_preview_20260908_router)
expected_changed_nodes=3
# Field-level allowance: the gateway changes its function body and its setup (the plan-rules
# writer is replaced), the evaluator and the preview change only `func`.
allow_changes=(
  "lk_subscription_booking_router_20260804:func,initialize"
  "lk_subscription_managed_policy_20260820:func"
  "lk_subscription_price_preview_20260908_router:func"
)
expected_node_fields='{"lk_subscription_booking_router_20260804":["func","initialize"],"lk_subscription_managed_policy_20260820":["func"],"lk_subscription_price_preview_20260908_router":["func"]}'
smoke_url="https://padlhub.su/lk/advertising/split-payment-promo"
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

stage_root="$(mktemp -d /private/tmp/padlhub-lk1-topokraty-friendship-deploy.XXXXXX)"
ssh_control_root="$(mktemp -d /private/tmp/lk1tkf.XXXXXX)"
workspace="$stage_root/live"
candidate_dir="$stage_root/candidate"
source_flow="$workspace/input/source.flow.json"
candidate_flow="$candidate_dir/candidate.flow.json"
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
  if [[ "$apply_started" == "1" && "$completed" != "1" ]]; then
    echo "apply started but not completed: run the ordered rollback (see rollbackHint) before any retry" >&2
  fi
  if [[ "$remote_stage_created" == "1" ]]; then
    ssh "${ssh_opts[@]}" "$host" "rm -f '$remote_candidate' '$remote_contract' '$remote_helper' '$remote_runtime'; rmdir '$remote_stage' 2>/dev/null || true" >/dev/null 2>&1 || true
  fi
  ssh "${ssh_opts[@]}" -O exit "$host" >/dev/null 2>&1 || true
  rm -f "$ssh_control_root"/c-* 2>/dev/null || true
  rmdir "$ssh_control_root" 2>/dev/null || true
  if [[ "$apply_started" != "1" ]]; then
    rm -rf "$stage_root" 2>/dev/null || true
  fi
}
trap cleanup EXIT
trap 'exit 130' INT
trap 'exit 143' TERM HUP

node -e '
  const expected=JSON.parse(process.argv[1]);
  const nodes=process.argv.slice(2).sort();
  if (JSON.stringify(Object.keys(expected).sort()) !== JSON.stringify(nodes)) process.exit(1);
' "$expected_node_fields" "${allow_nodes[@]}"

pull_live_workspace

mkdir -m 700 "$candidate_dir"
node scripts/patch_live_lk1_topokraty_friendship_hotfix.mjs \
  --mode generation \
  --workspace "$workspace" \
  --output "$candidate_flow" \
  --report "$candidate_report" >/dev/null

# The generation must be exactly the three reviewed nodes with the reviewed fields.
node -e '
  const value=JSON.parse(require("fs").readFileSync(process.argv[1],"utf8"));
  const expected=JSON.parse(process.argv[2]);
  const expectedCount=Number(process.argv[3]);
  const changes=Array.isArray(value.changes) ? value.changes : null;
  if (value.deploymentPerformed !== false || value.liveMutationPerformed !== false) process.exit(1);
  if (value.changedNodeCount !== expectedCount || !changes || changes.length !== expectedCount) process.exit(1);
  if (JSON.stringify(changes.map((change) => change.id).sort()) !== JSON.stringify(Object.keys(expected).sort())) process.exit(1);
  for (const change of changes) {
    if (JSON.stringify(change.fields) !== JSON.stringify(expected[change.id])) process.exit(1);
  }
  if (value.addedNodeCount !== 0) process.exit(1);
  if (value.gateway?.directionHelperEmbeddedOnce !== true
    || value.gateway?.targetDirectionBound !== true
    || value.gateway?.decisionPercentBound !== true
    || value.gateway?.planRulesPayloadReplaced !== true
    || value.evaluator?.clubBranchBound !== true
    || value.preview?.resolverReachable !== true
    || value.preview?.initializeUnchanged !== true
    || value.planRulesActivation?.expectedPriorRuleCount !== 7
    || value.planRulesActivation?.desiredRuleCount !== 8
    || value.planRulesActivation?.clubProductId !== "14692232-12be-4218-9fa1-2d5b79b62035") process.exit(1);
' "$candidate_report" "$expected_node_fields" "$expected_changed_nodes"

node scripts/nodered_reviewed_flow_deploy/prepare_exact_graph_contract.mjs \
  --live "$source_flow" \
  --candidate "$candidate_flow" \
  --output "$contract_file" \
  --deployment-id "$deployment_id" \
  $(printf -- "--allow-change %s " "${allow_changes[@]}") >/dev/null

source_sha="$(node -e 'const value=JSON.parse(require("fs").readFileSync(process.argv[1],"utf8")); process.stdout.write(value.sourceSha256)' "$contract_file")"
candidate_sha="$(node -e 'const value=JSON.parse(require("fs").readFileSync(process.argv[1],"utf8")); process.stdout.write(value.candidateSha256)' "$contract_file")"
source_node_count="$(node -e 'const value=JSON.parse(require("fs").readFileSync(process.argv[1],"utf8")); process.stdout.write(String(value.sourceNodeCount))' "$contract_file")"
candidate_node_count="$(node -e 'const value=JSON.parse(require("fs").readFileSync(process.argv[1],"utf8")); process.stdout.write(String(value.candidateNodeCount))' "$contract_file")"
node -e '
  const value=JSON.parse(require("fs").readFileSync(process.argv[1],"utf8"));
  const expected=JSON.parse(process.argv[2]);
  const expectedCount=Number(process.argv[3]);
  if (value.formatVersion !== 2 || value.contractKind !== "exact-graph") process.exit(1);
  const changes=Array.isArray(value.allowedChanges) ? value.allowedChanges : null;
  if (!changes || changes.length !== expectedCount) process.exit(1);
  if (JSON.stringify(changes.map((change) => change.id).sort()) !== JSON.stringify(Object.keys(expected).sort())) process.exit(1);
  for (const change of changes) {
    if (JSON.stringify(change.fields) !== JSON.stringify(expected[change.id])) process.exit(1);
  }
  if ((value.allowedAdditions ?? []).length !== 0) process.exit(1);
' "$contract_file" "$expected_node_fields" "$expected_changed_nodes"

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
    || value.candidateSha256 !== process.argv[3] || value.changedNodeCount !== Number(process.argv[4])
    || value.addedNodeCount !== 0 || String(value.nodeCount) !== process.argv[5]
    || String(value.candidateNodeCount) !== process.argv[6]) process.exit(1);
' "$preflight_result" "$source_sha" "$candidate_sha" "$expected_changed_nodes" "$source_node_count" "$candidate_node_count"

apply_started=1
echo "stamp=$remote_stamp"
echo "flowBackup=$remote_flow_backup"
echo "contractBackup=$remote_contract_backup"
ssh "${ssh_opts[@]}" "$host" "node '$remote_helper' apply --candidate '$remote_candidate' --contract '$remote_contract' --deployment-id '$deployment_id' --stamp '$remote_stamp'" >"$apply_result"
node -e '
  const value=JSON.parse(require("fs").readFileSync(process.argv[1],"utf8"));
  if (!value.ok || value.action !== "apply" || value.sourceSha256 !== process.argv[2]
    || value.activeFlowSha256 !== process.argv[3] || value.flowBackup !== process.argv[4]
    || value.contractBackup !== process.argv[5]) process.exit(1);
' "$apply_result" "$source_sha" "$candidate_sha" "$remote_flow_backup" "$remote_contract_backup"

remote_ssh_capture "$stage_root/readback.txt" "sha256sum '$remote_live_flow' | cut -d' ' -f1"
installed_sha="$(tr -d '\n' < "$stage_root/readback.txt")"
if [[ "$installed_sha" != "$candidate_sha" ]]; then
  echo "Installed flow readback does not match the candidate; ordered rollback required" >&2
  exit 5
fi

# The installed nodes must carry the reviewed markers the contour decision depends on.
if ! remote_ssh "node -e 'const fs=require(\"node:fs\");const flow=JSON.parse(fs.readFileSync(\"/root/.node-red/flows.json\",\"utf8\"));const node=id=>flow.find(row=>row.id===id)||{};const func=n=>(typeof n.func===\"string\"?n.func:\"\");const init=n=>(typeof n.initialize===\"string\"?n.initialize:\"\");const gateway=node(\"lk_subscription_booking_router_20260804\");const evaluator=node(\"lk_subscription_managed_policy_20260820\");const preview=node(\"lk_subscription_price_preview_20260908_router\");const gw=func(gateway);const gwi=init(gateway);const ev=func(evaluator);const pv=func(preview);const wanted=[\"const exerciseDirectionId = (exercise) => {\",\"directionId: exerciseDirectionId(exercise),\",\"lk1ExpectedEventDiscountPercent(decision, route)\"];if(!wanted.every(m=>gw.includes(m)))process.exit(1);if(!gwi.includes(\"14692232-12be-4218-9fa1-2d5b79b62035\"))process.exit(1);if(gwi.includes(\"const lk1PlanRulesExpectedPrior = null;\"))process.exit(1);if(!ev.includes(\"isTopokratyTrainingBenefit\")||!ev.includes(\"eventDiscountPercent\"))process.exit(1);if(!pv.includes(\"canonical.resolveLk1Rule\"))process.exit(1);'"; then
  echo "Installed nodes do not carry the reviewed club rule; ordered rollback required" >&2
  exit 7
fi

smoke_ok=0
for ((smoke_attempt = 1; smoke_attempt <= 30; smoke_attempt++)); do
  if curl -sS --max-time 15 -o "$postcheck_result" -w '%{http_code}' "$smoke_url" > "$stage_root/smoke.status" \
    && [[ "$(tr -d '\n' < "$stage_root/smoke.status")" == "200" ]] \
    && node -e '
        const value=JSON.parse(require("fs").readFileSync(process.argv[1],"utf8"));
        if (!value || typeof value !== "object" || Array.isArray(value)
          || value.currency !== "RUB" || typeof value.pricingMode !== "string") process.exit(1);
      ' "$postcheck_result"; then
    smoke_ok=1
    break
  fi
  sleep 3
done
if [[ "$smoke_ok" != "1" ]]; then
  echo "LK backend smoke check failed after the warm-up budget; ordered rollback required" >&2
  exit 6
fi

completed=1
echo "deployedGitSha=$local_sha"
echo "sourceFlowSha256=$source_sha"
echo "activeFlowSha256=$candidate_sha"
echo "installedFlowReadbackSha256=$installed_sha"
echo "upstreamFlowSha256=$source_sha"
echo "clubProductId=14692232-12be-4218-9fa1-2d5b79b62035"
echo "clubTrainingDirection=6233"
echo "changedNodeCount=$expected_changed_nodes"
echo "flowBackup=$remote_flow_backup"
echo "contractBackup=$remote_contract_backup"
echo "smokeUrl=$smoke_url"
echo "rollbackOrder=1-plan-rules-global 2-resolver-generation"
echo "rollbackHint=NODE_RED_LK1_TOPOKRATY_FRIENDSHIP_ROLLBACK=CONFIRM_147 npm run nodered:lk1-topokraty-friendship:rollback-147 -- $remote_stamp"
