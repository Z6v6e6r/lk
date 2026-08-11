#!/usr/bin/env node
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const fnDir = path.join(rootDir, "scripts/nodered_tournament_community_nodes");
const broadcastRoutePath = path.join(
  rootDir,
  "scripts/nodered_tournament_broadcast_nodes/fn_tournament_broadcast_route.js",
);
const BROADCAST_ROUTE_PREIMAGE_SHA256 = "948f9944b69074185ce0ef3b73d0a2ae13c7e3c303c3674cffef10b36b03b06b";
const IDS = {
  historyMongo: "ddc581fde0073e34",
  historyResponse: "a57565a6ddbb532f",
  historyQuery: "tournament_community_history_query_20260811",
  historyFeed: "tournament_community_history_feed_20260811",
  historyAttach: "tournament_community_history_attach_20260811",
  broadcastFind: "lk_tournament_broadcast_find_20260719",
  broadcastRoute: "lk_tournament_broadcast_route_20260719",
  broadcastQuery: "tournament_community_broadcast_query_20260811",
  broadcastFeed: "tournament_community_broadcast_feed_20260811",
  broadcastAttach: "tournament_community_broadcast_attach_20260811",
  broadcastCatch: "lk_tournament_broadcast_catch_20260719",
};

const getArg = (name) => {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : null;
};
const inputPath = getArg("--input");
const outputPath = getArg("--output");
const reportPath = getArg("--report");
const expectedFlowSha256 = getArg("--expected-flow-sha256");
if (!inputPath || !outputPath || !reportPath || !expectedFlowSha256) {
  throw new Error("Usage: node scripts/patch_live_tournament_community_context.mjs --input <flow> --output <candidate> --report <report> --expected-flow-sha256 <sha256>");
}
if (!/^[a-f0-9]{64}$/i.test(expectedFlowSha256)) throw new Error("--expected-flow-sha256 must be a SHA256 digest");
for (const target of [outputPath, reportPath]) {
  if (fs.existsSync(path.resolve(target))) throw new Error(`Refusing to overwrite ${target}`);
}
const sha256 = (value) => crypto.createHash("sha256").update(value).digest("hex");
const inputBytes = fs.readFileSync(path.resolve(inputPath));
const sourceSha256 = sha256(inputBytes);
if (sourceSha256 !== expectedFlowSha256.toLowerCase()) {
  throw new Error(`Flow preimage mismatch: expected ${expectedFlowSha256}, got ${sourceSha256}`);
}
const flow = JSON.parse(inputBytes.toString("utf8"));
if (!Array.isArray(flow)) throw new Error("Node-RED flow must be an array");
const exact = (id, type, name = null) => {
  const rows = flow.filter((node) => node?.id === id);
  if (rows.length !== 1) throw new Error(`Expected exactly one node ${id}, found ${rows.length}`);
  const node = rows[0];
  if (node.type !== type || (name !== null && node.name !== name)) {
    throw new Error(`Node identity mismatch for ${id}`);
  }
  return node;
};
const historyMongo = exact(IDS.historyMongo, "mongodb4", "Find tournament history");
exact(IDS.historyResponse, "http response");
const broadcastFind = exact(IDS.broadcastFind, "mongodb4", "Find tournament for broadcast");
const broadcastRoute = exact(IDS.broadcastRoute, "function", "Resolve tournament broadcast device");
const broadcastCatch = exact(IDS.broadcastCatch, "catch", "Catch tournament broadcast failure");
if (historyMongo.collection !== "tournaments" || JSON.stringify(historyMongo.wires) !== JSON.stringify([[IDS.historyResponse]])) {
  throw new Error("Tournament history preimage is not the expected direct find-to-response path");
}
if (broadcastFind.collection !== "tournaments" || JSON.stringify(broadcastFind.wires) !== JSON.stringify([[IDS.broadcastRoute]])) {
  throw new Error("Tournament broadcast preimage is not the expected direct find-to-route path");
}
if (sha256(String(broadcastRoute.func || "").trim()) !== BROADCAST_ROUTE_PREIMAGE_SHA256) {
  throw new Error("Tournament broadcast route function preimage does not match the reviewed live source");
}
const managedIds = new Set([
  IDS.historyQuery,
  IDS.historyFeed,
  IDS.historyAttach,
  IDS.broadcastQuery,
  IDS.broadcastFeed,
  IDS.broadcastAttach,
]);
if (flow.some((node) => managedIds.has(node?.id))) throw new Error("Managed tournament community nodes already exist in preimage");
const readFn = (name) => fs.readFileSync(path.join(fnDir, name), "utf8");
const queryFn = readFn("fn_tournament_community_publications_query.js");
const attachFn = readFn("fn_tournament_community_publications_attach.js");
const functionNode = (id, name, func, x, y, target) => ({
  id,
  type: "function",
  z: historyMongo.z,
  name,
  func,
  outputs: 1,
  timeout: "",
  noerr: 0,
  initialize: "",
  finalize: "",
  libs: [],
  x,
  y,
  wires: [[target]],
});
const mongoNode = (id, name, clientNode, x, y, target) => ({
  id,
  type: "mongodb4",
  z: historyMongo.z,
  clientNode,
  mode: "collection",
  collection: "lk_community_feed",
  operation: "find",
  output: "toArray",
  maxTimeMS: "5000",
  handleDocId: false,
  name,
  x,
  y,
  wires: [[target]],
});

