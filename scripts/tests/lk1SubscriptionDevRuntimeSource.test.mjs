import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { execFileSync } from "node:child_process";
import { buildRuntimeSourceBundle } from "../build_lk1_subscription_dev_runtime_source.mjs";
import {
  FixtureRuntimeError,
  handleFixtureRequest,
  loadFixtureConfig,
  validateFixtureCli,
  validateFixtureConfig,
} from "../lk1_subscription_dev_runtime/fixture_runtime.mjs";
import {
  validateMinimalDevFlow,
  validateRuntimeSourceContract,
  verifyRuntimeSourceBundle,
} from "../verify_lk1_subscription_dev_runtime_source.mjs";
import {
  evaluatePreflight,
  normalizeObservation,
} from "../dev-uat/subscriptions-sale-period/lib.mjs";

const ROOT = path.resolve(import.meta.dirname, "../..");
const FLOW_PATH = path.join(ROOT, "scripts/lk1_subscription_dev_runtime/minimal.flow.json");
const CONTRACT_PATH = path.join(ROOT, "scripts/lk1_subscription_dev_runtime/runtime_source_contract.json");
const COMMIT = "1".repeat(40);
const NOW = new Date("2026-09-10T12:00:00.000Z");
const TMP_ROOT = fs.existsSync("/private/tmp") ? "/private/tmp" : os.tmpdir();
const clone = (value) => JSON.parse(JSON.stringify(value));
const readJson = (file) => JSON.parse(fs.readFileSync(file, "utf8"));

function fixtureConfig() {
  return {
    schemaVersion: 1,
    environment: "DEV",
    tenantId: "fixture-tenant-piter",
    productId: "fixture-product-membership",
    subscriptionTypeId: "fixture-type-sale-period",
    integrationToken: `fixture-integration-${"x".repeat(32)}`,
    cupRelease: {
      sourceSha: "1".repeat(40),
      candidateSha: "2".repeat(40),
      readbackSha: "3".repeat(40),
      servedSha: "4".repeat(40),
    },
    managedRange: {
      startsAt: "2026-09-01T00:00:00.000Z",
      endsAt: "2026-09-30T23:59:59.999Z",
    },
    publications: [
      {
        version: 1,
        subscriptionTypeId: "fixture-type-sale-period",
        effectiveAt: "2026-09-01T00:00:00.000Z",
        status: "SUPERSEDED",
        policyDigest: "a".repeat(64),
      },
      {
        version: 2,
        subscriptionTypeId: "fixture-type-sale-period",
        effectiveAt: "2026-09-10T00:00:00.000Z",
        status: "PUBLISHED",
        policyDigest: "b".repeat(64),
      },
    ],
    subjects: {
      A: {
        clientSubscriptionId: "fixture-client-subscription-a",
        subscriptionInstanceId: "fixture-instance-a",
        auth: `fixture-auth-a-${"a".repeat(24)}`,
        authoritativePurchasedAt: "2026-09-09T23:59:59.999Z",
        policyVersion: 1,
        policyDigest: "a".repeat(64),
        instanceRevision: 7,
        instanceState: "ACTIVE",
        canaryAllowed: true,
      },
      B: {
        clientSubscriptionId: "fixture-client-subscription-b",
        subscriptionInstanceId: "fixture-instance-b",
        auth: `fixture-auth-b-${"b".repeat(24)}`,
        authoritativePurchasedAt: "2026-09-10T00:00:00.000Z",
        policyVersion: 2,
        policyDigest: "b".repeat(64),
        instanceRevision: 8,
        instanceState: "PENDING_ACTIVATION",
        canaryAllowed: true,
      },
      CONTROL: {
        clientSubscriptionId: "fixture-client-subscription-control",
        subscriptionInstanceId: "fixture-instance-control",
        auth: `fixture-auth-control-${"c".repeat(24)}`,
        authoritativePurchasedAt: "2026-09-11T00:00:00.000Z",
        policyVersion: 2,
        policyDigest: "b".repeat(64),
        instanceRevision: 9,
        instanceState: "ACTIVE",
        canaryAllowed: false,
      },
    },
  };
}

