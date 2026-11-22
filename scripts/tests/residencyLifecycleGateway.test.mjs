import assert from "node:assert/strict";
import { generateKeyPairSync, sign } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);
const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const nodeSource = fs.readFileSync(path.join(repoRoot, "node-red/custom-nodes/residency-lifecycle-api/residency-lifecycle-node.cjs"), "utf8");
const helpers = require(path.join(repoRoot, "node-red/custom-nodes/residency-lifecycle-api/residency-lifecycle-node.cjs"));
const { createVivaAccessVerifier, resolveVivaActor } = require(path.join(repoRoot, "node-red/custom-nodes/residency-lifecycle-api/lib/viva-keycloak-access.cjs"));
const importJson = JSON.parse(fs.readFileSync(path.join(repoRoot, "node-red/imports/lk_residency_lifecycle.import.json"), "utf8"));
const { RESIDENCY_LIFECYCLE_INDEXES } = await import(path.join(repoRoot, "node-red/custom-nodes/residency-lifecycle-api/lib/residency-lifecycle-store.mjs"));

function env(values) {
  return { get: (name) => (Object.hasOwn(values, name) ? values[name] : undefined) };
}

test("config is disabled by default and requires storage when enabled", () => {
  assert.equal(helpers.readConfig(env({})).enabled, false);
  const enabled = helpers.readConfig(env({ LK_RESIDENCY_LIFECYCLE_ENABLED: "true", LK_RESIDENCY_LIFECYCLE_MONGO_URI: "mongodb://127.0.0.1:27017", LK_RESIDENCY_LIFECYCLE_MONGO_DB: "lk" }));
  assert.equal(enabled.enabled, true);
  assert.equal(enabled.tenantKey, "iSkq6G");
  assert.equal(enabled.productId, "4037a3a3-e551-4f9a-a9db-1410e46b8635");
  assert.equal(enabled.rateLimit, 20);
  assert.equal(helpers.readConfig(env({ LK_RESIDENCY_LIFECYCLE_RATE_LIMIT_PER_MINUTE: "500" })).rateLimit, 120);
  // The cross-path guard is on by default: an unread provider list must not release a
  // second financial command. It can only be disabled explicitly for a non-production run.
  assert.equal(helpers.readConfig(env({})).externalGuard, true);
  assert.equal(helpers.readConfig(env({ LK_RESIDENCY_LIFECYCLE_EXTERNAL_GUARD: "false" })).externalGuard, false);
  assert.equal(helpers.readConfig(env({})).externalLookbackMs, 30 * 86400000);
  assert.equal(helpers.readConfig(env({ LK_RESIDENCY_LIFECYCLE_EXTERNAL_LOOKBACK_MS: "86400000" })).externalLookbackMs, 86400000);
  assert.equal(helpers.readConfig(env({})).identityLog, false);
  assert.equal(helpers.readConfig(env({ LK_RESIDENCY_LIFECYCLE_IDENTITY_LOG: "true" })).identityLog, true);
});

test("personal pilot create settings are closed by default and bound to the verified tenant", () => {
  const defaults = helpers.readConfig(env({}));
  assert.equal(defaults.createEnabled, false);
  assert.equal(defaults.createAudience, "pilot");
  assert.equal(defaults.pilotUsers instanceof Set, true);
  assert.equal(defaults.pilotUsers.size, 0);
  assert.equal(defaults.pilotUsersError, null);

  const allowed = helpers.readConfig(env({
    LK_RESIDENCY_LIFECYCLE_CREATE_ENABLED: "true",
    LK_RESIDENCY_LIFECYCLE_CREATE_AUDIENCE: "pilot",
    LK_RESIDENCY_LIFECYCLE_PILOT_USERS: JSON.stringify(["iSkq6G:pilot-user"]),
  }));
  assert.equal(allowed.createEnabled, true);
  assert.equal(allowed.pilotUsers.has("iSkq6G:pilot-user"), true);
  assert.equal(allowed.pilotUsersError, null);

  const wrongTenant = helpers.readConfig(env({ LK_RESIDENCY_LIFECYCLE_PILOT_USERS: JSON.stringify(["other:pilot-user"]) }));
  assert.equal(wrongTenant.pilotUsers, null);
  assert.equal(wrongTenant.pilotUsersError, "PILOT_USERS");
  for (const raw of ["not-json", "[]", JSON.stringify(["no-tenant"]), JSON.stringify(["iSkq6G:"]), JSON.stringify(["iSkq6G:a", "iSkq6G:a"])]) {
    assert.equal(helpers.readConfig(env({ LK_RESIDENCY_LIFECYCLE_PILOT_USERS: raw })).pilotUsersError, "PILOT_USERS");
  }
  assert.equal(helpers.readConfig(env({ LK_RESIDENCY_LIFECYCLE_CREATE_AUDIENCE: "everyone" })).createAudience, null);

  // A broken personal list must not block servicing an existing order: the runtime
  // configuration check only covers storage/provider/URLs, not the create audience.
  const base = { LK_RESIDENCY_LIFECYCLE_ENABLED: "true", LK_RESIDENCY_LIFECYCLE_MONGO_URI: "mongodb://127.0.0.1:27017",
    LK_RESIDENCY_LIFECYCLE_MONGO_DB: "lk", LK_RESIDENCY_LIFECYCLE_CUP_API_URL: "https://cup.example/api",
    LK_RESIDENCY_LIFECYCLE_CUP_INTEGRATION_TOKEN: "t".repeat(40), LK_RESIDENCY_LIFECYCLE_PILOT_USERS: "broken" };
  assert.equal(helpers.runtimeConfigError(helpers.readConfig(env(base))), null);
});

