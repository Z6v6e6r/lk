import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import {
  FUNCTION_SOURCES,
  buildResidencyPassNodes,
  readFunctionSources,
  serializeNodes,
  validateResidencyPassNodes,
} from "../build_nodered_residency_pass_import.mjs";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const fnDir = path.join(repoRoot, "scripts/nodered_residency_pass_nodes");
const importPath = path.join(repoRoot, "node-red/imports/lk_residency_pass.import.json");
const sources = readFunctionSources(repoRoot);

const BEARER = ["Bearer", "test-user-token-value"].join(" ");
const INTEGRATION_TOKEN = "integration-token-value-0123456789abcdef";
const PASS_ID = "resident_pass:3f1c5c6e-1f2a-4b3c-8d9e-0a1b2c3d4e5f";
const SUBSCRIPTION_ID = "8f14e45f-ceea-4a67-a1f7-2b1c3d4e5f60";

function createContextStore() {
  const store = new Map();
  return {
    get: (key) => store.get(key),
    set: (key, value) => store.set(key, value),
    store,
  };
}

function runFunction(name, msg, options = {}) {
  const source = sources[name];
  assert.ok(source, `missing function source ${name}`);
  const warnings = [];
  const envValues = options.env ?? {
    RESIDENT_CLIENT_ENABLED: "true",
    RESIDENT_CLIENT_CUP_API_BASE_URL: "http://cup.internal:3010/api",
    RESIDENT_CLIENT_CUP_INTEGRATION_TOKEN: INTEGRATION_TOKEN,
    RESIDENT_CLIENT_CUP_PASS_STATUS_PATH: "/internal/subscriptions/resident-passes/",
  };
  const env = { get: (key) => (Object.hasOwn(envValues, key) ? envValues[key] : null) };
  const node = { warn: (value) => warnings.push(String(value)) };
  const flow = options.flow ?? createContextStore();
  const fn = new Function(
    "msg",
    "node",
    "context",
    "flow",
    "global",
    "env",
    "RED",
    "Buffer",
    `"use strict";\n${source}`,
  );
  const result = fn(msg, node, {}, flow, {}, env, {}, Buffer);
  return { result, warnings };
}

function baseMessage(overrides = {}) {
  return {
    req: {
      headers: { authorization: BEARER, "x-correlation-id": "corr-12345678" },
      body: { clientSubscriptionId: SUBSCRIPTION_ID },
      params: { passId: PASS_ID },
    },
    payload: { clientSubscriptionId: SUBSCRIPTION_ID },
    headers: {},
    ...overrides,
  };
}

function assertNoSecretsInJson(value, label) {
  const serialized = typeof value === "string" ? value : JSON.stringify(value);
  assert.ok(!serialized.includes(INTEGRATION_TOKEN), `${label} leaks the integration token`);
  assert.ok(!serialized.includes("test-user-token-value"), `${label} leaks the bearer`);
}

test("create prepare rejects a missing bearer without echoing it", () => {
  const msg = baseMessage({ req: { headers: {}, body: { clientSubscriptionId: SUBSCRIPTION_ID } } });
  const { result, warnings } = runFunction("fn_residency_pass_create_prepare.js", msg);
  const [continued, failed] = result;
  assert.equal(continued, null);
  assert.equal(failed.statusCode, 401);
  assert.equal(failed.payload.code, "RESIDENT_CLIENT_AUTH_REQUIRED");
  assert.equal(failed.headers["Cache-Control"], "no-store");
  assert.equal(failed.headers["Referrer-Policy"], "no-referrer");
  assertNoSecretsInJson(warnings, "create prepare warnings");
});

test("create prepare refuses a disabled gateway before any upstream call", () => {
  const { result } = runFunction("fn_residency_pass_create_prepare.js", baseMessage(), {
    env: { RESIDENT_CLIENT_ENABLED: "false" },
  });
  assert.equal(result[0], null);
  assert.equal(result[1].statusCode, 503);
  assert.equal(result[1].payload.code, "RESIDENT_CLIENT_DISABLED");
});

