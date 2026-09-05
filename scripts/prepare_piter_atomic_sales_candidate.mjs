#!/usr/bin/env node

import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { verifyWorkspace } from "./verify_nodered_source_origin.mjs";
import { buildExactGraphContract, validateExactGraphContract } from "./nodered_reviewed_flow_deploy/runtime_contract.mjs";
import {
  assertPiterAtomicTopology,
  PITER_ATOMIC_BINDING_INITIALIZER_SOURCE,
  PITER_ATOMIC_ERROR_SOURCE,
  PITER_ATOMIC_TOPOLOGY_IDS,
} from "./lib/piterAtomicTopologyContract.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const FN_DIR = path.join(ROOT, "scripts/nodered_games_nodes");
const TAB = "f9575c8726e29196";
const DEPLOYMENT_ID = "piter-atomic-sales-20260903";
const IDS = Object.freeze({
  status: "c165e43eba668c25",
  prepare: "91dded2dc8cfebe4",
  limit: "f8679e53edadc39b",
  confirmResolve: "ca022fd14027a5b0",
  viva: "fdc3f25f39199546",
  purchaseRouter: "566ae4b886c37ae5",
  response: "10fe94a32b8adc35",
  debug: "03cc3ac17f7e154a",
  atomicRouter: "piter_atomic_router_20260903",
  ledgerFind: "piter_ledger_find_20260903",
  ledgerUpdate: "piter_ledger_update_20260903",
  saleUpdate: "piter_sale_update_20260903",
  mongoCatch: "piter_atomic_catch_20260903",
  mongoError: "piter_atomic_error_20260903",
});
const TARGETS = [
  [IDS.status, "Build tournament subscription status", "fn_tournament_subscription_status_response.js", "f7e9d81975e63a090ad47abe54c07ed9db265fccf114ab7758f3b102ed0007e0"],
  [IDS.prepare, "Prepare tournament subscription purchase", "fn_tournament_subscription_purchase_prepare.js", "2f15053bdf2c8abd770b7bc65cd59d6fdcfc2c08f26c2ee78a95bc309dfe5ca3"],
  [IDS.limit, "Check tournament subscription limit", "fn_tournament_subscription_purchase_limit.js", "75d070b427ca9097cd258a84daca7b2c3998f545415b69ef4968ccdce2aaeef8"],
  [IDS.confirmResolve, "Resolve tournament subscription confirm", "fn_tournament_subscription_confirm_resolve.js", "7a868bc5d6fd0547904ae774e033ed3103d15d7398bda9d5a9146464bbbfcdab"],
  [IDS.purchaseRouter, "Route tournament subscription payment", "fn_tournament_subscription_purchase_router.js", "27b54a9e4204bd39951cae8e2194a60af5c3f3fc58edd85ceea76f56ff17deb2"],
];
const sha256 = (value) => crypto.createHash("sha256").update(value).digest("hex");
const fail = (message) => { throw new Error(message); };
const args = process.argv.slice(2);
if (args.length !== 2 || args[0] !== "--workspace") fail("Usage: --workspace /absolute/fresh-live-workspace");
const verified = verifyWorkspace(args[1], { quiet: true });
const liveBytes = fs.readFileSync(verified.sourcePath);
const candidate = structuredClone(verified.source);
const byId = new Map(candidate.map((node) => [node.id, node]));
const changed = [];
for (const [id, name, sourceFile, preimage] of TARGETS) {
  const node = byId.get(id);
  if (!node || node.type !== "function" || node.z !== TAB || node.name !== name) fail(`Target identity mismatch: ${id}`);
  if (sha256(String(node.func || "")) !== preimage) fail(`Target preimage mismatch: ${id}`);
  node.func = fs.readFileSync(path.join(FN_DIR, sourceFile), "utf8");
  changed.push({ id, fields: ["func"] });
}
const purchaseRouter = byId.get(IDS.purchaseRouter);
if (purchaseRouter.outputs !== 4 || purchaseRouter.wires.length !== 4) fail("Purchase router topology preimage mismatch");
purchaseRouter.outputs = 5;
purchaseRouter.wires = [...purchaseRouter.wires, [IDS.atomicRouter]];
changed.find((item) => item.id === IDS.purchaseRouter).fields.push("outputs", "wires");

