#!/usr/bin/env node

import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { isDeepStrictEqual } from "node:util";
import { verifyWorkspace } from "./verify_nodered_source_origin.mjs";

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const FN_DIR = path.join(SCRIPT_DIR, "nodered_games_nodes");
const EXPECTED_SOURCE_SHA256 = "ffe6020341a50755f8f83c35e3099cac87d3b9a6a3aaea6c8c8e9cc26a195ec4";
const EXPECTED_NODE_COUNT = 4667;
const EXPECTED_ROUTE_COUNT = 203;
const TAB_ID = "4b91e2a2413688db";

const ids = Object.freeze({
  patchRoute: "7ad34f13c4b25d60",
  patchRecordsRoute: "4cb1e542db56b508",
  patchPrepare: "e0d7883bc1a9fa8c",
  patchArgs: "b2a10027fc45966c",
  patchMongo: "591234d213742276",
  patchResponse: "e17f8a411d4dfa91",
  patchDebug: "3b822085d5f18e97",
  patchAutojoin: "5fc5eaeab97f3f88",
  functionTemplate: "9878400d518ebcbd",
  patchCasGuard: "lk_game_patch_cas_guard_20260801",
  patchCasQuery: "lk_game_patch_apply_cas_20260801",
  patchResponseGate: "lk_game_patch_response_gate_20260801",
  patchAutojoinGate: "lk_game_patch_autojoin_gate_20260801",
  patchAfterWrite: "lk_game_patch_after_write_20260801",
  patchCatch: "lk_game_patch_write_catch_20260801",
});

const expectedFunctionHashes = Object.freeze({
  "fn_patch_cas_guard.js": "11d21b951b916fc04fb815853c79ff64fcb58f777626a54988b06573a92da374",
  "fn_patch_cas_query.js": "17713e19d9f465a4b88fee8decb4c9e94402d51298239ecc0b22b91e90f6377d",
  "fn_patch_after_write.js": "e2316241b7148bdc8a76de725215d542e67c57681ee2e2efc51a0b58145c3d88",
  "fn_patch_response_gate.js": "551a50d6263f96fd65f69970a034d62d3ffe29d30ab5da6ec2e65c2f588173cd",
  "fn_patch_autojoin_gate.js": "551a50d6263f96fd65f69970a034d62d3ffe29d30ab5da6ec2e65c2f588173cd",
});

const sha256 = (value) => crypto.createHash("sha256").update(value).digest("hex");
const fail = (message) => { throw new Error(message); };
const readFn = (fileName) => fs.readFileSync(path.join(FN_DIR, fileName), "utf8");
const exactNode = (flow, id, type) => {
  const matches = flow.filter((node) => node?.id === id);
  if (matches.length !== 1 || matches[0].type !== type) fail(`Expected exact ${type} node ${id}`);
  return matches[0];
};
const changedFields = (before, after) => [...new Set([...Object.keys(before), ...Object.keys(after)])]
  .filter((field) => !isDeepStrictEqual(before[field], after[field]))
  .sort();
const functionNode = (template, id, name, func, outputs, wires, x, y) => ({
  ...structuredClone(template),
  id,
  name,
  func,
  outputs,
  wires,
  x,
  y,
});