test("runtime configuration fails closed before any request", () => {
  const base = { LK_RESIDENCY_LIFECYCLE_ENABLED: "true", LK_RESIDENCY_LIFECYCLE_MONGO_URI: "mongodb://127.0.0.1:27017",
    LK_RESIDENCY_LIFECYCLE_MONGO_DB: "lk", LK_RESIDENCY_LIFECYCLE_CUP_API_URL: "https://cup.example/api",
    LK_RESIDENCY_LIFECYCLE_CUP_INTEGRATION_TOKEN: "t".repeat(40) };
  assert.equal(helpers.runtimeConfigError(helpers.readConfig(env(base))), null);
  assert.equal(helpers.runtimeConfigError(helpers.readConfig(env({ ...base, LK_RESIDENCY_LIFECYCLE_MONGO_URI: "" }))), "STORAGE");
  assert.equal(helpers.runtimeConfigError(helpers.readConfig(env({ ...base, LK_RESIDENCY_LIFECYCLE_CUP_API_URL: "http://cup" }))), "CUP");
  assert.equal(helpers.runtimeConfigError(helpers.readConfig(env({ ...base, LK_RESIDENCY_LIFECYCLE_CUP_INTEGRATION_TOKEN: "short" }))), "CUP");
  assert.equal(helpers.runtimeConfigError(helpers.readConfig(env({ ...base, LK_RESIDENCY_LIFECYCLE_KEYCLOAK_USERINFO_URL: "http://kc" }))), "KEYCLOAK_URL");
});

test("a running pilot policy reads the file again, fails closed and separates preview from create", async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "lk-residency-access-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const control = path.join(dir, "mode");
  const config = helpers.readConfig(env({
    LK_RESIDENCY_LIFECYCLE_PILOT_CONTROL_FILE: control,
    LK_RESIDENCY_LIFECYCLE_CREATE_ENABLED: "true",
    LK_RESIDENCY_LIFECYCLE_PILOT_USERS: JSON.stringify(["iSkq6G:pilot-user"]),
  }));
  const policies = helpers.createAdmissionPolicies(config);
  const pilot = { tenantId: "iSkq6G", userId: "pilot-user" };
  const setMode = (mode) => {
    fs.writeFileSync(control + ".next", mode + "\n");
    fs.renameSync(control + ".next", control);
  };

  assert.equal((await policies.pilotPolicy(pilot)).code, "RESIDENCY_PILOT_CLOSED");
  setMode("preview");
  assert.deepEqual(await policies.pilotPolicy(pilot), { allowed: true, canCreate: false });
  assert.equal((await policies.createPolicy(pilot)).code, "RESIDENCY_ORDERS_DISABLED");
  assert.equal((await policies.pilotPolicy({ ...pilot, userId: "ordinary-user" })).statusCode, 403);
  assert.equal((await policies.pilotPolicy({ ...pilot, tenantId: "other" })).statusCode, 403);
  setMode("checkout");
  assert.deepEqual(await policies.pilotPolicy(pilot), { allowed: true, canCreate: true });
  assert.equal((await policies.createPolicy(pilot)).allowed, true);
  const previewOnly = helpers.createAdmissionPolicies({ ...config, createEnabled: false });
  assert.deepEqual(await previewOnly.pilotPolicy(pilot), { allowed: true, canCreate: false });
  assert.equal((await previewOnly.createPolicy(pilot)).allowed, false);
  for (const value of ["off", "on", "checkout "]) {
    setMode(value);
    assert.equal((await policies.pilotPolicy(pilot)).allowed, false);
    assert.equal((await policies.createPolicy(pilot)).allowed, false);
  }
  fs.renameSync(control, control + ".actual");
  fs.symlinkSync(control + ".actual", control);
  fs.writeFileSync(control + ".actual", "checkout\n");
  assert.equal((await policies.pilotPolicy(pilot)).allowed, false);
});

