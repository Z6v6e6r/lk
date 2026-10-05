#!/usr/bin/env bash

# Guarded deployment of G1 of the 2026-10-05 LK1 train (server 147).
#
# G1 changes exactly two fields of the booking gateway
# (`lk_subscription_booking_router_20260804.func` + `.initialize`):
#   * `func` — the reviewed court-window proof (`lk1CourtMasterServices`,
#     `hourlyCourtPriceMinor`, `LK1_COURT_PRICE_UNRESOLVED`), the #174 club gate widened to
#     `open_game`, the Patriots money-only identity guard, the reviewed club money mandate
#     (`COURT_HOURLY_COPAY` spliced into `lk1ClubEventPaymentBinding`) and the two reviewed
#     allowance deltas; the court dispatch runs after the target's station and room are assigned;
#   * `initialize` — the plan-rules writer replaced by the guarded
#     `friendship_two_hours -> patriots` transition (9 rules -> 10 rules).
#
# The reviewed preimage is the read-only 2026-10-05 snapshot of lk-primary-147
# (`7e8a9570…`, 4815 nodes); the composed candidate is `99b5d5b5…`. G1 is followed by G2
# (`nodered:lk1-train-g2:deploy-147`) immediately after — G2 refuses any flow other than G1's
# postimage. The shared reviewed-flow soak lease is the only pacing between the two applies: the
# runtime refuses a second preflight/apply until G1's 15-minute lease expires, so "immediately"
# means the first apply the runtime accepts, with the installed sha still exactly G1's postimage.
#
# Rollback is ORDERED and is NOT a plain restore: the plan-rules global must go back to the
# installed nine-rule payload first (`nodered:lk1-train-g1:rollback-147 -- <stamp>`), and only then
# is the preimage flow restored. The reverse order would leave the global naming the Patriots
# product while the restored gateway has no Patriots money guard.
#
# Requires an explicit confirmation variable, a clean main checkout equal to origin/main and the
# exact upstream preimage. Everything else fails closed. The `--dry-run` path never contacts 147:
# it composes and validates the candidate/contract against the pinned local snapshot only.

set -euo pipefail
umask 077

