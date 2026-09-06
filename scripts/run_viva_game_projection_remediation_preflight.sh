#!/bin/bash
set -euo pipefail

PATH="/usr/sbin:/usr/bin:/sbin:/bin"
export PATH
unset BASH_ENV ENV CDPATH NODE_OPTIONS NODE_PATH LD_PRELOAD LD_LIBRARY_PATH
unset GIT_DIR GIT_WORK_TREE GIT_OBJECT_DIRECTORY GIT_ALTERNATE_OBJECT_DIRECTORIES
umask 077

wrapper_path="${BASH_SOURCE[0]}"
runtime_dir="${PADLHUB_REMEDIATION_RUNTIME_DIR:-}"
repository_root="${PADLHUB_REMEDIATION_REPOSITORY_ROOT:-}"
wrapper_sha256="${PADLHUB_REMEDIATION_PREFLIGHT_WRAPPER_SHA256:-}"
bootstrap_sha256="${PADLHUB_REMEDIATION_PREFLIGHT_BOOTSTRAP_SHA256:-}"

if [[ "${EUID}" -ne 0 ]]; then
  echo "The remediation preflight launcher requires root" >&2
  exit 1
fi
if [[ ! "${wrapper_sha256}" =~ ^[a-f0-9]{64}$ || ! "${bootstrap_sha256}" =~ ^[a-f0-9]{64}$ ]]; then
  echo "Externally reviewed wrapper and bootstrap SHA-256 values are required" >&2
  exit 1
fi
if [[ -z "${runtime_dir}" || -z "${repository_root}" \
  || "$(/usr/bin/realpath -- "${runtime_dir}")" != "${runtime_dir}" \
  || "$(/usr/bin/realpath -- "${repository_root}")" != "${repository_root}" \
  || "$(/usr/bin/stat -Lc '%u:%a' -- "${runtime_dir}")" != "0:700" \
  || "$(/usr/bin/stat -Lc '%u:%a:%h' -- "${wrapper_path}")" != "0:500:1" \
  || "$(/usr/bin/sha256sum --binary "${wrapper_path}" | /usr/bin/cut -d' ' -f1)" != "${wrapper_sha256}" ]]; then
  echo "Remediation preflight launcher is not its externally verified private copy" >&2
  exit 1
fi
if [[ "${PADLHUB_REMEDIATION_FENCE_TOKEN_FD:-}" != "7" \
  || "${PADLHUB_REMEDIATION_PROVIDER_TOKEN_FD:-}" != "10" \
  || "$(/usr/bin/stat -Lc '%u:%a:%h' -- /proc/self/fd/7)" != "0:400:1" \
  || "$(/usr/bin/stat -Lc '%u:%a:%h' -- /proc/self/fd/10)" != "0:400:1" ]]; then
  echo "Owned 0400 fence and provider credential descriptors 7 and 10 are required" >&2
  exit 1
fi
for name in PADLHUB_CUTOVER_GUARDIAN_RECEIPT PADLHUB_CUTOVER_GUARDIAN_RELEASE_REQUEST \
  PADLHUB_CUTOVER_GUARDIAN_RECOVERY_REQUEST PADLHUB_CUTOVER_GUARDIAN_READY_REQUEST \
  PADLHUB_CUTOVER_GUARDIAN_HEARTBEAT; do
  if [[ -z "${!name:-}" ]]; then
    echo "All persistent fence guardian paths are required" >&2
    exit 1
  fi
done

bootstrap_source="${repository_root}/scripts/run_viva_game_projection_remediation_preflight_bootstrap.mjs"
bootstrap_copy="${runtime_dir}/bootstrap.mjs"
exec 8<"${bootstrap_source}"
if ! (set -o noclobber; /bin/cat <&8 >"${bootstrap_copy}"); then
  echo "Unable to materialize the opened remediation preflight bootstrap" >&2
  exit 1
fi
/bin/chmod 400 "${bootstrap_copy}"
if [[ "$(/usr/bin/stat -Lc '%u:%a:%h' -- "${bootstrap_copy}")" != "0:400:1" \
  || "$(/usr/bin/sha256sum --binary "${bootstrap_copy}" | /usr/bin/cut -d' ' -f1)" != "${bootstrap_sha256}" ]]; then
  echo "Opened remediation preflight bootstrap differs from the external trust anchor" >&2
  exit 1
fi

exec /usr/bin/env -i \
  PATH=/usr/sbin:/usr/bin:/sbin:/bin LANG=C LC_ALL=C \
  PADLHUB_REMEDIATION_REPOSITORY_ROOT="${repository_root}" \
  PADLHUB_REMEDIATION_RUNTIME_DIR="${runtime_dir}" \
  PADLHUB_REMEDIATION_PREFLIGHT_WRAPPER_SHA256="${wrapper_sha256}" \
  PADLHUB_REMEDIATION_PREFLIGHT_BOOTSTRAP_SHA256="${bootstrap_sha256}" \
  PADLHUB_REMEDIATION_FENCE_TOKEN_FD=7 \
  PADLHUB_REMEDIATION_PROVIDER_TOKEN_FD=10 \
  PADLHUB_CUTOVER_GUARDIAN_RECEIPT="${PADLHUB_CUTOVER_GUARDIAN_RECEIPT}" \
  PADLHUB_CUTOVER_GUARDIAN_RELEASE_REQUEST="${PADLHUB_CUTOVER_GUARDIAN_RELEASE_REQUEST}" \
  PADLHUB_CUTOVER_GUARDIAN_RECOVERY_REQUEST="${PADLHUB_CUTOVER_GUARDIAN_RECOVERY_REQUEST}" \
  PADLHUB_CUTOVER_GUARDIAN_READY_REQUEST="${PADLHUB_CUTOVER_GUARDIAN_READY_REQUEST}" \
  PADLHUB_CUTOVER_GUARDIAN_HEARTBEAT="${PADLHUB_CUTOVER_GUARDIAN_HEARTBEAT}" \
  /usr/bin/node "${bootstrap_copy}" "$@"