const clientNode = "4e820638cc39c730";
const atomicFunc = fs.readFileSync(path.join(FN_DIR, "fn_tournament_subscription_piter_atomic_router.js"), "utf8");
const errorFunc = PITER_ATOMIC_ERROR_SOURCE;
const additions = [
  { id: IDS.atomicRouter, type: "function", z: TAB, name: "Route atomic Piter subscription sale", func: atomicFunc, outputs: 5, timeout: "", noerr: 0, initialize: PITER_ATOMIC_BINDING_INITIALIZER_SOURCE, finalize: "", libs: [], x: 2750, y: 2240, wires: [[IDS.ledgerFind], [IDS.ledgerUpdate], [IDS.saleUpdate], [IDS.response], [IDS.viva]] },
  { id: IDS.ledgerFind, type: "mongodb4", z: TAB, clientNode, mode: "collection", collection: "lk_tournament_subscription_sales", operation: "find", output: "toArray", maxTimeMS: "5000", handleDocId: false, name: "Find Piter atomic inventory ledger", x: 3140, y: 2180, wires: [[IDS.atomicRouter]] },
  { id: IDS.ledgerUpdate, type: "mongodb4", z: TAB, clientNode, mode: "collection", collection: "lk_tournament_subscription_sales", operation: "updateOne", output: "toArray", maxTimeMS: "5000", handleDocId: false, name: "CAS Piter atomic inventory ledger", x: 3140, y: 2220, wires: [[IDS.atomicRouter]] },
  { id: IDS.saleUpdate, type: "mongodb4", z: TAB, clientNode, mode: "collection", collection: "lk_tournament_subscription_sales", operation: "updateOne", output: "toArray", maxTimeMS: "5000", handleDocId: false, name: "Persist Piter atomic sale", x: 3140, y: 2260, wires: [[IDS.atomicRouter]] },
  { id: IDS.mongoCatch, type: "catch", z: TAB, name: "Catch Piter atomic Mongo errors", scope: [IDS.ledgerFind, IDS.ledgerUpdate, IDS.saleUpdate], uncaught: false, x: 2780, y: 2320, wires: [[IDS.mongoError]] },
  { id: IDS.mongoError, type: "function", z: TAB, name: "Redact Piter atomic Mongo error", func: errorFunc, outputs: 2, timeout: "", noerr: 0, initialize: "", finalize: "", libs: [], x: 3150, y: 2320, wires: [[IDS.response], [IDS.debug]] },
];
candidate.push(...additions);
if (Object.entries(PITER_ATOMIC_TOPOLOGY_IDS).some(([key, id]) => !["tab", "mongoClient"].includes(key) && IDS[key] !== id)) {
  fail("Piter atomic topology identifiers drifted from the shared contract");
}
assertPiterAtomicTopology(candidate);
const candidateBytes = Buffer.from(`${JSON.stringify(candidate, null, 2)}\n`, "utf8");
const contract = buildExactGraphContract({
  liveBytes,
  candidateBytes,
  deploymentId: DEPLOYMENT_ID,
  allowedChanges: changed,
  allowedAdditionIds: additions.map(({ id }) => id),
});
validateExactGraphContract({ liveBytes, candidateBytes, contract });
const buildDir = path.join(verified.workspace, "build-piter-atomic");
if (fs.existsSync(buildDir)) fail("Piter atomic build directory already exists");
fs.mkdirSync(buildDir, { mode: 0o700 });
fs.writeFileSync(path.join(buildDir, "candidate.flow.json"), candidateBytes, { mode: 0o600, flag: "wx" });
fs.writeFileSync(path.join(buildDir, "reviewed-flow.contract.json"), `${JSON.stringify(contract, null, 2)}\n`, { mode: 0o600, flag: "wx" });
const report = {
  launchQuotaSchemaVersion: 2,
  ok: true, deploymentId: DEPLOYMENT_ID, sourceSha256: contract.sourceSha256,
  candidateSha256: contract.candidateSha256, sourceNodeCount: contract.sourceNodeCount,
  candidateNodeCount: contract.candidateNodeCount, httpInputCount: contract.httpInputCount,
  ledgerActivationRequired: true, deploymentPerformed: false, activationPerformed: false,
};
fs.writeFileSync(path.join(buildDir, "report.json"), `${JSON.stringify(report, null, 2)}\n`, { mode: 0o600, flag: "wx" });
process.stdout.write(`${JSON.stringify(report)}\n`);
