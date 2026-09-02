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
const PREPARE_SOURCE = "scripts/nodered_subscription_booking_nodes/fn_subscription_booking_prepare.js";
const FINALIZE_SOURCE = "scripts/nodered_subscription_booking_nodes/fn_subscription_booking_finalize.js";
const SPLIT_ROUTER_SOURCE = "scripts/nodered_games_nodes/fn_split_router.js";
const SPLIT_CREATE_PREPARE_SOURCE = "scripts/nodered_games_nodes/fn_split_create_prepare.js";
const SPLIT_JOIN_PREPARE_SOURCE = "scripts/nodered_games_nodes/fn_split_join_prepare.js";
const HTTP_REQUEST_NODE_ID = "lk_subscription_booking_http_20260804";
const SPLIT_CREATE_HTTP_REQUEST_NODE_ID = "ee7ba8cdd68bdf74";
const MANAGED_MONGO_SPECS = Object.freeze([
  { id: "lk_subscription_booking_find_20260804", operation: "find", routerOutputIndex: 1 },
  { id: "lk_subscription_booking_insert_20260804", operation: "insertOne", routerOutputIndex: 2 },
  { id: "lk_subscription_booking_update_20260804", operation: "updateOne", routerOutputIndex: 3 },
]);
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
  const transportAllowed = environment === "PROD"
    ? parsed.protocol === "https:"
    : parsed.protocol === "http:" && parsed.hostname === "127.0.0.1";
  if (!transportAllowed
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

export function validateDevEndpointBindings(endpoints, provisioningContract = checkedProvisioningContract) {
  const expectedKeys = ["cupApiBase", "vivaApiBase", "serv2Base", "tokenUrl"].sort();
  if (JSON.stringify(Object.keys(endpoints || {}).sort()) !== JSON.stringify(expectedKeys)) {
    fail("DEV endpoint bindings do not match the approved schema");
  }
  const expected = {
    cupApiBase: `http://${provisioningContract.fixtureDependencies.cup.listener}/api`,
    vivaApiBase: `http://${provisioningContract.fixtureDependencies.provider.listener}`,
    serv2Base: `http://${provisioningContract.fixtureDependencies.provider.listener}/serv2`,
    tokenUrl: `http://${provisioningContract.fixtureDependencies.identity.listener}/realms/dev/protocol/openid-connect/token`,
  };
  for (const [key, value] of Object.entries(expected)) {
    if (endpoints[key] !== value) fail(`DEV ${key} is not the exact fixture binding`);
    const parsed = new URL(endpoints[key]);
    if (parsed.protocol !== "http:" || parsed.hostname !== "127.0.0.1"
      || parsed.username || parsed.password || parsed.search || parsed.hash) {
      fail(`DEV ${key} is not an isolated loopback URL`);
    }
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

const replaceExactMarker = (source, marker, replacement, label) => {
  if (!source.includes(marker) || source.indexOf(marker) !== source.lastIndexOf(marker)) {
    fail(`${label} marker mismatch`);
  }
  return source.replace(marker, replacement);
};

const bindManagedRuntimeSource = (source, apiBase) => {
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

const bindDevEndpoints = (source, kind, endpoints) => {
  if (kind === "router") {
    return replaceExactMarker(
      replaceExactMarker(source,
        'const VIVA_API_BASE = "https://api.vivacrm.ru";',
        `const VIVA_API_BASE = ${JSON.stringify(endpoints.vivaApiBase)};`,
        "Atomic-router Viva base"),
      'const SERV2_URL = "https://padlhub.su/seliger";',
      `const SERV2_URL = ${JSON.stringify(endpoints.serv2Base)};`,
      "Atomic-router SERV2 base",
    );
  }
  if (kind === "prepare") {
    return replaceExactMarker(source,
      'const VIVA_API_BASE = "https://api.vivacrm.ru";',
      `const VIVA_API_BASE = ${JSON.stringify(endpoints.vivaApiBase)};`,
      "Prepare-node Viva base");
  }
  if (kind === "split") {
    let next = replaceExactMarker(source,
      'const ADMIN_API = "https://api.vivacrm.ru/api/v1";',
      `const ADMIN_API = ${JSON.stringify(`${endpoints.vivaApiBase}/api/v1`)};`,
      "Split-router Admin base");
    next = replaceExactMarker(next,
      'const END_USER_API = "https://api.vivacrm.ru/end-user/api/v1/iSkq6G";',
      `const END_USER_API = ${JSON.stringify(`${endpoints.vivaApiBase}/end-user/api/v1/iSkq6G`)};`,
      "Split-router end-user base");
    next = replaceExactMarker(next,
      'const CUP_API_DEFAULT = "https://padlhub.su/api";',
      `const CUP_API_DEFAULT = ${JSON.stringify(endpoints.cupApiBase)};`,
      "Split-router CUP base");
    next = replaceExactMarker(next,
      'const TOKEN_URL_DEFAULT = "https://kc.vivacrm.ru/realms/prod/protocol/openid-connect/token";',
      `const TOKEN_URL_DEFAULT = ${JSON.stringify(endpoints.tokenUrl)};`,
      "Split-router token URL");
    next = replaceExactMarker(next,
      '  const apiBase = (readEnv("CUP_API_BASE_URL") || CUP_API_DEFAULT).replace(/\\/+$/, "");',
      '  const apiBase = CUP_API_DEFAULT.replace(/\\/+$/, "");',
      "Split-router CUP override");
    return replaceExactMarker(next,
      '  msg.url = readEnv("VIVA_SERVICE_TOKEN_URL") || TOKEN_URL_DEFAULT;',
      "  msg.url = TOKEN_URL_DEFAULT;",
      "Split-router token override");
  }
  if (kind === "splitPrepare") {
    let next = replaceExactMarker(source,
      'const CUP_API_DEFAULT = "https://padlhub.su/api";',
      `const CUP_API_DEFAULT = ${JSON.stringify(endpoints.cupApiBase)};`,
      "Split-prepare CUP base");
    next = replaceExactMarker(next,
      'const TOKEN_URL_DEFAULT = "https://kc.vivacrm.ru/realms/prod/protocol/openid-connect/token";',
      `const TOKEN_URL_DEFAULT = ${JSON.stringify(endpoints.tokenUrl)};`,
      "Split-prepare token URL");
    next = replaceExactMarker(next,
      '  const apiBase = (readEnv("CUP_API_BASE_URL") || CUP_API_DEFAULT).replace(/\\/+$/, "");',
      '  const apiBase = CUP_API_DEFAULT.replace(/\\/+$/, "");',
      "Split-prepare CUP override");
    return replaceExactMarker(next,
      'msg.url = readEnv("VIVA_SERVICE_TOKEN_URL") || TOKEN_URL_DEFAULT;',
      "msg.url = TOKEN_URL_DEFAULT;",
      "Split-prepare token override");
  }
  fail("Unknown DEV source binding kind");
};

const assertDevPostimageHasNoProductionEndpoints = (sources, allowedOrigins) => {
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
  const literals = sources.flatMap((source) => (
    source.match(/https?:\/\/[^\s"'`]+/g) || []
  ));
  for (const literal of literals) {
    let parsed;
    try {
      parsed = new URL(literal.replace(/[),;]+$/, ""));
    } catch {
      fail(`DEV candidate contains an invalid endpoint literal (${literal})`);
    }
    if (!allowedOrigins.has(parsed.origin)) {
      fail(`DEV candidate contains an unapproved endpoint origin (${parsed.origin})`);
    }
  }
};

const collectHttpEndpointLiterals = (value, pathPrefix = "$", excludeFunctionBodies = false) => {
  const endpoints = [];
  const visit = (current, currentPath) => {
    if (typeof current === "string") {
      for (const literal of current.match(/https?:\/\/[^\s"'`]+/g) || []) {
        const normalized = literal.replace(/[),;]+$/, "");
        let parsed = null;
        try {
          parsed = new URL(normalized);
        } catch {
          // Keep malformed literals in the derived audit so they fail closed.
        }
        endpoints.push({ path: currentPath, literal: normalized, origin: parsed?.origin || null });
      }
      return;
    }
    if (Array.isArray(current)) {
      current.forEach((entry, index) => visit(entry, `${currentPath}[${index}]`));
      return;
    }
    if (!current || typeof current !== "object") return;
    for (const [key, entry] of Object.entries(current)) {
      if (excludeFunctionBodies && key === "func" && current.type === "function") continue;
      visit(entry, `${currentPath}.${key}`);
    }
  };
  visit(value, pathPrefix);
  return endpoints;
};

const deriveEndpointAudit = (flow, allowedOrigins, excludeFunctionBodies = false) => {
  const endpointInventory = collectHttpEndpointLiterals(flow, "$", excludeFunctionBodies);
  const crossEnvironmentEndpoints = endpointInventory.filter((entry) => (
    !entry.origin || !allowedOrigins.has(entry.origin)
  ));
  return {
    verifiedDevOnly: crossEnvironmentEndpoints.length === 0,
    crossEnvironmentEndpointCount: crossEnvironmentEndpoints.length,
    endpointInventorySha256: sha256(JSON.stringify(endpointInventory)),
  };
};

const effectiveMongoIdentity = (node) => {
  const uri = String(node?.uri || "").trim();
  if (uri && uri !== "__MONGODB_URI_REQUIRED__") {
    let parsed;
    try {
      parsed = new URL(uri);
    } catch {
      fail("DEV mongodb4-client URI is invalid");
    }
    let advanced;
    try {
      advanced = JSON.parse(String(node?.advanced ?? "{}"));
    } catch {
      fail("DEV mongodb4-client advanced options are invalid");
    }
    if (!advanced || typeof advanced !== "object" || Array.isArray(advanced)) {
      fail("DEV mongodb4-client advanced options must be an object");
    }
    const serializedCredentialFields = [
      node?.username, node?.password, node?.authSource, node?.authMechanism,
      node?.tlsCAFile, node?.tlsCertificateKeyFile,
    ].some((value) => String(value || "").trim());
    return {
      mode: "uri",
      protocol: parsed.protocol.replace(/:$/, ""),
      host: parsed.hostname,
      port: Number(parsed.port || 27017),
      database: parsed.pathname.replace(/^\//, ""),
      credentialsPresent: Boolean(parsed.username || parsed.password || serializedCredentialFields),
      optionsPresent: Boolean(parsed.search || parsed.hash
        || Object.keys(advanced || {}).length
        || node?.tls === true || node?.tlsInsecure === true),
      uriTabActive: String(node?.uriTabActive || ""),
    };
  }
  fail("DEV mongodb4-client must use an exact credential-free URI");
};

const assertDevMongoCustody = (flow, router, dependencies, provisioningContract) => {
  const claimedClient = dependencies?.managedMongoClient;
  const clients = flow.filter((node) => node?.type === "mongodb4-client"
    && node.id === claimedClient?.id);
  if (clients.length !== 1) fail("DEV managed mongodb4-client identity is absent or ambiguous");
  const identity = effectiveMongoIdentity(clients[0]);
  const expected = provisioningContract.fixtureDependencies.mongo;
  if (identity.protocol !== "mongodb" || identity.host !== expected.host
    || identity.port !== expected.port || identity.database !== expected.database
    || identity.credentialsPresent || identity.optionsPresent
    || identity.uriTabActive !== "tab-uri-advanced"
    || dependencies?.mongoCredentialStoreVerifiedEmpty !== true
    || !/^[a-f0-9]{64}$/.test(dependencies?.mongoCredentialStorePreimageSha256 || "")
    || claimedClient.fixtureOnly !== true
    || JSON.stringify(claimedClient.effectiveIdentity) !== JSON.stringify(identity)
    || sha256(JSON.stringify(clients[0])) !== claimedClient.preimageSha256) {
    fail("DEV managed mongodb4-client effective URI/database is not fixture-only");
  }
  const claims = Array.isArray(dependencies?.managedMongoNodes)
    ? dependencies.managedMongoNodes : [];
  if (claims.length !== MANAGED_MONGO_SPECS.length) fail("DEV managed Mongo node inventory is incomplete");
  for (const spec of MANAGED_MONGO_SPECS) {
    const claim = claims.find((item) => item.id === spec.id);
    const nodes = flow.filter((node) => node?.id === spec.id && node?.type === "mongodb4");
    const node = nodes.length === 1 ? nodes[0] : null;
    if (!claim || !node || claim.operation !== spec.operation
      || claim.routerOutputIndex !== spec.routerOutputIndex
      || node.operation !== spec.operation || node.collection !== "lk_games"
      || node.clientNode !== clients[0].id
      || !Array.isArray(router.wires?.[spec.routerOutputIndex])
      || !router.wires[spec.routerOutputIndex].includes(spec.id)
      || !(node.wires || []).flat().includes(router.id)
      || claim.wiredFromRouter !== true || claim.returnsToRouter !== true
      || claim.clientNode !== clients[0].id || claim.collection !== "lk_games"
      || claim.preimageSha256 !== sha256(JSON.stringify(node))) {
      fail(`DEV managed Mongo wiring mismatch (${spec.id})`);
    }
  }
};

const assertDevHttpCustody = (
  flow, router, prepare, splitRouter, splitCreatePrepare, splitJoinPrepare, dependencies,
) => {
  const expectedInboundEdges = [
    `${prepare.id}:0:${HTTP_REQUEST_NODE_ID}`,
    `${router.id}:0:${HTTP_REQUEST_NODE_ID}`,
    `${splitRouter.id}:0:${SPLIT_CREATE_HTTP_REQUEST_NODE_ID}`,
    `${splitRouter.id}:3:${HTTP_REQUEST_NODE_ID}`,
    `${splitCreatePrepare.id}:0:${SPLIT_CREATE_HTTP_REQUEST_NODE_ID}`,
    `${splitJoinPrepare.id}:0:${SPLIT_CREATE_HTTP_REQUEST_NODE_ID}`,
  ].sort();
  const allHttpRequests = flow.filter((node) => node?.type === "http request");
  const inboundEdges = flow.flatMap((node) => (
    (Array.isArray(node?.wires) ? node.wires : []).flatMap((targets, outputIndex) => (
      (Array.isArray(targets) ? targets : [])
        .filter((target) => [HTTP_REQUEST_NODE_ID, SPLIT_CREATE_HTTP_REQUEST_NODE_ID].includes(target))
        .map((target) => `${node.id}:${outputIndex}:${target}`)
    ))
  )).sort();
  const nodes = flow.filter((node) => node?.id === HTTP_REQUEST_NODE_ID);
  const http = nodes.length === 1 ? nodes[0] : null;
  const splitCreateNodes = flow.filter((node) => node?.id === SPLIT_CREATE_HTTP_REQUEST_NODE_ID);
  const splitCreateHttp = splitCreateNodes.length === 1 ? splitCreateNodes[0] : null;
  if (JSON.stringify(allHttpRequests.map((node) => node.id).sort())
      !== JSON.stringify([HTTP_REQUEST_NODE_ID, SPLIT_CREATE_HTTP_REQUEST_NODE_ID].sort())
    || JSON.stringify(inboundEdges) !== JSON.stringify(expectedInboundEdges)
    || !http || http.type !== "http request" || String(http.url || "") !== ""
    || JSON.stringify(http.wires) !== JSON.stringify([[router.id]])
    || JSON.stringify(router.wires?.[0]) !== JSON.stringify([HTTP_REQUEST_NODE_ID])
    || JSON.stringify(prepare.wires?.[0]) !== JSON.stringify([HTTP_REQUEST_NODE_ID])
    || JSON.stringify(splitRouter.wires?.[0]) !== JSON.stringify([SPLIT_CREATE_HTTP_REQUEST_NODE_ID])
    || JSON.stringify(splitRouter.wires?.[3]) !== JSON.stringify([HTTP_REQUEST_NODE_ID])
    || dependencies?.httpRequestBindingVerified !== true
    || dependencies?.httpRequestPreimageSha256 !== sha256(JSON.stringify(http))
    || !splitCreateHttp || splitCreateHttp.type !== "http request"
    || String(splitCreateHttp.url || "") !== ""
    || JSON.stringify(splitCreatePrepare.wires?.[0]) !== JSON.stringify([splitCreateHttp.id])
    || JSON.stringify(splitCreatePrepare.wires?.[3]) !== JSON.stringify([splitRouter.id])
    || JSON.stringify(splitJoinPrepare.wires?.[0]) !== JSON.stringify([splitCreateHttp.id])
    || JSON.stringify(splitJoinPrepare.wires?.[3]) !== JSON.stringify([splitRouter.id])
    || JSON.stringify(splitCreateHttp.wires) !== JSON.stringify([[splitRouter.id]])
    || dependencies?.splitCreateHttpRequestPreimageSha256 !== sha256(JSON.stringify(splitCreateHttp))) {
    fail("DEV reachable HTTP request wiring is not exactly attested");
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
    || binding.endpointAudit.crossEnvironmentEndpointCount !== 0
    || !/^[a-f0-9]{64}$/.test(String(binding.endpointAudit.endpointInventorySha256 || ""))) {
    fail("DEV network endpoint configuration audit is absent or not isolated");
  }
  if (!binding.runtime?.completeManagedContractExposed) {
    fail("DEV CUP origin does not expose the complete managed contract");
  }
  if (!trustedBindings?.DEV) fail("Trusted DEV runtime API binding is unbound");
  if (trustedBindings.DEV !== trustedBindings.DEV_ENDPOINTS?.cupApiBase) {
    fail("DEV runtime and CUP fixture bindings diverge");
  }
  validateEnvironmentApiBase("DEV", binding.runtime.apiBase, trustedBindings.DEV);
  validateDevEndpointBindings(trustedBindings.DEV_ENDPOINTS, provisioningContract);
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
  const endpoints = trustedBindings.DEV_ENDPOINTS;
  const allowedOrigins = new Set([
    new URL(binding.runtime.apiBase).origin,
    ...Object.values(endpoints).map((value) => new URL(value).origin),
  ]);
  const sourceEndpointAudit = deriveEndpointAudit(flow, allowedOrigins, true);
  if (sourceEndpointAudit.verifiedDevOnly !== binding.endpointAudit.verifiedDevOnly
    || sourceEndpointAudit.crossEnvironmentEndpointCount
      !== binding.endpointAudit.crossEnvironmentEndpointCount
    || sourceEndpointAudit.endpointInventorySha256
      !== binding.endpointAudit.endpointInventorySha256) {
    fail("DEV source network endpoint configuration audit mismatch");
  }
  const tabs = new Map(flow.filter((node) => node?.type === "tab").map((node) => [node.id, node]));
  const router = exactTarget(flow, tabs, binding.target,
    "routerNodeId", "routerNodeName", "routerPreimageSha256");
  const prepare = exactTarget(flow, tabs, binding.target,
    "prepareNodeId", "prepareNodeName", "preparePreimageSha256");
  const splitRouter = exactTarget(flow, tabs, binding.target,
    "splitRouterNodeId", "splitRouterNodeName", "splitRouterPreimageSha256");
  const splitCreatePrepare = exactTarget(flow, tabs, binding.target,
    "splitCreatePrepareNodeId", "splitCreatePrepareNodeName", "splitCreatePreparePreimageSha256");
  const splitJoinPrepare = exactTarget(flow, tabs, binding.target,
    "splitJoinPrepareNodeId", "splitJoinPrepareNodeName", "splitJoinPreparePreimageSha256");
  const finalize = exactTarget(flow, tabs, binding.target,
    "finalizeNodeId", "finalizeNodeName", "finalizePreimageSha256");
  assertDevHttpCustody(
    flow, router, prepare, splitRouter, splitCreatePrepare, splitJoinPrepare, binding.dependencies,
  );
  assertDevMongoCustody(flow, router, binding.dependencies, provisioningContract);
  const routerSource = bindDevEndpoints(bindManagedRuntimeSource(
    String(readSource(ROUTER_SOURCE, "utf8")), binding.runtime.apiBase,
  ), "router", endpoints);
  const prepareSource = bindDevEndpoints(
    String(readSource(PREPARE_SOURCE, "utf8")), "prepare", endpoints,
  );
  const splitSource = bindDevEndpoints(bindManagedRuntimeSource(
    String(readSource(SPLIT_ROUTER_SOURCE, "utf8")), binding.runtime.apiBase,
  ), "split", endpoints);
  const splitCreateSource = bindDevEndpoints(
    String(readSource(SPLIT_CREATE_PREPARE_SOURCE, "utf8")), "splitPrepare", endpoints,
  );
  const splitJoinSource = bindDevEndpoints(
    String(readSource(SPLIT_JOIN_PREPARE_SOURCE, "utf8")), "splitPrepare", endpoints,
  );
  const finalizeSource = String(readSource(FINALIZE_SOURCE, "utf8"));
  assertDevPostimageHasNoProductionEndpoints(
    [routerSource, prepareSource, splitSource, splitCreateSource, splitJoinSource, finalizeSource],
    allowedOrigins,
  );
  router.func = routerSource;
  prepare.func = prepareSource;
  splitRouter.func = splitSource;
  splitCreatePrepare.func = splitCreateSource;
  splitJoinPrepare.func = splitJoinSource;
  finalize.func = finalizeSource;
  const candidateEndpointAudit = deriveEndpointAudit(flow, allowedOrigins);
  if (!candidateEndpointAudit.verifiedDevOnly
    || candidateEndpointAudit.crossEnvironmentEndpointCount !== 0) {
    fail("DEV candidate contains a cross-environment network endpoint");
  }
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
      nodePostimageSha256: {
        router: sha256(routerSource),
        prepare: sha256(prepareSource),
        splitRouter: sha256(splitSource),
        splitCreatePrepare: sha256(splitCreateSource),
        splitJoinPrepare: sha256(splitJoinSource),
        finalize: sha256(finalizeSource),
      },
      endpointOrigins: [...allowedOrigins].sort(),
      mongoClientPreimageSha256: binding.dependencies.managedMongoClient.preimageSha256,
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
  const credentialStorePath = path.join(resolvedWorkspace, "input/source.flow.credentials.json");
  const snapshot = JSON.parse(fs.readFileSync(metaPath, "utf8"));
  let credentialStoreBytes;
  let credentialStore;
  try {
    credentialStoreBytes = fs.readFileSync(credentialStorePath);
    credentialStore = JSON.parse(credentialStoreBytes.toString("utf8"));
  } catch {
    fail("DEV credential store snapshot is absent or invalid");
  }
  if (!credentialStore || typeof credentialStore !== "object" || Array.isArray(credentialStore)
    || Object.keys(credentialStore).length !== 0
    || snapshot.dependencies?.mongoCredentialStoreVerifiedEmpty !== true
    || snapshot.dependencies.mongoCredentialStorePreimageSha256 !== sha256(credentialStoreBytes)
    || binding.dependencies?.mongoCredentialStorePreimageSha256 !== sha256(credentialStoreBytes)) {
    fail("DEV credential store is not an exact empty frozen preimage");
  }
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
