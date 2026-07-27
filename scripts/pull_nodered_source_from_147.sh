#!/usr/bin/env bash

set -euo pipefail
umask 077

usage() {
  echo "Usage: bash ./scripts/pull_nodered_source_from_147.sh /absolute/external/workspace" >&2
}

if [[ $# -ne 1 ]]; then
  usage
  exit 1
fi

workspace_arg="$1"
if [[ "$workspace_arg" != /* ]]; then
  echo "Node-RED workspace must be an absolute path" >&2
  exit 1
fi
if [[ -e "$workspace_arg" || -L "$workspace_arg" ]]; then
  echo "Node-RED workspace must not already exist" >&2
  exit 1
fi

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd -P)"
workspace_parent="$(dirname "$workspace_arg")"
workspace_name="$(basename "$workspace_arg")"
if [[ ! -d "$workspace_parent" || -L "$workspace_parent" ]]; then
  echo "Node-RED workspace parent must be an existing real directory" >&2
  exit 1
fi
canonical_parent="$(cd "$workspace_parent" && pwd -P)"
workspace="$canonical_parent/$workspace_name"
if [[ "$workspace" != "$workspace_arg" ]]; then
  echo "Node-RED workspace path must be canonical" >&2
  exit 1
fi
case "$workspace/" in
  "$repo_root/"*) echo "Node-RED workspace must be outside the repository" >&2; exit 1 ;;
esac

mkdir -m 700 "$workspace"
stage="$workspace/.pull-stage-$$"
cleanup() {
  exit_code=$?
  if [[ $exit_code -ne 0 ]]; then
    rm -f "$stage/source.flow.json" "$stage/source.flow.meta.json" 2>/dev/null || true
    rmdir "$stage" "$workspace" 2>/dev/null || true
  fi
  exit "$exit_code"
}
trap cleanup EXIT

mkdir -m 700 "$stage"
source_path="$stage/source.flow.json"
meta_path="$stage/source.flow.meta.json"
scp -q -P 22 "root@lk-primary-147:/root/.node-red/flows.json" "$source_path"
chmod 600 "$source_path"

summary="$(
  node --input-type=module -e '
    import crypto from "node:crypto";
    import fs from "node:fs";
    const [sourcePath, metaPath, finalSourcePath] = process.argv.slice(1);
    const raw = fs.readFileSync(sourcePath);
    const flow = JSON.parse(raw);
    if (!Array.isArray(flow)) throw new Error("Node-RED source must be a JSON array");
    const ids = new Set();
    for (const node of flow) {
      if (!node || typeof node !== "object" || Array.isArray(node) || typeof node.id !== "string" || !node.id.trim()) {
        throw new Error("Node-RED source contains an invalid node");
      }
      if (ids.has(node.id)) throw new Error(`Duplicate Node-RED node id: ${node.id}`);
      ids.add(node.id);
    }
    const sourceSha256 = crypto.createHash("sha256").update(raw).digest("hex");
    const meta = {
      formatVersion: 1,
      sourceKind: "live-147",
      sourceHost: "lk-primary-147",
      sourceUser: "root",
      sourcePort: "22",
      remoteFlowPath: "/root/.node-red/flows.json",
      localSourcePath: finalSourcePath,
      pulledAt: new Date().toISOString(),
      sourceSha256,
      nodeCount: flow.length,
    };
    fs.writeFileSync(metaPath, `${JSON.stringify(meta, null, 2)}\n`, { mode: 0o600, flag: "wx" });
    console.log(`sourceSha256=${sourceSha256}`);
    console.log(`nodeCount=${flow.length}`);
  ' "$source_path" "$meta_path" "$workspace/input/source.flow.json"
)"
chmod 600 "$meta_path"
mv "$stage" "$workspace/input"
printf '%s\n' "$summary"
