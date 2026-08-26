import crypto from "node:crypto";

export const LEGACY_COMMAND_COLLECTIONS = Object.freeze({
  games: "lk_games",
  results: "lk_game_results",
  resultVivaSyncOutbox: "lk_result_viva_sync_outbox",
  commands: "lk_legacy_game_commands",
  mappings: "lk_canonical_legacy_player_mappings",
  auditIntents: "lk_legacy_game_command_audit_intents",
  outboxIntents: "lk_legacy_game_command_outbox_intents",
  cleanupReconciliationIntents: "lk_legacy_game_revision_reconciliation_intents",
});

export const LEGACY_COMMAND_INDEX_SPECS = Object.freeze({
  commands: [
    { key: { tenantKey: 1, idempotencyKey: 1 }, name: "uniq_tenant_idempotency_key", unique: true },
    { key: { tenantKey: 1, operationId: 1 }, name: "uniq_tenant_operation_id", unique: true },
  ],
  mappings: [
    { key: { tenantKey: 1, canonicalUserId: 1 }, name: "uniq_tenant_canonical_user", unique: true },
    { key: { tenantKey: 1, legacyUserId: 1 }, name: "uniq_tenant_legacy_user", unique: true },
  ],
  auditIntents: [
    { key: { tenantKey: 1, operationId: 1, intentKey: 1 }, name: "uniq_command_audit_intent", unique: true },
  ],
  outboxIntents: [
    { key: { tenantKey: 1, operationId: 1, intentKey: 1 }, name: "uniq_command_outbox_intent", unique: true },
  ],
  games: [
    { key: { tenantKey: 1, id: 1 }, name: "uniq_tenant_game_id", unique: true },
    { key: { tenantKey: 1, id: 1, revision: 1 }, name: "tenant_game_revision_lookup" },
  ],
  results: [
    { key: { tenantKey: 1, id: 1 }, name: "uniq_tenant_result_id", unique: true },
    { key: { tenantKey: 1, idempotencyKey: 1 }, name: "uniq_tenant_result_idempotency_key", unique: true },
    { key: { tenantKey: 1, id: 1, revision: 1 }, name: "tenant_result_revision_lookup" },
    { key: { tenantKey: 1, id: 1, "legacyGameProjectionOutbox.bundleId": 1 }, name: "tenant_result_outbox_lookup" },
  ],
  resultVivaSyncOutbox: [
    { key: { tenantKey: 1, id: 1 }, name: "uniq_tenant_result_viva_outbox_id", unique: true },
    { key: { tenantKey: 1, resultId: 1, resultRevision: 1 }, name: "tenant_result_viva_revision_lookup" },
  ],
  cleanupReconciliationIntents: [
    { key: { tenantKey: 1, intentId: 1 }, name: "uniq_tenant_cleanup_reconciliation_intent", unique: true },
    { key: { status: 1, updatedAt: 1 }, name: "cleanup_reconciliation_status" },
  ],
});

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const HASH_PATTERN = /^[0-9a-f]{64}$/i;
const TERMINAL_STATES = new Set(["SUCCEEDED", "REJECTED", "UNKNOWN"]);
const TERMINAL_RESULT_SINK_STATES = new Set(["DELIVERED", "SKIPPED", "SUPERSEDED", "UNKNOWN"]);
const RESULT_SINK_KINDS = new Set(["RATING", "EVENT", "PROVIDER"]);
const RESULT_SINK_RETRY_POLICIES = new Set(["FENCED", "AT_MOST_ONCE"]);
const RESULT_TENANT_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/;
const RESULT_IDEMPOTENCY_KEY_PATTERN = /^[A-Za-z0-9][A-Za-z0-9:._-]{7,159}$/;
const BLOCKED_UPDATE_PATHS = new Set([
  "revision",
  "updatedAt",
  "legacyCommand.lastOperationId",
  "legacyCommand.lastIdempotencyKey",
]);
const ALLOWED_UPDATE_OPERATORS = new Set(["$set", "$unset", "$inc", "$push", "$pull", "$addToSet"]);

const isObject = (value) => Boolean(value) && typeof value === "object" && !Array.isArray(value);
const toStringOrNull = (value) => {
  if (value === null || value === undefined) return null;
  const normalized = String(value).trim();
  return normalized || null;
};
const clone = (value) => value === undefined ? undefined : structuredClone(value);
const wait = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds));
const isValidIsoTimestamp = (value) => (
  typeof value === "string"
  && value.trim() === value
  && value.length > 0
  && Number.isFinite(Date.parse(value))
);

export function buildLegacyResultId(tenantKey, idempotencyKey) {
  if (typeof tenantKey !== "string" || !RESULT_TENANT_PATTERN.test(tenantKey)) {
    throw new TypeError("tenantKey is not canonical for a legacy result identity");
  }
  if (typeof idempotencyKey !== "string" || !RESULT_IDEMPOTENCY_KEY_PATTERN.test(idempotencyKey)) {
    throw new TypeError("idempotencyKey is not canonical for a legacy result identity");
  }
  return `res_v1_${tenantKey.length}_${tenantKey}_${idempotencyKey}`;
}

function assertCanonicalString(value, field) {
  if (typeof value !== "string" || !value || value.trim() !== value) {
    throw new LegacyCommandError("RESULT_OUTBOX_CONTEXT_INVALID", `${field} must be canonical and trimmed`, {
      httpStatus: 500,
      terminal: false,
    });
  }
  return value;
}

