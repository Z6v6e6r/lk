"use strict";

module.exports = function registerLegacyGameCommandStore(RED) {
  function LegacyGameCommandStoreNode(config) {
    RED.nodes.createNode(this, config);
    const node = this;
    const mongoUriEnv = String(config.mongoUriEnv || "LK_LEGACY_COMMAND_MONGO_URI").trim();
    const databaseNameEnv = String(config.databaseNameEnv || "LK_LEGACY_COMMAND_MONGO_DB").trim();
    let servicePromise = null;

    node.getService = async function getService() {
      const mongoUri = process.env[mongoUriEnv];
      const databaseName = process.env[databaseNameEnv];
      if (!mongoUri) throw new Error(`Legacy command Mongo URI env ${mongoUriEnv} is not configured`);
      if (!databaseName || databaseName.trim() !== databaseName) {
        throw new Error(`Legacy command database env ${databaseNameEnv} is not configured canonically`);
      }
      if (!servicePromise) {
        servicePromise = Promise.all([
          import("mongodb"),
          import("./legacy-game-command-core.mjs"),
        ]).then(async ([{ MongoClient }, { LegacyGameCommandTransactionService }]) => {
          const client = new MongoClient(mongoUri, {
            readPreference: "primary",
            retryReads: true,
            retryWrites: true,
            serverSelectionTimeoutMS: 10_000,
          });
          await client.connect();
          return new LegacyGameCommandTransactionService({
            client,
            db: client.db(databaseName),
            ownsClient: true,
          });
        }).catch((error) => {
          servicePromise = null;
          throw error;
        });
      }
      return servicePromise;
    };

    node.executeLegacyGameCommandTransaction = async function execute(input) {
      const service = await node.getService();
      return service.executeLegacyGameCommandTransaction(input);
    };

    node.claimResultSideEffect = async function claim(input, options) {
      const service = await node.getService();
      return service.claimResultSideEffect(input, options);
    };

    node.completeResultSideEffect = async function complete(input, options) {
      const service = await node.getService();
      return service.completeResultSideEffect(input, options);
    };

    node.readResultIdempotencyIdentity = async function readResultIdempotencyIdentity(input) {
      const service = await node.getService();
      return service.readResultIdempotencyIdentity(input);
    };

    node.readProviderOutboxIdentity = async function readProviderOutboxIdentity(input) {
      const service = await node.getService();
      return service.readProviderOutboxIdentity(input);
    };

    node.persistCleanupReconciliationIntent = async function persist(input) {
      const service = await node.getService();
      return service.persistCleanupReconciliationIntent(input);
    };

    node.on("close", async (_removed, done) => {
      try {
        const service = servicePromise ? await servicePromise : null;
        await service?.close();
        done();
      } catch (error) {
        done(error);
      }
    });
  }

  function LegacyGameCommandOperationNode(config) {
    RED.nodes.createNode(this, config);
    const node = this;
    const store = RED.nodes.getNode(config.store);
    const action = String(config.action || "").trim();

    node.on("input", async (msg, send, done) => {
      const emit = typeof send === "function" ? send : node.send.bind(node);
      try {
        if (!store) throw new Error("Legacy game command store is not configured");
        if (action === "read-result-idempotency") {
          msg._resultSubmitStoredDoc = await store.readResultIdempotencyIdentity(msg._resultSubmitIdempotencyReadback);
          emit([msg, null]);
        } else if (action === "read-provider-outbox-identity") {
          msg._resultVivaOutboxStoredDoc = await store.readProviderOutboxIdentity(msg._resultVivaOutboxIdentityRead);
          msg.payload = msg._resultVivaSyncOriginalTask;
          delete msg._resultVivaSyncOriginalTask;
          emit([msg, null]);
        } else if (action === "claim-result-sink") {
          const context = msg._legacyResultSideEffect;
          const result = await store.claimResultSideEffect(context, {
            leaseMs: Number(config.leaseMs || 30_000),
            maxAttempts: Number(config.maxAttempts || 3),
          });
          msg._legacyResultSideEffectClaim = result;
          if (result.claimed) {
            msg._legacyResultSideEffect = { ...context, leaseToken: result.leaseToken };
            emit([msg, null]);
          } else {
            emit([null, msg]);
          }
        } else if (action === "complete-result-sink") {
          const context = msg._legacyResultSideEffect;
          const outcome = msg._legacyResultSideEffectOutcome || {};
          const result = await store.completeResultSideEffect(context, {
            leaseToken: context?.leaseToken,
            outcome: outcome.status,
            error: outcome.error,
          });
          msg._legacyResultSideEffectCompletion = result;
          if (["DELIVERED", "SKIPPED", "SUPERSEDED"].includes(result.sinkState)) emit([msg, null]);
          else emit([null, msg]);
        } else if (action === "persist-cleanup-recovery") {
          const result = await store.persistCleanupReconciliationIntent(msg._legacyCleanupRecovery);
          msg._legacyCleanupRecoveryResult = result;
          emit([msg, null]);
        } else {
          throw new Error(`Unsupported legacy game command operation: ${action}`);
        }
        done?.();
      } catch (error) {
        const exposedCodes = new Set([
          "RESULT_IDEMPOTENCY_READBACK_MISSING",
          "RESULT_IDEMPOTENCY_CONFLICT",
          "PROVIDER_OUTBOX_IDENTITY_INVALID",
          "PROVIDER_OUTBOX_IDENTITY_CONFLICT",
        ]);
        const code = exposedCodes.has(error?.code)
          ? error.code
          : "LEGACY_COMMAND_OPERATION_FAILED";
        const messages = {
          RESULT_IDEMPOTENCY_READBACK_MISSING: "Durable result idempotency state is not available",
          RESULT_IDEMPOTENCY_CONFLICT: "Result idempotency identity conflicts with durable state",
          PROVIDER_OUTBOX_IDENTITY_INVALID: "Provider outbox identity is invalid",
          PROVIDER_OUTBOX_IDENTITY_CONFLICT: "Provider outbox identity conflicts with durable state",
        };
        msg._legacyCommandOperationError = {
          code,
          message: messages[code] || "Legacy command operation failed",
        };
        if (action === "read-provider-outbox-identity") {
          msg._legacyResultSideEffectOutcome = {
            status: "UNKNOWN",
            error: "Provider outbox identity was not durably verified",
          };
        }
        emit([null, msg]);
        done?.();
      }
    });
  }

  RED.nodes.registerType("padlhub-legacy-game-command-store", LegacyGameCommandStoreNode);
  RED.nodes.registerType("padlhub-legacy-game-command-operation", LegacyGameCommandOperationNode);
};
