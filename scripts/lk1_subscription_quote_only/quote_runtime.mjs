#!/usr/bin/env node

import crypto from "node:crypto";
import fs from "node:fs";
import http from "node:http";
import vm from "node:vm";
import { fileURLToPath } from "node:url";

const PURPOSE = "PROVIDER_INDEPENDENT_QUOTE_ONLY";
const ROLE = "quote";
const HOST = "127.0.0.1";
const PORT = 3040;
const ROUTE = "/api/internal/subscriptions/dev-uat/quote-comparison";
const MARKER = "/srv/lk1-subscription-dev/authorization/quote-start.approved";
const FIXTURE = "/srv/lk1-subscription-dev/quote/quote_fixture.json";
const EVALUATOR = "/srv/lk1-subscription-dev/quote/fn_managed_subscription_policy_evaluate.js";
const RESOLVER = "/srv/lk1-subscription-dev/quote/subscription-sale-period-resolver.ts";
const RESOLVER_RUNTIME = "/srv/lk1-subscription-dev/quote/subscription-sale-period-resolver.mjs";
const RUNTIME = "/srv/lk1-subscription-dev/quote/quote_runtime.mjs";
const UNIT = "/etc/systemd/system/lk1-subscription-dev-quote.service";
const NODE_EXECUTABLE = "/srv/lk1-subscription-dev/runtime/node/bin/node";
const MAX_AUTHORIZATION_BYTES = 16_384;
const MAX_LIFETIME_MS = 3_600_000;
const SHA256 = /^[a-f0-9]{64}$/;
const COMMIT = /^[a-f0-9]{40}$/;
const INSTANT = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;
const EXPECTED_POLICY_DIGESTS = Object.freeze([
  "f92a043abe68645085bc0b698ff8d541fce4711c815b7d153914c115711c07a3",
  "fb40c2d8cd77b434557074e227b32b8e9003f143f4032e80554a57899d618776",
]);

const ENV_KEYS = Object.freeze({
  lkSourceCommit: "LK1_QUOTE_INSTALLED_LK_SOURCE_COMMIT",
  phAdminSourceCommit: "LK1_QUOTE_INSTALLED_PH_ADMIN_SOURCE_COMMIT",
  toolingCommit: "LK1_QUOTE_INSTALLED_TOOLING_COMMIT",
  candidateManifestSha256: "LK1_QUOTE_INSTALLED_MANIFEST_SHA256",
  unitSha256: "LK1_QUOTE_INSTALLED_UNIT_SHA256",
  runtimeSha256: "LK1_QUOTE_INSTALLED_RUNTIME_SHA256",
  fixtureSha256: "LK1_QUOTE_INSTALLED_FIXTURE_SHA256",
  evaluatorSha256: "LK1_QUOTE_INSTALLED_EVALUATOR_SHA256",
  resolverSha256: "LK1_QUOTE_INSTALLED_RESOLVER_SHA256",
  resolverRuntimeSha256: "LK1_QUOTE_INSTALLED_RESOLVER_RUNTIME_SHA256",
  nodeBinarySha256: "LK1_QUOTE_INSTALLED_NODE_BINARY_SHA256",
  nodeVersion: "LK1_QUOTE_INSTALLED_NODE_VERSION",
});

export class QuoteOnlyError extends Error {
  constructor(code, message, statusCode = 500) {
    super(message);
    this.code = code;
    this.statusCode = statusCode;
  }
}

const fail = (code, message, statusCode = 500) => {
  throw new QuoteOnlyError(code, `${code}: ${message}`, statusCode);
};
const sha256 = (bytes) => crypto.createHash("sha256").update(bytes).digest("hex");
const isObject = (value) => Boolean(value) && typeof value === "object" && !Array.isArray(value);
const exactKeys = (value, expected, label) => {
  if (!isObject(value)
    || JSON.stringify(Object.keys(value).sort()) !== JSON.stringify([...expected].sort())) {
    fail("QUOTE_SCHEMA_INVALID", `${label} fields are not exact`);
  }
};
const exactInstant = (value) => typeof value === "string" && INSTANT.test(value)
  && Number.isFinite(Date.parse(value));
