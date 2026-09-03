#!/usr/bin/env node

import crypto from "node:crypto";
import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROLE_PORTS = Object.freeze({ cup: 3037, provider: 3038, identity: 3039 });
const LOOPBACK = "127.0.0.1";
const AUTHORIZATION_MARKER = "/srv/lk1-subscription-dev/authorization/service-start.approved";
const CONFIG_ENV = "LK1_SUBSCRIPTION_DEV_FIXTURE_CONFIG_FILE";
const SAFE_ID = /^fixture-[a-z0-9][a-z0-9-]{2,95}$/;
const SAFE_FIXTURE_SECRET = /^fixture-[a-z0-9][a-z0-9-]{23,127}$/;
const SHA256 = /^[a-f0-9]{64}$/;
const RELEASE_SHA = /^[a-f0-9]{40}$/;
const RUN_SCOPE = /^subscription-sale-period:\d{8}T\d{9}Z:(A|B)$/;
const METRIC_KEYS = Object.freeze([
  "entitlementAggregateRevision", "dailyUsage", "activeUsage", "operations",
  "ledgerEntries", "outboxEntries", "testerGames", "providerWriteCounter",
  "paymentWriteCounter", "entitlementMutationCounter", "rollbackWriteCounter",
  "orphanReserves", "fallbackCounter", "productionCupCalls", "unrelatedUserChanges",
]);

export class FixtureRuntimeError extends Error {
  constructor(code, message, statusCode = 500) {
    super(message);
    this.code = code;
    this.statusCode = statusCode;
  }
}

const fail = (code, message, statusCode = 500) => {
  throw new FixtureRuntimeError(code, message, statusCode);
};
const isObject = (value) => Boolean(value) && typeof value === "object" && !Array.isArray(value);
const exactKeys = (value, expected, label) => {
  if (!isObject(value)
    || JSON.stringify(Object.keys(value).sort()) !== JSON.stringify([...expected].sort())) {
    fail("FIXTURE_CONFIG_SCHEMA_INVALID", `${label} fields are not exact`);
  }
};
const cleanText = (value) => typeof value === "string" ? value.trim() : "";
const jsonClone = (value) => JSON.parse(JSON.stringify(value));
const exactRelease = (value, label) => {
  exactKeys(value, ["sourceSha", "candidateSha", "readbackSha", "servedSha"], label);
  if (!Object.values(value).every((item) => RELEASE_SHA.test(cleanText(item)))) {
    fail("FIXTURE_RELEASE_INVALID", `${label} is not an exact four-SHA release identity`);
  }
};
const exactInstant = (value) => {
  if (typeof value !== "string"
    || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?(?:Z|[+-]\d{2}:\d{2})$/.test(value)) return false;
  return Number.isFinite(Date.parse(value));
};
const hashSecret = (value) => crypto.createHash("sha256").update(value).digest();
const sameSecret = (left, right) => {
  if (!cleanText(left) || !cleanText(right)) return false;
  const a = hashSecret(left);
  const b = hashSecret(right);
  return crypto.timingSafeEqual(a, b);
};
const evidenceHmac = (value, key) => crypto.createHmac("sha256", key)
  .update(JSON.stringify(value)).digest("hex");

function validatePublicationHistory(publications, subscriptionTypeId) {
  if (!Array.isArray(publications) || publications.length !== 2) {
    fail("FIXTURE_PUBLICATIONS_INVALID", "Fixture requires exactly V1 and V2 publications");
  }
  const rows = publications.map((row) => {
    exactKeys(row, ["version", "subscriptionTypeId", "effectiveAt", "status", "policyDigest"], "publication");
    if (![1, 2].includes(row.version) || row.subscriptionTypeId !== subscriptionTypeId
      || !exactInstant(row.effectiveAt) || !["SUPERSEDED", "PUBLISHED"].includes(row.status)
      || !SHA256.test(row.policyDigest)) {
      fail("FIXTURE_PUBLICATIONS_INVALID", "Publication history is not immutable V1/V2 evidence");
    }
    return row;
  });
  if (rows[0].version !== 1 || rows[1].version !== 2
    || Date.parse(rows[0].effectiveAt) >= Date.parse(rows[1].effectiveAt)) {
    fail("FIXTURE_PUBLICATIONS_INVALID", "Publication history is not monotonic");
  }
}

