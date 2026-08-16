#!/usr/bin/env node
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { isDeepStrictEqual } from "node:util";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const DEFAULT_FLOW_SHA256 = "d9ae9ef519f5f1e1bc474ebd7aff955b20721af3467c92f079cf6f68dc26c76a";
const IDS = {
  route: "ccd7d6b82f8b90c1",
  query: "11b8491cc624fb42",
  history: "ddc581fde0073e34",
  publicationQuery: "tournament_community_history_query_20260811",
  publicationFeed: "tournament_community_history_feed_20260811",
  attach: "tournament_community_history_attach_20260811",
  response: "a57565a6ddbb532f",
  catch: "tournament_history_storage_catch_20260816",
  error: "tournament_history_storage_error_20260816",
  errorResponse: "tournament_history_storage_response_20260816",
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
    "Usage: node scripts/patch_live_tournament_history_resilience.mjs --input <flow.json> "
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
const query = exact(IDS.query, "change", "History by tournamentId");
const history = exact(IDS.history, "mongodb4", "Find tournament history");
const publicationQuery = exact(IDS.publicationQuery, "function", "Find tournament publications");
const publicationFeed = exact(IDS.publicationFeed, "mongodb4", "Find active tournament publications");
const attach = exact(IDS.attach, "function", "Attach published communities");
exact(IDS.response, "http response");
if (route.method !== "get" || route.url !== "/lk/tournaments/americano/history") {
  throw new Error("Tournament history route contract mismatch");
}
if (
  !isDeepStrictEqual(query.wires, [[IDS.history]])
  || !isDeepStrictEqual(history.wires, [[IDS.publicationQuery]])
  || !isDeepStrictEqual(publicationQuery.wires, [[IDS.publicationFeed]])
  || !isDeepStrictEqual(publicationFeed.wires, [[IDS.attach]])
  || !isDeepStrictEqual(attach.wires, [[IDS.response]])
) throw new Error("Tournament history storage chain wiring mismatch");
if (
  history.operation !== "find" || history.collection !== "tournaments" || history.maxTimeMS !== "5000"
  || publicationFeed.operation !== "find" || publicationFeed.collection !== "lk_community_feed"
  || publicationFeed.maxTimeMS !== "5000"
) throw new Error("Tournament history Mongo contract mismatch");
if (Object.hasOwn(history, "limit") || Object.hasOwn(publicationFeed, "limit")) {
  throw new Error("Reviewed preimage must not already contain history limits");
}
for (const id of [IDS.catch, IDS.error, IDS.errorResponse]) {
  if (flow.some((node) => node?.id === id)) throw new Error(`Managed node already exists: ${id}`);
}

history.limit = "1";
publicationFeed.limit = "50";
const errorFn = fs.readFileSync(
  path.join(ROOT, "scripts/nodered_games_nodes/fn_tournament_history_storage_error.js"),
  "utf8",
);
const addedNodes = [
  {
    id: IDS.catch,
    type: "catch",
    z: history.z,
    name: "Catch tournament history storage errors",
    scope: [IDS.history, IDS.publicationFeed],
    uncaught: false,
    x: 1110,
    y: 1620,
    wires: [[IDS.error]],
  },
  {
    id: IDS.error,
    type: "function",
    z: history.z,
    name: "Build tournament history storage error",
    func: errorFn,
    outputs: 1,
    timeout: "",
    noerr: 0,
    initialize: "",
    finalize: "",
    libs: [],
    x: 1430,
    y: 1620,
    wires: [[IDS.errorResponse]],
  },
  {
    id: IDS.errorResponse,
    type: "http response",
    z: history.z,
    name: "Tournament history storage error response",
    statusCode: "",
    headers: {},
    x: 1770,
    y: 1620,
    wires: [],
  },
];
flow.push(...addedNodes);

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
if (!isDeepStrictEqual(before.filter((node) => node?.type === "http in"), flow.filter((node) => node?.type === "http in"))) {
  throw new Error("HTTP input routes changed");
}
const allowedChangedIds = new Set([IDS.history, IDS.publicationFeed]);
for (let index = 0; index < before.length; index += 1) {
  if (allowedChangedIds.has(before[index]?.id)) continue;
  if (!isDeepStrictEqual(before[index], flow[index])) {
    throw new Error(`Non-target preimage node changed: ${String(before[index]?.id)}`);
  }
}

const candidateText = `${JSON.stringify(flow, null, 2)}\n`;
const candidateSha256 = sha256(Buffer.from(candidateText, "utf8"));
const report = {
  ok: true,
  flowSha256,
  candidateSha256,
  expectedFlowSha256,
  inputPath: input,
  outputPath: output,
  changed: [
    { id: IDS.history, fields: ["limit"], value: "1" },
    { id: IDS.publicationFeed, fields: ["limit"], value: "50" },
  ],
  addedNodeIds: addedNodes.map((node) => node.id),
  invariants: {
    sourceNodeCount: before.length,
    candidateNodeCount: flow.length,
    httpInputRoutesUnchanged: true,
    brokenWireCount: 0,
  },
};
const tempPath = (destination) => path.join(
  path.dirname(destination),
  `.${path.basename(destination)}.${process.pid}.${crypto.randomUUID()}.tmp`,
);
const outputTemp = tempPath(output);
const reportTemp = tempPath(reportFile);
const removeIfPresent = (filePath) => {
  try { fs.unlinkSync(filePath); } catch (error) { if (error?.code !== "ENOENT") throw error; }
};
let outputPublished = false;
let reportPublished = false;
try {
  fs.writeFileSync(outputTemp, candidateText, { flag: "wx", mode: 0o600 });
  fs.writeFileSync(reportTemp, `${JSON.stringify(report, null, 2)}\n`, { flag: "wx", mode: 0o600 });
  fs.linkSync(reportTemp, reportFile);
  reportPublished = true;
  fs.linkSync(outputTemp, output);
  outputPublished = true;
} catch (error) {
  if (outputPublished) removeIfPresent(output);
  if (reportPublished) removeIfPresent(reportFile);
  throw error;
} finally {
  removeIfPresent(outputTemp);
  removeIfPresent(reportTemp);
}
console.log(JSON.stringify(report, null, 2));
