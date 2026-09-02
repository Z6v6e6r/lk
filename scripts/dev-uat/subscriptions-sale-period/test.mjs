import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  assertNoSecrets,
  boundaryFixtures,
  classifyDevUrl,
  evaluatePreflight,
  executeMode,
  hasCompleteNoWriteProof,
  hasCompleteSetupNoWriteProof,
  loadInputs,
  normalizeObservation,
  parseCli,
  ReadOnlyHttpClient,
  reconcileObservations,
  redact,
  selectPublication,
  signObservationEvidence,
  UatError,
  writeEvidence,
} from "./lib.mjs";

const SECRET_A = "Bearer user-a-secret-token";
const SECRET_B = "Bearer user-b-secret-token";
const INTEGRATION_SECRET = "integration-secret-at-least-32-bytes-long";
const PRIVATE_PHONE = ["+7", "999", "000", "11", "22"].join("");
const LK_SHA = "1".repeat(40);
const CUP_SHA = "2".repeat(40);

function releaseEvidence(sha) {
  return { sourceSha: sha, candidateSha: sha, readbackSha: sha, servedSha: sha };
}

function inputs(overrides = {}) {
  return {
    DEV_LK_BASE_URL: "https://lk.dev.padlhub.example",
    DEV_CUP_BASE_URL: "https://cup.dev.padlhub.example",
    DEV_TEST_SUBSCRIPTION_A_ID: "client-subscription-a-123456",
    DEV_TEST_SUBSCRIPTION_B_ID: "client-subscription-b-654321",
    DEV_TEST_SUBSCRIPTION_A_INSTANCE_ID: "instance-a-123456",
    DEV_TEST_SUBSCRIPTION_B_INSTANCE_ID: "instance-b-123456",
    DEV_TEST_AUTH_A: SECRET_A,
    DEV_TEST_AUTH_B: SECRET_B,
    DEV_CUP_INTEGRATION_TOKEN: INTEGRATION_SECRET,
    EXPECTED_SUBSCRIPTION_TYPE_ID: "subscription-type-piter",
    EXPECTED_PRODUCT_ID: "product-piter",
    EXPECTED_RULE_A_VERSION: "V1",
    EXPECTED_RULE_B_VERSION: "V2",
    DEV_CONTROL_SUBSCRIPTION_ID: "control-subscription-000001",
    DEV_CONTROL_SUBSCRIPTION_INSTANCE_ID: "instance-control-000001",
    DEV_CONTROL_AUTH: "Bearer control-placeholder",
    expectedLkRelease: releaseEvidence(LK_SHA),
    expectedCupRelease: releaseEvidence(CUP_SHA),
    allowedDevOrigins: ["https://lk.dev.padlhub.example", "https://cup.dev.padlhub.example"],
    productionOrigins: ["https://padlhub.su", "https://cup.padlhub.su"],
    timeoutMs: 100,
    maxEvidenceAgeMs: 300_000,
    beforeMaxAgeMs: 3_600_000,
    endpoints: {
      lkRelease: "/lk/release-dev.json",
      cupRelease: "/api/system/release",
      runtimeContext: "/api/internal/subscriptions/runtime-context",
      systemEvidence: "/api/internal/subscriptions/dev-uat/system-evidence",
      observability: "/api/internal/subscriptions/dev-uat/observability",
    },
    artifactRoot: fs.mkdtempSync(path.join(os.tmpdir(), "sale-period-uat-")),
    ...overrides,
  };
}

function runtime(label, overrides = {}) {
  const isA = label === "A";
  const isControl = label === "CONTROL";
  const digest = (isA ? "a" : "b").repeat(64);
  const version = isA ? 1 : 2;
  const clientSubscriptionId = isA
    ? "client-subscription-a-123456"
    : isControl ? "control-subscription-000001" : "client-subscription-b-654321";
  const subscriptionInstanceId = isA
    ? "instance-a-123456"
    : isControl ? "instance-control-000001" : "instance-b-123456";
  const base = {
    schemaVersion: 1,
    clientSubscriptionId,
    subscriptionInstanceId,
    productId: "product-piter",
    tenantId: "tenant-dev",
    authoritativePurchasedAt: isA ? "2026-09-09T23:59:59.999Z" : "2026-09-10T00:00:00.000Z",
    policyDigest: digest,
    policy: { subscriptionTypeId: "subscription-type-piter", policyVersion: version },
    instance: {
      subscriptionInstanceId,
      subscriptionTypeId: "subscription-type-piter",
      productId: "product-piter",
      policyVersion: version,
      policyDigest: digest,
      state: "ACTIVE",
      tenantId: "tenant-dev",
    },
    evidence: {
      instanceRevision: isA ? 10 : 20,
      canaryAllowed: true,
      publicationHistory: boundaryFixtures().publications,
    },
  };
  return {
    ...base,
    ...overrides,
    policy: { ...base.policy, ...(overrides.policy || {}) },
    instance: { ...base.instance, ...(overrides.instance || {}) },
    evidence: { ...base.evidence, ...(overrides.evidence || {}) },
  };
}

