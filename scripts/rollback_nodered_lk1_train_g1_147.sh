#!/usr/bin/env bash

# Ordered rollback of G1 of the 2026-10-05 LK1 train (server 147).
#
# The order is not optional. G1 replaced the plan-rules writer with the guarded
# `friendship_two_hours -> patriots` transition, so the runtime global currently names ten rules.
# Restoring the preimage flow first would leave that global naming the Patriots product while the
# restored gateway has no Patriots money guard, so:
#
# Step 1 (this script, first half): import G1's revert candidate `a5a3149f…` — the same G1 bodies
#   with the plan-rules writer replaced by the guarded `patriots -> friendship_two_hours` block —
#   and restart, so the global goes back to the installed nine-rule payload. Readback must be
#   exactly `a5a3149f…` and the installed writer must name nine rules without the Patriots product.
# Step 2 (this script, second half): read back the recorded pre-candidate backup
#   (`flows-pre-lk1-train-g1-<stamp>.json`), require its bytes to be exactly the reviewed preimage
#   `7e8a9570…`, import those bytes and restart. The restored initialize now finds its exact
#   nine-rule prior.
#
# G2 must be rolled back before G1 (`nodered:lk1-train-g2:rollback-147`), because G2's postimage
# stacks on G1's. Requires the explicit confirmation variable, a clean main checkout equal to
# origin/main and the deployment stamp printed by the forward run.
#
# `--dry-run` never contacts 147: it composes the revert candidate from a supplied applied flow,
# extracts exactly the supplied pre-candidate bytes and validates both exact-graph contracts.

set -euo pipefail
umask 077

usage() {
  echo "Usage: NODE_RED_LK1_TRAIN_G1_ROLLBACK=CONFIRM_147 npm run nodered:lk1-train-g1:rollback-147 -- <stamp>" >&2
  echo "       NODE_RED_LK1_TRAIN_G1_ROLLBACK=CONFIRM_147 bash scripts/rollback_nodered_lk1_train_g1_147.sh --dry-run --applied <flow.json> --preimage <flow.json> --restore-out <flow.json> [--stamp <stamp>]" >&2
}

