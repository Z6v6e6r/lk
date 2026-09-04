import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync, spawnSync } from "node:child_process";
import test from "node:test";
import {
  assertExactMainSourceCommit,
  publishOfflineDevSource,
} from "../generate_lk1_subscription_dev_offline_source.mjs";
import {
  assertProductionManifestEnvironment,
  buildDevCandidate,
  CHECKED_DEV_CANDIDATE_BINDING,
  publishDevCandidate,
  validateDevBinding,
  validateDevInstallTarget,
  validateDevInstallManifest,
  validateEnvironmentApiBase,
} from "../prepare_lk1_subscription_dev_candidate.mjs";
import { deriveDevWholeFlowIsolation } from "../lk1_subscription_dev_execution_contract.mjs";
import {
  verifyChangedNodeEvidence,
  verifyDevInstallManifest,
} from "../verify_lk1_subscription_dev_install.mjs";
import {
  assertProductionManifestEnvironment as assertProductionBuilderManifestEnvironment,
} from "../prepare_lk1_subscription_enforcement_candidate.mjs";

const sha256 = (value) => crypto.createHash("sha256").update(value).digest("hex");
const ROOT = path.resolve(import.meta.dirname, "../..");
const TEMP_ROOT = fs.existsSync("/private/tmp") ? "/private/tmp" : "/tmp";
const FROZEN_SOURCE_COMMIT = CHECKED_DEV_CANDIDATE_BINDING.source.sourceCommit;
const nodeInventorySha256 = (flow) => sha256(JSON.stringify(flow
  .map((node) => ({ id: node.id, sha256: sha256(JSON.stringify(node)) }))
  .sort((left, right) => left.id.localeCompare(right.id))));
