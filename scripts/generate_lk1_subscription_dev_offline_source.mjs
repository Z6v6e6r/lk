#!/usr/bin/env node

import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const fail = (message) => { throw new Error(message); };
const sha256 = (value) => crypto.createHash("sha256").update(value).digest("hex");
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const SCRIPT_PATH = fileURLToPath(import.meta.url);
const isTemporaryChild = (candidate) => (
  candidate.startsWith("/private/tmp/") || candidate.startsWith("/tmp/")
);
const TAB_ID = "lk1_subscription_dev_tab_20260903";
const MONGO_CLIENT_ID = "lk1_subscription_dev_mongo_client_20260903";
const SOURCE_INPUTS = Object.freeze([
  "scripts/nodered_subscription_booking_nodes/fn_subscription_booking_router.js",
  "scripts/nodered_subscription_booking_nodes/fn_subscription_booking_prepare.js",
  "scripts/nodered_subscription_booking_nodes/fn_subscription_booking_finalize.js",
  "scripts/nodered_subscription_booking_nodes/fn_managed_subscription_policy_evaluate.js",
  "scripts/nodered_subscription_booking_nodes/fn_managed_subscription_policy_blocked.js",
  "scripts/nodered_subscription_booking_nodes/fn_subscription_booking_mongo_error.js",
  "scripts/nodered_subscription_booking_nodes/fn_subscription_booking_options.js",
  "scripts/nodered_games_nodes/fn_split_router.js",
  "scripts/nodered_games_nodes/fn_split_create_prepare.js",
  "scripts/nodered_games_nodes/fn_split_join_prepare.js",
]);

const IDS = Object.freeze({
  postIn: "lk_subscription_booking_post_20260804",
  prepare: "lk_subscription_booking_prepare_20260804",
  http: "lk_subscription_booking_http_20260804",
  router: "lk_subscription_booking_router_20260804",
  managedPolicy: "lk_subscription_managed_policy_20260820",
  managedPolicyBlocked: "lk_subscription_managed_policy_blocked_20260820",
  mongoFind: "lk_subscription_booking_find_20260804",
  mongoInsert: "lk_subscription_booking_insert_20260804",
  mongoUpdate: "lk_subscription_booking_update_20260804",
  finalize: "lk_subscription_booking_finalize_20260804",
  response: "lk_subscription_booking_response_20260804",
  catch: "lk_subscription_booking_catch_20260804",
  mongoError: "lk_subscription_booking_mongo_error_20260804",
  optionsIn: "lk_subscription_booking_options_in_20260804",
  options: "lk_subscription_booking_options_20260804",
  optionsResponse: "lk_subscription_booking_options_response_20260804",
  debug: "lk_subscription_booking_debug_20260804",
  splitRouter: "8f7bd5b482fe9763",
  splitCreate: "f3f9a60354d394da",
  splitJoin: "e92e68bf3f08a70c",
  splitHttp: "ee7ba8cdd68bdf74",
});

const readSource = (relativePath) => fs.readFileSync(path.join(ROOT, relativePath), "utf8");
const functionNode = (id, name, sourcePath, outputs, wires) => ({
  id, type: "function", z: TAB_ID, name, func: readSource(sourcePath), outputs,
  timeout: "", noerr: 0, initialize: "", finalize: "", libs: [], wires,
});
const httpRequestNode = (id, name, target) => ({
  id, type: "http request", z: TAB_ID, name, method: "use", ret: "obj",
  paytoqs: "ignore", url: "", requestTimeout: "20000", senderr: true,
  persist: false, authType: "", insecureHTTPParser: false, wires: [[target]],
});
const mongoNode = (id, name, operation) => ({
  id, type: "mongodb4", z: TAB_ID, name, collection: "lk_subscription_daily_booking_ops",
  operation, clientNode: MONGO_CLIENT_ID, mode: "collection", output: "toArray",
  maxTimeMS: "5000", handleDocId: false, wires: [[IDS.router]],
});

