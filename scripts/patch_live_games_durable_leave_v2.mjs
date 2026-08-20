#!/usr/bin/env node

import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { isDeepStrictEqual } from "node:util";
import { verifyWorkspace } from "./verify_nodered_source_origin.mjs";

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const FN_DIR = path.join(SCRIPT_DIR, "nodered_games_nodes");
const EXPECTED_SOURCE_SHA256 = "08d7c2f96fd4a4f5ed917a0c157024708965d53c92f6389dce84e02e4b31427e";
const EXPECTED_NODE_COUNT = 4707;
const EXPECTED_ROUTE_COUNT = 209;
const TAB_ID = "4b91e2a2413688db";

const ids = Object.freeze({
  operationRoute: "lk_split_leave_operation_route_20260801",
  operationStart: "lk_split_leave_operation_start_build_20260801",
  operationClaim: "lk_split_leave_operation_claim_build_20260801",
  operationDone: "lk_split_leave_operation_done_build_20260801",
  operationVivaBuild: "lk_split_leave_operation_viva_build_20260801",
  operationVivaAck: "lk_split_leave_operation_viva_ack_20260801",
  retryHydrate: "lk_split_leave_retry_hydrate_20260801",
  retrySelect: "lk_split_leave_retry_select_20260801",
  retryFindTemplate: "lk_split_leave_retry_operation_find_20260801",
  updateTemplate: "lk_split_leave_operation_viva_update_20260801",
  gameBuild: "lk_split_leave_game_update_build_20260801",
  doneBuild: "lk_split_leave_operation_done_build_20260801",
  retry: "lk_split_leave_retry_response_20260801",
  router: "9878400d518ebcbd",
  debug: "cf731009d4167f78",
  dailyFindBuild: "lk_split_leave_daily_limit_find_build_20260811",
  dailyFind: "lk_split_leave_daily_limit_find_20260811",
  dailyRoute: "lk_split_leave_daily_limit_route_20260811",
  dailyUpdate: "lk_split_leave_daily_limit_update_20260811",
  dailyAck: "lk_split_leave_daily_limit_ack_20260811",
  dailyCatch: "lk_split_leave_daily_limit_catch_20260811",
});

const expectedLiveFunctionHashes = Object.freeze({
  [ids.operationRoute]: "04823d77b494aac4870349d4c89f6c9f142c15b08f1623537c5933e0d0c8031f",
  [ids.operationStart]: "ecdf9de8fdf439bf5d6c5a0a925d51bad5975ad5e018f423a07991a402069b23",
  [ids.operationClaim]: "33473bed64b8a85da354e386adf95970e90dcd47492c17b3bbca20391924d6bb",
  [ids.operationDone]: "e790731745e62541c328b61f0739de23b3fe5a178005b7804ec73b3acde1749f",
  [ids.operationVivaBuild]: "1d63b8e5e5b69dac805cd8c22cafeb5bcd9e25ebb85ecacc1ae27842eb9021e6",
  [ids.operationVivaAck]: "b7d649b24426f52213bb5b9a08bd633162156a379e21ea55591bec8c628ca21e",
  [ids.retryHydrate]: "a5ddd5f07bdf7773901901f532578550036cf2308e67d1b93e6f4d8f5888bc25",
  [ids.retrySelect]: "a992603bc6fa816516c208a3e5aa342507e6ceeec326d25da057dec5b435cf77",
});