const SOURCE_INPUTS = [
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
];
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
  DEV: null,
  devBindingState: "UNBOUND_RUNTIME_STOPPED",
  DEV_CANDIDATE_API_BASE: DEV_API_BASE,
  PROD: "https://padlhub.su/api",
  DEV_INSTALL_TARGET,
  DEV_ENDPOINTS: {
    cupApiBase: "http://127.0.0.1:3037/api",
    vivaApiBase: "http://127.0.0.1:3038",
    serv2Base: "http://127.0.0.1:3038/serv2",
    tokenUrl: "http://127.0.0.1:3039/realms/dev/protocol/openid-connect/token",
  },
  DEV_MONGO: {
    host: "127.0.0.1", port: 27030, database: "lk1_subscription_dev_fixture",
    replicaSet: "rs0", credentialFree: true,
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
    method: "use", ret: "obj", paytoqs: "ignore", requestTimeout: "20000",
    senderr: true, persist: false, authType: "", insecureHTTPParser: false,
    url: "", wires: [["router-dev"]],
  };
  const splitCreateHttpRequest = {
    id: "ee7ba8cdd68bdf74", type: "http request", z: "tab-dev",
    method: "use", ret: "obj", paytoqs: "ignore", requestTimeout: "20000",
    senderr: true, persist: false, authType: "", insecureHTTPParser: false,
    url: "", wires: [["split-dev"]],
  };
  const flow = [
    { id: "tab-dev", type: "tab", label: "LK Games", disabled: false },
    { id: "lk_subscription_booking_post_20260804", type: "http in", z: "tab-dev", method: "post", url: "/lk/subscription-bookings", wires: [["prepare-dev"]] },
    { id: "prepare-dev", type: "function", z: "tab-dev", name: "Prepare subscription booking", func: preparePreimage, wires: [[httpRequest.id], ["finalize-dev"]] },
    { id: "router-dev", type: "function", z: "tab-dev", name: "Route atomic subscription booking", func: routerPreimage, wires: [[httpRequest.id], ["lk_subscription_booking_find_20260804"], ["lk_subscription_booking_insert_20260804"], ["lk_subscription_booking_update_20260804"], ["finalize-dev"], [], ["lk_subscription_managed_policy_20260820"]] },
    { id: "lk_subscription_managed_policy_20260820", type: "function", z: "tab-dev", name: "Evaluate managed subscription policy", func: "return [msg, null];", wires: [["router-dev"], ["lk_subscription_managed_policy_blocked_20260820"]] },
    { id: "lk_subscription_managed_policy_blocked_20260820", type: "function", z: "tab-dev", name: "Block managed subscription decision", func: "return msg;", wires: [["finalize-dev"]] },
    { id: "split-dev", type: "function", z: "tab-dev", name: "Route Viva split payment", func: splitPreimage, wires: [[splitCreateHttpRequest.id], [], [], [httpRequest.id]] },
    { id: "split-create-dev", type: "function", z: "tab-dev", name: "Prepare split game payment", func: splitCreatePreimage, wires: [[splitCreateHttpRequest.id], [], [], ["split-dev"]] },
    { id: "split-join-dev", type: "function", z: "tab-dev", name: "Prepare split join payment", func: splitJoinPreimage, wires: [[splitCreateHttpRequest.id], [], [], ["split-dev"]] },
    { id: "finalize-dev", type: "function", z: "tab-dev", name: "Finalize subscription booking response", func: finalizePreimage, wires: [["split-dev"], ["lk_subscription_booking_response_20260804"]] },
    { id: "lk_subscription_booking_response_20260804", type: "http response", z: "tab-dev", wires: [] },
    { id: "lk_subscription_booking_options_in_20260804", type: "http in", z: "tab-dev", method: "options", url: "/lk/subscription-bookings", wires: [["lk_subscription_booking_options_20260804"]] },
    { id: "lk_subscription_booking_options_20260804", type: "function", z: "tab-dev", name: "Subscription booking CORS", func: "return msg;", wires: [["lk_subscription_booking_options_response_20260804"]] },
    { id: "lk_subscription_booking_options_response_20260804", type: "http response", z: "tab-dev", wires: [] },
    httpRequest,
    splitCreateHttpRequest,
    mongoClient,
    { id: "lk_subscription_booking_find_20260804", type: "mongodb4", z: "tab-dev", operation: "find", mode: "collection", output: "toArray", maxTimeMS: "5000", handleDocId: false, collection: "lk_subscription_daily_booking_ops", clientNode: mongoClient.id, wires: [["router-dev"]] },
    { id: "lk_subscription_booking_insert_20260804", type: "mongodb4", z: "tab-dev", operation: "insertOne", mode: "collection", output: "toArray", maxTimeMS: "5000", handleDocId: false, collection: "lk_subscription_daily_booking_ops", clientNode: mongoClient.id, wires: [["router-dev"]] },
    { id: "lk_subscription_booking_update_20260804", type: "mongodb4", z: "tab-dev", operation: "updateOne", mode: "collection", output: "toArray", maxTimeMS: "5000", handleDocId: false, collection: "lk_subscription_daily_booking_ops", clientNode: mongoClient.id, wires: [["router-dev"]] },
    { id: "lk_subscription_booking_catch_20260804", type: "catch", z: "tab-dev", scope: ["lk_subscription_booking_find_20260804", "lk_subscription_booking_insert_20260804", "lk_subscription_booking_update_20260804"], uncaught: false, wires: [["lk_subscription_booking_mongo_error_20260804"]] },
    { id: "lk_subscription_booking_mongo_error_20260804", type: "function", z: "tab-dev", name: "Fail closed on subscription booking persistence", func: "return msg;", wires: [["finalize-dev"]] },
    { id: "lk_subscription_booking_debug_20260804", type: "debug", z: "tab-dev", active: false, console: false, tostatus: false, complete: "payload", targetType: "msg", wires: [] },
  ];
  const sourceText = `${JSON.stringify(flow, null, 2)}\n`;
  const binding = {
    environment: "DEV",
    bindingState: "BOUND_SOURCE_ONLY",
    installAllowed: false,
    environmentIdentityVerified: false,
    source: {
      sourceKind: "offline-dedicated-dev-bootstrap",
      sourceCommit: "a".repeat(40),
      generatorPath: "scripts/generate_lk1_subscription_dev_offline_source.mjs",
      generatorSha256: "a".repeat(64),
      sourceInputsSha256: Object.fromEntries(SOURCE_INPUTS.map((file) => [file, "a".repeat(64)])),
      sourceSha256: sha256(sourceText),
      sourceNodeInventorySha256: nodeInventorySha256(flow),
      nodeCount: flow.length,
      httpRouteCount: 2,
      tabCount: 1,
      brokenWires: 0,
      brokenLinks: 0,
    },
    target: {
      present: true,
      enabledDuplicateCount: 1,
      tabLabel: "LK Games",
      routerNodeId: "router-dev",
      routerNodeName: "Route atomic subscription booking",
      routerPreimageSha256: sha256(routerPreimage),
      routerNodePreimageSha256: sha256(JSON.stringify(flow.find((node) => node.id === "router-dev"))),
      prepareNodeId: "prepare-dev",
      prepareNodeName: "Prepare subscription booking",
      preparePreimageSha256: sha256(preparePreimage),
      prepareNodePreimageSha256: sha256(JSON.stringify(flow.find((node) => node.id === "prepare-dev"))),
      splitRouterNodeId: "split-dev",
      splitRouterNodeName: "Route Viva split payment",
      splitRouterPreimageSha256: sha256(splitPreimage),
      splitRouterNodePreimageSha256: sha256(JSON.stringify(flow.find((node) => node.id === "split-dev"))),
      splitCreatePrepareNodeId: "split-create-dev",
      splitCreatePrepareNodeName: "Prepare split game payment",
      splitCreatePreparePreimageSha256: sha256(splitCreatePreimage),
      splitCreatePrepareNodePreimageSha256: sha256(JSON.stringify(flow.find((node) => node.id === "split-create-dev"))),
      splitJoinPrepareNodeId: "split-join-dev",
      splitJoinPrepareNodeName: "Prepare split join payment",
      splitJoinPreparePreimageSha256: sha256(splitJoinPreimage),
      splitJoinPrepareNodePreimageSha256: sha256(JSON.stringify(flow.find((node) => node.id === "split-join-dev"))),
      finalizeNodeId: "finalize-dev",
      finalizeNodeName: "Finalize subscription booking response",
      finalizePreimageSha256: sha256(finalizePreimage),
      finalizeNodePreimageSha256: sha256(JSON.stringify(flow.find((node) => node.id === "finalize-dev"))),
    },
    runtime: {
      apiBase: DEV_API_BASE,
      completeManagedContractSourceImplemented: true,
      localPhysicalVerified: true,
      hostRuntimeExposed: false,
      completeManagedContractExposed: false,
      reason: "Source implemented and locally loopback-verified; DEV services remain stopped and host runtime was not exercised",
    },
    dependencies: {
      wholeFlowIsolationVerified: true,
      executionFunctionPreimages: [
        "finalize-dev", "lk_subscription_booking_mongo_error_20260804",
        "lk_subscription_booking_options_20260804",
        "lk_subscription_managed_policy_20260820",
        "lk_subscription_managed_policy_blocked_20260820",
        "prepare-dev", "router-dev", "split-create-dev", "split-dev", "split-join-dev",
      ].sort().map((id) => ({
        id,
        nodeSha256: sha256(JSON.stringify(flow.find((node) => node.id === id))),
      })),
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
    candidateSha256: null,
    productionBindingState: "UNBOUND_AFTER_ROUTER_AMENDMENT",
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
    "const TOKEN_URL_DEFAULT = \"https://kc.vivacrm.ru/realms/prod/protocol/openid-connect/token\";\nconst CUP_API_DEFAULT = \"https://padlhub.su/api\";\n  const apiBase = (readEnv(\"CUP_API_BASE_URL\") || CUP_API_DEFAULT).replace(/\\/+$/, \"\");\nmsg.url = readEnv(\"VIVA_SERVICE_TOKEN_URL\") || TOKEN_URL_DEFAULT;\n  successUrl: toStr(body.successUrl) || toStr(body.baseRedirectUrl),\n  failUrl: toStr(body.failUrl) || toStr(body.baseRedirectUrl),\n",
  "scripts/nodered_games_nodes/fn_split_join_prepare.js":
    "const TOKEN_URL_DEFAULT = \"https://kc.vivacrm.ru/realms/prod/protocol/openid-connect/token\";\nconst CUP_API_DEFAULT = \"https://padlhub.su/api\";\n  const apiBase = (readEnv(\"CUP_API_BASE_URL\") || CUP_API_DEFAULT).replace(/\\/+$/, \"\");\n  msg.url = readEnv(\"VIVA_SERVICE_TOKEN_URL\") || TOKEN_URL_DEFAULT;\n  successUrl: toStr(body.successUrl) || toStr(body.baseRedirectUrl),\n  failUrl: toStr(body.failUrl) || toStr(body.baseRedirectUrl),\n",
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

test("offline source CLI authority requires frozen source ancestry under current origin/main and a clean worktree", () => {
  const sourceCommit = "a".repeat(40);
  const originMain = "b".repeat(40);
  const exact = (args) => {
    if (args[0] === "status") return "";
    if (args[0] === "rev-parse") return originMain;
    return args[1] === "HEAD" ? originMain : sourceCommit;
  };
  assert.equal(assertExactMainSourceCommit(sourceCommit, exact), true);
  assert.throws(() => assertExactMainSourceCommit("not-a-commit", exact), /40-hex/);
  assert.throws(() => assertExactMainSourceCommit(sourceCommit, (args) => (
    args[0] === "status" ? "" : args[0] === "rev-parse" ? originMain : "c".repeat(40)
  )), /tooling HEAD does not contain/);
  assert.throws(() => assertExactMainSourceCommit(sourceCommit, (args) => (
    args[0] === "status" ? "" : args[0] === "rev-parse" || args[1] === "HEAD"
      ? originMain : "c".repeat(40)
  )), /frozen source base is not an ancestor/);
  assert.throws(() => assertExactMainSourceCommit(sourceCommit, (args) => (
    args[0] === "status" ? " M source.js" : args[0] === "rev-parse" || args[1] === "HEAD"
      ? originMain : sourceCommit
  )), /clean worktree/);
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
  assert.equal(result.manifest.sourceProvenance, "OFFLINE_GENERATED");
  assert.deepEqual(result.manifest.hostPreimage, { state: "ABSENT", sha256: null });
  assert.deepEqual(result.manifest.rollback, {
    mode: "RETURN_TO_ABSENT",
    restoreSha256: null,
    preserveEvidence: true,
    deleteData: false,
    requiresSeparateAuthorization: true,
  });
  assert.equal(result.manifest.installAuthorization.authorized, false);
  assert.equal(result.manifest.installAuthorization.candidateSha256, result.manifest.candidateSha256);
  assert.deepEqual(result.manifest.changedNodeIds, [
    "finalize-dev", "prepare-dev", "router-dev", "split-create-dev", "split-dev", "split-join-dev",
  ]);
  assert.equal(result.manifest.changedNodes.length, 6);
  assert.deepEqual(binding.dependencies.executionFunctionPreimages.map(({ id }) => id), [
    "finalize-dev",
    "lk_subscription_booking_mongo_error_20260804",
    "lk_subscription_booking_options_20260804",
    "lk_subscription_managed_policy_20260820",
    "lk_subscription_managed_policy_blocked_20260820",
    "prepare-dev",
    "router-dev",
    "split-create-dev",
    "split-dev",
    "split-join-dev",
  ]);
  assert.ok(result.manifest.changedNodes.every((node) => (
    JSON.stringify(node.changedFields) === JSON.stringify(["func"])
    && /^[a-f0-9]{64}$/.test(node.sourceNodeSha256)
    && /^[a-f0-9]{64}$/.test(node.candidateNodeSha256)
  )));
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
  assert.doesNotMatch(combined, /(?:successUrl|failUrl):\s*toStr\(body\./);
  for (const id of [binding.target.splitCreatePrepareNodeId, binding.target.splitJoinPrepareNodeId]) {
    const source = String(result.candidate.find((node) => node.id === id)?.func || "");
    assert.match(source, /successUrl: null/);
    assert.match(source, /failUrl: null/);
  }
  assert.match(combined, /http:\/\/127\.0\.0\.1:3037\/api/);
  assert.match(combined, /http:\/\/127\.0\.0\.1:3038/);
  assert.match(combined, /http:\/\/127\.0\.0\.1:3039/);
});

test("install evidence binds every changed source node to the frozen preimage", () => {
  const { sourceText, binding } = fixture();
  const result = buildDevCandidate(sourceText, binding, fs.readFileSync, trustedBindings());
  assert.equal(verifyChangedNodeEvidence(result.manifest, result.candidate, binding), true);
  const tampered = structuredClone(result.manifest);
  tampered.changedNodes[0].sourceNodeSha256 = "f".repeat(64);
  assert.equal(verifyChangedNodeEvidence(tampered, result.candidate, binding), false);
});

test("DEV builder independently rejects HTTP, mongodb4 wiring, and effective database drift", () => {
  const rebuild = (value) => {
    value.sourceText = `${JSON.stringify(value.flow, null, 2)}\n`;
    value.binding.source.sourceSha256 = sha256(value.sourceText);
    value.binding.source.sourceNodeInventorySha256 = nodeInventorySha256(value.flow);
    value.binding.source.nodeCount = value.flow.length;
    for (const [field, id] of [
      ["routerNodePreimageSha256", "router-dev"],
      ["prepareNodePreimageSha256", "prepare-dev"],
      ["splitRouterNodePreimageSha256", "split-dev"],
      ["splitCreatePrepareNodePreimageSha256", "split-create-dev"],
      ["splitJoinPrepareNodePreimageSha256", "split-join-dev"],
      ["finalizeNodePreimageSha256", "finalize-dev"],
    ]) {
      value.binding.target[field] = sha256(JSON.stringify(
        value.flow.find((node) => node.id === id),
      ));
    }
    const isolation = deriveDevWholeFlowIsolation(value.flow, value.binding.target);
    value.binding.dependencies.executionFunctionPreimages = isolation.reachableFunctionIds.map((id) => ({
      id,
      nodeSha256: sha256(JSON.stringify(value.flow.find((node) => node.id === id))),
    }));
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

  for (const [field, unsafeValue] of [
    ["method", "DELETE"], ["ret", "txt"], ["paytoqs", "query"],
    ["requestTimeout", ""], ["persist", true], ["insecureHTTPParser", true],
  ]) {
    const httpSemanticsDrift = fixture();
    const httpNode = httpSemanticsDrift.flow.find((node) => node.id === "lk_subscription_booking_http_20260804");
    httpNode[field] = unsafeValue;
    httpSemanticsDrift.binding.dependencies.httpRequestPreimageSha256 = sha256(JSON.stringify(httpNode));
    rebuild(httpSemanticsDrift);
    assert.throws(() => buildDevCandidate(
      httpSemanticsDrift.sourceText, httpSemanticsDrift.binding, fs.readFileSync, trustedBindings(),
    ), /HTTP request wiring/);
  }

  const duplicateId = fixture();
  duplicateId.flow.push(structuredClone(duplicateId.flow[1]));
  rebuild(duplicateId);
  assert.throws(() => buildDevCandidate(
    duplicateId.sourceText, duplicateId.binding, fs.readFileSync, trustedBindings(),
  ), /duplicate node IDs/);

  const extraMongoClient = fixture();
  extraMongoClient.flow.push({
    id: "unclaimed-production-mongo", type: "mongodb4-client", uri: "mongodb://production.invalid/prod",
  });
  rebuild(extraMongoClient);
  assert.throws(() => buildDevCandidate(
    extraMongoClient.sourceText, extraMongoClient.binding, fs.readFileSync, trustedBindings(),
  ), /Mongo client inventory/);

  const numericTimeout = fixture();
  numericTimeout.flow.find((node) => node.operation === "updateOne").maxTimeMS = 5000;
  rebuild(numericTimeout);
  assert.throws(() => buildDevCandidate(
    numericTimeout.sourceText, numericTimeout.binding, fs.readFileSync, trustedBindings(),
  ), /Mongo wiring mismatch/);

  for (const unsafeNode of [
    { id: "exec-out", type: "exec", command: "true", wires: [] },
    { id: "mqtt-out", type: "mqtt out", broker: "prod-broker", wires: [] },
    { id: "tcp-out", type: "tcp out", host: "production.internal", wires: [] },
    { id: "other-db", type: "postgres", host: "production.internal", wires: [] },
    { id: "ws-out", type: "websocket out", server: "production.internal", wires: [] },
  ]) {
    const unsafeCapability = fixture();
    unsafeCapability.flow.push(unsafeNode);
    rebuild(unsafeCapability);
    assert.throws(() => buildDevCandidate(
      unsafeCapability.sourceText, unsafeCapability.binding, fs.readFileSync, trustedBindings(),
    ), /non-isolated node capability/);
  }

  const externalFunctionLib = fixture();
  externalFunctionLib.flow.find((node) => node.id === "prepare-dev").libs = [{ var: "net", module: "net" }];
  externalFunctionLib.binding.target.preparePreimageSha256 = sha256("prepare prod source");
  rebuild(externalFunctionLib);
  assert.throws(() => buildDevCandidate(
    externalFunctionLib.sourceText, externalFunctionLib.binding, fs.readFileSync, trustedBindings(),
  ), /offline source provenance mismatch|non-isolated node capability/);
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
  value.binding.source.sourceNodeInventorySha256 = nodeInventorySha256(value.flow);
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
    value.binding.source.sourceNodeInventorySha256 = nodeInventorySha256(value.flow);
    value.binding.source.nodeCount = value.flow.length;
    value.binding.endpointAudit.endpointInventorySha256 = endpointInventorySha256(value.flow);
    value.binding.dependencies.executionFunctionPreimages = deriveDevWholeFlowIsolation(
      value.flow, value.binding.target,
    ).reachableFunctionIds.map((id) => ({
      id,
      nodeSha256: sha256(JSON.stringify(value.flow.find((node) => node.id === id))),
    }));
  };

  const dynamicNode = fixture();
  dynamicNode.flow.push({
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
  extraSender.flow.find((node) => (
    node.id === "lk_subscription_managed_policy_blocked_20260820"
  )).wires = [["finalize-dev", "lk_subscription_booking_http_20260804"]];
  rebuild(extraSender);
  assert.throws(() => buildDevCandidate(
    extraSender.sourceText, extraSender.binding, fs.readFileSync, trustedBindings(),
  ), /HTTP request wiring/);

  const tokenDisclosureRoute = fixture();
  tokenDisclosureRoute.flow.push({
    id: "debug-token-route",
    type: "http in",
    z: "tab-dev",
    method: "get",
    url: "/debug-token",
    wires: [["debug-token-function"]],
  }, {
    id: "debug-token-function",
    type: "function",
    z: "tab-dev",
    name: "Return service token",
    func: "msg.payload = global.get('vivacrm_access_token'); return msg;",
    wires: [["debug-token-response"]],
  }, {
    id: "debug-token-response",
    type: "http response",
    z: "tab-dev",
    wires: [],
  });
  rebuild(tokenDisclosureRoute);
  tokenDisclosureRoute.binding.source.httpRouteCount = 3;
  assert.throws(() => buildDevCandidate(
    tokenDisclosureRoute.sourceText,
    tokenDisclosureRoute.binding,
    fs.readFileSync,
    trustedBindings(),
  ), /offline source provenance mismatch|non-isolated node capability/);
});

test("shared-root audit capture cannot become a DEV candidate source", () => {
  const { sourceText, binding } = fixture();
  binding.source.sourceKind = "shared-host-audit-only";
  assert.throws(() => buildDevCandidate(sourceText, binding, () => "", trustedBindings()),
    /offline source provenance mismatch/);
  const divergentBindings = trustedBindings();
  divergentBindings.DEV_INSTALL_TARGET = {
    ...DEV_INSTALL_TARGET,
    remoteFlowPath: "/root/.node-red/flows.json",
  };
  assert.throws(() => validateDevBinding(fixture().binding, divergentBindings),
    /diverges from the provisioning contract/);
});

test("offline generator and publisher emit an install-blocked readiness packet", () => {
  const parents = [
    fs.mkdtempSync(path.join(TEMP_ROOT, "lk1-dev-publish-a-")),
    fs.mkdtempSync(path.join(TEMP_ROOT, "lk1-dev-publish-b-")),
  ];
  try {
    const results = parents.map((parent) => {
      const workspace = path.join(parent, "workspace");
      publishOfflineDevSource(workspace, FROZEN_SOURCE_COMMIT);
      const binding = JSON.parse(fs.readFileSync(path.join(
        workspace, "input/source.flow.meta.json",
      ), "utf8"));
      return publishDevCandidate(workspace, binding);
    });
    const ready = JSON.parse(fs.readFileSync(results[0].readyPath, "utf8"));
    assert.equal(ready.sourceProvenance, "OFFLINE_GENERATED");
    assert.equal(ready.hostPreimageState, "ABSENT");
    assert.equal(ready.hostReadbackSha256, null);
    assert.equal(ready.installAuthorized, false);
    assert.equal(ready.candidateSha256, results[0].manifest.candidateSha256);
    assert.equal(ready.manifestSha256, results[0].manifestSha256);
    const foreignWorkspace = path.join(parents[0], "foreign-workspace");
    publishOfflineDevSource(foreignWorkspace, FROZEN_SOURCE_COMMIT);
    assert.doesNotThrow(() => execFileSync(process.execPath, [
      path.resolve("scripts/prepare_lk1_subscription_dev_candidate.mjs"),
      "--workspace", foreignWorkspace,
      "--binding", path.resolve("scripts/lk1_subscription_dev_candidate_binding.json"),
    ], { cwd: TEMP_ROOT, encoding: "utf8" }));
    for (const file of [
      "lk1-subscription-dev.candidate.json",
      "lk1-subscription-dev.manifest.json",
      "lk1-subscription-dev.ready.json",
    ]) {
      assert.deepEqual(
        fs.readFileSync(path.join(parents[0], "workspace/build", file)),
        fs.readFileSync(path.join(parents[1], "workspace/build", file)),
      );
    }
    const installAttempt = spawnSync(process.execPath, [
      "scripts/verify_lk1_subscription_dev_install.mjs",
      "--manifest", results[0].manifestPath,
      "--candidate", results[0].candidatePath,
    ], { cwd: path.resolve("."), encoding: "utf8" });
    assert.notEqual(installAttempt.status, 0);
    assert.match(installAttempt.stderr, /blocks DEV install/);
  } finally {
    parents.forEach((parent) => fs.rmSync(parent, { recursive: true, force: true }));
  }
});

test("publisher rejects an arbitrary self-consistent binding and symlinked input", () => {
  const parent = fs.mkdtempSync(path.join(TEMP_ROOT, "lk1-dev-untrusted-"));
  try {
    const workspace = path.join(parent, "workspace");
    publishOfflineDevSource(workspace, FROZEN_SOURCE_COMMIT);
    const metaPath = path.join(workspace, "input/source.flow.meta.json");
    const binding = JSON.parse(fs.readFileSync(metaPath, "utf8"));
    const tamperedAuthorization = JSON.parse(fs.readFileSync(
      "scripts/lk1_subscription_dev_source_authorization.json", "utf8",
    ));
    tamperedAuthorization.filesSha256["scripts/lk1_subscription_dev_execution_contract.mjs"] =
      "f".repeat(64);
    assert.throws(() => publishDevCandidate(workspace, binding, {
      sourceAuthorization: tamperedAuthorization,
    }), /does not accept authority overrides/);
    assert.equal(fs.existsSync(path.join(workspace, "build")), false);
    const untrusted = structuredClone(binding);
    const sourcePath = path.join(workspace, "input/source.flow.json");
    const source = JSON.parse(fs.readFileSync(sourcePath, "utf8"));
    const optionsNode = source.find((node) => node.id === "lk_subscription_booking_options_20260804");
    optionsNode.func = "msg.payload = global.get('vivacrm_access_token'); return msg;";
    const untrustedSourceText = `${JSON.stringify(source, null, 2)}\n`;
    fs.writeFileSync(sourcePath, untrustedSourceText);
    untrusted.source.sourceSha256 = sha256(untrustedSourceText);
    untrusted.source.sourceNodeInventorySha256 = nodeInventorySha256(source);
    untrusted.dependencies.executionFunctionPreimages.find((entry) => (
      entry.id === optionsNode.id
    )).nodeSha256 = sha256(JSON.stringify(optionsNode));
    fs.writeFileSync(metaPath, `${JSON.stringify(untrusted, null, 2)}\n`);
    assert.throws(() => publishDevCandidate(workspace, untrusted), /frozen binding/);

    fs.writeFileSync(metaPath, `${JSON.stringify(binding, null, 2)}\n`);
    publishOfflineDevSource(path.join(parent, "clean-workspace"), FROZEN_SOURCE_COMMIT);
    const cleanSourcePath = path.join(parent, "clean-workspace/input/source.flow.json");
    const realSourcePath = path.join(workspace, "input/source.flow.real.json");
    fs.copyFileSync(cleanSourcePath, realSourcePath);
    fs.rmSync(sourcePath);
    fs.symlinkSync(realSourcePath, sourcePath);
    assert.throws(() => publishDevCandidate(workspace, binding), /canonical regular file/);
  } finally {
    fs.rmSync(parent, { recursive: true, force: true });
  }
});

test("offline generator rejects a temp symlink parent that resolves outside its custody", () => {
  const holder = fs.mkdtempSync(path.join(TEMP_ROOT, "lk1-dev-symlink-parent-"));
  try {
    const redirect = path.join(holder, "redirect");
    fs.symlinkSync(fs.realpathSync(ROOT), redirect);
    assert.throws(() => publishOfflineDevSource(path.join(redirect, "workspace"), FROZEN_SOURCE_COMMIT),
      /workspace must be under/);
  } finally {
    fs.rmSync(holder, { recursive: true, force: true });
  }
});

test("checked-in DEV binding is source-only and never claims runtime or install proof", () => {
  const binding = JSON.parse(fs.readFileSync("scripts/lk1_subscription_dev_candidate_binding.json", "utf8"));
  assert.equal(binding.environment, "DEV");
  assert.equal(binding.productionBindingState, "UNBOUND_AFTER_ROUTER_AMENDMENT");
  assert.equal(binding.installAllowed, false);
  assert.equal(binding.bindingState, "BOUND_SOURCE_ONLY");
  assert.equal(binding.environmentIdentityVerified, false);
  assert.equal(binding.target.present, true);
  assert.equal(binding.runtime.completeManagedContractExposed, false);
  assert.equal(binding.runtime.completeManagedContractSourceImplemented, true);
  assert.equal(binding.runtime.localPhysicalVerified, true);
  assert.equal(binding.runtime.hostRuntimeExposed, false);
  assert.equal(binding.dependencies.mongoBindingVerifiedDevOnly, true);
  assert.equal(binding.endpointAudit.verifiedDevOnly, true);
  assert.equal(fs.existsSync(path.resolve(
    import.meta.dirname, "../lk1_subscription_dev_host_evidence.json",
  )), false, "source-only gate must not carry stale host evidence");
  assert.equal(validateDevBinding(binding), true);
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

test("snapshot inspector independently rejects unsafe HTTP, Mongo, and graph semantics", () => {
  const idMap = {
    "router-dev": "lk_subscription_booking_router_20260804",
    "prepare-dev": "lk_subscription_booking_prepare_20260804",
    "split-dev": "8f7bd5b482fe9763",
    "split-create-dev": "f3f9a60354d394da",
    "split-join-dev": "e92e68bf3f08a70c",
    "finalize-dev": "lk_subscription_booking_finalize_20260804",
  };
  const probes = {
    healthy: () => {},
    deleteMethod: (flow) => { flow.find((node) => node.id === "lk_subscription_booking_http_20260804").method = "DELETE"; },
    numericTimeout: (flow) => { flow.find((node) => node.operation === "updateOne").maxTimeMS = 5000; },
    expressionMode: (flow) => { flow.find((node) => node.operation === "updateOne").mode = "expression"; },
    rawOutput: (flow) => { flow.find((node) => node.operation === "find").output = "raw"; },
    extraMongoClient: (flow) => { flow.push({ id: "extra-client", type: "mongodb4-client", uri: "mongodb://production.invalid/prod" }); },
    extraMongoProducer: (flow) => { flow.push({ id: "producer", type: "function", z: "tab-dev", name: "Producer", func: "return msg;", wires: [["lk_subscription_booking_update_20260804"]] }); },
    duplicateId: (flow) => { flow.push(structuredClone(flow[1])); },
    unsafeExec: (flow) => { flow.push({ id: "exec", type: "exec", command: "true", wires: [] }); },
    functionLibrary: (flow) => { flow.find((node) => node.id === "prepare-dev").libs = [{ var: "net", module: "net" }]; },
    activeDebug: (flow) => { flow.push({ id: "debug", type: "debug", active: true, console: true, tostatus: false, complete: "true", targetType: "full", wires: [] }); },
    disconnectedOnStart: (flow) => { flow.push({ id: "on-start", type: "function", z: "tab-dev", name: "On start escape", func: "return msg;", initialize: "global.set('escape', true);", wires: [] }); },
    rogueCatch: (flow) => { flow.push({ id: "rogue-catch", type: "catch", z: "tab-dev", scope: ["lk_subscription_booking_update_20260804"], uncaught: false, wires: [["router-dev"]] }); },
    unscopedCatch: (flow) => { flow.find((node) => node.id === "lk_subscription_booking_catch_20260804").scope = null; },
    alteredCatchWire: (flow) => { flow.find((node) => node.id === "lk_subscription_booking_catch_20260804").wires = [["router-dev"]]; },
  };
  for (const [label, mutate] of Object.entries(probes)) {
    const { flow } = fixture();
    mutate(flow);
    const serialized = JSON.stringify(flow, (key, value) => (
      typeof value === "string" && idMap[value] ? idMap[value] : value
    ));
    const workspace = fs.mkdtempSync(path.join(os.tmpdir(), "lk1-dev-inspector-contract-"));
    const sourcePath = path.join(workspace, "source.flow.json");
    const metaPath = path.join(workspace, "source.flow.meta.json");
    const credentialStorePath = path.join(workspace, "source.flow.credentials.json");
    try {
      fs.writeFileSync(sourcePath, serialized);
      fs.writeFileSync(credentialStorePath, "{}");
      fs.writeFileSync(metaPath, JSON.stringify({ environment: "DEV", syntheticTestOnly: true }));
      execFileSync(process.execPath, [
        "scripts/inspect_lk1_subscription_dev_snapshot.mjs", sourcePath, metaPath, credentialStorePath,
      ]);
      const audit = JSON.parse(fs.readFileSync(metaPath, "utf8"));
      assert.equal(audit.dependencies.httpRequestBindingVerified,
        !["deleteMethod", "duplicateId"].includes(label), label);
      assert.equal(audit.dependencies.mongoBindingVerifiedDevOnly,
        !["numericTimeout", "expressionMode", "rawOutput", "extraMongoClient", "extraMongoProducer"].includes(label));
      assert.equal(audit.dependencies.wholeFlowIsolationVerified,
        !["duplicateId", "unsafeExec", "functionLibrary", "activeDebug", "extraMongoProducer", "disconnectedOnStart", "rogueCatch", "unscopedCatch", "alteredCatchWire"].includes(label), label);
      assert.equal(audit.environmentIdentityVerified, false,
        "synthetic evidence must never become verified runtime evidence");
    } finally {
      fs.rmSync(workspace, { recursive: true, force: true });
    }
  }
});

test("DEV and PROD manifests cannot cross installation environments", () => {
  const devManifest = {
    environment: "DEV",
    sourceSha256: "b".repeat(64),
    candidateSha256: "a".repeat(64),
    targetHost: "lk-reserve-89",
    targetHostname: "89-108-64-209.cloudvps.regruhosting.ru",
    targetServiceName: DEV_INSTALL_TARGET.serviceName,
    targetUnixUser: DEV_INSTALL_TARGET.unixUser,
    targetUserDir: DEV_INSTALL_TARGET.userDir,
    targetFlowPath: DEV_INSTALL_TARGET.remoteFlowPath,
    hostPreimage: { state: "ABSENT", sha256: null },
    rollback: {
      mode: "RETURN_TO_ABSENT", restoreSha256: null, preserveEvidence: true,
      deleteData: false, requiresSeparateAuthorization: true,
    },
    changedNodeIds: ["a", "b", "c", "d", "e", "f"],
    changedNodes: ["a", "b", "c", "d", "e", "f"].map((id) => ({
      id, changedFields: ["func"], sourceNodeSha256: "c".repeat(64), candidateNodeSha256: "d".repeat(64),
    })),
    candidateNodeInventorySha256: "e".repeat(64),
    installAuthorization: {
      authorized: true,
      candidateSha256: "a".repeat(64),
      targetHost: "lk-reserve-89",
      targetServiceName: DEV_INSTALL_TARGET.serviceName,
      targetFlowPath: DEV_INSTALL_TARGET.remoteFlowPath,
    },
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
