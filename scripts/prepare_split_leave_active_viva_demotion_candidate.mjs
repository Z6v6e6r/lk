#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import vm from "node:vm";
import { fileURLToPath } from "node:url";
import { verifyWorkspace } from "./verify_nodered_source_origin.mjs";
import { buildFunctionOnlyContract, validateFunctionOnlyContract, sha256 } from "./nodered_reviewed_flow_deploy/runtime_contract.mjs";

// Fresh read-only preimage pulled from lk-primary-147 (4799 nodes) at apply time.
export const SOURCE_SHA256 = "47bffbef103ae106e6cba8e0bc0378fbc26a6d2d1f448ac13ab659345ae1db8e";
export const DEPLOYMENT_ID = "split-leave-active-viva-demotion-20260911";

export const TARGETS = [
  {
    id: "016d6797a530ed0a",
    name: "Prepare split leave booking cancel",
    file: "fn_split_leave_prepare.js",
    liveSha256: "e2653faa2532f546dca497ef683c43b3bf26d3b151ae9b4ab24fb49898bf69d7",
    candidateSha256: "7cae69a101cd4810d7b8f7d487f3ef6e2dfd42ea7e2df3343b6a70cbcb49bc6b",
  },
  {
    id: "9878400d518ebcbd",
    name: "Route split leave booking cancel",
    file: "fn_split_leave_router.js",
    liveSha256: "c9fb27a4d34131175381335996b47530b90b9b83a5df80b0a89b6da671be3a25",
    candidateSha256: "4411495cc679ddde0724f8eda9aa1dcf8c06dcca1adf276df65422438b14d7c3",
  },
];

function readTargetSource(target) {
  return fs.readFileSync(new URL(`./nodered_games_nodes/${target.file}`, import.meta.url), "utf8");
}

export function buildCandidate(liveBytes) {
  if (sha256(liveBytes) !== SOURCE_SHA256) throw new Error("Live flow preimage drift");
  const candidate = JSON.parse(liveBytes);
  for (const target of TARGETS) {
    const nodes = candidate.filter((node) => node.id === target.id);
    if (nodes.length !== 1 || nodes[0].type !== "function" || sha256(nodes[0].func) !== target.liveSha256) {
      throw new Error(`Leave function preimage drift: ${target.id}`);
    }
    const source = readTargetSource(target);
    if (sha256(source) !== target.candidateSha256) throw new Error(`Tracked source drift: ${target.file}`);
    new vm.Script(`(function(msg,node,context,flow,global,env){\n${source}\n})`);
    nodes[0].func = source;
  }
  const candidateBytes = Buffer.from(JSON.stringify(candidate, null, 2) + "\n");
  const args = { liveBytes, candidateBytes, deploymentId: DEPLOYMENT_ID, allowedNodeIds: TARGETS.map((target) => target.id) };
  const contract = buildFunctionOnlyContract(args);
  validateFunctionOnlyContract({ liveBytes, candidateBytes, contract });
  const reverse = buildFunctionOnlyContract({ ...args, liveBytes: candidateBytes, candidateBytes: liveBytes });
  validateFunctionOnlyContract({ liveBytes: candidateBytes, candidateBytes: liveBytes, contract: reverse });
  return { candidateBytes, contract, reverse };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  if (process.argv.length !== 4 || process.argv[2] !== "--workspace") {
    throw new Error("Usage: --workspace <fresh-private-live-workspace>");
  }
  const verified = verifyWorkspace(process.argv[3], { quiet: true });
  const result = buildCandidate(fs.readFileSync(verified.sourcePath));
  const output = path.join(verified.workspace, "build-leave-active-viva-demotion");
  fs.mkdirSync(output, { mode: 0o700 });
  for (const [name, bytes] of Object.entries({
    "candidate.flow.json": result.candidateBytes,
    "contract.json": JSON.stringify(result.contract, null, 2) + "\n",
    "structural-reverse.contract.json": JSON.stringify(result.reverse, null, 2) + "\n",
  })) fs.writeFileSync(path.join(output, name), bytes, { mode: 0o600, flag: "wx" });
  console.log(JSON.stringify({
    sourceSha256: SOURCE_SHA256,
    candidateSha256: sha256(result.candidateBytes),
    changedFunctions: TARGETS.length,
    deploymentId: DEPLOYMENT_ID,
    deploymentPerformed: false,
  }));
}
