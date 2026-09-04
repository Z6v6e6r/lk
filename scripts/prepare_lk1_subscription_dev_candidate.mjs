#!/usr/bin/env node

import crypto from "node:crypto";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  deriveDevWholeFlowIsolation,
  hasUniqueFlowIds,
  hasSafeDevHttpSemantics,
} from "./lk1_subscription_dev_execution_contract.mjs";
import {
  checkedProvisioningContract,
  validateDevProvisioningContract,
} from "./validate_lk1_subscription_dev_provisioning_contract.mjs";

const sha256 = (value) => crypto.createHash("sha256").update(value).digest("hex");
const fail = (message) => { throw new Error(message); };
const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const readRepositorySource = (file, encoding) => fs.readFileSync(
  path.join(REPO_ROOT, file), encoding,
);
const PROD_API_BASE = "https://padlhub.su/api";
const ROUTER_SOURCE = "scripts/nodered_subscription_booking_nodes/fn_subscription_booking_router.js";
const PREPARE_SOURCE = "scripts/nodered_subscription_booking_nodes/fn_subscription_booking_prepare.js";
const FINALIZE_SOURCE = "scripts/nodered_subscription_booking_nodes/fn_subscription_booking_finalize.js";
const SPLIT_ROUTER_SOURCE = "scripts/nodered_games_nodes/fn_split_router.js";
const SPLIT_CREATE_PREPARE_SOURCE = "scripts/nodered_games_nodes/fn_split_create_prepare.js";
const SPLIT_JOIN_PREPARE_SOURCE = "scripts/nodered_games_nodes/fn_split_join_prepare.js";
const OFFLINE_GENERATOR = "scripts/generate_lk1_subscription_dev_offline_source.mjs";
const isTemporaryChild = (candidate) => (
  candidate.startsWith("/private/tmp/") || candidate.startsWith("/tmp/")
);
const OFFLINE_SOURCE_INPUTS = Object.freeze([
  ROUTER_SOURCE,
  PREPARE_SOURCE,
  FINALIZE_SOURCE,
  "scripts/nodered_subscription_booking_nodes/fn_managed_subscription_policy_evaluate.js",
  "scripts/nodered_subscription_booking_nodes/fn_managed_subscription_policy_blocked.js",
  "scripts/nodered_subscription_booking_nodes/fn_subscription_booking_mongo_error.js",
  "scripts/nodered_subscription_booking_nodes/fn_subscription_booking_options.js",
  SPLIT_ROUTER_SOURCE,
  SPLIT_CREATE_PREPARE_SOURCE,
  SPLIT_JOIN_PREPARE_SOURCE,
].sort());
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
export const CHECKED_DEV_CANDIDATE_BINDING = Object.freeze(JSON.parse(fs.readFileSync(
  new URL("./lk1_subscription_dev_candidate_binding.json", import.meta.url),
  "utf8",
)));
export const CHECKED_DEV_SOURCE_AUTHORIZATION = Object.freeze(JSON.parse(fs.readFileSync(
  new URL("./lk1_subscription_dev_source_authorization.json", import.meta.url),
  "utf8",
)));