function systemEvidence(overrides = {}) {
  const observedAt = new Date().toISOString();
  const base = {
    environment: "DEV",
    tenantId: "tenant-dev",
    runtimeFlags: { enabled: true, devOnly: true, productionEnabled: false },
    productionState: { unchanged: true, runtimeFlagsEnabled: false },
    indexes: { required: ["instance-pin", "entitlement-scope"], present: ["instance-pin", "entitlement-scope"], missing: [] },
    projectionCheckpoint: { current: true, observedAt },
    canaryEvidence: {
      current: true,
      observedAt,
      subscriptionInstanceIds: ["instance-a-123456", "instance-b-123456"],
    },
    noWriteEvidence: {
      current: true,
      observedAt,
      createJoinWritesAbsent: true,
      providerBookingWritesAbsent: true,
      paymentWritesAbsent: true,
      entitlementMutationsAbsent: true,
      rollbackWritesAbsent: true,
    },
    managedRange: { startsAt: "2026-09-01T00:00:00.000Z", endsAt: "2026-09-30T23:59:59.999Z" },
  };
  return { ...base, ...overrides };
}

function observation(label = "A", overrides = {}) {
  const isA = label === "A";
  const base = {
    clientSubscriptionId: isA ? "client-subscription-a-123456" : "client-subscription-b-654321",
    subscriptionInstanceId: isA ? "instance-a-123456" : "instance-b-123456",
    correlationScope: `subscription-sale-period:20260902T120000000Z:${label}`,
    selectedPolicyVersion: isA ? 1 : 2,
    selectedPolicyDigest: (isA ? "a" : "b").repeat(64),
    instanceRevision: isA ? 10 : 20,
    instanceState: "ACTIVE",
    metrics: {
      entitlementAggregateRevision: 4,
      dailyUsage: 0,
      activeUsage: 0,
      operations: 0,
      ledgerEntries: 0,
      outboxEntries: 0,
      testerGames: 0,
      providerWriteCounter: 0,
      paymentWriteCounter: 0,
      entitlementMutationCounter: 0,
      rollbackWriteCounter: 0,
      orphanReserves: 0,
      fallbackCounter: 0,
      productionCupCalls: 0,
      unrelatedUserChanges: 0,
    },
    logicalResults: [],
  };
  return { ...base, ...overrides, metrics: { ...base.metrics, ...(overrides.metrics || {}) } };
}

function normalizeFixtureObservation(label, overrides = {}) {
  const payload = observation(label, overrides);
  return normalizeObservation(
    signObservationEvidence(payload, INTEGRATION_SECRET),
    payload.clientSubscriptionId,
    payload.subscriptionInstanceId,
    payload.correlationScope,
    INTEGRATION_SECRET,
  );
}

function logicalResult(label, overrides = {}) {
  const isA = label === "A";
  return {
    step: `${label}_CREATE`,
    action: "CREATE_GAME",
    result: "CONFIRMED",
    policyVersion: isA ? 1 : 2,
    policyDigest: (isA ? "a" : "b").repeat(64),
    logicalOperationCount: 1,
    providerCalls: 1,
    ledgerEntries: 1,
    outboxEntries: 1,
    orphanReserve: false,
    fallback: false,
    productionCupCalls: 0,
    ...overrides,
  };
}

function expectedDelta(label) {
  return {
    policyVersion: label === "A" ? "V1" : "V2",
    instanceRevisionDelta: 0,
    instanceState: "ACTIVE",
    metrics: {
      entitlementAggregateRevision: 1,
      dailyUsage: 1,
      activeUsage: 1,
      operations: 1,
      ledgerEntries: 1,
      outboxEntries: 1,
      testerGames: 1,
      providerWriteCounter: 1,
      paymentWriteCounter: 0,
      entitlementMutationCounter: 1,
      rollbackWriteCounter: 0,
    },
    logicalResults: [{
      step: `${label}_CREATE`,
      action: "CREATE_GAME",
      result: "CONFIRMED",
      providerCalls: 1,
      ledgerEntries: 1,
      outboxEntries: 1,
    }],
  };
}

test("URL classification requires an exact approved origin and rejects lookalikes", () => {
  assert.equal(classifyDevUrl("https://lk.dev.example").code, "URL_DEV_IDENTITY_UNPROVEN");
  assert.equal(classifyDevUrl("http://localhost:3000").code, "URL_DEV_IDENTITY_UNPROVEN");
  assert.equal(classifyDevUrl("https://padlhub.su").code, "URL_PRODUCTION_ORIGIN");
  assert.equal(classifyDevUrl("https://token@localhost").code, "URL_BASE_NOT_ORIGIN");
  assert.equal(classifyDevUrl("https://preview.example", { allowedDevOrigins: ["https://preview.example"] }).ok, true);
  assert.equal(classifyDevUrl("https://preview.example.attacker.invalid", { allowedDevOrigins: ["https://preview.example"] }).code, "URL_DEV_IDENTITY_UNPROVEN");
});

test("custom production origins extend the immutable built-in denylist", () => {
  const loaded = loadInputs({
    DEV_LK_BASE_URL: "https://lk.dev.example",
    DEV_CUP_BASE_URL: "https://cup.dev.example",
    DEV_TEST_SUBSCRIPTION_A_ID: "subscription-a",
    DEV_TEST_SUBSCRIPTION_B_ID: "subscription-b",
    DEV_TEST_SUBSCRIPTION_A_INSTANCE_ID: "instance-a",
    DEV_TEST_SUBSCRIPTION_B_INSTANCE_ID: "instance-b",
    DEV_TEST_AUTH_A: SECRET_A,
    DEV_TEST_AUTH_B: SECRET_B,
    DEV_CUP_INTEGRATION_TOKEN: INTEGRATION_SECRET,
    EXPECTED_SUBSCRIPTION_TYPE_ID: "type",
    EXPECTED_PRODUCT_ID: "product",
    EXPECTED_RULE_A_VERSION: "V1",
    EXPECTED_RULE_B_VERSION: "V2",
    DEV_CONTROL_SUBSCRIPTION_ID: "subscription-control",
    DEV_CONTROL_SUBSCRIPTION_INSTANCE_ID: "instance-control",
    DEV_CONTROL_AUTH: "Bearer control-placeholder",
    DEV_UAT_ALLOWED_DEV_ORIGINS_JSON: '["https://lk.dev.example","https://cup.dev.example"]',
    DEV_UAT_EXPECTED_LK_RELEASE_JSON: JSON.stringify(releaseEvidence(LK_SHA)),
    DEV_UAT_EXPECTED_CUP_RELEASE_JSON: JSON.stringify(releaseEvidence(CUP_SHA)),
    DEV_UAT_PRODUCTION_ORIGINS_JSON: '["https://other.example"]',
  });
  assert.equal(loaded.productionOrigins.includes("https://cup.padlhub.su"), true);
  assert.equal(loaded.productionOrigins.includes("https://other.example"), true);
});

