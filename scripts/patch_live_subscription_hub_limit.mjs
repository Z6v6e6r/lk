#!/usr/bin/env node

// Focused Node-RED generation: read the annual HUB daily seat count from
// configuration instead of hard-coding it in four counter nodes. Only the four
// function bodies change; topology, routes and every other node stay identical.
//
// This is preparation only. It never deploys, imports, restarts or activates
// anything, and it fails closed unless the supplied preimage is exactly the
// reviewed live flow.

import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { isDeepStrictEqual } from "node:util";
import { buildExactGraphContract, validateReviewedFlowContract } from "./nodered_reviewed_flow_deploy/runtime_contract.mjs";
import { verifyWorkspace } from "./verify_nodered_source_origin.mjs";

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const FN_DIR = path.join(SCRIPT_DIR, "nodered_games_nodes");
const TAB_ID = "f9575c8726e29196";
export const HUB_LIMIT_DEPLOYMENT_ID = "subscription-hub-daily-limit-20260911";

// Exact live preimage this generation was reviewed against (pull-147,
// 2026-09-11T10:00:52Z). Any other preimage is rejected before composing.
export const HUB_LIMIT_LIVE_CONTRACT = Object.freeze({
  sourceSha256: "2ace2b60d0e246e84d5b9a542f6022ea1f7788c945dd855339e0ff0e47c09438",
  nodeCount: 4799,
  httpInputCount: 219,
});

export const HUB_LIMIT_TARGETS = Object.freeze([
  Object.freeze({ id: "8fdc7076a0c436a2", name: "Prepare tournament subscription status", fileName: "fn_tournament_subscription_status_prepare.js", outputs: 3,
    liveSha256: "8bbeee82bb309ee2a899c8b9a5b0e59090aaec58a7df1938eb19d9dab722f614", candidateSha256: "752ebf525a267ab86b9a9aa0c63dd8f5c7de6e023d34e21f0c2641d52cb5fcd2" }),
  Object.freeze({ id: "c165e43eba668c25", name: "Build tournament subscription status", fileName: "fn_tournament_subscription_status_response.js", outputs: 2,
    liveSha256: "bd5be3995b53fc6b013ba11635402ecaa3d840b8f78e3543a16115d01c7d8f5f", candidateSha256: "cf4beffffedcd2fb8efaa2efff6564cdbf2d8417c9d71d9305d8533448c69d3d" }),
  Object.freeze({ id: "91dded2dc8cfebe4", name: "Prepare tournament subscription purchase", fileName: "fn_tournament_subscription_purchase_prepare.js", outputs: 3,
    liveSha256: "4fe051ed4204265ad4cb5896b1bfbfd1afd4f0a247a763e6c2ad680fb8cb9b91", candidateSha256: "7d8e8e1f067e46845824f86471749565c9dde83b48e8915480ea0f92af049004" }),
  Object.freeze({ id: "519b6a6ca208e281", name: "Prepare tournament subscription counter refresh", fileName: "fn_tournament_subscription_counter_refresh_prepare.js", outputs: 1,
    liveSha256: "204fd921dda914fec7d99f3b952ef33d1fcbe22b0b896dec215e7448da9e02b2", candidateSha256: "bd6332ca15aa62b639f91ece36eafe76b7465a078d68312d33996666ff38f0a4" }),
]);

const sha256 = (value) => crypto.createHash("sha256").update(value).digest("hex");
const fail = (message) => { throw new Error(message); };
const changedFields = (before, after) => [...new Set([...Object.keys(before), ...Object.keys(after)])]
  .filter((key) => !isDeepStrictEqual(before[key], after[key]));
const httpInputs = (nodes) => nodes.filter((node) => node.type === "http in")
  .map((node) => `${node.id}\u0000${node.method || ""}\u0000${node.url || ""}`).sort();

