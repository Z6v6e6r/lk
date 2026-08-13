#!/usr/bin/env node

import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { isDeepStrictEqual } from "node:util";

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const FN_DIR = path.join(SCRIPT_DIR, "nodered_games_nodes");
const EXPECTED_SOURCE_SHA256 = "157e92c2b02a950f95a7ae609dbba637ea0baa61fa4b0f4cde01bec32f492bf1";
const EXPECTED_NODE_COUNT = 4724;
const EXPECTED_ROUTE_COUNT = 209;
const TAB_ID = "4b91e2a2413688db";

const ids = Object.freeze({
  response: "35f7c89069fc393a",
  debug: "cf731009d4167f78",
  gameFindTemplate: "7c280001a0c1e014",
  operationFindTemplate: "lk_split_leave_operation_find_20260801",
  operationStart: "lk_split_leave_operation_start_build_20260801",
  operationRoute: "lk_split_leave_operation_route_20260801",
  router: "9878400d518ebcbd",
  finalize: "lk_split_leave_finalize_20260801",
  retry: "lk_split_leave_retry_response_20260801",
  gameUpdate: "lk_split_leave_game_update_build_20260801",
  retrySelect: "lk_split_leave_retry_select_20260801",
  postRoute: "lk_staff_player_leave_post_20260812",
  postPrepare: "lk_staff_player_leave_prepare_20260812",
  postGameFind: "lk_staff_player_leave_game_find_20260812",
  postAuthorize: "lk_staff_player_leave_authorize_20260812",
  statusRoute: "lk_staff_player_leave_status_get_20260812",
  statusPrepare: "lk_staff_player_leave_status_prepare_20260812",
  statusFind: "lk_staff_player_leave_status_find_20260812",
  statusFormat: "lk_staff_player_leave_status_format_20260812",
  persistenceCatch: "lk_staff_player_leave_catch_20260812",
  persistenceError: "lk_staff_player_leave_error_20260812",
});

const sourceFunctions = Object.freeze({
  postPrepare: "fn_staff_player_leave_prepare.js",
  postAuthorize: "fn_staff_player_leave_authorize.js",
  statusPrepare: "fn_staff_player_leave_status_prepare.js",
  statusFormat: "fn_staff_player_leave_status.js",
  persistenceError: "fn_staff_player_leave_persistence_error.js",
  operationStart: "fn_split_leave_operation_start.js",
  operationRoute: "fn_split_leave_operation_route.js",
  router: "fn_split_leave_router.js",
  finalize: "fn_split_leave_finalize.js",
  retry: "fn_split_leave_retry_response.js",
  gameUpdate: "fn_split_leave_game_update.js",
  retrySelect: "fn_split_leave_retry_select.js",
});
const expectedLiveFunctionHashes = Object.freeze({
  [ids.operationStart]: "1c33e03da9aa2352ea8d2da379f787f710fb6fd402ceed095c9a636e8dcc33b9",
  [ids.operationRoute]: "7debcfa16929a4980d39e62e7550cbda70a9c794a8fad605d4bf6f429e30962e",
  [ids.router]: "6599a544983714e483ebc23d856c0b817b87440792c525dffc151ddd54dc9c43",
  [ids.finalize]: "ac1bcdf55f312248d7821c7f9436103d8c9db5c34e84e4ec5e9dcd7c904a4064",
  [ids.retry]: "73f20298daeeb8a952239d9e9591544fa795e3144129830af73e58732885bd68",
  [ids.gameUpdate]: "8111395a5e34319e122158ef347fa37a994346c19f7c00424817e2cb11366354",
  [ids.retrySelect]: "29c63bf42a71651dc8255969bbf2e430623fcfee41272e629630034c9266b954",
});
const expectedSourceHashes = Object.freeze({
  "fn_staff_player_leave_prepare.js": "757ba258f19f755c1724c8efa220a6a9271baa9a6e6c49111ce61feeeabf8053",
  "fn_staff_player_leave_authorize.js": "928f60aaa50bc1e25493ce4dd77429c8d9bc6e8a333115fbad530bae89cd090d",
  "fn_staff_player_leave_status_prepare.js": "b95000d99856cfd27e535b1689e3f61e444fca0f8a549e5bf0c499e249e37f39",
  "fn_staff_player_leave_status.js": "2a1dc413ae7544104d4d246df59f62d6ab105e4598a0888a6a40cc2345822076",
  "fn_staff_player_leave_persistence_error.js": "4618f2e3dba60ad85e8573cc3a50a43ea5c988c2c16e7d7f288c1cb74799ef0c",
  "fn_split_leave_operation_start.js": "25d73d9cac26469ff4e5bdc73b922e2d469db8939ea2114f1e60346cb0da21c0",
  "fn_split_leave_operation_route.js": "f62dd41ee4ffdeaa39ab61e1a413629d9ddb72b91945d6550f3859883ac03790",
  "fn_split_leave_router.js": "6d270142b759205835f67d14a3e7a21a6c4112b6418d60df4474834e928dd7fd",
  "fn_split_leave_finalize.js": "d245ae72f5b72319cdbe798a74a78216dd5c6a2c93391bf48a85fd47dc190719",
  "fn_split_leave_retry_response.js": "4f5229564a962f2cccfd5c18c69a67c960a9f0f3a55c13c6a9be609c308af3ba",
  "fn_split_leave_game_update.js": "f78d98c33ceab669f0db9844036c8ecb402d064f05506e55a5dd6aea5ca25203",
  "fn_split_leave_retry_select.js": "3b41205b4f3dce04e59d8757de6ccc1423a36e6f78c95f654e54448021b7d991",
});