test("input loading rejects missing exact allowlist and malformed frozen release binding", () => {
  const baseEnv = {
    DEV_LK_BASE_URL: "https://lk.dev.example",
    DEV_CUP_BASE_URL: "https://cup.dev.example",
    DEV_TEST_SUBSCRIPTION_A_ID: "subscription-a",
    DEV_TEST_SUBSCRIPTION_B_ID: "subscription-b",
    DEV_TEST_SUBSCRIPTION_A_INSTANCE_ID: "instance-a",
    DEV_TEST_SUBSCRIPTION_B_INSTANCE_ID: "instance-b",
    DEV_TEST_AUTH_A: SECRET_A,
    DEV_TEST_AUTH_B: SECRET_B,
    DEV_CUP_INTEGRATION_TOKEN: INTEGRATION_SECRET,
    EXPECTED_SUBSCRIPTION_TYPE_ID: "type",
    EXPECTED_PRODUCT_ID: "product",
    EXPECTED_RULE_A_VERSION: "V1",
    EXPECTED_RULE_B_VERSION: "V2",
    DEV_CONTROL_SUBSCRIPTION_ID: "subscription-control",
    DEV_CONTROL_SUBSCRIPTION_INSTANCE_ID: "instance-control",
    DEV_CONTROL_AUTH: "Bearer control-placeholder",
    DEV_UAT_EXPECTED_LK_RELEASE_JSON: JSON.stringify(releaseEvidence(LK_SHA)),
    DEV_UAT_EXPECTED_CUP_RELEASE_JSON: JSON.stringify(releaseEvidence(CUP_SHA)),
  };
  assert.throws(() => loadInputs(baseEnv), (error) => error.code === "DEV_ORIGIN_ALLOWLIST_REQUIRED");
  assert.throws(() => loadInputs({
    ...baseEnv,
    DEV_UAT_ALLOWED_DEV_ORIGINS_JSON: '["https://lk.dev.example","https://cup.dev.example"]',
    DEV_UAT_EXPECTED_LK_RELEASE_JSON: JSON.stringify({ ...releaseEvidence(LK_SHA), servedSha: "not-a-sha" }),
  }), (error) => error.code === "EXPECTED_RELEASE_BINDING_REQUIRED");
});

test("redaction removes secrets, PII, and exact identifiers", () => {
  const report = redact({
    authorization: SECRET_A,
    token: INTEGRATION_SECRET,
    phone: PRIVATE_PHONE,
    fullName: "Test User",
    clientSubscriptionId: "client-subscription-a-123456",
  }, { hmacKey: "redaction-key" });
  assertNoSecrets(report, [SECRET_A, INTEGRATION_SECRET, PRIVATE_PHONE, "Test User", "client-subscription-a-123456"]);
  assert.match(report.clientSubscriptionId, /^hmac:/);
  assert.equal(report.authorization, "[REDACTED]");
});

test("read-only client blocks mutation methods and non-observability POST", async () => {
  const client = new ReadOnlyHttpClient({ fetchImpl: async () => ({ ok: true, status: 200, json: async () => ({ ok: true }) }) });
  await assert.rejects(client.json({ baseUrl: "https://cup.dev.example", endpointPath: "/api/write", method: "DELETE" }), (error) => error.code === "WRITE_METHOD_BLOCKED");
  await assert.rejects(client.json({ baseUrl: "https://cup.dev.example", endpointPath: "/api/write", method: "POST", body: {} }), (error) => error.code === "WRITE_METHOD_BLOCKED");
});

test("duplicate logical read performs one network request", async () => {
  let calls = 0;
  const client = new ReadOnlyHttpClient({ fetchImpl: async () => {
    calls += 1;
    return { ok: true, status: 200, json: async () => ({ schemaVersion: 1 }) };
  } });
  const request = {
    baseUrl: "https://cup.dev.example",
    endpointPath: "/api/internal/subscriptions/runtime-context",
    method: "POST",
    body: { clientSubscriptionId: "subscription-1" },
    cacheKey: "same-operation",
  };
  assert.deepEqual(await client.json(request), await client.json(request));
  assert.equal(calls, 1);
});

test("boundary matrix selects V1 before V2 and V2 at/after effectiveAt", () => {
  const { publications } = boundaryFixtures();
  assert.equal(selectPublication(publications, "2026-09-09T23:59:59.999Z").selected.version, 1);
  assert.equal(selectPublication(publications, "2026-09-10T00:00:00.000Z").selected.version, 2);
  assert.equal(selectPublication(publications, "2026-09-10T00:00:00.001Z").selected.version, 2);
});