const expectedCandidateSourceHashes = Object.freeze({
  "fn_split_leave_operation_route.js": "d5649238cb4cbcd22cd72edafcea0b57691ac7d7a981e8b83d15a2218706326d",
  "fn_split_leave_operation_start.js": "c7b8b2be039439417898e8217787c8aa9cdb15407204102b54acb4a9c9434359",
  "fn_split_leave_operation_claim.js": "a0f74b5bb2f48a221eadb9bb374f81e847e7790bb3bbef22361dc123fc6f55ea",
  "fn_split_leave_operation_done.js": "1da535b7e4edfdf50568d9d8a713cd58a60c8ace010e5037d3eb4a00302e402c",
  "fn_split_leave_daily_limit_find.js": "bee0f2c1b31ac47df3e11efc48fe2445eb92f2864668211a84995c76290099a0",
  "fn_split_leave_daily_limit_route.js": "fa66bc2dab9ed9e6106129483bf44a8d61e28496b18c697b762cbaf26ded1ac6",
  "fn_split_leave_daily_limit_ack.js": "7e5abe293062a71cba10795c3579760a4976f9199d0dd617c57be7d246c20e98",
  "fn_split_leave_operation_viva_confirmed.js": "3306759ab7ecac3e434b1dd88fcb7a70c01f267f009060277237fff0a3f21b0d",
  "fn_split_leave_retry_select.js": "01cbc9a774dff77e86deb3a5dd6f85d8e237d865be4e13c94805b09476fa82ab",
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
const parseArgs = (argv) => {
  const parsed = {};
  for (let index = 0; index < argv.length; index += 2) parsed[argv[index]] = argv[index + 1];
  if (!parsed["--workspace"] || !parsed["--output"] || !parsed["--report"]) {
    fail("Usage: --workspace <verified-live-workspace> --output <candidate.json> --report <report.json>");
  }
  return parsed;
};

const args = parseArgs(process.argv.slice(2));
for (const [fileName, expectedHash] of Object.entries(expectedCandidateSourceHashes)) {
  if (sha256(readFn(fileName)) !== expectedHash) fail(`Candidate source mismatch for ${fileName}`);
}

const verified = verifyWorkspace(args["--workspace"], { quiet: true });
if (verified.sourceSha256 !== EXPECTED_SOURCE_SHA256) fail("Live flow preimage SHA mismatch");
if (verified.nodeCount !== EXPECTED_NODE_COUNT) fail("Live flow node count mismatch");
const flow = structuredClone(verified.source);
if (flow.filter((node) => node.type === "http in").length !== EXPECTED_ROUTE_COUNT) {
  fail("Live flow HTTP route count mismatch");
}
const tab = exactNode(flow, TAB_ID, "tab");
if (tab.label !== "LK Games" || tab.disabled !== false) fail("LK Games tab contract mismatch");
const before = structuredClone(flow);

const operationRoute = exactNode(flow, ids.operationRoute, "function");
const operationStart = exactNode(flow, ids.operationStart, "function");
const operationClaim = exactNode(flow, ids.operationClaim, "function");
const operationDone = exactNode(flow, ids.operationDone, "function");
const operationVivaBuild = exactNode(flow, ids.operationVivaBuild, "function");
const operationVivaAck = exactNode(flow, ids.operationVivaAck, "function");
const retryHydrate = exactNode(flow, ids.retryHydrate, "function");
const retrySelect = exactNode(flow, ids.retrySelect, "function");
for (const node of [operationRoute, operationStart, operationClaim, operationDone, operationVivaBuild, operationVivaAck, retryHydrate, retrySelect]) {
  if (sha256(String(node.func || "")) !== expectedLiveFunctionHashes[node.id]) {
    fail(`Function preimage mismatch for ${node.id}`);
  }
}
if (!isDeepStrictEqual(operationVivaAck.wires, [
  [ids.gameBuild], [ids.retry], [ids.doneBuild],
])) fail("Viva acknowledgement wire preimage mismatch");
if (!isDeepStrictEqual(retryHydrate.wires, [
  [ids.gameBuild], [ids.router], [ids.debug], [ids.doneBuild],
])) fail("Retry hydration wire preimage mismatch");

operationRoute.func = readFn("fn_split_leave_operation_route.js");
operationStart.func = readFn("fn_split_leave_operation_start.js");
operationClaim.func = readFn("fn_split_leave_operation_claim.js");
operationDone.func = readFn("fn_split_leave_operation_done.js");
operationVivaBuild.func = readFn("fn_split_leave_operation_viva_confirmed.js");
retrySelect.func = readFn("fn_split_leave_retry_select.js");
operationVivaAck.wires = [[ids.dailyFindBuild], [ids.retry], [ids.dailyFindBuild]];
retryHydrate.wires = [[ids.dailyFindBuild], [ids.router], [ids.debug], [ids.dailyFindBuild]];

const functionTemplate = operationRoute;
const findTemplate = exactNode(flow, ids.retryFindTemplate, "mongodb4");
const updateTemplate = exactNode(flow, ids.updateTemplate, "mongodb4");
const functionNode = (id, name, func, outputs, wires, x, y) => ({
  ...structuredClone(functionTemplate), id, name, func, outputs, wires, x, y,
});
const newNodes = [
  functionNode(
    ids.dailyFindBuild,
    "Find daily subscription claim after Viva leave",
    readFn("fn_split_leave_daily_limit_find.js"),
    3,
    [[ids.dailyFind], [ids.dailyRoute], [ids.retry]],
    4100,
    1260,
  ),
  {
    ...structuredClone(findTemplate),
    id: ids.dailyFind,
    name: "Read exact daily subscription claim",
    collection: "lk_subscription_daily_booking_ops",
    operation: "find",
    x: 4340,
    y: 1260,
    wires: [[ids.dailyRoute]],
  },
  functionNode(
    ids.dailyRoute,
    "Release daily subscription claim after Viva proof",
    readFn("fn_split_leave_daily_limit_route.js"),
    4,
    [[ids.dailyUpdate], [ids.gameBuild], [ids.doneBuild], [ids.retry]],
    4580,
    1260,
  ),
  {
    ...structuredClone(updateTemplate),
    id: ids.dailyUpdate,
    name: "Release exact daily subscription claim",
    collection: "lk_subscription_daily_booking_ops",
    operation: "updateOne",
    x: 4820,
    y: 1260,
    wires: [[ids.dailyAck]],
  },
  functionNode(
    ids.dailyAck,
    "Acknowledge daily subscription claim release",
    readFn("fn_split_leave_daily_limit_ack.js"),
    3,
    [[ids.gameBuild], [ids.doneBuild], [ids.retry]],
    5060,
    1260,
  ),
  {
    id: ids.dailyCatch,
    type: "catch",
    z: TAB_ID,
    name: "Catch daily subscription leave persistence errors",
    scope: [ids.dailyFind, ids.dailyUpdate],
    uncaught: false,
    x: 4820,
    y: 1320,
    wires: [[ids.retry]],
  },
];
for (const node of newNodes) {
  if (flow.some((current) => current.id === node.id)) fail(`New node id already exists: ${node.id}`);
  flow.push(node);
}

const byId = new Map(flow.map((node) => [node.id, node]));
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
  fail("Candidate changed HTTP routes");
}
if (flow.length !== EXPECTED_NODE_COUNT + newNodes.length) fail("Candidate node count mismatch");
for (const source of [
  operationRoute.func,
  operationStart.func,
  operationClaim.func,
  operationDone.func,
  operationVivaBuild.func,
  retrySelect.func,
  ...newNodes.filter((node) => node.type === "function").map((node) => node.func),
]) {
  if (/grant_type=password|password=|username=/i.test(String(source || ""))) {
    fail("Durable leave candidate contains a hardcoded credential path");
  }
}

const allowedChanges = new Map([
  [ids.operationRoute, ["func"]],
  [ids.operationStart, ["func"]],
  [ids.operationClaim, ["func"]],
  [ids.operationDone, ["func"]],
  [ids.operationVivaBuild, ["func"]],
  [ids.operationVivaAck, ["wires"]],
  [ids.retryHydrate, ["wires"]],
  [ids.retrySelect, ["func"]],
]);
const changes = flow.flatMap((node) => {
  const previous = before.find((item) => item.id === node.id);
  if (!previous) return [{ id: node.id, kind: "added", changedFields: Object.keys(node).sort() }];
  if (isDeepStrictEqual(previous, node)) return [];
  return [{ id: node.id, kind: "changed", changedFields: changedFields(previous, node) }];
});
for (const change of changes.filter((item) => item.kind === "changed")) {
  if (!isDeepStrictEqual(change.changedFields, allowedChanges.get(change.id))) {
    fail(`Unexpected existing-node change for ${change.id}: ${change.changedFields.join(",")}`);
  }
}
if (changes.length !== allowedChanges.size + newNodes.length) fail("Unexpected candidate change count");

const outputPath = path.resolve(args["--output"]);
const reportPath = path.resolve(args["--report"]);
for (const target of [outputPath, reportPath]) {
  if (fs.existsSync(target)) fail(`Refusing to overwrite ${target}`);
  fs.mkdirSync(path.dirname(target), { recursive: true, mode: 0o700 });
}
const outputText = `${JSON.stringify(flow, null, 2)}\n`;
fs.writeFileSync(outputPath, outputText, { mode: 0o600, flag: "wx" });
const report = {
  sourceSha256: verified.sourceSha256,
  candidateSha256: sha256(outputText),
  sourceNodeCount: verified.nodeCount,
  candidateNodeCount: flow.length,
  routeCount: EXPECTED_ROUTE_COUNT,
  changes,
};
fs.writeFileSync(reportPath, `${JSON.stringify(report, null, 2)}\n`, { mode: 0o600, flag: "wx" });
console.log(JSON.stringify(report, null, 2));
