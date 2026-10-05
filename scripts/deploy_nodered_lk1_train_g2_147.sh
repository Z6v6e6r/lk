#!/usr/bin/env bash

# Guarded deployment of G2 of the 2026-10-05 LK1 train (server 147).
#
# G2 stacks the reviewed *content* of the train on G1's postimage (`99b5d5b5…`) and changes exactly
# one field (`func`) of three nodes:
#   * `lk_subscription_managed_policy_20260820.func` — the reviewed evaluator (club court-hourly
#     co-pay for directions 6233/6180 plus the Patriots money-validity branch the G1 gateway guard
#     feeds);
#   * `lk_subscription_price_preview_20260908_evaluate.func` — the same reviewed evaluator;
#   * `lk_subscription_price_preview_20260908_router.func` — the reviewed preview router
#     (court-window step, Topokraty exclusion, PRO-training and shared plan-rules resolver).
#
# G2 must never run unless G1's readback passed: the wrapper requires the installed flow to be
# exactly G1's postimage `99b5d5b5…` before composing, and the shared reviewed-flow runtime refuses
# the apply while G1's 15-minute soak lease is active. The wrapper waits out that lease
# (docs/NODERED_MODULAR_WORKFLOW.md: "wait for expiry") so G1 and G2 run back to back without
# leaving the Patriots plan rules alone in the runtime.
#
# Requires an explicit confirmation variable, a clean main checkout equal to origin/main and G1's
# exact postimage. Everything else fails closed. The `--dry-run` path never contacts 147.

set -euo pipefail
umask 077

usage() {
  echo "Usage: NODE_RED_LK1_TRAIN_G2_DEPLOY=CONFIRM_147 npm run nodered:lk1-train-g2:deploy-147" >&2
  echo "       NODE_RED_LK1_TRAIN_G2_DEPLOY=CONFIRM_147 bash scripts/deploy_nodered_lk1_train_g2_147.sh --dry-run [--snapshot /absolute/g1-postimage.flow.json]" >&2
}

dry_run=0
snapshot_arg=""
while [[ $# -gt 0 ]]; do
  case "$1" in
    --dry-run)
      dry_run=1
      shift
      ;;
    --snapshot)
      if [[ $# -lt 2 || -z "$2" ]]; then usage; exit 2; fi
      snapshot_arg="$2"
      shift 2
      ;;
    *)
      usage
      exit 2
      ;;
  esac
done

if [[ "${NODE_RED_LK1_TRAIN_G2_DEPLOY:-}" != "CONFIRM_147" ]]; then
  usage
  exit 2
fi

host="lk-primary-147"
deployment_id="lk1-train-g2"
allow_nodes=(lk_subscription_managed_policy_20260820 lk_subscription_price_preview_20260908_evaluate lk_subscription_price_preview_20260908_router)
expected_changed_nodes=3
allow_changes=(
  "lk_subscription_managed_policy_20260820:func"
  "lk_subscription_price_preview_20260908_evaluate:func"
  "lk_subscription_price_preview_20260908_router:func"
)
expected_node_fields='{"lk_subscription_managed_policy_20260820":["func"],"lk_subscription_price_preview_20260908_evaluate":["func"],"lk_subscription_price_preview_20260908_router":["func"]}'
evaluator_id="lk_subscription_managed_policy_20260820"
evaluate_id="lk_subscription_price_preview_20260908_evaluate"
router_id="lk_subscription_price_preview_20260908_router"
preimage_flow_sha="99b5d5b5c2617e77f654c68ac12c9d7f834e0a65334feb1d9b12dc5a6d267ba3"
candidate_flow_sha="0f95fbd3f050d45173c8f2642a4b0dc34ec1fea0384933473ed3b70750777192"
source_node_count=4815
evaluator_func_before_sha="2d3f5b5080152c07ace9e4aaf31e7b0280878576c027ca7f5c30dd15d9b45602"
evaluator_func_after_sha="e876ba0722e09798f5f065d1c3bf55ae6df408b84a78f56345f011bbf419f5e1"
evaluate_func_before_sha="2d3f5b5080152c07ace9e4aaf31e7b0280878576c027ca7f5c30dd15d9b45602"
evaluate_func_after_sha="e876ba0722e09798f5f065d1c3bf55ae6df408b84a78f56345f011bbf419f5e1"
router_func_before_sha="43c21f70844b795a4f53af43d1c9e18afaff34ff243690d74ef260cec39c9a70"
router_func_after_sha="0f2e528de34f4b7ebf134ac219743b02905585cb74779f91863a8d2806d44221"
gateway_postimage_func_sha="7f1539bfbeb6ba9ed3a068e6706ca7af23454f29e28055d5fade8f538d00f0d4"
allowance_after_sha="2916f13c5987a6d056d198ab539ccff6127f43d875c8ae9c0328d03187dbc813"
smoke_url="https://padlhub.su/lk/advertising/split-payment-promo"
repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd -P)"
cd "$repo_root"

