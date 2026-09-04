#!/usr/bin/env node

import crypto from "node:crypto";
import fs from "node:fs";
import https from "node:https";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROLE_PORTS = Object.freeze({ cup: 3037, provider: 3038, identity: 3039 });
const AUTHORIZATION_ROLES = Object.freeze([...Object.keys(ROLE_PORTS), "nodered"]);
const LOOPBACK = "127.0.0.1";
const AUTHORIZATION_MARKER = "/srv/lk1-subscription-dev/authorization/service-start.approved";
const AUTHORIZATION_FILE_ENV = "LK1_SUBSCRIPTION_DEV_START_AUTHORIZATION_FILE";
const CONFIG_ENV = "LK1_SUBSCRIPTION_DEV_FIXTURE_CONFIG_FILE";
const INSTALLED_SOURCE_ENV = "LK1_SUBSCRIPTION_DEV_INSTALLED_SOURCE_COMMIT";
const INSTALLED_MANIFEST_ENV = "LK1_SUBSCRIPTION_DEV_RUNTIME_MANIFEST_SHA256";
const TLS_KEY_ENV = "LK1_SUBSCRIPTION_DEV_TLS_KEY_FILE";
const TLS_CERT_ENV = "LK1_SUBSCRIPTION_DEV_TLS_CERT_FILE";
const TLS_KEY_FILE = "/srv/lk1-subscription-dev/tls/server.key";
const TLS_CERT_FILE = "/srv/lk1-subscription-dev/tls/server.crt";
const SAFE_ID = /^fixture-[a-z0-9][a-z0-9-]{2,95}$/;
const SAFE_FIXTURE_SECRET = /^fixture-[a-z0-9][a-z0-9-]{23,127}$/;
const SHA256 = /^[a-f0-9]{64}$/;
const RELEASE_SHA = /^[a-f0-9]{40}$/;
const RUN_SCOPE = /^subscription-sale-period:\d{8}T\d{9}Z:(A|B)$/;
const SAFE_OPERATION_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{7,127}$/;
const MANAGED_ACTIONS = Object.freeze([
  "CREATE_GAME", "JOIN_GAME", "BOOK_GROUP_TRAINING", "BOOK_TOURNAMENT",
]);
const AUTHORIZATION_LIFETIME_MS = 3_600_000;
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
  exactKeys(value, [
    "schemaVersion", "environment", "sourceCommit", "artifactSha256", "manifestSha256",
    "hostReadbackSha256", "servedSha256",
  ], label);
  if (value.schemaVersion !== 2 || value.environment !== "DEV"
    || !RELEASE_SHA.test(cleanText(value.sourceCommit))
    || ![value.artifactSha256, value.manifestSha256, value.hostReadbackSha256, value.servedSha256]
      .every((item) => SHA256.test(cleanText(item)))) {
    fail("FIXTURE_RELEASE_INVALID", `${label} is not an exact v2 release identity`);
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
    "managedTarget", "usageUnits", "money",
  ], `subject ${role}`);
  if (!SAFE_ID.test(subject.clientSubscriptionId) || !SAFE_ID.test(subject.subscriptionInstanceId)
    || !SAFE_FIXTURE_SECRET.test(cleanText(subject.auth)) || !exactInstant(subject.authoritativePurchasedAt)
    || ![1, 2].includes(subject.policyVersion) || !SHA256.test(subject.policyDigest)
    || !Number.isSafeInteger(subject.instanceRevision) || subject.instanceRevision < 0
    || !["ACTIVE", "PENDING_ACTIVATION"].includes(subject.instanceState)
    || typeof subject.canaryAllowed !== "boolean") {
    fail("FIXTURE_SUBJECT_INVALID", `Subject ${role} is incomplete or not fixture-scoped`);
  }
  exactKeys(subject.managedTarget, [
    "targetId", "stationId", "eventTypeId", "productTypeId", "durationMinutes", "startsAt",
  ], `subject ${role} managed target`);
  exactKeys(subject.money, [
    "currency", "basePriceMinor", "discountMinor", "surchargeMinor", "finalPriceMinor",
  ], `subject ${role} money`);
  if (!SAFE_ID.test(subject.managedTarget.targetId)
    || !SAFE_ID.test(subject.managedTarget.stationId)
    || !SAFE_ID.test(subject.managedTarget.eventTypeId)
    || !SAFE_ID.test(subject.managedTarget.productTypeId)
    || ![60, 90, 120].includes(subject.managedTarget.durationMinutes)
    || !exactInstant(subject.managedTarget.startsAt)
    || !Number.isSafeInteger(subject.usageUnits) || subject.usageUnits < 1
    || subject.money.currency !== "RUB"
    || ![subject.money.basePriceMinor, subject.money.discountMinor,
      subject.money.surchargeMinor, subject.money.finalPriceMinor]
      .every((value) => Number.isSafeInteger(value) && value >= 0)
    || subject.money.finalPriceMinor !== 0) {
    fail("FIXTURE_SUBJECT_INVALID", `Subject ${role} managed decision is incomplete`);
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

function findSubjectByInstance(config, subscriptionInstanceId) {
  return Object.entries(config.subjects)
    .find(([, subject]) => subject.subscriptionInstanceId === subscriptionInstanceId);
}

function normalizedHeaders(headers) {
  return Object.fromEntries(Object.entries(headers)
    .map(([key, value]) => [key.toLowerCase(), cleanText(value)]));
}

function requireIntegrationAuthorization(config, request) {
  if (!sameSecret(request.headers["x-subscriptions-integration-token"], config.integrationToken)) {
    fail("FIXTURE_INTEGRATION_AUTH_INVALID", "Integration authentication failed", 401);
  }
}

function requireSubjectAuthorization(config, request, found, allowControl = false) {
  if (!found || (!allowControl && found[0] === "CONTROL")) {
    fail("FIXTURE_SUBJECT_NOT_FOUND", "Fixture subject is unavailable", 404);
  }
  if (!sameSecret(request.headers.authorization, found[1].auth)) {
    fail("FIXTURE_SUBJECT_AUTH_INVALID", "Subject authentication failed", 401);
  }
  return found;
}

function requireReadAuthorization(config, request, allowedBodyKeys, allowControl = true) {
  if (!isObject(request.body)
    || JSON.stringify(Object.keys(request.body).sort()) !== JSON.stringify([...allowedBodyKeys].sort())) {
    fail("FIXTURE_REQUEST_INVALID", "Read request body is not exact", 400);
  }
  requireIntegrationAuthorization(config, request);
  const found = findSubject(config, cleanText(request.body.clientSubscriptionId));
  return requireSubjectAuthorization(config, request, found, allowControl);
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

export function createFixtureState(config) {
  validateFixtureConfig(config);
  return {
    entitlements: new Map(),
    instances: new Map(Object.values(config.subjects).map((subject) => [
      subject.subscriptionInstanceId,
      { revision: subject.instanceRevision, state: subject.instanceState },
    ])),
  };
}

function requireManagedRequest(config, request, state, expectedBodyKeys) {
  if (!state || !(state.entitlements instanceof Map) || !(state.instances instanceof Map)) {
    fail("FIXTURE_MANAGED_STATE_INVALID", "Managed fixture state is unavailable", 503);
  }
  if (!isObject(request.body)
    || JSON.stringify(Object.keys(request.body).sort()) !== JSON.stringify([...expectedBodyKeys].sort())) {
    fail("FIXTURE_REQUEST_INVALID", "Managed request body is not exact", 400);
  }
  requireIntegrationAuthorization(config, request);
}

function managedDecision(subject, action) {
  return {
    decisionKind: "ENTITLEMENT",
    policyVersion: subject.policyVersion,
    policyDigest: subject.policyDigest,
    action,
    target: jsonClone(subject.managedTarget),
    usageUnits: subject.usageUnits,
    money: jsonClone(subject.money),
  };
}

function reserveEntitlement(config, request, state) {
  requireManagedRequest(config, request, state, ["subscriptionInstanceId", "action", "target"]);
  exactKeys(request.body.target, ["targetId"], "entitlement target");
  const found = requireSubjectAuthorization(
    config,
    request,
    findSubjectByInstance(config, cleanText(request.body.subscriptionInstanceId)),
  );
  const [, subject] = found;
  const operationId = cleanText(request.headers["idempotency-key"]);
  const correlationId = cleanText(request.headers["x-correlation-id"]);
  const action = cleanText(request.body.action);
  if (!SAFE_OPERATION_ID.test(operationId) || correlationId !== operationId
    || !MANAGED_ACTIONS.includes(action)
    || cleanText(request.body.target.targetId) !== subject.managedTarget.targetId) {
    fail("FIXTURE_ENTITLEMENT_REQUEST_INVALID", "Entitlement reserve identity is invalid", 409);
  }
  const existing = state.entitlements.get(operationId);
  if (existing) {
    if (existing.subscriptionInstanceId !== subject.subscriptionInstanceId
      || existing.action !== action || existing.targetId !== subject.managedTarget.targetId) {
      fail("FIXTURE_IDEMPOTENCY_CONFLICT", "Idempotency key is bound to another request", 409);
    }
    if (!["RESERVED", "CONFIRMED"].includes(existing.state)) {
      fail("FIXTURE_ENTITLEMENT_STATE_CONFLICT", "Released entitlement cannot be replayed", 409);
    }
    return {
      schemaVersion: 1,
      outcome: "RESERVED",
      operationId,
      subscriptionInstanceId: subject.subscriptionInstanceId,
      operationState: existing.state,
      aggregateRevision: existing.aggregateRevision,
      replayed: true,
      blockers: [],
      decision: jsonClone(existing.decision),
    };
  }
  const entry = {
    subscriptionInstanceId: subject.subscriptionInstanceId,
    action,
    targetId: subject.managedTarget.targetId,
    state: "RESERVED",
    aggregateRevision: 1,
    decision: managedDecision(subject, action),
  };
  state.entitlements.set(operationId, entry);
  return {
    schemaVersion: 1,
    outcome: "RESERVED",
    operationId,
    subscriptionInstanceId: subject.subscriptionInstanceId,
    operationState: "RESERVED",
    aggregateRevision: 1,
    replayed: false,
    blockers: [],
    decision: jsonClone(entry.decision),
  };
}

function entitlementTransition(config, request, state, transition) {
  const bodyKeys = Object.keys(request.body || {}).sort();
  const allowedKeySets = transition === "CONFIRMED"
    ? [["operationId", "providerBookingId"]]
    : [["operationId", "reason"], ["operationId", "providerBookingId", "reason"]];
  if (!allowedKeySets.some((keys) => JSON.stringify([...keys].sort()) === JSON.stringify(bodyKeys))) {
    fail("FIXTURE_REQUEST_INVALID", "Managed request body is not exact", 400);
  }
  requireManagedRequest(config, request, state, bodyKeys);
  const operationId = cleanText(request.body.operationId);
  const entry = state.entitlements.get(operationId);
  const found = entry && findSubjectByInstance(config, entry.subscriptionInstanceId);
  requireSubjectAuthorization(config, request, found);
  if (!SAFE_OPERATION_ID.test(operationId)) {
    fail("FIXTURE_ENTITLEMENT_REQUEST_INVALID", "Entitlement operation identity is invalid", 409);
  }
  if (transition === "CONFIRMED") {
    if (!SAFE_ID.test(cleanText(request.body.providerBookingId))) {
      fail("FIXTURE_PROVIDER_BOOKING_INVALID", "Synthetic provider booking is invalid", 409);
    }
    if (entry.state === "FAILED" || entry.state === "COMPENSATED") {
      fail("FIXTURE_ENTITLEMENT_STATE_CONFLICT", "Released entitlement cannot be confirmed", 409);
    }
    if (entry.state !== "CONFIRMED") {
      entry.state = "CONFIRMED";
      entry.aggregateRevision += 1;
    }
    return {
      schemaVersion: 1,
      outcome: "CONFIRMED",
      operationId,
      subscriptionInstanceId: entry.subscriptionInstanceId,
      operationState: "CONFIRMED",
      aggregateRevision: entry.aggregateRevision,
    };
  }
  if (!["PROVIDER_REJECTED", "PROVIDER_CANCELLED", "BOOKING_CANCELLED", "REQUEST_FAILED", "EXPIRED"]
    .includes(cleanText(request.body.reason))) {
    fail("FIXTURE_RELEASE_REASON_INVALID", "Release reason is not allowlisted", 409);
  }
  if (request.body.providerBookingId !== undefined
    && !SAFE_ID.test(cleanText(request.body.providerBookingId))) {
    fail("FIXTURE_PROVIDER_BOOKING_INVALID", "Synthetic provider booking is invalid", 409);
  }
  if (entry.state === "CONFIRMED") {
    fail("FIXTURE_ENTITLEMENT_STATE_CONFLICT", "Confirmed entitlement cannot be released", 409);
  }
  if (entry.state !== "FAILED") {
    entry.state = "FAILED";
    entry.aggregateRevision += 1;
  }
  return {
    schemaVersion: 1,
    outcome: "RELEASED",
    operationId,
    subscriptionInstanceId: entry.subscriptionInstanceId,
    operationState: "FAILED",
    aggregateRevision: entry.aggregateRevision,
  };
}

function activateFirstUse(config, request, state) {
  requireManagedRequest(config, request, state, [
    "subscriptionInstanceId", "clientSubscriptionId", "providerBookingId", "expectedInstanceRevision",
  ]);
  const found = requireSubjectAuthorization(
    config,
    request,
    findSubjectByInstance(config, cleanText(request.body.subscriptionInstanceId)),
  );
  const [, subject] = found;
  const instance = state.instances.get(subject.subscriptionInstanceId);
  if (request.body.clientSubscriptionId !== subject.clientSubscriptionId
    || !SAFE_ID.test(cleanText(request.body.providerBookingId))
    || !Number.isSafeInteger(request.body.expectedInstanceRevision)) {
    fail("FIXTURE_ACTIVATION_REQUEST_INVALID", "Activation request identity is invalid", 409);
  }
  const alreadyActive = instance.state === "ACTIVE";
  if (!alreadyActive && request.body.expectedInstanceRevision !== instance.revision) {
    fail("FIXTURE_ACTIVATION_REVISION_CONFLICT", "Activation revision is stale", 409);
  }
  if (!alreadyActive) {
    instance.state = "ACTIVE";
    instance.revision += 1;
  }
  return {
    schemaVersion: 1,
    outcome: alreadyActive ? "ALREADY_ACTIVE" : "ACTIVATED",
    subscriptionInstanceId: subject.subscriptionInstanceId,
    state: "ACTIVE",
    revision: instance.revision,
    activeFrom: config.managedRange.startsAt,
    activeTo: config.managedRange.endsAt,
  };
}

export function handleFixtureRequest(
  { role, method, pathname, headers = {}, body, now = new Date() },
  config,
  state = null,
) {
  if (!ROLE_PORTS[role]) fail("FIXTURE_ROLE_INVALID", "Unknown fixture role", 400);
  const request = {
    method: cleanText(method).toUpperCase(),
    pathname: cleanText(pathname),
    headers: normalizedHeaders(headers),
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
  if (request.method === "POST" && request.pathname === "/api/internal/subscriptions/entitlements/reserve") {
    return { statusCode: 200, body: reserveEntitlement(config, request, state) };
  }
  if (request.method === "POST" && request.pathname === "/api/internal/subscriptions/entitlements/confirm") {
    return { statusCode: 200, body: entitlementTransition(config, request, state, "CONFIRMED") };
  }
  if (request.method === "POST" && request.pathname === "/api/internal/subscriptions/entitlements/release") {
    return { statusCode: 200, body: entitlementTransition(config, request, state, "FAILED") };
  }
  if (request.method === "POST" && request.pathname === "/api/internal/subscriptions/activate-first-use") {
    return { statusCode: 200, body: activateFirstUse(config, request, state) };
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

export function createFixtureServer(role, config, tlsCredentials) {
  validateFixtureConfig(config);
  if (!ROLE_PORTS[role]) fail("FIXTURE_ROLE_INVALID", "Unknown fixture role", 64);
  if (!isObject(tlsCredentials)
    || !Buffer.isBuffer(tlsCredentials.key) || tlsCredentials.key.length === 0
    || !Buffer.isBuffer(tlsCredentials.cert) || tlsCredentials.cert.length === 0) {
    fail("FIXTURE_TLS_CREDENTIALS_INVALID", "HTTPS fixture credentials are required", 78);
  }
  const state = createFixtureState(config);
  return https.createServer(tlsCredentials, async (request, response) => {
    try {
      const url = new URL(request.url || "/", `https://${LOOPBACK}:${ROLE_PORTS[role]}`);
      if (url.hostname !== LOOPBACK || url.search || url.hash) {
        fail("FIXTURE_REQUEST_TARGET_INVALID", "Fixture request target is not exact", 400);
      }
      const result = handleFixtureRequest({
        role,
        method: request.method,
        pathname: url.pathname,
        headers: request.headers,
        body: await readJsonBody(request),
      }, config, state);
      writeJson(response, result.statusCode, result.body);
    } catch (error) {
      const statusCode = error instanceof FixtureRuntimeError ? error.statusCode : 500;
      const code = error instanceof FixtureRuntimeError ? error.code : "FIXTURE_INTERNAL_ERROR";
      writeJson(response, statusCode, { code });
    }
  });
}

function readTlsCredential(filePath, expectedPath, fsApi, runtimeGid) {
  if (filePath !== expectedPath || !Number.isInteger(runtimeGid) || runtimeGid <= 0) {
    fail("FIXTURE_TLS_CREDENTIAL_PATH_INVALID", "TLS credential path is not exact", 78);
  }
  for (const [target, mode] of [
    ["/srv", 0o755],
    ["/srv/lk1-subscription-dev", null],
    ["/srv/lk1-subscription-dev/tls", 0o750],
  ]) {
    const stat = fsApi.lstatSync(target);
    if (fsApi.realpathSync(target) !== target || !stat.isDirectory() || stat.isSymbolicLink()
      || stat.uid !== 0 || (stat.mode & 0o022) !== 0
      || (mode !== null && (stat.mode & 0o777) !== mode)
      || (target.endsWith("/tls") && stat.gid !== runtimeGid)) {
      fail("FIXTURE_TLS_CREDENTIAL_CUSTODY_INVALID", "TLS directory custody is invalid", 78);
    }
  }
  const stat = fsApi.lstatSync(filePath);
  if (fsApi.realpathSync(filePath) !== filePath || !stat.isFile() || stat.isSymbolicLink()
    || stat.uid !== 0 || stat.gid !== runtimeGid || (stat.mode & 0o777) !== 0o440) {
    fail("FIXTURE_TLS_CREDENTIAL_CUSTODY_INVALID", "TLS file custody is invalid", 78);
  }
  const bytes = fsApi.readFileSync(filePath);
  if (!Buffer.isBuffer(bytes) || bytes.length === 0) {
    fail("FIXTURE_TLS_CREDENTIAL_INVALID", "TLS credential is empty", 78);
  }
  return bytes;
}

export function loadFixtureTlsCredentials(
  env = process.env,
  fsApi = fs,
  runtimeGid = typeof process.getgid === "function" ? process.getgid() : null,
) {
  return {
    key: readTlsCredential(cleanText(env[TLS_KEY_ENV]), TLS_KEY_FILE, fsApi, runtimeGid),
    cert: readTlsCredential(cleanText(env[TLS_CERT_ENV]), TLS_CERT_FILE, fsApi, runtimeGid),
  };
}

export function readAuthorizationCredential(
  authorizationFile,
  fsApi = fs,
  runtimeGid = typeof process.getgid === "function" ? process.getgid() : null,
) {
  if (authorizationFile !== AUTHORIZATION_MARKER) {
    fail("SERVICE_START_CREDENTIAL_PATH_INVALID", "Authorization path is not exact", 78);
  }
  const custody = [
    ["/srv", 0o755, null],
    ["/srv/lk1-subscription-dev", null, null],
    ["/srv/lk1-subscription-dev/authorization", 0o750, "DEDICATED_GROUP"],
  ];
  let authorizationGroup = null;
  for (const [target, exactMode, groupPolicy] of custody) {
    const lexicalStat = fsApi.lstatSync(target);
    const resolved = fsApi.realpathSync(target);
    if (resolved !== target || !lexicalStat.isDirectory() || lexicalStat.isSymbolicLink()
      || lexicalStat.uid !== 0 || (lexicalStat.mode & 0o022) !== 0
      || (exactMode !== null && (lexicalStat.mode & 0o777) !== exactMode)) {
      fail("SERVICE_START_CREDENTIAL_CUSTODY_INVALID", "Authorization directory custody is invalid", 78);
    }
    if (groupPolicy === "DEDICATED_GROUP") {
      if (!Number.isInteger(lexicalStat.gid) || lexicalStat.gid <= 0) {
        fail("SERVICE_START_CREDENTIAL_CUSTODY_INVALID", "Authorization group is not dedicated", 78);
      }
      authorizationGroup = lexicalStat.gid;
    }
  }
  const lexicalStat = fsApi.lstatSync(authorizationFile);
  const resolved = fsApi.realpathSync(authorizationFile);
  if (!Number.isInteger(runtimeGid) || runtimeGid <= 0
    || resolved !== authorizationFile || !lexicalStat.isFile() || lexicalStat.isSymbolicLink()
    || lexicalStat.uid !== 0 || lexicalStat.gid !== authorizationGroup
    || lexicalStat.gid !== runtimeGid
    || (lexicalStat.mode & 0o777) !== 0o440) {
    fail(
      "SERVICE_START_CREDENTIAL_CUSTODY_INVALID",
      "Start authorization is not an exact root-owned group-read-only regular file",
      78,
    );
  }
  return fsApi.readFileSync(resolved, "utf8");
}

export function validateStartAuthorization(
  role,
  env = process.env,
  now = new Date(),
  readCredential = readAuthorizationCredential,
) {
  if (!AUTHORIZATION_ROLES.includes(role)) fail("FIXTURE_ROLE_INVALID", "Unknown authorization role", 64);
  const authorizationFile = cleanText(env[AUTHORIZATION_FILE_ENV]);
  const installedSourceCommit = cleanText(env[INSTALLED_SOURCE_ENV]);
  const installedManifestSha256 = cleanText(env[INSTALLED_MANIFEST_ENV]);
  if (authorizationFile !== AUTHORIZATION_MARKER
    || !RELEASE_SHA.test(installedSourceCommit)
    || !SHA256.test(installedManifestSha256)) {
    fail("SERVICE_START_IDENTITY_UNBOUND", "Installed runtime identity is not exact", 78);
  }
  let authorization;
  try {
    authorization = JSON.parse(readCredential(authorizationFile));
  } catch (error) {
    if (error instanceof FixtureRuntimeError) throw error;
    fail("SERVICE_START_CREDENTIAL_INVALID", "Start credential is unavailable or invalid", 78);
  }
  exactKeys(authorization, [
    "schemaVersion", "environment", "sourceCommit", "runtimeManifestSha256",
    "roles", "issuedAt", "expiresAt", "authorizationId",
  ], "service-start credential");
  const issuedAt = Date.parse(authorization.issuedAt);
  const expiresAt = Date.parse(authorization.expiresAt);
  const nowMs = now.getTime();
  if (authorization.schemaVersion !== 1 || authorization.environment !== "DEV"
    || authorization.sourceCommit !== installedSourceCommit
    || authorization.runtimeManifestSha256 !== installedManifestSha256
    || JSON.stringify(authorization.roles) !== JSON.stringify(AUTHORIZATION_ROLES)
    || !authorization.roles.includes(role)
    || !exactInstant(authorization.issuedAt) || !exactInstant(authorization.expiresAt)
    || !SHA256.test(cleanText(authorization.authorizationId))
    || !Number.isFinite(nowMs) || issuedAt > nowMs || expiresAt <= nowMs
    || expiresAt <= issuedAt || expiresAt - issuedAt > AUTHORIZATION_LIFETIME_MS) {
    fail("SERVICE_START_AUTHORIZATION_INVALID", "Start credential is not exact, current, and bounded", 78);
  }
  return {
    sourceCommit: installedSourceCommit,
    runtimeManifestSha256: installedManifestSha256,
    expiresAt: authorization.expiresAt,
  };
}

export function validateFixtureCli(
  argv,
  env = process.env,
  authorize = (role) => validateStartAuthorization(role, env),
) {
  if (argv.length === 1 && argv[0] === "--self-check") {
    return {
      mode: "SELF_CHECK",
      host: LOOPBACK,
      roles: Object.keys(ROLE_PORTS),
      authorizationRoles: AUTHORIZATION_ROLES,
      ports: ROLE_PORTS,
      authorizationTransport: "ROOT_OWNED_GROUP_READ_ONLY_FILE",
    };
  }
  if (argv.length === 3 && argv[0] === "--validate-start-authorization"
    && argv[1] === "--role" && AUTHORIZATION_ROLES.includes(argv[2])) {
    return { mode: "AUTHORIZATION_CHECK", role: argv[2], authorization: authorize(argv[2]) };
  }
  if (argv.length !== 2 || argv[0] !== "--role" || !ROLE_PORTS[argv[1]]) {
    fail(
      "FIXTURE_CLI_INVALID",
      "Usage: fixture_runtime.mjs --self-check | --role cup|provider|identity | --validate-start-authorization --role cup|provider|identity|nodered",
      64,
    );
  }
  const authorization = authorize(argv[1]);
  const configPath = cleanText(env[CONFIG_ENV]);
  if (!configPath) fail("FIXTURE_CONFIG_PATH_MISSING", "Private fixture config is not configured", 78);
  return { mode: "SERVE", role: argv[1], configPath, authorization };
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  try {
    const command = validateFixtureCli(process.argv.slice(2));
    if (command.mode === "SELF_CHECK") {
      process.stdout.write(`${JSON.stringify(command)}\n`);
    } else if (command.mode === "AUTHORIZATION_CHECK") {
      process.stdout.write("LK1_DEV_START_AUTHORIZATION=VALID\n");
    } else {
      const config = loadFixtureConfig(command.configPath);
      const server = createFixtureServer(command.role, config, loadFixtureTlsCredentials());
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
  authorizationFileEnvironmentVariable: AUTHORIZATION_FILE_ENV,
  authorizationTransport: "ROOT_OWNED_GROUP_READ_ONLY_FILE",
  authorizationRoles: AUTHORIZATION_ROLES,
  installedIdentityEnvironment: {
    sourceCommit: INSTALLED_SOURCE_ENV,
    runtimeManifestSha256: INSTALLED_MANIFEST_ENV,
  },
  configEnvironmentVariable: CONFIG_ENV,
  tls: {
    keyEnvironmentVariable: TLS_KEY_ENV,
    certificateEnvironmentVariable: TLS_CERT_ENV,
    keyFile: TLS_KEY_FILE,
    certificateFile: TLS_CERT_FILE,
    transport: "HTTPS_ONLY",
  },
  mode: "SYNTHETIC_MANAGED_CONTRACT_SOURCE_ONLY",
});