export function buildFocusedHubLimitCandidate(liveBytes, targets = HUB_LIMIT_TARGETS) {
  if (!Buffer.isBuffer(liveBytes) && !Array.isArray(liveBytes)) fail("Live preimage bytes are required");
  const bytes = Buffer.isBuffer(liveBytes) ? liveBytes : Buffer.from(`${JSON.stringify(liveBytes, null, 2)}\n`);
  const source = JSON.parse(bytes.toString("utf8"));
  if (!Array.isArray(source)) fail("Node-RED source must be an array");
  const flow = structuredClone(source);
  const beforeById = new Map(source.map((node) => [node.id, node]));
  const flowById = new Map(flow.map((node) => [node.id, node]));
  if (beforeById.size !== source.length || flowById.size !== flow.length) fail("Duplicate node ids");

  for (const target of targets) {
    const before = beforeById.get(target.id);
    const node = flowById.get(target.id);
    if (!before || !node || before.type !== "function" || before.z !== TAB_ID
      || before.name !== target.name || before.outputs !== target.outputs
      || !Array.isArray(before.wires) || before.wires.length !== target.outputs) {
      fail(`Target node contract mismatch: ${target.id}`);
    }
    if (sha256(String(before.func || "")) !== target.liveSha256) {
      fail(`Live function preimage changed: ${target.id}`);
    }
    const candidateSource = fs.readFileSync(path.join(FN_DIR, target.fileName), "utf8");
    if (sha256(candidateSource) !== target.candidateSha256) {
      fail(`Candidate source changed: ${target.fileName}`);
    }
    new Function("msg", "global", "env", candidateSource);
    node.func = candidateSource;
  }

  const changes = flow.flatMap((node) => {
    const before = beforeById.get(node.id);
    if (isDeepStrictEqual(before, node)) return [];
    return [{ id: node.id, name: node.name, fields: changedFields(before, node) }];
  });
  const targetIds = new Set(targets.map((target) => target.id));
  if (changes.length !== targets.length
    || changes.some((change) => !targetIds.has(change.id)
      || !isDeepStrictEqual(change.fields, ["func"]))) {
    fail("Focused change budget mismatch");
  }
  if (!isDeepStrictEqual(httpInputs(source), httpInputs(flow))) fail("HTTP inputs changed");
  for (const node of flow) {
    for (const targetId of (Array.isArray(node.wires) ? node.wires : []).flat()) {
      if (!flowById.has(targetId)) fail(`Broken wire ${node.id} -> ${targetId}`);
    }
    if ((node.type === "link in" || node.type === "link out") && Array.isArray(node.links)) {
      for (const targetId of node.links) if (!flowById.has(targetId)) fail(`Broken link ${node.id} -> ${targetId}`);
    }
  }

  const candidateBytes = Buffer.from(`${JSON.stringify(flow, null, 2)}\n`);
  const contract = buildExactGraphContract({
    liveBytes: bytes,
    candidateBytes,
    deploymentId: HUB_LIMIT_DEPLOYMENT_ID,
    allowedChanges: changes.map((change) => ({ id: change.id, fields: change.fields })),
    allowedAdditionIds: [],
  });
  validateReviewedFlowContract({ liveBytes: bytes, candidateBytes, contract });
  return {
    flow,
    candidateBytes,
    importNodes: targets.map((target) => structuredClone(flowById.get(target.id))),
    changes,
    contract,
  };
}

export function assertHubLimitLiveBaseline(verified) {
  if (verified.sourceSha256 !== HUB_LIMIT_LIVE_CONTRACT.sourceSha256
    || verified.nodeCount !== HUB_LIMIT_LIVE_CONTRACT.nodeCount) {
    fail("Fresh live source baseline changed");
  }
  if (verified.source.filter((node) => node.type === "http in").length !== HUB_LIMIT_LIVE_CONTRACT.httpInputCount) {
    fail("Fresh live HTTP input count changed");
  }
  const tabs = verified.source.filter((node) => node.id === TAB_ID && node.type === "tab");
  if (tabs.length !== 1 || tabs[0].label !== "LK Tournaments" || tabs[0].disabled === true) {
    fail("LK Tournaments tab contract mismatch");
  }
  return true;
}

