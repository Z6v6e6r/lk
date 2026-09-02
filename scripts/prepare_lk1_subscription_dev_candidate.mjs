#!/usr/bin/env node

import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  checkedProvisioningContract,
  validateDevProvisioningContract,
} from "./validate_lk1_subscription_dev_provisioning_contract.mjs";

const sha256 = (value) => crypto.createHash("sha256").update(value).digest("hex");
const fail = (message) => { throw new Error(message); };
const PROD_API_BASE = "https://padlhub.su/api";
const ROUTER_SOURCE = "scripts/nodered_subscription_booking_nodes/fn_subscription_booking_router.js";
const SPLIT_ROUTER_SOURCE = "scripts/nodered_games_nodes/fn_split_router.js";
export const LK1_SUBSCRIPTION_RUNTIME_ENVIRONMENT_BINDINGS = Object.freeze(JSON.parse(fs.readFileSync(
  new URL("./lk1_subscription_runtime_environment_bindings.json", import.meta.url),
  "utf8",
)));

export function validateEnvironmentApiBase(environment, configuredApiBase, expectedApiBase) {
  if (!["DEV", "PROD"].includes(environment)) fail("Managed runtime environment must be DEV or PROD");
  if (!configuredApiBase || configuredApiBase !== expectedApiBase) {
    fail("Managed runtime API base is not the exact environment binding");
  }
  let parsed;
  try {
    parsed = new URL(configuredApiBase);
  } catch {
    fail("Managed runtime API base is invalid");
  }
  if (parsed.protocol !== "https:"
    || parsed.username
    || parsed.password
    || parsed.search
    || parsed.hash
    || parsed.pathname !== "/api"
    || parsed.href !== configuredApiBase) {
    fail("Managed runtime API base violates the strict URL contract");
  }
  if (environment === "DEV" && configuredApiBase === PROD_API_BASE) {
    fail("Production CUP origin is forbidden in DEV");
  }
  if (environment === "PROD" && configuredApiBase !== PROD_API_BASE) {
    fail("DEV CUP origin is forbidden in PROD");
  }
  return true;
}

export function validateDevInstallTarget(target,
  trustedBindings = LK1_SUBSCRIPTION_RUNTIME_ENVIRONMENT_BINDINGS) {
  const trustedTarget = trustedBindings?.DEV_INSTALL_TARGET;
  const expectedKeys = [
    "sourceHost", "sourceHostname", "serviceName", "unixUser", "userDir", "remoteFlowPath",
  ].sort();
  const { environment: targetEnvironment, ...targetIdentity } = target || {};
  if (!trustedTarget
    || (targetEnvironment !== undefined && targetEnvironment !== "DEV")
    || JSON.stringify(Object.keys(targetIdentity).sort()) !== JSON.stringify(expectedKeys)
    || JSON.stringify(Object.keys(trustedTarget).sort()) !== JSON.stringify(expectedKeys)
    || targetIdentity.sourceHost !== trustedTarget.sourceHost
    || targetIdentity.sourceHostname !== trustedTarget.sourceHostname
    || targetIdentity.serviceName !== trustedTarget.serviceName
    || targetIdentity.unixUser !== trustedTarget.unixUser
    || targetIdentity.userDir !== trustedTarget.userDir
    || targetIdentity.remoteFlowPath !== trustedTarget.remoteFlowPath) {
    fail("DEV install target is not the exact trusted DEV binding");
  }
  return true;
}

const graphHealth = (flow) => {
  const ids = new Set(flow.map((node) => node?.id));
  let brokenWires = 0;
  let brokenLinks = 0;
  for (const node of flow) {
    for (const target of (Array.isArray(node?.wires) ? node.wires : []).flat()) {
      if (!ids.has(target)) brokenWires += 1;
    }
    if (["link in", "link out"].includes(node?.type) && Array.isArray(node.links)) {
      for (const target of node.links) if (!ids.has(target)) brokenLinks += 1;
    }
  }
  return { brokenWires, brokenLinks };
};