function normalizeResultSinkContext(input) {
  if (!isObject(input)) {
    throw new LegacyCommandError("RESULT_OUTBOX_CONTEXT_INVALID", "Result outbox context is required", {
      httpStatus: 500,
      terminal: false,
    });
  }
  const normalized = {
    tenantKey: assertCanonicalString(input.tenantKey, "tenantKey"),
    resultId: assertCanonicalString(input.resultId, "resultId"),
    bundleId: assertCanonicalString(input.bundleId, "bundleId"),
    sinkKey: assertCanonicalString(input.sinkKey, "sinkKey"),
    kind: assertCanonicalString(input.kind, "kind").toUpperCase(),
    retryPolicy: assertCanonicalString(input.retryPolicy, "retryPolicy").toUpperCase(),
    resultRevision: Number(input.resultRevision),
  };
  if (!Number.isSafeInteger(normalized.resultRevision) || normalized.resultRevision < 1) {
    throw new LegacyCommandError("RESULT_OUTBOX_CONTEXT_INVALID", "resultRevision must be a positive safe integer", {
      httpStatus: 500,
      terminal: false,
    });
  }
  if (!RESULT_SINK_KINDS.has(normalized.kind)) {
    throw new LegacyCommandError("RESULT_OUTBOX_CONTEXT_INVALID", "Unsupported result sink kind", {
      httpStatus: 500,
      terminal: false,
    });
  }
  if (!RESULT_SINK_RETRY_POLICIES.has(normalized.retryPolicy)) {
    throw new LegacyCommandError("RESULT_OUTBOX_CONTEXT_INVALID", "Unsupported result sink retry policy", {
      httpStatus: 500,
      terminal: false,
    });
  }
  if (normalized.kind === "PROVIDER" && normalized.retryPolicy !== "AT_MOST_ONCE") {
    throw new LegacyCommandError("RESULT_OUTBOX_CONTEXT_INVALID", "Provider sinks must be AT_MOST_ONCE", {
      httpStatus: 500,
      terminal: false,
    });
  }
  return normalized;
}

export function validateLegacyIdentityMapping(mapping) {
  const errors = [];
  if (!isObject(mapping)) return ["mapping must be an object"];
  const tenantKey = typeof mapping.tenantKey === "string" ? mapping.tenantKey : "";
  if (!tenantKey.trim()) errors.push("tenantKey is required");
  else if (tenantKey !== tenantKey.trim()) errors.push("tenantKey must be canonical and trimmed");
  if (!UUID_PATTERN.test(String(mapping.canonicalUserId || ""))) {
    errors.push("canonicalUserId must be a canonical lowercase UUID");
  }
  if (!UUID_PATTERN.test(String(mapping.legacyUserId || ""))) {
    errors.push("legacyUserId must be a canonical lowercase UUID");
  }
  if (!new Set(["ACTIVE", "REVOKED"]).has(mapping.status)) errors.push("status must be ACTIVE or REVOKED");
  if (!toStringOrNull(mapping.source)) errors.push("source is required");
  if (!Number.isSafeInteger(mapping.version) || mapping.version < 1) errors.push("version must be a positive safe integer");
  if (!toStringOrNull(mapping.evidenceRef)) errors.push("evidenceRef is required");
  if (!isValidIsoTimestamp(mapping.createdAt)) errors.push("createdAt must be an ISO timestamp");
  if (mapping.status === "REVOKED" && !isValidIsoTimestamp(mapping.revokedAt)) {
    errors.push("revokedAt must be an ISO timestamp for revoked mappings");
  }
  return errors;
}

export class LegacyCommandError extends Error {
  constructor(code, message, options = {}) {
    super(message);
    this.name = "LegacyCommandError";
    this.code = code;
    this.httpStatus = options.httpStatus || 409;
    this.terminal = options.terminal !== false;
    this.details = options.details || null;
  }
}

function assertInput(input) {
  if (!isObject(input)) throw new LegacyCommandError("INVALID_REQUEST", "Command input is required", { httpStatus: 400 });
  const requiredStrings = ["tenantKey", "idempotencyKey", "requestHash", "correlationId", "command", "canonicalUserId", "legacyGameId"];
  for (const field of requiredStrings) {
    if (!toStringOrNull(input[field])) throw new LegacyCommandError("INVALID_REQUEST", `${field} is required`, { httpStatus: 400 });
  }
  if (!UUID_PATTERN.test(input.idempotencyKey)) {
    throw new LegacyCommandError("INVALID_REQUEST", "idempotencyKey must be a UUID", { httpStatus: 400 });
  }
  if (!UUID_PATTERN.test(input.canonicalUserId)) {
    throw new LegacyCommandError("INVALID_REQUEST", "canonicalUserId must be a UUID", { httpStatus: 400 });
  }
  if (!HASH_PATTERN.test(input.requestHash)) {
    throw new LegacyCommandError("INVALID_REQUEST", "requestHash must be a SHA-256 hex digest", { httpStatus: 400 });
  }
  if (String(input.command).trim().toUpperCase() === "NOOP") {
    throw new LegacyCommandError("INVALID_REQUEST", "NOOP is not a supported production command", { httpStatus: 400 });
  }
  if (!Number.isSafeInteger(input.expectedRevision) || input.expectedRevision < 1) {
    throw new LegacyCommandError("LEGACY_GAME_REVISION_REQUIRED", "expectedRevision must be a positive integer", { httpStatus: 428 });
  }
  if (typeof input.buildMutation !== "function") {
    throw new LegacyCommandError("INVALID_REQUEST", "buildMutation callback is required", { httpStatus: 400 });
  }
}

