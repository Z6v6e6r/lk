import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";

const workspaceRoot = process.cwd();
const defaultSourcePath = path.resolve(workspaceRoot, "node-red/modular/source.flow.json");
const sourcePath = path.resolve(
  workspaceRoot,
  process.argv[2] || defaultSourcePath,
);
const usesDefaultSource = sourcePath === defaultSourcePath;
const importPath = path.resolve(
  workspaceRoot,
  process.argv[3] || "node-red/modular/imports/lk_auth_consents.nodes.import.json",
);
const fnDir = path.resolve(workspaceRoot, "scripts/nodered_auth_consent_nodes");

if (usesDefaultSource) {
  const metaPath = path.resolve(workspaceRoot, "node-red/modular/source.flow.meta.json");
  let meta;
  try {
    meta = JSON.parse(fs.readFileSync(metaPath, "utf8"));
  } catch {
    throw new Error("Refusing to patch the default Node-RED source without live-147 origin metadata");
  }
  const pulledAt = Date.parse(String(meta?.pulledAt || ""));
  const maxSourceAgeMs = 30 * 60 * 1000;
  const isExpectedOrigin = meta?.sourceKind === "live-147"
    && meta?.sourceHost === "lk-primary-147"
    && meta?.sourceUser === "root"
    && String(meta?.sourcePort) === "22"
    && meta?.remoteFlowPath === "/root/.node-red/flows.json";
  const isFresh = Number.isFinite(pulledAt)
    && Date.now() >= pulledAt
    && Date.now() - pulledAt <= maxSourceAgeMs;
  let sourceSha256 = null;
  try {
    sourceSha256 = crypto.createHash("sha256").update(fs.readFileSync(sourcePath)).digest("hex");
  } catch {
    // The common failure below provides the release recovery command.
  }
  const hasVerifiedContent = typeof meta?.sourceSha256 === "string"
    && sourceSha256 === meta.sourceSha256;
  if (!isExpectedOrigin || !isFresh || !hasVerifiedContent) {
    throw new Error(
      "Refusing to patch stale/unverified Node-RED source; run nodered:modular:prepare-147",
    );
  }
}

const readFn = (name) => fs.readFileSync(path.join(fnDir, name), "utf8");
const fnPrepare = readFn("fn_auth_consent_prepare.js");
const fnBuildUpsert = readFn("fn_auth_consent_build_upsert.js");
const fnResponse = readFn("fn_auth_consent_response.js");
const fnOptions = readFn("fn_auth_consent_options.js");

const IDS = {
  comment: "auth_consent_comment_20260714",
  postIn: "auth_consent_post_in_20260714",
  prepare: "auth_consent_prepare_20260714",
  userinfo: "auth_consent_userinfo_20260714",
  buildUpsert: "auth_consent_build_upsert_20260714",
  mongo: "auth_consent_mongo_20260714",
  response: "auth_consent_response_20260714",
  httpResponse: "auth_consent_http_response_20260714",
  optionsIn: "auth_consent_options_in_20260714",
  options: "auth_consent_options_20260714",
  optionsResponse: "auth_consent_options_response_20260714",
};

const ROUTE = "/lk/analytics/auth-consents";
const flow = JSON.parse(fs.readFileSync(sourcePath, "utf8"));
if (!Array.isArray(flow)) throw new Error("Node-RED source flow must be an array");

const analyticsAnchor = flow.find((node) => (
  node?.type === "http in"
  && node?.method === "post"
  && node?.url === "/lk/analytics/events"
));
if (!analyticsAnchor?.z) {
  throw new Error("Enabled LK Analytics anchor /lk/analytics/events was not found");
}

const tabId = analyticsAnchor.z;
const analyticsTab = flow.find((node) => node?.type === "tab" && node?.id === tabId);
if (!analyticsTab || analyticsTab.disabled === true) {
  throw new Error("LK Analytics tab is missing or disabled");
}
const mongoClientIds = Array.from(new Set(
  flow
    .filter((node) => node?.type === "mongodb4" && node?.z === tabId && node?.clientNode)
    .map((node) => node.clientNode),
));
if (mongoClientIds.length !== 1) {
  throw new Error(`Expected one LK Analytics mongodb4 client, found ${mongoClientIds.length}`);
}
const mongoClientId = mongoClientIds[0];

const managedIds = new Set(Object.values(IDS));
const withoutManagedNodes = flow.filter((node) => !managedIds.has(node?.id));
const duplicateRoutes = withoutManagedNodes.filter((node) => (
  node?.type === "http in" && node?.url === ROUTE
));
if (duplicateRoutes.length > 0) {
  throw new Error(`Unmanaged duplicate route exists: ${ROUTE}`);
}