const exactTarget = (flow, tabs, target, idField, nameField, preimageField) => {
  const matches = flow.filter((node) => node?.id === target[idField]);
  if (matches.length !== 1) fail(`DEV target ${target[idField]} must exist exactly once`);
  const node = matches[0];
  const tab = tabs.get(node.z);
  if (node.type !== "function" || node.name !== target[nameField]
    || tab?.label !== target.tabLabel || tab.disabled === true) {
    fail(`DEV target ${target[idField]} identity or enabled-tab mismatch`);
  }
  const duplicates = flow.filter((candidate) => (
    candidate?.type === "function"
    && candidate.name === target[nameField]
    && tabs.get(candidate.z)?.label === target.tabLabel
    && tabs.get(candidate.z)?.disabled !== true
  ));
  if (duplicates.length !== 1) fail(`DEV target ${target[idField]} enabled semantic duplicate`);
  if (sha256(String(node.func || "")) !== target[preimageField]) {
    fail(`DEV target ${target[idField]} preimage mismatch`);
  }
  return node;
};

const bindDevSource = (source, apiBase) => {
  const devMarker = "  DEV: null,";
  const prodMarker = `  PROD: ${JSON.stringify(PROD_API_BASE)},`;
  const environmentMarker = 'const MANAGED_RUNTIME_EXPECTED_ENVIRONMENT = "PROD";';
  for (const marker of [devMarker, prodMarker, environmentMarker]) {
    if (!source.includes(marker) || source.indexOf(marker) !== source.lastIndexOf(marker)) {
      fail("DEV runtime environment binding marker mismatch");
    }
  }
  const devBound = source
    .replace(prodMarker, "  PROD: null,")
    .replace(devMarker, `  DEV: ${JSON.stringify(apiBase)},`)
    .replace(environmentMarker, 'const MANAGED_RUNTIME_EXPECTED_ENVIRONMENT = "DEV";');
  if (devBound.includes(prodMarker) || devBound.includes(environmentMarker)) {
    fail("DEV runtime API binding marker mismatch");
  }
  return devBound;
};

const assertDevPostimageHasNoProductionEndpoints = (sources) => {
  const forbidden = [
    "https://api.vivacrm.ru",
    "https://kc.vivacrm.ru/realms/prod",
    "https://padlhub.su/seliger",
    "const CUP_API_DEFAULT = \"https://padlhub.su/api\"",
  ];
  for (const marker of forbidden) {
    if (sources.some((source) => source.includes(marker))) {
      fail(`DEV candidate retains a production/shared endpoint (${marker})`);
    }
  }
};

export function validateDevBinding(binding,
  trustedBindings = LK1_SUBSCRIPTION_RUNTIME_ENVIRONMENT_BINDINGS,
  provisioningContract = checkedProvisioningContract) {
  validateDevProvisioningContract(provisioningContract);
  if (binding?.environment !== "DEV") fail("DEV builder rejects a production source or binding");
  if (binding.bindingState !== "BOUND" || binding.installAllowed !== true) {
    fail(`DEV candidate binding is blocked (${binding?.bindingState || "missing"})`);
  }
  if (binding.environmentIdentityVerified !== true) fail("DEV environment identity is not verified");
  const plannedTarget = provisioningContract.plannedTarget;
  if (trustedBindings?.DEV_INSTALL_TARGET?.sourceHost !== plannedTarget.sourceHost
    || trustedBindings?.DEV_INSTALL_TARGET?.sourceHostname !== plannedTarget.sourceHostname
    || trustedBindings?.DEV_INSTALL_TARGET?.serviceName !== plannedTarget.serviceName
    || trustedBindings?.DEV_INSTALL_TARGET?.unixUser !== plannedTarget.unixUser
    || trustedBindings?.DEV_INSTALL_TARGET?.userDir !== plannedTarget.userDir
    || trustedBindings?.DEV_INSTALL_TARGET?.remoteFlowPath !== plannedTarget.flowPath) {
    fail("Trusted DEV install target diverges from the provisioning contract");
  }
  if (binding.source?.sourceKind !== "dedicated-dev-target"
    || binding.source.sourceHost !== "lk-reserve-89"
    || binding.source.sourceHostname !== "89-108-64-209.cloudvps.regruhosting.ru"
    || binding.source.sourceUser !== "root"
    || String(binding.source.sourcePort) !== "22"
    || binding.source.remoteFlowPath !== plannedTarget.flowPath) {
    fail("DEV source identity mismatch");
  }
  if (!binding.target?.present || binding.target.enabledDuplicateCount !== 1) {
    fail("DEV target flow is absent or ambiguous");
  }
  if (!binding.dependencies?.httpRequestBindingVerified
    || !binding.dependencies?.mongoBindingVerifiedDevOnly
    || binding.dependencies.crossEnvironmentMongoConfigCount !== 0) {
    fail("DEV HTTP or Mongo dependency binding is not isolated");
  }
  if (binding.endpointAudit?.verifiedDevOnly !== true
    || binding.endpointAudit.crossEnvironmentEndpointCount !== 0) {
    fail("DEV Viva, Keycloak, SERV2, or legacy CUP endpoint binding is not isolated");
  }
  if (!binding.runtime?.completeManagedContractExposed) {
    fail("DEV CUP origin does not expose the complete managed contract");
  }
  if (!trustedBindings?.DEV) fail("Trusted DEV runtime API binding is unbound");
  validateEnvironmentApiBase("DEV", binding.runtime.apiBase, trustedBindings.DEV);
  validateDevInstallTarget(binding.installTarget, trustedBindings);
  const capturedAt = Date.parse(String(binding.source.capturedAt || ""));
  if (!Number.isFinite(capturedAt) || Date.now() < capturedAt
    || Date.now() - capturedAt > 30 * 60 * 1000) fail("DEV source snapshot is stale");
  return true;
}