const clone = (value) => JSON.parse(JSON.stringify(value));

function sameStat(left, right) {
  return left.dev === right.dev && left.ino === right.ino && left.size === right.size
    && left.mtimeMs === right.mtimeMs && left.ctimeMs === right.ctimeMs
    && left.mode === right.mode && left.uid === right.uid && left.gid === right.gid
    && left.nlink === right.nlink;
}

function readBoundedFd(fsApi, fd, maximumBytes) {
  const chunks = [];
  let size = 0;
  while (true) {
    const chunk = Buffer.allocUnsafe(Math.min(4096, maximumBytes + 1 - size));
    const count = fsApi.readSync(fd, chunk, 0, chunk.length, null);
    if (count === 0) break;
    size += count;
    if (size > maximumBytes) fail("QUOTE_START_AUTHORIZATION_TOO_LARGE", "Start authorization is too large", 78);
    chunks.push(chunk.subarray(0, count));
  }
  if (size === 0) fail("QUOTE_START_AUTHORIZATION_EMPTY", "Start authorization is empty", 78);
  return Buffer.concat(chunks, size);
}

export function readStartAuthorizationFromStandardInput(fsApi = fs, fd = 0) {
  const fdPath = `/proc/self/fd/${fd}`;
  const beforeFd = fsApi.fstatSync(fd);
  const fdTarget = fsApi.readlinkSync(fdPath);
  const fdInfo = fsApi.readFileSync(`/proc/self/fdinfo/${fd}`, "utf8");
  const flagsMatch = /^flags:\s*([0-7]+)$/m.exec(fdInfo);
  const flags = flagsMatch ? Number.parseInt(flagsMatch[1], 8) : Number.NaN;
  const accessMode = flags & 0o3;
  const oPath = 0o10000000;
  if (!beforeFd.isFile() || beforeFd.uid !== 0 || beforeFd.gid !== 0
    || (beforeFd.mode & 0o777) !== 0o600 || beforeFd.nlink !== 1
    || beforeFd.size < 1 || beforeFd.size > MAX_AUTHORIZATION_BYTES
    || fdTarget !== MARKER
    || !Number.isSafeInteger(flags) || accessMode !== 0 || (flags & oPath) !== 0) {
    fail("QUOTE_START_AUTHORIZATION_CUSTODY_INVALID", "Start authorization FD is not exact and read-only", 78);
  }
  const bytes = readBoundedFd(fsApi, fd, MAX_AUTHORIZATION_BYTES);
  const afterFd = fsApi.fstatSync(fd);
  if (bytes.length !== beforeFd.size || !sameStat(beforeFd, afterFd)) {
    fail("QUOTE_START_AUTHORIZATION_CHANGED", "Start authorization changed during read", 78);
  }
  return bytes;
}

function installedIdentity(env) {
  const identity = Object.fromEntries(Object.entries(ENV_KEYS).map(([key, envKey]) => [key, String(env[envKey] || "").trim()]));
  for (const key of ["lkSourceCommit", "phAdminSourceCommit", "toolingCommit"]) {
    if (!COMMIT.test(identity[key])) fail("QUOTE_INSTALLED_IDENTITY_INVALID", "Installed source identity is not exact", 78);
  }
  for (const key of ["candidateManifestSha256", "unitSha256", "runtimeSha256", "fixtureSha256", "evaluatorSha256", "resolverSha256", "resolverRuntimeSha256", "nodeBinarySha256"]) {
    if (!SHA256.test(identity[key])) fail("QUOTE_INSTALLED_IDENTITY_INVALID", "Installed artifact identity is not exact", 78);
  }
  if (!/^v\d+\.\d+\.\d+$/.test(identity.nodeVersion)) {
    fail("QUOTE_INSTALLED_IDENTITY_INVALID", "Installed Node version is not exact", 78);
  }
  return identity;
}

