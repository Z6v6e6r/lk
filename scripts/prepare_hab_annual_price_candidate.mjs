#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import vm from "node:vm";
import { fileURLToPath } from "node:url";
import { verifyWorkspace, assertFlowArray } from "./verify_nodered_source_origin.mjs";
import { sha256, buildExactGraphContract, validateExactGraphContract } from "./nodered_reviewed_flow_deploy/runtime_contract.mjs";

const sourceDir = new URL("./nodered_games_nodes/", import.meta.url);
const binding = JSON.parse(fs.readFileSync(new URL("./subscription_sale_opening_binding.json", import.meta.url)));
const preimages = Object.freeze({
  "8fdc7076a0c436a2": "34de1450d02fb20d3116394882ff4e1da284c3ee8ea3adf221a1cb1699ecc642",
  "c165e43eba668c25": "b827edf10d0ae3132f01bf3cd34d7e8990a1b27b1198a3d77c8c063f6a6fd2e6",
  "91dded2dc8cfebe4": "7dbf111802d3c1f7f30e3e82d2f19259a613991142fcfcc37743dbef33e800cf",
  "519b6a6ca208e281": "213f527a8f3ea83341cecc426ca4aca74c14a543674b4af9762db04bee425f58",
});
const initNodeId = "8fdc7076a0c436a2";
const deploymentId = "hab-price-98000-20260909";
const fail = message => { throw new Error("HAB price candidate blocked: " + message); };

export function buildHabAnnualPriceCandidate(liveBytes) {
  const live = JSON.parse(Buffer.from(liveBytes).toString("utf8"));
  assertFlowArray(live);
  const candidate = structuredClone(live);
  const changes = [];
  for (const [id, beforeHash] of Object.entries(preimages)) {
    const target = binding.targets.find(t => t.id === id);
    const node = candidate.find(n => n.id === id);
    if (!node || node.type !== "function" || node.z !== "f9575c8726e29196"
      || node.name !== target.name || node.outputs !== target.outputs
      || sha256(node.func) !== beforeHash) fail("target preimage drift: " + id);
    const code = fs.readFileSync(new URL(target.file, sourceDir), "utf8");
    if (sha256(code) !== target.candidateSha256) fail("replacement drift: " + id);
    new vm.Script("(function(msg,node,context,flow,global,env){\n" + code + "\n})");
    node.func = code;
    const fields = ["func"];
    if (id === initNodeId) {
      if (node.initialize !== "") fail("initializer preimage drift");
      node.initialize = fs.readFileSync(new URL("init_hab_annual_price_98000.js", sourceDir), "utf8");
      new vm.Script("(function(global){\n" + node.initialize + "\n})");
      fields.push("initialize");
    }
    changes.push({ id, fields });
  }
  const candidateBytes = Buffer.from(JSON.stringify(candidate, null, 2) + "\n");
  const args = { liveBytes, candidateBytes, deploymentId, allowedChanges: changes, allowedAdditionIds: [] };
  const contract = buildExactGraphContract(args);
  validateExactGraphContract({ ...args, contract });
  const reverse = buildExactGraphContract({ ...args, liveBytes: candidateBytes, candidateBytes: liveBytes });
  validateExactGraphContract({ liveBytes: candidateBytes, candidateBytes: liveBytes, contract: reverse });
  return { candidateBytes, contract, reverse, report: {
    ok: true, deploymentId, sourceSha256: sha256(liveBytes), candidateSha256: sha256(candidateBytes),
    nodeCount: live.length, changedNodeCount: changes.length, addedNodeCount: 0,
    priceMinor: 9800000, startupPriceEnabled: true, quotasChanged: false, admissionChanged: false,
    structuralReverseCheckPassed: true, deploymentPerformed: false,
    runtimePrecheckRequired: ["memory context store", "provider base override absent or 9800000", "Viva price 9800000"],
  } };
}

export function prepareHabAnnualPriceCandidate(argv) {
  if (argv.length !== 2 || argv[0] !== "--workspace") fail("Usage: --workspace /absolute/fresh-private-workspace");
  const verified = verifyWorkspace(argv[1], { quiet: true });
  const liveBytes = fs.readFileSync(verified.sourcePath);
  if (sha256(liveBytes) !== verified.sourceSha256) fail("source custody drift");
  const built = buildHabAnnualPriceCandidate(liveBytes);
  const out = path.join(verified.workspace, "build-hab-price");
  fs.mkdirSync(out, { mode: 0o700 });
  for (const [name, value] of Object.entries({ "candidate.flow.json": built.candidateBytes,
    "reviewed-flow.contract.json": JSON.stringify(built.contract, null, 2) + "\n",
    "structural-reverse.contract.json": JSON.stringify(built.reverse, null, 2) + "\n",
    "report.json": JSON.stringify(built.report, null, 2) + "\n" })) {
    fs.writeFileSync(path.join(out, name), value, { mode: 0o600, flag: "wx" });
  }
  return built.report;
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try { console.log(JSON.stringify(prepareHabAnnualPriceCandidate(process.argv.slice(2)))); }
  catch { console.error("HAB price candidate failed; no deployment performed."); process.exitCode = 1; }
}