test("create prepare validates the exact body contract", () => {
  for (const body of [{}, { clientSubscriptionId: "not-a-uuid" }, { clientSubscriptionId: SUBSCRIPTION_ID, extra: 1 }]) {
    const msg = baseMessage({ payload: body, req: { headers: { authorization: BEARER }, body } });
    const { result } = runFunction("fn_residency_pass_create_prepare.js", msg);
    assert.equal(result[0], null);
    assert.equal(result[1].statusCode, 400, JSON.stringify(body));
    assert.equal(result[1].payload.code, "RESIDENT_CLIENT_REQUEST_INVALID");
  }
});

test("create prepare starts the Keycloak userinfo verification and scrubs the inbound bearer", () => {
  const msg = baseMessage();
  const { result } = runFunction("fn_residency_pass_create_prepare.js", msg);
  const continued = result[0];
  assert.ok(continued);
  assert.equal(continued.method, "GET");
  assert.match(continued.url, /userinfo$/);
  assert.equal(continued.headers.Authorization, BEARER);
  assert.equal(continued.headers["X-Resident-Services-Integration-Token"], undefined);
  assert.equal(continued._residentPass.endpoint, "create");
  assert.equal(continued.req.headers.authorization, undefined);
  assert.equal(continued.req.headers.Authorization, undefined);
  assert.deepEqual(continued.payload, null);
});

test("status prepare degrades to statusAvailable=false when CUP status path is not configured", () => {
  const { result } = runFunction("fn_residency_pass_status_prepare.js", baseMessage(), {
    env: { RESIDENT_CLIENT_ENABLED: "true" },
  });
  assert.equal(result[0], null);
  assert.equal(result[1].statusCode, 200);
  assert.deepEqual(
    { statusAvailable: result[1].payload.statusAvailable, state: result[1].payload.state },
    { statusAvailable: false, state: "UNKNOWN" },
  );
});

test("status prepare validates passId and status path configuration", () => {
  const badId = runFunction("fn_residency_pass_status_prepare.js", baseMessage({ req: { headers: { authorization: BEARER }, params: { passId: "pass:1" } } }));
  assert.equal(badId.result[1].statusCode, 400);
  const badPath = runFunction("fn_residency_pass_status_prepare.js", baseMessage(), {
    env: { RESIDENT_CLIENT_ENABLED: "true", RESIDENT_CLIENT_CUP_PASS_STATUS_PATH: "//evil.example/x/" },
  });
  assert.equal(badPath.result[1].statusCode, 503);
  assert.equal(badPath.result[1].payload.code, "RESIDENT_CLIENT_NOT_CONFIGURED");
});

test("authorize verifies client and tenant claims and maps upstream auth failures", () => {
  const unauthorized = runFunction("fn_residency_pass_authorize.js", {
    ...baseMessage(),
    statusCode: 401,
    _residentPass: { endpoint: "create", authorization: BEARER, startedAt: Date.now() },
  });
  assert.equal(unauthorized.result[1].statusCode, 401);

  const wrongClient = runFunction("fn_residency_pass_authorize.js", {
    ...baseMessage(),
    statusCode: 200,
    payload: { sub: "sub-1", azp: "another-client", tenantKey: "iSkq6G" },
    _residentPass: { endpoint: "create", authorization: BEARER, startedAt: Date.now() },
  });
  assert.equal(wrongClient.result[1].statusCode, 403);
  assert.equal(wrongClient.result[1].payload.code, "RESIDENT_CLIENT_FORBIDDEN");

  const wrongTenant = runFunction("fn_residency_pass_authorize.js", {
    ...baseMessage(),
    statusCode: 200,
    payload: { sub: "sub-1", azp: "widget", tenantKey: "other" },
    _residentPass: { endpoint: "create", authorization: BEARER, startedAt: Date.now() },
  });
  assert.equal(wrongTenant.result[1].statusCode, 403);
  assertNoSecretsInJson(wrongTenant.warnings, "authorize warnings");
});