function validateMutationPlan(plan) {
  if (!isObject(plan) || !isObject(plan.update)) {
    throw new LegacyCommandError("INVALID_MUTATION_PLAN", "A non-empty Mongo update is required", { httpStatus: 500, terminal: false });
  }
  const operators = Object.keys(plan.update);
  if (operators.length === 0 || operators.some((key) => !ALLOWED_UPDATE_OPERATORS.has(key))) {
    throw new LegacyCommandError("INVALID_MUTATION_PLAN", "Mutation must use Mongo update operators", { httpStatus: 500, terminal: false });
  }
  for (const operator of operators) {
    if (!isObject(plan.update[operator])) {
      throw new LegacyCommandError("INVALID_MUTATION_PLAN", `${operator} must contain an object`, { httpStatus: 500, terminal: false });
    }
    for (const path of Object.keys(plan.update[operator])) {
      const conflictsWithProtectedPath = [...BLOCKED_UPDATE_PATHS].some((protectedPath) => (
        path === protectedPath
        || path.startsWith(`${protectedPath}.`)
        || protectedPath.startsWith(`${path}.`)
      ));
      if (conflictsWithProtectedPath) {
        throw new LegacyCommandError("INVALID_MUTATION_PLAN", `Mutation cannot control ${path}`, { httpStatus: 500, terminal: false });
      }
    }
  }
  if (plan.auditIntents !== undefined && !Array.isArray(plan.auditIntents)) {
    throw new LegacyCommandError("INVALID_MUTATION_PLAN", "auditIntents must be an array", { httpStatus: 500, terminal: false });
  }
  if (plan.outboxIntents !== undefined && !Array.isArray(plan.outboxIntents)) {
    throw new LegacyCommandError("INVALID_MUTATION_PLAN", "outboxIntents must be an array", { httpStatus: 500, terminal: false });
  }
  if (plan.filter !== undefined && (!isObject(plan.filter)
    || Object.keys(plan.filter).some((key) => key.startsWith("$")))) {
    throw new LegacyCommandError("INVALID_MUTATION_PLAN", "Mutation filter may contain field constraints only", { httpStatus: 500, terminal: false });
  }
  return plan;
}

function replayResult(document) {
  return {
    ...(clone(document.result) || {}),
    operationId: document.operationId,
    status: document.state,
    replayed: true,
  };
}

function isUnknownCommit(error) {
  return Boolean(
    error?.hasErrorLabel?.("UnknownTransactionCommitResult")
    || error?.errorLabels?.includes?.("UnknownTransactionCommitResult"),
  );
}

export class LegacyGameCommandTransactionService {
  constructor({
    client,
    db,
    ownsClient = false,
    now = () => new Date(),
    operationIdFactory = () => crypto.randomUUID(),
    transactionExecutor = (session, callback, options) => session.withTransaction(callback, options),
    ambiguousReadBarrier = async (attempt) => wait(Math.min(250 * (2 ** (attempt - 1)), 1_000)),
    ambiguousReadAttempts = 4,
  }) {
    if (!client || !db) throw new Error("Mongo client and database are required");
    this.client = client;
    this.db = db;
    this.ownsClient = ownsClient;
    this.now = now;
    this.operationIdFactory = operationIdFactory;
    this.transactionExecutor = transactionExecutor;
    this.ambiguousReadBarrier = ambiguousReadBarrier;
    this.ambiguousReadAttempts = ambiguousReadAttempts;
  }

  async close() {
    if (this.ownsClient) await this.client.close();
  }

  async readExistingCommand({ tenantKey, idempotencyKey, requestHash }) {
    const document = await this.db.collection(LEGACY_COMMAND_COLLECTIONS.commands).findOne(
      { tenantKey, idempotencyKey },
      { readPreference: "primary", readConcern: { level: "majority" } },
    );
    if (!document) return null;
    if (document.requestHash !== requestHash) {
      throw new LegacyCommandError("IDEMPOTENCY_KEY_REUSED", "Idempotency key was used for another request", { httpStatus: 409 });
    }
    if (TERMINAL_STATES.has(document.state)) return replayResult(document);
    throw new LegacyCommandError("COMMAND_ALREADY_IN_PROGRESS", "Command is not terminal", { httpStatus: 409, terminal: false });
  }

  async readResultIdempotencyIdentity(input) {
    const tenantKey = assertCanonicalString(input?.tenantKey, "tenantKey");
    const idempotencyKey = assertCanonicalString(input?.idempotencyKey, "idempotencyKey");
    const resultId = assertCanonicalString(input?.resultId, "resultId");
    const document = await this.db.collection(LEGACY_COMMAND_COLLECTIONS.results).findOne(
      { tenantKey, idempotencyKey },
      { readPreference: "primary", readConcern: { level: "majority" } },
    );
    if (!document) {
      throw new LegacyCommandError("RESULT_IDEMPOTENCY_READBACK_MISSING", "Durable result idempotency row was not found", {
        httpStatus: 503,
        terminal: false,
      });
    }
    if (document.id !== resultId || document._id !== resultId) {
      throw new LegacyCommandError("RESULT_IDEMPOTENCY_CONFLICT", "Result idempotency identity does not match its durable row", {
        httpStatus: 409,
      });
    }
    return clone(document);
  }

  async readProviderOutboxIdentity(input) {
    const tenantKey = assertCanonicalString(input?.tenantKey, "tenantKey");
    const outboxId = assertCanonicalString(input?.outboxId, "outboxId");
    const resultId = assertCanonicalString(input?.resultId, "resultId");
    const resultRevision = Number(input?.resultRevision);
    if (!Number.isSafeInteger(resultRevision) || resultRevision < 1) {
      throw new LegacyCommandError("PROVIDER_OUTBOX_IDENTITY_INVALID", "Provider result revision is invalid", {
        httpStatus: 500,
        terminal: false,
      });
    }
    const document = await this.db.collection(LEGACY_COMMAND_COLLECTIONS.resultVivaSyncOutbox).findOne(
      { _id: outboxId, id: outboxId, tenantKey, resultId, resultRevision },
      { readPreference: "primary", readConcern: { level: "majority" } },
    );
    if (!document) {
      throw new LegacyCommandError("PROVIDER_OUTBOX_IDENTITY_CONFLICT", "Provider outbox identity does not match durable state", {
        httpStatus: 409,
      });
    }
    return clone(document);
  }