usage() {
  echo "Usage: NODE_RED_LK1_TRAIN_G1_DEPLOY=CONFIRM_147 npm run nodered:lk1-train-g1:deploy-147" >&2
  echo "       NODE_RED_LK1_TRAIN_G1_DEPLOY=CONFIRM_147 bash scripts/deploy_nodered_lk1_train_g1_147.sh --dry-run [--snapshot /absolute/pinned/source.flow.json]" >&2
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

if [[ "${NODE_RED_LK1_TRAIN_G1_DEPLOY:-}" != "CONFIRM_147" ]]; then
  usage
  exit 2
fi

host="lk-primary-147"
deployment_id="lk1-train-g1"
allow_nodes=(lk_subscription_booking_router_20260804)
expected_changed_nodes=1
allow_changes=("lk_subscription_booking_router_20260804:func,initialize")
expected_node_fields='{"lk_subscription_booking_router_20260804":["func","initialize"]}'
gateway_id="lk_subscription_booking_router_20260804"
preimage_flow_sha="7e8a9570dbc8b7cfabe3340c81a9274e407f9fbc1de2d9e963f92db67ae32ff1"
candidate_flow_sha="99b5d5b5c2617e77f654c68ac12c9d7f834e0a65334feb1d9b12dc5a6d267ba3"
source_node_count=4815
preimage_node_sha="f3e1b807a13b1d404a8ecf5119c9cb03c63217f64986201c4e52440d4a0f107b"
postimage_node_sha="d4d84655a24c6dd79c64501ff7359c4a56f86f88d28d80f60d9ccf61d022aea0"
gateway_func_before_sha="21c50a8d4240060f4e491f42526c14a2586b0fbf2edf2c324a97a946e9176cc2"
gateway_func_after_sha="7f1539bfbeb6ba9ed3a068e6706ca7af23454f29e28055d5fade8f538d00f0d4"
gateway_initialize_before_sha="d7aec140d29a33411e416f05652aa09f23f2f436a491d76827afb3b17282f7a5"
gateway_initialize_after_sha="283f9e8a3468e8e4ebad56e479aacd13084a60006783b55e578c3c36fe8847d3"
allowance_before_sha="a3fc39f013d0380d16466fe140061042e0bb307fac14315086b765cfc1f1adf1"
allowance_after_sha="2916f13c5987a6d056d198ab539ccff6127f43d875c8ae9c0328d03187dbc813"
patriots_product_id="37ab3713-4431-4815-96ba-d7ece76a9241"
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

# A local workspace that satisfies verify_nodered_source_origin.mjs byte-for-byte, built from the
# pinned read-only snapshot. Used only by `--dry-run`; the real path pulls through the repo script.
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

write_gateway_postcheck() {
  local out="$1"
  cat > "$out" <<'CJS'
const crypto = require("node:crypto");
const fs = require("node:fs");
const flow = JSON.parse(fs.readFileSync(process.argv[2], "utf8"));
const gateway = flow.find((node) => node.id === "lk_subscription_booking_router_20260804") || {};
const func = typeof gateway.func === "string" ? gateway.func : "";
const init = typeof gateway.initialize === "string" ? gateway.initialize : "";
const hash = (value) => crypto.createHash("sha256").update(value).digest("hex");
if (hash(func) !== "7f1539bfbeb6ba9ed3a068e6706ca7af23454f29e28055d5fade8f538d00f0d4") process.exit(1);
const wanted = ["lk1CourtMasterServices", "lk1CourtWindowNeeded", "hourlyCourtPriceMinor",
  "[\"group_training\", \"open_game\"]", "patriotsMoneyOnlyIdentity",
  "operation.lk1.decision.courtMinutes"];
if (!wanted.every((marker) => func.includes(marker))) process.exit(1);
// Step-1 postcheck 3 (F1/F5): the club money mandate must live INSIDE the installed
// lk1ClubEventPaymentBinding definition — a marker anywhere else in the function must not pass.
const bindingStart = "const lk1ClubEventPaymentBinding = (ctx, quote = ctx.lk1) => {";
const bindingEnd = "\n};\n";
const bindingAt = func.indexOf(bindingStart);
if (bindingAt < 0 || func.indexOf(bindingStart, bindingAt + 1) >= 0) process.exit(1);
const bindingClose = func.indexOf(bindingEnd, bindingAt + bindingStart.length);
if (bindingClose < 0) process.exit(1);
const binding = func.slice(bindingAt, bindingClose + bindingEnd.length);
if (func.split("COURT_HOURLY_COPAY").length !== 2) process.exit(1);
if (!binding.includes("if (decision.benefit?.kind === \"COURT_HOURLY_COPAY\")")) process.exit(1);
if (!binding.includes("perHour === Math.floor(hourly / 4)")) process.exit(1);
// The installed body must still carry the quote resolver and its five call sites exactly.
if (func.split("const lk1EventPaymentQuoteBinding = (ctx, quote = ctx.lk1) =>").length !== 2) process.exit(1);
if (func.split("lk1EventPaymentQuoteBinding(").length !== 6) process.exit(1);
// Step-1 postcheck 4 (F2/F5): the dispatch runs after the target's station AND room are assigned,
// so the stored proof binds a non-null station/room instead of refusing LK1_COURT_PRICE_UNRESOLVED.
const stationAt = func.indexOf("      ctx.studioId = quote.target.stationId;\n");
const roomAt = func.indexOf("      ctx.roomId = quote.target.roomId;\n");
const dispatchAt = func.indexOf("      if (lk1CourtWindowNeeded(ctx)) ctx.lk1CourtExercise = exercise;\n");
if (!(stationAt >= 0 && stationAt < roomAt && roomAt < dispatchAt)) process.exit(1);
if (init.split("\"planKey\":\"patriots\"").length !== 2) process.exit(1);
if (!init.includes("\"planKey\":\"topocraty\"")) process.exit(1);
if (!init.includes("\"planKey\":\"friendship_two_hours\"")) process.exit(1);
CJS
  chmod 600 "$out"
}

node -e '
  const expected=JSON.parse(process.argv[1]);
  const nodes=process.argv.slice(2).sort();
  if (JSON.stringify(Object.keys(expected).sort()) !== JSON.stringify(nodes)) process.exit(1);
' "$expected_node_fields" "${allow_nodes[@]}"

stage_root="$(mktemp -d "$(local_tmp_root)/padlhub-lk1-train-g1-deploy.XXXXXX")"
ssh_control_root="$(mktemp -d "$(local_tmp_root)/lk1tg1.XXXXXX")"
workspace="$stage_root/live"
candidate_dir="$stage_root/candidate"
source_flow="$workspace/input/source.flow.json"
candidate_flow="$candidate_dir/candidate.flow.json"
candidate_report="$candidate_dir/report.json"
contract_file="$candidate_dir/contract.json"
gateway_postcheck="$candidate_dir/gateway-postcheck.cjs"
preflight_result="$stage_root/preflight.json"
apply_result="$stage_root/apply.json"
postcheck_result="$stage_root/postcheck.json"
remote_stamp="$(date '+%Y%m%dT%H%M%S%z')"
remote_stage="/root/.node-red/.padlhub-reviewed-flow-stage-$remote_stamp-$$"
remote_candidate="$remote_stage/candidate.flow.json"
remote_contract="$remote_stage/contract.json"
remote_helper="$remote_stage/deploy_reviewed_flow_147_remote.mjs"
remote_runtime="$remote_stage/runtime_contract.mjs"
remote_postcheck="$remote_stage/gateway-postcheck.cjs"
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
ssh_retry_attempts="${NODE_RED_LK1_TRAIN_G1_SSH_ATTEMPTS:-5}"
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

# The shared compose -> report -> exact-graph contract discipline. Used identically by the
# dry-run and the live path; it never touches 147.
compose_and_validate() {
  mkdir -m 700 "$candidate_dir"
  write_gateway_postcheck "$gateway_postcheck"
  node scripts/patch_live_lk1_train_g1_20261005.mjs \
    --mode generation \
    --workspace "$workspace" \
    --output "$candidate_flow" \
    --report "$candidate_report" >/dev/null

  node -e '
    const fs=require("node:fs");
    const value=JSON.parse(fs.readFileSync(process.argv[1],"utf8"));
    const gate="lk_subscription_booking_router_20260804";
    const funcBefore="21c50a8d4240060f4e491f42526c14a2586b0fbf2edf2c324a97a946e9176cc2";
    const funcAfter="7f1539bfbeb6ba9ed3a068e6706ca7af23454f29e28055d5fade8f538d00f0d4";
    const initBefore="d7aec140d29a33411e416f05652aa09f23f2f436a491d76827afb3b17282f7a5";
    const initAfter="283f9e8a3468e8e4ebad56e479aacd13084a60006783b55e578c3c36fe8847d3";
    const allowanceBefore="a3fc39f013d0380d16466fe140061042e0bb307fac14315086b765cfc1f1adf1";
    const allowanceAfter="2916f13c5987a6d056d198ab539ccff6127f43d875c8ae9c0328d03187dbc813";
    if(value.kind!=="FOCUSED_LK1_TRAIN_G1_V1"||value.deploymentId!=="lk1-train-g1")process.exit(1);
    if(value.deploymentPerformed!==false||value.liveMutationPerformed!==false)process.exit(1);
    if(value.changedNodeCount!==1||value.expectedChangedNodeCount!==1||value.addedNodeCount!==0)process.exit(1);
    const changes=Array.isArray(value.changes)?value.changes:null;
    if(!changes||changes.length!==1)process.exit(1);
    if(changes[0].id!==gate||JSON.stringify(changes[0].fields)!==JSON.stringify(["func","initialize"]))process.exit(1);
    if(changes[0].func.beforeSha256!==funcBefore||changes[0].func.afterSha256!==funcAfter)process.exit(1);
    if(changes[0].initialize.beforeSha256!==initBefore||changes[0].initialize.afterSha256!==initAfter)process.exit(1);
    if(value.upstreamFlowSha256!==process.argv[2]||value.sourceSha256!==process.argv[2])process.exit(1);
    if(value.candidateSha256!==process.argv[3])process.exit(1);
    if(value.sourceNodeCount!==4815||value.candidateNodeCount!==4815)process.exit(1);
    const t=value.targets&&value.targets.gateway;
    if(!t||t.id!==gate)process.exit(1);
    if(t.func.beforeSha256!==funcBefore||t.func.afterSha256!==funcAfter)process.exit(1);
    if(t.initialize.beforeSha256!==initBefore||t.initialize.afterSha256!==initAfter)process.exit(1);
    const g=value.gateway||{};
    for(const key of ["courtHelpersBound","courtDispatchBound","courtResponseBound","courtQuoteBound","clubGateOpenGame","patriotsMoneyOnlyIdentity","patriotsPlanRule","courtMinutesAccumulated","clubFreeCeiling","clubMoneyMandateBound","clubDispatchAfterTargetIdentity"]){if(g[key]!==true)process.exit(1);}
    if(g.usageBlockBeforeSha256!==allowanceBefore||g.usageBlockSha256!==allowanceAfter)process.exit(1);
    const p=value.planRulesActivation||{};
    if(p.key!=="subscriptions_lk1_plan_rules"||p.expectedPriorRuleCount!==9||p.desiredRuleCount!==10)process.exit(1);
    if(p.patriotsProductId!=="37ab3713-4431-4815-96ba-d7ece76a9241"||p.writerReplaced!==true)process.exit(1);
    if(value.topologyChanged!==false||value.routesChanged!==false||value.policyChanged!==true)process.exit(1);
  ' "$candidate_report" "$preimage_flow_sha" "$candidate_flow_sha"

  if [[ "$(sha256_file "$candidate_flow")" != "$candidate_flow_sha" ]]; then
    echo "Composed candidate is not the reviewed G1 postimage" >&2
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
    const gate="lk_subscription_booking_router_20260804";
    if(value.formatVersion!==2||value.contractKind!=="exact-graph")process.exit(1);
    if(value.deploymentId!=="lk1-train-g1")process.exit(1);
    if(value.sourceSha256!==process.argv[2]||value.candidateSha256!==process.argv[3])process.exit(1);
    if(value.sourceNodeCount!==4815||value.candidateNodeCount!==4815)process.exit(1);
    const changes=Array.isArray(value.allowedChanges)?value.allowedChanges:null;
    if(!changes||changes.length!==1)process.exit(1);
    if(changes[0].id!==gate||JSON.stringify(changes[0].fields)!==JSON.stringify(["func","initialize"]))process.exit(1);
    if(changes[0].sourceNodeSha256!=="f3e1b807a13b1d404a8ecf5119c9cb03c63217f64986201c4e52440d4a0f107b")process.exit(1);
    if(changes[0].candidateNodeSha256!=="d4d84655a24c6dd79c64501ff7359c4a56f86f88d28d80f60d9ccf61d022aea0")process.exit(1);
    if((value.allowedAdditions||[]).length!==0)process.exit(1);
  ' "$contract_file" "$preimage_flow_sha" "$candidate_flow_sha"

  node "$gateway_postcheck" "$candidate_flow"
}

if [[ "$dry_run" == "1" ]]; then
  # ---- documented dry-run: pinned snapshot only, no 147 contact, no write outside the stage ----
  snapshot_path="$snapshot_arg"
  if [[ -z "$snapshot_path" ]]; then snapshot_path="${NODE_RED_LK1_TRAIN_147_PREIMAGE:-}"; fi
  if [[ -z "$snapshot_path" ]]; then snapshot_path="/private/tmp/lk1-train-147-prep/input/source.flow.json"; fi
  if [[ ! -f "$snapshot_path" ]]; then
    echo "Pinned snapshot is absent: $snapshot_path (pull it read-only with npm run nodered:modular:pull-147, or pass --snapshot)" >&2
    exit 4
  fi
  if [[ "$(sha256_file "$snapshot_path")" != "$preimage_flow_sha" ]]; then
    echo "Pinned snapshot is not the reviewed G1 preimage: $(sha256_file "$snapshot_path")" >&2
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
  echo "changedNodes=$gateway_id:func,initialize"
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

pull_live_workspace
if [[ "$(sha256_file "$source_flow")" != "$preimage_flow_sha" ]]; then
  echo "Live flow is not the reviewed G1 preimage; the train refuses any other flow" >&2
  exit 4
fi
compose_and_validate

remote_ssh "test ! -e '$remote_stage' && install -d -m 700 '$remote_stage'"
remote_stage_created=1
remote_scp_to "$candidate_flow" "$host:$remote_candidate"
remote_scp_to "$contract_file" "$host:$remote_contract"
remote_scp_to "$gateway_postcheck" "$host:$remote_postcheck"
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
    ||value.candidateSha256!==process.argv[3]||value.changedNodeCount!==1
    ||value.addedNodeCount!==0||String(value.nodeCount)!=="4815"
    ||String(value.candidateNodeCount)!=="4815")process.exit(1);