test("bearer parsing is strict and never echoes the token", () => {
  assert.equal(helpers.bearer({ headers: { authorization: "Bearer " + "a".repeat(32) } }), "a".repeat(32));
  for (const value of [undefined, "", "Bearer short", "Basic " + "a".repeat(32), "Bearer " + "a".repeat(32) + "\n"]) {
    assert.equal(helpers.bearer({ headers: { authorization: value } }), null);
  }
});

test("explicit UserInfo claims require the exact client and tenant without a token fallback", async () => {
  const claims = { sub: "user-1", azp: "widget", tenant_key: "iSkq6G" };
  const resolve = (userinfo) => resolveVivaActor(userinfo, "", "widget", "iSkq6G", () => assert.fail("Unexpected fallback"));
  assert.deepEqual(await resolve(claims), { userId: "user-1", tenantId: "iSkq6G" });
  for (const userinfo of [null, { ...claims, azp: "other" }, { ...claims, client_id: "other" },
    { ...claims, azp: undefined }, { ...claims, tenant_key: "other" }, { ...claims, sub: "" }]) {
    assert.equal(await resolve(userinfo), null);
  }
});

test("client-omitting UserInfo only resolves with a matching signed widget access token", async () => {
  const { publicKey, privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
  const issuer = "https://kc.vivacrm.ru/realms/clients";
  const jwk = { ...publicKey.export({ format: "jwk" }), kid: "fixture-rsa", use: "sig", alg: "RS256" };
  const now = Math.floor(Date.now() / 1000);
  const actor = { userId: "user-1", tenantId: "iSkq6G" };
  const userinfo = { sub: actor.userId, tenant_key: actor.tenantId };
  let fetches = 0;
  const fetchKeys = async (url, options) => {
    fetches++;
    assert.equal(url, issuer + "/protocol/openid-connect/certs");
    assert.equal(options.redirect, "error");
    assert.deepEqual(options.headers, { Accept: "application/json" });
    return { status: 200, text: async () => JSON.stringify({ keys: [jwk] }) };
  };
  const verifyAccess = createVivaAccessVerifier(fetchKeys);
  const encode = (value) => Buffer.from(JSON.stringify(value)).toString("base64url");
  const token = (overrides = {}, header = {}) => {
    const content = encode({ alg: "RS256", kid: jwk.kid, ...header }) + "." + encode({
      iss: issuer, sub: actor.userId, azp: "widget", typ: "Bearer", aud: "account", exp: now + 120, ...overrides,
    });
    return content + "." + sign("RSA-SHA256", Buffer.from(content), privateKey).toString("base64url");
  };
  const resolve = (accessToken, verifier = verifyAccess) => resolveVivaActor(userinfo, accessToken, "widget", actor.tenantId, verifier);
  assert.deepEqual(await resolve(token()), actor);
  assert.deepEqual(await resolve(token({ tenant_key: actor.tenantId })), actor);
  for (const overrides of [{ iss: "https://other.example/realms/clients" }, { sub: "someone-else" },
    { azp: "other" }, { tenant_key: "other" }, { exp: now - 1 }, { nbf: now + 600 }, { typ: "Refresh" }]) {
    assert.equal(await resolve(token(overrides)), null);
  }
  const [header, , signature] = token().split(".");
  const altered = encode({ iss: issuer, sub: actor.userId, azp: "widget", typ: "Bearer", exp: now + 600 });
  assert.equal(await resolve([header, altered, signature].join(".")), null);
  assert.equal(await resolve(token({}, { kid: "unknown" })), null);
  assert.equal(fetches, 1);
  assert.equal(await resolve(token(), createVivaAccessVerifier(async () => ({ status: 503 }))), null);
});

test("userinfo reads only a bounded 200 JSON response", async () => {
  const ok = await helpers.readUserinfo(async () => ({ status: 200, async text() { return JSON.stringify({ sub: "user-1" }); } }), "https://kc.example/userinfo", "a".repeat(32), 1000);
  assert.equal(ok.sub, "user-1");
  for (const response of [{ status: 401, async text() { return "{}"; } }, { status: 200, async text() { return "not-json"; } },
    { status: 200, async text() { return "x".repeat(70000); } }]) {
    assert.equal(await helpers.readUserinfo(async () => response, "https://kc.example/userinfo", "a".repeat(32), 1000), null);
  }
});

test("the import exposes the exact routes and no reverse-proxy or token material", () => {
  const routes = importJson.filter((node) => node.type === "http in").map((node) => node.method.toUpperCase() + " " + node.url).sort();
  assert.deepEqual(routes, [
    "GET /lk/residency/catalog", "GET /lk/residency/orders", "GET /lk/residency/orders/:orderId", "GET /lk/residency/orders/:orderId/payment",
    "GET /lk/residency/status", "GET /lk/residency/pilot-access", "OPTIONS /lk/residency/catalog", "OPTIONS /lk/residency/orders",
    "OPTIONS /lk/residency/orders/:orderId", "OPTIONS /lk/residency/orders/:orderId/cancel",
    "OPTIONS /lk/residency/orders/:orderId/payment", "OPTIONS /lk/residency/orders/:orderId/reconcile",
    "OPTIONS /lk/residency/status", "OPTIONS /lk/residency/pilot-access", "POST /lk/residency/orders",
    "POST /lk/residency/orders/:orderId/cancel", "POST /lk/residency/orders/:orderId/reconcile",
  ].sort());
  assert.equal(new Set(importJson.map((node) => node.id)).size, importJson.length);
  assert.equal(importJson.filter((node) => node.type === "padlhub-residency-lifecycle-http").length, 1);
  assert.equal(importJson.filter((node) => node.type === "padlhub-residency-lifecycle-store").length, 1);
  assert.equal(importJson.filter((node) => node.type === "http response").length, 1);
  const serialized = JSON.stringify(importJson);
  assert.ok(!serialized.includes("Authorization"));
  assert.ok(!serialized.includes("cupIntegrationToken"));
  assert.ok(!serialized.includes("vivacrm_access_token"));
  assert.ok(!serialized.includes("Bearer "));
});

test("node source never logs secrets or uses console", () => {
  assert.ok(!/console\.(log|error|warn|info|debug)\(/.test(nodeSource));
  assert.ok(!/token\s*[:=]\s*["'][A-Za-z0-9+/=]{16,}/.test(nodeSource));
  assert.ok(nodeSource.includes("node.warn(JSON.stringify({ event:"));
});

test("index contract covers identity and idempotency uniqueness", () => {
  const names = RESIDENCY_LIFECYCLE_INDEXES.map((index) => index.options.name);
  assert.deepEqual(names, ["residency_order_identity", "residency_order_idempotency", "residency_order_active_slot", "residency_order_user_state", "residency_order_expiry"]);
  assert.equal(RESIDENCY_LIFECYCLE_INDEXES[0].options.unique, true);
  assert.equal(RESIDENCY_LIFECYCLE_INDEXES[1].options.unique, true);
});

test("the Node-RED boundary handles OPTIONS before auth and passes the verified actor", async () => {
  const calls = [];
  const flowStore = new Map();
  const RED = { nodes: {
    createNode(node) {
      node.context = () => ({ global: { get: () => "s".repeat(32) },
        flow: { get: (key) => flowStore.get(key), set: (key, value) => flowStore.set(key, value) } });
      node.warn = (value) => calls.push(["warn", value]);
      node.on = () => {};
    },
    registerType: () => {},
  } };
  helpers(RED);
  const node = new helpers.ResidencyLifecycleStoreNode({ enabledEnv: "ENABLED", mongoUriEnv: "URI", databaseNameEnv: "DB" });
  const api = { async handle(request) {
    calls.push(["handle", request.method, request.path, request.actor?.userId || null]);
    if (request.method === "OPTIONS") return { statusCode: 204, headers: {}, body: null };
    return { statusCode: 200, headers: {}, body: { userId: request.actor.userId } };
  } };
  node.getRuntime = async () => ({ api, config: { rateLimit: 20, allowOrigin: "*", keycloakUserinfoUrl: "https://kc.example/userinfo",
    expectedClientId: "widget", tenantKey: "iSkq6G", timeoutMs: 1000 }, collection: {} });

  const options = await node.handleHttpMessage({ req: { method: "OPTIONS", originalUrl: "/lk/residency/orders", headers: {} } });
  assert.equal(options.statusCode, 204);
  assert.deepEqual(calls, [["handle", "OPTIONS", "/lk/residency/orders", null]]);

  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => ({ status: 200, async text() { return JSON.stringify({ sub: "user-1", azp: "widget", tenant_key: "iSkq6G" }); } });
  try {
    const result = await node.handleHttpMessage({ req: { method: "GET", originalUrl: "/lk/residency/catalog",
      headers: { authorization: "Bearer " + "a".repeat(32) } }, payload: {} });
    assert.equal(result.statusCode, 200);
    assert.equal(result.body.userId, "user-1");
    const denied = await node.handleHttpMessage({ req: { method: "GET", originalUrl: "/lk/residency/catalog", headers: {} } });
    assert.equal(denied.statusCode, 401);
  } finally { globalThis.fetch = originalFetch; }
});