const nodes = [
  {
    id: IDS.comment,
    type: "comment",
    z: tabId,
    name: "Authenticated consent audit",
    info: [
      "POST /lk/analytics/auth-consents",
      "Verifies Bearer through Keycloak clients/userinfo before Mongo write.",
      "Collection: lk_auth_consents.",
      "Idempotency: _id = tenant + verified subject + documentSetVersion.",
      "Current document set version: 2026-07-14.",
    ].join("\n"),
    x: 260,
    y: 440,
    wires: [],
  },
  {
    id: IDS.postIn,
    type: "http in",
    z: tabId,
    name: "Auth consent audit",
    url: ROUTE,
    method: "post",
    upload: false,
    swaggerDoc: "",
    x: 150,
    y: 500,
    wires: [[IDS.prepare]],
  },
  {
    id: IDS.prepare,
    type: "function",
    z: tabId,
    name: "Auth consent prepare userinfo",
    func: fnPrepare,
    outputs: 2,
    timeout: "",
    noerr: 0,
    initialize: "",
    finalize: "",
    libs: [],
    x: 420,
    y: 500,
    wires: [[IDS.userinfo], [IDS.httpResponse]],
  },
  {
    id: IDS.userinfo,
    type: "http request",
    z: tabId,
    name: "Verify consent bearer via Keycloak userinfo",
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
    x: 730,
    y: 480,
    wires: [[IDS.buildUpsert]],
  },
  {
    id: IDS.buildUpsert,
    type: "function",
    z: tabId,
    name: "Auth consent build immutable upsert",
    func: fnBuildUpsert,
    outputs: 2,
    timeout: "",
    noerr: 0,
    initialize: "",
    finalize: "",
    libs: [],
    x: 1050,
    y: 500,
    wires: [[IDS.mongo], [IDS.httpResponse]],
  },
  {
    id: IDS.mongo,
    type: "mongodb4",
    z: tabId,
    clientNode: mongoClientId,
    mode: "collection",
    collection: "lk_auth_consents",
    operation: "updateOne",
    output: "toArray",
    maxTimeMS: "0",
    handleDocId: false,
    name: "Upsert authenticated consent",
    x: 1350,
    y: 480,
    wires: [[IDS.response]],
  },
  {
    id: IDS.response,
    type: "function",
    z: tabId,
    name: "Auth consent response",
    func: fnResponse,
    outputs: 1,
    timeout: "",
    noerr: 0,
    initialize: "",
    finalize: "",
    libs: [],
    x: 1620,
    y: 480,
    wires: [[IDS.httpResponse]],
  },
  {
    id: IDS.httpResponse,
    type: "http response",
    z: tabId,
    name: "",
    statusCode: "",
    headers: {},
    x: 1870,
    y: 500,
    wires: [],
  },
  {
    id: IDS.optionsIn,
    type: "http in",
    z: tabId,
    name: "OPTIONS auth consent audit",
    url: ROUTE,
    method: "options",
    upload: false,
    swaggerDoc: "",
    x: 170,
    y: 580,
    wires: [[IDS.options]],
  },
  {
    id: IDS.options,
    type: "function",
    z: tabId,
    name: "Auth consent CORS preflight",
    func: fnOptions,
    outputs: 1,
    timeout: "",
    noerr: 0,
    initialize: "",
    finalize: "",
    libs: [],
    x: 460,
    y: 580,
    wires: [[IDS.optionsResponse]],
  },
  {
    id: IDS.optionsResponse,
    type: "http response",
    z: tabId,
    name: "",
    statusCode: "",
    headers: {},
    x: 750,
    y: 580,
    wires: [],
  },
];

const nextFlow = [...withoutManagedNodes, ...nodes];
fs.writeFileSync(sourcePath, `${JSON.stringify(nextFlow, null, 2)}\n`, "utf8");
fs.mkdirSync(path.dirname(importPath), { recursive: true });
fs.writeFileSync(importPath, `${JSON.stringify(nodes, null, 2)}\n`, "utf8");

const postRoutes = nextFlow.filter((node) => node?.type === "http in" && node?.method === "post" && node?.url === ROUTE);
const optionsRoutes = nextFlow.filter((node) => node?.type === "http in" && node?.method === "options" && node?.url === ROUTE);
if (postRoutes.length !== 1 || optionsRoutes.length !== 1) {
  throw new Error("Auth consent routes were not patched idempotently");
}

console.log(`Patched auth consent nodes into tab ${tabId}`);
console.log(`Focused import written to ${importPath}`);