' "$preflight_result" "$preimage_flow_sha" "$candidate_flow_sha"

# The plan-rules writer runs inside the gateway initialize on every restart. 147 keeps the
# Node-RED context in memory, so count the writer errors before the apply and require that the
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
  const fs=require("node:fs");
  const value=JSON.parse(fs.readFileSync(process.argv[1],"utf8"));
  if(!value.ok||value.action!=="apply"||value.sourceSha256!==process.argv[2]
    ||value.activeFlowSha256!==process.argv[3]||value.flowBackup!==process.argv[4]
    ||value.contractBackup!==process.argv[5])process.exit(1);
' "$apply_result" "$preimage_flow_sha" "$candidate_flow_sha" "$remote_flow_backup" "$remote_contract_backup"

remote_ssh_capture "$stage_root/readback.txt" "sha256sum '$remote_live_flow' | cut -d' ' -f1"
installed_sha="$(tr -d '\n' < "$stage_root/readback.txt")"
if [[ "$installed_sha" != "$candidate_flow_sha" ]]; then
  echo "Installed flow readback does not match the G1 candidate; ordered rollback required" >&2
  exit 5
fi
if ! remote_ssh "node '$remote_postcheck' '$remote_live_flow'"; then
  echo "Installed gateway body does not carry the reviewed G1 contour; ordered rollback required" >&2
  exit 7