test("boundary failures are closed for dates, publication history, and pins", () => {
  const { v1, v2, publications } = boundaryFixtures();
  const cases = [
    [selectPublication(publications, null), "PURCHASED_AT_MISSING"],
    [selectPublication(publications, "bad-date"), "PURCHASED_AT_MALFORMED"],
    [selectPublication(publications, "2026-09-10"), "PURCHASED_AT_MALFORMED"],
    [selectPublication(publications, "2026-09-10T00:00:00"), "PURCHASED_AT_MALFORMED"],
    [selectPublication(publications, "2026-02-30T00:00:00Z"), "PURCHASED_AT_MALFORMED"],
    [selectPublication(publications, "2026-08-31T23:59:59.999Z"), "PURCHASE_BEFORE_FIRST_PUBLICATION"],
    [selectPublication([v1, { ...v2, effectiveAt: v1.effectiveAt }], "2026-09-20T00:00:00Z"), "PUBLICATION_EFFECTIVE_AT_AMBIGUOUS"],
    [selectPublication([v1, { ...v2, version: 1 }], "2026-09-20T00:00:00Z"), "PUBLICATION_VERSIONS_NON_MONOTONIC"],
    [selectPublication([v1, { ...v2, disabled: true }], "2026-09-20T00:00:00Z"), "SELECTED_PUBLICATION_DISABLED"],
    [selectPublication(publications, "2026-09-20T00:00:00Z", { expectedVersion: 3 }), "POLICY_VERSION_MISMATCH"],
    [selectPublication(publications, "2026-09-20T00:00:00Z", { pinnedDigest: "c".repeat(64) }), "POLICY_DIGEST_MISMATCH"],
    [selectPublication([{ ...v1, policyDigest: "free text" }, v2], "2026-09-02T00:00:00Z"), "PUBLICATION_HISTORY_INVALID"],
  ];
  for (const [result, code] of cases) assert.equal(result.code, code);
});

test("browser date is ignored", () => {
  const { publications } = boundaryFixtures();
  const result = selectPublication(publications, "2026-09-09T23:59:59.999Z", {
    browserPurchasedAt: "2026-09-20T00:00:00.000Z",
  });
  assert.equal(result.selected.version, 1);
});

test("complete preflight proves two pinned rules and DEV safety gates", () => {
  const report = evaluatePreflight({
    inputs: inputs(),
    lkRelease: releaseEvidence(LK_SHA),
    cupRelease: releaseEvidence(CUP_SHA),
    systemEvidence: systemEvidence(),
    runtimeA: runtime("A"),
    runtimeB: runtime("B"),
    runtimeControl: runtime("CONTROL"),
  });
  assert.equal(report.status, "READY", JSON.stringify(report.checks.filter((row) => row.status === "FAIL")));
  assert.equal(report.setupNoWrites, true);
  assert.equal(report.noWrites, false);
  assert.equal(hasCompleteSetupNoWriteProof(report), true);
  assert.equal(hasCompleteNoWriteProof(report), false);
});

test("preflight binds both served releases to every frozen expected SHA", () => {
  const mismatched = releaseEvidence(LK_SHA);
  mismatched.servedSha = "3".repeat(40);
  const report = evaluatePreflight({
    inputs: inputs(),
    lkRelease: mismatched,
    cupRelease: releaseEvidence(CUP_SHA),
    systemEvidence: systemEvidence(),
    runtimeA: runtime("A"),
    runtimeB: runtime("B"),
    runtimeControl: runtime("CONTROL"),
  });
  assert.equal(report.status, "BLOCKED");
  assert.equal(report.checks.find((row) => row.name === "LK_RELEASE_BINDING").status, "FAIL");
});

test("preflight requires exact A=V1/B=V2, exact-two canary instances, and mandatory control", () => {
  const wrongAssignment = evaluatePreflight({
    inputs: inputs({ EXPECTED_RULE_A_VERSION: "V2", EXPECTED_RULE_B_VERSION: "V1" }),
    lkRelease: releaseEvidence(LK_SHA),
    cupRelease: releaseEvidence(CUP_SHA),
    systemEvidence: systemEvidence(),
    runtimeA: runtime("A", { evidence: { canaryAllowed: false } }),
    runtimeB: runtime("B", { evidence: { canaryAllowed: false } }),
    runtimeControl: runtime("CONTROL", { evidence: { canaryAllowed: true } }),
  });
  assert.equal(wrongAssignment.checks.find((row) => row.name === "EXPECTED_RULE_ASSIGNMENT").status, "FAIL");

  const extraCanary = systemEvidence();
  extraCanary.canaryEvidence.subscriptionInstanceIds.push("instance-extra");
  const noControl = evaluatePreflight({
    inputs: inputs(),
    lkRelease: releaseEvidence(LK_SHA),
    cupRelease: releaseEvidence(CUP_SHA),
    systemEvidence: extraCanary,
    runtimeA: runtime("A"),
    runtimeB: runtime("B"),
  });
  assert.equal(noControl.status, "BLOCKED");
  assert.equal(noControl.checks.find((row) => row.name === "CANARY_EXACT_TWO_INSTANCE_ALLOWLIST").status, "FAIL");
  assert.equal(noControl.checks.find((row) => row.name === "CONTROL_SUBSCRIPTION_EXCLUDED").status, "FAIL");
});