export function validateStartAuthorization(bytes, env = process.env, now = new Date()) {
  let authorization;
  try {
    authorization = JSON.parse(Buffer.from(bytes).toString("utf8"));
  } catch {
    fail("QUOTE_START_AUTHORIZATION_INVALID", "Start authorization is not valid JSON", 78);
  }
  exactKeys(authorization, [
    "schemaVersion", "environment", "purpose", "role", "lkSourceCommit",
    "phAdminSourceCommit", "toolingCommit", "candidateManifestSha256", "unitSha256",
    "runtimeSha256", "fixtureSha256", "evaluatorSha256", "resolverSha256", "resolverRuntimeSha256",
    "nodeBinarySha256", "nodeVersion",
    "authorizationId", "issuedAt", "expiresAt",
  ], "start authorization");
  const identity = installedIdentity(env);
  const issuedAt = Date.parse(authorization.issuedAt);
  const expiresAt = Date.parse(authorization.expiresAt);
  const nowMs = now.getTime();
  const identityMatches = Object.keys(identity).every((key) => authorization[key] === identity[key]);
  if (authorization.schemaVersion !== 1 || authorization.environment !== "DEV"
    || authorization.purpose !== PURPOSE || authorization.role !== ROLE || !identityMatches
    || !SHA256.test(authorization.authorizationId || "")
    || !exactInstant(authorization.issuedAt) || !exactInstant(authorization.expiresAt)
    || !Number.isFinite(nowMs) || issuedAt > nowMs || expiresAt <= nowMs
    || expiresAt <= issuedAt || expiresAt - issuedAt > MAX_LIFETIME_MS) {
    fail("QUOTE_START_AUTHORIZATION_INVALID", "Start authorization is not exact, current, and bounded", 78);
  }
  return { ...identity, expiresAt: authorization.expiresAt };
}

function validatePublicationHistory(rows, fixture) {
  if (!Array.isArray(rows) || rows.length !== 2) fail("QUOTE_PUBLICATION_HISTORY_INVALID", "Exactly V1 and V2 are required");
  rows.forEach((row, index) => {
    exactKeys(row, [
      "publicationId", "subscriptionTypeId", "policyVersion", "effectiveAt", "publishedAt",
      "state", "supersededAt", "supersededBy", "policyDigest",
    ], `publication ${index}`);
    if (row.publicationId !== `fixture-publication-v${index + 1}`
      || row.subscriptionTypeId !== fixture.subscriptionTypeId || row.policyVersion !== index + 1
      || row.effectiveAt !== ["2026-09-01T00:00:00.000Z", "2026-09-10T00:00:00.000Z"][index]
      || row.publishedAt !== row.effectiveAt || row.policyDigest !== EXPECTED_POLICY_DIGESTS[index]
      || row.state !== (index === 0 ? "SUPERSEDED" : "PUBLISHED")
      || row.supersededAt !== (index === 0 ? rows[1].publishedAt : null)
      || row.supersededBy !== (index === 0 ? rows[1].publicationId : null)) {
      fail("QUOTE_PUBLICATION_HISTORY_INVALID", "Publication history is not exact");
    }
    const policy = fixture.policies[`V${row.policyVersion}`];
    if (!isObject(policy) || policy.policyVersion !== row.policyVersion
      || policy.subscriptionTypeId !== fixture.subscriptionTypeId
      || policy.effectiveAt !== row.effectiveAt || sha256(Buffer.from(JSON.stringify(policy))) !== row.policyDigest) {
      fail("QUOTE_POLICY_DIGEST_INVALID", "Policy bytes do not match their publication pin");
    }
  });
  if (Date.parse(rows[0].effectiveAt) >= Date.parse(rows[1].effectiveAt)) {
    fail("QUOTE_PUBLICATION_HISTORY_INVALID", "Publication boundaries are not monotonic");
  }
}