function request(config, role, method, pathname, subjectRole, body = undefined) {
  const subject = subjectRole ? config.subjects[subjectRole] : null;
  return handleFixtureRequest({
    role,
    method,
    pathname,
    now: NOW,
    headers: subject ? {
      authorization: subject.auth,
      "x-subscriptions-integration-token": config.integrationToken,
    } : {},
    body,
  }, config);
}

function build() {
  const parent = fs.mkdtempSync(path.join(TMP_ROOT, "lk1-dev-runtime-test-"));
  const output = path.join(parent, "bundle");
  return {
    parent,
    ...buildRuntimeSourceBundle({
      outputDirectory: output,
      sourceCommit: COMMIT,
      now: NOW,
      repositoryIdentity: () => ({ head: COMMIT, clean: true }),
      commitFile: (_commit, repositoryPath) => fs.readFileSync(path.join(ROOT, repositoryPath)),
    }),
  };
}

test("fixture config pins exact DEV identities, immutable V1/V2 boundary, and private custody", () => {
  const config = fixtureConfig();
  assert.equal(validateFixtureConfig(config), true);
  const parent = fs.mkdtempSync(path.join(TMP_ROOT, "lk1-dev-config-test-"));
  try {
    const file = path.join(parent, "fixture.json");
    fs.writeFileSync(file, `${JSON.stringify(config)}\n`, { mode: 0o600 });
    assert.deepEqual(loadFixtureConfig(file), config);
    fs.chmodSync(file, 0o640);
    assert.throws(() => loadFixtureConfig(file), /private file/);
    fs.chmodSync(file, 0o600);
    const link = path.join(parent, "fixture-link.json");
    fs.symlinkSync(file, link);
    assert.throws(() => loadFixtureConfig(link), /private file/);
  } finally {
    fs.rmSync(parent, { recursive: true });
  }
});

test("fixture config rejects non-fixture, ambiguous, out-of-range, and expanded schemas", () => {
  for (const mutate of [
    (value) => { value.environment = "PROD"; },
    (value) => { value.tenantId = "real-tenant"; },
    (value) => { value.integrationToken = `prod-secret-${"x".repeat(32)}`; },
    (value) => { value.subjects.B.clientSubscriptionId = value.subjects.A.clientSubscriptionId; },
    (value) => { value.subjects.B.auth = value.subjects.A.auth; },
    (value) => { value.subjects.B.auth = value.integrationToken; },
    (value) => { value.subjects.B.auth = `Bearer-${"b".repeat(32)}`; },
    (value) => { value.subjects.A.authoritativePurchasedAt = "2026-08-31T23:59:59.999Z"; },
    (value) => { value.subjects.A.policyVersion = 2; value.subjects.A.policyDigest = "b".repeat(64); },
    (value) => { value.subjects.B.authoritativePurchasedAt = "2026-09-09T23:59:59.999Z"; },
    (value) => { value.subjects.CONTROL.canaryAllowed = true; },
    (value) => { value.unapproved = true; },
  ]) {
    const config = fixtureConfig();
    mutate(config);
    assert.throws(() => validateFixtureConfig(config), FixtureRuntimeError);
  }
});

test("CLI self-check is inert and service mode requires a separate marker and private config path", () => {
  const selfCheck = validateFixtureCli(["--self-check"]);
  assert.equal(selfCheck.mode, "SELF_CHECK");
  assert.deepEqual(selfCheck.ports, { cup: 3037, provider: 3038, identity: 3039 });
  assert.throws(
    () => validateFixtureCli(["--role", "cup"], {}, () => false),
    (error) => error.code === "SERVICE_START_AUTHORIZATION_ABSENT",
  );
  assert.throws(
    () => validateFixtureCli(["--role", "cup"], {}, () => true),
    (error) => error.code === "FIXTURE_CONFIG_PATH_MISSING",
  );
  assert.deepEqual(
    validateFixtureCli(
      ["--role", "cup"],
      { LK1_SUBSCRIPTION_DEV_FIXTURE_CONFIG_FILE: "/srv/lk1-subscription-dev/private/fixture.json" },
      () => true,
    ),
    { mode: "SERVE", role: "cup", configPath: "/srv/lk1-subscription-dev/private/fixture.json" },
  );
});