test("unknown payment or rollback safety is FAIL and cannot claim default no-writes", () => {
  const evidence = systemEvidence();
  delete evidence.noWriteEvidence.paymentWritesAbsent;
  delete evidence.noWriteEvidence.rollbackWritesAbsent;
  const report = evaluatePreflight({
    inputs: inputs(),
    lkRelease: releaseEvidence(LK_SHA),
    cupRelease: releaseEvidence(CUP_SHA),
    systemEvidence: evidence,
    runtimeA: runtime("A"),
    runtimeB: runtime("B"),
    runtimeControl: runtime("CONTROL"),
  });
  assert.equal(report.status, "BLOCKED");
  assert.equal(report.setupNoWrites, false);
  assert.equal(report.noWrites, false);
  assert.equal(report.writeSafety.paymentWritesAbsent, false);
  assert.equal(report.writeSafety.rollbackWritesAbsent, false);
  assert.equal(hasCompleteNoWriteProof(report), false);
});

test("preflight blocks wrong ID, missing tenant, contradictions, and unsafe control", () => {
  const evidence = systemEvidence();
  delete evidence.tenantId;
  const control = runtime("CONTROL", { clientSubscriptionId: "wrong-control" });
  const report = evaluatePreflight({
    inputs: inputs({ DEV_CONTROL_AUTH: "Bearer control" }),
    lkRelease: releaseEvidence(LK_SHA),
    cupRelease: releaseEvidence(CUP_SHA),
    systemEvidence: evidence,
    runtimeA: runtime("A", { clientSubscriptionId: "wrong-id", canaryAllowed: false, instance: { revision: 99 } }),
    runtimeB: runtime("B"),
    runtimeControl: control,
  });
  assert.equal(report.status, "BLOCKED");
  for (const name of ["SUBSCRIPTION_A_IDENTITY", "RUNTIME_CONTEXT_A", "CROSS_TENANT", "CONTROL_SUBSCRIPTION_EXCLUDED"]) {
    assert.equal(report.checks.find((row) => row.name === name).status, "FAIL");
  }
});

test("preflight rejects fallback purchase date and wrong publication type", () => {
  const fallback = runtime("A");
  delete fallback.authoritativePurchasedAt;
  fallback.instance.purchaseDate = "2026-09-09T23:59:59.999Z";
  const missingInstance = runtime("B");
  delete missingInstance.subscriptionInstanceId;
  delete missingInstance.instance.subscriptionInstanceId;
  missingInstance.evidence.publicationHistory = boundaryFixtures().publications.map((row) => ({ ...row, subscriptionTypeId: "other" }));
  const report = evaluatePreflight({
    inputs: inputs(),
    lkRelease: releaseEvidence(LK_SHA),
    cupRelease: releaseEvidence(CUP_SHA),
    systemEvidence: systemEvidence(),
    runtimeA: fallback,
    runtimeB: missingInstance,
    runtimeControl: runtime("CONTROL"),
  });
  assert.equal(report.status, "BLOCKED");
  assert.equal(report.checks.find((row) => row.name === "RUNTIME_CONTEXT_A").status, "FAIL");
  assert.equal(report.checks.find((row) => row.name === "RUNTIME_CONTEXT_B").status, "FAIL");
  assert.equal(report.checks.find((row) => row.name === "PUBLICATION_B").status, "FAIL");
});

test("preflight rejects two client subscriptions aliased to one instance", () => {
  const aliasedB = runtime("B", {
    subscriptionInstanceId: "instance-a-123456",
    instance: { subscriptionInstanceId: "instance-a-123456" },
  });
  const report = evaluatePreflight({
    inputs: inputs(),
    lkRelease: releaseEvidence(LK_SHA),
    cupRelease: releaseEvidence(CUP_SHA),
    systemEvidence: systemEvidence(),
    runtimeA: runtime("A"),
    runtimeB: aliasedB,
    runtimeControl: runtime("CONTROL"),
  });
  assert.equal(report.status, "BLOCKED");
  assert.equal(report.checks.find((row) => row.name === "SUBSCRIPTION_INSTANCES_DISTINCT").status, "FAIL");
});

test("mandatory control must be a third distinct client and instance", () => {
  const report = evaluatePreflight({
    inputs: inputs({
      DEV_CONTROL_SUBSCRIPTION_ID: "client-subscription-a-123456",
      DEV_CONTROL_SUBSCRIPTION_INSTANCE_ID: "instance-a-123456",
      DEV_CONTROL_AUTH: "Bearer control-placeholder",
    }),
    lkRelease: releaseEvidence(LK_SHA),
    cupRelease: releaseEvidence(CUP_SHA),
    systemEvidence: systemEvidence(),
    runtimeA: runtime("A"),
    runtimeB: runtime("B"),
    runtimeControl: runtime("A"),
  });
  assert.equal(report.status, "BLOCKED");
  assert.equal(report.checks.find((row) => row.name === "CONTROL_SUBSCRIPTION_EXCLUDED").status, "FAIL");
});

test("timeout fails closed without exposing secrets", async () => {
  const client = new ReadOnlyHttpClient({
    timeoutMs: 20,
    fetchImpl: (_url, init) => new Promise((_resolve, reject) => {
      init.signal.addEventListener("abort", () => reject(Object.assign(new Error("aborted"), { name: "AbortError" })));
    }),
  });
  await assert.rejects(client.json({
    baseUrl: "https://cup.dev.example",
    endpointPath: "/api/internal/subscriptions/runtime-context",
    method: "POST",
    auth: SECRET_A,
    integrationToken: INTEGRATION_SECRET,
    body: { clientSubscriptionId: "subscription-1" },
  }), (error) => error.code === "HTTP_TIMEOUT" && !error.message.includes(SECRET_A));
});