export function buildOfflineDevSourceFlow() {
  return [
    { id: TAB_ID, type: "tab", label: "LK Games", disabled: false, info: "Isolated LK1 subscription DEV source" },
    { id: IDS.postIn, type: "http in", z: TAB_ID, name: "LK subscription booking", url: "/lk/subscription-bookings", method: "post", upload: false, swaggerDoc: "", wires: [[IDS.prepare]] },
    functionNode(IDS.prepare, "Prepare subscription booking", "scripts/nodered_subscription_booking_nodes/fn_subscription_booking_prepare.js", 2, [[IDS.http], [IDS.finalize]]),
    httpRequestNode(IDS.http, "Subscription booking fixture request", IDS.router),
    functionNode(IDS.router, "Route atomic subscription booking", "scripts/nodered_subscription_booking_nodes/fn_subscription_booking_router.js", 7, [[IDS.http], [IDS.mongoFind], [IDS.mongoInsert], [IDS.mongoUpdate], [IDS.finalize], [], [IDS.managedPolicy]]),
    functionNode(IDS.managedPolicy, "Evaluate managed subscription policy", "scripts/nodered_subscription_booking_nodes/fn_managed_subscription_policy_evaluate.js", 2, [[IDS.router], [IDS.managedPolicyBlocked]]),
    functionNode(IDS.managedPolicyBlocked, "Block managed subscription decision", "scripts/nodered_subscription_booking_nodes/fn_managed_subscription_policy_blocked.js", 1, [[IDS.finalize]]),
    mongoNode(IDS.mongoFind, "Find daily subscription operation", "find"),
    mongoNode(IDS.mongoInsert, "Insert daily subscription operation", "insertOne"),
    mongoNode(IDS.mongoUpdate, "Update daily subscription operation", "updateOne"),
    functionNode(IDS.finalize, "Finalize subscription booking response", "scripts/nodered_subscription_booking_nodes/fn_subscription_booking_finalize.js", 2, [[IDS.splitRouter], [IDS.response]]),
    { id: IDS.response, type: "http response", z: TAB_ID, name: "", statusCode: "", headers: {}, wires: [] },
    { id: IDS.catch, type: "catch", z: TAB_ID, name: "Catch subscription booking persistence errors", scope: [IDS.mongoFind, IDS.mongoInsert, IDS.mongoUpdate], uncaught: false, wires: [[IDS.mongoError]] },
    functionNode(IDS.mongoError, "Fail closed on subscription booking persistence", "scripts/nodered_subscription_booking_nodes/fn_subscription_booking_mongo_error.js", 1, [[IDS.finalize]]),
    { id: IDS.optionsIn, type: "http in", z: TAB_ID, name: "OPTIONS subscription booking", url: "/lk/subscription-bookings", method: "options", upload: false, swaggerDoc: "", wires: [[IDS.options]] },
    functionNode(IDS.options, "Subscription booking CORS", "scripts/nodered_subscription_booking_nodes/fn_subscription_booking_options.js", 1, [[IDS.optionsResponse]]),
    { id: IDS.optionsResponse, type: "http response", z: TAB_ID, name: "", statusCode: "", headers: {}, wires: [] },
    { id: IDS.debug, type: "debug", z: TAB_ID, name: "subscription booking debug", active: false, tosidebar: true, console: false, tostatus: false, complete: "payload", targetType: "msg", statusVal: "", statusType: "auto", wires: [] },
    functionNode(IDS.splitRouter, "Route Viva split payment", "scripts/nodered_games_nodes/fn_split_router.js", 5, [[IDS.splitHttp], [], [], [IDS.http], []]),
    functionNode(IDS.splitCreate, "Prepare split game payment", "scripts/nodered_games_nodes/fn_split_create_prepare.js", 4, [[IDS.splitHttp], [], [], [IDS.splitRouter]]),
    functionNode(IDS.splitJoin, "Prepare split join payment", "scripts/nodered_games_nodes/fn_split_join_prepare.js", 4, [[IDS.splitHttp], [], [], [IDS.splitRouter]]),
    httpRequestNode(IDS.splitHttp, "Split payment fixture request", IDS.splitRouter),
    {
      id: MONGO_CLIENT_ID, type: "mongodb4-client", name: "LK1 subscription DEV fixture",
      uri: "mongodb://127.0.0.1:27030/lk1_subscription_dev_fixture",
      advanced: "{}", uriTabActive: "tab-uri-advanced",
    },
  ];
}

const parseArgs = (argv) => {
  if (argv.length !== 2 || argv[0] !== "--workspace") {
    fail("Usage: node scripts/generate_lk1_subscription_dev_offline_source.mjs --workspace <external-workspace>");
  }
  const requestedWorkspace = path.resolve(argv[1]);
  const parent = fs.realpathSync(path.dirname(requestedWorkspace));
  const workspace = path.join(parent, path.basename(requestedWorkspace));
  if (!isTemporaryChild(workspace) || path.basename(requestedWorkspace) !== path.basename(argv[1])) {
    fail("DEV offline source workspace must be under /private/tmp or /tmp");
  }
  if (fs.existsSync(workspace)) fail("Refusing to overwrite an existing DEV offline workspace");
  return workspace;
};

