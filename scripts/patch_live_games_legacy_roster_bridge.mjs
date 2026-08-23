import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

const EXPECTED_FLOW_SHA256 = "2ff19d3543030ef14a7d551eca44dd44de9997d5641c36bdde828f8c4eec6861";
const EXPECTED_PATCH_FUNC_SHA256 = "4fb7d6ca9961e854cefb22f0752f9c1f921e1b6cbacfea3ce16e8b8681538931";
const PATCH_NODE_ID = "e0d7883bc1a9fa8c";
const MONGO_TEMPLATE_ID = "591234d213742276";
const AUTOJOIN_FIND_ID = "5fc5eaeab97f3f88";
const SPLIT_JOIN_PREPARE_ID = "e92e68bf3f08a70c";
const SPLIT_JOIN_PREPARE_SHA256 = "415a2131acd876a4a973d71f9478c2ccd127dee4d59fbc5043ca77db15b4a0e6";
const SPLIT_ROUTER_ID = "8f7bd5b482fe9763";
const SPLIT_ROUTER_SHA256 = "6be5041a581846dc53ecf0ef02c4c7e90adff52b94c4ee0d9ca2ff9d6b82eaad";
const TAB_ID = "4b91e2a2413688db";
const ROUTE = "/lk/games/:gameId/roster-command";
const PAYMENT_ROUTE = "/lk/games/:gameId/roster-payment-confirm";
const IDS = {
  post: "legacy_roster_bridge_post_20260816",
  options: "legacy_roster_bridge_options_20260816",
  optionsFn: "legacy_roster_bridge_options_fn_20260816",
  prepare: "legacy_roster_bridge_prepare_20260816",
  request: "legacy_roster_bridge_http_20260816",
  response: "legacy_roster_bridge_response_20260816",
  find: "legacy_roster_bridge_find_20260816",
  build: "legacy_roster_bridge_build_20260816",
  update: "legacy_roster_bridge_update_20260816",
  ack: "legacy_roster_bridge_ack_20260816",
  httpResponse: "legacy_roster_bridge_http_response_20260816",
  paymentPost: "legacy_payment_confirm_post_20260816",
  paymentOptions: "legacy_payment_confirm_options_20260816",
  paymentQuery: "legacy_payment_confirm_query_20260816",
  paymentFind: "legacy_payment_confirm_find_20260816",
  paymentCanonicalPrepare: "legacy_payment_confirm_canonical_prepare_20260816",
  paymentCanonicalRequest: "legacy_payment_confirm_canonical_http_20260816",
};

const argumentPairs = [];
for (let index = 2; index < process.argv.length; index += 2) {
  argumentPairs.push([process.argv[index], process.argv[index + 1]]);
}
const args = Object.fromEntries(argumentPairs);
if (!args["--input"] || !args["--output"] || !args["--report"]) {
  throw new Error("Usage: --input <fresh-live-flow.json> --output <candidate.json> --report <report.json>");
}
const artifactPaths = [args["--input"], args["--output"], args["--report"]].map((value) => path.resolve(value));
if (new Set(artifactPaths).size !== artifactPaths.length) {
  throw new Error("Input, candidate and report paths must be distinct");
}
for (const artifactPath of artifactPaths.slice(1)) {
  if (fs.existsSync(artifactPath)) {
    throw new Error(`Refusing to overwrite an existing artifact: ${artifactPath}`);
  }
}
const sha256 = (value) => crypto.createHash("sha256").update(value).digest("hex");
const inputRaw = fs.readFileSync(args["--input"]);
if (sha256(inputRaw) !== EXPECTED_FLOW_SHA256) {
  throw new Error("Fresh live flow SHA changed; refusing to build a candidate from an unaudited source");
}
const flow = JSON.parse(inputRaw);
if (!Array.isArray(flow)) throw new Error("Node-RED flow must be an array");
const exactNode = (id, type) => {
  const matches = flow.filter((node) => node?.id === id && node?.type === type);
  if (matches.length !== 1) throw new Error(`${id} must exist exactly once as ${type}`);
  return matches[0];
};
const patchNode = exactNode(PATCH_NODE_ID, "function");
if (sha256(patchNode.func) !== EXPECTED_PATCH_FUNC_SHA256) {
  throw new Error("Live generic game PATCH function drifted; refusing to close the wrong writer");
}
if (flow.some((node) => Object.values(IDS).includes(node.id))) {
  throw new Error("Legacy roster bridge node IDs already exist");
}
if (flow.some((node) => node.type === "http in" && node.url === ROUTE)) {
  throw new Error("Legacy roster bridge route already exists");
}
if (flow.some((node) => node.type === "http in" && node.url === PAYMENT_ROUTE)) {
  throw new Error("Legacy payment confirmation route already exists");
}
const sourceDir = path.join(path.dirname(fileURLToPath(import.meta.url)), "nodered_games_nodes");
const source = (name) => fs.readFileSync(path.join(sourceDir, name), "utf8");
patchNode.func = source("fn_patch.js");