test("authorize routes create requests to Viva and status requests to CUP without exposing the token", () => {
  const created = runFunction("fn_residency_pass_authorize.js", {
    ...baseMessage(),
    statusCode: 200,
    payload: { sub: "sub-1", azp: "widget", tenantKey: "iSkq6G" },
    _residentPass: { endpoint: "create", authorization: BEARER, correlationId: "corr-12345678", startedAt: Date.now() },
  });
  const createMsg = created.result[0];
  assert.ok(createMsg);
  assert.match(createMsg.url, /\/end-user\/api\/v1\/iSkq6G\/subscriptions\?includeFinished=false&size=100$/);
  assert.equal(createMsg.headers["X-Resident-Services-Integration-Token"], undefined);
  assert.equal(createMsg._residentPass.authorization, undefined);

  const status = runFunction("fn_residency_pass_authorize.js", {
    ...baseMessage(),
    statusCode: 200,
    payload: { sub: "sub-1", azp: "widget", tenantKey: "iSkq6G" },
    _residentPass: {
      endpoint: "status",
      authorization: BEARER,
      correlationId: "corr-12345678",
      passId: PASS_ID,
      statusPath: "/internal/subscriptions/resident-passes/",
      startedAt: Date.now(),
    },
  });
  const statusMsg = status.result[0];
  assert.ok(statusMsg);
  assert.equal(
    statusMsg.url,
    "http://cup.internal:3010/api/internal/subscriptions/resident-passes/" + encodeURIComponent(PASS_ID),
  );
  assert.equal(statusMsg.headers["X-Resident-Services-Integration-Token"], INTEGRATION_TOKEN);
  assert.equal(statusMsg.headers.Authorization, BEARER);
});

test("authorize rate limits pass creation but not status polling", () => {
  const flow = createContextStore();
  const ctx = {
    statusCode: 200,
    payload: { sub: "sub-1", azp: "widget", tenantKey: "iSkq6G" },
    _residentPass: { endpoint: "create", authorization: BEARER, correlationId: "corr-12345678", startedAt: Date.now() },
  };
  const env = {
    RESIDENT_CLIENT_ENABLED: "true",
    RESIDENT_CLIENT_RATE_LIMIT_PER_MINUTE: "1",
    RESIDENT_CLIENT_CUP_API_BASE_URL: "http://cup.internal:3010/api",
    RESIDENT_CLIENT_CUP_INTEGRATION_TOKEN: INTEGRATION_TOKEN,
  };
  const first = runFunction("fn_residency_pass_authorize.js", { ...baseMessage(), ...ctx }, { flow, env });
  assert.ok(first.result[0]);
  const second = runFunction("fn_residency_pass_authorize.js", { ...baseMessage(), ...ctx }, { flow, env });
  assert.equal(second.result[1].statusCode, 429);
  assert.equal(second.result[1].payload.code, "RESIDENT_CLIENT_RATE_LIMITED");

  const statusFlow = createContextStore();
  for (let index = 0; index < 5; index += 1) {
    const statusRun = runFunction("fn_residency_pass_authorize.js", {
      ...baseMessage(),
      statusCode: 200,
      payload: { sub: "sub-1", azp: "widget", tenantKey: "iSkq6G" },
      _residentPass: {
        endpoint: "status",
        authorization: BEARER,
        correlationId: "corr-12345678",
        passId: PASS_ID,
        statusPath: "/internal/subscriptions/resident-passes/",
        startedAt: Date.now(),
      },
    }, { flow: statusFlow, env });
    assert.ok(statusRun.result[0], "status polling must not be rate limited");
  }
});