local_tmp_root() {
  local candidate
  for candidate in /private/tmp "${TMPDIR:-/tmp}"; do
    if [[ -d "$candidate" && -w "$candidate" ]]; then
      (cd "$candidate" && pwd -P)
      return 0
    fi
  done
  echo "No canonical writable temporary root is available" >&2
  return 1
}

sha256_file() {
  node -e 'const fs=require("node:fs"),crypto=require("node:crypto");process.stdout.write(crypto.createHash("sha256").update(fs.readFileSync(process.argv[1])).digest("hex"))' "$1"
}

stage_pinned_workspace() {
  local snapshot_path="$1" pinned_workspace="$2"
  mkdir -m 700 "$pinned_workspace"
  mkdir -m 700 "$pinned_workspace/input"
  local pinned_source="$pinned_workspace/input/source.flow.json"
  cp "$snapshot_path" "$pinned_source"
  chmod 600 "$pinned_source"
  node --input-type=module -e '
    import crypto from "node:crypto";
    import fs from "node:fs";
    const [sourcePath, metaPath, finalSourcePath] = process.argv.slice(1);
    const raw = fs.readFileSync(sourcePath);
    const flow = JSON.parse(raw);
    if (!Array.isArray(flow)) throw new Error("Pinned snapshot must be a JSON array");
    const ids = new Set();
    for (const node of flow) {
      if (!node || typeof node !== "object" || Array.isArray(node) || typeof node.id !== "string" || !node.id.trim()) {
        throw new Error("Pinned snapshot contains an invalid node");
      }
      if (ids.has(node.id)) throw new Error(`Duplicate Node-RED node id: ${node.id}`);
      ids.add(node.id);
    }
    const meta = {
      formatVersion: 1,
      sourceKind: "live-147",
      sourceHost: "lk-primary-147",
      sourceUser: "root",
      sourcePort: "22",
      sourceTransport: "pinned-snapshot",
      remoteFlowPath: "/root/.node-red/flows.json",
      localSourcePath: finalSourcePath,
      pulledAt: new Date().toISOString(),
      sourceSha256: crypto.createHash("sha256").update(raw).digest("hex"),
      nodeCount: flow.length,
    };
    fs.writeFileSync(metaPath, `${JSON.stringify(meta, null, 2)}\n`, { mode: 0o600, flag: "wx" });
  ' "$pinned_source" "$pinned_workspace/input/source.flow.meta.json" "$pinned_source"
  chmod 600 "$pinned_workspace/input/source.flow.meta.json"
}