export function buildDevCandidate(sourceText, binding, readSource = fs.readFileSync,
  trustedBindings = LK1_SUBSCRIPTION_RUNTIME_ENVIRONMENT_BINDINGS,
  provisioningContract = checkedProvisioningContract) {
  validateDevBinding(binding, trustedBindings, provisioningContract);
  if (sha256(sourceText) !== binding.source.sourceSha256) fail("DEV source SHA mismatch");
  const flow = JSON.parse(sourceText);
  if (!Array.isArray(flow)
    || flow.length !== binding.source.nodeCount
    || flow.filter((node) => node?.type === "http in").length !== binding.source.httpRouteCount
    || flow.filter((node) => node?.type === "tab").length !== binding.source.tabCount) {
    fail("DEV source counts mismatch");
  }
  const health = graphHealth(flow);
  if (health.brokenWires !== binding.source.brokenWires
    || health.brokenLinks !== binding.source.brokenLinks
    || health.brokenWires !== 0
    || health.brokenLinks !== 0) fail("DEV source graph is unhealthy");
  const tabs = new Map(flow.filter((node) => node?.type === "tab").map((node) => [node.id, node]));
  const router = exactTarget(flow, tabs, binding.target,
    "routerNodeId", "routerNodeName", "routerPreimageSha256");
  const splitRouter = exactTarget(flow, tabs, binding.target,
    "splitRouterNodeId", "splitRouterNodeName", "splitRouterPreimageSha256");
  const routerSource = bindDevSource(String(readSource(ROUTER_SOURCE, "utf8")), binding.runtime.apiBase);
  const splitSource = bindDevSource(String(readSource(SPLIT_ROUTER_SOURCE, "utf8")), binding.runtime.apiBase);
  assertDevPostimageHasNoProductionEndpoints([routerSource, splitSource]);
  router.func = routerSource;
  splitRouter.func = splitSource;
  const candidateText = `${JSON.stringify(flow, null, 2)}\n`;
  const candidateSha256 = sha256(candidateText);
  return {
    candidate: flow,
    candidateText,
    manifest: {
      formatVersion: 1,
      environment: "DEV",
      sourceSha256: binding.source.sourceSha256,
      candidateSha256,
      targetHost: binding.installTarget.sourceHost,
      targetHostname: binding.installTarget.sourceHostname,
      targetServiceName: binding.installTarget.serviceName,
      targetUnixUser: binding.installTarget.unixUser,
      targetUserDir: binding.installTarget.userDir,
      targetFlowPath: binding.installTarget.remoteFlowPath,
      productionBindingState: "UNBOUND_AFTER_ROUTER_AMENDMENT",
    },
  };
}