function validateSubject(subject, role, config) {
  exactKeys(subject, [
    "clientSubscriptionId", "subscriptionInstanceId", "auth", "authoritativePurchasedAt",
    "policyVersion", "policyDigest", "instanceRevision", "instanceState", "canaryAllowed",
  ], `subject ${role}`);
  if (!SAFE_ID.test(subject.clientSubscriptionId) || !SAFE_ID.test(subject.subscriptionInstanceId)
    || !SAFE_FIXTURE_SECRET.test(cleanText(subject.auth)) || !exactInstant(subject.authoritativePurchasedAt)
    || ![1, 2].includes(subject.policyVersion) || !SHA256.test(subject.policyDigest)
    || !Number.isSafeInteger(subject.instanceRevision) || subject.instanceRevision < 0
    || !["ACTIVE", "PENDING_ACTIVATION"].includes(subject.instanceState)
    || typeof subject.canaryAllowed !== "boolean") {
    fail("FIXTURE_SUBJECT_INVALID", `Subject ${role} is incomplete or not fixture-scoped`);
  }
  const publication = config.publications.find((row) => row.version === subject.policyVersion);
  if (!publication || publication.policyDigest !== subject.policyDigest) {
    fail("FIXTURE_SUBJECT_INVALID", `Subject ${role} policy pin is inconsistent`);
  }
}

export function validateFixtureConfig(config) {
  exactKeys(config, [
    "schemaVersion", "environment", "tenantId", "productId", "subscriptionTypeId",
    "integrationToken", "cupRelease", "managedRange", "publications", "subjects",
  ], "fixture config");
  if (config.schemaVersion !== 1 || config.environment !== "DEV"
    || !SAFE_ID.test(config.tenantId) || !SAFE_ID.test(config.productId)
    || !SAFE_ID.test(config.subscriptionTypeId)
    || !SAFE_FIXTURE_SECRET.test(cleanText(config.integrationToken))) {
    fail("FIXTURE_CONFIG_INVALID", "Fixture config must be exact, DEV, and fixture-scoped");
  }
  exactRelease(config.cupRelease, "CUP release");
  exactKeys(config.managedRange, ["startsAt", "endsAt"], "managed range");
  if (!exactInstant(config.managedRange.startsAt) || !exactInstant(config.managedRange.endsAt)
    || Date.parse(config.managedRange.startsAt) > Date.parse(config.managedRange.endsAt)) {
    fail("FIXTURE_RANGE_INVALID", "Managed range is invalid");
  }
  validatePublicationHistory(config.publications, config.subscriptionTypeId);
  exactKeys(config.subjects, ["A", "B", "CONTROL"], "subjects");
  for (const role of ["A", "B", "CONTROL"]) validateSubject(config.subjects[role], role, config);
  const subjects = Object.values(config.subjects);
  const rangeStart = Date.parse(config.managedRange.startsAt);
  const rangeEnd = Date.parse(config.managedRange.endsAt);
  const subjectDates = subjects.map((row) => Date.parse(row.authoritativePurchasedAt));
  if (new Set(subjects.map((row) => row.clientSubscriptionId)).size !== 3
    || new Set(subjects.map((row) => row.subscriptionInstanceId)).size !== 3
    || new Set(subjects.map((row) => row.auth)).size !== 3
    || subjects.some((row) => sameSecret(row.auth, config.integrationToken))
    || subjectDates.some((value) => value < rangeStart || value > rangeEnd)
    || config.subjects.A.policyVersion !== 1 || config.subjects.B.policyVersion !== 2
    || config.subjects.A.canaryAllowed !== true || config.subjects.B.canaryAllowed !== true
    || config.subjects.CONTROL.canaryAllowed !== false
    || Date.parse(config.subjects.A.authoritativePurchasedAt) >= Date.parse(config.publications[1].effectiveAt)
    || Date.parse(config.subjects.B.authoritativePurchasedAt) < Date.parse(config.publications[1].effectiveAt)) {
    fail("FIXTURE_SUBJECT_SET_INVALID", "Fixture subjects do not prove exact A=V1/B=V2/control boundaries");
  }
  return true;
}

