#!/usr/bin/env bash

set -euo pipefail

usage() {
  echo "Usage: bash ./scripts/prepare_nodered_live_workspace.sh /absolute/external/workspace (--source-tab-label LABEL | --source-tab-id ID)" >&2
}

if [[ $# -ne 3 ]]; then
  usage
  exit 1
fi

workspace="$1"
selector="$2"
selector_value="$3"
if [[ "$selector" != "--source-tab-label" && "$selector" != "--source-tab-id" ]]; then
  usage
  exit 1
fi
if [[ -z "$selector_value" ]]; then
  echo "Source tab selector must not be empty" >&2
  exit 1
fi

script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd -P)"
bash "$script_dir/pull_nodered_source_from_147.sh" "$workspace"
node "$script_dir/verify_nodered_source_origin.mjs" --workspace "$workspace"
node "$script_dir/nodered_modular_flow.mjs" build --workspace "$workspace" "$selector" "$selector_value"
node "$script_dir/nodered_modular_flow.mjs" validate --workspace "$workspace" "$selector" "$selector_value"
