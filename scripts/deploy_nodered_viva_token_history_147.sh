#!/usr/bin/env bash

set -euo pipefail
umask 077

if [[ $# -ne 0 || "${NODE_RED_VIVA_TOKEN_HISTORY_DEPLOY:-}" != "CONFIRM_147" ]]; then
  echo "Usage: NODE_RED_VIVA_TOKEN_HISTORY_DEPLOY=CONFIRM_147 bash scripts/deploy_nodered_viva_token_history_147.sh" >&2
  exit 2
fi

host="lk-primary-147"
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

stage_root="$(mktemp -d /private/tmp/padlhub-viva-token-history.XXXXXX)"
workspace="$stage_root/live"
remote_stamp="$(date '+%Y%m%dT%H%M%S%z')"
remote_stage="/root/.node-red/.padlhub-viva-token-history-stage-$remote_stamp-$$"
remote_candidate="$remote_stage/candidate.flow.json"
remote_backup="/root/.node-red/.padlhub-viva-token-history-backups/flows-pre-viva-token-history-$remote_stamp.json"

cleanup() {
  ssh "$host" "rm -f '$remote_stage/candidate.flow.json' '$remote_stage/runtime_contract.mjs' '$remote_stage/deploy_viva_token_history_147_remote.mjs'; rmdir '$remote_stage' 2>/dev/null || true" >/dev/null 2>&1 || true
  rm -f \
    "$workspace/input/source.flow.json" \
    "$workspace/input/source.flow.meta.json" \
    "$stage_root/token.candidate.json" \
    "$stage_root/token.report.json" \
    "$stage_root/final.candidate.json" \
    "$stage_root/history.report.json" 2>/dev/null || true
  rmdir "$workspace/input" "$workspace" "$stage_root" 2>/dev/null || true
}
trap cleanup EXIT

bash scripts/pull_nodered_source_from_147.sh "$workspace"
source_flow="$workspace/input/source.flow.json"
source_sha="$(shasum -a 256 "$source_flow" | awk '{print $1}')"
reviewed_sha="d9ae9ef519f5f1e1bc474ebd7aff955b20721af3467c92f079cf6f68dc26c76a"
if [[ "$source_sha" != "$reviewed_sha" ]]; then
  echo "Fresh live flow does not match the reviewed preimage" >&2
  exit 5
fi

node scripts/patch_live_viva_token_cache.mjs \
  --input "$source_flow" \
  --output "$stage_root/token.candidate.json" \
  --report "$stage_root/token.report.json" \
  --expected-flow-sha256 "$source_sha" >/dev/null
token_sha="$(shasum -a 256 "$stage_root/token.candidate.json" | awk '{print $1}')"
node scripts/patch_live_tournament_history_resilience.mjs \
  --input "$stage_root/token.candidate.json" \
  --output "$stage_root/final.candidate.json" \
  --report "$stage_root/history.report.json" \
  --expected-flow-sha256 "$token_sha" >/dev/null
node scripts/nodered_viva_token_deploy/validate_candidate.mjs \
  "$source_flow" "$stage_root/final.candidate.json"
candidate_sha="$(shasum -a 256 "$stage_root/final.candidate.json" | awk '{print $1}')"

ssh "$host" "test ! -e '$remote_stage' && install -d -m 700 '$remote_stage'"
scp -q "$stage_root/final.candidate.json" "$host:$remote_candidate"
scp -q \
  scripts/nodered_viva_token_deploy/runtime_contract.mjs \
  scripts/nodered_viva_token_deploy/deploy_viva_token_history_147_remote.mjs \
  "$host:$remote_stage/"
ssh "$host" "chmod 600 '$remote_candidate' '$remote_stage/runtime_contract.mjs'; chmod 700 '$remote_stage/deploy_viva_token_history_147_remote.mjs'"

ssh "$host" "node '$remote_stage/deploy_viva_token_history_147_remote.mjs' install-env --stamp '$remote_stamp'"
ssh "$host" "node '$remote_stage/deploy_viva_token_history_147_remote.mjs' apply-flow --candidate '$remote_candidate' --stamp '$remote_stamp'"

public_games_status="$(curl --retry 5 --retry-delay 2 --retry-connrefused --max-time 20 -sS -o /dev/null -w '%{http_code}' 'https://padlhub.su/lk/games?public=true&available=true&limit=1&offset=0' || true)"
history_status="$(curl --retry 5 --retry-delay 2 --retry-connrefused --max-time 20 -sS -o /dev/null -w '%{http_code}' 'https://padlhub.su/lk/tournaments/americano/history?tournamentId=00000000-0000-0000-0000-000000000000' || true)"
if [[ "$public_games_status" != "200" || "$history_status" != "200" ]]; then
  echo "Public postcheck failed; restoring the reviewed flow" >&2
  ssh "$host" "node '$remote_stage/deploy_viva_token_history_147_remote.mjs' rollback-flow --backup '$remote_backup' --expected-candidate-sha256 '$candidate_sha'"
  exit 6
fi

echo "deployedGitSha=$local_sha"
echo "activeFlowSha256=$candidate_sha"
echo "publicGamesStatus=$public_games_status"
echo "tournamentHistoryStatus=$history_status"