write_g2_postcheck() {
  local out="$1"
  cat > "$out" <<'CJS'
const crypto = require("node:crypto");
const fs = require("node:fs");
const flow = JSON.parse(fs.readFileSync(process.argv[2], "utf8"));
const node = (id) => flow.find((row) => row.id === id) || {};
const func = (row) => (typeof row.func === "string" ? row.func : "");
const evaluator = func(node("lk_subscription_managed_policy_20260820"));
const previewEvaluate = func(node("lk_subscription_price_preview_20260908_evaluate"));
const previewRouter = func(node("lk_subscription_price_preview_20260908_router"));
for (const body of [evaluator, previewEvaluate]) {
  if (!body.includes("COURT_HOURLY_COPAY")) process.exit(1);
  if (!body.includes("LK1_COURT_PRICE_UNRESOLVED")) process.exit(1);
  if (!body.includes("PATRIOTS_FRIENDSHIP_PRODUCT_ID")) process.exit(1);
}
for (const marker of ["COURT_HOURLY_COPAY", "if (ctx.step === 'courtWindow') {", "isTopokratyExercise",
  "isTopokratyClubPack", "canonical.isProTrainingExercise", "canonical.resolveLk1Rule"]) {
  if (!previewRouter.includes(marker)) process.exit(1);
}
// Corrected Step-2 postcheck 4: G2 does not touch the gateway, so G1's postimage body — including
// the club money mandate and the resolved court dispatch order — must survive the G2 apply.
const gateway = func(node("lk_subscription_booking_router_20260804"));
const hash = (value) => crypto.createHash("sha256").update(value).digest("hex");
if (hash(gateway) !== "7f1539bfbeb6ba9ed3a068e6706ca7af23454f29e28055d5fade8f538d00f0d4") process.exit(1);
const bindingStart = "const lk1ClubEventPaymentBinding = (ctx, quote = ctx.lk1) => {";
const bindingAt = gateway.indexOf(bindingStart);
const bindingClose = gateway.indexOf("\n};\n", bindingAt + bindingStart.length);
if (bindingAt < 0 || bindingClose < 0) process.exit(1);
const binding = gateway.slice(bindingAt, bindingClose + 4);
if (gateway.split("COURT_HOURLY_COPAY").length !== 2) process.exit(1);
if (!binding.includes("if (decision.benefit?.kind === \"COURT_HOURLY_COPAY\")")) process.exit(1);
if (!binding.includes("perHour === Math.floor(hourly / 4)")) process.exit(1);
const stationAt = gateway.indexOf("      ctx.studioId = quote.target.stationId;\n");
const roomAt = gateway.indexOf("      ctx.roomId = quote.target.roomId;\n");
const dispatchAt = gateway.indexOf("      if (lk1CourtWindowNeeded(ctx)) ctx.lk1CourtExercise = exercise;\n");
if (!(stationAt >= 0 && stationAt < roomAt && roomAt < dispatchAt)) process.exit(1);
CJS
  chmod 600 "$out"
}

node -e '
  const expected=JSON.parse(process.argv[1]);
  const nodes=process.argv.slice(2).sort();
  if (JSON.stringify(Object.keys(expected).sort()) !== JSON.stringify(nodes)) process.exit(1);
' "$expected_node_fields" "${allow_nodes[@]}"

stage_root="$(mktemp -d "$(local_tmp_root)/padlhub-lk1-train-g2-deploy.XXXXXX")"
ssh_control_root="$(mktemp -d "$(local_tmp_root)/lk1tg2.XXXXXX")"
workspace="$stage_root/live"
candidate_dir="$stage_root/candidate"
source_flow="$workspace/input/source.flow.json"
candidate_flow="$candidate_dir/candidate.flow.json"
candidate_report="$candidate_dir/report.json"
contract_file="$candidate_dir/contract.json"
g2_postcheck="$candidate_dir/g2-postcheck.cjs"
preflight_result="$stage_root/preflight.json"
apply_result="$stage_root/apply.json"
postcheck_result="$stage_root/postcheck.json"
remote_stamp="$(date '+%Y%m%dT%H%M%S%z')"
remote_stage="/root/.node-red/.padlhub-reviewed-flow-stage-$remote_stamp-$$"
remote_candidate="$remote_stage/candidate.flow.json"
remote_contract="$remote_stage/contract.json"
remote_helper="$remote_stage/deploy_reviewed_flow_147_remote.mjs"
remote_runtime="$remote_stage/runtime_contract.mjs"
remote_postcheck="$remote_stage/g2-postcheck.cjs"
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
ssh_retry_attempts="${NODE_RED_LK1_TRAIN_G2_SSH_ATTEMPTS:-5}"
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

