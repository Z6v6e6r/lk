"use strict";

// Node-RED transport for the LK1 residency lifecycle.
//
// The node is a thin boundary: it verifies the LK bearer, builds the Viva/CUP/Mongo
// adapters, and delegates every decision to the lifecycle + HTTP contract modules.
// It never logs a token, phone, provider id, order id or raw provider body.

const crypto = require("node:crypto");
const DEFAULT_VIVA = "https://api.vivacrm.ru";
const DEFAULT_KEYCLOAK = "https://kc.vivacrm.ru/realms/clients/protocol/openid-connect/userinfo";
const DEFAULT_PRODUCT = "4037a3a3-e551-4f9a-a9db-1410e46b8635";
const COLLECTION = "lk_residency_lifecycle_orders";

const text = (value, max = 4096) => typeof value === "string" && value.length > 0 && value.length <= max
  && value.trim() === value && !Array.from(value).some((ch) => ch.charCodeAt(0) < 32 || ch.charCodeAt(0) === 127);

function readEnv(env, name, fallback) {
  const value = env && typeof env.get === "function" ? env.get(name) : env ? env[name] : undefined;
  return typeof value === "string" && value.trim() ? value.trim() : fallback;
}

function readConfig(env) {
  const enabled = readEnv(env, "LK_RESIDENCY_LIFECYCLE_ENABLED", "false") === "true";
  const vivaBaseUrl = readEnv(env, "LK_RESIDENCY_LIFECYCLE_VIVA_API_URL", DEFAULT_VIVA);
  const cupBaseUrl = readEnv(env, "LK_RESIDENCY_LIFECYCLE_CUP_API_URL", "");
  const cupIntegrationToken = readEnv(env, "LK_RESIDENCY_LIFECYCLE_CUP_INTEGRATION_TOKEN", "");
  const successUrl = readEnv(env, "LK_RESIDENCY_LIFECYCLE_SUCCESS_URL", "https://lk2.padlhub.su/user/api/v1/subscription-payment-return");
  const failUrl = readEnv(env, "LK_RESIDENCY_LIFECYCLE_FAIL_URL", successUrl);
  const tenantKey = readEnv(env, "LK_RESIDENCY_LIFECYCLE_TENANT_KEY", "iSkq6G");
  const productId = readEnv(env, "LK_RESIDENCY_LIFECYCLE_PRODUCT_ID", DEFAULT_PRODUCT);
  const expectedClientId = readEnv(env, "LK_RESIDENCY_LIFECYCLE_EXPECTED_CLIENT_ID", "widget");
  const keycloakUserinfoUrl = readEnv(env, "LK_RESIDENCY_LIFECYCLE_KEYCLOAK_USERINFO_URL", DEFAULT_KEYCLOAK);
  const allowOrigin = readEnv(env, "LK_RESIDENCY_LIFECYCLE_ALLOW_ORIGIN", "*");
  const rateLimit = Number(readEnv(env, "LK_RESIDENCY_LIFECYCLE_RATE_LIMIT_PER_MINUTE", "20"));
  return {
    enabled,
    mongoUri: readEnv(env, "LK_RESIDENCY_LIFECYCLE_MONGO_URI", ""),
    databaseName: readEnv(env, "LK_RESIDENCY_LIFECYCLE_MONGO_DB", ""),
    vivaBaseUrl,
    cupBaseUrl,
    cupIntegrationToken,
    successUrl,
    failUrl,
    tenantKey,
    productId,
    expectedClientId,
    keycloakUserinfoUrl,
    allowOrigin,
    rateLimit: Number.isFinite(rateLimit) ? Math.max(1, Math.min(120, Math.floor(rateLimit))) : 20,
    ensureIndexes: readEnv(env, "LK_RESIDENCY_LIFECYCLE_ENSURE_INDEXES", "false") === "true",
    timeoutMs: Number(readEnv(env, "LK_RESIDENCY_LIFECYCLE_TIMEOUT_MS", "8000")),
    paymentTtlMs: Number(readEnv(env, "LK_RESIDENCY_LIFECYCLE_PAYMENT_TTL_MS", "1200000")),
  };
}

