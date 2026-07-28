import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

const workspaceRoot = process.cwd();
const defaultSourcePath = path.resolve(workspaceRoot, "node-red/modular/source.flow.json");
const sourcePath = path.resolve(workspaceRoot, process.argv[2] || defaultSourcePath);
const importPath = path.resolve(
  workspaceRoot,
  process.argv[3] || "node-red/modular/imports/lk_tournament_broadcast.nodes.import.json",
);
const fnDir = path.resolve(workspaceRoot, "scripts/nodered_tournament_broadcast_nodes");

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
  const isExpectedOrigin = meta?.sourceKind === "live-147"
    && meta?.sourceHost === "lk-primary-147"
    && meta?.sourceUser === "root"
    && String(meta?.sourcePort) === "22"
    && meta?.remoteFlowPath === "/root/.node-red/flows.json";
  const isFresh = Number.isFinite(pulledAt)
    && Date.now() >= pulledAt
    && Date.now() - pulledAt <= 30 * 60 * 1000;
  const sourceText = fs.readFileSync(sourcePath, "utf8");
  const followsVerifiedAuthConsentPatch = sourceText.includes('"id": "auth_consent_post_in_20260714"');
  const hasVerifiedSource = meta?.sourceSha256 === sourceSha256 || followsVerifiedAuthConsentPatch;
  if (!isExpectedOrigin || !isFresh || !hasVerifiedSource) {
    throw new Error("Refusing to patch stale/unverified Node-RED source; pull the live 147 flow first");
  }
}

const readFn = (fileName) => fs.readFileSync(path.join(fnDir, fileName), "utf8");
const IDS = {
  comment: "lk_tournament_broadcast_comment_20260719",
  postIn: "lk_tournament_broadcast_post_20260719",
  statusIn: "lk_tournament_broadcast_status_20260719",
  prepare: "lk_tournament_broadcast_prepare_20260719",
  profileRequest: "lk_tournament_broadcast_profile_20260719",
  authorize: "lk_tournament_broadcast_authorize_20260719",
  tournamentFind: "lk_tournament_broadcast_find_20260719",
  route: "lk_tournament_broadcast_route_20260719",
  deviceRequest: "lk_tournament_broadcast_device_20260719",
  persist: "lk_tournament_broadcast_persist_20260719",
  tournamentUpdate: "lk_tournament_broadcast_update_20260719",
  response: "lk_tournament_broadcast_response_20260719",
  httpResponse: "lk_tournament_broadcast_http_response_20260719",
  catch: "lk_tournament_broadcast_catch_20260719",
  error: "lk_tournament_broadcast_error_20260719",
  optionsActionIn: "lk_tournament_broadcast_options_action_20260719",
  options: "lk_tournament_broadcast_options_20260719",
  optionsResponse: "lk_tournament_broadcast_options_response_20260719",
};

const flow = JSON.parse(fs.readFileSync(sourcePath, "utf8"));
if (!Array.isArray(flow)) throw new Error("Node-RED source flow must be an array");

const tournamentTab = flow.find((node) => (
  node?.type === "tab"
  && node?.disabled !== true
  && String(node?.label || "").trim().toLowerCase() === "lk tournaments"
));
if (!tournamentTab) throw new Error("Enabled LK Tournaments tab was not found");

const tournamentMongoNodes = flow.filter((node) => (
  node?.type === "mongodb4"
  && node?.z === tournamentTab.id
  && node?.collection === "tournaments"
  && node?.clientNode
));
const writeMongoClientIds = Array.from(new Set(
  tournamentMongoNodes
    .filter((node) => node.operation === "updateOne")
    .map((node) => node.clientNode),
));
const mongoClientIds = writeMongoClientIds.length > 0
  ? writeMongoClientIds
  : Array.from(new Set(tournamentMongoNodes.map((node) => node.clientNode)));
if (mongoClientIds.length !== 1) {
  throw new Error(`Expected one LK Tournaments Mongo client, found ${mongoClientIds.length}`);
}
const mongoClientId = mongoClientIds[0];

