#!/usr/bin/env bash

set -euo pipefail
umask 077

if [[ $# -ne 0 ]]; then
  echo "Usage: bash scripts/install_nodered_mongodb_logging_guard_147.sh" >&2
  exit 2
fi

host="lk-primary-147"
repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd -P)"
source_directory="$repo_root/scripts/nodered_runtime_hardening"
guard_source="$source_directory/harden_mongodb_logging.cjs"
installer_source="$source_directory/install_mongodb_logging_guard.mjs"
remote_source="$source_directory/install_mongodb_logging_guard_147_remote.sh"
backup_stamp="$(date '+%Y%m%dT%H%M%S%z')"
stage_directory="/root/.node-red/.padlhub-mongodb-log-guard-stage-${backup_stamp}-$$"

for file in "$guard_source" "$installer_source" "$remote_source"; do
  if [[ ! -f "$file" || -L "$file" ]]; then
    echo "Runtime hardening source must be a regular file: $file" >&2
    exit 3
  fi
done

cleanup() {
  ssh "$host" "rm -f '$stage_directory/harden_mongodb_logging.cjs' '$stage_directory/install_mongodb_logging_guard.mjs' '$stage_directory/install_mongodb_logging_guard_147_remote.sh'; rmdir '$stage_directory' 2>/dev/null || true" >/dev/null 2>&1 || true
}
trap cleanup EXIT

ssh "$host" "test ! -e '$stage_directory' && install -d -m 700 '$stage_directory'"
scp -q \
  "$guard_source" \
  "$installer_source" \
  "$remote_source" \
  "$host:$stage_directory/"
ssh "$host" "chmod 700 '$stage_directory/harden_mongodb_logging.cjs' '$stage_directory/install_mongodb_logging_guard.mjs' '$stage_directory/install_mongodb_logging_guard_147_remote.sh'"
ssh "$host" "$stage_directory/install_mongodb_logging_guard_147_remote.sh '$stage_directory' '$backup_stamp'"

public_status="$(curl -sS -o /dev/null -w '%{http_code}' 'https://padlhub.su/lk/games?public=true&available=true&limit=1&offset=0')"
if [[ "$public_status" != "200" ]]; then
  echo "Public games API postcheck failed: HTTP $public_status" >&2
  exit 4
fi
echo "publicGamesApiStatus=$public_status"