export function loadFixtureConfig(filePath) {
  const lexical = path.resolve(filePath);
  const lexicalStat = fs.lstatSync(lexical);
  const resolved = fs.realpathSync(lexical);
  const stat = fs.lstatSync(resolved);
  if (lexicalStat.isSymbolicLink() || resolved !== lexical || !stat.isFile()
    || stat.isSymbolicLink() || (stat.mode & 0o077) !== 0) {
    fail("FIXTURE_CONFIG_CUSTODY_INVALID", "Fixture config must be a regular private file", 78);
  }
  const config = JSON.parse(fs.readFileSync(resolved, "utf8"));
  validateFixtureConfig(config);
  return config;
}

function findSubject(config, clientSubscriptionId) {
  return Object.entries(config.subjects)
    .find(([, subject]) => subject.clientSubscriptionId === clientSubscriptionId);
}

function requireReadAuthorization(config, request, allowedBodyKeys, allowControl = true) {
  if (!isObject(request.body)
    || JSON.stringify(Object.keys(request.body).sort()) !== JSON.stringify([...allowedBodyKeys].sort())) {
    fail("FIXTURE_REQUEST_INVALID", "Read request body is not exact", 400);
  }
  if (!sameSecret(request.headers["x-subscriptions-integration-token"], config.integrationToken)) {
    fail("FIXTURE_INTEGRATION_AUTH_INVALID", "Integration authentication failed", 401);
  }
  const found = findSubject(config, cleanText(request.body.clientSubscriptionId));
  if (!found || (!allowControl && found[0] === "CONTROL")) {
    fail("FIXTURE_SUBJECT_NOT_FOUND", "Fixture subject is unavailable", 404);
  }
  if (!sameSecret(request.headers.authorization, found[1].auth)) {
    fail("FIXTURE_SUBJECT_AUTH_INVALID", "Subject authentication failed", 401);
  }
  return found;
}

function runtimeContext(config, subject) {
  return {
    schemaVersion: 1,
    clientSubscriptionId: subject.clientSubscriptionId,
    subscriptionInstanceId: subject.subscriptionInstanceId,
    productId: config.productId,
    tenantId: config.tenantId,
    authoritativePurchasedAt: subject.authoritativePurchasedAt,
    policyDigest: subject.policyDigest,
    policy: { subscriptionTypeId: config.subscriptionTypeId, policyVersion: subject.policyVersion },
    instance: {
      subscriptionInstanceId: subject.subscriptionInstanceId,
      subscriptionTypeId: config.subscriptionTypeId,
      productId: config.productId,
      policyVersion: subject.policyVersion,
      policyDigest: subject.policyDigest,
      state: subject.instanceState,
      tenantId: config.tenantId,
    },
    evidence: {
      instanceRevision: subject.instanceRevision,
      publicationHistory: jsonClone(config.publications),
    },
  };
}

function systemEvidence(config, now) {
  const observedAt = now.toISOString();
  return {
    environment: "DEV",
    tenantId: config.tenantId,
    evidenceMode: "FIXTURE_NON_AUTHORIZING",
    runtimeFlags: { enabled: false, devOnly: true, productionEnabled: false },
    productionState: { unchanged: false, runtimeFlagsEnabled: false },
    indexes: {
      required: ["instance-pin", "entitlement-scope"],
      present: [],
      missing: ["instance-pin", "entitlement-scope"],
    },
    projectionCheckpoint: { current: false, observedAt },
    canaryEvidence: {
      current: false,
      observedAt,
      subscriptionInstanceIds: [
        config.subjects.A.subscriptionInstanceId,
        config.subjects.B.subscriptionInstanceId,
      ],
    },
    noWriteEvidence: {
      current: false,
      observedAt,
      createJoinWritesAbsent: false,
      providerBookingWritesAbsent: false,
      paymentWritesAbsent: false,
      entitlementMutationsAbsent: false,
      rollbackWritesAbsent: false,
    },
    managedRange: jsonClone(config.managedRange),
  };
}

