#!/usr/bin/env node
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { isDeepStrictEqual } from "node:util";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const DEFAULT_FLOW_SHA256 = "07c118977b90c94a7d0c73e3d958df6a24e1d0f3d2b47690c371e2b3b6ea5865";
const IDS = {
  route: "ccd7d6b82f8b90c1",
  query: "11b8491cc624fb42",
  history: "ddc581fde0073e34",
  publicationQuery: "tournament_community_history_query_20260811",
  publicationFeed: "tournament_community_history_feed_20260811",
  attach: "tournament_community_history_attach_20260811",
  response: "a57565a6ddbb532f",
  inactiveDebug: "0299bf5612ade8d5",
  catch: "tournament_history_storage_catch_20260816",
  error: "tournament_history_storage_error_20260816",
  errorResponse: "tournament_history_storage_response_20260816",
  guard: "tournament_history_request_guard_20260817",
  cacheStore: "tournament_history_cache_store_20260817",
};

const getArg = (name) => {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : null;
};
const inputPath = getArg("--input");
const outputPath = getArg("--output");
const reportPath = getArg("--report");
const expectedFlowSha256 = (getArg("--expected-flow-sha256") || DEFAULT_FLOW_SHA256).toLowerCase();
if (!inputPath || !outputPath || !reportPath || !/^[a-f0-9]{64}$/.test(expectedFlowSha256)) {
  throw new Error(
    "Usage: node scripts/patch_live_tournament_history_storm_guard.mjs --input <flow.json> "
    + "--output <candidate.json> --report <report.json> [--expected-flow-sha256 <sha256>]",
  );
}

const sha256 = (value) => crypto.createHash("sha256").update(value).digest("hex");
const canonicalizePath = (filePath) => {
  const absolutePath = path.resolve(filePath);
  if (fs.existsSync(absolutePath)) return fs.realpathSync(absolutePath);
  return path.join(fs.realpathSync(path.dirname(absolutePath)), path.basename(absolutePath));
};
const sameInode = (leftPath, rightPath) => {
  if (!fs.existsSync(leftPath) || !fs.existsSync(rightPath)) return false;
  const left = fs.statSync(leftPath);
  const right = fs.statSync(rightPath);
  return left.dev === right.dev && left.ino === right.ino;
};
const input = canonicalizePath(inputPath);
const output = canonicalizePath(outputPath);
const reportFile = canonicalizePath(reportPath);
if (
  input === output || input === reportFile || output === reportFile
  || sameInode(input, output) || sameInode(input, reportFile) || sameInode(output, reportFile)
) throw new Error("Input, output, and report paths must be distinct");
if (fs.existsSync(output) || fs.existsSync(reportFile)) {
  throw new Error("Output and report destinations must not already exist");
}

const inputBytes = fs.readFileSync(input);
const flowSha256 = sha256(inputBytes);
if (flowSha256 !== expectedFlowSha256) {
  throw new Error(`Flow preimage mismatch: expected ${expectedFlowSha256}, got ${flowSha256}`);
}
const flow = JSON.parse(inputBytes.toString("utf8"));
if (!Array.isArray(flow)) throw new Error("Flow must be a JSON array");
const before = structuredClone(flow);
const exact = (id, type, name = null) => {
  const matches = flow.filter((node) => node?.id === id);
  if (matches.length !== 1) throw new Error(`Expected exactly one node ${id}, found ${matches.length}`);
  const node = matches[0];
  if (node.type !== type || (name !== null && node.name !== name)) {
    throw new Error(`Node identity mismatch for ${id}`);
  }
  return node;
};

const route = exact(IDS.route, "http in", "Americano history");
const inactiveDebug = exact(IDS.inactiveDebug, "debug", "Americano save payload");
const query = exact(IDS.query, "change", "History by tournamentId");
const history = exact(IDS.history, "mongodb4", "Find tournament history");
const publicationQuery = exact(IDS.publicationQuery, "function", "Find tournament publications");
const publicationFeed = exact(IDS.publicationFeed, "mongodb4", "Find active tournament publications");
const attach = exact(IDS.attach, "function", "Attach published communities");
exact(IDS.response, "http response");
const catchNode = exact(IDS.catch, "catch", "Catch tournament history storage errors");
exact(IDS.error, "function", "Build tournament history storage error");
exact(IDS.errorResponse, "http response", "Tournament history storage error response");