export function buildPhase2CasCandidate(source) {
  if (!Array.isArray(source)) fail("Phase-two source must be a Node-RED flow array");
  const flow = structuredClone(source);
  const before = structuredClone(source);

  if (flow.length !== EXPECTED_NODE_COUNT) fail("Phase-one live node count mismatch");
  if (flow.filter((node) => node.type === "http in").length !== EXPECTED_ROUTE_COUNT) {
    fail("Phase-one live HTTP route count mismatch");
  }
  const tab = exactNode(flow, TAB_ID, "tab");
  if (tab.label !== "LK Games" || tab.disabled !== false) fail("LK Games tab contract mismatch");

  const patchRoute = exactNode(flow, ids.patchRoute, "http in");
  const patchRecordsRoute = exactNode(flow, ids.patchRecordsRoute, "http in");
  if (patchRoute.url !== "/lk/games/:gameId" || patchRoute.method !== "patch"
    || patchRecordsRoute.url !== "/lk/games/records/:gameId" || patchRecordsRoute.method !== "patch") {
    fail("PATCH route contract mismatch");
  }
  const patchPrepare = exactNode(flow, ids.patchPrepare, "function");
  const patchArgs = exactNode(flow, ids.patchArgs, "function");
  const patchMongo = exactNode(flow, ids.patchMongo, "mongodb4");
  exactNode(flow, ids.patchResponse, "http response");
  exactNode(flow, ids.patchDebug, "debug");
  exactNode(flow, ids.patchAutojoin, "mongodb4");
  const functionTemplate = exactNode(flow, ids.functionTemplate, "function");

  const phaseOneWires = new Map([
    [ids.patchRoute, [[ids.patchPrepare]]],
    [ids.patchRecordsRoute, [[ids.patchPrepare]]],
    [ids.patchPrepare, [[ids.patchArgs], [ids.patchResponse], [ids.patchDebug], [ids.patchAutojoin]]],
    [ids.patchArgs, [[ids.patchMongo]]],
    [ids.patchMongo, [[]]],
  ]);
  for (const [id, expected] of phaseOneWires) {
    const node = flow.find((item) => item.id === id);
    if (!node || !isDeepStrictEqual(node.wires, expected)) {
      fail(`Phase-one PATCH wire contract mismatch for ${id}`);
    }
  }

  for (const id of [
    ids.patchCasGuard,
    ids.patchCasQuery,
    ids.patchResponseGate,
    ids.patchAutojoinGate,
    ids.patchAfterWrite,
    ids.patchCatch,
  ]) {
    if (flow.some((node) => node.id === id)) fail(`Phase-two node already exists: ${id}`);
  }

  for (const [fileName, expectedHash] of Object.entries(expectedFunctionHashes)) {
    if (sha256(readFn(fileName)) !== expectedHash) fail(`Phase-two source mismatch for ${fileName}`);
  }

  patchRoute.wires = [[ids.patchCasGuard]];
  patchRecordsRoute.wires = [[ids.patchCasGuard]];
  patchPrepare.wires = [[ids.patchArgs], [ids.patchResponseGate], [ids.patchDebug], [ids.patchAutojoinGate]];
  patchArgs.wires = [[ids.patchCasQuery]];
  patchMongo.wires = [[ids.patchAfterWrite]];

  flow.push(
    functionNode(functionTemplate, ids.patchCasGuard, "Require game PATCH CAS", readFn("fn_patch_cas_guard.js"), 3, [
      [ids.patchPrepare], [ids.patchResponse], [ids.patchDebug],
    ], 520, 2320),
    functionNode(functionTemplate, ids.patchResponseGate, "Gate pre-CAS PATCH response", readFn("fn_patch_response_gate.js"), 1, [[ids.patchResponse]], 1000, 2360),
    functionNode(functionTemplate, ids.patchAutojoinGate, "Gate pre-CAS PATCH autojoin", readFn("fn_patch_autojoin_gate.js"), 1, [[ids.patchAutojoin]], 1000, 2420),
    functionNode(functionTemplate, ids.patchCasQuery, "Bind game PATCH CAS query", readFn("fn_patch_cas_query.js"), 1, [[ids.patchMongo]], 1240, 2320),
    functionNode(functionTemplate, ids.patchAfterWrite, "Acknowledge game PATCH CAS", readFn("fn_patch_after_write.js"), 3, [
      [ids.patchResponse], [ids.patchDebug], [ids.patchAutojoin],
    ], 1480, 2320),
    {
      id: ids.patchCatch,
      type: "catch",
      z: TAB_ID,
      name: "Catch game PATCH CAS write errors",
      scope: [ids.patchMongo],
      uncaught: false,
      x: 1240,
      y: 2480,
      wires: [[ids.patchAfterWrite]],
    },
  );

  const byId = new Map(flow.map((node) => [node.id, node]));
  if (byId.size !== flow.length) fail("Phase-two candidate contains duplicate node ids");
  for (const node of flow) {
    for (const targetId of (Array.isArray(node.wires) ? node.wires : []).flat()) {
      if (!byId.has(targetId)) fail(`Broken wire ${node.id} -> ${targetId}`);
    }
    if (node.type === "function" && Number.isInteger(node.outputs)
      && Array.isArray(node.wires) && node.wires.length !== node.outputs) {
      fail(`Function output/wire count mismatch for ${node.id}`);
    }
  }
  if (flow.filter((node) => node.type === "http in").length !== EXPECTED_ROUTE_COUNT) {
    fail("Phase-two candidate changed HTTP routes");
  }

  const changes = flow.flatMap((node) => {
    const previous = before.find((item) => item.id === node.id);
    if (!previous) return [{ id: node.id, kind: "added", changedFields: Object.keys(node).sort() }];
    if (isDeepStrictEqual(previous, node)) return [];
    return [{ id: node.id, kind: "changed", changedFields: changedFields(previous, node) }];
  });
  const allowedExisting = new Set([
    ids.patchRoute,
    ids.patchRecordsRoute,
    ids.patchPrepare,
    ids.patchArgs,
    ids.patchMongo,
  ]);
  for (const change of changes.filter((item) => item.kind === "changed")) {
    if (!allowedExisting.has(change.id) || !isDeepStrictEqual(change.changedFields, ["wires"])) {
      fail(`Unexpected existing-node change for ${change.id}: ${change.changedFields.join(",")}`);
    }
  }
  if (changes.filter((item) => item.kind === "changed").length !== 5
    || changes.filter((item) => item.kind === "added").length !== 6) {
    fail("Phase-two change budget mismatch");
  }

  return { flow, changes };
}