test("resolve verifies subscription ownership and builds the CUP pass request", () => {
  const active = {
    subscriptionId: SUBSCRIPTION_ID,
    status: "ACTIVE",
    activationDate: "2026-01-01T00:00:00.000Z",
    expirationDate: "2027-01-01T00:00:00.000Z",
    holdUntil: null,
  };
  const context = {
    endpoint: "create",
    correlationId: "corr-12345678",
    clientSubscriptionId: SUBSCRIPTION_ID,
    authorization: BEARER,
    startedAt: Date.now(),
  };
  const { result, warnings } = runFunction("fn_residency_pass_resolve.js", {
    ...baseMessage(),
    statusCode: 200,
    payload: { content: [active] },
    _residentPass: context,
  });
  const cupMsg = result[0];
  assert.ok(cupMsg);
  assert.equal(cupMsg.method, "POST");
  assert.equal(cupMsg.url, "http://cup.internal:3010/api/internal/subscriptions/resident-passes");
  assert.deepEqual(cupMsg.payload, { clientSubscriptionId: SUBSCRIPTION_ID });
  assert.equal(cupMsg.headers["X-Resident-Services-Integration-Token"], INTEGRATION_TOKEN);
  assert.equal(cupMsg.headers.Authorization, BEARER);
  assert.equal(cupMsg._residentPass.authorization, undefined);
  assertNoSecretsInJson(warnings, "resolve warnings");
});

test("resolve rejects foreign, frozen and expired subscriptions", () => {
  const context = {
    endpoint: "create",
    correlationId: "corr-12345678",
    clientSubscriptionId: SUBSCRIPTION_ID,
    authorization: BEARER,
    startedAt: Date.now(),
  };
  const cases = [
    { content: [] },
    { content: [{ subscriptionId: "11111111-1111-4111-8111-111111111111", status: "ACTIVE" }] },
    { content: [{ subscriptionId: SUBSCRIPTION_ID, status: "ACTIVE", holdUntil: "2099-01-01T00:00:00.000Z" }] },
    { content: [{ subscriptionId: SUBSCRIPTION_ID, status: "ACTIVE", expirationDate: "2020-01-01T00:00:00.000Z" }] },
    { content: [{ subscriptionId: SUBSCRIPTION_ID, status: "CANCELLED" }] },
  ];
  for (const payload of cases) {
    const { result } = runFunction("fn_residency_pass_resolve.js", {
      ...baseMessage(),
      statusCode: 200,
      payload,
      _residentPass: { ...context },
    });
    assert.equal(result[0], null, JSON.stringify(payload));
    assert.equal(result[1].statusCode, 409, JSON.stringify(payload));
  }
  const frozen = runFunction("fn_residency_pass_resolve.js", {
    ...baseMessage(),
    statusCode: 200,
    payload: { content: [{ subscriptionId: SUBSCRIPTION_ID, status: "ACTIVE", holdUntil: "2099-01-01T00:00:00.000Z" }] },
    _residentPass: { ...context },
  });
  assert.equal(frozen.result[1].payload.code, "RESIDENT_CLIENT_SUBSCRIPTION_FROZEN");
});

test("resolve fails closed without CUP configuration", () => {
  const { result } = runFunction("fn_residency_pass_resolve.js", {
    ...baseMessage(),
    statusCode: 200,
    payload: { content: [{ subscriptionId: SUBSCRIPTION_ID, status: "ACTIVE" }] },
    _residentPass: { endpoint: "create", clientSubscriptionId: SUBSCRIPTION_ID, authorization: BEARER, startedAt: Date.now() },
  }, { env: { RESIDENT_CLIENT_ENABLED: "true" } });
  assert.equal(result[1].statusCode, 503);
  assert.equal(result[1].payload.code, "RESIDENT_CLIENT_NOT_CONFIGURED");
});

