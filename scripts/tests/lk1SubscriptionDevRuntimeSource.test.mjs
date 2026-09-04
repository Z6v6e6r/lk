import assert from "node:assert/strict";
import fs from "node:fs";
import https from "node:https";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { execFileSync } from "node:child_process";
import { buildRuntimeSourceBundle } from "../build_lk1_subscription_dev_runtime_source.mjs";
import {
  FixtureRuntimeError,
  createFixtureState,
  createFixtureServer,
  handleFixtureRequest,
  loadFixtureConfig,
  loadFixtureTlsCredentials,
  readAuthorizationCredential,
  validateFixtureCli,
  validateFixtureConfig,
  validateStartAuthorization,
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
  const managedTarget = (role, startsAt) => ({
    targetId: `fixture-target-${role.toLowerCase()}`,
    stationId: "fixture-station-piter",
    eventTypeId: "fixture-event-open-game",
    productTypeId: "fixture-product-type-padel",
    durationMinutes: 90,
    startsAt,
  });
  const money = {
    currency: "RUB",
    basePriceMinor: 400000,
    discountMinor: 400000,
    surchargeMinor: 0,
    finalPriceMinor: 0,
  };
  return {
    schemaVersion: 1,
    environment: "DEV",
    tenantId: "fixture-tenant-piter",
    productId: "fixture-product-membership",
    subscriptionTypeId: "fixture-type-sale-period",
    integrationToken: `fixture-integration-${"x".repeat(32)}`,
    cupRelease: {
      schemaVersion: 2,
      environment: "DEV",
      sourceCommit: "1".repeat(40),
      artifactSha256: "2".repeat(64),
      manifestSha256: "3".repeat(64),
      hostReadbackSha256: "4".repeat(64),
      servedSha256: "5".repeat(64),
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
        managedTarget: managedTarget("A", "2026-09-12T10:00:00.000Z"),
        usageUnits: 1,
        money,
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
        managedTarget: managedTarget("B", "2026-09-12T12:00:00.000Z"),
        usageUnits: 1,
        money,
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
        managedTarget: managedTarget("CONTROL", "2026-09-12T14:00:00.000Z"),
        usageUnits: 1,
        money,
      },
    },
  };
}

function installedIdentityEnv() {
  return {
    LK1_SUBSCRIPTION_DEV_START_AUTHORIZATION_FILE:
      "/srv/lk1-subscription-dev/authorization/service-start.approved",
    LK1_SUBSCRIPTION_DEV_INSTALLED_SOURCE_COMMIT: "1".repeat(40),
    LK1_SUBSCRIPTION_DEV_RUNTIME_MANIFEST_SHA256: "2".repeat(64),
  };
}

function startAuthorization() {
  return {
    schemaVersion: 1,
    environment: "DEV",
    sourceCommit: "1".repeat(40),
    runtimeManifestSha256: "2".repeat(64),
    roles: ["cup", "provider", "identity", "nodered"],
    issuedAt: "2026-09-10T11:30:00.000Z",
    expiresAt: "2026-09-10T12:30:00.000Z",
    authorizationId: "3".repeat(64),
  };
}