# The shared reviewed-flow runtime refuses the apply while G1's 15-minute soak lease is active
# (docs/NODERED_MODULAR_WORKFLOW.md: "wait for expiry"). G2 waits out G1's own lease instead of
# deleting or editing it; a lease for any other deployment fails closed.
lease_path="/root/.node-red/.padlhub-reviewed-flow-deploy.lease.json"
soak_wait_budget="${NODE_RED_LK1_TRAIN_SOAK_WAIT_SECONDS:-1800}"
wait_for_soak_lease() {
  local expected="$1" waited=0 lease state lease_id remaining phase
  while :; do
    lease="$(remote_ssh "cat '$lease_path' 2>/dev/null || true")"
    if [[ -z "$lease" ]]; then return 0; fi
    state="$(printf '%s' "$lease" | node -e 'let s="";process.stdin.on("data",(c)=>{s+=c;}).on("end",()=>{let v;try{v=JSON.parse(s);}catch{process.stdout.write("INVALID 0 0");return;}process.stdout.write(`${String(v.deploymentId)} ${Math.max(0,Math.round((Number(v.expiresAtMs)-Date.now())/1000))} ${String(v.phase||"legacy-unknown")}`);});')"
    read -r lease_id remaining phase <<< "$state"
    if [[ "$lease_id" == "INVALID" ]]; then
      echo "Reviewed-flow deployment lease is invalid; refusing to wait" >&2
      return 1
    fi
    if [[ "$lease_id" != "$expected" ]]; then
      echo "A reviewed-flow lease for $lease_id is active; refusing to wait for $expected" >&2
      return 1
    fi
    if [[ "$phase" != "soaking" ]]; then
      echo "Reviewed-flow lease for $lease_id is in phase $phase and does not auto-expire; roll back the owning deployment" >&2
      return 1
    fi
    if (( remaining <= 0 )); then return 0; fi
    if (( waited >= soak_wait_budget )); then
      echo "Soak lease for $lease_id is still active (${remaining}s remaining); re-run after expiry" >&2
      return 1
    fi
    echo "waiting for the $lease_id soak lease: ${remaining}s remaining"
    sleep 30
    waited=$((waited + 30))
  done
}

cleanup() {
  if [[ "$apply_started" == "1" && "$completed" != "1" ]]; then
    echo "apply started but not completed: run the G2 rollback (see rollbackHint) before any retry" >&2
  fi
  if [[ "$remote_stage_created" == "1" ]]; then
    ssh "${ssh_opts[@]}" "$host" "rm -f '$remote_candidate' '$remote_contract' '$remote_helper' '$remote_runtime' '$remote_postcheck'; rmdir '$remote_stage' 2>/dev/null || true" >/dev/null 2>&1 || true
    ssh "${ssh_opts[@]}" -O exit "$host" >/dev/null 2>&1 || true
  fi
  rm -f "$ssh_control_root"/c-* 2>/dev/null || true
  rmdir "$ssh_control_root" 2>/dev/null || true
  if [[ "$apply_started" != "1" ]]; then
    rm -rf "$stage_root" 2>/dev/null || true
  fi
}
trap cleanup EXIT
trap 'exit 130' INT
trap 'exit 143' TERM HUP