test("partial or unsafe observability fails closed", () => {
  assert.throws(
    () => normalizeObservation({
      clientSubscriptionId: "subscription-1",
      subscriptionInstanceId: "instance-1",
      correlationScope: "scope-1",
      metrics: { operations: 1 },
    }, "subscription-1", "instance-1", "scope-1", INTEGRATION_SECRET),
    (error) => error.code === "OBSERVATION_SCHEMA_INVALID",
  );
  const valid = signObservationEvidence(observation("A"), INTEGRATION_SECRET);
  assert.throws(() => normalizeObservation(valid, "another-subscription", "instance-a-123456", valid.correlationScope, INTEGRATION_SECRET), (error) => error.code === "OBSERVATION_IDENTITY_MISMATCH");
  assert.throws(
    () => {
      const unsafe = signObservationEvidence(observation("A", { logicalResults: [logicalResult("A", { step: "private user name" })] }), INTEGRATION_SECRET);
      return normalizeObservation(unsafe, unsafe.clientSubscriptionId, unsafe.subscriptionInstanceId, unsafe.correlationScope, INTEGRATION_SECRET);
    },
    (error) => error.code === "OBSERVATION_LOGICAL_RESULT_INVALID",
  );
  const tampered = { ...valid, instanceRevision: valid.instanceRevision + 1 };
  assert.throws(
    () => normalizeObservation(tampered, tampered.clientSubscriptionId, tampered.subscriptionInstanceId, tampered.correlationScope, INTEGRATION_SECRET),
    (error) => error.code === "OBSERVATION_INTEGRITY_INVALID",
  );
  const tamperedPayment = {
    ...valid,
    metrics: { ...valid.metrics, paymentWriteCounter: valid.metrics.paymentWriteCounter + 1 },
  };
  assert.throws(
    () => normalizeObservation(tamperedPayment, tamperedPayment.clientSubscriptionId, tamperedPayment.subscriptionInstanceId, tamperedPayment.correlationScope, INTEGRATION_SECRET),
    (error) => error.code === "OBSERVATION_INTEGRITY_INVALID",
  );
  const tamperedRollback = {
    ...valid,
    metrics: { ...valid.metrics, rollbackWriteCounter: valid.metrics.rollbackWriteCounter + 1 },
  };
  assert.throws(
    () => normalizeObservation(tamperedRollback, tamperedRollback.clientSubscriptionId, tamperedRollback.subscriptionInstanceId, tamperedRollback.correlationScope, INTEGRATION_SECRET),
    (error) => error.code === "OBSERVATION_INTEGRITY_INVALID",
  );
});

test("before/after reconciliation requires exact logical and aggregate deltas", () => {
  const beforeA = normalizeFixtureObservation("A");
  const beforeB = normalizeFixtureObservation("B");
  const makeAfter = (before, label) => ({
    ...before,
    metrics: {
      ...before.metrics,
      entitlementAggregateRevision: before.metrics.entitlementAggregateRevision + 1,
      dailyUsage: 1,
      activeUsage: 1,
      operations: 1,
      ledgerEntries: 1,
      outboxEntries: 1,
      testerGames: 1,
      providerWriteCounter: 1,
      paymentWriteCounter: 0,
      entitlementMutationCounter: 1,
      rollbackWriteCounter: 0,
    },
    logicalResults: [logicalResult(label)],
  });
  const before = { subjects: { A: beforeA, B: beforeB } };
  const after = { subjects: { A: makeAfter(beforeA, "A"), B: makeAfter(beforeB, "B") } };
  const expected = { A: expectedDelta("A"), B: expectedDelta("B") };
  assert.equal(reconcileObservations(before, after, expected).ok, true);

  const badAfter = structuredClone(after);
  badAfter.subjects.A.metrics.operations = 2;
  badAfter.subjects.A.metrics.orphanReserves = 1;
  badAfter.subjects.A.metrics.fallbackCounter = 1;
  badAfter.subjects.A.metrics.productionCupCalls = 1;
  badAfter.subjects.A.metrics.unrelatedUserChanges = 1;
  const failure = reconcileObservations(before, badAfter, expected);
  assert.equal(failure.ok, false);
  for (const name of ["NO_DUPLICATE_OPERATION_A", "NO_ORPHAN_RESERVE_A", "NO_FALLBACK_A", "NO_PRODUCTION_CUP_A", "ZERO_UNRELATED_USERS_A"]) {
    assert.equal(failure.checks.find((row) => row.name === name).status, "FAIL");
  }

  const emptyLogical = structuredClone(after);
  emptyLogical.subjects.A.logicalResults = [];
  assert.equal(reconcileObservations(before, emptyLogical, expected).checks.find((row) => row.name === "LOGICAL_RESULT_SET_A").status, "FAIL");
  const inconsistentExpected = structuredClone(expected);
  inconsistentExpected.A.logicalResults[0].providerCalls = 0;
  assert.equal(reconcileObservations(before, after, inconsistentExpected).checks.find((row) => row.name === "EXPECTED_DELTA_A").status, "FAIL");
  const unsafeExpected = structuredClone(expected);
  unsafeExpected.A.logicalResults[0].step = "private name";
  const unsafeReport = reconcileObservations(before, after, unsafeExpected);
  assert.equal(unsafeReport.checks.find((row) => row.name === "EXPECTED_DELTA_A").status, "FAIL");
  assert.equal(JSON.stringify(unsafeReport).includes("private name"), false);

  const contaminatedBefore = structuredClone(before);
  contaminatedBefore.subjects.A.metrics.fallbackCounter = 1;
  contaminatedBefore.subjects.A.metrics.productionCupCalls = 1;
  contaminatedBefore.subjects.A.metrics.unrelatedUserChanges = 1;
  const contaminatedAfter = structuredClone(after);
  contaminatedAfter.subjects.A.metrics.fallbackCounter = 1;
  contaminatedAfter.subjects.A.metrics.productionCupCalls = 1;
  contaminatedAfter.subjects.A.metrics.unrelatedUserChanges = 1;
  const contaminated = reconcileObservations(contaminatedBefore, contaminatedAfter, expected);
  for (const name of ["NO_FALLBACK_A", "NO_PRODUCTION_CUP_A", "ZERO_UNRELATED_USERS_A"]) {
    assert.equal(contaminated.checks.find((row) => row.name === name).status, "FAIL");
  }
});