const sha256 = (value) => crypto.createHash("sha256").update(value).digest("hex");
const fail = (message) => { throw new Error(message); };
const readFn = (key) => fs.readFileSync(path.join(FN_DIR, sourceFunctions[key]), "utf8");
const exactNode = (flow, id, type) => {
  const matches = flow.filter((node) => node?.id === id);
  if (matches.length !== 1 || matches[0].type !== type) fail(`Expected exact ${type} node ${id}`);
  return matches[0];
};
const parseArgs = (argv) => {
  const parsed = {};
  for (let index = 0; index < argv.length; index += 2) parsed[argv[index]] = argv[index + 1];
  if (!parsed["--source"] || !parsed["--output"] || !parsed["--report"]) {
    fail("Usage: --source <fresh-live-flow.json> --output <candidate.json> --report <report.json>");
  }
  return parsed;
};

const args = parseArgs(process.argv.slice(2));
for (const [fileName, hash] of Object.entries(expectedSourceHashes)) {
  const source = fs.readFileSync(path.join(FN_DIR, fileName), "utf8");
  if (sha256(source) !== hash) fail(`Candidate source mismatch for ${fileName}`);
}
const sourcePath = path.resolve(args["--source"]);
const sourceStat = fs.lstatSync(sourcePath);
if (!sourceStat.isFile() || sourceStat.isSymbolicLink() || sourceStat.nlink !== 1) {
  fail("Source must be a non-linked regular file");
}
const sourceText = fs.readFileSync(sourcePath, "utf8");
if (sha256(sourceText) !== EXPECTED_SOURCE_SHA256) fail("Live flow preimage SHA mismatch");
const flow = JSON.parse(sourceText);
if (!Array.isArray(flow) || flow.length !== EXPECTED_NODE_COUNT) fail("Live flow node count mismatch");
if (flow.filter((node) => node.type === "http in").length !== EXPECTED_ROUTE_COUNT) fail("Live route count mismatch");
const tab = exactNode(flow, TAB_ID, "tab");
if (tab.label !== "LK Games" || tab.disabled !== false) fail("LK Games tab contract mismatch");
const before = structuredClone(flow);