const splitJoinPrepare = exactNode(SPLIT_JOIN_PREPARE_ID, "function");
if (sha256(splitJoinPrepare.func) !== SPLIT_JOIN_PREPARE_SHA256) {
  throw new Error("Live split join preparation drifted; refusing to attach payment verification");
}
splitJoinPrepare.func = source("fn_split_join_prepare.js");
const splitRouter = exactNode(SPLIT_ROUTER_ID, "function");
if (sha256(splitRouter.func) !== SPLIT_ROUTER_SHA256) {
  throw new Error("Live split payment router drifted; refusing to attach payment verification");
}
splitRouter.func = source("fn_split_router.js");
splitRouter.outputs = 5;
splitRouter.wires = [...splitRouter.wires, [IDS.paymentCanonicalPrepare]];

const mongoTemplate = exactNode(MONGO_TEMPLATE_ID, "mongodb4");
exactNode(AUTOJOIN_FIND_ID, "mongodb4");
const functionNode = (id, name, func, outputs, x, y, wires) => ({
  id,
  type: "function",
  z: TAB_ID,
  name,
  func,
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
const added = [
  {
    id: IDS.post,
    type: "http in",
    z: TAB_ID,
    name: "Canonical legacy game roster command",
    url: ROUTE,
    method: "post",
    upload: false,
    swaggerDoc: "",
    x: 150,
    y: 3420,
    wires: [[IDS.prepare]],
  },
  {
    id: IDS.options,
    type: "http in",
    z: TAB_ID,
    name: "OPTIONS canonical legacy game roster command",
    url: ROUTE,
    method: "options",
    upload: false,
    swaggerDoc: "",
    x: 180,
    y: 3500,
    wires: [[IDS.optionsFn]],
  },
  functionNode(
    IDS.optionsFn,
    "Legacy roster bridge CORS",
    `msg.statusCode = 204;\nmsg.headers = {\n  "Access-Control-Allow-Origin": "*",\n  "Access-Control-Allow-Methods": "POST, OPTIONS",\n  "Access-Control-Allow-Headers": "Authorization, Content-Type, Idempotency-Key, X-Correlation-ID",\n  "Access-Control-Max-Age": "600",\n  "Cache-Control": "no-store",\n};\nmsg.payload = "";\nreturn msg;\n`,
    1,
    520,
    3500,
    [[IDS.httpResponse]],
  ),
  functionNode(
    IDS.prepare,
    "Prepare canonical roster command",
    source("fn_legacy_roster_bridge_prepare.js"),
    2,
    470,
    3420,
    [[IDS.request], [IDS.httpResponse]],
  ),
  {
    id: IDS.request,
    type: "http request",
    z: TAB_ID,
    name: "PadlHub canonical roster command",
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
    x: 760,
    y: 3400,
    wires: [[IDS.response]],
  },
  functionNode(
    IDS.response,
    "Validate canonical roster response",
    source("fn_legacy_roster_bridge_response.js"),
    2,
    1040,
    3400,
    [[IDS.find], [IDS.httpResponse]],
  ),
  {
    ...structuredClone(mongoTemplate),
    id: IDS.find,
    name: "Read legacy game for canonical projection",
    operation: "find",
    x: 1290,
    y: 3380,
    wires: [[IDS.build]],
  },
  functionNode(
    IDS.build,
    "Build canonical roster projection CAS",
    source("fn_legacy_roster_projection_build.js"),
    3,
    1540,
    3380,
    [[IDS.update], [IDS.httpResponse], [IDS.httpResponse]],
  ),
  {
    ...structuredClone(mongoTemplate),
    id: IDS.update,
    name: "Apply canonical roster projection CAS",
    operation: "updateOne",
    x: 1810,
    y: 3360,
    wires: [[IDS.ack]],
  },
  functionNode(
    IDS.ack,
    "Acknowledge canonical roster projection CAS",
    source("fn_legacy_roster_projection_ack.js"),
    4,
    2070,
    3360,
    [[IDS.httpResponse], [IDS.find], [IDS.httpResponse], [AUTOJOIN_FIND_ID]],
  ),
  {
    id: IDS.httpResponse,
    type: "http response",
    z: TAB_ID,
    name: "Legacy roster bridge response",
    statusCode: "",
    headers: {},
    x: 2350,
    y: 3420,
    wires: [],
  },
  {
    id: IDS.paymentPost,
    type: "http in",
    z: TAB_ID,
    name: "Verify and confirm legacy game payment",
    url: PAYMENT_ROUTE,
    method: "post",
    upload: false,
    swaggerDoc: "",
    x: 170,
    y: 3580,
    wires: [[IDS.paymentQuery]],
  },
  {
    id: IDS.paymentOptions,
    type: "http in",
    z: TAB_ID,
    name: "OPTIONS verify legacy game payment",
    url: PAYMENT_ROUTE,
    method: "options",
    upload: false,
    swaggerDoc: "",
    x: 180,
    y: 3620,
    wires: [[IDS.optionsFn]],
  },
  functionNode(
    IDS.paymentQuery,
    "Validate payment confirmation locator",
    source("fn_legacy_payment_confirm_query.js"),
    2,
    490,
    3580,
    [[IDS.paymentFind], [IDS.httpResponse]],
  ),
  {
    ...structuredClone(mongoTemplate),
    id: IDS.paymentFind,
    name: "Read game for payment verification",
    operation: "find",
    x: 770,
    y: 3580,
    wires: [[SPLIT_JOIN_PREPARE_ID]],
  },
  functionNode(
    IDS.paymentCanonicalPrepare,
    "Forward verified payment to canonical roster",
    source("fn_legacy_payment_confirm_to_canonical.js"),
    2,
    1790,
    3580,
    [[IDS.paymentCanonicalRequest], [IDS.httpResponse]],
  ),
  {
    id: IDS.paymentCanonicalRequest,
    type: "http request",
    z: TAB_ID,
    name: "PadlHub canonical payment confirmation",
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
    x: 2070,
    y: 3580,
    wires: [[IDS.response]],
  },
];
flow.push(...added);
const idSet = new Set(flow.map((node) => node.id));
if (idSet.size !== flow.length) throw new Error("Candidate contains duplicate node IDs");
for (const node of flow) {
  for (const output of node.wires || []) {
    for (const targetId of output || []) {
      if (!idSet.has(targetId)) throw new Error(`Broken wire ${node.id} -> ${targetId}`);
    }
  }
}
const output = `${JSON.stringify(flow, null, 2)}\n`;
const report = `${JSON.stringify({
    sourceFlowSha256: EXPECTED_FLOW_SHA256,
    candidateSha256: sha256(output),
    patchedNodeId: PATCH_NODE_ID,
    auditedNodePreimages: {
      [PATCH_NODE_ID]: EXPECTED_PATCH_FUNC_SHA256,
      [SPLIT_JOIN_PREPARE_ID]: SPLIT_JOIN_PREPARE_SHA256,
      [SPLIT_ROUTER_ID]: SPLIT_ROUTER_SHA256,
    },
    addedNodeIds: added.map((node) => node.id),
    routes: [ROUTE, PAYMENT_ROUTE],
    featureFlag: "PADLHUB_LEGACY_ROSTER_BRIDGE_ENABLED",
    patchGuardFeatureFlag: "PADLHUB_LEGACY_ROSTER_PATCH_GUARD_ENABLED",
    serverSecretEnv: "PADLHUB_LEGACY_ROSTER_TOKEN",
    liveWritesPerformed: false,
  }, null, 2)}\n`;
fs.writeFileSync(args["--output"], output, { mode: 0o600, flag: "wx" });
try {
  fs.writeFileSync(args["--report"], report, { mode: 0o600, flag: "wx" });
} catch (error) {
  fs.unlinkSync(args["--output"]);
  throw error;
}
