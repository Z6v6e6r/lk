import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

const workspaceRoot = process.cwd();
const defaultSourcePath = path.resolve(workspaceRoot, "node-red/modular/source.flow.json");
const sourcePath = path.resolve(workspaceRoot, process.argv[2] || defaultSourcePath);
const importPath = path.resolve(
  workspaceRoot,
  process.argv[3] || "node-red/modular/imports/lk_community_player_rating.nodes.import.json",
);
const fnDir = path.resolve(workspaceRoot, "scripts/nodered_community_player_rating_nodes");

if (sourcePath === defaultSourcePath) {
  const metaPath = path.resolve(workspaceRoot, "node-red/modular/source.flow.meta.json");
  let meta;
  try {
    meta = JSON.parse(fs.readFileSync(metaPath, "utf8"));
  } catch {
    throw new Error("Refusing to patch the default Node-RED source without live-147 origin metadata");
  }
  const pulledAt = Date.parse(String(meta?.pulledAt || ""));
  const sourceSha256 = crypto.createHash("sha256").update(fs.readFileSync(sourcePath)).digest("hex");
  const verifiedOrigin = meta?.sourceKind === "live-147"
    && meta?.sourceHost === "lk-primary-147"
    && meta?.sourceUser === "root"
    && String(meta?.sourcePort) === "22"
    && meta?.remoteFlowPath === "/root/.node-red/flows.json";
  const fresh = Number.isFinite(pulledAt) && Date.now() >= pulledAt && Date.now() - pulledAt <= 30 * 60 * 1000;
  if (!verifiedOrigin || !fresh || meta?.sourceSha256 !== sourceSha256) {
    throw new Error("Refusing to patch stale/unverified Node-RED source; pull the live 147 flow first");
  }
}

const readFn = (name) => fs.readFileSync(path.join(fnDir, name), "utf8");
const IDS = {
  comment: "community_player_rating_comment_20260811",
  lkIn: "community_player_rating_lk_in_20260811",
  publicIn: "community_player_rating_public_in_20260811",
  prepare: "community_player_rating_prepare_20260811",
  communityFind: "community_player_rating_community_find_20260811",
  community: "community_player_rating_community_20260811",
  snapshotFind: "community_player_rating_snapshot_find_20260811",
  response: "community_player_rating_response_20260811",
  catch: "community_player_rating_catch_20260811",
  error: "community_player_rating_error_20260811",
  httpResponse: "community_player_rating_http_response_20260811",
};

const flow = JSON.parse(fs.readFileSync(sourcePath, "utf8"));
if (!Array.isArray(flow)) throw new Error("Node-RED source flow must be an array");

const canonicalRatingRoutes = flow.filter((node) => (
  node?.type === "http in"
  && String(node?.method || "").toLowerCase() === "get"
  && node?.url === "/lk/communities/:communityId/rating"
));
if (canonicalRatingRoutes.length !== 1) {
  throw new Error(`Expected one canonical community rating route, found ${canonicalRatingRoutes.length}`);
}
const tabId = canonicalRatingRoutes[0].z;
const tab = flow.find((node) => node?.type === "tab" && node?.id === tabId && node?.disabled !== true);
if (!tab) throw new Error("Canonical community rating route is not on an enabled tab");

const clientIds = Array.from(new Set(flow
  .filter((node) => (
    node?.type === "mongodb4"
    && node?.z === tabId
    && ["lk_communities", "community_rating_snapshots"].includes(node?.collection)
    && node?.clientNode
  ))
  .map((node) => node.clientNode)));
if (clientIds.length !== 1) throw new Error(`Expected one community Mongo client, found ${clientIds.length}`);
const mongoClientId = clientIds[0];

const managedIds = new Set(Object.values(IDS));
const withoutManagedNodes = flow.filter((node) => !managedIds.has(node?.id));
const managedRoutes = new Set([
  "get:/lk/communities/:communityId/players/:playerId/rating",
  "get:/communities/:communityId/players/:playerId/rating",
]);
const unmanagedRoutes = withoutManagedNodes.filter((node) => (
  node?.type === "http in"
  && managedRoutes.has(`${String(node.method || "").toLowerCase()}:${node.url}`)
));
if (unmanagedRoutes.length > 0) throw new Error("Unmanaged community player rating route already exists");

