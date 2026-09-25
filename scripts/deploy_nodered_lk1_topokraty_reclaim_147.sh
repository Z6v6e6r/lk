#!/usr/bin/env bash

# Guarded deployment of the focused LK1 Topokraty rejection/reclaim generation.
#
#   * lk_subscription_booking_router_20260804.func — the reviewed Topokraty exclusion module
#     and its refusal in the exercise step (directions 6180/6233 stay outside every non-club
#     subscription), plus the ingress reclaim: a stored attempt whose provider write was
#     cleanly refused (4xx) is handed back to PREPARED under its own id, so the next POST is a
#     real new attempt instead of an endless `LK1_BOOKING_OUTCOME_UNRESOLVED` pending;
#   * lk_subscription_price_preview_20260908_router.func — recomposed on the patched generation,
#     so the advisory quote never advertises a benefit the write path refuses.
#
# The candidate changes exactly two nodes (one field each); every other node, route, the
# `initialize` setup and the existing activation globals stay byte-identical, and no node is
# added. The evaluator `lk_subscription_managed_policy_20260820` is NOT part of this generation.
#
# Unlike the «Дружба Топократы» resolver generation this one neither rewrites the plan-rules
# writer nor touches any activation global, so the rollback is the PLAIN flow restore from the
# recorded backup (no ordered step): `npm run nodered:lk1-topokraty-reclaim:rollback-147`.
#
# Requires an explicit confirmation variable, a clean main checkout equal to origin/main,
# and the exact upstream preimage. Everything else fails closed.

set -euo pipefail
umask 077

