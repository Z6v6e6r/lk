#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import vm from "node:vm";
import { fileURLToPath } from "node:url";
import { verifyWorkspace } from "./verify_nodered_source_origin.mjs";
import { buildFunctionOnlyContract, validateFunctionOnlyContract, sha256 } from "./nodered_reviewed_flow_deploy/runtime_contract.mjs";

export const SOURCE_SHA256 = "de6a6b2206476de79564fbec9ad5d41ac8bd6088517c29452f4101d6ed3bb0aa";
export const TARGETS = [
  {
    "id": "7c280001a0c1e015",
    "file": "fn_split_leave_authorize.js",
    "sha256": "c012028a32628f8ecd0154c53582001abdae4e9fb71e3bdb67c53fbeb5a7a2d9"
  },
  {
    "id": "lk_split_leave_daily_limit_find_build_20260811",
    "file": "fn_split_leave_daily_limit_find.js",
    "sha256": "bee0f2c1b31ac47df3e11efc48fe2445eb92f2864668211a84995c76290099a0"
  },
  {
    "id": "lk_split_leave_daily_limit_route_20260811",
    "file": "fn_split_leave_daily_limit_route.js",
    "sha256": "fa66bc2dab9ed9e6106129483bf44a8d61e28496b18c697b762cbaf26ded1ac6"
  },
  {
    "id": "lk_split_leave_game_update_build_20260801",
    "file": "fn_split_leave_game_update.js",
    "sha256": "fa40192d2fd5373c06c0a7c47350994ab55235e39279f0f41347856b20c7d040"
  },
  {
    "id": "lk_split_leave_operation_route_20260801",
    "file": "fn_split_leave_operation_route.js",
    "sha256": "d5649238cb4cbcd22cd72edafcea0b57691ac7d7a981e8b83d15a2218706326d"
  },
  {
    "id": "lk_split_leave_operation_start_build_20260801",
    "file": "fn_split_leave_operation_start.js",
    "sha256": "c7b8b2be039439417898e8217787c8aa9cdb15407204102b54acb4a9c9434359"
  },
  {
    "id": "lk_split_leave_operation_viva_build_20260801",
    "file": "fn_split_leave_operation_viva_confirmed.js",
    "sha256": "3306759ab7ecac3e434b1dd88fcb7a70c01f267f009060277237fff0a3f21b0d"
  },
  {
    "id": "lk_split_leave_retry_hydrate_20260801",
    "file": "fn_split_leave_retry_hydrate.js",
    "sha256": "dee3c8838ecda2d78418b6383d03365b387be7f02696187d2abb4101d9d34cbf"
  },
  {
    "id": "lk_split_leave_retry_select_20260801",
    "file": "fn_split_leave_retry_select.js",
    "sha256": "01cbc9a774dff77e86deb3a5dd6f85d8e237d865be4e13c94805b09476fa82ab"
  },
  {
    "id": "9878400d518ebcbd",
    "file": "fn_split_leave_router.js",
    "sha256": "ae0819a6083ed9d264d719ea0414b3ca43db4aa093d78818929a147ed2475de4"
  }
];

export function buildCandidate(liveBytes) {
  if (sha256(liveBytes) !== SOURCE_SHA256) throw new Error("Live flow preimage drift");
  const candidate = JSON.parse(liveBytes);
  for (const target of TARGETS) {
    const nodes = candidate.filter((node) => node.id === target.id);
    if (nodes.length !== 1 || nodes[0].type !== "function" || sha256(nodes[0].func) !== target.sha256) {
      throw new Error("Leave function preimage drift");
    }
    const source = fs.readFileSync(new URL(`./nodered_games_nodes/${target.file}`, import.meta.url), "utf8");
    new vm.Script(`(function(msg,node,context,flow,global,env){\n${source}\n})`);
    nodes[0].func = source;
  }
  const candidateBytes = Buffer.from(JSON.stringify(candidate, null, 2) + "\n");
  const args = { liveBytes, candidateBytes, deploymentId: "split-leave-local-reconciliation-20260909", allowedNodeIds: TARGETS.map((target) => target.id) };
  const contract = buildFunctionOnlyContract(args);
  validateFunctionOnlyContract({ liveBytes, candidateBytes, contract });
  const reverse = buildFunctionOnlyContract({ ...args, liveBytes: candidateBytes, candidateBytes: liveBytes });
  validateFunctionOnlyContract({ liveBytes: candidateBytes, candidateBytes: liveBytes, contract: reverse });
  return { candidateBytes, contract, reverse };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  if (process.argv.length !== 4 || process.argv[2] !== "--workspace") throw new Error("Usage: --workspace <fresh-private-live-workspace>");
  const verified = verifyWorkspace(process.argv[3], { quiet: true });
  const result = buildCandidate(fs.readFileSync(verified.sourcePath));
  const output = path.join(verified.workspace, "build-leave-reconciliation");
  fs.mkdirSync(output, { mode: 0o700 });
  for (const [name, bytes] of Object.entries({
    "candidate.flow.json": result.candidateBytes,
    "contract.json": JSON.stringify(result.contract, null, 2) + "\n",
    "structural-reverse.contract.json": JSON.stringify(result.reverse, null, 2) + "\n",
  })) fs.writeFileSync(path.join(output, name), bytes, { mode: 0o600, flag: "wx" });
  console.log(JSON.stringify({ sourceSha256: SOURCE_SHA256, candidateSha256: sha256(result.candidateBytes), changedFunctions: TARGETS.length, deploymentPerformed: false }));
}