fi

plan_rules_errors_after="$(remote_ssh "grep -hE '$plan_rules_error_pattern' /root/.pm2/logs/*node-red*.log 2>/dev/null | wc -l" | tr -d "[:space:]")"
plan_rules_errors_after="${plan_rules_errors_after:-0}"
echo "planRulesErrorsAfter=$plan_rules_errors_after"
if [[ "$plan_rules_errors_after" -gt "$plan_rules_errors_before" ]]; then
  echo "Gateway initialize failed to write the plan-rules global (writer error in the Node-RED log); ordered rollback required" >&2
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
  echo "LK backend smoke check failed after the warm-up budget; ordered rollback required" >&2
  exit 6
fi

completed=1
echo "deployedGitSha=$local_sha"
echo "sourceFlowSha256=$preimage_flow_sha"
echo "activeFlowSha256=$candidate_flow_sha"
echo "installedFlowReadbackSha256=$installed_sha"
echo "sourceNodeCount=$source_node_count"
echo "changedNodeCount=$expected_changed_nodes"
echo "planRulesPriorRuleCount=9"
echo "planRulesDesiredRuleCount=10"
echo "planRulesErrorsBefore=$plan_rules_errors_before"
echo "planRulesErrorsAfter=$plan_rules_errors_after"
echo "flowBackup=$remote_flow_backup"
echo "contractBackup=$remote_contract_backup"
echo "smokeUrl=$smoke_url"
echo "rollbackOrder=1-plan-rules-global 2-preimage-generation"
echo "nextStep=NODE_RED_LK1_TRAIN_G2_DEPLOY=CONFIRM_147 npm run nodered:lk1-train-g2:deploy-147 (after the G1 soak lease expires)"
echo "rollbackHint=NODE_RED_LK1_TRAIN_G1_ROLLBACK=CONFIRM_147 npm run nodered:lk1-train-g1:rollback-147 -- $remote_stamp"
