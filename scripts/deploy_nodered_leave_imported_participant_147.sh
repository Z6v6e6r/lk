#!/usr/bin/env bash

# Guarded deployment of the imported-participant leave fix.
#
# Publishes one reviewed flow whose only change is the function body of the split
# leave router (`9878400d518ebcbd`). The live body is narrower than the tracked
# source on main, so the candidate is composed by an in-place patch of the exact
# verified live body instead of shipping the whole tracked file.
#
# Requires an explicit confirmation variable, a clean checkout of the reviewed task
# branch equal to its origin counterpart, and the exact live preimage. Everything
# else fails closed.

set -euo pipefail
umask 077

if [[ $# -ne 0 || "${NODE_RED_LEAVE_IMPORTED_PARTICIPANT_DEPLOY:-}" != "CONFIRM_147" ]]; then
  echo "Usage: NODE_RED_LEAVE_IMPORTED_PARTICIPANT_DEPLOY=CONFIRM_147 bash scripts/deploy_nodered_leave_imported_participant_147.sh" >&2
  exit 2
fi

host="lk-primary-147"
deployment_id="split-leave-imported-participant-20260915"
router_node_id="9878400d518ebcbd"
probe_game_id="pay_1fb78942-4348-4cda-95cd-93634d335a60"
expected_source_sha="30bd28732cc87ed77fd802f1530a8c172dd16694528644baafc623088521fcb5"
expected_candidate_sha="8d9ddf83f84b99bb0930e2ddfbc7203a3955317746e0f9d2afa99ba47370a24d"
expected_node_func_sha="4411495cc679ddde0724f8eda9aa1dcf8c06dcca1adf276df65422438b14d7c3"
expected_branch="codex/games-leave-imported-participant-20260915"
repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd -P)"
cd "$repo_root"

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

stage_root="$(mktemp -d /private/tmp/padlhub-leave-imported.XXXXXX)"
ssh_control_root="$(mktemp -d /private/tmp/plip.XXXXXX)"
workspace="$stage_root/live"
candidate_dir="$stage_root/candidate-leave-imported"
source_flow="$workspace/input/source.flow.json"
candidate_flow="$candidate_dir/candidate.flow.json"
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
ssh_retry_attempts="${NODE_RED_LEAVE_IMPORTED_PARTICIPANT_SSH_ATTEMPTS:-5}"
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
  rm -f "$candidate_flow" "$contract_file" 2>/dev/null || true
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

mkdir -p "$candidate_dir"
chmod 700 "$candidate_dir"
node scripts/prepare_split_leave_imported_participant_candidate.mjs --workspace "$workspace" >/dev/null

built_candidate="$workspace/build-split-leave-imported-participant/candidate.flow.json"
built_contract="$workspace/build-split-leave-imported-participant/contract.json"
[[ -f "$built_candidate" && -f "$built_contract" ]] || { echo "Candidate build produced no artifacts" >&2; exit 5; }
cp "$built_candidate" "$candidate_flow"
cp "$built_contract" "$contract_file"
chmod 600 "$candidate_flow" "$contract_file"

# The live router body must still be the reviewed one, otherwise the in-place patch
# is not the change that was reviewed.
live_func_sha="$(node -e '
  const fs=require("fs");
  const crypto=require("crypto");
  const flow=JSON.parse(fs.readFileSync(process.argv[1],"utf8"));
  const node=flow.find((item)=>item.id===process.argv[2]);
  if(!node) process.exit(1);
  process.stdout.write(crypto.createHash("sha256").update(String(node.func||"")).digest("hex"));
' "$source_flow" "$router_node_id")"
if [[ "$live_func_sha" != "$expected_node_func_sha" ]]; then
  echo "Live router body is not the reviewed preimage" >&2
  exit 6
fi

source_sha="$(node -e 'const value=JSON.parse(require("fs").readFileSync(process.argv[1],"utf8")); process.stdout.write(value.sourceSha256)' "$contract_file")"
candidate_sha="$(node -e 'const value=JSON.parse(require("fs").readFileSync(process.argv[1],"utf8")); process.stdout.write(value.candidateSha256)' "$contract_file")"
if [[ "$source_sha" != "$expected_source_sha" || "$candidate_sha" != "$expected_candidate_sha" ]]; then
  echo "Rebuilt candidate does not match the reviewed packet" >&2
  exit 7
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
    || value.candidateSha256 !== process.argv[3] || value.changedNodeCount !== 1) process.exit(1);
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
  exit 8
fi

# Read-only liveness observation after the Node-RED restart. The exit behaviour itself
# is covered by the function-body contract and the local regressions; a real leave
# probe would mutate a player record and is deliberately not run here.
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
  exit 9
fi

completed=1
echo "deployedGitSha=$local_sha"
echo "sourceFlowSha256=$source_sha"
echo "activeFlowSha256=$candidate_sha"
echo "installedFlowReadbackSha256=$installed_sha"
echo "routerFuncSha256=$expected_node_func_sha"
echo "flowBackup=$remote_flow_backup"
echo "contractBackup=$remote_contract_backup"