function parseArgs(argv) {
  const result = {};
  for (let index = 0; index < argv.length; index += 2) result[argv[index]] = argv[index + 1];
  if (!result["--workspace"] || !result["--output"] || !result["--report"]) {
    fail("Usage: --workspace <fresh-phase1-workspace> --output <candidate.json> --report <report.json>");
  }
  return result;
}

export function runPhase2CasBuild(argv) {
  const args = parseArgs(argv);
  const verified = verifyWorkspace(args["--workspace"], { quiet: true });
  if (verified.sourceSha256 !== EXPECTED_SOURCE_SHA256) fail("Phase-one live flow preimage SHA mismatch");
  const { flow, changes } = buildPhase2CasCandidate(verified.source);
  const outputPath = path.resolve(args["--output"]);
  const reportPath = path.resolve(args["--report"]);
  for (const target of [outputPath, reportPath]) {
    if (fs.existsSync(target)) fail(`Refusing to overwrite ${target}`);
    fs.mkdirSync(path.dirname(target), { recursive: true, mode: 0o700 });
  }
  const outputText = `${JSON.stringify(flow, null, 2)}\n`;
  fs.writeFileSync(outputPath, outputText, { mode: 0o600, flag: "wx" });
  const report = {
    rolloutPhase: "phase2-cas",
    sourceSha256: verified.sourceSha256,
    candidateSha256: sha256(outputText),
    sourceNodeCount: verified.nodeCount,
    candidateNodeCount: flow.length,
    httpRouteCount: EXPECTED_ROUTE_COUNT,
    changes,
    sourceFunctionContracts: Object.keys(expectedFunctionHashes).length,
    graphContract: {
      phaseOnePreimagePinned: true,
      patchCasAcknowledgementGate: true,
      legacyPatchCompatibilityRemoved: true,
      durableLeaveSagaPreserved: true,
    },
    deploymentPerformed: false,
  };
  fs.writeFileSync(reportPath, `${JSON.stringify(report, null, 2)}\n`, { mode: 0o600, flag: "wx" });
  return report;
}

const invokedPath = process.argv[1] ? fs.realpathSync(process.argv[1]) : "";
if (invokedPath === fileURLToPath(import.meta.url)) {
  try {
    console.log(JSON.stringify(runPhase2CasBuild(process.argv.slice(2))));
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