function zeroMetrics() {
  return Object.fromEntries(METRIC_KEYS.map((key) => [key, 0]));
}

function observationSigningPayload(payload) {
  return {
    clientSubscriptionId: payload.clientSubscriptionId,
    subscriptionInstanceId: payload.subscriptionInstanceId,
    correlationScope: payload.correlationScope,
    selectedPolicyVersion: payload.selectedPolicyVersion,
    selectedPolicyDigest: payload.selectedPolicyDigest,
    instanceRevision: payload.instanceRevision,
    instanceState: payload.instanceState,
    metrics: Object.fromEntries(METRIC_KEYS.map((key) => [key, payload.metrics[key]])),
    logicalResults: payload.logicalResults,
  };
}

function observability(config, role, subject, scope) {
  if (!["A", "B"].includes(role) || !RUN_SCOPE.test(scope) || !scope.endsWith(`:${role}`)) {
    fail("FIXTURE_SCOPE_INVALID", "Observability scope is not bound to the fixture subject", 400);
  }
  const payload = {
    clientSubscriptionId: subject.clientSubscriptionId,
    subscriptionInstanceId: subject.subscriptionInstanceId,
    correlationScope: scope,
    selectedPolicyVersion: subject.policyVersion,
    selectedPolicyDigest: subject.policyDigest,
    instanceRevision: subject.instanceRevision,
    instanceState: subject.instanceState,
    metrics: zeroMetrics(),
    logicalResults: [],
  };
  return { ...payload, evidenceHmac: evidenceHmac(observationSigningPayload(payload), config.integrationToken) };
}

export function handleFixtureRequest({ role, method, pathname, headers = {}, body, now = new Date() }, config) {
  if (!ROLE_PORTS[role]) fail("FIXTURE_ROLE_INVALID", "Unknown fixture role", 400);
  const request = {
    method: cleanText(method).toUpperCase(),
    pathname: cleanText(pathname),
    headers: Object.fromEntries(Object.entries(headers).map(([key, value]) => [key.toLowerCase(), cleanText(value)])),
    body,
  };
  if (request.method === "GET" && request.pathname === "/healthz") {
    return { statusCode: 200, body: { environment: "DEV", role, mode: "FIXTURE_READ_ONLY" } };
  }
  if (role !== "cup") {
    fail("FIXTURE_ROUTE_NOT_IMPLEMENTED", "Provider and identity fixture routes remain locked", 503);
  }
  if (request.method === "GET" && request.pathname === "/api/system/release") {
    return { statusCode: 200, body: jsonClone(config.cupRelease) };
  }
  if (request.method === "GET" && request.pathname === "/api/internal/subscriptions/dev-uat/system-evidence") {
    return { statusCode: 200, body: systemEvidence(config, now) };
  }
  if (request.method === "POST" && request.pathname === "/api/internal/subscriptions/runtime-context") {
    const [, subject] = requireReadAuthorization(config, request, ["clientSubscriptionId"]);
    return { statusCode: 200, body: runtimeContext(config, subject) };
  }
  if (request.method === "POST" && request.pathname === "/api/internal/subscriptions/dev-uat/observability") {
    const [subjectRole, subject] = requireReadAuthorization(
      config,
      request,
      ["clientSubscriptionId", "correlationScope"],
      false,
    );
    return { statusCode: 200, body: observability(config, subjectRole, subject, cleanText(body.correlationScope)) };
  }
  fail("FIXTURE_ROUTE_NOT_IMPLEMENTED", "Mutation and unknown fixture routes are locked", 503);
}