compose_and_validate() {
  mkdir -m 700 "$candidate_dir"
  write_g2_postcheck "$g2_postcheck"
  node scripts/patch_live_lk1_train_g2_20261005.mjs \
    --workspace "$workspace" \
    --output "$candidate_flow" \
    --report "$candidate_report" >/dev/null

  node -e '
    const fs=require("node:fs");
    const value=JSON.parse(fs.readFileSync(process.argv[1],"utf8"));
    const evaluator="lk_subscription_managed_policy_20260820";
    const evaluate="lk_subscription_price_preview_20260908_evaluate";
    const router="lk_subscription_price_preview_20260908_router";
    const evaluatorBefore="2d3f5b5080152c07ace9e4aaf31e7b0280878576c027ca7f5c30dd15d9b45602";
    const evaluatorAfter="e876ba0722e09798f5f065d1c3bf55ae6df408b84a78f56345f011bbf419f5e1";
    const routerBefore="43c21f70844b795a4f53af43d1c9e18afaff34ff243690d74ef260cec39c9a70";
    const routerAfter="0f2e528de34f4b7ebf134ac219743b02905585cb74779f91863a8d2806d44221";
    if(value.kind!=="FOCUSED_LK1_TRAIN_G2_V1"||value.deploymentId!=="lk1-train-g2")process.exit(1);
    if(value.deploymentPerformed!==false||value.liveMutationPerformed!==false)process.exit(1);
    if(value.changedNodeCount!==3||value.expectedChangedNodeCount!==3||value.addedNodeCount!==0)process.exit(1);
    const changes=Array.isArray(value.changes)?value.changes:null;
    if(!changes||changes.length!==3)process.exit(1);
    if(JSON.stringify(changes.map((row)=>row.id).sort())!==JSON.stringify([evaluate,evaluator,router].sort()))process.exit(1);
    for(const row of changes){if(JSON.stringify(row.fields)!==JSON.stringify(["func"]))process.exit(1);}
    const byId=(id)=>changes.find((row)=>row.id===id);
    if(byId(evaluator).func.beforeSha256!==evaluatorBefore||byId(evaluator).func.afterSha256!==evaluatorAfter)process.exit(1);
    if(byId(evaluate).func.beforeSha256!==evaluatorBefore||byId(evaluate).func.afterSha256!==evaluatorAfter)process.exit(1);
    if(byId(router).func.beforeSha256!==routerBefore||byId(router).func.afterSha256!==routerAfter)process.exit(1);
    if(value.upstreamFlowSha256!==process.argv[2]||value.sourceSha256!==process.argv[2])process.exit(1);
    if(value.candidateSha256!==process.argv[3])process.exit(1);
    if(value.sourceNodeCount!==4815||value.candidateNodeCount!==4815)process.exit(1);
    const t=value.targets||{};
    if(!t.evaluator||t.evaluator.id!==evaluator||t.evaluator.func.beforeSha256!==evaluatorBefore||t.evaluator.func.afterSha256!==evaluatorAfter)process.exit(1);
    if(!t.previewEvaluate||t.previewEvaluate.id!==evaluate||t.previewEvaluate.func.beforeSha256!==evaluatorBefore||t.previewEvaluate.func.afterSha256!==evaluatorAfter)process.exit(1);
    if(!t.previewRouter||t.previewRouter.id!==router||t.previewRouter.func.beforeSha256!==routerBefore||t.previewRouter.func.afterSha256!==routerAfter)process.exit(1);
    const e=value.evaluator||{};
    if(e.id!==evaluator||e.courtBranchBound!==true||e.courtRefusalBound!==true||e.patriotsBranchBound!==true)process.exit(1);
    const p=value.preview||{};
    if(p.id!==router||p.courtWindowStepBound!==true||p.courtQuoteBound!==true
      ||p.topokratyExclusionKept!==true||p.proTrainingKept!==true||p.resolverReachable!==true)process.exit(1);
    if(value.gatewayPostimageSha256!=="7f1539bfbeb6ba9ed3a068e6706ca7af23454f29e28055d5fade8f538d00f0d4")process.exit(1);
    if(value.usageBlockSha256!=="2916f13c5987a6d056d198ab539ccff6127f43d875c8ae9c0328d03187dbc813")process.exit(1);
    if(value.planRulesActivation!==null)process.exit(1);
    if(value.topologyChanged!==false||value.routesChanged!==false||value.policyChanged!==true)process.exit(1);
  ' "$candidate_report" "$preimage_flow_sha" "$candidate_flow_sha"

  if [[ "$(sha256_file "$candidate_flow")" != "$candidate_flow_sha" ]]; then
    echo "Composed candidate is not the reviewed G2 postimage" >&2
    exit 5
  fi

  node scripts/nodered_reviewed_flow_deploy/prepare_exact_graph_contract.mjs \
    --live "$source_flow" \
    --candidate "$candidate_flow" \
    --output "$contract_file" \
    --deployment-id "$deployment_id" \
    $(printf -- "--allow-change %s " "${allow_changes[@]}") >/dev/null

  node -e '
    const fs=require("node:fs");
    const value=JSON.parse(fs.readFileSync(process.argv[1],"utf8"));
    const expected=["lk_subscription_managed_policy_20260820","lk_subscription_price_preview_20260908_evaluate","lk_subscription_price_preview_20260908_router"].sort();
    if(value.formatVersion!==2||value.contractKind!=="exact-graph")process.exit(1);
    if(value.deploymentId!=="lk1-train-g2")process.exit(1);
    if(value.sourceSha256!==process.argv[2]||value.candidateSha256!==process.argv[3])process.exit(1);
    if(value.sourceNodeCount!==4815||value.candidateNodeCount!==4815)process.exit(1);
    const changes=Array.isArray(value.allowedChanges)?value.allowedChanges:null;
    if(!changes||changes.length!==3)process.exit(1);
    if(JSON.stringify(changes.map((row)=>row.id).sort())!==JSON.stringify(expected))process.exit(1);
    for(const row of changes){if(JSON.stringify(row.fields)!==JSON.stringify(["func"]))process.exit(1);}
    if((value.allowedAdditions||[]).length!==0)process.exit(1);
  ' "$contract_file" "$preimage_flow_sha" "$candidate_flow_sha"

  node "$g2_postcheck" "$candidate_flow"
}