test("CUP fixture is schema-compatible but cannot authorize standard UAT preflight", () => {
  const config = fixtureConfig();
  const release = request(config, "cup", "GET", "/api/system/release").body;
  const systemEvidence = request(
    config,
    "cup",
    "GET",
    "/api/internal/subscriptions/dev-uat/system-evidence",
  ).body;
  const runtime = (role) => request(
    config,
    "cup",
    "POST",
    "/api/internal/subscriptions/runtime-context",
    role,
    { clientSubscriptionId: config.subjects[role].clientSubscriptionId },
  ).body;
  const inputs = {
    DEV_LK_BASE_URL: "http://127.0.0.1:1882",
    DEV_CUP_BASE_URL: "http://127.0.0.1:3037",
    allowedDevOrigins: ["http://127.0.0.1:1882", "http://127.0.0.1:3037"],
    productionOrigins: ["https://padlhub.ru"],
    expectedLkRelease: release,
    expectedCupRelease: release,
    DEV_TEST_SUBSCRIPTION_A_ID: config.subjects.A.clientSubscriptionId,
    DEV_TEST_SUBSCRIPTION_B_ID: config.subjects.B.clientSubscriptionId,
    DEV_TEST_SUBSCRIPTION_A_INSTANCE_ID: config.subjects.A.subscriptionInstanceId,
    DEV_TEST_SUBSCRIPTION_B_INSTANCE_ID: config.subjects.B.subscriptionInstanceId,
    DEV_CONTROL_SUBSCRIPTION_ID: config.subjects.CONTROL.clientSubscriptionId,
    DEV_CONTROL_SUBSCRIPTION_INSTANCE_ID: config.subjects.CONTROL.subscriptionInstanceId,
    EXPECTED_PRODUCT_ID: config.productId,
    EXPECTED_SUBSCRIPTION_TYPE_ID: config.subscriptionTypeId,
    EXPECTED_RULE_A_VERSION: "V1",
    EXPECTED_RULE_B_VERSION: "V2",
    maxEvidenceAgeMs: 300_000,
  };
  const report = evaluatePreflight({
    inputs,
    lkRelease: release,
    cupRelease: release,
    systemEvidence,
    runtimeA: runtime("A"),
    runtimeB: runtime("B"),
    runtimeControl: runtime("CONTROL"),
    now: NOW,
  });
  assert.equal(systemEvidence.evidenceMode, "FIXTURE_NON_AUTHORIZING");
  assert.equal(report.status, "BLOCKED");
  assert.equal(report.setupNoWrites, false);
  assert.equal(report.noWrites, false);
  assert.equal(report.checks.some((row) => row.status === "FAIL"), true);
});

test("observability is exact-subject, exact-scope, authenticated, and all-zero", () => {
  const config = fixtureConfig();
  for (const role of ["A", "B"]) {
    const scope = `subscription-sale-period:20260910T120000000Z:${role}`;
    const payload = request(
      config,
      "cup",
      "POST",
      "/api/internal/subscriptions/dev-uat/observability",
      role,
      { clientSubscriptionId: config.subjects[role].clientSubscriptionId, correlationScope: scope },
    ).body;
    const normalized = normalizeObservation(
      payload,
      config.subjects[role].clientSubscriptionId,
      config.subjects[role].subscriptionInstanceId,
      scope,
      config.integrationToken,
    );
    assert.equal(normalized.evidenceAuthenticated, true);
    assert.deepEqual(new Set(Object.values(normalized.metrics)), new Set([0]));
    assert.deepEqual(normalized.logicalResults, []);
  }
});