test("report generation creates private redacted JSON and Markdown", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "sale-period-report-"));
  const configured = inputs({ artifactRoot: root, DEV_UAT_REDACTION_HMAC_KEY: "hmac-secret-key" });
  const result = writeEvidence({
    inputs: configured,
    runId: "20260902T120000000Z",
    report: { mode: "preflight", status: "READY", checks: [], authorization: SECRET_A, clientSubscriptionId: "client-subscription-a-123456" },
  });
  const json = fs.readFileSync(result.jsonPath, "utf8");
  assert.doesNotMatch(json, /user-a-secret-token|client-subscription-a-123456|hmac-secret-key/);
  assert.match(json, /hmac:/);
  assert.equal(fs.statSync(result.directory).mode & 0o777, 0o700);
  assert.equal(fs.statSync(result.jsonPath).mode & 0o777, 0o600);
  assert.equal(fs.statSync(result.markdownPath).mode & 0o777, 0o600);
});

test("CLI accepts only exact mode interface", () => {
  assert.deepEqual(parseCli(["--mode", "preflight"]), { mode: "preflight" });
  assert.throws(() => parseCli(["--mode", "preflight", "--token", "secret"]), UatError);
  assert.throws(() => parseCli(["--subscription", "raw-id"]), UatError);
});

function fixtureFetch({ observations = {}, system = systemEvidence() } = {}) {
  const calls = [];
  const fetchImpl = async (url, init) => {
    const target = new URL(url);
    calls.push({ path: target.pathname, method: init.method, headers: init.headers, body: init.body });
    let payload;
    if (target.pathname === "/lk/release-dev.json") payload = releaseEvidence(LK_SHA);
    else if (target.pathname === "/api/system/release") payload = releaseEvidence(CUP_SHA);
    else if (target.pathname === "/api/internal/subscriptions/dev-uat/system-evidence") payload = system;
    else if (target.pathname === "/api/internal/subscriptions/runtime-context") {
      const body = JSON.parse(init.body);
      if (body.clientSubscriptionId === "client-subscription-a-123456") payload = runtime("A");
      else if (body.clientSubscriptionId === "client-subscription-b-654321") payload = runtime("B");
      else if (body.clientSubscriptionId === "control-subscription-000001") payload = runtime("CONTROL");
    } else if (target.pathname === "/api/internal/subscriptions/dev-uat/observability") {
      const body = JSON.parse(init.body);
      payload = observations[body.clientSubscriptionId]
        ? signObservationEvidence({ ...observations[body.clientSubscriptionId], correlationScope: body.correlationScope }, INTEGRATION_SECRET)
        : undefined;
    }
    return { ok: Boolean(payload), status: payload ? 200 : 404, json: async () => payload };
  };
  return { calls, fetchImpl };
}

test("preflight integration uses only allowlisted reads", async () => {
  const fixture = fixtureFetch();
  const result = await executeMode({
    mode: "preflight",
    inputs: inputs(),
    client: new ReadOnlyHttpClient({ fetchImpl: fixture.fetchImpl, timeoutMs: 100 }),
    now: new Date(),
  });
  assert.equal(result.report.status, "READY");
  assert.equal(fixture.calls.length, 6);
  assert.equal(fixture.calls.filter((call) => call.method === "POST").every((call) => call.path.endsWith("runtime-context")), true);
});

test("failed DEV metadata stops before authenticated user reads", async () => {
  const fixture = fixtureFetch({ system: systemEvidence({ environment: "PROD" }) });
  await assert.rejects(executeMode({
    mode: "preflight",
    inputs: inputs(),
    client: new ReadOnlyHttpClient({ fetchImpl: fixture.fetchImpl, timeoutMs: 100 }),
    now: new Date(),
  }), (error) => error.code === "SYSTEM_PREFLIGHT_BLOCKED");
  assert.equal(fixture.calls.length, 3);
  assert.equal(fixture.calls.every((call) => call.method === "GET" && call.body === undefined), true);
  assert.equal(fixture.calls.every((call) => !call.headers.Authorization && !call.headers["X-Subscriptions-Integration-Token"]), true);
});

test("all modes reject production targets before network or secret transmission", async () => {
  for (const mode of ["preflight", "observe-before", "observe-after"]) {
    let calls = 0;
    const configured = inputs({
      DEV_CUP_BASE_URL: "https://cup.padlhub.su",
      DEV_UAT_RUN_ID: "20260902T120000000Z",
      DEV_UAT_EXPECTED_DELTA: { A: {}, B: {} },
    });
    await assert.rejects(executeMode({
      mode,
      inputs: configured,
      client: new ReadOnlyHttpClient({ fetchImpl: async () => { calls += 1; throw new Error("must not call"); } }),
    }), (error) => error.code === "URL_PRODUCTION_ORIGIN");
    assert.equal(calls, 0);
  }
});

test("DEV-looking unapproved origin is rejected before credentials or network", async () => {
  let calls = 0;
  const configured = inputs({ DEV_CUP_BASE_URL: "https://cup.dev.padlhub.example.attacker.invalid" });
  await assert.rejects(executeMode({
    mode: "preflight",
    inputs: configured,
    client: new ReadOnlyHttpClient({ fetchImpl: async () => { calls += 1; throw new Error("must not call"); } }),
  }), (error) => error.code === "URL_DEV_IDENTITY_UNPROVEN");
  assert.equal(calls, 0);
});