function request(config, role, method, pathname, subjectRole, body = undefined, state = null, extraHeaders = {}) {
  const subject = subjectRole ? config.subjects[subjectRole] : null;
  return handleFixtureRequest({
    role,
    method,
    pathname,
    now: NOW,
    headers: subject ? {
      authorization: subject.auth,
      "x-subscriptions-integration-token": config.integrationToken,
      ...extraHeaders,
    } : {},
    body,
  }, config, state);
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

test("health modes disclose CUP synthetic mutations and locked provider boundaries", () => {
  const config = fixtureConfig();
  assert.deepEqual(request(config, "cup", "GET", "/healthz").body, {
    environment: "DEV", role: "cup", mode: "SYNTHETIC_IN_MEMORY_MANAGED_CONTRACT",
  });
  for (const role of ["provider", "identity"]) {
    assert.deepEqual(request(config, role, "GET", "/healthz").body, {
      environment: "DEV", role, mode: "HEALTH_ONLY_FAIL_CLOSED",
    });
  }
});

test("CLI self-check is inert and service mode requires validated root-owned authorization transport", () => {
  const selfCheck = validateFixtureCli(["--self-check"]);
  assert.equal(selfCheck.mode, "SELF_CHECK");
  assert.deepEqual(selfCheck.ports, { cup: 3037, provider: 3038, identity: 3039 });
  assert.deepEqual(selfCheck.authorizationRoles, ["cup", "provider", "identity", "nodered"]);
  assert.equal(selfCheck.authorizationTransport, "ROOT_OWNED_GROUP_READ_ONLY_FILE");
  assert.throws(
    () => validateFixtureCli(["--role", "cup"], {}, () => {
      throw new FixtureRuntimeError("SERVICE_START_AUTHORIZATION_INVALID", "blocked", 78);
    }),
    (error) => error.code === "SERVICE_START_AUTHORIZATION_INVALID",
  );
  assert.throws(
    () => validateFixtureCli(["--role", "cup"], {}, () => ({ exact: true })),
    (error) => error.code === "FIXTURE_CONFIG_PATH_MISSING",
  );
  const authorization = { sourceCommit: "1".repeat(40) };
  const result = validateFixtureCli(
    ["--role", "cup"],
    { LK1_SUBSCRIPTION_DEV_FIXTURE_CONFIG_FILE: "/srv/lk1-subscription-dev/private/fixture.json" },
    () => authorization,
  );
  assert.deepEqual(result, {
    mode: "SERVE",
    role: "cup",
    configPath: "/srv/lk1-subscription-dev/private/fixture.json",
    authorization,
  });
  const nodeRedAuthorization = validateFixtureCli(
    ["--validate-start-authorization", "--role", "nodered"],
    {},
    (role) => ({ role }),
  );
  assert.deepEqual(nodeRedAuthorization, {
    mode: "AUTHORIZATION_CHECK",
    role: "nodered",
    authorization: { role: "nodered" },
  });
  assert.throws(
    () => validateFixtureCli(["--role", "nodered"], {}, () => ({ exact: true })),
    (error) => error.code === "FIXTURE_CLI_INVALID",
  );
});

test("start authorization binds role, installed commit, manifest, and a one-hour validity window", () => {
  const env = installedIdentityEnv();
  const authorization = startAuthorization();
  assert.deepEqual(
    validateStartAuthorization("cup", env, NOW, () => JSON.stringify(authorization)),
    {
      sourceCommit: authorization.sourceCommit,
      runtimeManifestSha256: authorization.runtimeManifestSha256,
      expiresAt: authorization.expiresAt,
    },
  );
  for (const mutate of [
    (value) => { value.environment = "PROD"; },
    (value) => { value.sourceCommit = "4".repeat(40); },
    (value) => { value.runtimeManifestSha256 = "5".repeat(64); },
    (value) => { value.roles = ["cup"]; },
    (value) => { value.issuedAt = "2026-09-10T12:00:00.001Z"; },
    (value) => { value.expiresAt = "2026-09-10T12:00:00.000Z"; },
    (value) => { value.issuedAt = "2026-09-10T11:00:00.000Z"; value.expiresAt = "2026-09-10T12:00:00.001Z"; },
    (value) => { value.authorizationId = "short"; },
    (value) => { value.extra = true; },
  ]) {
    const changed = startAuthorization();
    mutate(changed);
    assert.throws(
      () => validateStartAuthorization("cup", env, NOW, () => JSON.stringify(changed)),
      (error) => error.code === "SERVICE_START_AUTHORIZATION_INVALID"
        || error.code === "FIXTURE_CONFIG_SCHEMA_INVALID",
    );
  }
  assert.throws(
    () => validateStartAuthorization("cup", {}, NOW, () => JSON.stringify(authorization)),
    (error) => error.code === "SERVICE_START_IDENTITY_UNBOUND",
  );
  assert.throws(
    () => validateStartAuthorization("cup", env, NOW, () => "not-json"),
    (error) => error.code === "SERVICE_START_CREDENTIAL_INVALID",
  );
  assert.throws(
    () => validateStartAuthorization(
      "cup",
      { ...env, LK1_SUBSCRIPTION_DEV_START_AUTHORIZATION_FILE: "/private/tmp/fabricated-credential" },
      NOW,
      () => JSON.stringify(authorization),
    ),
    (error) => error.code === "SERVICE_START_IDENTITY_UNBOUND",
  );
});

test("credential reader requires the exact root-owned group-read-only authorization file", () => {
  const directory = "/srv/lk1-subscription-dev/authorization";
  const credential = `${directory}/service-start.approved`;
  const directoryStat = {
    uid: 0,
    gid: 997,
    mode: 0o750,
    isDirectory: () => true,
    isFile: () => false,
    isSymbolicLink: () => false,
  };
  const srvStat = { ...directoryStat, gid: 0, mode: 0o755 };
  const appRootStat = { ...directoryStat, gid: 0, mode: 0o755 };
  const fileStat = {
    uid: 0,
    gid: 997,
    mode: 0o440,
    isDirectory: () => false,
    isFile: () => true,
    isSymbolicLink: () => false,
  };
  const fakeFs = {
    lstatSync: (target) => {
      if (target === "/srv") return srvStat;
      if (target === "/srv/lk1-subscription-dev") return appRootStat;
      if (target === directory) return directoryStat;
      if (target === credential) return fileStat;
      throw new Error(`unexpected lstat ${target}`);
    },
    realpathSync: (target) => target,
    readFileSync: () => `${JSON.stringify(startAuthorization())}\n`,
  };
  assert.equal(JSON.parse(readAuthorizationCredential(credential, fakeFs, 997)).environment, "DEV");

  for (const mutate of [
    (value) => { value.lstatSync = (target) => target === "/srv"
      ? { ...srvStat, uid: 501 }
      : fakeFs.lstatSync(target); },
    (value) => { value.realpathSync = (target) => target === directory
      ? "/private/tmp/forged-credentials"
      : target; },
    (value) => { value.lstatSync = (target) => target === credential
      ? { ...fileStat, isSymbolicLink: () => true }
      : fakeFs.lstatSync(target); },
    (value) => { value.lstatSync = (target) => target === credential
      ? { ...fileStat, mode: 0o640 }
      : fakeFs.lstatSync(target); },
    (value) => { value.lstatSync = (target) => target === credential
      ? { ...fileStat, uid: 501 }
      : fakeFs.lstatSync(target); },
    (value) => { value.lstatSync = (target) => target === directory
      ? { ...directoryStat, mode: 0o770 }
      : fakeFs.lstatSync(target); },
  ]) {
    const changed = { ...fakeFs };
    mutate(changed);
    assert.throws(
      () => readAuthorizationCredential(credential, changed, 997),
      (error) => error.code === "SERVICE_START_CREDENTIAL_CUSTODY_INVALID",
    );
  }
});

test("credential reader rejects user-owned temporary authorization material", () => {
  const parent = fs.mkdtempSync(path.join(TMP_ROOT, "lk1-start-credential-test-"));
  const credential = path.join(parent, "service-start.approved");
  try {
    fs.writeFileSync(credential, `${JSON.stringify(startAuthorization())}\n`, { mode: 0o600 });
    assert.throws(
      () => readAuthorizationCredential(parent),
      (error) => error.code === "SERVICE_START_CREDENTIAL_PATH_INVALID"
        || error.code === "SERVICE_START_CREDENTIAL_CUSTODY_INVALID"
        || error.code === "ENOENT",
    );
  } finally {
    fs.rmSync(parent, { recursive: true });
  }
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
    DEV_CUP_BASE_URL: "https://127.0.0.1:3037",
    allowedDevOrigins: ["http://127.0.0.1:1882", "https://127.0.0.1:3037"],
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

test("CUP managed reserve, replay, confirm, release, and activation are synthetic and exact", () => {
  const config = fixtureConfig();
  const state = createFixtureState(config);
  const reserve = (role, operationId) => request(
    config,
    "cup",
    "POST",
    "/api/internal/subscriptions/entitlements/reserve",
    role,
    {
      subscriptionInstanceId: config.subjects[role].subscriptionInstanceId,
      action: "CREATE_GAME",
      target: { targetId: config.subjects[role].managedTarget.targetId },
    },
    state,
    { "idempotency-key": operationId, "x-correlation-id": operationId },
  ).body;
  const operationA = "fixture-operation-entitlement-a";
  const first = reserve("A", operationA);
  const replay = reserve("A", operationA);
  assert.equal(first.outcome, "RESERVED");
  assert.equal(first.replayed, false);
  assert.equal(replay.replayed, true);
  assert.deepEqual(replay.decision.target, config.subjects.A.managedTarget);
  const confirmed = request(
    config,
    "cup",
    "POST",
    "/api/internal/subscriptions/entitlements/confirm",
    "A",
    { operationId: operationA, providerBookingId: "fixture-provider-booking-a" },
    state,
  ).body;
  assert.equal(confirmed.operationState, "CONFIRMED");
  assert.equal(reserve("A", operationA).operationState, "CONFIRMED");

  const operationB = "fixture-operation-entitlement-b";
  reserve("B", operationB);
  const released = request(
    config,
    "cup",
    "POST",
    "/api/internal/subscriptions/entitlements/release",
    "B",
    { operationId: operationB, reason: "PROVIDER_REJECTED" },
    state,
  ).body;
  assert.equal(released.operationState, "FAILED");

  const activated = request(
    config,
    "cup",
    "POST",
    "/api/internal/subscriptions/activate-first-use",
    "B",
    {
      subscriptionInstanceId: config.subjects.B.subscriptionInstanceId,
      clientSubscriptionId: config.subjects.B.clientSubscriptionId,
      providerBookingId: "fixture-provider-booking-b",
      expectedInstanceRevision: config.subjects.B.instanceRevision,
    },
    state,
  ).body;
  assert.equal(activated.outcome, "ACTIVATED");
  assert.equal(activated.state, "ACTIVE");
});

test("managed CUP contract denies control, idempotency conflicts, bad revisions, and unknown operations", () => {
  const config = fixtureConfig();
  const state = createFixtureState(config);
  const operationId = "fixture-operation-entitlement-a";
  const reserveBody = {
    subscriptionInstanceId: config.subjects.A.subscriptionInstanceId,
    action: "CREATE_GAME",
    target: { targetId: config.subjects.A.managedTarget.targetId },
  };
  request(
    config, "cup", "POST", "/api/internal/subscriptions/entitlements/reserve", "A",
    reserveBody, state, { "idempotency-key": operationId, "x-correlation-id": operationId },
  );
  assert.throws(() => request(
    config, "cup", "POST", "/api/internal/subscriptions/entitlements/reserve", "B",
    {
      ...reserveBody,
      subscriptionInstanceId: config.subjects.B.subscriptionInstanceId,
      target: { targetId: config.subjects.B.managedTarget.targetId },
    },
    state,
    { "idempotency-key": operationId, "x-correlation-id": operationId },
  ), (error) => error.code === "FIXTURE_IDEMPOTENCY_CONFLICT");
  assert.throws(() => request(
    config, "cup", "POST", "/api/internal/subscriptions/entitlements/reserve", "CONTROL",
    {
      subscriptionInstanceId: config.subjects.CONTROL.subscriptionInstanceId,
      action: "CREATE_GAME",
      target: { targetId: config.subjects.CONTROL.managedTarget.targetId },
    },
    state,
    { "idempotency-key": "fixture-operation-control", "x-correlation-id": "fixture-operation-control" },
  ), (error) => error.code === "FIXTURE_SUBJECT_NOT_FOUND");
  assert.throws(() => request(
    config, "cup", "POST", "/api/internal/subscriptions/entitlements/confirm", "A",
    { operationId: "fixture-operation-unknown", providerBookingId: "fixture-provider-booking-a" }, state,
  ), (error) => error.code === "FIXTURE_SUBJECT_NOT_FOUND");
  assert.throws(() => request(
    config, "cup", "POST", "/api/internal/subscriptions/activate-first-use", "B",
    {
      subscriptionInstanceId: config.subjects.B.subscriptionInstanceId,
      clientSubscriptionId: config.subjects.B.clientSubscriptionId,
      providerBookingId: "fixture-provider-booking-b",
      expectedInstanceRevision: config.subjects.B.instanceRevision - 1,
    }, state,
  ), (error) => error.code === "FIXTURE_ACTIVATION_REVISION_CONFLICT");
});

test("CUP managed contract is physically reachable on a fixture-owned loopback listener", async (t) => {
  const config = fixtureConfig();
  const tlsRoot = fs.mkdtempSync(path.join(TMP_ROOT, "lk1-fixture-tls-test-"));
  const keyFile = path.join(tlsRoot, "server.key");
  const certFile = path.join(tlsRoot, "server.crt");
  execFileSync("openssl", [
    "req", "-x509", "-newkey", "rsa:2048", "-nodes",
    "-keyout", keyFile, "-out", certFile, "-days", "1",
    "-subj", "/CN=127.0.0.1", "-addext", "subjectAltName=IP:127.0.0.1",
  ], { stdio: "ignore" });
  const tlsCredentials = {
    key: fs.readFileSync(keyFile),
    cert: fs.readFileSync(certFile),
  };
  const server = createFixtureServer("cup", config, tlsCredentials);
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  t.after(async () => {
    await new Promise((resolve, reject) => server.close((error) => (
      error ? reject(error) : resolve()
    )));
    fs.rmSync(tlsRoot, { recursive: true });
  });
  const address = server.address();
  const operationId = "fixture-network-entitlement-a";
  const headers = {
    authorization: config.subjects.A.auth,
    "x-subscriptions-integration-token": config.integrationToken,
    "x-correlation-id": operationId,
    "idempotency-key": operationId,
    "content-type": "application/json",
  };
  const requestBody = JSON.stringify({
      subscriptionInstanceId: config.subjects.A.subscriptionInstanceId,
      action: "CREATE_GAME",
      target: { targetId: config.subjects.A.managedTarget.targetId },
  });
  const response = await new Promise((resolve, reject) => {
    const networkRequest = https.request({
      hostname: "127.0.0.1",
      port: address.port,
      path: "/api/internal/subscriptions/entitlements/reserve",
      method: "POST",
      headers: { ...headers, "content-length": Buffer.byteLength(requestBody) },
      ca: tlsCredentials.cert,
      rejectUnauthorized: true,
    }, (networkResponse) => {
      const chunks = [];
      networkResponse.on("data", (chunk) => chunks.push(chunk));
      networkResponse.on("end", () => resolve({
        status: networkResponse.statusCode,
        json: () => JSON.parse(Buffer.concat(chunks).toString("utf8")),
      }));
    });
    networkRequest.once("error", reject);
    networkRequest.end(requestBody);
  });
  assert.equal(response.status, 200);
  const payload = response.json();
  assert.equal(payload.outcome, "RESERVED");
  assert.equal(payload.subscriptionInstanceId, config.subjects.A.subscriptionInstanceId);
});

test("TLS credential loader requires exact root-owned group-readable files", () => {
  const fakeStat = (kind, mode) => ({
    uid: 0,
    gid: kind === "directory" && mode === 0o755 ? 0 : 997,
    mode,
    isDirectory: () => kind === "directory",
    isFile: () => kind === "file",
    isSymbolicLink: () => false,
  });
  const fakeFs = {
    lstatSync: (target) => target === "/srv"
      ? fakeStat("directory", 0o755)
      : target.endsWith(".key") || target.endsWith(".crt")
        ? fakeStat("file", 0o440)
        : fakeStat("directory", target.endsWith("/tls") ? 0o750 : 0o755),
    realpathSync: (target) => target,
    readFileSync: (target) => Buffer.from(target.endsWith(".key") ? "test-key" : "test-cert"),
  };
  const credentials = loadFixtureTlsCredentials({
    LK1_SUBSCRIPTION_DEV_TLS_KEY_FILE: "/srv/lk1-subscription-dev/tls/server.key",
    LK1_SUBSCRIPTION_DEV_TLS_CERT_FILE: "/srv/lk1-subscription-dev/tls/server.crt",
  }, fakeFs, 997);
  assert.equal(credentials.key.toString(), "test-key");
  assert.equal(credentials.cert.toString(), "test-cert");
  assert.throws(() => loadFixtureTlsCredentials({
    LK1_SUBSCRIPTION_DEV_TLS_KEY_FILE: "/private/tmp/server.key",
    LK1_SUBSCRIPTION_DEV_TLS_CERT_FILE: "/srv/lk1-subscription-dev/tls/server.crt",
  }, fakeFs, 997), (error) => error.code === "FIXTURE_TLS_CREDENTIAL_PATH_INVALID");
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
        `msg.payload = { schemaVersion: 2, environment: 'DEV', sourceCommit: '${"1".repeat(40)}',`,
        `  candidateSha256: '${"1".repeat(64)}', manifestSha256: '${"1".repeat(64)}',`,
        `  hostReadbackSha256: '${"1".repeat(64)}', servedSha256: '${"1".repeat(64)}' };`,
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

test("minimal release route rejects nested target, rollback, and authority drift", () => {
  const flow = readJson(FLOW_PATH);
  const validate = new Function(
    "msg",
    flow.find((node) => node.id.endsWith("release-validate")).func,
  );
  const sourceOnly = readJson(path.join(
    ROOT, "scripts/lk1_subscription_dev_release_receipt_v2_contract.json",
  ));
  const served = {
    ...sourceOnly,
    state: "SERVED",
    hostReadbackSha256: sourceOnly.candidateSha256,
    servedSha256: sourceOnly.candidateSha256,
  };
  assert.equal(validate({ payload: JSON.stringify(served) }).statusCode, 200);
  for (const changed of [
    { ...served, authority: {} },
    { ...served, target: { ...served.target, hostAlias: "production" } },
    { ...served, rollback: { mode: "RETURN_TO_ABSENT", deleteData: false } },
  ]) {
    assert.equal(validate({ payload: JSON.stringify(changed) }).statusCode, 503);
  }
});

test("runtime source contract grants local bundle build only", () => {
  const contract = readJson(CONTRACT_PATH);
  assert.equal(validateRuntimeSourceContract(contract), true);
  assert.equal(
    contract.implementedContract.managedEntitlement,
    "SYNTHETIC_IN_MEMORY_SOURCE_IMPLEMENTED",
  );
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