if (route.method !== "get" || route.url !== "/lk/tournaments/americano/history") {
  throw new Error("Tournament history route contract mismatch");
}
if (inactiveDebug.active !== false || !isDeepStrictEqual(inactiveDebug.wires, [])) {
  throw new Error("Tournament history inactive debug contract mismatch");
}
if (
  !isDeepStrictEqual(route.wires, [[IDS.query, IDS.inactiveDebug]])
  || !isDeepStrictEqual(query.wires, [[IDS.history]])
  || !isDeepStrictEqual(history.wires, [[IDS.publicationQuery]])
  || !isDeepStrictEqual(publicationQuery.wires, [[IDS.publicationFeed]])
  || !isDeepStrictEqual(publicationFeed.wires, [[IDS.attach]])
  || !isDeepStrictEqual(attach.wires, [[IDS.response]])
) throw new Error("Tournament history storage chain wiring mismatch");
if (
  history.operation !== "find" || history.collection !== "tournaments"
  || history.maxTimeMS !== "5000" || history.limit !== "1"
  || publicationFeed.operation !== "find" || publicationFeed.collection !== "lk_community_feed"
  || publicationFeed.maxTimeMS !== "5000" || publicationFeed.limit !== "50"
) throw new Error("Tournament history bounded Mongo contract mismatch");
if (!isDeepStrictEqual(catchNode.scope, [IDS.history, IDS.publicationFeed])) {
  throw new Error("Tournament history catch scope mismatch");
}
for (const id of [IDS.guard, IDS.cacheStore]) {
  if (flow.some((node) => node?.id === id)) throw new Error(`Managed node already exists: ${id}`);
}

route.wires = [[IDS.guard]];
attach.wires = [[IDS.cacheStore]];
const guardFn = fs.readFileSync(
  path.join(ROOT, "scripts/nodered_games_nodes/fn_tournament_history_request_guard.js"),
  "utf8",
);
const cacheStoreFn = fs.readFileSync(
  path.join(ROOT, "scripts/nodered_games_nodes/fn_tournament_history_cache_store.js"),
  "utf8",
);
flow.push(
  {
    id: IDS.guard,
    type: "function",
    z: route.z,
    name: "Guard and cache tournament history",
    func: guardFn,
    outputs: 2,
    timeout: "",
    noerr: 0,
    initialize: "",
    finalize: "",
    libs: [],
    x: 510,
    y: 1540,
    wires: [[IDS.response], [IDS.query, IDS.inactiveDebug]],
  },
  {
    id: IDS.cacheStore,
    type: "function",
    z: route.z,
    name: "Store tournament history response cache",
    func: cacheStoreFn,
    outputs: 1,
    timeout: "",
    noerr: 0,
    initialize: "",
    finalize: "",
    libs: [],
    x: 1730,
    y: 1540,
    wires: [[IDS.response]],
  },
);

const ids = flow.map((node) => String(node?.id || ""));
if (ids.some((id) => !id) || new Set(ids).size !== ids.length) {
  throw new Error("Candidate contains missing or duplicate node IDs");
}
const knownIds = new Set(ids);
const brokenWires = [];
for (const node of flow) {
  for (const row of Array.isArray(node?.wires) ? node.wires : []) {
    for (const targetId of Array.isArray(row) ? row : []) {
      if (!knownIds.has(targetId)) brokenWires.push(`${node.id}->${targetId}`);
    }
  }
}
if (brokenWires.length > 0) throw new Error(`Candidate contains broken wires: ${brokenWires.join(", ")}`);
const httpInputContract = (nodes) => nodes
  .filter((node) => node?.type === "http in")
  .map((node) => ({
    id: node.id,
    type: node.type,
    name: node.name,
    method: node.method,
    url: node.url,
    disabled: node.disabled === true,
  }));
if (!isDeepStrictEqual(httpInputContract(before), httpInputContract(flow))) {
  throw new Error("HTTP input routes changed");
}
const allowedChangedIds = new Set([IDS.route, IDS.attach]);
for (let index = 0; index < before.length; index += 1) {
  if (allowedChangedIds.has(before[index]?.id)) continue;
  if (!isDeepStrictEqual(before[index], flow[index])) {
    throw new Error(`Non-target preimage node changed: ${String(before[index]?.id)}`);
  }
}

const candidateText = `${JSON.stringify(flow, null, 2)}\n`;
const report = {
  schemaVersion: 1,
  sourceFlowSha256: flowSha256,
  candidateFlowSha256: sha256(Buffer.from(candidateText)),
  nodeCountBefore: before.length,
  nodeCountAfter: flow.length,
  changedExistingNodeIds: [IDS.route, IDS.attach],
  addedNodeIds: [IDS.guard, IDS.cacheStore],
  invariants: {
    httpInputRoutesUnchanged: true,
    boundedMongoReadsPreserved: true,
    storageCatchPreserved: true,
    brokenWires: 0,
  },
};
fs.writeFileSync(output, candidateText, { mode: 0o600, flag: "wx" });
fs.writeFileSync(reportFile, `${JSON.stringify(report, null, 2)}\n`, { mode: 0o600, flag: "wx" });
console.log(JSON.stringify(report));