test("wrong credentials, control observability, extra fields, mutation methods, and non-CUP routes fail closed", () => {
  const config = fixtureConfig();
  const bodyA = { clientSubscriptionId: config.subjects.A.clientSubscriptionId };
  assert.throws(() => handleFixtureRequest({
    role: "cup",
    method: "POST",
    pathname: "/api/internal/subscriptions/runtime-context",
    headers: {
      authorization: config.subjects.A.auth,
      "x-subscriptions-integration-token": "wrong-token-with-enough-length-xxxxxxxx",
    },
    body: bodyA,
  }, config), (error) => error.code === "FIXTURE_INTEGRATION_AUTH_INVALID" && error.statusCode === 401);
  assert.throws(() => request(
    config,
    "cup",
    "POST",
    "/api/internal/subscriptions/dev-uat/observability",
    "CONTROL",
    {
      clientSubscriptionId: config.subjects.CONTROL.clientSubscriptionId,
      correlationScope: "subscription-sale-period:20260910T120000000Z:CONTROL",
    },
  ), (error) => error.code === "FIXTURE_SUBJECT_NOT_FOUND" && error.statusCode === 404);
  assert.throws(() => request(
    config,
    "cup",
    "POST",
    "/api/internal/subscriptions/runtime-context",
    "A",
    { ...bodyA, correlationScope: "extra" },
  ), (error) => error.code === "FIXTURE_REQUEST_INVALID" && error.statusCode === 400);
  for (const role of ["cup", "provider", "identity"]) {
    for (const method of ["POST", "PUT", "PATCH", "DELETE"]) {
      assert.throws(
        () => request(config, role, method, "/api/games", "A", bodyA),
        (error) => error.code === "FIXTURE_ROUTE_NOT_IMPLEMENTED" && error.statusCode === 503,
      );
    }
  }
  assert.throws(
    () => request(config, "provider", "GET", "/api/system/release"),
    (error) => error.code === "FIXTURE_ROUTE_NOT_IMPLEMENTED" && error.statusCode === 503,
  );
});

test("minimal Node-RED flow is one fail-closed read-only release route", () => {
  const flow = readJson(FLOW_PATH);
  assert.equal(validateMinimalDevFlow(flow), true);
  for (const mutate of [
    (value) => { value.find((node) => node.type === "http in").method = "post"; },
    (value) => { value.push({ id: "outbound", type: "http request", wires: [] }); },
    (value) => { value.find((node) => node.type === "file in").filename = "/root/.node-red/flows.json"; },
    (value) => { value.find((node) => node.type === "http in").wires = [["missing"]]; },
    (value) => { value.find((node) => node.id.endsWith("release-validate")).func += "\nglobal.set('x', 1);"; },
    (value) => {
      value.find((node) => node.id.endsWith("release-validate")).func = [
        "msg.statusCode = 200;",
        `msg.payload = { sourceSha: '${"1".repeat(40)}', candidateSha: '${"1".repeat(40)}',`,
        `  readbackSha: '${"1".repeat(40)}', servedSha: '${"1".repeat(40)}' };`,
        "return msg;",
      ].join("\n");
    },
    (value) => {
      value.find((node) => node.id.endsWith("release-file")).type = "function";
      value.find((node) => node.id.endsWith("error-response")).type = "file in";
      value.find((node) => node.id.endsWith("error-response")).filename = "/srv/lk1-subscription-dev/node-red/release-identity.json";
    },
  ]) {
    const changed = clone(flow);
    mutate(changed);
    assert.throws(() => validateMinimalDevFlow(changed));
  }
});

test("runtime source contract grants local bundle build only", () => {
  const contract = readJson(CONTRACT_PATH);
  assert.equal(validateRuntimeSourceContract(contract), true);
  assert.equal(contract.implementedContract.managedEntitlement, "NOT_IMPLEMENTED");
  assert.equal(contract.implementedContract.provider, "HEALTH_ONLY_LOCKED");
  assert.deepEqual(
    Object.entries(contract.authority).filter(([key, value]) => value && key !== "bundleBuildAllowed"),
    [],
  );
  for (const key of Object.keys(contract.authority).filter((name) => name !== "bundleBuildAllowed")) {
    const changed = clone(contract);
    changed.authority[key] = true;
    assert.throws(() => validateRuntimeSourceContract(changed));
  }
});