historyMongo.wires = [[IDS.historyQuery]];
broadcastFind.wires = [[IDS.broadcastQuery]];
broadcastRoute.func = fs.readFileSync(broadcastRoutePath, "utf8");
broadcastCatch.scope = Array.from(new Set([
  ...(Array.isArray(broadcastCatch.scope) ? broadcastCatch.scope : []),
  IDS.broadcastQuery,
  IDS.broadcastFeed,
  IDS.broadcastAttach,
]));
const addedNodes = [
  functionNode(IDS.historyQuery, "Find tournament publications", `msg._tournamentCommunityMode = "history";\n${queryFn}`, 1050, 1560, IDS.historyFeed),
  mongoNode(IDS.historyFeed, "Find active tournament publications", historyMongo.clientNode, 1320, 1560, IDS.historyAttach),
  functionNode(IDS.historyAttach, "Attach published communities", attachFn, 1580, 1560, IDS.historyResponse),
  functionNode(IDS.broadcastQuery, "Find broadcast tournament publications", `msg._tournamentCommunityMode = "broadcast";\n${queryFn}`, 1410, 4880, IDS.broadcastFeed),
  mongoNode(IDS.broadcastFeed, "Find broadcast active publications", broadcastFind.clientNode, 1690, 4880, IDS.broadcastAttach),
  functionNode(IDS.broadcastAttach, "Attach broadcast community context", attachFn, 1970, 4880, IDS.broadcastRoute),
];
flow.push(...addedNodes);

const ids = flow.map((node) => String(node?.id || ""));
if (ids.some((id) => !id) || new Set(ids).size !== ids.length) throw new Error("Candidate contains missing or duplicate node IDs");
const knownIds = new Set(ids);
const brokenWires = [];
flow.forEach((node) => (Array.isArray(node.wires) ? node.wires : []).forEach((row) => (
  Array.isArray(row) ? row : []
).forEach((targetId) => {
  if (!knownIds.has(targetId)) brokenWires.push(`${node.id}->${targetId}`);
})));
if (brokenWires.length > 0) throw new Error(`Candidate contains broken wires: ${brokenWires.join(", ")}`);

const candidateBytes = Buffer.from(`${JSON.stringify(flow, null, 2)}\n`, "utf8");
const candidateSha256 = sha256(candidateBytes);
fs.mkdirSync(path.dirname(path.resolve(outputPath)), { recursive: true });
fs.writeFileSync(path.resolve(outputPath), candidateBytes, { mode: 0o600 });
const report = {
  ok: true,
  sourceSha256,
  candidateSha256,
  sourceNodeCount: flow.length - addedNodes.length,
  candidateNodeCount: flow.length,
  addedNodeIds: addedNodes.map((node) => node.id),
  changedNodeIds: [IDS.historyMongo, IDS.broadcastFind, IDS.broadcastRoute, IDS.broadcastCatch],
  deploymentPerformed: false,
};
fs.writeFileSync(path.resolve(reportPath), `${JSON.stringify(report, null, 2)}\n`, { mode: 0o600 });
console.log(JSON.stringify(report, null, 2));
