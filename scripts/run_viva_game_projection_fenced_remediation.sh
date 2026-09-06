#!/usr/bin/env bash
set -euo pipefail

lock_path="/run/lock/padlhub-viva-game-projection-cutover.lock"
script_dir="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd -P)"

if [[ "${EUID}" -ne 0 ]]; then
  echo "The production remediation wrapper requires root" >&2
  exit 1
fi
if [[ -z "${PADLHUB_CUTOVER_FENCE_TOKEN:-}" ]]; then
  echo "PADLHUB_CUTOVER_FENCE_TOKEN is required" >&2
  exit 1
fi

umask 077
exec 9>"${lock_path}"
if ! flock -n 9; then
  echo "Another PadlHub Viva projection cutover holds the writer fence" >&2
  exit 1
fi

export PADLHUB_CUTOVER_FENCE_FD=9
export PADLHUB_CUTOVER_FENCE_LOCK_PATH="${lock_path}"
exec node "${script_dir}/run_viva_game_projection_remediation.mjs" "$@"