function writeJson(response, statusCode, body) {
  const bytes = Buffer.from(`${JSON.stringify(body)}\n`);
  response.writeHead(statusCode, {
    "Content-Type": "application/json",
    "Content-Length": bytes.length,
    "Cache-Control": "no-store",
  });
  response.end(bytes);
}

async function readJsonBody(request) {
  const chunks = [];
  let size = 0;
  for await (const chunk of request) {
    size += chunk.length;
    if (size > 16_384) fail("FIXTURE_REQUEST_TOO_LARGE", "Fixture request body is too large", 413);
    chunks.push(chunk);
  }
  if (chunks.length === 0) return undefined;
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch {
    fail("FIXTURE_REQUEST_JSON_INVALID", "Fixture request body is invalid", 400);
  }
}

export function createFixtureServer(role, config) {
  validateFixtureConfig(config);
  if (!ROLE_PORTS[role]) fail("FIXTURE_ROLE_INVALID", "Unknown fixture role", 64);
  return http.createServer(async (request, response) => {
    try {
      const url = new URL(request.url || "/", `http://${LOOPBACK}:${ROLE_PORTS[role]}`);
      if (url.hostname !== LOOPBACK || url.search || url.hash) {
        fail("FIXTURE_REQUEST_TARGET_INVALID", "Fixture request target is not exact", 400);
      }
      const result = handleFixtureRequest({
        role,
        method: request.method,
        pathname: url.pathname,
        headers: request.headers,
        body: await readJsonBody(request),
      }, config);
      writeJson(response, result.statusCode, result.body);
    } catch (error) {
      const statusCode = error instanceof FixtureRuntimeError ? error.statusCode : 500;
      const code = error instanceof FixtureRuntimeError ? error.code : "FIXTURE_INTERNAL_ERROR";
      writeJson(response, statusCode, { code });
    }
  });
}

export function validateFixtureCli(argv, env = process.env, exists = fs.existsSync) {
  if (argv.length === 1 && argv[0] === "--self-check") {
    return { mode: "SELF_CHECK", host: LOOPBACK, roles: Object.keys(ROLE_PORTS), ports: ROLE_PORTS };
  }
  if (argv.length !== 2 || argv[0] !== "--role" || !ROLE_PORTS[argv[1]]) {
    fail("FIXTURE_CLI_INVALID", "Usage: fixture_runtime.mjs --self-check | --role cup|provider|identity", 64);
  }
  if (!exists(AUTHORIZATION_MARKER)) {
    fail("SERVICE_START_AUTHORIZATION_ABSENT", "Service-start authorization is absent", 78);
  }
  const configPath = cleanText(env[CONFIG_ENV]);
  if (!configPath) fail("FIXTURE_CONFIG_PATH_MISSING", "Private fixture config is not configured", 78);
  return { mode: "SERVE", role: argv[1], configPath };
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  try {
    const command = validateFixtureCli(process.argv.slice(2));
    if (command.mode === "SELF_CHECK") {
      process.stdout.write(`${JSON.stringify(command)}\n`);
    } else {
      const config = loadFixtureConfig(command.configPath);
      const server = createFixtureServer(command.role, config);
      server.listen(ROLE_PORTS[command.role], LOOPBACK, () => {
        process.stdout.write(`LK1_DEV_FIXTURE_ROLE=${command.role}\n`);
      });
    }
  } catch (error) {
    process.stderr.write(`${error.code || "FIXTURE_RUNTIME_BLOCKED"}\n`);
    process.exitCode = error.statusCode === 64 ? 64 : 78;
  }
}

export const fixtureRuntimeContract = Object.freeze({
  environment: "DEV",
  host: LOOPBACK,
  ports: ROLE_PORTS,
  authorizationMarker: AUTHORIZATION_MARKER,
  configEnvironmentVariable: CONFIG_ENV,
  mode: "READ_ONLY_EVIDENCE",
});