const functionNode = (id, name, fileName, outputs, x, y, wires) => ({
  id,
  type: "function",
  z: tabId,
  name,
  func: readFn(fileName),
  outputs,
  timeout: "",
  noerr: 0,
  initialize: "",
  finalize: "",
  libs: [],
  x,
  y,
  wires,
});
const httpIn = (id, name, url, y) => ({
  id,
  type: "http in",
  z: tabId,
  name,
  url,
  method: "get",
  upload: false,
  swaggerDoc: "",
  x: 220,
  y,
  wires: [[IDS.prepare]],
});
const mongoFind = (id, name, collection, x, y, target) => ({
  id,
  type: "mongodb4",
  z: tabId,
  clientNode: mongoClientId,
  mode: "collection",
  collection,
  operation: "find",
  output: "toArray",
  maxTimeMS: "5000",
  handleDocId: false,
  name,
  x,
  y,
  wires: [[target]],
});

const nodes = [
  {
    id: IDS.comment,
    type: "comment",
    z: tabId,
    name: "Exact community player rating API",
    info: "Minimal fail-closed rating lookup by exact community member ID. Reads materialized community_rating_snapshots only.",
    x: 250,
    y: 5760,
    wires: [],
  },
  httpIn(IDS.lkIn, "LK community player rating", "/lk/communities/:communityId/players/:playerId/rating", 5820),
  httpIn(IDS.publicIn, "Community player rating public path", "/communities/:communityId/players/:playerId/rating", 5880),
  functionNode(
    IDS.prepare,
    "Prepare exact player rating request",
    "fn_community_player_rating_prepare.js",
    2,
    560,
    5850,
    [[IDS.communityFind], [IDS.httpResponse]],
  ),
  mongoFind(IDS.communityFind, "Find community for exact player rating", "lk_communities", 900, 5820, IDS.community),
  functionNode(
    IDS.community,
    "Verify exact community member",
    "fn_community_player_rating_community.js",
    2,
    1210,
    5820,
    [[IDS.snapshotFind], [IDS.httpResponse]],
  ),
  mongoFind(IDS.snapshotFind, "Find exact player rating snapshot", "community_rating_snapshots", 1540, 5820, IDS.response),
  functionNode(
    IDS.response,
    "Build minimal player rating response",
    "fn_community_player_rating_response.js",
    1,
    1870,
    5820,
    [[IDS.httpResponse]],
  ),
  {
    id: IDS.catch,
    type: "catch",
    z: tabId,
    name: "Catch community player rating errors",
    scope: [IDS.prepare, IDS.communityFind, IDS.community, IDS.snapshotFind, IDS.response],
    uncaught: false,
    x: 1220,
    y: 5910,
    wires: [[IDS.error]],
  },
  functionNode(
    IDS.error,
    "Sanitize community player rating error",
    "fn_community_player_rating_error.js",
    1,
    1580,
    5910,
    [[IDS.httpResponse]],
  ),
  {
    id: IDS.httpResponse,
    type: "http response",
    z: tabId,
    name: "",
    statusCode: "",
    headers: {},
    x: 2210,
    y: 5850,
    wires: [],
  },
];

const nextFlow = [...withoutManagedNodes, ...nodes];
const idCounts = new Map();
nextFlow.forEach((node) => {
  const id = String(node?.id || "").trim();
  if (!id) throw new Error("Community player rating candidate contains a node without ID");
  idCounts.set(id, (idCounts.get(id) || 0) + 1);
});
const duplicateIds = Array.from(idCounts.entries()).filter(([, count]) => count !== 1).map(([id]) => id);
if (duplicateIds.length > 0) throw new Error(`Community player rating candidate contains duplicate IDs: ${duplicateIds.join(", ")}`);

const knownIds = new Set(idCounts.keys());
const brokenWires = [];
nextFlow.forEach((node) => (Array.isArray(node?.wires) ? node.wires : []).forEach((row) => (
  Array.isArray(row) ? row : []
).forEach((targetId) => {
  if (!knownIds.has(targetId)) brokenWires.push(`${node.id}->${targetId}`);
})));
if (brokenWires.length > 0) throw new Error(`Community player rating candidate contains broken wires: ${brokenWires.join(", ")}`);

for (const routeKey of managedRoutes) {
  const separator = routeKey.indexOf(":");
  const method = routeKey.slice(0, separator);
  const url = routeKey.slice(separator + 1);
  const count = nextFlow.filter((node) => (
    node?.type === "http in"
    && String(node?.method || "").toLowerCase() === method
    && node?.url === url
  )).length;
  if (count !== 1) throw new Error(`Community player rating route is not idempotent: ${routeKey}`);
}

fs.writeFileSync(sourcePath, `${JSON.stringify(nextFlow, null, 2)}\n`, "utf8");
fs.mkdirSync(path.dirname(importPath), { recursive: true });
fs.writeFileSync(importPath, `${JSON.stringify(nodes, null, 2)}\n`, "utf8");

console.log(`Patched exact community player rating nodes into tab ${tabId}`);
console.log(`Focused import written to ${importPath}`);