export function validateQuoteFixture(fixture) {
  exactKeys(fixture, [
    "schemaVersion", "environment", "purpose", "evaluatedAt", "subscriptionTypeId",
    "publicationHistory", "subjects", "target", "usage", "policies",
  ], "quote fixture");
  if (fixture.schemaVersion !== 1 || fixture.environment !== "DEV" || fixture.purpose !== PURPOSE
    || fixture.evaluatedAt !== "2026-09-10T10:00:00.000Z"
    || fixture.subscriptionTypeId !== "fixture-type-sale-period") {
    fail("QUOTE_FIXTURE_INVALID", "Quote fixture identity is invalid");
  }
  exactKeys(fixture.subjects, ["A", "B"], "subjects");
  exactKeys(fixture.policies, ["V1", "V2"], "policies");
  exactKeys(fixture.target, [
    "resolutionSource", "stationId", "category", "externalEventTypeId", "productTypeId",
    "eventId", "durationMinutes", "startsAt", "basePriceMinor", "currency",
  ], "target");
  exactKeys(fixture.usage, [
    "activeServiceScope", "dailyBucketLocalDate", "activeServices", "dailyUsed",
    "weeklyUsed", "monthlyUsed", "futureBookings", "activeServiceStartsAt",
  ], "usage");
  if (JSON.stringify(fixture.target) !== JSON.stringify({
    resolutionSource: "SERVER",
    stationId: "fixture-station-quote",
    category: "GAME",
    externalEventTypeId: "fixture-open-game",
    productTypeId: null,
    eventId: "fixture-event-quote",
    durationMinutes: 60,
    startsAt: "2026-09-10T12:00:00.000Z",
    basePriceMinor: 10000,
    currency: "RUB",
  }) || JSON.stringify(fixture.usage) !== JSON.stringify({
    activeServiceScope: "SUBSCRIPTION_BENEFIT_ONLY",
    dailyBucketLocalDate: "2026-09-10",
    activeServices: 0,
    dailyUsed: 0,
    weeklyUsed: 0,
    monthlyUsed: 0,
    futureBookings: 0,
    activeServiceStartsAt: [],
  })) fail("QUOTE_FIXTURE_INVALID", "Quote target and usage must remain exact synthetic server data");
  validatePublicationHistory(fixture.publicationHistory, fixture);
  for (const [label, expectedVersion] of [["A", 1], ["B", 2]]) {
    const subject = fixture.subjects[label];
    exactKeys(subject, ["authoritativePurchasedAt", "expectedPolicyVersion", "instanceState"], `subject ${label}`);
    const expectedPurchasedAt = label === "A" ? "2026-09-09T23:59:59.999Z" : "2026-09-10T00:00:00.000Z";
    if (subject.authoritativePurchasedAt !== expectedPurchasedAt || subject.expectedPolicyVersion !== expectedVersion
      || subject.instanceState !== "ACTIVE") fail("QUOTE_SUBJECT_INVALID", `Subject ${label} is invalid`);
  }
  const boundary = Date.parse(fixture.publicationHistory[1].effectiveAt);
  if (Date.parse(fixture.subjects.A.authoritativePurchasedAt) >= boundary
    || Date.parse(fixture.subjects.B.authoritativePurchasedAt) !== boundary) {
    fail("QUOTE_BOUNDARY_INVALID", "A/B purchase instants do not prove the V2 boundary");
  }
  return true;
}