  async readResultOutbox(context) {
    const normalized = normalizeResultSinkContext(context);
    const result = await this.db.collection(LEGACY_COMMAND_COLLECTIONS.results).findOne(
      {
        tenantKey: normalized.tenantKey,
        id: normalized.resultId,
        revision: normalized.resultRevision,
        "legacyGameProjectionOutbox.bundleId": normalized.bundleId,
      },
      {
        projection: { legacyGameProjectionOutbox: 1 },
        readPreference: "primary",
        readConcern: { level: "majority" },
      },
    );
    const outbox = result?.legacyGameProjectionOutbox;
    if (!outbox || outbox.version !== 2 || !Array.isArray(outbox.sinks)) {
      throw new LegacyCommandError("RESULT_SIDE_EFFECT_OUTBOX_INVALID", "Durable result side-effect outbox is missing or invalid", {
        httpStatus: 503,
        terminal: false,
      });
    }
    const sink = outbox.sinks.find((candidate) => candidate?.key === normalized.sinkKey);
    if (!sink || sink.kind !== normalized.kind || sink.retryPolicy !== normalized.retryPolicy) {
      throw new LegacyCommandError("RESULT_SIDE_EFFECT_OUTBOX_INVALID", "Result side-effect sink contract does not match", {
        httpStatus: 503,
        terminal: false,
      });
    }
    return { normalized, outbox, sink };
  }

  async refreshResultOutboxState(context) {
    for (let pass = 0; pass < 5; pass += 1) {
      const { normalized, outbox } = await this.readResultOutbox(context);
      const sinks = outbox.sinks;
      const stateRevision = Number(outbox.stateRevision);
      if (!Number.isSafeInteger(stateRevision) || stateRevision < 0) {
        throw new LegacyCommandError("RESULT_SIDE_EFFECT_OUTBOX_INVALID", "Result outbox stateRevision is invalid", {
          httpStatus: 503,
          terminal: false,
        });
      }
      let state = "PENDING";
      if (sinks.some((sink) => sink.status === "UNKNOWN")) state = "RECOVERY_REQUIRED";
      else if (sinks.every((sink) => TERMINAL_RESULT_SINK_STATES.has(sink.status))) state = "DELIVERED";
      else if (sinks.some((sink) => sink.status === "PROCESSING")) state = "PROCESSING";
      else if (sinks.some((sink) => sink.status === "RETRYABLE")) state = "RETRY_REQUIRED";
      const nowIso = this.now().toISOString();
      const write = await this.db.collection(LEGACY_COMMAND_COLLECTIONS.results).updateOne(
        {
          tenantKey: normalized.tenantKey,
          id: normalized.resultId,
          revision: normalized.resultRevision,
          "legacyGameProjectionOutbox.bundleId": normalized.bundleId,
          "legacyGameProjectionOutbox.stateRevision": stateRevision,
        },
        {
          $set: {
            "legacyGameProjectionOutbox.status": state,
            "legacyGameProjectionOutbox.updatedAt": nowIso,
            ...(state === "DELIVERED" ? { "legacyGameProjectionOutbox.completedAt": nowIso } : {}),
          },
          $inc: { "legacyGameProjectionOutbox.stateRevision": 1 },
        },
        { writeConcern: { w: "majority" } },
      );
      if (write.matchedCount === 1) {
        return { state, response: clone(outbox.response) || null, sinks: clone(sinks) };
      }
    }
    throw new LegacyCommandError("RESULT_OUTBOX_STATE_CONFLICT", "Result outbox aggregate changed during terminalization", {
      httpStatus: 409,
      terminal: false,
    });
  }

