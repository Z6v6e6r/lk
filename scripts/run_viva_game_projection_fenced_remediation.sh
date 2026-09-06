#!/bin/bash
set -euo pipefail
unset BASH_ENV ENV CDPATH NODE_OPTIONS NODE_PATH LD_PRELOAD LD_LIBRARY_PATH
unset GIT_DIR GIT_WORK_TREE GIT_OBJECT_DIRECTORY GIT_ALTERNATE_OBJECT_DIRECTORIES
PATH="/usr/sbin:/usr/bin:/sbin:/bin"
export PATH

lock_path="/run/lock/padlhub-viva-game-projection-cutover.lock"
wrapper_path="${BASH_SOURCE[0]}"
runtime_dir="${PADLHUB_REMEDIATION_RUNTIME_DIR:-}"
repository_root="${PADLHUB_REMEDIATION_REPOSITORY_ROOT:-}"
fence_token_fd="${PADLHUB_REMEDIATION_FENCE_TOKEN_FD:-}"

if [[ "${EUID}" -ne 0 ]]; then
  echo "The production remediation wrapper requires root" >&2
  exit 1
fi
if [[ "${fence_token_fd}" != "7" \
  || "$(/usr/bin/stat -Lc '%u:%a:%h' -- /proc/self/fd/7)" != "0:400:1" ]]; then
  echo "Private remediation fence-token descriptor is required" >&2
  exit 1
fi
if [[ -z "${runtime_dir}" || -z "${repository_root}" \
  || "$(/usr/bin/realpath -- "${runtime_dir}")" != "${runtime_dir}" \
  || "$(/usr/bin/realpath -- "${repository_root}")" != "${repository_root}" ]]; then
  echo "Canonical remediation runtime and repository directories are required" >&2
  exit 1
fi
if [[ ! "${PADLHUB_REMEDIATION_WRAPPER_SHA256:-}" =~ ^[a-f0-9]{64}$ ]] \
  || [[ ! "${PADLHUB_REMEDIATION_BOOTSTRAP_SHA256:-}" =~ ^[a-f0-9]{64}$ ]]; then
  echo "Externally pinned remediation wrapper and bootstrap SHA-256 values are required" >&2
  exit 1
fi
if [[ "$(/usr/bin/realpath -- "${wrapper_path}")" != "${wrapper_path}" \
  || "$(/usr/bin/stat -Lc '%u:%a' -- "${runtime_dir}")" != "0:700" \
  || "$(/usr/bin/stat -Lc '%u:%a:%h' -- "${wrapper_path}")" != "0:500:1" \
  || "$(/usr/bin/sha256sum --binary "${wrapper_path}" | /usr/bin/cut -d' ' -f1)" != "${PADLHUB_REMEDIATION_WRAPPER_SHA256}" ]]; then
  echo "Remediation wrapper is not the externally verified private copy" >&2
  exit 1
fi

bootstrap_source="${repository_root}/scripts/run_viva_game_projection_remediation_bootstrap.mjs"
bootstrap_copy="${runtime_dir}/bootstrap.mjs"
exec 8<"${bootstrap_source}"
if ! (umask 077; set -o noclobber; /bin/cat <&8 >"${bootstrap_copy}"); then
  echo "Unable to materialize the opened remediation bootstrap byte stream" >&2
  exit 1
fi
/bin/chmod 400 "${bootstrap_copy}"
if [[ "$(/usr/bin/stat -Lc '%u:%a:%h' -- "${bootstrap_copy}")" != "0:400:1" \
  || "$(/usr/bin/sha256sum --binary "${bootstrap_copy}" | /usr/bin/cut -d' ' -f1)" != "${PADLHUB_REMEDIATION_BOOTSTRAP_SHA256}" ]]; then
  echo "Opened remediation bootstrap differs from the externally pinned byte stream" >&2
  exit 1
fi

umask 077
exec 9>"${lock_path}"
if ! /usr/bin/flock -n 9; then
  echo "Another PadlHub Viva projection cutover holds the writer fence" >&2
  exit 1
fi

export PADLHUB_CUTOVER_FENCE_FD=9
export PADLHUB_CUTOVER_FENCE_LOCK_PATH="${lock_path}"
exec /usr/bin/node "${bootstrap_copy}" "$@"
