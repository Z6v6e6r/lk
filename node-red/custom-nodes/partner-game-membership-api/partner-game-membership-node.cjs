"use strict";

const crypto = require("node:crypto");

const readEnv = (name) => String(process.env[name] || "").trim();

const parseKeyring = (raw) => {
  let value;
  try { value = JSON.parse(raw); } catch { throw new Error("Partner API keyring JSON is invalid"); }
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Partner API keyring must be an object");
  return value;
};

module.exports = function registerPartnerGameMembershipApi(RED) {
  function PartnerGameMembershipStoreNode(config) {
    RED.nodes.createNode(this, config);
    const node = this;
    const envNames = {
      enabled: String(config.enabledEnv || "LK_PARTNER_GAME_API_ENABLED").trim(),
      mongoUri: String(config.mongoUriEnv || "LK_PARTNER_GAME_API_MONGO_URI").trim(),
      databaseName: String(config.databaseNameEnv || "LK_PARTNER_GAME_API_MONGO_DB").trim(),
      keyring: String(config.keyringEnv || "LK_PARTNER_GAME_API_KEYRING_JSON").trim(),
      auditKey: String(config.auditKeyEnv || "LK_PARTNER_GAME_API_AUDIT_HMAC_KEY").trim(),
      environment: String(config.environmentEnv || "LK_PARTNER_GAME_API_ENVIRONMENT").trim(),
      providerMode: String(config.providerModeEnv || "LK_PARTNER_GAME_API_PROVIDER_MODE").trim(),
      technicalVivaClientId: String(config.technicalVivaClientIdEnv || "LK_PARTNER_GAME_API_VIVA_TECHNICAL_CLIENT_ID").trim(),
      vivaMutationsEnabled: String(config.vivaMutationsEnabledEnv || "LK_PARTNER_GAME_API_VIVA_MUTATIONS_ENABLED").trim(),
      vivaContractRevision: String(config.vivaContractRevisionEnv || "LK_PARTNER_GAME_API_VIVA_CONTRACT_REVISION").trim(),
      vivaIdempotencyConfirmed: String(config.vivaIdempotencyConfirmedEnv || "LK_PARTNER_GAME_API_VIVA_IDEMPOTENCY_CONFIRMED").trim(),
      vivaOnPlaceConfirmed: String(config.vivaOnPlaceConfirmedEnv || "LK_PARTNER_GAME_API_VIVA_ON_PLACE_CONFIRMED").trim(),
    };
    let runtimePromise = null;

    node.getRuntime = async function getRuntime() {
      if (readEnv(envNames.enabled) !== "true") {
        const error = new Error("Partner game membership API is disabled");
        error.code = "PARTNER_API_DISABLED";
        error.httpStatus = 503;
        throw error;
      }
      if (!runtimePromise) {
        runtimePromise = Promise.all([
          import("mongodb"),
          import("./partner-game-membership-core.mjs"),
          import("./partner-game-membership-mongo.mjs"),
          import("./partner-game-membership-viva.mjs"),
        ]).then(async ([{ MongoClient }, core, mongo, viva]) => {
          const mongoUri = readEnv(envNames.mongoUri);
          const databaseName = readEnv(envNames.databaseName);
          const environment = readEnv(envNames.environment);
          const providerMode = readEnv(envNames.providerMode).toLowerCase();
          const technicalVivaClientId = readEnv(envNames.technicalVivaClientId);
          const keyring = parseKeyring(readEnv(envNames.keyring));
          const auditKey = Buffer.from(readEnv(envNames.auditKey), "base64url");
          if (!mongoUri || !databaseName || !technicalVivaClientId) throw new Error("Partner API server-only runtime configuration is incomplete");
          if (auditKey.length < 32) throw new Error("Partner API audit HMAC key must contain at least 32 bytes");

          const client = new MongoClient(mongoUri, {
            readPreference: "primary",
            retryReads: true,
            retryWrites: true,
            serverSelectionTimeoutMS: 10_000,
          });
          try {
            await client.connect();
            const repository = new mongo.MongoPartnerGameMembershipRepository({
              client,
              db: client.db(databaseName),
              ownsClient: true,
            });
            const isolated = mongo.isIsolatedSyntheticRuntime({ environment, mongoUri, databaseName });
            if (providerMode === "synthetic") {
              if (!isolated) throw new Error("Synthetic Viva mode requires local/test/dev and a loopback Mongo database");
              await repository.ensureIndexesForIsolatedTest();
            } else {
              await repository.verifyRequiredIndexes();
            }
            let provider;
            if (providerMode === "synthetic") {
              provider = new core.SyntheticVivaProvider();
            } else if (providerMode === "viva") {
              provider = new viva.VivaAdminTechnicalUserProvider({
                mutationsEnabled: readEnv(envNames.vivaMutationsEnabled) === "true",
                contractRevision: readEnv(envNames.vivaContractRevision),
                idempotencyConfirmed: readEnv(envNames.vivaIdempotencyConfirmed) === "true",
                onPlacePaymentConfirmed: readEnv(envNames.vivaOnPlaceConfirmed) === "true",
                tokenResolver: async () => {
                  try {
                    const globalContext = node.context().global;
                    const expiresAt = Number(globalContext.get("vivacrm_token_expires_at") || 0);
                    if (!Number.isFinite(expiresAt) || expiresAt <= Date.now() + 30_000) return "";
                    return globalContext.get("vivacrm_access_token");
                  } catch {
                    return "";
                  }
                },
              });
            } else if (!providerMode || providerMode === "disabled") {
              provider = new core.DisabledVivaProvider();
            } else {
              throw new Error("Partner API provider mode is invalid");
            }
            const keyResolver = async (clientId, keyId) => {
              const clientConfig = Object.hasOwn(keyring, clientId) ? keyring[clientId] : null;
              const encodedSecret = clientConfig?.keys && Object.hasOwn(clientConfig.keys, keyId)
                ? clientConfig.keys[keyId]
                : null;
              return {
                enabled: clientConfig?.enabled === true && typeof encodedSecret === "string",
                secret: typeof encodedSecret === "string" ? Buffer.from(encodedSecret, "base64url") : Buffer.alloc(0),
                scopes: Array.isArray(clientConfig?.scopes) ? clientConfig.scopes : [],
                stationIds: Array.isArray(clientConfig?.stationIds) ? clientConfig.stationIds : [],
                games: clientConfig?.games && typeof clientConfig.games === "object" && !Array.isArray(clientConfig.games)
                  ? clientConfig.games
                  : {},
              };
            };
            const service = new core.PartnerGameMembershipApiService({
              repository,
              provider,
              keyResolver,
              technicalVivaClientId,
              auditKey,
            });
            return { client, repository, service, providerMode, isolated };
          } catch (error) {
            await client.close().catch(() => {});
            throw error;
          }
        }).catch((error) => {
          runtimePromise = null;
          throw error;
        });
      }
      return runtimePromise;
    };

    node.handleHttpMessage = async function handleHttpMessage(msg) {
      const runtime = await node.getRuntime();
      const req = msg.req || {};
      return runtime.service.handle({
        method: req.method || msg.method,
        path: req.originalUrl || req.url || msg.url,
        headers: req.headers || msg.headers || {},
        body: msg.payload ?? {},
        remoteAddress: req.ip || req.socket?.remoteAddress || req.connection?.remoteAddress || null,
      });
    };

    node.on("close", async (_removed, done) => {
      try {
        const runtime = runtimePromise ? await runtimePromise : null;
        await runtime?.repository?.close();
        done();
      } catch (error) {
        done(error);
      }
    });
  }

  function PartnerGameMembershipHttpNode(config) {
    RED.nodes.createNode(this, config);
    const node = this;
    const store = RED.nodes.getNode(config.store);
    node.on("input", async (msg, send, done) => {
      const emit = typeof send === "function" ? send : node.send.bind(node);
      try {
        if (!store) throw new Error("Partner game membership store is not configured");
        const result = await store.handleHttpMessage(msg);
        msg.statusCode = result.statusCode;
        msg.headers = {
          "content-type": "application/json; charset=utf-8",
          "cache-control": "no-store",
        };
        msg.payload = result.body;
        emit(msg);
        done?.();
      } catch (error) {
        const rawCorrelationId = String(msg.req?.headers?.["x-correlation-id"] || "").trim();
        const correlationId = /^[0-9a-f-]{36}$/.test(rawCorrelationId) ? rawCorrelationId : null;
        const code = String(error?.code || "PARTNER_API_INTERNAL_ERROR");
        const exposed = error?.expose !== false && Number(error?.httpStatus || 500) < 500;
        msg.statusCode = Number(error?.httpStatus || 500);
        msg.headers = {
          "content-type": "application/json; charset=utf-8",
          "cache-control": "no-store",
        };
        msg.payload = {
          error: {
            code,
            message: exposed ? String(error.message || "Request failed") : "Integration request could not be completed",
          },
          correlationId,
        };
        node.warn(JSON.stringify({
          event: "partner_api_request_failed",
          code,
          correlationId,
          traceId: crypto.randomUUID(),
        }));
        emit(msg);
        done?.();
      }
    });
  }

  RED.nodes.registerType("padlhub-partner-game-membership-store", PartnerGameMembershipStoreNode);
  RED.nodes.registerType("padlhub-partner-game-membership-http", PartnerGameMembershipHttpNode);
};

module.exports.parseKeyring = parseKeyring;