test("create response returns only allowlisted pass fields", () => {
  const upstreamPayload = {
    schemaVersion: 1,
    passId: PASS_ID,
    token: "rsp1_abcdefghijklmnopqrstuvwxyz012345",
    issuedAt: "2026-11-05T10:00:00.000Z",
    expiresAt: "2026-11-05T10:02:00.000Z",
    subscriptionInstanceId: "subscription_instance:5f1c5c6e-1f2a-4b3c-8d9e-0a1b2c3d4e5f",
    residency: {
      subscriptionTypeId: "type-1",
      subscriptionTypeTitle: "Резидент",
      activeFrom: "2026-01-01T00:00:00.000Z",
      activeTo: "2027-01-01T00:00:00.000Z",
    },
    // Fields from an upstream implementation detail must never reach the browser.
    integrationToken: INTEGRATION_TOKEN,
    clientRefHash: "sha256:deadbeef",
  };
  const { result, warnings } = runFunction("fn_residency_pass_create_response.js", {
    ...baseMessage(),
    statusCode: 200,
    payload: JSON.stringify(upstreamPayload),
    _residentPass: { endpoint: "create", startedAt: Date.now() },
  });
  assert.equal(result.statusCode, 200);
  assert.equal(result.payload.passToken, "rsp1_abcdefghijklmnopqrstuvwxyz012345");
  assert.equal(result.payload.passId, PASS_ID);
  assert.deepEqual(Object.keys(result.payload).sort(), [
    "expiresAt",
    "issuedAt",
    "passId",
    "passToken",
    "residency",
    "schemaVersion",
    "subscriptionInstanceId",
  ]);
  assert.equal(result.payload._residentPass, undefined);
  assertNoSecretsInJson(result.payload, "create response payload");
  assert.equal(result.headers["Cache-Control"], "no-store");
  assert.equal(result.headers["Referrer-Policy"], "no-referrer");
  assertNoSecretsInJson(warnings, "create response warnings");
});

test("create response maps CUP errors to stable client codes", () => {
  const evidenceStale = runFunction("fn_residency_pass_create_response.js", {
    ...baseMessage(),
    statusCode: 503,
    payload: JSON.stringify({ error: { code: "RESIDENT_EVIDENCE_STALE", message: "internal detail", correlationId: "corr:cup" } }),
    _residentPass: { endpoint: "create", startedAt: Date.now() },
  });
  assert.equal(evidenceStale.result.statusCode, 503);
  assert.equal(evidenceStale.result.payload.code, "RESIDENT_EVIDENCE_STALE");
  assert.equal(evidenceStale.result.payload.message, "Не удалось выдать пропуск");

  const unknown = runFunction("fn_residency_pass_create_response.js", {
    ...baseMessage(),
    statusCode: 500,
    payload: JSON.stringify({ error: { code: "SOMETHING_ELSE", message: "boom" } }),
    _residentPass: { endpoint: "create", startedAt: Date.now() },
  });
  assert.equal(unknown.result.statusCode, 503);
  assert.equal(unknown.result.payload.code, "RESIDENT_CLIENT_UPSTREAM_UNAVAILABLE");

  const timeout = runFunction("fn_residency_pass_create_response.js", {
    ...baseMessage(),
    error: new Error("socket hang up"),
    payload: null,
    _residentPass: { endpoint: "create", startedAt: Date.now() },
  });
  assert.equal(timeout.result.statusCode, 504);
  assert.equal(timeout.result.payload.code, "RESIDENT_CLIENT_UPSTREAM_TIMEOUT");
});

test("create response rejects malformed upstream payloads", () => {
  const { result } = runFunction("fn_residency_pass_create_response.js", {
    ...baseMessage(),
    statusCode: 200,
    payload: JSON.stringify({ passId: "resident_pass:not-a-uuid", token: "x" }),
    _residentPass: { endpoint: "create", startedAt: Date.now() },
  });
  assert.equal(result.statusCode, 503);
  assert.equal(result.payload.code, "RESIDENT_CLIENT_UPSTREAM_INVALID");
});