dry_run=0
stamp=""
applied_arg=""
preimage_arg=""
restore_out=""
positionals=()
while [[ $# -gt 0 ]]; do
  case "$1" in
    --dry-run)
      dry_run=1
      shift
      ;;
    --stamp)
      if [[ $# -lt 2 || -z "$2" ]]; then usage; exit 2; fi
      stamp="$2"
      shift 2
      ;;
    --applied)
      if [[ $# -lt 2 || -z "$2" ]]; then usage; exit 2; fi
      applied_arg="$2"
      shift 2
      ;;
    --preimage)
      if [[ $# -lt 2 || -z "$2" ]]; then usage; exit 2; fi
      preimage_arg="$2"
      shift 2
      ;;
    --restore-out)
      if [[ $# -lt 2 || -z "$2" ]]; then usage; exit 2; fi
      restore_out="$2"
      shift 2
      ;;
    -*)
      usage
      exit 2
      ;;
    *)
      positionals+=("$1")
      shift
      ;;
  esac
done

if [[ "${NODE_RED_LK1_TRAIN_G1_ROLLBACK:-}" != "CONFIRM_147" ]]; then
  usage
  exit 2
fi

if [[ "$dry_run" == "0" ]]; then
  if [[ ${#positionals[@]} -ne 1 || -n "$stamp" || -n "$applied_arg" || -n "$preimage_arg" || -n "$restore_out" ]]; then
    usage
    exit 2
  fi
  stamp="${positionals[0]}"
else
  if [[ ${#positionals[@]} -ne 0 ]]; then usage; exit 2; fi
  if [[ -z "$applied_arg" || -z "$preimage_arg" || -z "$restore_out" ]]; then usage; exit 2; fi
  if [[ -z "$stamp" ]]; then stamp="00000000T000000+0000"; fi
fi
if [[ ! "$stamp" =~ ^[0-9]{8}T[0-9]{6}[+-][0-9]{4}$ ]]; then
  echo "Usage: ... rollback-147 -- <stamp>  (the stamp printed by the forward deploy)" >&2
  exit 2
fi

host="lk-primary-147"
deployment_id="lk1-train-g1"
revert_deployment_id="lk1-train-g1-revert"
restore_deployment_id="lk1-train-g1-restore"
allow_nodes=(lk_subscription_booking_router_20260804)
expected_changed_nodes=1
allow_changes=("lk_subscription_booking_router_20260804:initialize")
expected_node_fields='{"lk_subscription_booking_router_20260804":["initialize"]}'
gateway_id="lk_subscription_booking_router_20260804"
applied_flow_sha="fc4a46a6d1cbda022e8d3ce503d019bc4d0d1e366ff44ba53612a0809256efc5"
revert_candidate_sha="a5a3149f351e509e5534a7993f7ebb21991290f64d1159288fe813ba8ff5c2c4"
revert_initialize_sha="2c2c0c89e3562fff985c388d7bbd0f55f9deaf5cc002ae86974ce59f43c6caf1"
preimage_flow_sha="7e8a9570dbc8b7cfabe3340c81a9274e407f9fbc1de2d9e963f92db67ae32ff1"
applied_initialize_sha="283f9e8a3468e8e4ebad56e479aacd13084a60006783b55e578c3c36fe8847d3"
preimage_func_sha="21c50a8d4240060f4e491f42526c14a2586b0fbf2edf2c324a97a946e9176cc2"
preimage_initialize_sha="d7aec140d29a33411e416f05652aa09f23f2f436a491d76827afb3b17282f7a5"
source_node_count=4815
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

write_initialize_postcheck() {
  local out="$1"
  cat > "$out" <<'CJS'
const fs = require("node:fs");
const flow = JSON.parse(fs.readFileSync(process.argv[2], "utf8"));
const gateway = flow.find((node) => node.id === "lk_subscription_booking_router_20260804") || {};
const init = typeof gateway.initialize === "string" ? gateway.initialize : "";
const key = "const lk1DesiredPlanRules = ";
const at = init.indexOf(key);
if (at < 0) process.exit(1);
const desired = JSON.parse(init.slice(at + key.length).split(";\n")[0]);
if (desired.rules.length !== 9) process.exit(1);
if (desired.rules.some((row) => row.productId === "37ab3713-4431-4815-96ba-d7ece76a9241")) process.exit(1);
if (!init.includes("37ab3713-4431-4815-96ba-d7ece76a9241")) process.exit(1);
if (!init.includes("\"planKey\":\"patriots\"")) process.exit(1);
if (!init.includes("\"planKey\":\"friendship_two_hours\"")) process.exit(1);
CJS
  chmod 600 "$out"
}

write_preimage_postcheck() {
  local out="$1"
  cat > "$out" <<'CJS'
const crypto = require("node:crypto");
const fs = require("node:fs");
const flow = JSON.parse(fs.readFileSync(process.argv[2], "utf8"));
if (!Array.isArray(flow) || flow.length !== 4815) process.exit(1);
const gateway = flow.find((node) => node.id === "lk_subscription_booking_router_20260804") || {};
const hash = (value) => crypto.createHash("sha256").update(value).digest("hex");
if (hash(gateway.func) !== "21c50a8d4240060f4e491f42526c14a2586b0fbf2edf2c324a97a946e9176cc2") process.exit(1);
if (hash(gateway.initialize) !== "d7aec140d29a33411e416f05652aa09f23f2f436a491d76827afb3b17282f7a5") process.exit(1);
CJS
  chmod 600 "$out"
}

node -e '
  const expected=JSON.parse(process.argv[1]);
  const nodes=process.argv.slice(2).sort();
  if (JSON.stringify(Object.keys(expected).sort()) !== JSON.stringify(nodes)) process.exit(1);
' "$expected_node_fields" "${allow_nodes[@]}"

stage_root="$(mktemp -d "$(local_tmp_root)/padlhub-lk1-train-g1-rollback.XXXXXX")"
ssh_control_root="$(mktemp -d "$(local_tmp_root)/lk1tg1.XXXXXX")"
workspace="$stage_root/live"
candidate_dir="$stage_root/candidate"
source_flow="$workspace/input/source.flow.json"
revert_flow="$candidate_dir/revert.flow.json"
revert_report="$candidate_dir/revert-report.json"
revert_contract="$candidate_dir/revert-contract.json"
initialize_postcheck="$candidate_dir/initialize-postcheck.cjs"
restore_dir="$stage_root/restore"
restore_candidate="$restore_dir/restore.flow.json"
restore_contract="$restore_dir/restore-contract.json"
preimage_postcheck="$candidate_dir/preimage-postcheck.cjs"
remote_stamp="$(date '+%Y%m%dT%H%M%S%z')"
remote_stage="/root/.node-red/.padlhub-reviewed-flow-stage-$remote_stamp-$$"
remote_candidate="$remote_stage/candidate.flow.json"
remote_contract="$remote_stage/contract.json"
remote_helper="$remote_stage/deploy_reviewed_flow_147_remote.mjs"
remote_runtime="$remote_stage/runtime_contract.mjs"
remote_postcheck="$remote_stage/initialize-postcheck.cjs"
remote_live_flow="/root/.node-red/flows.json"
remote_backup_dir="/root/.node-red/.padlhub-reviewed-flow-backups"
remote_flow_backup="$remote_backup_dir/flows-pre-$deployment_id-$stamp.json"
remote_contract_backup="$remote_backup_dir/contract-$deployment_id-$stamp.json"
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

# The shared reviewed-flow runtime refuses a second apply until the preceding 15-minute soak lease
# expires (docs/NODERED_MODULAR_WORKFLOW.md: "wait for expiry"). The ordered rollback needs two
# applies, so it waits for its own preceding lease instead of deleting or editing it. A lease that
# belongs to another deployment, or one that cannot auto-expire, fails closed.
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
  if [[ "$remote_stage_created" == "1" ]]; then
    ssh "${ssh_opts[@]}" "$host" "rm -f '$remote_candidate' '$remote_contract' '$remote_helper' '$remote_runtime' '$remote_postcheck'; rmdir '$remote_stage' 2>/dev/null || true" >/dev/null 2>&1 || true
    ssh "${ssh_opts[@]}" -O exit "$host" >/dev/null 2>&1 || true
  fi
  rm -f "$ssh_control_root"/c-* 2>/dev/null || true
  rmdir "$ssh_control_root" 2>/dev/null || true
  rm -rf "$stage_root" 2>/dev/null || true
}
trap cleanup EXIT
trap 'exit 130' INT
trap 'exit 143' TERM HUP

# Step 1: compose the plan-rules revert on the exact applied generation and validate it.
compose_and_validate_revert() {
  mkdir -m 700 "$candidate_dir"
  write_initialize_postcheck "$initialize_postcheck"
  node scripts/patch_live_lk1_train_g1_20261005.mjs \
    --mode revert \
    --workspace "$workspace" \
    --output "$revert_flow" \
    --report "$revert_report" >/dev/null

  node -e '
    const fs=require("node:fs");
    const value=JSON.parse(fs.readFileSync(process.argv[1],"utf8"));
    const gate="lk_subscription_booking_router_20260804";
    if(value.kind!=="FOCUSED_LK1_TRAIN_G1_V1"||value.deploymentId!=="lk1-train-g1")process.exit(1);
    if(value.mode!=="revert")process.exit(1);
    if(value.deploymentPerformed!==false||value.liveMutationPerformed!==false)process.exit(1);
    if(value.changedNodeCount!==1||value.expectedChangedNodeCount!==1||value.addedNodeCount!==0)process.exit(1);
    const changes=Array.isArray(value.changes)?value.changes:null;
    if(!changes||changes.length!==1)process.exit(1);
    if(changes[0].id!==gate||JSON.stringify(changes[0].fields)!==JSON.stringify(["initialize"]))process.exit(1);
    if(changes[0].initialize.beforeSha256!==process.argv[2])process.exit(1);
    if(changes[0].initialize.afterSha256!==process.argv[3])process.exit(1);
    if(value.sourceSha256!==process.argv[4]||value.upstreamFlowSha256!==process.argv[4])process.exit(1);
    if(value.candidateSha256!==process.argv[5])process.exit(1);
    if(value.sourceNodeCount!==4815||value.candidateNodeCount!==4815)process.exit(1);
    const p=value.planRulesActivation||{};
    if(p.key!=="subscriptions_lk1_plan_rules"||p.expectedPriorRuleCount!==10||p.desiredRuleCount!==9)process.exit(1);
    if(p.patriotsProductId!=="37ab3713-4431-4815-96ba-d7ece76a9241"||p.writerReplaced!==true)process.exit(1);
    if(p.orderedRollbackStep!==1)process.exit(1);
    if(value.topologyChanged!==false||value.routesChanged!==false||value.policyChanged!==true)process.exit(1);
  ' "$revert_report" "$applied_initialize_sha" "$revert_initialize_sha" "$applied_flow_sha" "$revert_candidate_sha"

  if [[ "$(sha256_file "$revert_flow")" != "$revert_candidate_sha" ]]; then
    echo "Composed revert candidate is not the reviewed G1 revert postimage" >&2
    exit 5
  fi

  node scripts/nodered_reviewed_flow_deploy/prepare_exact_graph_contract.mjs \
    --live "$source_flow" \
    --candidate "$revert_flow" \
    --output "$revert_contract" \
    --deployment-id "$revert_deployment_id" \
    $(printf -- "--allow-change %s " "${allow_changes[@]}") >/dev/null

  node -e '
    const fs=require("node:fs");
    const value=JSON.parse(fs.readFileSync(process.argv[1],"utf8"));
    const gate="lk_subscription_booking_router_20260804";
    if(value.formatVersion!==2||value.contractKind!=="exact-graph")process.exit(1);
    if(value.deploymentId!=="lk1-train-g1-revert")process.exit(1);
    if(value.sourceSha256!==process.argv[2]||value.candidateSha256!==process.argv[3])process.exit(1);
    if(value.sourceNodeCount!==4815||value.candidateNodeCount!==4815)process.exit(1);
    const changes=Array.isArray(value.allowedChanges)?value.allowedChanges:null;
    if(!changes||changes.length!==1)process.exit(1);
    if(changes[0].id!==gate||JSON.stringify(changes[0].fields)!==JSON.stringify(["initialize"]))process.exit(1);
    if((value.allowedAdditions||[]).length!==0)process.exit(1);
  ' "$revert_contract" "$applied_flow_sha" "$revert_candidate_sha"

  node "$initialize_postcheck" "$revert_flow"
}

# Step 2: validate the extracted pre-candidate bytes and the exact-graph contract that restores
# them. `--live` is the just-verified revert bytes on disk, so the contract source is exactly the
# installed state the rollback leaves behind.
compose_and_validate_restore() {
  write_preimage_postcheck "$preimage_postcheck"
  if [[ "$(sha256_file "$restore_candidate")" != "$preimage_flow_sha" ]]; then
    echo "Recorded pre-candidate bytes are not the reviewed G1 preimage; refusing to restore" >&2
    exit 8
  fi
  node "$preimage_postcheck" "$restore_candidate"
  node scripts/nodered_reviewed_flow_deploy/prepare_exact_graph_contract.mjs \
    --live "$revert_flow" \
    --candidate "$restore_candidate" \
    --output "$restore_contract" \
    --deployment-id "$restore_deployment_id" \
    --allow-change "lk_subscription_booking_router_20260804:func,initialize" >/dev/null

  node -e '
    const fs=require("node:fs");
    const value=JSON.parse(fs.readFileSync(process.argv[1],"utf8"));
    const gate="lk_subscription_booking_router_20260804";
    if(value.formatVersion!==2||value.contractKind!=="exact-graph")process.exit(1);
    if(value.deploymentId!=="lk1-train-g1-restore")process.exit(1);
    if(value.sourceSha256!==process.argv[2]||value.candidateSha256!==process.argv[3])process.exit(1);
    if(value.sourceNodeCount!==4815||value.candidateNodeCount!==4815)process.exit(1);
    const changes=Array.isArray(value.allowedChanges)?value.allowedChanges:null;
    if(!changes||changes.length!==1)process.exit(1);
    if(changes[0].id!==gate||JSON.stringify(changes[0].fields)!==JSON.stringify(["func","initialize"]))process.exit(1);
    if((value.allowedAdditions||[]).length!==0)process.exit(1);
  ' "$restore_contract" "$revert_candidate_sha" "$preimage_flow_sha"
}

if [[ "$dry_run" == "1" ]]; then
  # ---- documented dry-run: supplied snapshot pair only, no 147 contact ----
  if [[ ! -f "$applied_arg" || ! -f "$preimage_arg" ]]; then
    echo "Dry-run requires existing --applied and --preimage files" >&2
    exit 4
  fi
  case "$restore_out" in
    /*) ;;
    *) echo "--restore-out must be an absolute path" >&2; exit 2 ;;
  esac
  if [[ -e "$restore_out" ]]; then
    echo "Refusing to overwrite --restore-out: $restore_out" >&2
    exit 2
  fi
  if [[ "$(sha256_file "$applied_arg")" != "$applied_flow_sha" ]]; then
    echo "Dry-run --applied is not the applied G1 generation: $(sha256_file "$applied_arg")" >&2
    exit 4
  fi
  if [[ "$(sha256_file "$preimage_arg")" != "$preimage_flow_sha" ]]; then
    echo "Dry-run --preimage is not the reviewed G1 preimage: $(sha256_file "$preimage_arg")" >&2
    exit 4
  fi
  stage_pinned_workspace "$applied_arg" "$workspace"
  compose_and_validate_revert
  mkdir -m 700 "$restore_dir"
  cp "$preimage_arg" "$restore_candidate"
  chmod 600 "$restore_candidate"
  compose_and_validate_restore
  cp "$restore_candidate" "$restore_out"
  chmod 600 "$restore_out"
  echo "dryRun=1"
  echo "mode=ordered-rollback"
  echo "appliedFlowSha256=$applied_flow_sha"
  echo "revertFlowSha256=$revert_candidate_sha"
  echo "revertInitializeSha256=$revert_initialize_sha"
  echo "restoreSource=recorded-pre-candidate-bytes"
  echo "restoredPreimageSha256=$preimage_flow_sha"
  echo "restoreFlowPath=$restore_out"
  exit 0
fi

remote_ssh "test -s '$remote_flow_backup' && test -s '$remote_contract_backup'"

if [[ "$(git branch --show-current)" != "main" || -n "$(git status --porcelain)" ]]; then
  echo "Rollback requires a clean main checkout" >&2
  exit 3
fi
git fetch --quiet origin main
if [[ "$(git rev-parse HEAD)" != "$(git rev-parse origin/main)" ]]; then
  echo "Local main and origin/main differ" >&2
  exit 4
fi

# ---------------------------------------------------------------- step 1: the global
wait_for_soak_lease "$deployment_id"
pull_live_workspace
if [[ "$(sha256_file "$source_flow")" != "$applied_flow_sha" ]]; then
  echo "Live flow is not the applied G1 generation; ordered rollback cannot start" >&2
  exit 5
fi
compose_and_validate_revert

remote_ssh "test ! -e '$remote_stage' && install -d -m 700 '$remote_stage'"
remote_stage_created=1
remote_scp_to "$revert_flow" "$host:$remote_candidate"
remote_scp_to "$revert_contract" "$host:$remote_contract"
remote_scp_to "$initialize_postcheck" "$host:$remote_postcheck"
remote_scp_to \
  scripts/nodered_reviewed_flow_deploy/runtime_contract.mjs \
  scripts/nodered_reviewed_flow_deploy/deploy_reviewed_flow_147_remote.mjs \
  "$host:$remote_stage/"
remote_ssh "chmod 600 '$remote_candidate' '$remote_contract' '$remote_postcheck'; chmod 700 '$remote_helper'"

remote_ssh_capture "$stage_root/revert-preflight.json" \
  "node '$remote_helper' preflight --candidate '$remote_candidate' --contract '$remote_contract' --deployment-id '$revert_deployment_id'"
node -e '
  const fs=require("node:fs");
  const value=JSON.parse(fs.readFileSync(process.argv[1],"utf8"));
  if(!value.ok||value.action!=="preflight"||value.sourceSha256!==process.argv[2]
    ||value.candidateSha256!==process.argv[3]||value.changedNodeCount!==1
    ||value.addedNodeCount!==0)process.exit(1);
' "$stage_root/revert-preflight.json" "$applied_flow_sha" "$revert_candidate_sha"

# The revert writer runs inside the gateway initialize on every restart; require that its restart
# adds no `plan rules prior mismatch` / `plan rules readback mismatch` line.
plan_rules_error_pattern='plan rules prior mismatch|plan rules readback mismatch'
plan_rules_errors_before="$(remote_ssh "grep -hE '$plan_rules_error_pattern' /root/.pm2/logs/*node-red*.log 2>/dev/null | wc -l" | tr -d "[:space:]")"
plan_rules_errors_before="${plan_rules_errors_before:-0}"
echo "step1PlanRulesErrorsBefore=$plan_rules_errors_before"

ssh "${ssh_opts[@]}" "$host" "node '$remote_helper' apply --candidate '$remote_candidate' --contract '$remote_contract' --deployment-id '$revert_deployment_id' --stamp '$remote_stamp'" >"$stage_root/revert-apply.json"
node -e '
  const fs=require("node:fs");
  const value=JSON.parse(fs.readFileSync(process.argv[1],"utf8"));
  if(!value.ok||value.action!=="apply"||value.activeFlowSha256!==process.argv[2])process.exit(1);
' "$stage_root/revert-apply.json" "$revert_candidate_sha"
remote_ssh_capture "$stage_root/revert-readback.txt" "sha256sum '$remote_live_flow' | cut -d' ' -f1"
if [[ "$(tr -d '\n' < "$stage_root/revert-readback.txt")" != "$revert_candidate_sha" ]]; then
  echo "Revert readback mismatch: the plan-rules global was not restored; stop and inspect" >&2
  exit 6
fi
if ! remote_ssh "node '$remote_postcheck' '$remote_live_flow'"; then
  echo "Installed initialize does not carry the nine-rule revert writer; stop and inspect" >&2
  exit 7
fi
plan_rules_errors_after="$(remote_ssh "grep -hE '$plan_rules_error_pattern' /root/.pm2/logs/*node-red*.log 2>/dev/null | wc -l" | tr -d "[:space:]")"
plan_rules_errors_after="${plan_rules_errors_after:-0}"
if [[ "$plan_rules_errors_after" -gt "$plan_rules_errors_before" ]]; then
  echo "The revert restart logged a plan-rules mismatch; the global was not restored, stop and inspect" >&2
  exit 8
fi
echo "step1PlanRulesGlobal=restored(9 rules)"

# ------------------------------------------------------- step 2: the preimage flow
mkdir -m 700 "$restore_dir"
remote_ssh_capture "$restore_candidate" "cat '$remote_flow_backup'"
compose_and_validate_restore
wait_for_soak_lease "$revert_deployment_id"

remote_scp_to "$restore_candidate" "$host:$remote_candidate"
remote_scp_to "$restore_contract" "$host:$remote_contract"
remote_ssh "chmod 600 '$remote_candidate' '$remote_contract'"
remote_ssh_capture "$stage_root/restore-preflight.json" \
  "node '$remote_helper' preflight --candidate '$remote_candidate' --contract '$remote_contract' --deployment-id '$restore_deployment_id'"
node -e '
  const fs=require("node:fs");
  const value=JSON.parse(fs.readFileSync(process.argv[1],"utf8"));
  if(!value.ok||value.action!=="preflight"||value.sourceSha256!==process.argv[2]
    ||value.candidateSha256!==process.argv[3]||value.changedNodeCount!==1
    ||value.addedNodeCount!==0)process.exit(1);
' "$stage_root/restore-preflight.json" "$revert_candidate_sha" "$preimage_flow_sha"

ssh "${ssh_opts[@]}" "$host" "node '$remote_helper' apply --candidate '$remote_candidate' --contract '$remote_contract' --deployment-id '$restore_deployment_id' --stamp '$remote_stamp'" >"$stage_root/restore-apply.json"
node -e '
  const fs=require("node:fs");
  const value=JSON.parse(fs.readFileSync(process.argv[1],"utf8"));
  if(!value.ok||value.action!=="apply"||value.activeFlowSha256!==process.argv[2])process.exit(1);
' "$stage_root/restore-apply.json" "$preimage_flow_sha"
remote_ssh_capture "$stage_root/restore-readback.txt" "sha256sum '$remote_live_flow' | cut -d' ' -f1"
if [[ "$(tr -d '\n' < "$stage_root/restore-readback.txt")" != "$preimage_flow_sha" ]]; then
  echo "Restore readback mismatch; stop and inspect" >&2
  exit 9
fi
remote_ssh_capture "$stage_root/restored.flow.json" "cat '$remote_live_flow'"
if ! node "$preimage_postcheck" "$stage_root/restored.flow.json"; then
  echo "Restored flow is not the reviewed G1 preimage; stop and inspect" >&2
  exit 9
fi
plan_rules_errors_restore="$(remote_ssh "grep -hE '$plan_rules_error_pattern' /root/.pm2/logs/*node-red*.log 2>/dev/null | wc -l" | tr -d "[:space:]")"
plan_rules_errors_restore="${plan_rules_errors_restore:-0}"
if [[ "$plan_rules_errors_restore" -gt "$plan_rules_errors_after" ]]; then
  echo "The restore restart logged a plan-rules mismatch; the preimage writer found the wrong prior, stop and inspect" >&2
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
