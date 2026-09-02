#!/usr/bin/env bash
set -euo pipefail

if [[ $# -ne 1 ]]; then
  echo "Usage: bash scripts/pull_nodered_dev_source_readonly.sh <external-workspace>" >&2
  exit 64
fi

workspace="$1"
case "$workspace" in
  /private/tmp/*|/tmp/*) ;;
  *) echo "DEV snapshot workspace must be under /private/tmp or /tmp" >&2; exit 65 ;;
esac

umask 077
if [[ -e "$workspace" ]]; then
  echo "Refusing to overwrite an existing DEV snapshot workspace" >&2
  exit 66
fi
mkdir -p "$workspace/input"
source_path="$workspace/input/source.flow.json"
meta_path="$workspace/input/source.flow.meta.json"

# Remote commands are read-only. No Node-RED import, restart, or flow mutation occurs.
ssh lk-reserve-89 'test "$(id -u)" = 0 && test -r /root/.node-red/flows.json && cat /root/.node-red/flows.json' > "$source_path"
source_sha="$(shasum -a 256 "$source_path" | awk '{print $1}')"
source_hostname="$(ssh lk-reserve-89 'hostname')"
node_count="$(jq 'length' "$source_path")"
http_route_count="$(jq '[.[] | select(.type == "http in")] | length' "$source_path")"
tab_count="$(jq '[.[] | select(.type == "tab")] | length' "$source_path")"
captured_at="$(date -u +%Y-%m-%dT%H:%M:%SZ)"

jq -n \
  --arg environment DEV \
  --arg sourceKind live-dev-reserve \
  --arg sourceHost lk-reserve-89 \
  --arg sourceHostname "$source_hostname" \
  --arg sourceUser root \
  --arg remoteFlowPath /root/.node-red/flows.json \
  --arg sourceSha256 "$source_sha" \
  --arg capturedAt "$captured_at" \
  --argjson sourcePort 22 \
  --argjson nodeCount "$node_count" \
  --argjson httpRouteCount "$http_route_count" \
  --argjson tabCount "$tab_count" \
  '{formatVersion:1, environment:$environment, sourceKind:$sourceKind,
    sourceHost:$sourceHost, sourceHostname:$sourceHostname, sourceUser:$sourceUser,
    sourcePort:$sourcePort, remoteFlowPath:$remoteFlowPath,
    sourceSha256:$sourceSha256, nodeCount:$nodeCount,
    httpRouteCount:$httpRouteCount, tabCount:$tabCount, capturedAt:$capturedAt}' > "$meta_path"

node scripts/inspect_lk1_subscription_dev_snapshot.mjs "$source_path" "$meta_path"

printf 'source=%s\nmetadata=%s\nsourceSha256=%s\n' "$source_path" "$meta_path" "$source_sha"