test("status response maps CONSUMED and rejects unknown states", () => {
  const consumed = runFunction("fn_residency_pass_status_response.js", {
    ...baseMessage(),
    statusCode: 200,
    payload: JSON.stringify({
      schemaVersion: 1,
      passId: PASS_ID,
      state: "CONSUMED",
      issuedAt: "2026-11-05T10:00:00.000Z",
      expiresAt: "2026-11-05T10:02:00.000Z",
      consumedAt: "2026-11-05T10:01:00.000Z",
      stationId: "station-1",
    }),
    _residentPass: { endpoint: "status", startedAt: Date.now() },
  });
  assert.equal(consumed.result.statusCode, 200);
  assert.deepEqual(consumed.result.payload, {
    schemaVersion: 1,
    statusAvailable: true,
    state: "CONSUMED",
    issuedAt: "2026-11-05T10:00:00.000Z",
    expiresAt: "2026-11-05T10:02:00.000Z",
    consumedAt: "2026-11-05T10:01:00.000Z",
    stationId: "station-1",
  });

  const invalid = runFunction("fn_residency_pass_status_response.js", {
    ...baseMessage(),
    statusCode: 200,
    payload: JSON.stringify({ state: "PWNED" }),
    _residentPass: { endpoint: "status", startedAt: Date.now() },
  });
  assert.equal(invalid.result.statusCode, 503);
  assert.equal(invalid.result.payload.code, "RESIDENT_CLIENT_UPSTREAM_INVALID");

  const notFound = runFunction("fn_residency_pass_status_response.js", {
    ...baseMessage(),
    statusCode: 404,
    payload: JSON.stringify({ error: { code: "RESIDENT_PASS_NOT_FOUND" } }),
    _residentPass: { endpoint: "status", startedAt: Date.now() },
  });
  assert.equal(notFound.result.statusCode, 404);
  assert.equal(notFound.result.payload.code, "RESIDENT_PASS_NOT_FOUND");
});

test("options preflight allows only the browser contract headers", () => {
  const { result } = runFunction("fn_residency_pass_options.js", {});
  assert.equal(result.statusCode, 204);
  assert.equal(result.headers["Access-Control-Allow-Methods"], "GET, POST, OPTIONS");
  assert.equal(result.headers["Access-Control-Allow-Headers"], "Authorization, Content-Type, X-Correlation-Id");
  assert.ok(!JSON.stringify(result.headers).includes("Integration-Token"));
});

test("import JSON is generated from the tracked sources and validates", () => {
  const nodes = buildResidencyPassNodes(sources);
  assert.deepEqual(validateResidencyPassNodes(nodes, sources), []);
  const serialized = serializeNodes(nodes);
  const onDisk = fs.readFileSync(importPath, "utf8");
  assert.equal(serialized, onDisk, "node-red/imports/lk_residency_pass.import.json is out of date");
  const sha256 = crypto.createHash("sha256").update(onDisk).digest("hex");
  assert.match(sha256, /^[a-f0-9]{64}$/);
  for (const name of FUNCTION_SOURCES) {
    assert.ok(onDisk.includes(JSON.stringify(sources[name]).slice(1, -1)) || onDisk.includes(EJSON(sources[name])),
      `import does not inline ${name}`);
  }
  const parsed = JSON.parse(onDisk);
  // POST create + OPTIONS create + GET status + OPTIONS status: both browser routes preflight.
  assert.equal(parsed.filter((node) => node.type === "http in").length, 4);
  assert.equal(parsed.filter((node) => node.type === "http response").length, 1);
  assert.ok(!onDisk.includes("console.log"));
  assert.ok(!onDisk.includes(INTEGRATION_TOKEN));
});

// JSON.stringify(sources) escapes exactly like the serialized import, so the inlining check above
// compares against the escaped form for readability.
function EJSON(value) {
  return JSON.stringify(value);
}

test("every function source that handles secrets avoids logging helpers that could leak", () => {
  for (const name of FUNCTION_SOURCES) {
    const source = sources[name];
    assert.ok(!/console\.(log|warn|error)\(/.test(source), `${name} uses console`);
    assert.ok(!/node\.warn\(\s*msg\./.test(source), `${name} logs msg`);
    assert.ok(!/node\.warn\([^)]*JSON\.stringify\(msg/.test(source), `${name} logs the full msg`);
  }
});

test("gateway sources never read the integration token from a request", () => {
  for (const name of FUNCTION_SOURCES) {
    const source = fs.readFileSync(path.join(fnDir, name), "utf8");
    assert.ok(!/req[^\n]*RESIDENT_CLIENT_CUP_INTEGRATION_TOKEN/.test(source), `${name} reads the token from the request`);
    assert.ok(!/headers\[[^\]]*integration-token[^\]]*\]/i.test(source.replace(/readEnv/g, "")), `${name} copies a client integration token`);
  }
});
