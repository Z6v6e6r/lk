#!/usr/bin/env bash

set -euo pipefail

usage() {
  cat <<'EOF'
Usage:
  bash ./scripts/prepare_nodered_update_for_147.sh <remote-flow-path> [--dry-run]

What it does:
  1. Pulls the live Node-RED flow from 147 into node-red/modular/source.flow.json
  2. Applies local LK Games / result / referral patch scripts onto that pulled source
  3. Rebuilds modular artifacts with --allow-other-tabs=true
  4. Runs modular validation

Examples:
  bash ./scripts/prepare_nodered_update_for_147.sh /root/.node-red/flows.json
  npm run nodered:modular:prepare-147 -- /root/.node-red/flows.json
  bash ./scripts/prepare_nodered_update_for_147.sh /root/.node-red/flows.json --dry-run
EOF
}

if [[ $# -lt 1 || $# -gt 2 ]]; then
  usage
  exit 1
fi

remote_flow_path="$1"
dry_run="${2:-}"

if [[ "$remote_flow_path" != /* ]]; then
  echo "Remote flow path must be absolute: $remote_flow_path" >&2
  exit 1
fi

if [[ -n "$dry_run" && "$dry_run" != "--dry-run" ]]; then
  echo "Unknown option: $dry_run" >&2
  usage
  exit 1
fi

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
source_host="${NODERED_SOURCE_HOST:-lk-primary-147}"
source_user="${NODERED_SOURCE_USER:-root}"
source_port="${NODERED_SOURCE_PORT:-22}"
source_key_raw="${NODERED_SOURCE_KEY:-}"
pull_cmd=(bash "$repo_root/scripts/pull_nodered_source_from_147.sh" "$remote_flow_path")
sync_cmd=(npm run nodered:modular:sync-games-source)
build_cmd=(node "$repo_root/scripts/nodered_modular_flow.mjs" build --allow-other-tabs=true)
validate_cmd=(npm run nodered:modular:validate)
verify_cmd=(node "$repo_root/scripts/verify_nodered_source_origin.mjs" "$repo_root/node-red/modular/source.flow.meta.json" "$source_host" "$source_user" "$source_port" "$remote_flow_path")

echo "Preparing Node-RED update for 147 from live source"
echo "Remote flow path: $remote_flow_path"
echo "Expected source host: $source_host"
echo "Repository root: $repo_root"

if [[ "$dry_run" == "--dry-run" ]]; then
  echo
  echo "Dry run commands:"
  printf '  %q' "${pull_cmd[@]}" --dry-run
  echo
  printf '  %q' "${verify_cmd[@]}"
  echo
  printf '  %q' "${sync_cmd[@]}"
  echo
  printf '  %q' "${build_cmd[@]}"
  echo
  printf '  %q' "${validate_cmd[@]}"
  echo
  exit 0
fi

"${pull_cmd[@]}"
(cd "$repo_root" && "${verify_cmd[@]}")
(cd "$repo_root" && "${sync_cmd[@]}")
(cd "$repo_root" && "${build_cmd[@]}")
(cd "$repo_root" && "${validate_cmd[@]}")

echo
echo "Prepared artifacts:"
echo "  source flow: $repo_root/node-red/modular/source.flow.json"
echo "  source origin metadata: $repo_root/node-red/modular/source.flow.meta.json"
echo "  modular flow: $repo_root/node-red/modular/lk.flow.modular.json"
echo "  LK Games import: $repo_root/node-red/modular/imports/lk_games.import.json"
echo "  LK Games nodes-only import: $repo_root/node-red/modular/imports/lk_games.nodes.import.json"