export function validateDevSourceAuthorization(authorization, binding, candidateIdentity = null) {
  const expectedFiles = [
    "scripts/generate_lk1_subscription_dev_offline_source.mjs",
    "scripts/inspect_lk1_subscription_dev_snapshot.mjs",
    "scripts/lk1_subscription_dev_execution_contract.mjs",
    "scripts/prepare_lk1_subscription_dev_candidate.mjs",
    "scripts/lk1_subscription_dev_candidate_binding.json",
    "scripts/lk1_subscription_dev_provisioning_contract.json",
    "scripts/validate_lk1_subscription_dev_provisioning_contract.mjs",
    "scripts/lk1_subscription_runtime_environment_bindings.json",
  ].sort();
  const expectedKeys = [
    "formatVersion", "environment", "authorizationState", "scope", "filesSha256",
    "sourceCommit", "sourceInputsSha256", "sourceSha256", "sourceNodeInventorySha256",
    "executionFunctionNodePreimagesSha256", "candidateSha256", "manifestSha256",
  ].sort();
  const executionPreimages = Object.fromEntries(
    (binding.dependencies?.executionFunctionPreimages || []).map(({ id, nodeSha256 }) => [id, nodeSha256]),
  );
  if (JSON.stringify(Object.keys(authorization || {}).sort()) !== JSON.stringify(expectedKeys)
    || authorization.formatVersion !== 1
    || authorization.environment !== "DEV"
    || authorization.authorizationState !== "AUTHORIZED_SOURCE_ONLY"
    || authorization.scope !== "BUILD_OFFLINE_CANDIDATE_ONLY"
    || authorization.sourceCommit !== binding.source.sourceCommit
    || JSON.stringify(Object.keys(authorization.filesSha256 || {}).sort()) !== JSON.stringify(expectedFiles)
    || Object.entries(authorization.filesSha256 || {}).some(([file, expected]) => (
      !/^[a-f0-9]{64}$/.test(expected || "")
      || sha256(fs.readFileSync(path.join(REPO_ROOT, file))) !== expected
    ))
    || JSON.stringify(authorization.sourceInputsSha256) !== JSON.stringify(binding.source.sourceInputsSha256)
    || authorization.sourceSha256 !== binding.source.sourceSha256
    || authorization.sourceNodeInventorySha256 !== binding.source.sourceNodeInventorySha256
    || JSON.stringify(authorization.executionFunctionNodePreimagesSha256)
      !== JSON.stringify(executionPreimages)
    || !/^[a-f0-9]{64}$/.test(authorization.candidateSha256 || "")
    || !/^[a-f0-9]{64}$/.test(authorization.manifestSha256 || "")) {
    fail("DEV source-only authorization contract mismatch");
  }
  for (const [file, expected] of Object.entries(authorization.sourceInputsSha256)) {
    let committed;
    try {
      committed = execFileSync("git", ["show", `${authorization.sourceCommit}:${file}`], {
        cwd: REPO_ROOT,
        stdio: ["ignore", "pipe", "pipe"],
      });
    } catch {
      fail(`DEV exact-main source input is unavailable (${file})`);
    }
    if (sha256(committed) !== expected) fail(`DEV exact-main source input digest mismatch (${file})`);
  }
  if (candidateIdentity && (
    candidateIdentity.candidateSha256 !== authorization.candidateSha256
    || candidateIdentity.manifestSha256 !== authorization.manifestSha256
  )) fail("DEV source-only candidate identity diverges from authorization");
  return true;
}

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