if [[ "$dry_run" == "1" ]]; then
  # ---- documented dry-run: pinned G1 postimage only, no 147 contact ----
  snapshot_path="$snapshot_arg"
  if [[ -z "$snapshot_path" ]]; then snapshot_path="${NODE_RED_LK1_TRAIN_147_G1_POSTIMAGE:-}"; fi
  if [[ ! -f "$snapshot_path" ]]; then
    echo "Pinned G1 postimage is absent: $snapshot_path (compose it from the read-only snapshot with scripts/patch_live_lk1_train_g1_20261005.mjs --mode generation, or pass --snapshot)" >&2
    exit 4
  fi
  if [[ "$(sha256_file "$snapshot_path")" != "$preimage_flow_sha" ]]; then
    echo "Pinned snapshot is not G1's reviewed postimage: $(sha256_file "$snapshot_path")" >&2
    exit 4
  fi
  stage_pinned_workspace "$snapshot_path" "$workspace"
  compose_and_validate
  echo "dryRun=1"
  echo "mode=generation"
  echo "preimageFlowSha256=$preimage_flow_sha"
  echo "candidateFlowSha256=$candidate_flow_sha"
  echo "sourceNodeCount=$source_node_count"
  echo "changedNodeCount=$expected_changed_nodes"
  echo "changedNodes=$evaluator_id:func,$evaluate_id:func,$router_id:func"
  echo "postcheck=composed-candidate-markers"
  completed=1
  exit 0
fi

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

wait_for_soak_lease "lk1-train-g1"
pull_live_workspace
if [[ "$(sha256_file "$source_flow")" != "$preimage_flow_sha" ]]; then
  echo "Installed flow is not G1's reviewed postimage; G2 refuses to stack on any other flow" >&2
  exit 4
fi
compose_and_validate

remote_ssh "test ! -e '$remote_stage' && install -d -m 700 '$remote_stage'"
remote_stage_created=1
remote_scp_to "$candidate_flow" "$host:$remote_candidate"
remote_scp_to "$contract_file" "$host:$remote_contract"
remote_scp_to "$g2_postcheck" "$host:$remote_postcheck"
remote_scp_to \
  scripts/nodered_reviewed_flow_deploy/runtime_contract.mjs \
  scripts/nodered_reviewed_flow_deploy/deploy_reviewed_flow_147_remote.mjs \
  "$host:$remote_stage/"
remote_ssh "chmod 600 '$remote_candidate' '$remote_contract' '$remote_postcheck'; chmod 700 '$remote_helper'"

remote_ssh_capture "$preflight_result" \
  "node '$remote_helper' preflight --candidate '$remote_candidate' --contract '$remote_contract' --deployment-id '$deployment_id'"
node -e '
  const fs=require("node:fs");
  const value=JSON.parse(fs.readFileSync(process.argv[1],"utf8"));
  if(!value.ok||value.action!=="preflight"||value.sourceSha256!==process.argv[2]
    ||value.candidateSha256!==process.argv[3]||value.changedNodeCount!==3
    ||value.addedNodeCount!==0||String(value.nodeCount)!=="4815"
    ||String(value.candidateNodeCount)!=="4815")process.exit(1);