export function publishDevCandidate(workspace, binding, options = {}) {
  const provisioningContract = options.provisioningContract ?? checkedProvisioningContract;
  validateDevProvisioningContract(provisioningContract);
  if (provisioningContract.candidateBuildAllowed !== true) {
    fail("Provisioning contract blocks DEV candidate publication");
  }
  const resolvedWorkspace = path.resolve(workspace);
  if (!resolvedWorkspace.startsWith("/private/tmp/") && !resolvedWorkspace.startsWith("/tmp/")) {
    fail("DEV candidate workspace must be under /private/tmp or /tmp");
  }
  const sourcePath = path.join(resolvedWorkspace, "input/source.flow.json");
  const metaPath = path.join(resolvedWorkspace, "input/source.flow.meta.json");
  const snapshot = JSON.parse(fs.readFileSync(metaPath, "utf8"));
  const exactSnapshot = [
    "environment", "sourceKind", "sourceHost", "sourceHostname", "sourceUser",
    "sourcePort", "remoteFlowPath", "sourceSha256", "nodeCount", "httpRouteCount",
    "tabCount", "capturedAt", "brokenWires", "brokenLinks",
  ].every((key) => (
    (key === "environment" ? binding.environment : binding.source[key]) === snapshot[key]
  ))
    && JSON.stringify(binding.target) === JSON.stringify(snapshot.target)
    && JSON.stringify(binding.dependencies) === JSON.stringify(snapshot.dependencies)
    && binding.environmentIdentityVerified === snapshot.environmentIdentityVerified;
  if (!exactSnapshot) fail("DEV snapshot metadata does not match the frozen binding");
  const result = buildDevCandidate(
    fs.readFileSync(sourcePath, "utf8"),
    binding,
    options.readSource ?? fs.readFileSync,
    options.trustedBindings ?? LK1_SUBSCRIPTION_RUNTIME_ENVIRONMENT_BINDINGS,
    provisioningContract,
  );
  const buildDirectory = path.join(resolvedWorkspace, "build");
  if (fs.existsSync(buildDirectory)) fail("Refusing to overwrite an existing DEV candidate build");
  fs.mkdirSync(buildDirectory, { mode: 0o700 });
  const candidatePath = path.join(buildDirectory, "lk1-subscription-dev.candidate.json");
  const manifestPath = path.join(buildDirectory, "lk1-subscription-dev.manifest.json");
  fs.writeFileSync(candidatePath, result.candidateText, { encoding: "utf8", mode: 0o600, flag: "wx" });
  fs.writeFileSync(manifestPath, `${JSON.stringify(result.manifest, null, 2)}\n`, {
    encoding: "utf8", mode: 0o600, flag: "wx",
  });
  return { ...result, candidatePath, manifestPath };
}

export function validateDevInstallManifest(manifest, target,
  trustedBindings = LK1_SUBSCRIPTION_RUNTIME_ENVIRONMENT_BINDINGS) {
  if (manifest?.environment !== "DEV" || target?.environment !== "DEV") {
    fail("DEV manifest cannot be installed in PROD");
  }
  validateDevInstallTarget(target, trustedBindings);
  if (manifest.targetHost !== target.sourceHost
    || manifest.targetHostname !== target.sourceHostname
    || manifest.targetServiceName !== target.serviceName
    || manifest.targetUnixUser !== target.unixUser
    || manifest.targetUserDir !== target.userDir
    || manifest.targetFlowPath !== target.remoteFlowPath
    || !/^[a-f0-9]{64}$/.test(manifest.candidateSha256 || "")) {
    fail("DEV install target does not match the frozen manifest");
  }
  return true;
}

export function assertProductionManifestEnvironment(manifest) {
  if (manifest?.environment !== "PROD") fail("Production builder rejects a DEV manifest");
  return true;
}

const scriptPath = fileURLToPath(import.meta.url);
if (process.argv[1] === scriptPath) {
  if (process.argv.length !== 6 || process.argv[2] !== "--workspace"
    || process.argv[4] !== "--binding") {
    fail("Usage: node scripts/prepare_lk1_subscription_dev_candidate.mjs --workspace <external-workspace> --binding <binding.json>");
  }
  const workspace = path.resolve(process.argv[3]);
  const bindingPath = path.resolve(process.argv[5]);
  const binding = JSON.parse(fs.readFileSync(bindingPath, "utf8"));
  const result = publishDevCandidate(workspace, binding);
  process.stdout.write(`environment=${result.manifest.environment}\n`);
  process.stdout.write(`candidateSha256=${result.manifest.candidateSha256}\n`);
  process.stdout.write(`candidatePath=${result.candidatePath}\n`);
  process.stdout.write(`manifestPath=${result.manifestPath}\n`);
}
