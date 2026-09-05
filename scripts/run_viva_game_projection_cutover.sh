#!/usr/bin/env bash
set -euo pipefail

lock_path="/run/lock/padlhub-viva-game-projection-cutover.lock"
script_dir="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd -P)"

if [[ "${1:-}" == "--help" ]]; then
  exec node "${script_dir}/run_viva_game_projection_cutover_coordinator.mjs" --help
fi

if [[ "${EUID}" -ne 0 ]]; then
  echo "The production cutover coordinator requires root" >&2
  exit 1
fi
if [[ -z "${PADLHUB_CUTOVER_FENCE_TOKEN:-}" ]]; then
  echo "PADLHUB_CUTOVER_FENCE_TOKEN is required" >&2
  exit 1
fi
if [[ -z "${PADLHUB_CUTOVER_GUARDIAN_RECEIPT:-}" || -z "${PADLHUB_CUTOVER_GUARDIAN_RELEASE_REQUEST:-}" || -z "${PADLHUB_CUTOVER_GUARDIAN_HEARTBEAT:-}" ]]; then
  echo "PADLHUB_CUTOVER_GUARDIAN_RECEIPT, PADLHUB_CUTOVER_GUARDIAN_RELEASE_REQUEST and PADLHUB_CUTOVER_GUARDIAN_HEARTBEAT are required" >&2
  exit 1
fi

umask 077
exec 9>"${lock_path}"
if ! flock -n 9; then
  echo "Another PadlHub Viva projection cutover holds the writer fence" >&2
  exit 75
fi

export PADLHUB_CUTOVER_FENCE_FD=9
export PADLHUB_CUTOVER_FENCE_LOCK_PATH="${lock_path}"
guardian_log="${PADLHUB_CUTOVER_GUARDIAN_RECEIPT}.log"
nohup node "${script_dir}/run_viva_game_projection_fence_guardian.mjs" \
  --receipt "${PADLHUB_CUTOVER_GUARDIAN_RECEIPT}" \
  --release-request "${PADLHUB_CUTOVER_GUARDIAN_RELEASE_REQUEST}" \
  --heartbeat "${PADLHUB_CUTOVER_GUARDIAN_HEARTBEAT}" \
  9>&9 </dev/null >>"${guardian_log}" 2>&1 &
guardian_pid=$!
for _ in {1..50}; do
  [[ -f "${PADLHUB_CUTOVER_GUARDIAN_RECEIPT}" && -f "${PADLHUB_CUTOVER_GUARDIAN_HEARTBEAT}" ]] && break
  kill -0 "${guardian_pid}" 2>/dev/null || {
    echo "Persistent fence guardian failed to start" >&2
    exit 1
  }
  sleep 0.1
done
if [[ ! -f "${PADLHUB_CUTOVER_GUARDIAN_RECEIPT}" || ! -f "${PADLHUB_CUTOVER_GUARDIAN_HEARTBEAT}" ]]; then
  echo "Persistent fence guardian receipt and heartbeat were not created" >&2
  exit 1
fi
export PADLHUB_CUTOVER_GUARDIAN_PID="${guardian_pid}"
exec node "${script_dir}/run_viva_game_projection_cutover_coordinator.mjs" "$@"