export function publishOfflineDevSource(workspace) {
  const requestedWorkspace = path.resolve(workspace);
  const parent = fs.realpathSync(path.dirname(requestedWorkspace));
  const resolvedWorkspace = path.join(parent, path.basename(requestedWorkspace));
  if (!isTemporaryChild(resolvedWorkspace)) {
    fail("DEV offline source workspace must be under /private/tmp or /tmp");
  }
  if (fs.existsSync(resolvedWorkspace)) fail("Refusing to overwrite an existing DEV offline workspace");
  const inputDirectory = path.join(resolvedWorkspace, "input");
  fs.mkdirSync(inputDirectory, { recursive: true, mode: 0o700 });
  const sourcePath = path.join(inputDirectory, "source.flow.json");
  const metaPath = path.join(inputDirectory, "source.flow.meta.json");
  const credentialStorePath = path.join(inputDirectory, "source.flow.credentials.json");
  const sourceText = `${JSON.stringify(buildOfflineDevSourceFlow(), null, 2)}\n`;
  fs.writeFileSync(sourcePath, sourceText, { encoding: "utf8", mode: 0o600, flag: "wx" });
  fs.writeFileSync(credentialStorePath, "{}\n", { encoding: "utf8", mode: 0o600, flag: "wx" });
  fs.writeFileSync(metaPath, `${JSON.stringify({
    environment: "DEV",
    sourceKind: "offline-dedicated-dev-bootstrap",
    generatorPath: "scripts/generate_lk1_subscription_dev_offline_source.mjs",
    generatorSha256: sha256(fs.readFileSync(SCRIPT_PATH)),
    sourceInputsSha256: Object.fromEntries(SOURCE_INPUTS.map((file) => [
      file, sha256(fs.readFileSync(path.join(ROOT, file))),
    ])),
  }, null, 2)}\n`, { encoding: "utf8", mode: 0o600, flag: "wx" });
  execFileSync(process.execPath, [
    path.join(ROOT, "scripts/inspect_lk1_subscription_dev_snapshot.mjs"),
    sourcePath, metaPath, credentialStorePath,
  ], { cwd: ROOT, stdio: "pipe" });
  const audit = JSON.parse(fs.readFileSync(metaPath, "utf8"));
  const binding = {
    formatVersion: 1,
    environment: "DEV",
    bindingState: "BOUND_SOURCE_ONLY",
    environmentIdentityVerified: false,
    source: {
      sourceKind: audit.sourceKind,
      generatorPath: audit.generatorPath,
      generatorSha256: audit.generatorSha256,
      sourceInputsSha256: audit.sourceInputsSha256,
      sourceSha256: audit.sourceSha256,
      sourceNodeInventorySha256: audit.sourceNodeInventorySha256,
      nodeCount: audit.nodeCount,
      httpRouteCount: audit.httpRouteCount,
      tabCount: audit.tabCount,
      brokenWires: audit.brokenWires,
      brokenLinks: audit.brokenLinks,
    },
    target: audit.target,
    runtime: {
      apiBase: "http://127.0.0.1:3037/api",
      completeManagedContractExposed: false,
      reason: "Source-only binding; DEV services are stopped and no runtime contract was exercised",
    },
    dependencies: audit.dependencies,
    endpointAudit: audit.endpointAudit,
    installTarget: {
      sourceHost: "lk-reserve-89",
      sourceHostname: "89-108-64-209.cloudvps.regruhosting.ru",
      serviceName: "lk1-subscription-dev-nodered.service",
      unixUser: "lk1-subscription-dev",
      userDir: "/srv/lk1-subscription-dev/node-red",
      remoteFlowPath: "/srv/lk1-subscription-dev/node-red/flows.json",
    },
    candidateSha256: null,
    installAllowed: false,
    productionBindingState: "UNBOUND_AFTER_ROUTER_AMENDMENT",
  };
  fs.writeFileSync(metaPath, `${JSON.stringify(binding, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
  return { sourcePath, metaPath, credentialStorePath, sourceSha256: sha256(sourceText) };
}

if (process.argv[1] === SCRIPT_PATH) {
  const result = publishOfflineDevSource(parseArgs(process.argv.slice(2)));
  process.stdout.write(`sourceSha256=${result.sourceSha256}\n`);
  process.stdout.write(`sourcePath=${result.sourcePath}\n`);
  process.stdout.write(`metaPath=${result.metaPath}\n`);
  process.stdout.write(`credentialStorePath=${result.credentialStorePath}\n`);
}