const operationStart = exactNode(flow, ids.operationStart, "function");
const operationRoute = exactNode(flow, ids.operationRoute, "function");
const router = exactNode(flow, ids.router, "function");
const finalize = exactNode(flow, ids.finalize, "function");
const retry = exactNode(flow, ids.retry, "function");
const gameUpdate = exactNode(flow, ids.gameUpdate, "function");
const retrySelect = exactNode(flow, ids.retrySelect, "function");
for (const node of [operationStart, operationRoute, router, finalize, retry, gameUpdate, retrySelect]) {
  if (sha256(String(node.func || "")) !== expectedLiveFunctionHashes[node.id]) {
    fail(`Durable function preimage mismatch for ${node.id}`);
  }
}
operationStart.func = readFn("operationStart");
operationRoute.func = readFn("operationRoute");
router.func = readFn("router");
finalize.func = readFn("finalize");
retry.func = readFn("retry");
gameUpdate.func = readFn("gameUpdate");
retrySelect.func = readFn("retrySelect");

const functionTemplate = operationRoute;
const gameFindTemplate = exactNode(flow, ids.gameFindTemplate, "mongodb4");
const operationFindTemplate = exactNode(flow, ids.operationFindTemplate, "mongodb4");
const functionNode = (id, name, func, outputs, wires, x, y) => ({
  ...structuredClone(functionTemplate), id, name, func, outputs, wires, x, y,
});
const httpInNode = (id, name, url, method, wires, x, y) => ({
  id, type: "http in", z: TAB_ID, name, url, method, upload: false, swaggerDoc: "", x, y, wires,
});
const newNodes = [
  httpInNode(ids.postRoute, "CUP staff player leave", "/lk/internal/staff/games/:gameId/player-leaves", "post", [[ids.postPrepare]], 180, 2120),
  functionNode(ids.postPrepare, "Authorize CUP staff leave command", readFn("postPrepare"), 2, [[ids.postGameFind], [ids.response]], 470, 2120),
  { ...structuredClone(gameFindTemplate), id: ids.postGameFind, name: "Find exact game for CUP staff leave", x: 760, y: 2120, wires: [[ids.postAuthorize]] },
  functionNode(ids.postAuthorize, "Bind CUP staff leave to active membership", readFn("postAuthorize"), 2, [[ids.operationStart], [ids.response]], 1060, 2120),
  httpInNode(ids.statusRoute, "CUP staff player leave status", "/lk/internal/staff/games/:gameId/player-leaves/:operationId", "get", [[ids.statusPrepare]], 200, 2180),
  functionNode(ids.statusPrepare, "Authorize CUP staff leave status", readFn("statusPrepare"), 2, [[ids.statusFind], [ids.response]], 490, 2180),
  { ...structuredClone(operationFindTemplate), id: ids.statusFind, name: "Read exact CUP staff leave operation", x: 780, y: 2180, wires: [[ids.statusFormat]] },
  functionNode(ids.statusFormat, "Format CUP staff leave status", readFn("statusFormat"), 2, [[ids.response], [ids.debug]], 1070, 2180),
  { id: ids.persistenceCatch, type: "catch", z: TAB_ID, name: "Catch CUP staff leave persistence errors", scope: [ids.postGameFind, ids.statusFind], uncaught: false, x: 780, y: 2240, wires: [[ids.persistenceError]] },
  functionNode(ids.persistenceError, "Fail closed CUP staff leave persistence", readFn("persistenceError"), 1, [[ids.response]], 1080, 2240),
];
for (const node of newNodes) {
  if (flow.some((current) => current.id === node.id)) fail(`New node id already exists: ${node.id}`);
  flow.push(node);
}