export function validateDevEndpointBindings(endpoints, trustedBindings = LK1_SUBSCRIPTION_RUNTIME_ENVIRONMENT_BINDINGS) {
  const expectedKeys = ["cupApiBase", "vivaApiBase", "serv2Base", "tokenUrl"].sort();
  if (JSON.stringify(Object.keys(endpoints || {}).sort()) !== JSON.stringify(expectedKeys)) {
    fail("DEV endpoint bindings do not match the approved schema");
  }
  const expected = {
    cupApiBase: "https://127.0.0.1:3037/api",
    vivaApiBase: "https://127.0.0.1:3038",
    serv2Base: "https://127.0.0.1:3038/serv2",
    tokenUrl: "https://127.0.0.1:3039/realms/dev/protocol/openid-connect/token",
  };
  for (const [key, value] of Object.entries(expected)) {
    if (endpoints[key] !== value) fail(`DEV ${key} is not the exact fixture binding`);
    const parsed = new URL(endpoints[key]);
    if (parsed.protocol !== "https:" || parsed.hostname !== "127.0.0.1"
      || parsed.username || parsed.password || parsed.search || parsed.hash) {
      fail(`DEV ${key} is not an isolated loopback URL`);
    }
  }
  if (JSON.stringify(endpoints) !== JSON.stringify(trustedBindings.DEV_ENDPOINTS)) {
    fail("DEV endpoint bindings diverge from the trusted source-only contract");
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

const exactTarget = (flow, tabs, target, idField, nameField, preimageField, nodePreimageField) => {
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
  if (sha256(JSON.stringify(node)) !== target[nodePreimageField]) {
    fail(`DEV target ${target[idField]} whole-node preimage mismatch`);
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
  const transportMarkers = [
    '  const transportAllowed = identity.environment === "PROD"\n    ? parsed.protocol === "https:"\n    : parsed.protocol === "http:" && parsed.hostname === "127.0.0.1";',
    '  const transportAllowed = environment === "PROD"\n    ? parsed.protocol === "https:"\n    : parsed.protocol === "http:" && parsed.hostname === "127.0.0.1";',
  ];
  for (const marker of [devMarker, prodMarker, environmentMarker]) {
    if (!source.includes(marker) || source.indexOf(marker) !== source.lastIndexOf(marker)) {
      fail("DEV runtime environment binding marker mismatch");
    }
  }
  const matchedTransportMarkers = transportMarkers.filter((marker) => source.includes(marker));
  if (matchedTransportMarkers.length !== 1) {
    fail("DEV runtime HTTPS transport marker mismatch");
  }
  const devBound = source
    .replace(prodMarker, "  PROD: null,")
    .replace(devMarker, `  DEV: ${JSON.stringify(apiBase)},`)
    .replace(environmentMarker, 'const MANAGED_RUNTIME_EXPECTED_ENVIRONMENT = "DEV";')
    .replace(matchedTransportMarkers[0], '  const transportAllowed = parsed.protocol === "https:";');
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
    next = replaceExactMarker(next,
      'msg.url = readEnv("VIVA_SERVICE_TOKEN_URL") || TOKEN_URL_DEFAULT;',
      "msg.url = TOKEN_URL_DEFAULT;",
      "Split-prepare token override");
    next = replaceExactMarker(next,
      '  successUrl: toStr(body.successUrl) || toStr(body.baseRedirectUrl),',
      "  successUrl: null,",
      "Split-prepare browser success URL");
    return replaceExactMarker(next,
      '  failUrl: toStr(body.failUrl) || toStr(body.baseRedirectUrl),',
      "  failUrl: null,",
      "Split-prepare browser failure URL");
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

const assertDevMongoCustody = (flow, router, dependencies, trustedBindings) => {
  if (flow.filter((node) => node?.type === "mongodb4-client").length !== 1
    || flow.some((node) => node?.type === "mongodb")) {
    fail("DEV managed Mongo client inventory must be exactly one fixture client");
  }
  const claimedClient = dependencies?.managedMongoClient;
  const clients = flow.filter((node) => node?.type === "mongodb4-client"
    && node.id === claimedClient?.id);
  if (clients.length !== 1) fail("DEV managed mongodb4-client identity is absent or ambiguous");
  const identity = effectiveMongoIdentity(clients[0]);
  const expected = trustedBindings.DEV_MONGO;
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
  const expectedEdges = MANAGED_MONGO_SPECS.map((spec) => `${router.id}:${spec.routerOutputIndex}:${spec.id}`).sort();
  const actualEdges = flow.flatMap((node) => (node.wires || []).flatMap((targets, index) => (
    targets.filter((id) => MANAGED_MONGO_SPECS.some((spec) => spec.id === id))
      .map((id) => `${node.id}:${index}:${id}`)
  ))).sort();
  if (flow.filter((node) => node.type === "mongodb4").length !== MANAGED_MONGO_SPECS.length
    || JSON.stringify(expectedEdges) !== JSON.stringify(actualEdges)) {
    fail("DEV managed Mongo wiring mismatch (operation inventory or inbound edges)");
  }
  for (const spec of MANAGED_MONGO_SPECS) {
    const claim = claims.find((item) => item.id === spec.id);
    const nodes = flow.filter((node) => node?.id === spec.id && node?.type === "mongodb4");
    const node = nodes.length === 1 ? nodes[0] : null;
    if (!claim || !node || claim.operation !== spec.operation
      || claim.routerOutputIndex !== spec.routerOutputIndex
      || node.operation !== spec.operation || node.collection !== "lk_subscription_daily_booking_ops"
      || node.mode !== "collection" || node.output !== "toArray"
      || node.maxTimeMS !== "5000" || node.handleDocId !== false
      || node.clientNode !== clients[0].id
      || JSON.stringify(router.wires?.[spec.routerOutputIndex]) !== JSON.stringify([spec.id])
      || JSON.stringify(node.wires) !== JSON.stringify([[router.id]])
      || claim.wiredFromRouter !== true || claim.returnsToRouter !== true
      || claim.clientNode !== clients[0].id || claim.collection !== "lk_subscription_daily_booking_ops"
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
    || !hasSafeDevHttpSemantics(http)
    || JSON.stringify(http.wires) !== JSON.stringify([[router.id]])
    || JSON.stringify(router.wires?.[0]) !== JSON.stringify([HTTP_REQUEST_NODE_ID])
    || JSON.stringify(prepare.wires?.[0]) !== JSON.stringify([HTTP_REQUEST_NODE_ID])
    || JSON.stringify(splitRouter.wires?.[0]) !== JSON.stringify([SPLIT_CREATE_HTTP_REQUEST_NODE_ID])
    || JSON.stringify(splitRouter.wires?.[3]) !== JSON.stringify([HTTP_REQUEST_NODE_ID])
    || dependencies?.httpRequestBindingVerified !== true
    || dependencies?.httpRequestPreimageSha256 !== sha256(JSON.stringify(http))
    || !hasSafeDevHttpSemantics(splitCreateHttp)
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
  if (provisioningContract.contractState !== "STOPPED_BOOTSTRAP_AUTHORIZED"
    || provisioningContract.bootstrapInstallAllowed !== true
    || provisioningContract.candidateBuildAllowed !== false
    || provisioningContract.executionAuthorized !== false
    || provisioningContract.installAllowed !== false
    || provisioningContract.serviceStartAllowed !== false
    || provisioningContract.ingressAllowed !== false
    || provisioningContract.activationAllowed !== false) {
    fail("Provisioning contract is not the exact stopped, non-runtime prerequisite");
  }
  if (binding.bindingState !== "BOUND_SOURCE_ONLY" || binding.installAllowed !== false) {
    fail(`DEV candidate binding is blocked (${binding?.bindingState || "missing"})`);
  }
  if (binding.environmentIdentityVerified !== false) {
    fail("Source-only DEV binding must not claim verified runtime identity");
  }
  const plannedTarget = provisioningContract.plannedTarget;
  if (trustedBindings?.DEV_INSTALL_TARGET?.sourceHost !== plannedTarget.sourceHost
    || trustedBindings?.DEV_INSTALL_TARGET?.sourceHostname !== plannedTarget.sourceHostname
    || trustedBindings?.DEV_INSTALL_TARGET?.serviceName !== plannedTarget.serviceName
    || trustedBindings?.DEV_INSTALL_TARGET?.unixUser !== plannedTarget.unixUser
    || trustedBindings?.DEV_INSTALL_TARGET?.userDir !== plannedTarget.userDir
    || trustedBindings?.DEV_INSTALL_TARGET?.remoteFlowPath !== plannedTarget.flowPath) {
    fail("Trusted DEV install target diverges from the provisioning contract");
  }
  const source = binding.source;
  const sourceKeys = [
    "sourceKind", "sourceCommit", "generatorPath", "generatorSha256", "sourceInputsSha256",
    "sourceSha256", "sourceNodeInventorySha256", "nodeCount", "httpRouteCount", "tabCount",
    "brokenWires", "brokenLinks",
  ].sort();
  if (JSON.stringify(Object.keys(source || {}).sort()) !== JSON.stringify(sourceKeys)
    || source.sourceKind !== "offline-dedicated-dev-bootstrap"
    || !/^[a-f0-9]{40}$/.test(source.sourceCommit || "")
    || source.generatorPath !== OFFLINE_GENERATOR
    || !/^[a-f0-9]{64}$/.test(source.generatorSha256 || "")
    || JSON.stringify(Object.keys(source.sourceInputsSha256 || {}).sort())
      !== JSON.stringify(OFFLINE_SOURCE_INPUTS)
    || Object.values(source.sourceInputsSha256 || {})
      .some((value) => !/^[a-f0-9]{64}$/.test(value || ""))
    || !/^[a-f0-9]{64}$/.test(source.sourceSha256 || "")
    || !/^[a-f0-9]{64}$/.test(source.sourceNodeInventorySha256 || "")
    || ![source.nodeCount, source.httpRouteCount, source.tabCount,
      source.brokenWires, source.brokenLinks].every(Number.isInteger)
    || source.nodeCount < 1 || source.httpRouteCount !== 2 || source.tabCount !== 1
    || source.brokenWires !== 0 || source.brokenLinks !== 0) {
    fail("DEV offline source provenance mismatch");
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
  if (binding.runtime?.completeCupManagedContractSourceImplemented !== true
    || binding.runtime.localPhysicalVerified !== true
    || binding.runtime.hostRuntimeExposed !== false
    || binding.runtime.completeManagedContractExposed !== false
    || binding.runtime.networkIsolationRuntimeVerified !== false
    || binding.runtime.serviceStartBlocked !== true
    || binding.runtime.serviceStartBlocker !== "NON_LOOPBACK_EGRESS_ENFORCEMENT_NOT_VERIFIED"
    || binding.runtime.reason
      !== "Source implemented and locally loopback-verified; DEV services remain stopped and host runtime was not exercised") {
    fail("Source-only DEV binding must distinguish local physical proof from host runtime exposure");
  }
  if (trustedBindings?.DEV !== null
    || trustedBindings?.devBindingState !== "UNBOUND_RUNTIME_STOPPED") {
    fail("Trusted DEV runtime binding must remain unbound while services are stopped");
  }
  if (trustedBindings.DEV_CANDIDATE_API_BASE !== trustedBindings.DEV_ENDPOINTS?.cupApiBase) {
    fail("DEV candidate and CUP fixture bindings diverge");
  }
  validateEnvironmentApiBase(
    "DEV", binding.runtime.apiBase, trustedBindings.DEV_CANDIDATE_API_BASE,
  );
  validateDevEndpointBindings(trustedBindings.DEV_ENDPOINTS, trustedBindings);
  validateDevInstallTarget(binding.installTarget, trustedBindings);
  if (binding.candidateSha256 !== null
    || binding.productionBindingState !== "UNBOUND_AFTER_ROUTER_AMENDMENT") {
    fail("Source-only DEV binding must remain unpublished and production-unbound");
  }
  return true;
}

export function buildDevCandidate(sourceText, binding, readSource = readRepositorySource,
  trustedBindings = LK1_SUBSCRIPTION_RUNTIME_ENVIRONMENT_BINDINGS,
  provisioningContract = checkedProvisioningContract) {
  validateDevBinding(binding, trustedBindings, provisioningContract);
  if (sha256(sourceText) !== binding.source.sourceSha256) fail("DEV source SHA mismatch");
  const flow = JSON.parse(sourceText);
  if (!hasUniqueFlowIds(flow)) fail("DEV source has missing or duplicate node IDs");
  const sourceNodesById = new Map(flow.map((node) => [node.id, structuredClone(node)]));
  const sourceNodeInventorySha256 = sha256(JSON.stringify(flow
    .map((node) => ({ id: node.id, sha256: sha256(JSON.stringify(node)) }))
    .sort((left, right) => left.id.localeCompare(right.id))));
  if (sourceNodeInventorySha256 !== binding.source.sourceNodeInventorySha256) {
    fail("DEV source node inventory SHA mismatch");
  }
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
  const sourceIsolation = deriveDevWholeFlowIsolation(flow, binding.target);
  const executionFunctionPreimages = sourceIsolation.reachableFunctionIds?.map((id) => ({
    id,
    nodeSha256: sha256(JSON.stringify(sourceNodesById.get(id))),
  })) || [];
  if (!sourceIsolation.verified
    || binding.dependencies?.wholeFlowIsolationVerified !== true
    || JSON.stringify(binding.dependencies?.executionFunctionPreimages)
      !== JSON.stringify(executionFunctionPreimages)) {
    fail(`DEV source contains a non-isolated node capability (${sourceIsolation.violations.join(",")})`);
  }
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
    "routerNodeId", "routerNodeName", "routerPreimageSha256", "routerNodePreimageSha256");
  const prepare = exactTarget(flow, tabs, binding.target,
    "prepareNodeId", "prepareNodeName", "preparePreimageSha256", "prepareNodePreimageSha256");
  const splitRouter = exactTarget(flow, tabs, binding.target,
    "splitRouterNodeId", "splitRouterNodeName", "splitRouterPreimageSha256", "splitRouterNodePreimageSha256");
  const splitCreatePrepare = exactTarget(flow, tabs, binding.target,
    "splitCreatePrepareNodeId", "splitCreatePrepareNodeName", "splitCreatePreparePreimageSha256", "splitCreatePrepareNodePreimageSha256");
  const splitJoinPrepare = exactTarget(flow, tabs, binding.target,
    "splitJoinPrepareNodeId", "splitJoinPrepareNodeName", "splitJoinPreparePreimageSha256", "splitJoinPrepareNodePreimageSha256");
  const finalize = exactTarget(flow, tabs, binding.target,
    "finalizeNodeId", "finalizeNodeName", "finalizePreimageSha256", "finalizeNodePreimageSha256");
  assertDevHttpCustody(
    flow, router, prepare, splitRouter, splitCreatePrepare, splitJoinPrepare, binding.dependencies,
  );
  assertDevMongoCustody(flow, router, binding.dependencies, trustedBindings);
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
  if (!deriveDevWholeFlowIsolation(flow, binding.target).verified) {
    fail("DEV candidate contains a non-isolated node capability");
  }
  const candidateEndpointAudit = deriveEndpointAudit(flow, allowedOrigins);
  if (!candidateEndpointAudit.verifiedDevOnly
    || candidateEndpointAudit.crossEnvironmentEndpointCount !== 0) {
    fail("DEV candidate contains a cross-environment network endpoint");
  }
  const candidateText = `${JSON.stringify(flow, null, 2)}\n`;
  const candidateSha256 = sha256(candidateText);
  const allowedChangedIds = new Set([
    router.id, prepare.id, splitRouter.id, splitCreatePrepare.id, splitJoinPrepare.id, finalize.id,
  ]);
  const changedNodes = flow.flatMap((node) => {
    const before = sourceNodesById.get(node.id);
    if (JSON.stringify(before) === JSON.stringify(node)) return [];
    const changedFields = [...new Set([
      ...Object.keys(before || {}), ...Object.keys(node || {}),
    ])].filter((key) => JSON.stringify(before?.[key]) !== JSON.stringify(node?.[key])).sort();
    if (!allowedChangedIds.has(node.id) || JSON.stringify(changedFields) !== JSON.stringify(["func"])) {
      fail(`DEV candidate contains an unexpected changed node or field (${node.id}:${changedFields.join(",")})`);
    }
    return [{
      id: node.id,
      changedFields,
      sourceNodeSha256: sha256(JSON.stringify(before)),
      candidateNodeSha256: sha256(JSON.stringify(node)),
    }];
  }).sort((left, right) => left.id.localeCompare(right.id));
  if (changedNodes.length === 0) fail("DEV candidate contains no reviewed function change");
  const candidateNodeInventorySha256 = sha256(JSON.stringify(flow
    .map((node) => ({ id: node.id, sha256: sha256(JSON.stringify(node)) }))
    .sort((left, right) => left.id.localeCompare(right.id))));
  return {
    candidate: flow,
    candidateText,
    manifest: {
      formatVersion: 1,
      environment: "DEV",
      sourceCommit: binding.source.sourceCommit,
      sourceSha256: binding.source.sourceSha256,
      sourceNodeInventorySha256: binding.source.sourceNodeInventorySha256,
      candidateSha256,
      sourceProvenance: "OFFLINE_GENERATED",
      hostPreimage: {
        state: "ABSENT",
        sha256: null,
      },
      rollback: {
        mode: "RETURN_TO_ABSENT",
        restoreSha256: null,
        preserveEvidence: true,
        deleteData: false,
        requiresSeparateAuthorization: true,
      },
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
      changedNodeIds: changedNodes.map((node) => node.id),
      changedNodes,
      candidateNodeInventorySha256,
      installAuthorization: {
        authorized: false,
        candidateSha256,
        targetHost: binding.installTarget.sourceHost,
        targetServiceName: binding.installTarget.serviceName,
        targetFlowPath: binding.installTarget.remoteFlowPath,
      },
      endpointOrigins: [...allowedOrigins].sort(),
      mongoClientPreimageSha256: binding.dependencies.managedMongoClient.preimageSha256,
      productionBindingState: "UNBOUND_AFTER_ROUTER_AMENDMENT",
    },
  };
}

export function publishDevCandidate(workspace, binding, options = {}) {
  if (Object.keys(options).length !== 0) {
    fail("DEV candidate publisher does not accept authority overrides");
  }
  const provisioningContract = checkedProvisioningContract;
  const checkedBinding = CHECKED_DEV_CANDIDATE_BINDING;
  const sourceAuthorization = CHECKED_DEV_SOURCE_AUTHORIZATION;
  validateDevProvisioningContract(provisioningContract);
  const resolvedWorkspace = fs.realpathSync(path.resolve(workspace));
  if (!isTemporaryChild(resolvedWorkspace)) {
    fail("DEV candidate workspace must be under /private/tmp or /tmp");
  }
  const sourcePath = path.join(resolvedWorkspace, "input/source.flow.json");
  const metaPath = path.join(resolvedWorkspace, "input/source.flow.meta.json");
  const credentialStorePath = path.join(resolvedWorkspace, "input/source.flow.credentials.json");
  for (const inputPath of [sourcePath, metaPath, credentialStorePath]) {
    const stat = fs.lstatSync(inputPath);
    if (!stat.isFile() || stat.isSymbolicLink()
      || fs.realpathSync(inputPath) !== inputPath) {
      fail("DEV candidate input must be a canonical regular file");
    }
  }
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
  if (JSON.stringify(binding) !== JSON.stringify(checkedBinding)
    || JSON.stringify(binding) !== JSON.stringify(snapshot)) {
    fail("DEV snapshot metadata does not match the frozen binding");
  }
  validateDevSourceAuthorization(sourceAuthorization, binding);
  const generatorPath = path.join(REPO_ROOT, binding.source.generatorPath);
  if (sha256(fs.readFileSync(generatorPath)) !== binding.source.generatorSha256) {
    fail("DEV offline generator digest mismatch");
  }
  for (const [file, expectedSha256] of Object.entries(binding.source.sourceInputsSha256)) {
    if (sha256(fs.readFileSync(path.join(REPO_ROOT, file))) !== expectedSha256) {
      fail(`DEV offline source input digest mismatch (${file})`);
    }
  }
  const result = buildDevCandidate(
    fs.readFileSync(sourcePath, "utf8"),
    binding,
    readRepositorySource,
    LK1_SUBSCRIPTION_RUNTIME_ENVIRONMENT_BINDINGS,
    provisioningContract,
  );
  const buildDirectory = path.join(resolvedWorkspace, "build");
  if (fs.existsSync(buildDirectory)) fail("Refusing to overwrite an existing DEV candidate build");
  const publishedManifest = { ...result.manifest };
  const manifestText = `${JSON.stringify(publishedManifest, null, 2)}\n`;
  const manifestSha256 = sha256(manifestText);
  validateDevSourceAuthorization(sourceAuthorization, binding, {
    candidateSha256: result.manifest.candidateSha256,
    manifestSha256,
  });
  const stagingDirectory = fs.mkdtempSync(path.join(resolvedWorkspace, ".build-stage-"));
  try {
    fs.chmodSync(stagingDirectory, 0o700);
    const stagedCandidatePath = path.join(stagingDirectory, "lk1-subscription-dev.candidate.json");
    const stagedManifestPath = path.join(stagingDirectory, "lk1-subscription-dev.manifest.json");
    const stagedReadyPath = path.join(stagingDirectory, "lk1-subscription-dev.ready.json");
    fs.writeFileSync(stagedCandidatePath, result.candidateText, { encoding: "utf8", mode: 0o600, flag: "wx" });
    fs.writeFileSync(stagedManifestPath, manifestText, { encoding: "utf8", mode: 0o600, flag: "wx" });
    fs.writeFileSync(stagedReadyPath, `${JSON.stringify({
      formatVersion: 1,
      environment: "DEV",
      sourceProvenance: "OFFLINE_GENERATED",
      sourceCommit: binding.source.sourceCommit,
      sourceSha256: binding.source.sourceSha256,
      sourceNodeInventorySha256: binding.source.sourceNodeInventorySha256,
      candidateSha256: result.manifest.candidateSha256,
      candidateNodeInventorySha256: result.manifest.candidateNodeInventorySha256,
      manifestSha256,
      hostPreimageState: "ABSENT",
      hostReadbackSha256: null,
      installAuthorized: false,
    }, null, 2)}\n`, { encoding: "utf8", mode: 0o600, flag: "wx" });
    fs.renameSync(stagingDirectory, buildDirectory);
  } catch (error) {
    fs.rmSync(stagingDirectory, { recursive: true, force: true });
    throw error;
  }
  const candidatePath = path.join(buildDirectory, "lk1-subscription-dev.candidate.json");
  const manifestPath = path.join(buildDirectory, "lk1-subscription-dev.manifest.json");
  const readyPath = path.join(buildDirectory, "lk1-subscription-dev.ready.json");
  return { ...result, manifest: publishedManifest, candidatePath, manifestPath, readyPath, manifestSha256 };
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
    || !/^[a-f0-9]{64}$/.test(manifest.candidateSha256 || "")
    || manifest.hostPreimage?.state !== "ABSENT"
    || manifest.hostPreimage?.sha256 !== null
    || manifest.rollback?.mode !== "RETURN_TO_ABSENT"
    || manifest.rollback?.restoreSha256 !== null
    || manifest.rollback?.preserveEvidence !== true
    || manifest.rollback?.deleteData !== false
    || manifest.rollback?.requiresSeparateAuthorization !== true
    || !Array.isArray(manifest.changedNodeIds) || manifest.changedNodeIds.length < 1
    || new Set(manifest.changedNodeIds).size !== manifest.changedNodeIds.length
    || !Array.isArray(manifest.changedNodes)
    || JSON.stringify(manifest.changedNodeIds) !== JSON.stringify(manifest.changedNodes.map((node) => node.id))
    || manifest.changedNodes.some((node) => (
      JSON.stringify(node.changedFields) !== JSON.stringify(["func"])
      || !/^[a-f0-9]{64}$/.test(node.sourceNodeSha256 || "")
      || !/^[a-f0-9]{64}$/.test(node.candidateNodeSha256 || "")
    ))
    || !/^[a-f0-9]{64}$/.test(manifest.candidateNodeInventorySha256 || "")
    || manifest.installAuthorization?.authorized !== true
    || manifest.installAuthorization?.candidateSha256 !== manifest.candidateSha256
    || manifest.installAuthorization?.targetHost !== target.sourceHost
    || manifest.installAuthorization?.targetServiceName !== target.serviceName
    || manifest.installAuthorization?.targetFlowPath !== target.remoteFlowPath) {
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
  process.stdout.write(`manifestSha256=${result.manifestSha256}\n`);
  process.stdout.write(`readyPath=${result.readyPath}\n`);
}