const managedIds = new Set(Object.values(IDS));
const withoutManagedNodes = flow.filter((node) => !managedIds.has(node?.id));
const managedRoutes = new Set([
  "post:/lk/tournaments/broadcast/:action",
  "get:/lk/tournaments/broadcast/status",
  "options:/lk/tournaments/broadcast/:action",
]);
const duplicateRoutes = withoutManagedNodes.filter((node) => (
  node?.type === "http in"
  && managedRoutes.has(`${String(node.method || "").toLowerCase()}:${node.url}`)
));
if (duplicateRoutes.length > 0) {
  throw new Error("Unmanaged tournament broadcast route already exists");
}

const nodes = [
  {
    id: IDS.comment,
    type: "comment",
    z: tournamentTab.id,
    name: "Tournament results broadcast",
    info: [
      "LK proxy for Android box tournament results broadcast.",
      "Bearer is verified through Viva profile before tournament authorization.",
      "Device token and station-to-box mapping remain server-side.",
    ].join("\n"),
    x: 250,
    y: 2380,
    wires: [],
  },
  {
    id: IDS.postIn,
    type: "http in",
    z: tournamentTab.id,
    name: "Start or stop tournament broadcast",
    url: "/lk/tournaments/broadcast/:action",
    method: "post",
    upload: false,
    swaggerDoc: "",
    x: 180,
    y: 2440,
    wires: [[IDS.prepare]],
  },
  {
    id: IDS.statusIn,
    type: "http in",
    z: tournamentTab.id,
    name: "Tournament broadcast status",
    url: "/lk/tournaments/broadcast/status",
    method: "get",
    upload: false,
    swaggerDoc: "",
    x: 190,
    y: 2500,
    wires: [[IDS.prepare]],
  },
  {
    id: IDS.prepare,
    type: "function",
    z: tournamentTab.id,
    name: "Prepare tournament broadcast auth",
    func: readFn("fn_tournament_broadcast_prepare.js"),
    outputs: 2,
    timeout: "",
    noerr: 0,
    initialize: "",
    finalize: "",
    libs: [],
    x: 500,
    y: 2460,
    wires: [[IDS.profileRequest], [IDS.httpResponse]],
  },
  {
    id: IDS.profileRequest,
    type: "http request",
    z: tournamentTab.id,
    name: "Verify broadcast manager via Viva profile",
    method: "use",
    ret: "obj",
    paytoqs: "ignore",
    url: "",
    tls: "",
    persist: false,
    proxy: "",
    insecureHTTPParser: false,
    authType: "",
    senderr: true,
    headers: [],
    x: 830,
    y: 2440,
    wires: [[IDS.authorize]],
  },
  {
    id: IDS.authorize,
    type: "function",
    z: tournamentTab.id,
    name: "Authorize tournament broadcast manager",
    func: readFn("fn_tournament_broadcast_authorize.js"),
    outputs: 2,
    timeout: "",
    noerr: 0,
    initialize: "",
    finalize: "",
    libs: [],
    x: 1160,
    y: 2460,
    wires: [[IDS.tournamentFind], [IDS.httpResponse]],
  },
  {
    id: IDS.tournamentFind,
    type: "mongodb4",
    z: tournamentTab.id,
    clientNode: mongoClientId,
    mode: "collection",
    collection: "tournaments",
    operation: "find",
    output: "toArray",
    maxTimeMS: "5000",
    handleDocId: false,
    name: "Find tournament for broadcast",
    x: 1470,
    y: 2440,
    wires: [[IDS.route]],
  },
  {
    id: IDS.route,
    type: "function",
    z: tournamentTab.id,
    name: "Resolve tournament broadcast device",
    func: readFn("fn_tournament_broadcast_route.js"),
    outputs: 3,
    timeout: "",
    noerr: 0,
    initialize: "",
    finalize: "",
    libs: [],
    x: 1760,
    y: 2460,
    wires: [[IDS.deviceRequest], [IDS.httpResponse], [IDS.httpResponse]],
  },
  {
    id: IDS.deviceRequest,
    type: "http request",
    z: tournamentTab.id,
    name: "Send tournament command to Android box",
    method: "use",
    ret: "obj",
    paytoqs: "ignore",
    url: "",
    tls: "",
    persist: false,
    proxy: "",
    insecureHTTPParser: false,
    authType: "",
    senderr: true,
    headers: [],
    x: 2080,
    y: 2420,
    wires: [[IDS.persist]],
  },
  {
    id: IDS.persist,
    type: "function",
    z: tournamentTab.id,
    name: "Persist tournament broadcast state",
    func: readFn("fn_tournament_broadcast_persist.js"),
    outputs: 2,
    timeout: "",
    noerr: 0,
    initialize: "",
    finalize: "",
    libs: [],
    x: 2390,
    y: 2440,
    wires: [[IDS.tournamentUpdate], [IDS.httpResponse]],
  },
  {
    id: IDS.tournamentUpdate,
    type: "mongodb4",
    z: tournamentTab.id,
    clientNode: mongoClientId,
    mode: "collection",
    collection: "tournaments",
    operation: "updateOne",
    output: "toArray",
    maxTimeMS: "5000",
    handleDocId: false,
    name: "Update tournament broadcast state",
    x: 2690,
    y: 2420,
    wires: [[IDS.response]],
  },
  {
    id: IDS.response,
    type: "function",
    z: tournamentTab.id,
    name: "Tournament broadcast response",
    func: readFn("fn_tournament_broadcast_response.js"),
    outputs: 1,
    timeout: "",
    noerr: 0,
    initialize: "",
    finalize: "",
    libs: [],
    x: 2990,
    y: 2420,
    wires: [[IDS.httpResponse]],
  },
  {
    id: IDS.httpResponse,
    type: "http response",
    z: tournamentTab.id,
    name: "",
    statusCode: "",
    headers: {},
    x: 3270,
    y: 2460,
    wires: [],
  },
  {
    id: IDS.catch,
    type: "catch",
    z: tournamentTab.id,
    name: "Catch tournament broadcast failure",
    scope: [IDS.profileRequest, IDS.tournamentFind, IDS.deviceRequest, IDS.tournamentUpdate],
    uncaught: false,
    x: 2370,
    y: 2520,
    wires: [[IDS.error]],
  },
  {
    id: IDS.error,
    type: "function",
    z: tournamentTab.id,
    name: "Tournament broadcast error",
    func: readFn("fn_tournament_broadcast_error.js"),
    outputs: 1,
    timeout: "",
    noerr: 0,
    initialize: "",
    finalize: "",
    libs: [],
    x: 2690,
    y: 2520,
    wires: [[IDS.httpResponse]],
  },
  {
    id: IDS.optionsActionIn,
    type: "http in",
    z: tournamentTab.id,
    name: "OPTIONS tournament broadcast action",
    url: "/lk/tournaments/broadcast/:action",
    method: "options",
    upload: false,
    swaggerDoc: "",
    x: 210,
    y: 2580,
    wires: [[IDS.options]],
  },
  {
    id: IDS.options,
    type: "function",
    z: tournamentTab.id,
    name: "Tournament broadcast CORS preflight",
    func: readFn("fn_tournament_broadcast_options.js"),
    outputs: 1,
    timeout: "",
    noerr: 0,
    initialize: "",
    finalize: "",
    libs: [],
    x: 540,
    y: 2610,
    wires: [[IDS.optionsResponse]],
  },
  {
    id: IDS.optionsResponse,
    type: "http response",
    z: tournamentTab.id,
    name: "",
    statusCode: "",
    headers: {},
    x: 850,
    y: 2610,
    wires: [],
  },
];

const nextFlow = [...withoutManagedNodes, ...nodes];
fs.writeFileSync(sourcePath, `${JSON.stringify(nextFlow, null, 2)}\n`, "utf8");
fs.mkdirSync(path.dirname(importPath), { recursive: true });
fs.writeFileSync(importPath, `${JSON.stringify(nodes, null, 2)}\n`, "utf8");

for (const routeKey of managedRoutes) {
  const separatorIndex = routeKey.indexOf(":");
  const method = routeKey.slice(0, separatorIndex);
  const url = routeKey.slice(separatorIndex + 1);
  const count = nextFlow.filter((node) => (
    node?.type === "http in"
    && String(node?.method || "").toLowerCase() === method
    && node?.url === url
  )).length;
  if (count !== 1) throw new Error(`Tournament broadcast route is not idempotent: ${routeKey}`);
}

console.log(`Patched tournament broadcast nodes into tab ${tournamentTab.id}`);
console.log(`Focused import written to ${importPath}`);