  async claimResultSideEffect(context, { leaseMs = 30_000, maxAttempts = 3 } = {}) {
    const normalizedLeaseMs = Math.max(1_000, Math.min(Number(leaseMs) || 30_000, 300_000));
    const normalizedMaxAttempts = Math.max(1, Math.min(Number(maxAttempts) || 3, 10));
    for (let pass = 0; pass < 3; pass += 1) {
      const { normalized, outbox, sink } = await this.readResultOutbox(context);
      if (TERMINAL_RESULT_SINK_STATES.has(sink.status)) {
        const aggregate = await this.refreshResultOutboxState(normalized);
        return { claimed: false, sinkState: sink.status, outboxState: aggregate.state, response: aggregate.response };
      }
      if (sink.dependsOnSinkKey) {
        const dependency = outbox.sinks.find((candidate) => candidate?.key === sink.dependsOnSinkKey);
        if (!dependency || !new Set(["DELIVERED", "SKIPPED", "SUPERSEDED"]).has(dependency.status)) {
          return {
            claimed: false,
            sinkState: sink.status,
            outboxState: outbox.status,
            blockedBySinkKey: sink.dependsOnSinkKey,
          };
        }
      }
      const now = this.now();
      const nowIso = now.toISOString();
      const leaseExpired = !isValidIsoTimestamp(sink.leaseUntil) || Date.parse(sink.leaseUntil) <= now.getTime();
      if (sink.status === "PROCESSING" && !leaseExpired) {
        return { claimed: false, sinkState: "PROCESSING", outboxState: outbox.status, leaseUntil: sink.leaseUntil };
      }
      const attempts = Math.max(0, Number(sink.attempts || 0));
      if (sink.status === "PROCESSING" && leaseExpired && normalized.retryPolicy === "AT_MOST_ONCE") {
        const write = await this.db.collection(LEGACY_COMMAND_COLLECTIONS.results).updateOne(
          {
            tenantKey: normalized.tenantKey,
            id: normalized.resultId,
            revision: normalized.resultRevision,
            "legacyGameProjectionOutbox.bundleId": normalized.bundleId,
            "legacyGameProjectionOutbox.sinks": {
              $elemMatch: { key: normalized.sinkKey, status: "PROCESSING", leaseToken: sink.leaseToken },
            },
          },
          {
            $set: {
              "legacyGameProjectionOutbox.sinks.$.status": "UNKNOWN",
              "legacyGameProjectionOutbox.sinks.$.lastError": "Provider attempt lost its ACK boundary; automatic replay is forbidden",
              "legacyGameProjectionOutbox.sinks.$.updatedAt": nowIso,
              "legacyGameProjectionOutbox.sinks.$.completedAt": nowIso,
            },
            $unset: {
              "legacyGameProjectionOutbox.sinks.$.leaseToken": "",
              "legacyGameProjectionOutbox.sinks.$.leaseUntil": "",
            },
            $inc: { "legacyGameProjectionOutbox.stateRevision": 1 },
          },
          { writeConcern: { w: "majority" } },
        );
        if (write.matchedCount === 1) {
          const aggregate = await this.refreshResultOutboxState(normalized);
          return { claimed: false, sinkState: "UNKNOWN", outboxState: aggregate.state, response: aggregate.response };
        }
        continue;
      }
      if (attempts >= normalizedMaxAttempts) {
        const write = await this.db.collection(LEGACY_COMMAND_COLLECTIONS.results).updateOne(
          {
            tenantKey: normalized.tenantKey,
            id: normalized.resultId,
            revision: normalized.resultRevision,
            "legacyGameProjectionOutbox.bundleId": normalized.bundleId,
            "legacyGameProjectionOutbox.sinks": {
              $elemMatch: {
                key: normalized.sinkKey,
                status: sink.status,
                ...(sink.leaseToken ? { leaseToken: sink.leaseToken } : {}),
              },
            },
          },
          {
            $set: {
              "legacyGameProjectionOutbox.sinks.$.status": "UNKNOWN",
              "legacyGameProjectionOutbox.sinks.$.lastError": "Result sink retry budget exhausted",
              "legacyGameProjectionOutbox.sinks.$.updatedAt": nowIso,
              "legacyGameProjectionOutbox.sinks.$.completedAt": nowIso,
            },
            $inc: { "legacyGameProjectionOutbox.stateRevision": 1 },
          },
          { writeConcern: { w: "majority" } },
        );
        if (write.matchedCount === 1) {
          const aggregate = await this.refreshResultOutboxState(normalized);
          return { claimed: false, sinkState: "UNKNOWN", outboxState: aggregate.state, response: aggregate.response };
        }
        continue;
      }
      const leaseToken = crypto.randomUUID();
      const leaseUntil = new Date(now.getTime() + normalizedLeaseMs).toISOString();
      const write = await this.db.collection(LEGACY_COMMAND_COLLECTIONS.results).updateOne(
        {
          tenantKey: normalized.tenantKey,
          id: normalized.resultId,
          revision: normalized.resultRevision,
          "legacyGameProjectionOutbox.bundleId": normalized.bundleId,
          "legacyGameProjectionOutbox.sinks": {
            $elemMatch: {
              key: normalized.sinkKey,
              status: sink.status,
              ...(sink.leaseToken ? { leaseToken: sink.leaseToken } : {}),
            },
          },
        },
        {
          $set: {
            "legacyGameProjectionOutbox.sinks.$.status": "PROCESSING",
            "legacyGameProjectionOutbox.sinks.$.leaseToken": leaseToken,
            "legacyGameProjectionOutbox.sinks.$.leaseUntil": leaseUntil,
            "legacyGameProjectionOutbox.sinks.$.lastClaimedAt": nowIso,
            "legacyGameProjectionOutbox.sinks.$.updatedAt": nowIso,
            "legacyGameProjectionOutbox.status": "PROCESSING",
            "legacyGameProjectionOutbox.updatedAt": nowIso,
          },
          $inc: {
            "legacyGameProjectionOutbox.sinks.$.attempts": 1,
            "legacyGameProjectionOutbox.stateRevision": 1,
          },
        },
        { writeConcern: { w: "majority" } },
      );
      if (write.matchedCount === 1) {
        return { claimed: true, leaseToken, leaseUntil, sinkState: "PROCESSING", outboxState: "PROCESSING" };
      }
    }
    throw new LegacyCommandError("RESULT_OUTBOX_CLAIM_CONFLICT", "Result side-effect sink changed while being claimed", {
      httpStatus: 409,
      terminal: false,
    });
  }

