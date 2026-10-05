#!/usr/bin/env bash

# Guarded rollback of G2 of the 2026-10-05 LK1 train (server 147).
#
# G2 is the top of the stack, so its rollback is a single restore: read back the recorded
# pre-candidate backup (`flows-pre-lk1-train-g2-<stamp>.json`, written by the forward G2 deploy),
# require its bytes to be exactly G1's postimage `99b5d5b5…`, import those bytes and restart. The
# restored G1 postimage keeps the Patriots plan-rules writer, so the runtime global (ten rules from
# G1) stays exactly consistent; G1 itself is then rolled back separately with the ordered
# `nodered:lk1-train-g1:rollback-147`, which reverts the plan-rules global first.
#
# The shared reviewed-flow runtime refuses the apply while G2's 15-minute soak lease is active
# (docs/NODERED_MODULAR_WORKFLOW.md: "wait for expiry"); this wrapper waits it out instead of
# deleting or editing it. Requires the explicit confirmation variable, a clean main checkout equal
# to origin/main and the deployment stamp printed by the forward run.
#
# `--dry-run` never contacts 147: it validates the exact-graph contract and extracts exactly the
# supplied pre-candidate bytes.

set -euo pipefail
umask 077

usage() {
  echo "Usage: NODE_RED_LK1_TRAIN_G2_ROLLBACK=CONFIRM_147 npm run nodered:lk1-train-g2:rollback-147 -- <stamp>" >&2
  echo "       NODE_RED_LK1_TRAIN_G2_ROLLBACK=CONFIRM_147 bash scripts/rollback_nodered_lk1_train_g2_147.sh --dry-run --applied <flow.json> --preimage <flow.json> --restore-out <flow.json> [--stamp <stamp>]" >&2
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

if [[ "${NODE_RED_LK1_TRAIN_G2_ROLLBACK:-}" != "CONFIRM_147" ]]; then
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
deployment_id="lk1-train-g2"
restore_deployment_id="lk1-train-g2-restore"
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
applied_flow_sha="0f95fbd3f050d45173c8f2642a4b0dc34ec1fea0384933473ed3b70750777192"
preimage_flow_sha="99b5d5b5c2617e77f654c68ac12c9d7f834e0a65334feb1d9b12dc5a6d267ba3"
source_node_count=4815
evaluator_func_applied_sha="e876ba0722e09798f5f065d1c3bf55ae6df408b84a78f56345f011bbf419f5e1"
evaluator_func_preimage_sha="2d3f5b5080152c07ace9e4aaf31e7b0280878576c027ca7f5c30dd15d9b45602"
router_func_applied_sha="0f2e528de34f4b7ebf134ac219743b02905585cb74779f91863a8d2806d44221"
router_func_preimage_sha="43c21f70844b795a4f53af43d1c9e18afaff34ff243690d74ef260cec39c9a70"
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

write_restore_postcheck() {
  local out="$1"
  cat > "$out" <<'CJS'
const crypto = require("node:crypto");
const fs = require("node:fs");
const flow = JSON.parse(fs.readFileSync(process.argv[2], "utf8"));
const node = (id) => flow.find((row) => row.id === id) || {};
const func = (id) => {
  const value = node(id).func;
  return typeof value === "string" ? value : "";
};
const hash = (value) => crypto.createHash("sha256").update(value).digest("hex");
if (hash(func("lk_subscription_managed_policy_20260820")) !== "2d3f5b5080152c07ace9e4aaf31e7b0280878576c027ca7f5c30dd15d9b45602") process.exit(1);
if (hash(func("lk_subscription_price_preview_20260908_evaluate")) !== "2d3f5b5080152c07ace9e4aaf31e7b0280878576c027ca7f5c30dd15d9b45602") process.exit(1);
if (hash(func("lk_subscription_price_preview_20260908_router")) !== "43c21f70844b795a4f53af43d1c9e18afaff34ff243690d74ef260cec39c9a70") process.exit(1);
// The restored generation is G1's postimage: its gateway body and plan-rules writer must be
// exactly G1's, or the G1 ordered rollback would run against the wrong prior.
if (hash(func("lk_subscription_booking_router_20260804")) !== "7f1539bfbeb6ba9ed3a068e6706ca7af23454f29e28055d5fade8f538d00f0d4") process.exit(1);
const initValue = node("lk_subscription_booking_router_20260804").initialize;
const init = typeof initValue === "string" ? initValue : "";
if (hash(init) !== "283f9e8a3468e8e4ebad56e479aacd13084a60006783b55e578c3c36fe8847d3") process.exit(1);
if (!init.includes("\"planKey\":\"patriots\"")) process.exit(1);
const key = "const lk1DesiredPlanRules = ";
const at = init.indexOf(key);
if (at < 0) process.exit(1);
const desired = JSON.parse(init.slice(at + key.length).split(";\n")[0]);
if (desired.rules.length !== 10) process.exit(1);
CJS
  chmod 600 "$out"
}

node -e '
  const expected=JSON.parse(process.argv[1]);
  const nodes=process.argv.slice(2).sort();
  if (JSON.stringify(Object.keys(expected).sort()) !== JSON.stringify(nodes)) process.exit(1);
' "$expected_node_fields" "${allow_nodes[@]}"

stage_root="$(mktemp -d "$(local_tmp_root)/padlhub-lk1-train-g2-rollback.XXXXXX")"
ssh_control_root="$(mktemp -d "$(local_tmp_root)/lk1tg2.XXXXXX")"
workspace="$stage_root/live"
restore_dir="$stage_root/restore"
source_flow="$workspace/input/source.flow.json"
restore_candidate="$restore_dir/restore.flow.json"
restore_contract="$restore_dir/restore-contract.json"
restore_postcheck="$restore_dir/restore-postcheck.cjs"
restore_preflight="$restore_dir/restore-preflight.json"
restore_apply="$restore_dir/restore-apply.json"
restore_readback="$restore_dir/restore-readback.txt"
remote_stamp="$(date '+%Y%m%dT%H%M%S%z')"
remote_stage="/root/.node-red/.padlhub-reviewed-flow-stage-$remote_stamp-$$"
remote_candidate="$remote_stage/candidate.flow.json"
remote_contract="$remote_stage/contract.json"
remote_helper="$remote_stage/deploy_reviewed_flow_147_remote.mjs"
remote_runtime="$remote_stage/runtime_contract.mjs"
remote_postcheck="$remote_stage/restore-postcheck.cjs"
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

# The recorded pre-candidate bytes must be exactly G1's postimage, and the exact-graph contract
# must restore them from the applied G2 postimage. `--live` is the pulled G2 postimage.
compose_and_validate_restore() {
  write_restore_postcheck "$restore_postcheck"
  if [[ "$(sha256_file "$restore_candidate")" != "$preimage_flow_sha" ]]; then
    echo "Recorded pre-candidate bytes are not G1's postimage; refusing to restore" >&2
    exit 8
  fi
  node "$restore_postcheck" "$restore_candidate"
  node scripts/nodered_reviewed_flow_deploy/prepare_exact_graph_contract.mjs \
    --live "$source_flow" \
    --candidate "$restore_candidate" \
    --output "$restore_contract" \
    --deployment-id "$restore_deployment_id" \
    $(printf -- "--allow-change %s " "${allow_changes[@]}") >/dev/null

  node -e '
    const fs=require("node:fs");
    const value=JSON.parse(fs.readFileSync(process.argv[1],"utf8"));
    const expected=["lk_subscription_managed_policy_20260820","lk_subscription_price_preview_20260908_evaluate","lk_subscription_price_preview_20260908_router"].sort();
    if(value.formatVersion!==2||value.contractKind!=="exact-graph")process.exit(1);
    if(value.deploymentId!=="lk1-train-g2-restore")process.exit(1);
    if(value.sourceSha256!==process.argv[2]||value.candidateSha256!==process.argv[3])process.exit(1);
    if(value.sourceNodeCount!==4815||value.candidateNodeCount!==4815)process.exit(1);
    const changes=Array.isArray(value.allowedChanges)?value.allowedChanges:null;
    if(!changes||changes.length!==3)process.exit(1);
    if(JSON.stringify(changes.map((row)=>row.id).sort())!==JSON.stringify(expected))process.exit(1);
    for(const row of changes){if(JSON.stringify(row.fields)!==JSON.stringify(["func"]))process.exit(1);}
    if((value.allowedAdditions||[]).length!==0)process.exit(1);
  ' "$restore_contract" "$applied_flow_sha" "$preimage_flow_sha"
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
    echo "Dry-run --applied is not the applied G2 generation: $(sha256_file "$applied_arg")" >&2
    exit 4
  fi
  if [[ "$(sha256_file "$preimage_arg")" != "$preimage_flow_sha" ]]; then
    echo "Dry-run --preimage is not G1's reviewed postimage: $(sha256_file "$preimage_arg")" >&2
    exit 4
  fi
  stage_pinned_workspace "$applied_arg" "$workspace"
  mkdir -m 700 "$restore_dir"
  cp "$preimage_arg" "$restore_candidate"
  chmod 600 "$restore_candidate"
  compose_and_validate_restore
  cp "$restore_candidate" "$restore_out"
  chmod 600 "$restore_out"
  echo "dryRun=1"
  echo "mode=restore"
  echo "appliedFlowSha256=$applied_flow_sha"
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

wait_for_soak_lease "$deployment_id"
pull_live_workspace
if [[ "$(sha256_file "$source_flow")" != "$applied_flow_sha" ]]; then
  echo "Live flow is not the applied G2 generation; G2 rollback cannot start" >&2
  exit 5
fi
mkdir -m 700 "$restore_dir"
remote_ssh_capture "$restore_candidate" "cat '$remote_flow_backup'"
compose_and_validate_restore

remote_ssh "test ! -e '$remote_stage' && install -d -m 700 '$remote_stage'"
remote_stage_created=1
remote_scp_to "$restore_candidate" "$host:$remote_candidate"
remote_scp_to "$restore_contract" "$host:$remote_contract"
remote_scp_to "$restore_postcheck" "$host:$remote_postcheck"
remote_scp_to \
  scripts/nodered_reviewed_flow_deploy/runtime_contract.mjs \
  scripts/nodered_reviewed_flow_deploy/deploy_reviewed_flow_147_remote.mjs \
  "$host:$remote_stage/"
remote_ssh "chmod 600 '$remote_candidate' '$remote_contract' '$remote_postcheck'; chmod 700 '$remote_helper'"

remote_ssh_capture "$restore_preflight" \
  "node '$remote_helper' preflight --candidate '$remote_candidate' --contract '$remote_contract' --deployment-id '$restore_deployment_id'"
node -e '
  const fs=require("node:fs");
  const value=JSON.parse(fs.readFileSync(process.argv[1],"utf8"));
  if(!value.ok||value.action!=="preflight"||value.sourceSha256!==process.argv[2]
    ||value.candidateSha256!==process.argv[3]||value.changedNodeCount!==3
    ||value.addedNodeCount!==0)process.exit(1);
' "$restore_preflight" "$applied_flow_sha" "$preimage_flow_sha"

plan_rules_error_pattern='plan rules prior mismatch|plan rules readback mismatch'
plan_rules_errors_before="$(remote_ssh "grep -hE '$plan_rules_error_pattern' /root/.pm2/logs/*node-red*.log 2>/dev/null | wc -l" | tr -d "[:space:]")"
plan_rules_errors_before="${plan_rules_errors_before:-0}"
echo "planRulesErrorsBefore=$plan_rules_errors_before"

ssh "${ssh_opts[@]}" "$host" "node '$remote_helper' apply --candidate '$remote_candidate' --contract '$remote_contract' --deployment-id '$restore_deployment_id' --stamp '$remote_stamp'" >"$restore_apply"
node -e '
  const fs=require("node:fs");
  const value=JSON.parse(fs.readFileSync(process.argv[1],"utf8"));
  if(!value.ok||value.action!=="apply"||value.sourceSha256!==process.argv[2]
    ||value.activeFlowSha256!==process.argv[3])process.exit(1);
' "$restore_apply" "$applied_flow_sha" "$preimage_flow_sha"
remote_ssh_capture "$restore_readback" "sha256sum '$remote_live_flow' | cut -d' ' -f1"
if [[ "$(tr -d '\n' < "$restore_readback")" != "$preimage_flow_sha" ]]; then
  echo "Restore readback mismatch; stop and inspect" >&2
  exit 6
fi
if ! remote_ssh "node '$remote_postcheck' '$remote_live_flow'"; then
  echo "Restored content nodes are not G1's postimage; stop and inspect" >&2
  exit 7
fi

plan_rules_errors_after="$(remote_ssh "grep -hE '$plan_rules_error_pattern' /root/.pm2/logs/*node-red*.log 2>/dev/null | wc -l" | tr -d "[:space:]")"
plan_rules_errors_after="${plan_rules_errors_after:-0}"
if [[ "$plan_rules_errors_after" -gt "$plan_rules_errors_before" ]]; then
  echo "The G2 rollback restart logged a plan-rules mismatch; stop and inspect" >&2
  exit 8
fi

smoke_ok=0
for ((smoke_attempt = 1; smoke_attempt <= 30; smoke_attempt++)); do
  if curl -sS --max-time 15 -o "$restore_dir/smoke.json" -w '%{http_code}' "$smoke_url" > "$restore_dir/smoke.status" \
    && [[ "$(tr -d '\n' < "$restore_dir/smoke.status")" == "200" ]]; then
    smoke_ok=1
    break
  fi
  sleep 3
done
if [[ "$smoke_ok" != "1" ]]; then
  echo "LK backend smoke failed after the G2 rollback; flow restored, endpoint needs inspection" >&2
  exit 10
fi

echo "rollback=complete"
echo "restoredFlowSha256=$preimage_flow_sha"
echo "flowBackup=$remote_flow_backup"
echo "contractBackup=$remote_contract_backup"
echo "nextStep=NODE_RED_LK1_TRAIN_G1_ROLLBACK=CONFIRM_147 npm run nodered:lk1-train-g1:rollback-147 -- <g1 stamp> (ordered plan-rules revert first)"