function parseArgs(argv) {
  const values = {};
  for (let index = 0; index < argv.length; index += 2) {
    const key = argv[index];
    const value = argv[index + 1];
    if (!key?.startsWith("--") || !value || value.startsWith("--") || values[key]) fail("Invalid arguments");
    values[key] = value;
  }
  const allowed = new Set(["--workspace", "--output", "--import", "--report"]);
  if (Object.keys(values).some((key) => !allowed.has(key))
    || [...allowed].some((key) => !values[key])) {
    fail("Usage: --workspace <fresh-live-workspace> --output <candidate.json> --import <nodes.json> --report <report.json>");
  }
  return values;
}

function prepareTargets(workspace, paths) {
  const resolved = paths.map((value) => path.resolve(value));
  if (new Set(resolved).size !== resolved.length) fail("Output paths must be distinct");
  for (const target of resolved) {
    const relative = path.relative(workspace, target);
    if (!relative || relative.startsWith("..") || path.isAbsolute(relative)) fail("Outputs must stay inside the live workspace");
    if (fs.existsSync(target) || fs.lstatSync(path.dirname(target), { throwIfNoEntry: false })?.isSymbolicLink()) {
      fail(`Refusing unsafe or existing output: ${target}`);
    }
  }
  const outputDirectory = path.dirname(resolved[0]);
  if (!resolved.every((target) => path.dirname(target) === outputDirectory)) fail("Outputs must share one directory");
  if (path.dirname(outputDirectory) !== workspace || path.basename(outputDirectory) !== "candidate-hub-limit") {
    fail("Outputs must use the workspace candidate-hub-limit directory");
  }
  fs.mkdirSync(outputDirectory, { recursive: true, mode: 0o700 });
  fs.chmodSync(outputDirectory, 0o700);
  if (fs.realpathSync(outputDirectory) !== outputDirectory) fail("Candidate output directory must be canonical");
  return resolved;
}

function main(argv) {
  const args = parseArgs(argv);
  const verified = verifyWorkspace(args["--workspace"], { quiet: true });
  assertHubLimitLiveBaseline(verified);

  const liveBytes = fs.readFileSync(verified.sourcePath);
  const built = buildFocusedHubLimitCandidate(liveBytes);
  if (built.contract.sourceSha256 !== verified.sourceSha256) {
    fail("Live source changed between verification and composition");
  }
  const [outputPath, importPath, reportPath] = prepareTargets(verified.workspace, [
    args["--output"], args["--import"], args["--report"],
  ]);
  const outputText = built.candidateBytes.toString("utf8");
  const importText = `${JSON.stringify(built.importNodes, null, 2)}\n`;
  const report = {
    kind: "FOCUSED_SUBSCRIPTION_HUB_LIMIT_GENERATION_V1",
    deploymentId: HUB_LIMIT_DEPLOYMENT_ID,
    sourceSha256: verified.sourceSha256,
    candidateSha256: sha256(outputText),
    importSha256: sha256(importText),
    sourceNodeCount: verified.nodeCount,
    candidateNodeCount: built.flow.length,
    httpInputCount: HUB_LIMIT_LIVE_CONTRACT.httpInputCount,
    changedNodeCount: built.changes.length,
    changes: built.changes,
    contract: built.contract,
    topologyChanged: false,
    routesChanged: false,
    deploymentPerformed: false,
    activationPerformed: false,
  };
  fs.writeFileSync(outputPath, outputText, { encoding: "utf8", mode: 0o600, flag: "wx" });
  fs.writeFileSync(importPath, importText, { encoding: "utf8", mode: 0o600, flag: "wx" });
  fs.writeFileSync(reportPath, `${JSON.stringify(report, null, 2)}\n`, { encoding: "utf8", mode: 0o600, flag: "wx" });
  console.log(JSON.stringify(report));
}

const invokedPath = process.argv[1] ? fs.realpathSync(process.argv[1]) : "";
if (invokedPath === fileURLToPath(import.meta.url)) {
  try {
    main(process.argv.slice(2));
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