  async completeResultSideEffect(context, { leaseToken, outcome, error = null } = {}) {
    const normalized = normalizeResultSinkContext(context);
    const normalizedLeaseToken = assertCanonicalString(leaseToken, "leaseToken");
    let normalizedOutcome = String(outcome || "").trim().toUpperCase();
    let normalizedError = toStringOrNull(error);
    if (!new Set(["DELIVERED", "SKIPPED", "SUPERSEDED", "RETRYABLE", "UNKNOWN"]).has(normalizedOutcome)) {
      throw new LegacyCommandError("RESULT_OUTBOX_CONTEXT_INVALID", "Unsupported result sink outcome", {
        httpStatus: 500,
        terminal: false,
      });
    }
    if (normalized.retryPolicy === "AT_MOST_ONCE" && normalizedOutcome === "RETRYABLE") {
      throw new LegacyCommandError("RESULT_OUTBOX_CONTEXT_INVALID", "Provider sink failures cannot be retried automatically", {
        httpStatus: 500,
        terminal: false,
      });
    }
    if (normalized.kind === "PROVIDER" && normalizedOutcome === "DELIVERED") {
      const current = await this.readResultOutbox(normalized);
      const providerOutboxId = toStringOrNull(current.sink.providerOutboxId);
      const providerRow = providerOutboxId
        ? await this.db.collection(LEGACY_COMMAND_COLLECTIONS.resultVivaSyncOutbox).findOne(
          {
            _id: providerOutboxId,
            id: providerOutboxId,
            tenantKey: normalized.tenantKey,
            resultId: normalized.resultId,
            resultRevision: normalized.resultRevision,
            status: "SYNCED",
            retryable: false,
          },
          { readPreference: "primary", readConcern: { level: "majority" } },
        )
        : null;
      if (!providerRow) {
        normalizedOutcome = "UNKNOWN";
        normalizedError = "Provider success was not visible through primary-majority read-back";
      }
    }
    const nowIso = this.now().toISOString();
    const write = await this.db.collection(LEGACY_COMMAND_COLLECTIONS.results).updateOne(
      {
        tenantKey: normalized.tenantKey,
        id: normalized.resultId,
        revision: normalized.resultRevision,
        "legacyGameProjectionOutbox.bundleId": normalized.bundleId,
        "legacyGameProjectionOutbox.sinks": {
          $elemMatch: { key: normalized.sinkKey, status: "PROCESSING", leaseToken: normalizedLeaseToken },
        },
      },
      {
        $set: {
          "legacyGameProjectionOutbox.sinks.$.status": normalizedOutcome,
          "legacyGameProjectionOutbox.sinks.$.updatedAt": nowIso,
          "legacyGameProjectionOutbox.sinks.$.lastError": normalizedError,
          ...(TERMINAL_RESULT_SINK_STATES.has(normalizedOutcome)
            ? { "legacyGameProjectionOutbox.sinks.$.completedAt": nowIso }
            : {}),
        },
        $unset: {
          "legacyGameProjectionOutbox.sinks.$.leaseToken": "",
          "legacyGameProjectionOutbox.sinks.$.leaseUntil": "",
        },
        $inc: { "legacyGameProjectionOutbox.stateRevision": 1 },
      },
      { writeConcern: { w: "majority" } },
    );
    let effectiveOutcome = normalizedOutcome;
    if (write.matchedCount !== 1) {
      const existing = await this.readResultOutbox(normalized);
      if (TERMINAL_RESULT_SINK_STATES.has(existing.sink.status)) {
        if (existing.sink.status !== normalizedOutcome) {
          throw new LegacyCommandError("RESULT_OUTBOX_ACK_CONFLICT", "Result sink ACK conflicts with its durable terminal outcome", {
            httpStatus: 409,
            terminal: false,
          });
        }
        effectiveOutcome = existing.sink.status;
      } else {
        throw new LegacyCommandError("RESULT_OUTBOX_ACK_CONFLICT", "Result sink ACK did not match its active lease", {
          httpStatus: 409,
          terminal: false,
        });
      }
    }
    const aggregate = await this.refreshResultOutboxState(normalized);
    return { sinkState: effectiveOutcome, outboxState: aggregate.state, response: aggregate.response };
  }

  async persistCleanupReconciliationIntent(input) {
    if (!isObject(input)) throw new LegacyCommandError("CLEANUP_RECOVERY_CONTEXT_INVALID", "Cleanup recovery context is required", { httpStatus: 500, terminal: false });
    const tenantKey = assertCanonicalString(input.tenantKey, "tenantKey");
    const intentId = assertCanonicalString(input.intentId, "intentId");
    const legacyGameId = assertCanonicalString(input.legacyGameId, "legacyGameId");
    const operationKey = assertCanonicalString(input.operationKey, "operationKey");
    const sourceRevision = Number(input.sourceRevision);
    if (!Number.isSafeInteger(sourceRevision) || sourceRevision < 1) {
      throw new LegacyCommandError("CLEANUP_RECOVERY_CONTEXT_INVALID", "sourceRevision must be a positive safe integer", { httpStatus: 500, terminal: false });
    }
    const nowIso = this.now().toISOString();
    const collection = this.db.collection(LEGACY_COMMAND_COLLECTIONS.cleanupReconciliationIntents);
    await collection.updateOne(
      { tenantKey, intentId },
      {
        $setOnInsert: {
          _id: intentId,
          intentId,
          kind: "LEGACY_GAME_CLEANUP_CAS_RECONCILIATION",
          tenantKey,
          legacyGameId,
          sourceRevision,
          operationKey,
          createdAt: nowIso,
        },
        $set: {
          status: "PENDING_MANUAL_REVIEW",
          reason: toStringOrNull(input.reason) || "REVISION_CONFLICT",
          updatedAt: nowIso,
        },
      },
      { upsert: true, writeConcern: { w: "majority" } },
    );
    const readBack = await collection.findOne(
      { tenantKey, intentId },
      { readPreference: "primary", readConcern: { level: "majority" } },
    );
    if (!readBack || readBack.status !== "PENDING_MANUAL_REVIEW" || readBack.legacyGameId !== legacyGameId) {
      throw new LegacyCommandError("CLEANUP_RECONCILIATION_NOT_DURABLE", "Cleanup recovery intent failed majority read-back", {
        httpStatus: 503,
        terminal: false,
      });
    }
    return { persisted: true, intentId, status: readBack.status };
  }