' "$preflight_result" "$preimage_flow_sha" "$candidate_flow_sha"

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
  const fs=require("node:fs");
  const value=JSON.parse(fs.readFileSync(process.argv[1],"utf8"));
  if(!value.ok||value.action!=="apply"||value.sourceSha256!==process.argv[2]
    ||value.activeFlowSha256!==process.argv[3]||value.flowBackup!==process.argv[4]
    ||value.contractBackup!==process.argv[5])process.exit(1);
' "$apply_result" "$preimage_flow_sha" "$candidate_flow_sha" "$remote_flow_backup" "$remote_contract_backup"

remote_ssh_capture "$stage_root/readback.txt" "sha256sum '$remote_live_flow' | cut -d' ' -f1"
installed_sha="$(tr -d '\n' < "$stage_root/readback.txt")"
if [[ "$installed_sha" != "$candidate_flow_sha" ]]; then
  echo "Installed flow readback does not match the G2 candidate; roll G2 back first" >&2
  exit 5
fi
if ! remote_ssh "node '$remote_postcheck' '$remote_live_flow'"; then
  echo "Installed content nodes do not carry the reviewed G2 contour; roll G2 back first" >&2
  exit 7
fi

plan_rules_errors_after="$(remote_ssh "grep -hE '$plan_rules_error_pattern' /root/.pm2/logs/*node-red*.log 2>/dev/null | wc -l" | tr -d "[:space:]")"
plan_rules_errors_after="${plan_rules_errors_after:-0}"
echo "planRulesErrorsAfter=$plan_rules_errors_after"
if [[ "$plan_rules_errors_after" -gt "$plan_rules_errors_before" ]]; then
  echo "The G2 restart logged a plan-rules mismatch; roll G2 back first, then inspect the G1 global" >&2
  ssh "${ssh_opts[@]}" "$host" "tail -n 200 /root/.pm2/logs/*node-red*.log 2>/dev/null | grep -E '$plan_rules_error_pattern' | tail -3" >&2 || true
  exit 8
fi

smoke_ok=0
for ((smoke_attempt = 1; smoke_attempt <= 30; smoke_attempt++)); do
  if curl -sS --max-time 15 -o "$postcheck_result" -w '%{http_code}' "$smoke_url" > "$stage_root/smoke.status" \
    && [[ "$(tr -d '\n' < "$stage_root/smoke.status")" == "200" ]] \
    && node -e '
        const fs=require("node:fs");
        const value=JSON.parse(fs.readFileSync(process.argv[1],"utf8"));
        if(!value||typeof value!=="object"||Array.isArray(value)
          ||value.currency!=="RUB"||typeof value.pricingMode!=="string")process.exit(1);
      ' "$postcheck_result"; then
    smoke_ok=1
    break
  fi
  sleep 3
done
if [[ "$smoke_ok" != "1" ]]; then
  echo "LK backend smoke check failed after the warm-up budget; roll G2 back first" >&2
  exit 6
fi

completed=1
echo "deployedGitSha=$local_sha"
echo "sourceFlowSha256=$preimage_flow_sha"
echo "activeFlowSha256=$candidate_flow_sha"
echo "installedFlowReadbackSha256=$installed_sha"
echo "sourceNodeCount=$source_node_count"
echo "changedNodeCount=$expected_changed_nodes"
echo "changedNodes=$evaluator_id:func,$evaluate_id:func,$router_id:func"
echo "planRulesErrorsBefore=$plan_rules_errors_before"
echo "planRulesErrorsAfter=$plan_rules_errors_after"
echo "flowBackup=$remote_flow_backup"
echo "contractBackup=$remote_contract_backup"
echo "smokeUrl=$smoke_url"
echo "rollbackHint=NODE_RED_LK1_TRAIN_G2_ROLLBACK=CONFIRM_147 npm run nodered:lk1-train-g2:rollback-147 -- $remote_stamp"
