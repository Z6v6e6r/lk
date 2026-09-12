#!/usr/bin/env bash

# Guarded deployment of the split "no fabricated participant share" generation.
# Publishes one reviewed flow whose only change is the function body of the three
# split nodes (create prepare, join prepare, router), so the server stops
# substituting the nominal 10 000 / shareCount for an unproven participant share.
#
# Requires an explicit confirmation variable, a clean checkout of the reviewed task
# branch equal to its origin counterpart, and the exact live preimage. Everything
# else fails closed.

set -euo pipefail
umask 077

if [[ $# -ne 0 || "${NODE_RED_SPLIT_NOMINAL_SHARE_DEPLOY:-}" != "CONFIRM_147" ]]; then
  echo "Usage: NODE_RED_SPLIT_NOMINAL_SHARE_DEPLOY=CONFIRM_147 bash scripts/deploy_nodered_split_nominal_share_147.sh" >&2
  exit 2
fi

host="lk-primary-147"
deployment_id="split-nominal-share"
create_node_id="f3f9a60354d394da"
join_node_id="e92e68bf3f08a70c"
router_node_id="8f7bd5b482fe9763"
probe_game_id="pay_1fb78942-4348-4cda-95cd-93634d335a60"
expected_source_sha="e5d643518373698679ad3a209d94db66877de654154a215681a368ac2e5ec332"
expected_candidate_sha="f6c6c9e2da8a751a28075e44521662f794556052b96c17bed3fc00f59f5b502d"
expected_branch="codex/nodered-split-fail-closed-20260912"
repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd -P)"
cd "$repo_root"

# The tracked split sources carry a newer generation than the live flow, so this packet
# is reviewed and deployed from its own task branch instead of main.
if [[ "$(git branch --show-current)" != "$expected_branch" || -n "$(git status --porcelain)" ]]; then
  echo "Deploy requires a clean checkout of $expected_branch" >&2
  exit 3
fi
local_sha="$(git rev-parse HEAD)"
# Compare against the published branch directly: a worktree may not carry a local
# remote-tracking ref even after a push.
remote_sha="$(git ls-remote origin "refs/heads/$expected_branch" | awk '{print $1}')"
if [[ -z "$remote_sha" || "$local_sha" != "$remote_sha" ]]; then
  echo "Local $expected_branch and origin/$expected_branch differ" >&2
  exit 4
fi

stage_root="$(mktemp -d /private/tmp/padlhub-split-nominal.XXXXXX)"
ssh_control_root="$(mktemp -d /private/tmp/psn.XXXXXX)"
workspace="$stage_root/live"
candidate_dir="$stage_root/candidate-split-nominal"
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
ssh_retry_attempts="${NODE_RED_SPLIT_NOMINAL_SHARE_SSH_ATTEMPTS:-5}"
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
    ssh "${ssh_opts[@]}" "$host" "node '$remote_helper' rollback --deployment-id '$deployment_id' --flow-backup '$remote_flow_backup' --contract-backup '$remote_contract_backup'" >/dev/null 2>&1 || true
  fi
  if [[ "$remote_stage_created" == "1" ]]; then
    ssh "${ssh_opts[@]}" "$host" "rm -f '$remote_candidate' '$remote_contract' '$remote_helper' '$remote_runtime'; rmdir '$remote_stage' 2>/dev/null || true" >/dev/null 2>&1 || true
  fi
  ssh "${ssh_opts[@]}" -O exit "$host" >/dev/null 2>&1 || true
  rm -f "$ssh_control_root"/c-* 2>/dev/null || true
  rmdir "$ssh_control_root" 2>/dev/null || true
  rm -f "$candidate_flow" "$candidate_report" "$contract_file" 2>/dev/null || true
  if [[ "$apply_started" != "1" ]]; then
    rm -f "$preflight_result" "$apply_result" "$postcheck_result" 2>/dev/null || true
  fi
  rm -f "$workspace/input/source.flow.json" "$workspace/input/source.flow.meta.json" 2>/dev/null || true
  rmdir "$candidate_dir" "$workspace/input" "$workspace" "$stage_root" 2>/dev/null || true
}
trap cleanup EXIT
trap 'exit 130' INT
trap 'exit 143' TERM HUP

pull_live_workspace

node scripts/patch_live_split_nominal_share.mjs \
  --workspace "$workspace" \
  --output "$candidate_flow" \
  --report "$candidate_report" >/dev/null

node scripts/nodered_reviewed_flow_deploy/prepare_contract.mjs \
  --live "$source_flow" \
  --candidate "$candidate_flow" \
  --output "$contract_file" \
  --deployment-id "$deployment_id" \
  --allow-node "$create_node_id" \
  --allow-node "$join_node_id" \
  --allow-node "$router_node_id" >/dev/null

source_sha="$(node -e 'const value=JSON.parse(require("fs").readFileSync(process.argv[1],"utf8")); process.stdout.write(value.sourceSha256)' "$contract_file")"
candidate_sha="$(node -e 'const value=JSON.parse(require("fs").readFileSync(process.argv[1],"utf8")); process.stdout.write(value.candidateSha256)' "$contract_file")"
if [[ "$source_sha" != "$expected_source_sha" || "$candidate_sha" != "$expected_candidate_sha" ]]; then
  echo "Rebuilt candidate does not match the reviewed packet" >&2
  exit 5
fi

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
    || value.candidateSha256 !== process.argv[3] || value.changedNodeCount !== 3) process.exit(1);
' "$preflight_result" "$source_sha" "$candidate_sha"

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
  echo "Installed flow readback does not match the candidate; automatic rollback requested" >&2
  exit 6
fi

# Read-only liveness observation after the Node-RED restart. The participant-share
# behaviour itself is covered by the function-body contract and the local regressions;
# a create/join probe would create a real Viva booking and is deliberately not run here.
smoke_ok=0
for ((smoke_attempt = 1; smoke_attempt <= 30; smoke_attempt++)); do
  if curl -sS --max-time 15 "https://padlhub.su/lk/games/$probe_game_id" -o "$postcheck_result" \
    && node -e '
        const value=JSON.parse(require("fs").readFileSync(process.argv[1],"utf8"));
        if (!value || value.id !== process.argv[2] || !value.metadata) process.exit(1);
      ' "$postcheck_result" "$probe_game_id"; then
    smoke_ok=1
    break
  fi
  sleep 3
done
if [[ "$smoke_ok" != "1" ]]; then
  echo "Games API liveness check failed after the warm-up budget; automatic rollback requested" >&2
  exit 7
fi

completed=1
echo "deployedGitSha=$local_sha"
echo "sourceFlowSha256=$source_sha"
echo "activeFlowSha256=$candidate_sha"
echo "installedFlowReadbackSha256=$installed_sha"
echo "flowBackup=$remote_flow_backup"
echo "contractBackup=$remote_contract_backup"