  async reconcileAmbiguousCommit(input, operationId) {
    let marker = null;
    for (let attempt = 1; attempt <= this.ambiguousReadAttempts; attempt += 1) {
      const existing = await this.readExistingCommand(input);
      if (existing) return existing;
      marker = await this.db.collection(LEGACY_COMMAND_COLLECTIONS.games).findOne(
        {
          tenantKey: input.tenantKey,
          id: input.legacyGameId,
          "legacyCommand.lastOperationId": operationId,
        },
        {
          projection: { id: 1, revision: 1, legacyCommand: 1 },
          readPreference: "primary",
          readConcern: { level: "majority" },
        },
      );
      if (marker) break;
      if (attempt < this.ambiguousReadAttempts) await this.ambiguousReadBarrier(attempt);
    }
    const nowIso = this.now().toISOString();
    const unknownResult = {
      operationId,
      command: input.command,
      status: "UNKNOWN",
      replayed: false,
      legacyGameId: input.legacyGameId,
      error: {
        code: "COMMAND_STATE_UNKNOWN",
        message: marker
          ? "Game marker exists without terminal ledger"
          : "No terminal majority evidence was visible after an ambiguous commit",
      },
    };
    try {
      await this.db.collection(LEGACY_COMMAND_COLLECTIONS.commands).insertOne(
        {
          tenantKey: input.tenantKey,
          idempotencyKey: input.idempotencyKey,
          requestHash: input.requestHash,
          operationId,
          correlationId: input.correlationId,
          command: input.command,
          canonicalUserId: input.canonicalUserId,
          legacyGameId: input.legacyGameId,
          state: "UNKNOWN",
          result: unknownResult,
          sourceVersionAfter: marker?.revision || null,
          reconciliationEvidence: {
            majorityReadAttempts: this.ambiguousReadAttempts,
            markerObserved: Boolean(marker),
          },
          createdAt: nowIso,
          updatedAt: nowIso,
          completedAt: nowIso,
        },
        { writeConcern: { w: "majority" } },
      );
    } catch (error) {
      if (error?.code !== 11000) throw error;
      for (let attempt = 1; attempt <= this.ambiguousReadAttempts; attempt += 1) {
        const existing = await this.readExistingCommand(input);
        if (existing) return existing;
        if (attempt < this.ambiguousReadAttempts) await this.ambiguousReadBarrier(attempt);
      }
      throw new LegacyCommandError(
        "COMMAND_STATE_UNKNOWN",
        "The UNKNOWN fence raced with delayed majority evidence; automatic mutation retry remains forbidden",
        { httpStatus: 503, terminal: false, details: { operationId } },
      );
    }
    throw new LegacyCommandError(
      "COMMAND_STATE_UNKNOWN",
      "The transaction commit result is unresolved; retry is fenced by an UNKNOWN ledger",
      { httpStatus: 503, terminal: false, details: { operationId } },
    );
  }

