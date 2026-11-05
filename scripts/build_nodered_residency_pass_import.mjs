#!/usr/bin/env node
// Deterministic builder for the LK residency-pass gateway Node-RED import.
//
// The gateway is a *new* standalone flow: it does not patch node-red/modular/source.flow.json
// and therefore needs no live-147 preimage. Importing the produced JSON into Node-RED is a
// separate, explicitly approved live action.
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(scriptDir, "..");
const outputPath = path.join(repoRoot, "node-red/imports/lk_residency_pass.import.json");

export const FUNCTION_SOURCES = [
  "fn_residency_pass_create_prepare.js",
  "fn_residency_pass_status_prepare.js",
  "fn_residency_pass_authorize.js",
  "fn_residency_pass_resolve.js",
  "fn_residency_pass_create_response.js",
  "fn_residency_pass_status_response.js",
  "fn_residency_pass_options.js",
];

const CREATE_ROUTE = "/lk/residency/passes";
const STATUS_ROUTE = "/lk/residency/passes/:passId";

const IDS = Object.freeze({
  tab: "lk_resident_pass_tab_20261105",
  comment: "lk_resident_pass_comment_20261105",
  createIn: "lk_resident_pass_create_in_20261105",
  createPrepare: "lk_resident_pass_create_prepare_20261105",
  statusIn: "lk_resident_pass_status_in_20261105",
  statusPrepare: "lk_resident_pass_status_prepare_20261105",
  optionsIn: "lk_resident_pass_options_in_20261105",
  optionsStatusIn: "lk_resident_pass_status_options_in_20261105",
  options: "lk_resident_pass_options_20261105",
  userinfo: "lk_resident_pass_userinfo_20261105",
  authorize: "lk_resident_pass_authorize_20261105",
  endpointSwitch: "lk_resident_pass_endpoint_switch_20261105",
  vivaSubscriptions: "lk_resident_pass_viva_subscriptions_20261105",
  resolve: "lk_resident_pass_resolve_20261105",
  cupCreate: "lk_resident_pass_cup_create_20261105",
  cupStatus: "lk_resident_pass_cup_status_20261105",
  createResponse: "lk_resident_pass_create_response_20261105",
  statusResponse: "lk_resident_pass_status_response_20261105",
  httpResponse: "lk_resident_pass_http_response_20261105",
});

const COMMENT_INFO = [
  "LK resident pass gateway (B in the residency program).",
  "",
  "POST   " + CREATE_ROUTE + "  -> CUP internal POST /internal/subscriptions/resident-passes",
  "GET    " + STATUS_ROUTE + "  -> CUP internal GET  <RESIDENT_CLIENT_CUP_PASS_STATUS_PATH><passId>",
  "OPTIONS " + CREATE_ROUTE + " -> CORS preflight",
  "OPTIONS " + STATUS_ROUTE + " -> CORS preflight",
  "",
  "Browser contract: docs/residency-client.md (LK repository).",
  "The browser never receives the CUP base URL or the integration token.",
  "",
  "Required environment: RESIDENT_CLIENT_ENABLED, RESIDENT_CLIENT_CUP_API_BASE_URL,",
  "RESIDENT_CLIENT_CUP_INTEGRATION_TOKEN.",
  "Optional: RESIDENT_CLIENT_CUP_PASS_STATUS_PATH (status route disabled when empty),",
  "RESIDENT_CLIENT_KEYCLOAK_USERINFO_URL, RESIDENT_CLIENT_VIVA_API_BASE_URL,",
  "RESIDENT_CLIENT_EXPECTED_CLIENT_ID, RESIDENT_CLIENT_TENANT_KEY,",
  "RESIDENT_CLIENT_RATE_LIMIT_PER_MINUTE.",
  "",
  "Flow guards: bearer verified through Keycloak userinfo before any upstream call;",
  "subscription ownership verified against Viva before the CUP call; tokens and PII are",
  "never logged; responses are no-store/no-referrer.",
].join("\n");