test("builder emits and self-verifies an immutable temp-only source bundle", () => {
  const result = build();
  try {
    const verified = verifyRuntimeSourceBundle(result.outputDirectory, result.manifestSha256);
    assert.equal(verified.manifest.sourceCommit, COMMIT);
    assert.equal(verified.manifest.stage, "LOCAL_RUNTIME_SOURCE");
    assert.equal(Object.values(verified.manifest.authority).every((value) => value === false), true);
    assert.equal(fs.statSync(result.outputDirectory).mode & 0o777, 0o700);
    assert.equal(fs.statSync(path.join(result.outputDirectory, "manifest.json")).mode & 0o777, 0o600);
    assert.equal(verified.manifest.files.some((row) => /install/i.test(row.path)), false);
    const verifierOutput = execFileSync(process.execPath, [
      path.join(result.outputDirectory, "payload/verify_lk1_subscription_dev_runtime_source.mjs"),
      "--bundle",
      result.outputDirectory,
    ], {
      encoding: "utf8",
      env: { ...process.env, LK1_RUNTIME_SOURCE_MANIFEST_SHA256: result.manifestSha256 },
    });
    assert.match(verifierOutput, /LK1_DEV_RUNTIME_SOURCE_BUNDLE=VERIFIED/);
  } finally {
    fs.rmSync(result.parent, { recursive: true });
  }
});

test("bundle verification rejects manifest, payload, mode, and authority drift", () => {
  for (const mutate of [
    (result) => {
      const file = path.join(
        result.outputDirectory,
        "payload/lk1_subscription_dev_runtime/fixture_runtime.mjs",
      );
      fs.chmodSync(file, 0o750);
      fs.appendFileSync(file, "\n");
    },
    (result) => fs.chmodSync(path.join(
      result.outputDirectory,
      "payload/lk1_subscription_dev_runtime/runtime_source_contract.json",
    ), 0o644),
    (result) => fs.chmodSync(path.join(result.outputDirectory, "manifest.json"), 0o644),
    (result) => {
      const file = path.join(result.outputDirectory, "manifest.json");
      const manifest = readJson(file);
      manifest.authority.serviceStart = true;
      fs.writeFileSync(file, `${JSON.stringify(manifest)}\n`);
    },
    (result) => fs.writeFileSync(path.join(result.outputDirectory, "install.sh"), "#!/bin/sh\n"),
  ]) {
    const result = build();
    try {
      mutate(result);
      assert.throws(() => verifyRuntimeSourceBundle(result.outputDirectory, result.manifestSha256));
    } finally {
      fs.rmSync(result.parent, { recursive: true });
    }
  }
});

test("builder rejects repository identity ambiguity and non-new or non-temp output", () => {
  const exact = () => ({ head: COMMIT, clean: true });
  const committed = (_commit, repositoryPath) => fs.readFileSync(path.join(ROOT, repositoryPath));
  assert.throws(() => buildRuntimeSourceBundle({
    outputDirectory: path.join(ROOT, "bundle"), sourceCommit: COMMIT, repositoryIdentity: exact,
    commitFile: committed,
  }), /new temporary/);
  const parent = fs.mkdtempSync(path.join(TMP_ROOT, "lk1-dev-runtime-existing-"));
  try {
    assert.throws(() => buildRuntimeSourceBundle({
      outputDirectory: parent, sourceCommit: COMMIT, repositoryIdentity: exact,
      commitFile: committed,
    }), /new temporary/);
    assert.throws(() => buildRuntimeSourceBundle({
      outputDirectory: path.join(parent, "dirty"), sourceCommit: COMMIT,
      repositoryIdentity: () => ({ head: COMMIT, clean: false }),
      commitFile: committed,
    }), /exact clean HEAD/);
    assert.throws(() => buildRuntimeSourceBundle({
      outputDirectory: path.join(parent, "wrong-head"), sourceCommit: COMMIT,
      repositoryIdentity: () => ({ head: "2".repeat(40), clean: true }),
      commitFile: committed,
    }), /exact clean HEAD/);
    assert.throws(() => buildRuntimeSourceBundle({
      outputDirectory: path.join(parent, "divergent-blob"), sourceCommit: COMMIT,
      repositoryIdentity: exact,
      commitFile: () => Buffer.from("not-the-committed-source"),
    }), /do not belong to sourceCommit/);
  } finally {
    fs.rmSync(parent, { recursive: true });
  }
});