function bearer(req) {
  const value = req && req.headers && (req.headers.authorization || req.headers.Authorization);
  if (typeof value !== "string" || !/^Bearer [A-Za-z0-9._~+/=-]{16,4096}$/.test(value)) return null;
  return value.slice(7);
}

function validateClaims(claims, expectedClientId, expectedTenantKey) {
  if (!claims || typeof claims !== "object" || Array.isArray(claims)) return null;
  const subject = text(claims.sub, 256) ? claims.sub : null;
  if (!subject) return null;
  const party = text(claims.azp, 128) ? claims.azp
    : text(claims.client_id, 128) ? claims.client_id
    : text(claims.clientId, 128) ? claims.clientId : null;
  if (party !== expectedClientId) return null;
  const tenant = text(claims.tenantKey, 128) ? claims.tenantKey
    : text(claims.tenant_key, 128) ? claims.tenant_key
    : text(claims.tenant, 128) ? claims.tenant : null;
  if (tenant !== expectedTenantKey) return null;
  return { userId: subject, tenantId: tenant };
}

async function readUserinfo(fetchImpl, url, token, timeoutMs) {
  const controller = typeof AbortController === "function" ? new AbortController() : null;
  const timer = controller ? setTimeout(() => controller.abort(), Math.max(1000, Math.min(5000, timeoutMs))) : null;
  try {
    const response = await fetchImpl(url, {
      method: "GET",
      headers: { Accept: "application/json", Authorization: "Bearer " + token },
      redirect: "error",
      ...(controller ? { signal: controller.signal } : {}),
    });
    if (!response || response.status !== 200) return null;
    const raw = await response.text();
    if (typeof raw !== "string" || raw.length === 0 || raw.length > 65536) return null;
    try { return JSON.parse(raw); } catch { return null; }
  } catch { return null; } finally { if (timer) clearTimeout(timer); }
}

function correlationId(req) {
  const raw = String(req?.headers?.["x-correlation-id"] || "").trim();
  return /^[A-Za-z0-9._:-]{8,128}$/.test(raw) ? raw : null;
}