test("observe-before/after integration reconciles run-scoped evidence", async () => {
  const configured = inputs();
  const idA = configured.DEV_TEST_SUBSCRIPTION_A_ID;
  const idB = configured.DEV_TEST_SUBSCRIPTION_B_ID;
  const beforeRows = { [idA]: observation("A"), [idB]: observation("B") };
  const beforeAt = new Date();
  const beforeFixture = fixtureFetch({ observations: beforeRows });
  const before = await executeMode({
    mode: "observe-before",
    inputs: configured,
    client: new ReadOnlyHttpClient({ fetchImpl: beforeFixture.fetchImpl, timeoutMs: 100 }),
    now: beforeAt,
  });
  const afterRows = Object.fromEntries([[idA, "A"], [idB, "B"]].map(([id, label]) => [id, observation(label, {
    metrics: {
      entitlementAggregateRevision: 5,
      dailyUsage: 1,
      activeUsage: 1,
      operations: 1,
      ledgerEntries: 1,
      outboxEntries: 1,
      testerGames: 1,
      providerWriteCounter: 1,
      paymentWriteCounter: 0,
      entitlementMutationCounter: 1,
      rollbackWriteCounter: 0,
    },
    logicalResults: [logicalResult(label)],
  })]));
  const afterFixture = fixtureFetch({ observations: afterRows });
  const after = await executeMode({
    mode: "observe-after",
    inputs: { ...configured, DEV_UAT_RUN_ID: before.runId, DEV_UAT_EXPECTED_DELTA: { A: expectedDelta("A"), B: expectedDelta("B") } },
    client: new ReadOnlyHttpClient({ fetchImpl: afterFixture.fetchImpl, timeoutMs: 100 }),
    now: new Date(beforeAt.getTime() + 5 * 60_000),
  });
  assert.equal(after.report.status, "PASS", JSON.stringify(after.report.checks.filter((row) => row.status === "FAIL")));
  assert.match(after.report.integrityHmac, /^[a-f0-9]{64}$/);
  assert.match(after.report.context.subjectBindings.A.clientSubscriptionHmac, /^[a-f0-9]{64}$/);
  assert.equal(after.report.context.beforeIntegrityHmac, before.report.integrityHmac);
  assert.equal(after.report.setupNoWrites, true);
  assert.equal(after.report.noWrites, false);
  assert.equal(hasCompleteSetupNoWriteProof(after.report), true);
  assert.equal(hasCompleteNoWriteProof(after.report), false);
  assert.equal(after.report.endToEndMutationEvidence.authenticated, true);
  assert.equal(after.report.endToEndMutationEvidence.subjects.A.deltas.providerWriteCounter, 1);
  assert.equal(after.report.endToEndMutationEvidence.subjects.B.deltas.entitlementMutationCounter, 1);
  assert.equal(after.report.endToEndMutationEvidence.subjects.A.deltas.paymentWriteCounter, 0);
  assert.equal(after.report.endToEndMutationEvidence.subjects.B.deltas.rollbackWriteCounter, 0);
  assert.doesNotMatch(fs.readFileSync(after.jsonPath, "utf8"), /providerPayload|user-a-secret-token|client-subscription-a-123456/);
});

test("tampered before snapshot and invalid run ID stop before network", async () => {
  const configured = inputs();
  const observations = {
    [configured.DEV_TEST_SUBSCRIPTION_A_ID]: observation("A"),
    [configured.DEV_TEST_SUBSCRIPTION_B_ID]: observation("B"),
  };
  const before = await executeMode({
    mode: "observe-before",
    inputs: configured,
    client: new ReadOnlyHttpClient({ fetchImpl: fixtureFetch({ observations }).fetchImpl, timeoutMs: 100 }),
    now: new Date(),
  });
  let calls = 0;
  const never = new ReadOnlyHttpClient({ fetchImpl: async () => { calls += 1; throw new Error("must not call"); } });
  await assert.rejects(executeMode({
    mode: "observe-after",
    inputs: {
      ...configured,
      DEV_TEST_SUBSCRIPTION_A_INSTANCE_ID: "different-exact-instance",
      DEV_UAT_RUN_ID: before.runId,
      DEV_UAT_EXPECTED_DELTA: { A: expectedDelta("A"), B: expectedDelta("B") },
    },
    client: never,
  }), (error) => error.code === "BEFORE_SNAPSHOT_CONTEXT_MISMATCH");
  const stored = JSON.parse(fs.readFileSync(before.jsonPath, "utf8"));
  stored.status = "BLOCKED";
  fs.writeFileSync(before.jsonPath, `${JSON.stringify(stored)}\n`, { mode: 0o600 });
  await assert.rejects(executeMode({
    mode: "observe-after",
    inputs: { ...configured, DEV_UAT_RUN_ID: before.runId, DEV_UAT_EXPECTED_DELTA: { A: expectedDelta("A"), B: expectedDelta("B") } },
    client: never,
  }), (error) => error.code === "BEFORE_SNAPSHOT_INTEGRITY");
  await assert.rejects(executeMode({
    mode: "observe-after",
    inputs: { ...configured, DEV_UAT_RUN_ID: "../../escape", DEV_UAT_EXPECTED_DELTA: { A: {}, B: {} } },
    client: never,
  }), (error) => error.code === "RUN_ID_INVALID");
  assert.equal(calls, 0);
});
