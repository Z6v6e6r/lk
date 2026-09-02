import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import test from "node:test";
import {
  assertProductionManifestEnvironment,
  buildDevCandidate,
  publishDevCandidate,
  validateDevBinding,
  validateDevInstallTarget,
  validateDevInstallManifest,
  validateEnvironmentApiBase,
} from "../prepare_lk1_subscription_dev_candidate.mjs";
import { verifyDevInstallManifest } from "../verify_lk1_subscription_dev_install.mjs";
import {
  assertProductionManifestEnvironment as assertProductionBuilderManifestEnvironment,
} from "../prepare_lk1_subscription_enforcement_candidate.mjs";

const sha256 = (value) => crypto.createHash("sha256").update(value).digest("hex");
const endpointInventorySha256 = (flow) => {
  const inventory = [];
  const visit = (value, pathPrefix = "$") => {
    if (typeof value === "string") {
      for (const literal of value.match(/https?:\/\/[^\s"'`]+/g) || []) {
        const normalized = literal.replace(/[),;]+$/, "");
        inventory.push({ path: pathPrefix, literal: normalized, origin: new URL(normalized).origin });
      }
      return;
    }
    if (Array.isArray(value)) {
      value.forEach((entry, index) => visit(entry, `${pathPrefix}[${index}]`));
      return;
    }
    if (!value || typeof value !== "object") return;
    for (const [key, entry] of Object.entries(value)) {
      if (key === "func" && value.type === "function") continue;
      visit(entry, `${pathPrefix}.${key}`);
    }
  };
  visit(flow);
  return sha256(JSON.stringify(inventory));
};
const DEV_API_BASE = "http://127.0.0.1:3037/api";
const DEV_INSTALL_TARGET = Object.freeze({
  sourceHost: "lk-reserve-89",
  sourceHostname: "89-108-64-209.cloudvps.regruhosting.ru",
  serviceName: "lk1-subscription-dev-nodered.service",
  unixUser: "lk1-subscription-dev",
  userDir: "/srv/lk1-subscription-dev/node-red",
  remoteFlowPath: "/srv/lk1-subscription-dev/node-red/flows.json",
});
const trustedBindings = () => ({
  DEV: DEV_API_BASE,
  PROD: "https://padlhub.su/api",
  DEV_INSTALL_TARGET,
  DEV_ENDPOINTS: {
    cupApiBase: "http://127.0.0.1:3037/api",
    vivaApiBase: "http://127.0.0.1:3038",
    serv2Base: "http://127.0.0.1:3038/serv2",
    tokenUrl: "http://127.0.0.1:3039/realms/dev/protocol/openid-connect/token",
  },
});

function fixture() {
  const routerPreimage = "router prod source";
  const preparePreimage = "prepare prod source";
  const splitPreimage = "split prod source";
  const splitCreatePreimage = "split create prod source";
  const splitJoinPreimage = "split join prod source";
  const finalizePreimage = "finalize source";
  const mongoClient = {
    id: "mongo-client-dev", type: "mongodb4-client",
    uri: "mongodb://127.0.0.1:27030/lk1_subscription_dev_fixture",
    advanced: "{}", uriTabActive: "tab-uri-advanced",
  };
  const httpRequest = {
    id: "lk_subscription_booking_http_20260804", type: "http request", z: "tab-dev",
    url: "", wires: [["router-dev"]],
  };
  const splitCreateHttpRequest = {
    id: "ee7ba8cdd68bdf74", type: "http request", z: "tab-dev",
    url: "", wires: [["split-dev"]],
  };
  const flow = [
    { id: "tab-dev", type: "tab", label: "LK Games", disabled: false },
    { id: "route-dev", type: "http in", z: "tab-dev", url: "/lk/subscription-bookings", wires: [["prepare-dev"]] },
    { id: "prepare-dev", type: "function", z: "tab-dev", name: "Prepare subscription booking", func: preparePreimage, wires: [[httpRequest.id], ["finalize-dev"]] },
    { id: "router-dev", type: "function", z: "tab-dev", name: "Route atomic subscription booking", func: routerPreimage, wires: [[httpRequest.id], ["lk_subscription_booking_find_20260804"], ["lk_subscription_booking_insert_20260804"], ["lk_subscription_booking_update_20260804"], ["finalize-dev"]] },
    { id: "split-dev", type: "function", z: "tab-dev", name: "Route Viva split payment", func: splitPreimage, wires: [[splitCreateHttpRequest.id], [], [], [httpRequest.id]] },
    { id: "split-create-dev", type: "function", z: "tab-dev", name: "Prepare split game payment", func: splitCreatePreimage, wires: [[splitCreateHttpRequest.id], [], [], ["split-dev"]] },
    { id: "split-join-dev", type: "function", z: "tab-dev", name: "Prepare split join payment", func: splitJoinPreimage, wires: [[splitCreateHttpRequest.id], [], [], ["split-dev"]] },
    { id: "finalize-dev", type: "function", z: "tab-dev", name: "Finalize subscription booking response", func: finalizePreimage, wires: [] },
    httpRequest,
    splitCreateHttpRequest,
    mongoClient,
    { id: "lk_subscription_booking_find_20260804", type: "mongodb4", z: "tab-dev", operation: "find", collection: "lk_games", clientNode: mongoClient.id, wires: [["router-dev"]] },
    { id: "lk_subscription_booking_insert_20260804", type: "mongodb4", z: "tab-dev", operation: "insertOne", collection: "lk_games", clientNode: mongoClient.id, wires: [["router-dev"]] },
    { id: "lk_subscription_booking_update_20260804", type: "mongodb4", z: "tab-dev", operation: "updateOne", collection: "lk_games", clientNode: mongoClient.id, wires: [["router-dev"]] },
  ];
  const sourceText = `${JSON.stringify(flow, null, 2)}\n`;
  const binding = {
    environment: "DEV",
    bindingState: "BOUND",
    installAllowed: true,
    environmentIdentityVerified: true,
    source: {
      sourceKind: "dedicated-dev-target",
      sourceHost: "lk-reserve-89",
      sourceHostname: "89-108-64-209.cloudvps.regruhosting.ru",
      sourceUser: "root",
      sourcePort: 22,
      remoteFlowPath: DEV_INSTALL_TARGET.remoteFlowPath,
      sourceSha256: sha256(sourceText),
      nodeCount: flow.length,
      httpRouteCount: 1,
      tabCount: 1,
      brokenWires: 0,
      brokenLinks: 0,
      capturedAt: new Date().toISOString(),
    },
    target: {
      present: true,
      enabledDuplicateCount: 1,
      tabLabel: "LK Games",
      routerNodeId: "router-dev",
      routerNodeName: "Route atomic subscription booking",
      routerPreimageSha256: sha256(routerPreimage),
      prepareNodeId: "prepare-dev",
      prepareNodeName: "Prepare subscription booking",
      preparePreimageSha256: sha256(preparePreimage),
      splitRouterNodeId: "split-dev",
      splitRouterNodeName: "Route Viva split payment",
      splitRouterPreimageSha256: sha256(splitPreimage),
      splitCreatePrepareNodeId: "split-create-dev",
      splitCreatePrepareNodeName: "Prepare split game payment",
      splitCreatePreparePreimageSha256: sha256(splitCreatePreimage),
      splitJoinPrepareNodeId: "split-join-dev",
      splitJoinPrepareNodeName: "Prepare split join payment",
      splitJoinPreparePreimageSha256: sha256(splitJoinPreimage),
      finalizeNodeId: "finalize-dev",
      finalizeNodeName: "Finalize subscription booking response",
      finalizePreimageSha256: sha256(finalizePreimage),
    },
    runtime: { apiBase: DEV_API_BASE, completeManagedContractExposed: true },
    dependencies: {
      httpRequestBindingVerified: true,
      httpRequestPreimageSha256: sha256(JSON.stringify(httpRequest)),
      splitCreateHttpRequestPreimageSha256: sha256(JSON.stringify(splitCreateHttpRequest)),
      mongoCredentialStoreVerifiedEmpty: true,
      mongoCredentialStorePreimageSha256: "a".repeat(64),
      mongoBindingVerifiedDevOnly: true,
      crossEnvironmentMongoConfigCount: 0,
      managedMongoClient: {
        id: mongoClient.id,
        preimageSha256: sha256(JSON.stringify(mongoClient)),
        effectiveIdentity: {
          mode: "uri", protocol: "mongodb", host: "127.0.0.1", port: 27030,
          database: "lk1_subscription_dev_fixture", credentialsPresent: false, optionsPresent: false,
          uriTabActive: "tab-uri-advanced",
        },
        fixtureOnly: true,
      },
      managedMongoNodes: flow.filter((node) => node.type === "mongodb4").map((node, index) => ({
        id: node.id,
        operation: node.operation,
        routerOutputIndex: index + 1,
        present: true,
        clientNode: node.clientNode,
        collection: node.collection,
        returnsToRouter: true,
        wiredFromRouter: true,
        preimageSha256: sha256(JSON.stringify(node)),
      })),
    },
    endpointAudit: {
      verifiedDevOnly: true,
      crossEnvironmentEndpointCount: 0,
      endpointInventorySha256: endpointInventorySha256(flow),
    },
    installTarget: { ...DEV_INSTALL_TARGET },
  };
  return { flow, sourceText, binding };
}

const fixtureTrackedSources = () => ({
  "scripts/nodered_subscription_booking_nodes/fn_subscription_booking_router.js":
    "const VIVA_API_BASE = \"https://api.vivacrm.ru\";\nconst SERV2_URL = \"https://padlhub.su/seliger\";\nconst MANAGED_RUNTIME_EXPECTED_ENVIRONMENT = \"PROD\";\nconst MANAGED_RUNTIME_API_BASE_BY_ENVIRONMENT = {\n  PROD: \"https://padlhub.su/api\",\n  DEV: null,\n};\n",
  "scripts/nodered_subscription_booking_nodes/fn_subscription_booking_prepare.js":
    "const VIVA_API_BASE = \"https://api.vivacrm.ru\";\n",
  "scripts/nodered_subscription_booking_nodes/fn_subscription_booking_finalize.js":
    "const FINALIZE = true;\n",
  "scripts/nodered_games_nodes/fn_split_router.js":
    "const ADMIN_API = \"https://api.vivacrm.ru/api/v1\";\nconst END_USER_API = \"https://api.vivacrm.ru/end-user/api/v1/iSkq6G\";\nconst CUP_API_DEFAULT = \"https://padlhub.su/api\";\nconst TOKEN_URL_DEFAULT = \"https://kc.vivacrm.ru/realms/prod/protocol/openid-connect/token\";\nconst MANAGED_RUNTIME_EXPECTED_ENVIRONMENT = \"PROD\";\nconst MANAGED_RUNTIME_API_BASE_BY_ENVIRONMENT = {\n  PROD: \"https://padlhub.su/api\",\n  DEV: null,\n};\n  const apiBase = (readEnv(\"CUP_API_BASE_URL\") || CUP_API_DEFAULT).replace(/\\/+$/, \"\");\n  msg.url = readEnv(\"VIVA_SERVICE_TOKEN_URL\") || TOKEN_URL_DEFAULT;\n",
  "scripts/nodered_games_nodes/fn_split_create_prepare.js":
    "const TOKEN_URL_DEFAULT = \"https://kc.vivacrm.ru/realms/prod/protocol/openid-connect/token\";\nconst CUP_API_DEFAULT = \"https://padlhub.su/api\";\n  const apiBase = (readEnv(\"CUP_API_BASE_URL\") || CUP_API_DEFAULT).replace(/\\/+$/, \"\");\nmsg.url = readEnv(\"VIVA_SERVICE_TOKEN_URL\") || TOKEN_URL_DEFAULT;\n",
  "scripts/nodered_games_nodes/fn_split_join_prepare.js":
    "const TOKEN_URL_DEFAULT = \"https://kc.vivacrm.ru/realms/prod/protocol/openid-connect/token\";\nconst CUP_API_DEFAULT = \"https://padlhub.su/api\";\n  const apiBase = (readEnv(\"CUP_API_BASE_URL\") || CUP_API_DEFAULT).replace(/\\/+$/, \"\");\n  msg.url = readEnv(\"VIVA_SERVICE_TOKEN_URL\") || TOKEN_URL_DEFAULT;\n",
});

test("strict environment URL contract allows only the exact bound DEV or PROD base", () => {
  assert.equal(validateEnvironmentApiBase("DEV", DEV_API_BASE, DEV_API_BASE), true);
  assert.equal(validateEnvironmentApiBase("PROD", "https://padlhub.su/api", "https://padlhub.su/api"), true);
  assert.throws(() => validateEnvironmentApiBase("DEV", "https://padlhub.su/api", "https://padlhub.su/api"),
    /strict URL contract|forbidden in DEV/);
  assert.throws(() => validateEnvironmentApiBase("PROD", DEV_API_BASE, DEV_API_BASE),
    /strict URL contract|forbidden in PROD/);
  for (const invalid of [
    "http://subscriptions-dev.example.test/api",
    "https://user@127.0.0.1/api",
    "https://subscriptions-dev.example.test/api?target=prod",
    "https://subscriptions-dev.example.test/api#prod",
    "https://subscriptions-dev.example.test/other",
  ]) {
    assert.throws(() => validateEnvironmentApiBase("DEV", invalid, invalid));
  }
});

test("DEV builder patches only frozen function bodies and emits a separate digest", () => {
  const { flow, sourceText, binding } = fixture();
  const trackedSources = fixtureTrackedSources();
  const result = buildDevCandidate(
    sourceText,
    binding,
    (file) => trackedSources[file],
    trustedBindings(),
  );
  assert.equal(result.manifest.environment, "DEV");
  assert.notEqual(result.manifest.candidateSha256, binding.source.sourceSha256);
  assert.equal(result.manifest.productionBindingState, "UNBOUND_AFTER_ROUTER_AMENDMENT");
  assert.deepEqual(
    result.candidate.map(({ id, z, wires }) => ({ id, z, wires })),
    flow.map(({ id, z, wires }) => ({ id, z, wires })),
  );
  assert.match(result.candidate.find((node) => node.id === "router-dev").func,
    /DEV: "http:\/\/127\.0\.0\.1:3037\/api"/);
  assert.match(result.candidate.find((node) => node.id === "router-dev").func,
    /MANAGED_RUNTIME_EXPECTED_ENVIRONMENT = "DEV"/);
  assert.doesNotMatch(result.candidate.find((node) => node.id === "router-dev").func,
    /PROD: "https:\/\/padlhub\.su\/api"/);
});

test("actual reachable sources bind only to the approved DEV fixture origins", () => {
  const { sourceText, binding } = fixture();
  const result = buildDevCandidate(sourceText, binding, fs.readFileSync, trustedBindings());
  const functions = result.candidate.filter((node) => node.type === "function");
  const combined = functions.map((node) => String(node.func || "")).join("\n");
  assert.doesNotMatch(combined, /https:\/\/(?:api|kc)\.vivacrm\.ru/);
  assert.doesNotMatch(combined, /https:\/\/padlhub\.su\/(?:api|seliger)/);
  assert.doesNotMatch(combined, /readEnv\("VIVA_SERVICE_TOKEN_URL"\)/);
  assert.doesNotMatch(combined, /readEnv\("CUP_API_BASE_URL"\)/);
  assert.match(combined, /http:\/\/127\.0\.0\.1:3037\/api/);
  assert.match(combined, /http:\/\/127\.0\.0\.1:3038/);
  assert.match(combined, /http:\/\/127\.0\.0\.1:3039/);
});

test("DEV builder independently rejects HTTP, mongodb4 wiring, and effective database drift", () => {
  const rebuild = (value) => {
    value.sourceText = `${JSON.stringify(value.flow, null, 2)}\n`;
    value.binding.source.sourceSha256 = sha256(value.sourceText);
    value.binding.source.nodeCount = value.flow.length;
    return value;
  };

  const httpDrift = fixture();
  httpDrift.flow.find((node) => node.id === "lk_subscription_booking_http_20260804").wires = [[]];
  httpDrift.binding.dependencies.httpRequestPreimageSha256 = sha256(JSON.stringify(
    httpDrift.flow.find((node) => node.id === "lk_subscription_booking_http_20260804"),
  ));
  rebuild(httpDrift);
  assert.throws(() => buildDevCandidate(
    httpDrift.sourceText, httpDrift.binding, fs.readFileSync, trustedBindings(),
  ), /HTTP request wiring/);

  const httpOutputRelocation = fixture();
  const relocatedRouter = httpOutputRelocation.flow.find((node) => node.id === "router-dev");
  relocatedRouter.wires[0] = [];
  relocatedRouter.wires[4] = ["lk_subscription_booking_http_20260804"];
  rebuild(httpOutputRelocation);
  assert.throws(() => buildDevCandidate(
    httpOutputRelocation.sourceText,
    httpOutputRelocation.binding,
    fs.readFileSync,
    trustedBindings(),
  ), /HTTP request wiring/);

  const mongoWireDrift = fixture();
  mongoWireDrift.flow.find((node) => node.id === "router-dev").wires[1] = [];
  rebuild(mongoWireDrift);
  assert.throws(() => buildDevCandidate(
    mongoWireDrift.sourceText, mongoWireDrift.binding, fs.readFileSync, trustedBindings(),
  ), /Mongo wiring mismatch/);

  const databaseDrift = fixture();
  const client = databaseDrift.flow.find((node) => node.id === "mongo-client-dev");
  client.uri = "mongodb://127.0.0.1:27030/games";
  databaseDrift.binding.dependencies.managedMongoClient.preimageSha256 = sha256(JSON.stringify(client));
  databaseDrift.binding.dependencies.managedMongoClient.effectiveIdentity.database = "games";
  rebuild(databaseDrift);
  assert.throws(() => buildDevCandidate(
    databaseDrift.sourceText, databaseDrift.binding, fs.readFileSync, trustedBindings(),
  ), /not fixture-only/);

  const splitCreateHttpDrift = fixture();
  splitCreateHttpDrift.flow.find((node) => node.id === "ee7ba8cdd68bdf74").wires = [[]];
  splitCreateHttpDrift.binding.dependencies.splitCreateHttpRequestPreimageSha256 = sha256(JSON.stringify(
    splitCreateHttpDrift.flow.find((node) => node.id === "ee7ba8cdd68bdf74"),
  ));
  rebuild(splitCreateHttpDrift);
  assert.throws(() => buildDevCandidate(
    splitCreateHttpDrift.sourceText, splitCreateHttpDrift.binding, fs.readFileSync, trustedBindings(),
  ), /HTTP request wiring/);

  const splitRouterHttpRelocation = fixture();
  const relocatedSplitRouter = splitRouterHttpRelocation.flow.find((node) => node.id === "split-dev");
  relocatedSplitRouter.wires[0] = [];
  relocatedSplitRouter.wires[1] = ["ee7ba8cdd68bdf74"];
  rebuild(splitRouterHttpRelocation);
  assert.throws(() => buildDevCandidate(
    splitRouterHttpRelocation.sourceText,
    splitRouterHttpRelocation.binding,
    fs.readFileSync,
    trustedBindings(),
  ), /HTTP request wiring/);

  const mongoOptionsDrift = fixture();
  const optionsClient = mongoOptionsDrift.flow.find((node) => node.id === "mongo-client-dev");
  optionsClient.advanced = '{"readPreference":"secondary"}';
  mongoOptionsDrift.binding.dependencies.managedMongoClient.preimageSha256 = sha256(JSON.stringify(optionsClient));
  rebuild(mongoOptionsDrift);
  assert.throws(() => buildDevCandidate(
    mongoOptionsDrift.sourceText, mongoOptionsDrift.binding, fs.readFileSync, trustedBindings(),
  ), /not fixture-only/);

  const credentialStoreUnknown = fixture();
  credentialStoreUnknown.binding.dependencies.mongoCredentialStoreVerifiedEmpty = false;
  assert.throws(() => buildDevCandidate(
    credentialStoreUnknown.sourceText, credentialStoreUnknown.binding, fs.readFileSync, trustedBindings(),
  ), /not fixture-only/);
});

test("DEV builder rejects tracked function bodies that retain production/shared endpoints", () => {
  const { sourceText, binding } = fixture();
  const sources = fixtureTrackedSources();
  sources["scripts/nodered_subscription_booking_nodes/fn_subscription_booking_finalize.js"] =
    "const LEAK = \"https://api.vivacrm.ru\";\n";
  assert.throws(() => buildDevCandidate(
    sourceText,
    binding,
    (file) => sources[file],
    trustedBindings(),
  ), /retains a production\/shared endpoint/);
});

test("DEV builder derives whole-flow endpoint custody and rejects an added production HTTP node", () => {
  const value = fixture();
  value.flow.push({
    id: "unexpected-production-http",
    type: "http request",
    z: "tab-dev",
    url: "https://api.vivacrm.ru/api/v1/exercises",
    wires: [[]],
  });
  value.sourceText = `${JSON.stringify(value.flow, null, 2)}\n`;
  value.binding.source.sourceSha256 = sha256(value.sourceText);
  value.binding.source.nodeCount = value.flow.length;
  assert.throws(() => buildDevCandidate(
    value.sourceText, value.binding, fs.readFileSync, trustedBindings(),
  ), /endpoint configuration audit mismatch/);

  value.binding.endpointAudit = {
    verifiedDevOnly: true,
    crossEnvironmentEndpointCount: 0,
    endpointInventorySha256: endpointInventorySha256(value.flow),
  };
  assert.throws(() => buildDevCandidate(
    value.sourceText, value.binding, fs.readFileSync, trustedBindings(),
  ), /endpoint configuration audit mismatch/);
});

test("DEV builder rejects dynamic HTTP nodes and unapproved senders to an attested HTTP node", () => {
  const rebuild = (value) => {
    value.sourceText = `${JSON.stringify(value.flow, null, 2)}\n`;
    value.binding.source.sourceSha256 = sha256(value.sourceText);
    value.binding.source.nodeCount = value.flow.length;
    value.binding.endpointAudit.endpointInventorySha256 = endpointInventorySha256(value.flow);
  };

  const dynamicNode = fixture();
  dynamicNode.flow.push({
    id: "browser-url-producer",
    type: "function",
    z: "tab-dev",
    name: "Browser URL producer",
    func: "msg.url = msg.req.query.url; return msg;",
    wires: [["dynamic-http"]],
  }, {
    id: "dynamic-http",
    type: "http request",
    z: "tab-dev",
    url: "",
    wires: [[]],
  });
  rebuild(dynamicNode);
  assert.throws(() => buildDevCandidate(
    dynamicNode.sourceText, dynamicNode.binding, fs.readFileSync, trustedBindings(),
  ), /HTTP request wiring/);

  const extraSender = fixture();
  extraSender.flow.push({
    id: "browser-url-sender",
    type: "function",
    z: "tab-dev",
    name: "Browser URL sender",
    func: "msg.url = msg.req.query.url; return msg;",
    wires: [["lk_subscription_booking_http_20260804"]],
  });
  rebuild(extraSender);
  assert.throws(() => buildDevCandidate(
    extraSender.sourceText, extraSender.binding, fs.readFileSync, trustedBindings(),
  ), /HTTP request wiring/);
});

test("shared-root audit capture cannot become a DEV candidate source", () => {
  const { sourceText, binding } = fixture();
  binding.source.sourceKind = "shared-host-audit-only";
  binding.source.remoteFlowPath = "/root/.node-red/flows.json";
  assert.throws(() => buildDevCandidate(sourceText, binding, () => "", trustedBindings()),
    /DEV source identity mismatch/);
  const divergentBindings = trustedBindings();
  divergentBindings.DEV_INSTALL_TARGET = {
    ...DEV_INSTALL_TARGET,
    remoteFlowPath: "/root/.node-red/flows.json",
  };
  assert.throws(() => validateDevBinding(fixture().binding, divergentBindings),
    /diverges from the provisioning contract/);
});

test("DEV publisher remains blocked until provisioning separately authorizes candidate build", () => {
  const { sourceText, binding } = fixture();
  const workspace = fs.mkdtempSync("/private/tmp/lk1-dev-publish-test-");
  fs.mkdirSync(path.join(workspace, "input"));
  fs.writeFileSync(path.join(workspace, "input/source.flow.json"), sourceText);
  fs.writeFileSync(path.join(workspace, "input/source.flow.meta.json"), JSON.stringify({
    formatVersion: 1,
    environment: binding.environment,
    ...binding.source,
    target: binding.target,
    dependencies: binding.dependencies,
    environmentIdentityVerified: binding.environmentIdentityVerified,
  }));
  const trackedSources = fixtureTrackedSources();
  assert.throws(() => publishDevCandidate(workspace, binding, {
    readSource: (file) => trackedSources[file],
    trustedBindings: trustedBindings(),
  }), /blocks DEV candidate publication/);
  assert.equal(fs.existsSync(path.join(workspace, "build")), false);
});

test("checked-in DEV binding stays blocked on missing flow, CUP, HTTP, and Mongo custody", () => {
  const binding = JSON.parse(fs.readFileSync("scripts/lk1_subscription_dev_candidate_binding.json", "utf8"));
  assert.equal(binding.environment, "DEV");
  assert.equal(binding.productionBindingState, "UNBOUND_AFTER_ROUTER_AMENDMENT");
  assert.equal(binding.installAllowed, false);
  assert.equal(binding.target.present, false);
  assert.equal(binding.runtime.apiBase, null);
  assert.equal(binding.dependencies.mongoBindingVerifiedDevOnly, false);
  assert.equal(binding.endpointAudit.verifiedDevOnly, false);
  assert.equal(binding.endpointAudit.crossEnvironmentEndpointCount, 5);
  assert.equal(binding.endpointAudit.endpointInventorySha256, null);
  assert.throws(() => validateDevBinding(binding), /blocked/);
});

test("read-only snapshot inspector computes graph, target, duplicate, and Mongo evidence", () => {
  const { flow } = fixture();
  flow.push({ id: "mongo-prod", type: "mongodb", hostname: "cluster.example.test/prod", wires: [] });
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), "lk1-dev-snapshot-test-"));
  const sourcePath = path.join(workspace, "source.flow.json");
  const metaPath = path.join(workspace, "source.flow.meta.json");
  const credentialStorePath = path.join(workspace, "source.flow.credentials.json");
  fs.writeFileSync(sourcePath, `${JSON.stringify(flow)}\n`);
  fs.writeFileSync(credentialStorePath, "{}\n");
  fs.writeFileSync(metaPath, JSON.stringify({
    environment: "DEV",
    sourceKind: "shared-host-audit-only",
    sourceHost: "lk-reserve-89",
  }));
  execFileSync(process.execPath, [
    "scripts/inspect_lk1_subscription_dev_snapshot.mjs",
    sourcePath,
    metaPath,
    credentialStorePath,
  ]);
  const audit = JSON.parse(fs.readFileSync(metaPath, "utf8"));
  assert.equal(audit.brokenWires, 0);
  assert.equal(audit.brokenLinks, 0);
  assert.equal(audit.target.present, false, "fixture IDs deliberately differ from production target IDs");
  assert.equal(audit.dependencies.crossEnvironmentMongoConfigCount, 1);
  assert.equal(audit.dependencies.mongoBindingVerifiedDevOnly, false);
  assert.equal(audit.dependencies.mongoCredentialStoreVerifiedEmpty, true);
  assert.equal(audit.dependencies.mongoCredentialStorePreimageSha256, sha256("{}\n"));
  assert.deepEqual(audit.dependencies.httpRequestNodeIds, [
    "ee7ba8cdd68bdf74", "lk_subscription_booking_http_20260804",
  ]);
  assert.equal(audit.endpointAudit.verifiedDevOnly, true);
  assert.equal(audit.endpointAudit.crossEnvironmentEndpointCount, 0);
  assert.match(audit.endpointAudit.endpointInventorySha256, /^[a-f0-9]{64}$/);
  assert.equal(audit.environmentIdentityVerified, false);
});