function evaluate(evaluatorSource, input) {
  if (/\b(?:fetch|XMLHttpRequest|WebSocket|require|importScripts|process|globalThis|global|module|exports|eval|Function)\b|\bimport\s*\(/.test(evaluatorSource)) {
    fail("QUOTE_EVALUATOR_CAPABILITY_FORBIDDEN", "Evaluator contains an external capability");
  }
  const context = vm.createContext(Object.create(null), {
    codeGeneration: { strings: false, wasm: false },
  });
  const serializedDecision = new vm.Script(`"use strict";
const msg = { _managedSubscriptionPolicyInput: ${JSON.stringify(clone(input))} };
(function quoteOnlyEvaluator() {
${evaluatorSource}
}).call(null);
JSON.stringify(msg._managedSubscriptionPolicyDecision);`, {
    filename: "exact-lk-policy-evaluator.js",
  })
    .runInContext(context, { timeout: 100 });
  const decision = JSON.parse(serializedDecision);
  if (!isObject(decision)) fail("QUOTE_EVALUATOR_RESULT_INVALID", "Evaluator returned no decision");
  return decision;
}

function resolvePolicyVersion(resolverRuntimeSource, fixture, purchasedAt) {
  if (/\b(?:fetch|XMLHttpRequest|WebSocket|require|importScripts|process|globalThis|global|module|exports|eval|Function)\b|\bimport\s*\(/.test(resolverRuntimeSource)) {
    fail("QUOTE_RESOLVER_CAPABILITY_FORBIDDEN", "Resolver contains an external capability");
  }
  const context = vm.createContext(Object.create(null), {
    codeGeneration: { strings: false, wasm: false },
  });
  const serializedResolution = new vm.Script(`"use strict";
const input = ${JSON.stringify({ purchasedAt, publications: clone(fixture.publicationHistory) })};
let output = null;
${resolverRuntimeSource}
JSON.stringify(output);`, { filename: "exact-ph-admin-sale-period-resolver.mjs" })
    .runInContext(context, { timeout: 100 });
  const resolution = JSON.parse(serializedResolution);
  if (!isObject(resolution) || resolution.kind !== "MATCH" || resolution.matchCount !== 1
    || !isObject(resolution.publication) || !Number.isInteger(resolution.publication.policyVersion)) {
    fail("QUOTE_POLICY_NOT_FOUND", "Exact ph-admin resolver did not return one publication");
  }
  return resolution.publication.policyVersion;
}

function resultFor(fixture, evaluatorSource, resolverRuntimeSource, label) {
  const subject = fixture.subjects[label];
  const selected = resolvePolicyVersion(resolverRuntimeSource, fixture, subject.authoritativePurchasedAt);
  if (selected !== subject.expectedPolicyVersion) fail("QUOTE_POLICY_PIN_MISMATCH", `Subject ${label} selected an unexpected policy`);
  const policy = fixture.policies[`V${selected}`];
  const decision = evaluate(evaluatorSource, {
    evaluatedAt: fixture.evaluatedAt,
    action: "CREATE_GAME",
    policy,
    instance: {
      subscriptionInstanceId: `fixture-instance-${label.toLowerCase()}`,
      subscriptionTypeId: fixture.subscriptionTypeId,
      policyVersion: selected,
      state: subject.instanceState,
      activeFrom: fixture.publicationHistory[0].effectiveAt,
      activeTo: "2027-09-10T00:00:00.000Z",
      homeStationId: fixture.target.stationId,
      frozenUntil: null,
      noShowBlockedUntil: null,
    },
    target: clone(fixture.target),
    usage: clone(fixture.usage),
  });
  return {
    subject: label,
    authoritativePurchasedAt: subject.authoritativePurchasedAt,
    selectedPolicyVersion: selected,
    selectedPolicyDigest: fixture.publicationHistory[selected - 1].policyDigest,
    decision: {
      eligible: decision.eligible,
      policyVersion: decision.policyVersion,
      blockerCodes: decision.blockers.map((row) => row.code),
      benefitKind: decision.benefit?.kind ?? null,
      finalPriceMinor: decision.benefit?.finalPriceMinor ?? null,
      currency: decision.benefit?.currency ?? null,
    },
  };
}

export function buildQuoteComparison({ fixture, evaluatorBytes, resolverBytes, resolverRuntimeBytes, identity }) {
  validateQuoteFixture(fixture);
  if (sha256(evaluatorBytes) !== identity.evaluatorSha256
    || sha256(resolverBytes) !== identity.resolverSha256
    || sha256(resolverRuntimeBytes) !== identity.resolverRuntimeSha256) {
    fail("QUOTE_SOURCE_DIGEST_MISMATCH", "Evaluator or sale-period resolver source drifted");
  }
  const evaluatorSource = Buffer.from(evaluatorBytes).toString("utf8");
  const resolverRuntimeSource = Buffer.from(resolverRuntimeBytes).toString("utf8");
  const A = resultFor(fixture, evaluatorSource, resolverRuntimeSource, "A");
  const B = resultFor(fixture, evaluatorSource, resolverRuntimeSource, "B");
  if (A.selectedPolicyVersion !== 1 || B.selectedPolicyVersion !== 2
    || A.decision.finalPriceMinor === B.decision.finalPriceMinor) {
    fail("QUOTE_COMPARISON_NOT_DISTINCT", "A/V1 and B/V2 do not produce a distinct quote");
  }
  return {
    schemaVersion: 1,
    environment: "DEV",
    purpose: PURPOSE,
    browserAcceptedFields: [],
    source: {
      lkSourceCommit: identity.lkSourceCommit,
      phAdminSourceCommit: identity.phAdminSourceCommit,
      toolingCommit: identity.toolingCommit,
      candidateManifestSha256: identity.candidateManifestSha256,
      evaluatorSha256: identity.evaluatorSha256,
      resolverSha256: identity.resolverSha256,
      resolverRuntimeSha256: identity.resolverRuntimeSha256,
    },
    boundary: { rule: "effectiveAt-inclusive-half-open", result: "PASS" },
    results: { A, B },
    writeCounters: {
      provider: 0,
      booking: 0,
      payment: 0,
      entitlement: 0,
      mongo: 0,
    },
    standardManualUat: "BLOCKED",
  };
}

export function validateHttpRequest({ method, url, headers = {} }) {
  if (method !== "GET" || url !== ROUTE || headers["content-length"] !== undefined
    || headers["transfer-encoding"] !== undefined) {
    fail("QUOTE_HTTP_REQUEST_INVALID", "Only the exact input-free GET route is allowed", 400);
  }
  return true;
}

function readInstalledFile(filePath, expectedSha256) {
  const stat = fs.lstatSync(filePath);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.uid !== 0 || stat.gid !== 0
    || (stat.mode & 0o022) !== 0) fail("QUOTE_INSTALLED_FILE_CUSTODY_INVALID", "Installed quote source custody is invalid", 78);
  const bytes = fs.readFileSync(filePath);
  if (sha256(bytes) !== expectedSha256) fail("QUOTE_INSTALLED_FILE_DIGEST_MISMATCH", "Installed quote source drifted", 78);
  return bytes;
}

function sendJson(response, statusCode, body) {
  const bytes = Buffer.from(`${JSON.stringify(body)}\n`);
  response.writeHead(statusCode, {
    "Content-Type": "application/json",
    "Content-Length": bytes.length,
    "Cache-Control": "no-store",
  });
  response.end(bytes);
}

export function createQuoteServer(comparison) {
  return http.createServer((request, response) => {
    try {
      validateHttpRequest({ method: request.method, url: request.url, headers: request.headers });
      sendJson(response, 200, comparison);
    } catch (error) {
      const statusCode = error instanceof QuoteOnlyError ? error.statusCode : 500;
      const code = error instanceof QuoteOnlyError ? error.code : "QUOTE_INTERNAL_ERROR";
      sendJson(response, statusCode, { code });
    }
  });
}

function main() {
  if (process.argv.length !== 3 || process.argv[2] !== "--serve") {
    fail("QUOTE_CLI_INVALID", "Usage: quote_runtime.mjs --serve", 64);
  }
  const authorizationBytes = readStartAuthorizationFromStandardInput();
  fs.closeSync(0);
  const identity = validateStartAuthorization(authorizationBytes);
  readInstalledFile(RUNTIME, identity.runtimeSha256);
  readInstalledFile(UNIT, identity.unitSha256);
  if (process.execPath !== NODE_EXECUTABLE || process.version !== identity.nodeVersion) {
    fail("QUOTE_NODE_RUNTIME_IDENTITY_INVALID", "Installed Node executable or version is not exact", 78);
  }
  readInstalledFile(NODE_EXECUTABLE, identity.nodeBinarySha256);
  const fixtureBytes = readInstalledFile(FIXTURE, identity.fixtureSha256);
  const evaluatorBytes = readInstalledFile(EVALUATOR, identity.evaluatorSha256);
  const resolverBytes = readInstalledFile(RESOLVER, identity.resolverSha256);
  const resolverRuntimeBytes = readInstalledFile(RESOLVER_RUNTIME, identity.resolverRuntimeSha256);
  const fixture = JSON.parse(fixtureBytes.toString("utf8"));
  const comparison = buildQuoteComparison({ fixture, evaluatorBytes, resolverBytes, resolverRuntimeBytes, identity });
  const remainingMs = Date.parse(identity.expiresAt) - Date.now();
  const expiryTimer = setTimeout(() => process.exit(0), remainingMs);
  expiryTimer.unref();
  const server = createQuoteServer(comparison);
  server.listen(PORT, HOST);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) main();

export { ENV_KEYS, MARKER, PORT, PURPOSE, ROLE, ROUTE };