  async executeLegacyGameCommandTransaction(input) {
    assertInput(input);
    const normalized = {
      ...input,
      tenantKey: input.tenantKey.trim(),
      idempotencyKey: input.idempotencyKey.toLowerCase(),
      requestHash: input.requestHash.toLowerCase(),
      canonicalUserId: input.canonicalUserId.toLowerCase(),
      legacyGameId: input.legacyGameId.trim(),
    };
    const operationId = this.operationIdFactory();
    const session = this.client.startSession({ causalConsistency: true });
    let transactionResult;

    try {
      await this.transactionExecutor(session, async () => {
        const nowIso = this.now().toISOString();
        const commands = this.db.collection(LEGACY_COMMAND_COLLECTIONS.commands);
        await commands.insertOne({
          tenantKey: normalized.tenantKey,
          idempotencyKey: normalized.idempotencyKey,
          requestHash: normalized.requestHash,
          operationId,
          correlationId: normalized.correlationId,
          command: normalized.command,
          canonicalUserId: normalized.canonicalUserId,
          legacyGameId: normalized.legacyGameId,
          state: "CLAIMED",
          expectedRevision: normalized.expectedRevision,
          createdAt: nowIso,
          updatedAt: nowIso,
        }, { session });

        try {
          const mappings = await this.db.collection(LEGACY_COMMAND_COLLECTIONS.mappings).find({
            tenantKey: normalized.tenantKey,
            canonicalUserId: normalized.canonicalUserId,
          }, { session }).limit(2).toArray();
          if (mappings.length === 0) {
            throw new LegacyCommandError("ACTOR_MAPPING_NOT_FOUND", "Canonical actor has no legacy mapping", { httpStatus: 404 });
          }
          if (mappings.length !== 1) {
            throw new LegacyCommandError("ACTOR_MAPPING_AMBIGUOUS", "Canonical actor mapping is ambiguous", { httpStatus: 409 });
          }
          const mapping = mappings[0];
          if (mapping.status !== "ACTIVE") {
            throw new LegacyCommandError("ACTOR_MAPPING_REVOKED", "Canonical actor mapping is revoked", { httpStatus: 403 });
          }
          const mappingErrors = validateLegacyIdentityMapping(mapping);
          if (mappingErrors.length) {
            throw new LegacyCommandError("ACTOR_MAPPING_INVALID", "Legacy actor mapping evidence is invalid", {
              httpStatus: 409,
              details: { fields: mappingErrors },
            });
          }

          const games = this.db.collection(LEGACY_COMMAND_COLLECTIONS.games);
          const game = await games.findOne({
            tenantKey: normalized.tenantKey,
            id: normalized.legacyGameId,
            archived: { $ne: true },
          }, { session });
          if (!game) throw new LegacyCommandError("LEGACY_GAME_NOT_FOUND", "Legacy game was not found", { httpStatus: 404 });
          if (!Number.isSafeInteger(game.revision) || game.revision < 1) {
            throw new LegacyCommandError("LEGACY_GAME_REVISION_REQUIRED", "Legacy game has no valid revision", { httpStatus: 409 });
          }
          if (game.revision !== normalized.expectedRevision) {
            throw new LegacyCommandError("LEGACY_GAME_VERSION_CONFLICT", "Legacy game revision changed", { httpStatus: 409 });
          }

          await commands.updateOne(
            { tenantKey: normalized.tenantKey, operationId },
            { $set: { state: "APPLYING", legacyUserId: mapping.legacyUserId, sourceVersionBefore: game.revision, updatedAt: nowIso } },
            { session },
          );

          const builtPlan = normalized.buildMutation({
            game: clone(game),
            mapping: clone(mapping),
            legacyUserId: mapping.legacyUserId,
            operationId,
          });
          if (builtPlan && typeof builtPlan.then === "function") {
            throw new LegacyCommandError("INVALID_MUTATION_PLAN", "buildMutation must be synchronous and deterministic", { httpStatus: 500, terminal: false });
          }
          const plan = validateMutationPlan(builtPlan);
          const update = clone(plan.update);
          update.$set = {
            ...(update.$set || {}),
            updatedAt: nowIso,
            "legacyCommand.lastOperationId": operationId,
            "legacyCommand.lastIdempotencyKey": normalized.idempotencyKey,
          };
          update.$inc = { ...(update.$inc || {}), revision: 1 };
          const filter = {
            ...(isObject(plan.filter) ? plan.filter : {}),
            tenantKey: normalized.tenantKey,
            id: normalized.legacyGameId,
            archived: { $ne: true },
            revision: normalized.expectedRevision,
          };
          const write = await games.updateOne(filter, update, { session });
          if (write.matchedCount !== 1) {
            throw new LegacyCommandError("LEGACY_GAME_VERSION_CONFLICT", "Legacy game compare-and-set failed", { httpStatus: 409 });
          }

          const intentBase = {
            tenantKey: normalized.tenantKey,
            operationId,
            command: normalized.command,
            legacyGameId: normalized.legacyGameId,
            createdAt: nowIso,
          };
          const auditIntents = (plan.auditIntents || []).map((intent, index) => ({
            ...intentBase,
            intentKey: toStringOrNull(intent?.intentKey) || `audit:${index}`,
            payload: clone(intent?.payload) || {},
          }));
          const outboxIntents = (plan.outboxIntents || []).map((intent, index) => ({
            ...intentBase,
            intentKey: toStringOrNull(intent?.intentKey) || `outbox:${index}`,
            kind: toStringOrNull(intent?.kind) || "UNSPECIFIED",
            payload: clone(intent?.payload) || {},
            state: "PENDING",
          }));
          if (auditIntents.length) {
            await this.db.collection(LEGACY_COMMAND_COLLECTIONS.auditIntents).insertMany(auditIntents, { session });
          }
          if (outboxIntents.length) {
            await this.db.collection(LEGACY_COMMAND_COLLECTIONS.outboxIntents).insertMany(outboxIntents, { session });
          }

          const authoritativeGame = await games.findOne(
            { tenantKey: normalized.tenantKey, id: normalized.legacyGameId },
            { session, readPreference: "primary" },
          );
          if (!authoritativeGame || authoritativeGame.revision !== normalized.expectedRevision + 1
            || authoritativeGame.legacyCommand?.lastOperationId !== operationId) {
            throw new LegacyCommandError(
              "AUTHORITATIVE_READBACK_MISMATCH",
              "Transactional authoritative read-back did not match the mutation",
              { httpStatus: 503, terminal: false },
            );
          }
          if (typeof plan.verifyReadBack === "function" && plan.verifyReadBack(clone(authoritativeGame)) !== true) {
            throw new LegacyCommandError(
              "AUTHORITATIVE_READBACK_MISMATCH",
              "Domain read-back verification failed",
              { httpStatus: 503, terminal: false },
            );
          }

          const result = {
            operationId,
            command: normalized.command,
            status: "SUCCEEDED",
            replayed: false,
            legacyGameId: normalized.legacyGameId,
            actor: {
              canonicalUserId: normalized.canonicalUserId,
              legacyUserId: mapping.legacyUserId,
            },
            sourceVersionBefore: game.revision,
            sourceVersionAfter: authoritativeGame.revision,
            authoritativeReadBack: clone(plan.buildResult?.(clone(authoritativeGame)) || {
              revision: authoritativeGame.revision,
              observedAt: nowIso,
            }),
          };
          await commands.updateOne(
            { tenantKey: normalized.tenantKey, operationId, state: "APPLYING" },
            {
              $set: {
                state: "SUCCEEDED",
                result,
                sourceVersionAfter: authoritativeGame.revision,
                authoritativeReadBack: result.authoritativeReadBack,
                updatedAt: nowIso,
                completedAt: nowIso,
              },
            },
            { session },
          );
          transactionResult = result;
        } catch (error) {
          if (!(error instanceof LegacyCommandError) || error.terminal === false) throw error;
          const rejected = {
            operationId,
            command: normalized.command,
            status: "REJECTED",
            replayed: false,
            legacyGameId: normalized.legacyGameId,
            error: { code: error.code, message: error.message },
          };
          await commands.updateOne(
            { tenantKey: normalized.tenantKey, operationId },
            { $set: { state: "REJECTED", result: rejected, error: rejected.error, updatedAt: nowIso, completedAt: nowIso } },
            { session },
          );
          transactionResult = rejected;
        }
      }, {
        readConcern: { level: "snapshot" },
        writeConcern: { w: "majority" },
        readPreference: "primary",
        maxCommitTimeMS: 10_000,
      });
      return transactionResult;
    } catch (error) {
      if (error?.code === 11000) {
        const existing = await this.readExistingCommand(normalized);
        if (existing) return existing;
      }
      if (isUnknownCommit(error)) {
        const reconciled = await this.reconcileAmbiguousCommit(normalized, operationId);
        if (reconciled) return reconciled;
      }
      throw error;
    } finally {
      await session.endSession();
    }
  }
}