const byId = new Map(flow.map((node) => [node.id, node]));
if (byId.size !== flow.length) fail("Candidate contains duplicate node ids");
for (const node of flow) {
  for (const target of (Array.isArray(node.wires) ? node.wires : []).flat()) {
    if (!byId.has(target)) fail(`Broken wire ${node.id} -> ${target}`);
  }
  if (node.type === "function" && Number.isInteger(node.outputs)
    && (!Array.isArray(node.wires) || node.wires.length !== node.outputs)) {
    fail(`Function output/wire count mismatch for ${node.id}`);
  }
}
const routes = flow.filter((node) => node.type === "http in");
if (routes.length !== EXPECTED_ROUTE_COUNT + 2) fail("Candidate route count mismatch");
for (const [method, url] of [
  ["post", "/lk/internal/staff/games/:gameId/player-leaves"],
  ["get", "/lk/internal/staff/games/:gameId/player-leaves/:operationId"],
]) {
  if (routes.filter((node) => node.method === method && node.url === url).length !== 1) fail(`Route contract mismatch: ${method} ${url}`);
}
if (flow.length !== EXPECTED_NODE_COUNT + newNodes.length) fail("Candidate node count mismatch");

const allowedExistingChanges = new Map([
  [ids.operationStart, ["func"]],
  [ids.operationRoute, ["func"]],
  [ids.router, ["func"]],
  [ids.finalize, ["func"]],
  [ids.retry, ["func"]],
  [ids.gameUpdate, ["func"]],
  [ids.retrySelect, ["func"]],
]);
const changedFields = (left, right) => [...new Set([...Object.keys(left), ...Object.keys(right)])]
  .filter((field) => !isDeepStrictEqual(left[field], right[field])).sort();
const changes = flow.flatMap((node) => {
  const previous = before.find((item) => item.id === node.id);
  if (!previous) return [{ id: node.id, kind: "added", changedFields: Object.keys(node).sort() }];
  if (isDeepStrictEqual(previous, node)) return [];
  return [{ id: node.id, kind: "changed", changedFields: changedFields(previous, node) }];
});
for (const change of changes.filter((item) => item.kind === "changed")) {
  if (!isDeepStrictEqual(change.changedFields, allowedExistingChanges.get(change.id))) {
    fail(`Unexpected existing-node change for ${change.id}: ${change.changedFields.join(",")}`);
  }
}
if (changes.length !== allowedExistingChanges.size + newNodes.length) fail("Unexpected candidate change count");
const candidateFunctions = flow.filter((node) => node.type === "function" && (
  newNodes.some((item) => item.id === node.id) || allowedExistingChanges.has(node.id)
));
const candidateFunctionText = candidateFunctions.map((node) => String(node.func || "")).join("\n");
if (!candidateFunctionText.includes('env.get("CUP_LK_PLAYER_LEAVE_TOKEN")')) {
  fail("Candidate does not use the dedicated CUP staff leave token environment key");
}
for (const node of candidateFunctions) {
  if (/Bearer\s+[A-Za-z0-9._-]{20,}|grant_type=password|password=|username=/i.test(String(node.func || ""))) {
    fail(`Candidate function ${node.id} contains a credential-like literal`);
  }
}

const outputPath = path.resolve(args["--output"]);
const reportPath = path.resolve(args["--report"]);
for (const target of [outputPath, reportPath]) {
  if (fs.existsSync(target)) fail(`Refusing to overwrite ${target}`);
  fs.mkdirSync(path.dirname(target), { recursive: true, mode: 0o700 });
}
const outputText = `${JSON.stringify(flow, null, 2)}\n`;
fs.writeFileSync(outputPath, outputText, { mode: 0o600, flag: "wx" });
const report = {
  sourceSha256: EXPECTED_SOURCE_SHA256,
  candidateSha256: sha256(outputText),
  sourceNodeCount: EXPECTED_NODE_COUNT,
  candidateNodeCount: flow.length,
  sourceRouteCount: EXPECTED_ROUTE_COUNT,
  candidateRouteCount: routes.length,
  changes,
};
fs.writeFileSync(reportPath, `${JSON.stringify(report, null, 2)}\n`, { mode: 0o600, flag: "wx" });
console.log(JSON.stringify(report, null, 2));