test("DEV and PROD manifests cannot cross installation environments", () => {
  const devManifest = {
    environment: "DEV",
    candidateSha256: "a".repeat(64),
    targetHost: "lk-reserve-89",
    targetHostname: "89-108-64-209.cloudvps.regruhosting.ru",
    targetServiceName: DEV_INSTALL_TARGET.serviceName,
    targetUnixUser: DEV_INSTALL_TARGET.unixUser,
    targetUserDir: DEV_INSTALL_TARGET.userDir,
    targetFlowPath: DEV_INSTALL_TARGET.remoteFlowPath,
  };
  const devTarget = {
    environment: "DEV",
    sourceHost: "lk-reserve-89",
    sourceHostname: "89-108-64-209.cloudvps.regruhosting.ru",
    serviceName: DEV_INSTALL_TARGET.serviceName,
    unixUser: DEV_INSTALL_TARGET.unixUser,
    userDir: DEV_INSTALL_TARGET.userDir,
    remoteFlowPath: DEV_INSTALL_TARGET.remoteFlowPath,
  };
  assert.equal(validateDevInstallManifest(devManifest, devTarget, trustedBindings()), true);
  assert.throws(() => verifyDevInstallManifest(devManifest, Buffer.from("candidate")),
    /blocks DEV install/);
  const { binding } = fixture();
  const candidateBytes = Buffer.from("candidate");
  const candidateSha256 = sha256(candidateBytes);
  binding.candidateSha256 = candidateSha256;
  binding.installTarget = {
    ...DEV_INSTALL_TARGET,
  };
  const boundManifest = {
    ...devManifest,
    sourceSha256: binding.source.sourceSha256,
    candidateSha256,
  };
  assert.throws(() => verifyDevInstallManifest(
    boundManifest, candidateBytes, binding, trustedBindings(),
  ), /blocks DEV install/);
  assert.throws(() => validateDevInstallManifest(
    devManifest, { ...devTarget, environment: "PROD" }, trustedBindings(),
  ),
    /cannot be installed in PROD/);
  assert.throws(() => validateDevInstallManifest(
    { ...devManifest, environment: "PROD" }, devTarget, trustedBindings(),
  ),
    /cannot be installed in PROD/);
  const disguisedProductionTarget = {
    environment: "DEV",
    sourceHost: "lk-primary-147",
    sourceHostname: "production.example.test",
    serviceName: DEV_INSTALL_TARGET.serviceName,
    unixUser: DEV_INSTALL_TARGET.unixUser,
    userDir: DEV_INSTALL_TARGET.userDir,
    remoteFlowPath: DEV_INSTALL_TARGET.remoteFlowPath,
  };
  assert.throws(() => validateDevInstallTarget(disguisedProductionTarget, trustedBindings()),
    /exact trusted DEV binding/);
  assert.throws(() => validateDevInstallManifest(
    { ...devManifest, targetHost: disguisedProductionTarget.sourceHost },
    disguisedProductionTarget,
    trustedBindings(),
  ), /exact trusted DEV binding/);
  const { binding: disguisedBinding } = fixture();
  disguisedBinding.installTarget = { ...disguisedProductionTarget };
  assert.throws(() => validateDevBinding(disguisedBinding, trustedBindings()),
    /exact trusted DEV binding/);
  assert.throws(() => assertProductionManifestEnvironment(devManifest),
    /rejects a DEV manifest/);
  assert.throws(() => assertProductionBuilderManifestEnvironment(devManifest),
    /rejects a DEV manifest/);
  assert.equal(assertProductionManifestEnvironment({ environment: "PROD" }), true);
  assert.equal(assertProductionBuilderManifestEnvironment({ environment: "PROD" }), true);
});