export function readFunctionSources(root = repoRoot) {
  const dir = path.join(root, "scripts/nodered_residency_pass_nodes");
  const present = fs.readdirSync(dir).filter((name) => name.endsWith(".js")).sort();
  const missing = FUNCTION_SOURCES.filter((name) => !present.includes(name));
  const unexpected = present.filter((name) => !FUNCTION_SOURCES.includes(name));
  if (missing.length > 0) throw new Error(`Missing residency pass function sources: ${missing.join(", ")}`);
  if (unexpected.length > 0) throw new Error(`Unexpected residency pass function sources: ${unexpected.join(", ")}`);
  const sources = {};
  for (const name of FUNCTION_SOURCES) {
    const source = fs.readFileSync(path.join(dir, name), "utf8");
    if (!source.trim()) throw new Error(`Empty residency pass function source: ${name}`);
    if (/console\.(log|error|warn)\(/.test(source)) {
      throw new Error(`Residency pass function source must not use console: ${name}`);
    }
    sources[name] = source;
  }
  return sources;
}

function httpInNode(id, name, url, method, x, y, target) {
  return {
    id,
    type: "http in",
    z: IDS.tab,
    name,
    url,
    method,
    upload: false,
    swaggerDoc: "",
    x,
    y,
    wires: [[target]],
  };
}

function httpRequestNode(id, name, x, y, target) {
  return {
    id,
    type: "http request",
    z: IDS.tab,
    name,
    method: "use",
    // Parse in the following function so malformed/empty bodies stay service errors.
    ret: "txt",
    paytoqs: "ignore",
    url: "",
    tls: "",
    persist: false,
    proxy: "",
    insecureHTTPParser: false,
    authType: "",
    senderr: true,
    headers: [],
    x,
    y,
    wires: [[target]],
  };
}

function functionNode(id, name, func, x, y, wires) {
  return {
    id,
    type: "function",
    z: IDS.tab,
    name,
    func,
    outputs: wires.length,
    timeout: "",
    noerr: 0,
    initialize: "",
    finalize: "",
    libs: [],
    x,
    y,
    wires,
  };
}

function httpResponseNode(id, x, y) {
  return { id, type: "http response", z: IDS.tab, name: "", statusCode: "", headers: {}, x, y, wires: [] };
}

export function buildResidencyPassNodes(sources = readFunctionSources()) {
  const nodes = [
    {
      id: IDS.tab,
      type: "tab",
      label: "LK Resident Pass",
      disabled: false,
      info: COMMENT_INFO,
      env: [],
    },
    {
      id: IDS.comment,
      type: "comment",
      z: IDS.tab,
      name: "LK resident pass gateway (B)",
      info: COMMENT_INFO,
      x: 240,
      y: 80,
      wires: [],
    },
    httpInNode(IDS.createIn, "Create resident pass", CREATE_ROUTE, "post", 180, 160, IDS.createPrepare),
    functionNode(
      IDS.createPrepare,
      "Validate create request",
      sources["fn_residency_pass_create_prepare.js"],
      470,
      160,
      [[IDS.userinfo], [IDS.httpResponse]],
    ),
    httpInNode(IDS.statusIn, "Resident pass status", STATUS_ROUTE, "get", 180, 300, IDS.statusPrepare),
    functionNode(
      IDS.statusPrepare,
      "Validate status request",
      sources["fn_residency_pass_status_prepare.js"],
      470,
      300,
      [[IDS.userinfo], [IDS.httpResponse]],
    ),
    httpInNode(IDS.optionsIn, "Resident pass CORS preflight", CREATE_ROUTE, "options", 180, 440, IDS.options),
    httpInNode(IDS.optionsStatusIn, "Resident pass status CORS preflight", STATUS_ROUTE, "options", 180, 520, IDS.options),
    functionNode(
      IDS.options,
      "Resident pass CORS preflight",
      sources["fn_residency_pass_options.js"],
      470,
      440,
      [[IDS.httpResponse]],
    ),
    httpRequestNode(IDS.userinfo, "Verify LK bearer via Keycloak userinfo", 760, 220, IDS.authorize),
    functionNode(
      IDS.authorize,
      "Authorize and choose upstream",
      sources["fn_residency_pass_authorize.js"],
      1030,
      220,
      [[IDS.endpointSwitch], [IDS.httpResponse]],
    ),
    {
      id: IDS.endpointSwitch,
      type: "switch",
      z: IDS.tab,
      name: "Endpoint",
      property: "_residentPass.endpoint",
      propertyType: "msg",
      rules: [
        { t: "eq", v: "create", vt: "str" },
        { t: "eq", v: "status", vt: "str" },
      ],
      checkall: "true",
      repair: false,
      outputs: 2,
      x: 1300,
      y: 220,
      wires: [[IDS.vivaSubscriptions], [IDS.cupStatus]],
    },
    httpRequestNode(IDS.vivaSubscriptions, "Read LK active subscriptions", 1560, 200, IDS.resolve),
    functionNode(
      IDS.resolve,
      "Resolve owned subscription and build CUP pass request",
      sources["fn_residency_pass_resolve.js"],
      1840,
      200,
      [[IDS.cupCreate], [IDS.httpResponse]],
    ),
    httpRequestNode(IDS.cupCreate, "Create CUP resident pass", 2110, 200, IDS.createResponse),
    functionNode(
      IDS.createResponse,
      "Map CUP pass response",
      sources["fn_residency_pass_create_response.js"],
      2380,
      200,
      [[IDS.httpResponse]],
    ),
    httpRequestNode(IDS.cupStatus, "Read CUP resident pass status", 1560, 320, IDS.statusResponse),
    functionNode(
      IDS.statusResponse,
      "Map CUP pass status response",
      sources["fn_residency_pass_status_response.js"],
      1840,
      320,
      [[IDS.httpResponse]],
    ),
    httpResponseNode(IDS.httpResponse, 2660, 260),
  ];
  return nodes;
}

export function validateResidencyPassNodes(nodes, sources = readFunctionSources()) {
  const errors = [];
  const ids = new Set();
  for (const node of nodes) {
    if (!node?.id) errors.push("node without id");
    else if (ids.has(node.id)) errors.push(`duplicate node id: ${node.id}`);
    else ids.add(node.id);
  }
  for (const node of nodes) {
    for (const wire of node.wires ?? []) {
      for (const target of wire) {
        if (!ids.has(target)) errors.push(`${node.id} wires to unknown node ${target}`);
      }
    }
  }
  const routes = nodes.filter((node) => node.type === "http in");
  const countRoute = (method, url) => routes.filter((node) => node.method === method && node.url === url).length;
  if (countRoute("post", CREATE_ROUTE) !== 1) errors.push(`expected one POST ${CREATE_ROUTE}`);
  if (countRoute("options", CREATE_ROUTE) !== 1) errors.push(`expected one OPTIONS ${CREATE_ROUTE}`);
  if (countRoute("get", STATUS_ROUTE) !== 1) errors.push(`expected one GET ${STATUS_ROUTE}`);
  if (countRoute("options", STATUS_ROUTE) !== 1) errors.push(`expected one OPTIONS ${STATUS_ROUTE}`);
  if (routes.length !== 4) errors.push(`expected exactly 4 http in nodes, found ${routes.length}`);
  const responses = nodes.filter((node) => node.type === "http response").length;
  if (responses !== 1) errors.push(`expected exactly one shared http response node, found ${responses}`);
  const serialized = JSON.stringify(nodes);
  for (const forbidden of ["console.log", "console.error", "process.env", "require("]) {
    if (serialized.includes(forbidden)) errors.push(`import must not contain ${forbidden}`);
  }
  const combinedSource = FUNCTION_SOURCES.map((name) => sources[name] ?? "").join("\n");
  const tokenReads = (combinedSource.match(/readEnv\("RESIDENT_CLIENT_CUP_INTEGRATION_TOKEN"\)/g) ?? []).length;
  if (tokenReads === 0) errors.push("integration token is never read from the environment");
  for (const forbidden of [/node\.warn\([^)]*authorization/i, /node\.warn\([^)]*payload/i]) {
    if (forbidden.test(combinedSource)) errors.push(`functions must not log request data: ${forbidden}`);
  }
  return errors;
}

export function serializeNodes(nodes) {
  return `${JSON.stringify(nodes, null, 2)}\n`;
}

function main() {
  const checkOnly = process.argv.includes("--check");
  const sources = readFunctionSources();
  const nodes = buildResidencyPassNodes(sources);
  const errors = validateResidencyPassNodes(nodes, sources);
  if (errors.length > 0) {
    for (const error of errors) console.error(`Residency pass import invalid: ${error}`);
    process.exit(1);
  }
  const serialized = serializeNodes(nodes);
  const sha256 = crypto.createHash("sha256").update(serialized).digest("hex");
  if (checkOnly) {
    let existing = null;
    try {
      existing = fs.readFileSync(outputPath, "utf8");
    } catch {
      existing = null;
    }
    if (existing !== serialized) {
      console.error("Residency pass import is out of date; run: node scripts/build_nodered_residency_pass_import.mjs");
      process.exit(1);
    }
    console.log(`Residency pass import is up to date (sha256 ${sha256}).`);
    return;
  }
  fs.mkdirSync(path.dirname(outputPath), { recursive: true });
  fs.writeFileSync(outputPath, serialized, "utf8");
  console.log(`Wrote ${path.relative(repoRoot, outputPath)} (${nodes.length} nodes, sha256 ${sha256}).`);
  console.log("Importing this flow into Node-RED, enabling it and setting its environment is a separate approved action.");
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main();
}
