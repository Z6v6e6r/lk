import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);
const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const nodeSource = fs.readFileSync(path.join(repoRoot, "node-red/custom-nodes/residency-lifecycle-api/residency-lifecycle-node.cjs"), "utf8");
const helpers = require(path.join(repoRoot, "node-red/custom-nodes/residency-lifecycle-api/residency-lifecycle-node.cjs"));
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

test("bearer parsing is strict and never echoes the token", () => {
  assert.equal(helpers.bearer({ headers: { authorization: "Bearer " + "a".repeat(32) } }), "a".repeat(32));
  for (const value of [undefined, "", "Bearer short", "Basic " + "a".repeat(32), "Bearer " + "a".repeat(32) + "\n"]) {
    assert.equal(helpers.bearer({ headers: { authorization: value } }), null);
  }
});

test("claims require the exact client and tenant", () => {
  const claims = { sub: "user-1", azp: "widget", tenant_key: "iSkq6G" };
  assert.deepEqual(helpers.validateClaims(claims, "widget", "iSkq6G"), { userId: "user-1", tenantId: "iSkq6G" });
  assert.equal(helpers.validateClaims({ ...claims, azp: "other" }, "widget", "iSkq6G"), null);
  assert.equal(helpers.validateClaims({ ...claims, tenant_key: "other" }, "widget", "iSkq6G"), null);
  assert.equal(helpers.validateClaims({ ...claims, sub: "" }, "widget", "iSkq6G"), null);
  assert.equal(helpers.validateClaims(null, "widget", "iSkq6G"), null);
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
    "GET /lk/residency/status", "OPTIONS /lk/residency/catalog", "OPTIONS /lk/residency/orders",
    "OPTIONS /lk/residency/orders/:orderId", "OPTIONS /lk/residency/orders/:orderId/cancel",
    "OPTIONS /lk/residency/orders/:orderId/payment", "OPTIONS /lk/residency/orders/:orderId/reconcile",
    "OPTIONS /lk/residency/status", "POST /lk/residency/orders",
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