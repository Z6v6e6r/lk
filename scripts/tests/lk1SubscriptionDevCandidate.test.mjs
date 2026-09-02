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
const DEV_API_BASE = "https://subscriptions-dev.example.test/api";
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
});

function fixture() {
  const routerPreimage = "const MANAGED_RUNTIME_API_BASE_BY_ENVIRONMENT = {\n  DEV: null,\n};\n";
  const splitPreimage = "const MANAGED_RUNTIME_API_BASE_BY_ENVIRONMENT = {\n  DEV: null,\n};\n";
  const flow = [
    { id: "tab-dev", type: "tab", label: "LK Games", disabled: false },
    { id: "route-dev", type: "http in", z: "tab-dev", url: "/lk/subscription-bookings", wires: [["router-dev"]] },
    { id: "router-dev", type: "function", z: "tab-dev", name: "Route atomic subscription booking", func: routerPreimage, wires: [] },
    { id: "split-dev", type: "function", z: "tab-dev", name: "Route Viva split payment", func: splitPreimage, wires: [] },
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
      splitRouterNodeId: "split-dev",
      splitRouterNodeName: "Route Viva split payment",
      splitRouterPreimageSha256: sha256(splitPreimage),
    },
    runtime: { apiBase: DEV_API_BASE, completeManagedContractExposed: true },
    dependencies: {
      httpRequestBindingVerified: true,
      mongoBindingVerifiedDevOnly: true,
      crossEnvironmentMongoConfigCount: 0,
    },
    endpointAudit: { verifiedDevOnly: true, crossEnvironmentEndpointCount: 0 },
    installTarget: { ...DEV_INSTALL_TARGET },
  };
  return { flow, sourceText, binding };
}

test("strict environment URL contract allows only the exact bound DEV or PROD base", () => {
  assert.equal(validateEnvironmentApiBase("DEV", DEV_API_BASE, DEV_API_BASE), true);
  assert.equal(validateEnvironmentApiBase("PROD", "https://padlhub.su/api", "https://padlhub.su/api"), true);
  assert.throws(() => validateEnvironmentApiBase("DEV", "https://padlhub.su/api", "https://padlhub.su/api"),
    /forbidden in DEV/);
  assert.throws(() => validateEnvironmentApiBase("PROD", DEV_API_BASE, DEV_API_BASE),
    /forbidden in PROD/);
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
  const trackedSources = {
    "scripts/nodered_subscription_booking_nodes/fn_subscription_booking_router.js":
      "const MANAGED_RUNTIME_EXPECTED_ENVIRONMENT = \"PROD\";\nconst MANAGED_RUNTIME_API_BASE_BY_ENVIRONMENT = {\n  PROD: \"https://padlhub.su/api\",\n  DEV: null,\n};\n",
    "scripts/nodered_games_nodes/fn_split_router.js":
      "const MANAGED_RUNTIME_EXPECTED_ENVIRONMENT = \"PROD\";\nconst MANAGED_RUNTIME_API_BASE_BY_ENVIRONMENT = {\n  PROD: \"https://padlhub.su/api\",\n  DEV: null,\n};\n",
  };
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
    /DEV: "https:\/\/subscriptions-dev\.example\.test\/api"/);
  assert.match(result.candidate.find((node) => node.id === "router-dev").func,
    /MANAGED_RUNTIME_EXPECTED_ENVIRONMENT = "DEV"/);
  assert.doesNotMatch(result.candidate.find((node) => node.id === "router-dev").func,
    /PROD: "https:\/\/padlhub\.su\/api"/);
});

test("DEV builder rejects tracked function bodies that retain production/shared endpoints", () => {
  const { sourceText, binding } = fixture();
  const sources = {
    "scripts/nodered_subscription_booking_nodes/fn_subscription_booking_router.js":
      "const MANAGED_RUNTIME_EXPECTED_ENVIRONMENT = \"PROD\";\nconst MANAGED_RUNTIME_API_BASE_BY_ENVIRONMENT = {\n  PROD: \"https://padlhub.su/api\",\n  DEV: null,\n};\nconst VIVA = \"https://api.vivacrm.ru\";\n",
    "scripts/nodered_games_nodes/fn_split_router.js":
      "const MANAGED_RUNTIME_EXPECTED_ENVIRONMENT = \"PROD\";\nconst MANAGED_RUNTIME_API_BASE_BY_ENVIRONMENT = {\n  PROD: \"https://padlhub.su/api\",\n  DEV: null,\n};\n",
  };
  assert.throws(() => buildDevCandidate(
    sourceText,
    binding,
    (file) => sources[file],
    trustedBindings(),
  ), /retains a production\/shared endpoint/);
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
  const trackedSources = {
    "scripts/nodered_subscription_booking_nodes/fn_subscription_booking_router.js":
      "const MANAGED_RUNTIME_EXPECTED_ENVIRONMENT = \"PROD\";\nconst MANAGED_RUNTIME_API_BASE_BY_ENVIRONMENT = {\n  PROD: \"https://padlhub.su/api\",\n  DEV: null,\n};\n",
    "scripts/nodered_games_nodes/fn_split_router.js":
      "const MANAGED_RUNTIME_EXPECTED_ENVIRONMENT = \"PROD\";\nconst MANAGED_RUNTIME_API_BASE_BY_ENVIRONMENT = {\n  PROD: \"https://padlhub.su/api\",\n  DEV: null,\n};\n",
  };
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
  assert.throws(() => validateDevBinding(binding), /blocked/);
});

test("read-only snapshot inspector computes graph, target, duplicate, and Mongo evidence", () => {
  const { flow } = fixture();
  flow.push({ id: "mongo-prod", type: "mongodb", hostname: "cluster.example.test/prod", wires: [] });
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), "lk1-dev-snapshot-test-"));
  const sourcePath = path.join(workspace, "source.flow.json");
  const metaPath = path.join(workspace, "source.flow.meta.json");
  fs.writeFileSync(sourcePath, `${JSON.stringify(flow)}\n`);
  fs.writeFileSync(metaPath, JSON.stringify({
    environment: "DEV",
    sourceKind: "shared-host-audit-only",
    sourceHost: "lk-reserve-89",
  }));
  execFileSync(process.execPath, [
    "scripts/inspect_lk1_subscription_dev_snapshot.mjs",
    sourcePath,
    metaPath,
  ]);
  const audit = JSON.parse(fs.readFileSync(metaPath, "utf8"));
  assert.equal(audit.brokenWires, 0);
  assert.equal(audit.brokenLinks, 0);
  assert.equal(audit.target.present, false, "fixture IDs deliberately differ from production target IDs");
  assert.equal(audit.dependencies.crossEnvironmentMongoConfigCount, 1);
  assert.equal(audit.dependencies.mongoBindingVerifiedDevOnly, false);
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
