#!/usr/bin/env bash

# Guarded deployment of the focused LK1 free-event checkout generation.
#
#   * lk_subscription_booking_router_20260804.func - the visit-covered first event of the day
#     completes without a payment product: the payment binding is required only where money is
#     charged, so the confirm step no longer answers LK1_GROUP_PAYMENT_BINDING_INVALID after
#     Viva wrote the booking and the replay of the CONFIRMED operation no longer answers
#     LK1_PAYMENT_RECONCILIATION_REQUIRED on every poll.
#
# The candidate changes exactly one `func` field of one node; every other node stays
# byte-identical.
#
# The allowance is expressed with the exact-graph contract (formatVersion 2) and no
# node is added.
#
# Requires an explicit confirmation variable, a clean main checkout equal to
# origin/main, and the exact live preimage. Everything else fails closed.

set -euo pipefail
umask 077

if [[ $# -ne 0 || "${NODE_RED_LK1_FREE_EVENT_CHECKOUT_DEPLOY:-}" != "CONFIRM_147" ]]; then
  echo "Usage: NODE_RED_LK1_FREE_EVENT_CHECKOUT_DEPLOY=CONFIRM_147 npm run nodered:lk1-free-event-checkout:deploy-147" >&2
  exit 2
fi

host="lk-primary-147"
deployment_id="lk1-free-event-checkout"
allow_nodes=(lk_subscription_booking_router_20260804)
expected_changed_nodes=1
# Field-level allowance: exactly one `func` field of the gateway. No other field, node or
# route may change.
allow_changes=(
  "lk_subscription_booking_router_20260804:func"
)
expected_node_fields='{"lk_subscription_booking_router_20260804":["func"]}'
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

stage_root="$(mktemp -d /private/tmp/padlhub-lk1-free-event-checkout-deploy.XXXXXX)"
# Unix socket paths are limited to about 104 bytes, so keep the control path short.
ssh_control_root="$(mktemp -d /private/tmp/lk1fec.XXXXXX)"
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
# The remote helper only accepts its own reviewed stage shape:
# /root/.node-red/.padlhub-reviewed-flow-stage-<stamp>-<pid> holding
# candidate.flow.json and contract.json.
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
  -o ControlPath="$ssh_control_root/c-%C"
  -o ControlPersist=120
)
ssh_retry_attempts="${NODE_RED_LK1_FREE_EVENT_CHECKOUT_SSH_ATTEMPTS:-5}"
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
  rm -f "$ssh_control_root"/c-* 2>/dev/null || true
  rmdir "$ssh_control_root" 2>/dev/null || true
  # Receipts are the failure evidence: keep them (and the stage directory) once an
  # apply started, so a manual rollback has its stamp and the recorded receipts.
  if [[ "$apply_started" != "1" ]]; then
    rm -rf "$stage_root" 2>/dev/null || true
  fi
}
trap cleanup EXIT
trap 'exit 130' INT
trap 'exit 143' TERM HUP

# The node list and the field-level allowance must describe the same two nodes.
node -e '
  const expected=JSON.parse(process.argv[1]);
  const nodes=process.argv.slice(2).sort();
  if (JSON.stringify(Object.keys(expected).sort()) !== JSON.stringify(nodes)) process.exit(1);
' "$expected_node_fields" "${allow_nodes[@]}"

# Full-flow preimage: the focused generation pins the exact live flow sha and both
# live function bodies plus the live setup body, so a tab-scoped extraction is not
# enough.
pull_live_workspace

mkdir -m 700 "$candidate_dir"
node scripts/patch_live_lk1_free_event_checkout_hotfix.mjs \
  --workspace "$workspace" \
  --output "$candidate_flow" \
  --report "$candidate_report" >/dev/null

# The generation must be exactly the one reviewed node with the reviewed field: a
# candidate that also touches anything else is not this generation.
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
  if (value.booking?.id !== "lk_subscription_booking_router_20260804"
    || value.booking?.otherFieldsUnchanged !== true
    || value.booking?.freeEventCarriesZeroChargeBinding !== true
    || value.booking?.chargedBindingStillExact !== true) process.exit(1);
' "$candidate_report" "$expected_node_fields" "$expected_changed_nodes"

# Independent exact-graph contract (the candidate changes one `func` field only);
# never reuse the patcher's own report.
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
# The contract file carries the field-level allowance itself; the node count only
# exists in the preflight receipt. Require the exact reviewed one-node delta and no
# added nodes.
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
# Publish the recovery identifiers before the mutation: on a failed postcheck the
# operator needs the stamp to run the rollback helper.
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

# Functional smoke on the deployed LK backend. This is NOT the deploy proof (see
# the installed-flow readback above): it only proves the LK HTTP surface still
# answers with a RUB price payload. apply restarts Node-RED, so the endpoint may
# answer with an error page for a short window; retry within a bounded budget and
# fail closed if the payload never matches.
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
  echo "LK backend smoke check failed after the warm-up budget; automatic rollback requested" >&2
  exit 6
fi

completed=1
echo "deployedGitSha=$local_sha"
echo "sourceFlowSha256=$source_sha"
echo "activeFlowSha256=$candidate_sha"
echo "installedFlowReadbackSha256=$installed_sha"
echo "changedNodeCount=$expected_changed_nodes"
echo "flowBackup=$remote_flow_backup"
echo "contractBackup=$remote_contract_backup"
echo "smokeUrl=$smoke_url"
echo "rollbackHint=node '$remote_helper' rollback --deployment-id '$deployment_id' --flow-backup '$remote_flow_backup' --contract-backup '$remote_contract_backup'"