module.exports = function registerResidencyLifecycleApi(RED) {
  function ResidencyLifecycleStoreNode(config) {
    RED.nodes.createNode(this, config);
    const node = this;
    const envNames = {
      enabled: String(config.enabledEnv || "LK_RESIDENCY_LIFECYCLE_ENABLED").trim(),
      mongoUri: String(config.mongoUriEnv || "LK_RESIDENCY_LIFECYCLE_MONGO_URI").trim(),
      databaseName: String(config.databaseNameEnv || "LK_RESIDENCY_LIFECYCLE_MONGO_DB").trim(),
    };
    let runtimePromise = null;
    let closing = false;
    const inFlight = new Set();
    const assertOpen = () => {
      if (closing) throw Object.assign(new Error("Residency lifecycle is closing"), { code: "RESIDENCY_LIFECYCLE_CLOSING", statusCode: 503 });
    };

    node.getRuntime = async function getRuntime() {
      assertOpen();
      const env = {
        get: (name) => {
          if (name === "LK_RESIDENCY_LIFECYCLE_ENABLED") return readEnv(process.env, envNames.enabled, "false");
          if (name === "LK_RESIDENCY_LIFECYCLE_MONGO_URI") return readEnv(process.env, envNames.mongoUri, "");
          if (name === "LK_RESIDENCY_LIFECYCLE_MONGO_DB") return readEnv(process.env, envNames.databaseName, "");
          return process.env[name];
        },
      };
      const config = readConfig(env);
      if (!config.enabled) {
        const error = new Error("Residency lifecycle is disabled");
        error.code = "RESIDENCY_LIFECYCLE_DISABLED";
        error.statusCode = 503;
        throw error;
      }
      if (!config.mongoUri || !config.databaseName) {
        const error = new Error("Residency lifecycle storage is not configured");
        error.code = "RESIDENCY_LIFECYCLE_NOT_CONFIGURED";
        error.statusCode = 503;
        throw error;
      }
      if (!runtimePromise) {
        runtimePromise = Promise.all([
          import("mongodb"),
          import("./lib/residency-lifecycle.mjs"),
          import("./lib/residency-lifecycle-http.mjs"),
          import("./lib/residency-lifecycle-provider.mjs"),
          import("./lib/residency-lifecycle-store.mjs"),
        ]).then(async ([{ MongoClient }, core, http, provider, storeModule]) => {
          const client = new MongoClient(config.mongoUri, {
            readPreference: "primary", retryReads: true, retryWrites: true, serverSelectionTimeoutMS: 10_000,
          });
          try {
            await client.connect();
            const collection = client.db(config.databaseName).collection(COLLECTION);
            let indexes = [];
            try { indexes = await collection.indexes(); }
            catch (error) {
              if (error?.code !== 26 && error?.codeName !== "NamespaceNotFound") throw error;
            }
            for (const spec of storeModule.RESIDENCY_LIFECYCLE_INDEXES) {
              if (!indexes.some((index) => index.name === spec.options.name)) {
                if (!config.ensureIndexes) {
                  const error = new Error("Residency lifecycle indexes are missing");
                  error.code = "RESIDENCY_LIFECYCLE_INDEXES_MISSING";
                  error.statusCode = 503;
                  throw error;
                }
                await collection.createIndex(spec.keys, spec.options);
              }
            }
            const store = storeModule.createMongoResidencyLifecycleStore({ collection });
            const globalContext = () => node.context().global;
            const api = http.createResidencyLifecycleApi({
              allowOrigin: config.allowOrigin,
              createLifecycle: (actor) => {
                const ports = provider.createVivaCupResidencyPorts({
                  fetch: globalThis.fetch,
                  config: {
                    vivaBaseUrl: config.vivaBaseUrl,
                    cupBaseUrl: config.cupBaseUrl,
                    cupIntegrationToken: config.cupIntegrationToken,
                    tenantKey: config.tenantKey,
                    productId: config.productId,
                    successUrl: config.successUrl,
                    failUrl: config.failUrl,
                    timeoutMs: config.timeoutMs,
                    paymentTtlMs: config.paymentTtlMs,
                  },
                  clock: { now: () => Date.now() },
                  actorToken: actor.actorToken,
                  getAdminToken: () => {
                    const context = globalContext();
                    const expiresAt = Number(context.get("vivacrm_token_expires_at") || 0);
                    if (Number.isFinite(expiresAt) && expiresAt > 0 && expiresAt <= Date.now() + 30_000) return "";
                    const value = context.get("vivacrm_access_token");
                    return typeof value === "string" ? value : "";
                  },
                  now: () => new Date(),
                });
                return core.createResidencyLifecycle({
                  clock: { now: () => Date.now() },
                  ids: {
                    orderId: (tenantId, keyHash) => {
                      const hex = crypto.createHash("sha256").update(tenantId + "\0" + keyHash).digest("hex");
                      return hex.slice(0, 8) + "-" + hex.slice(8, 12) + "-4" + hex.slice(13, 16)
                        + "-8" + hex.slice(17, 20) + "-" + hex.slice(20, 32);
                    },
                    eventId: () => crypto.randomUUID(),
                  },
                  sha256: (value) => crypto.createHash("sha256").update(value).digest("hex"),
                  store,
                  catalog: ports.catalog,
                  payments: ports.payments,
                  activation: ports.activation,
                  discounts: ports.discounts,
                  status: ports.status,
                });
              },
            });
            return { client, collection, api, config };
          } catch (error) {
            await client.close().catch(() => {});
            throw error;
          }
        }).catch((error) => { runtimePromise = null; throw error; });
      }
      return runtimePromise;
    };

    node.handleHttpMessage = async function handleHttpMessage(msg) {
      assertOpen();
      const startedAt = Date.now();
      const req = msg.req || {};
      const runtime = await node.getRuntime();
      if (String(req.method || msg.method || "").toUpperCase() === "OPTIONS") {
        return runtime.api.handle({ method: "OPTIONS", path: String(req.originalUrl || req.url || msg.url || ""),
          headers: req.headers || msg.headers || {}, body: null, actor: null });
      }
      const token = bearer(req);
      const correlation = correlationId(req);
      if (!token) {
        return { statusCode: 401, headers: { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store",
          "Referrer-Policy": "no-referrer", "Access-Control-Allow-Origin": runtime.config.allowOrigin },
        body: { code: "RESIDENCY_AUTH_REQUIRED", message: "Authentication required" } };
      }
      const claims = await readUserinfo(globalThis.fetch, runtime.config.keycloakUserinfoUrl, token, runtime.config.timeoutMs);
      const actor = validateClaims(claims, runtime.config.expectedClientId, runtime.config.tenantKey);
      if (!actor) {
        node.warn(JSON.stringify({ event: "residency_lifecycle_auth_denied", correlationId: correlation, durationMs: Date.now() - startedAt }));
        return { statusCode: 401, headers: { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store",
          "Referrer-Policy": "no-referrer", "Access-Control-Allow-Origin": runtime.config.allowOrigin },
        body: { code: "RESIDENCY_AUTH_REQUIRED", message: "Authentication required" } };
      }
      const minute = Math.floor(Date.now() / 60000);
      const rateKey = "residency-lifecycle:" + crypto.createHash("sha256").update(actor.userId).digest("hex").slice(0, 16) + ":" + minute;
      let attempts = 0;
      try {
        const stored = Number(node.context().flow.get(rateKey));
        attempts = Number.isFinite(stored) && stored > 0 ? stored : 0;
        if (attempts >= runtime.config.rateLimit) {
          return { statusCode: 429, headers: { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store",
            "Referrer-Policy": "no-referrer", "Access-Control-Allow-Origin": runtime.config.allowOrigin },
          body: { code: "RESIDENCY_RATE_LIMITED", message: "Too many requests" } };
        }
        node.context().flow.set(rateKey, attempts + 1);
      } catch { /* rate limiting must not block the request if flow context is unavailable */ }
      const operation = runtime.api.handle({
        method: String(req.method || msg.method || "").toUpperCase(),
        path: String(req.originalUrl || req.url || msg.url || ""),
        headers: req.headers || msg.headers || {},
        body: msg.payload,
        actor: { ...actor, actorToken: token },
      });
      inFlight.add(operation);
      try {
        const result = await operation;
        node.warn(JSON.stringify({ event: "residency_lifecycle_request", code: result.statusCode, correlationId: correlation, durationMs: Date.now() - startedAt }));
        return result;
      } finally { inFlight.delete(operation); }
    };

    node.on("close", async (_removed, done) => {
      closing = true;
      try {
        await Promise.allSettled([...inFlight]);
        const runtime = runtimePromise ? await runtimePromise : null;
        await runtime?.client?.close?.();
        done();
      } catch (error) { done(error); }
    });
  }

  function ResidencyLifecycleHttpNode(config) {
    RED.nodes.createNode(this, config);
    const node = this;
    const store = RED.nodes.getNode(config.store);
    node.on("input", async (msg, send, done) => {
      const emit = typeof send === "function" ? send : node.send.bind(node);
      try {
        if (!store) throw Object.assign(new Error("Residency lifecycle store is not configured"), { code: "RESIDENCY_LIFECYCLE_NOT_CONFIGURED", statusCode: 503 });
        const result = await store.handleHttpMessage(msg);
        msg.statusCode = result.statusCode;
        msg.headers = result.headers;
        msg.payload = result.body;
        emit(msg);
        done?.();
      } catch (error) {
        const code = String(error?.code || "RESIDENCY_INTERNAL");
        const statusCode = Number(error?.statusCode || 500);
        msg.statusCode = statusCode >= 400 && statusCode < 600 ? statusCode : 500;
        msg.headers = { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store", "Referrer-Policy": "no-referrer" };
        msg.payload = { code, message: statusCode < 500 && statusCode !== 503 ? String(error?.message || "Request failed") : "Request could not be completed" };
        node.warn(JSON.stringify({ event: "residency_lifecycle_failed", code, statusCode }));
        emit(msg);
        done?.();
      }
    });
  }

  RED.nodes.registerType("padlhub-residency-lifecycle-store", ResidencyLifecycleStoreNode);
  RED.nodes.registerType("padlhub-residency-lifecycle-http", ResidencyLifecycleHttpNode);
  module.exports.ResidencyLifecycleStoreNode = ResidencyLifecycleStoreNode;
};

module.exports.readConfig = readConfig;
module.exports.bearer = bearer;
module.exports.validateClaims = validateClaims;
module.exports.readUserinfo = readUserinfo;