if [[ $# -ne 0 || "${NODE_RED_LK1_TOPOKRATY_RECLAIM_DEPLOY:-}" != "CONFIRM_147" ]]; then
  echo "Usage: NODE_RED_LK1_TOPOKRATY_RECLAIM_DEPLOY=CONFIRM_147 npm run nodered:lk1-topokraty-reclaim:deploy-147" >&2
  exit 2
fi

host="lk-primary-147"
deployment_id="lk1-topokraty-rejection-reclaim"
allow_nodes=(lk_subscription_booking_router_20260804 lk_subscription_price_preview_20260908_router)
expected_changed_nodes=2
# Field-level allowance: both nodes change only their function body; the gateway setup and the
# evaluator stay untouched.
allow_changes=(
  "lk_subscription_booking_router_20260804:func"
  "lk_subscription_price_preview_20260908_router:func"
)
expected_node_fields='{"lk_subscription_booking_router_20260804":["func"],"lk_subscription_price_preview_20260908_router":["func"]}'
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

stage_root="$(mktemp -d /private/tmp/padlhub-lk1-topokraty-reclaim-deploy.XXXXXX)"
ssh_control_root="$(mktemp -d /private/tmp/lk1tkrc.XXXXXX)"
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
    echo "apply started but not completed: run the plain rollback (see rollbackHint) before any retry" >&2
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
node scripts/patch_live_lk1_topokraty_rejection_reclaim_hotfix.mjs \
  --mode generation \
  --workspace "$workspace" \
  --output "$candidate_flow" \
  --report "$candidate_report" >/dev/null

# The generation must be exactly the two reviewed nodes with the reviewed field, and it must
# prove that the exclusion, the refusal, the reclaim and the preview binding are all present.
node -e '
  const value=JSON.parse(require("fs").readFileSync(process.argv[1],"utf8"));
  const expected=JSON.parse(process.argv[2]);
  const expectedCount=Number(process.argv[3]);
  const changes=Array.isArray(value.changes) ? value.changes : null;
  if (value.deploymentPerformed !== false || value.liveMutationPerformed !== false) process.exit(1);
  if (value.changedNodeCount !== expectedCount || !changes || changes.length !== expectedCount) process.exit(1);
  if (value.expectedChangedNodeCount !== expectedCount) process.exit(1);
  if (JSON.stringify(changes.map((change) => change.id).sort()) !== JSON.stringify(Object.keys(expected).sort())) process.exit(1);
  for (const change of changes) {
    if (JSON.stringify(change.fields) !== JSON.stringify(expected[change.id])) process.exit(1);
    if (!change.func || typeof change.func.beforeSha256 !== "string" || typeof change.func.afterSha256 !== "string") process.exit(1);
  }
  if (value.addedNodeCount !== 0) process.exit(1);
  if (value.targets?.booking?.id !== "lk_subscription_booking_router_20260804"
    || value.targets?.preview?.id !== "lk_subscription_price_preview_20260908_router") process.exit(1);
  if (value.booking?.id !== "lk_subscription_booking_router_20260804"
    || value.booking?.moduleEmbeddedOnce !== true
    || value.booking?.refusalBound !== true
    || value.booking?.reclaimBound !== true
    || value.booking?.reclaimPrecedesStop !== true) process.exit(1);
  if (value.preview?.id !== "lk_subscription_price_preview_20260908_router"
    || value.preview?.topokratyBound !== true
    || value.preview?.proTrainingKept !== true
    || value.preview?.sharedPreviewSourcesUnchanged !== true
    || value.preview?.initializeUnchanged !== true) process.exit(1);
  if (value.topologyChanged !== false || value.routesChanged !== false || value.policyChanged !== true) process.exit(1);
  if (value.upstreamFlowSha256 !== "d6df38f3148c576a1602f9d6e9509345d668a725044f0e536411c5b5bcb73dbe") process.exit(1);
  if (value.sourceNodeCount !== 4804) process.exit(1);
  if (value.sourceSha256 !== value.upstreamFlowSha256) process.exit(1);
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

# This generation does not touch the plan-rules writer, but the writer still runs inside the
# gateway initialize on every restart. Count its errors before the apply and require that the
# restart adds none.
plan_rules_error_pattern='plan rules prior mismatch|plan rules readback mismatch'
plan_rules_errors_before="$(remote_ssh "grep -hE '$plan_rules_error_pattern' /root/.pm2/logs/*node-red*.log 2>/dev/null | wc -l" | tr -d "[:space:]")"
plan_rules_errors_before="${plan_rules_errors_before:-0}"
echo "planRulesErrorsBefore=$plan_rules_errors_before"
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
  echo "Installed flow readback does not match the candidate; plain rollback required" >&2
  exit 5
fi

# The installed nodes must carry the reviewed markers the contour decision depends on, the
# gateway setup must stay untouched (no plan-rules writer rewrite), and the evaluator must not
# have entered this generation.
if ! remote_ssh "node -e 'const fs=require(\"node:fs\"); const flow=JSON.parse(fs.readFileSync(\"/root/.node-red/flows.json\",\"utf8\")); const node=id=>flow.find(row=>row.id===id)||{}; const func=n=>(typeof n.func===\"string\"?n.func:\"\"); const init=n=>(typeof n.initialize===\"string\"?n.initialize:\"\"); const bk=func(node(\"lk_subscription_booking_router_20260804\")); const bi=init(node(\"lk_subscription_booking_router_20260804\")); const pv=func(node(\"lk_subscription_price_preview_20260908_router\")); const wanted=[\"const LK1_RECLAIM_ATTEMPT_CAP = 5;\",\"const lk1ReclaimIsRecord = (value) => value !== null\",\"const lk1ReclaimText = (value) =>\",\"lk1ReclaimableAttempt(operation)\",\"ctx.caller !== \\\"split_create_readonly_preflight\\\" && lk1ReclaimableAttempt(operation)\",\"prepareMongoUpdate(ctx, \\\"lk1_ingress_reclaim\\\"\",\"TOPOKRATY_SUBSCRIPTION_UNAVAILABLE\",\"function isTopokratyClubPack(value) {\"]; if(!wanted.every(m=>bk.includes(m)))process.exit(1); const reclaimAt=bk.indexOf(\"lk1ReclaimableAttempt(operation)\"); const stopAt=bk.indexOf(\"return lk1Stop(ctx, \\\"LK1_BOOKING_OUTCOME_UNRESOLVED\\\")\"); if(reclaimAt<0||stopAt<0||reclaimAt>=stopAt)process.exit(1); if(bi.includes(\"\\\"planKey\\\":\\\"topocraty\\\"\"))process.exit(1); if(bi.includes(\"LK1_PLAN_RULES_WITH_TOPOKRATY\"))process.exit(1); if(!pv.includes(\"isTopokratyExercise(exercise)\")||!pv.includes(\"isTopokratyClubPack(topokratyClubRow)\")||!pv.includes(\"canonical.isProTrainingExercise\"))process.exit(1); if(pv.includes(\"canonical.isTopokratyExercise\"))process.exit(1); '"; then
  echo "Installed nodes do not carry the reviewed rejection/reclaim rule, or the gateway setup changed; plain rollback required" >&2
  exit 7
fi

# The flow being online does not prove the untouched plan-rules writer still agrees with the
# runtime global: the initialize would log "plan rules prior mismatch/readback mismatch".
plan_rules_errors_after="$(remote_ssh "grep -hE '$plan_rules_error_pattern' /root/.pm2/logs/*node-red*.log 2>/dev/null | wc -l" | tr -d "[:space:]")"
plan_rules_errors_after="${plan_rules_errors_after:-0}"
echo "planRulesErrorsAfter=$plan_rules_errors_after"
if [[ "$plan_rules_errors_after" -gt "$plan_rules_errors_before" ]]; then
  echo "Gateway initialize failed to keep the plan-rules global (writer error in the Node-RED log); plain rollback required" >&2
  ssh "${ssh_opts[@]}" "$host" "tail -n 200 /root/.pm2/logs/*node-red*.log 2>/dev/null | grep -E '$plan_rules_error_pattern' | tail -3" >&2 || true
  exit 8
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
  echo "LK backend smoke check failed after the warm-up budget; plain rollback required" >&2
  exit 6
fi

completed=1
echo "deployedGitSha=$local_sha"
echo "sourceFlowSha256=$source_sha"
echo "activeFlowSha256=$candidate_sha"
echo "installedFlowReadbackSha256=$installed_sha"
echo "changedNodeCount=$expected_changed_nodes"
echo "planRulesErrorsBefore=$plan_rules_errors_before"
echo "planRulesErrorsAfter=$plan_rules_errors_after"
echo "flowBackup=$remote_flow_backup"
echo "contractBackup=$remote_contract_backup"
echo "smokeUrl=$smoke_url"
echo "rollbackHint=NODE_RED_LK1_TOPOKRATY_RECLAIM_ROLLBACK=CONFIRM_147 npm run nodered:lk1-topokraty-reclaim:rollback-147 -- $remote_stamp"
