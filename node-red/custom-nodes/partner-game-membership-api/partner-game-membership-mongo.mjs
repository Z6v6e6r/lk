import crypto from "node:crypto";

import { PartnerApiError, PartnerProviderError, sha256Hex } from "./partner-game-membership-core.mjs";

export const PARTNER_MEMBERSHIP_COLLECTIONS = Object.freeze({
  nonces: "lk_partner_api_nonces",
  operations: "lk_partner_game_operations",
  memberships: "lk_partner_game_memberships",
  audit: "lk_partner_api_audit",
  outbox: "lk_partner_game_outbox",
  games: "lk_games",
});

export const PARTNER_MEMBERSHIP_INDEX_SPECS = Object.freeze({
  nonces: [
    { key: { expiresAt: 1 }, name: "ttl_partner_nonce_expiry", expireAfterSeconds: 0 },
  ],
  operations: [
    { key: { clientId: 1, idempotencyKey: 1 }, name: "uniq_partner_client_idempotency", unique: true },
    { key: { clientId: 1, correlationId: 1 }, name: "partner_client_correlation" },
  ],
  memberships: [
    { key: { activeKey: 1 }, name: "uniq_partner_active_membership", unique: true, sparse: true },
    { key: { clientId: 1, "payment.reference": 1 }, name: "uniq_partner_payment_reference", unique: true },
    { key: { clientId: 1, tenantKey: 1, gameId: 1, externalPlayerId: 1, generation: -1 }, name: "partner_owner_history" },
  ],
  audit: [
    { key: { at: -1, clientId: 1 }, name: "partner_audit_time_client" },
    { key: { correlationId: 1 }, name: "partner_audit_correlation", sparse: true },
  ],
  outbox: [
    { key: { operationId: 1, eventType: 1 }, name: "uniq_partner_outbox_event", unique: true },
    { key: { state: 1, createdAt: 1 }, name: "partner_outbox_delivery" },
  ],
  games: [
    { key: { tenantKey: 1, id: 1 }, name: "uniq_tenant_game_id", unique: true },
  ],
});

const JOINABLE_GAME_STATUSES = new Set([
  "OPEN",
  "PUBLISHED",
  "ACTIVE",
  "CREATED",
  "PAID",
  "PAYMENT_PENDING",
]);
const ACTIVE_MEMBER_STATES = new Set(["SLOT_RESERVED", "VIVA_PENDING", "ACTIVE", "REMOVAL_PENDING", "UNKNOWN"]);

const isDuplicateKey = (error) => Number(error?.code) === 11000;
const toText = (value) => (value === null || value === undefined ? "" : String(value).trim());
const asArray = (value) => (Array.isArray(value) ? value : []);

const membershipActiveKey = (clientId, tenantKey, gameId, externalPlayerId) => (
  sha256Hex(JSON.stringify([clientId, tenantKey, gameId, externalPlayerId]))
);

const canonicalTenantKey = (tenantKey) => {
  const validTenantKey = tenantKey === null
    || (typeof tenantKey === "string"
      && tenantKey.length > 0
      && tenantKey.length <= 128
      && tenantKey === tenantKey.trim()
      && [...tenantKey].every((character) => character.charCodeAt(0) >= 32 && character.charCodeAt(0) !== 127));
  if (!validTenantKey) {
    throw new PartnerApiError("GAME_TENANT_POLICY_INVALID", "Authorized game tenant is invalid", {
      httpStatus: 503,
      expose: false,
    });
  }
  return tenantKey;
};

const gameIdentifierFilter = (gameId, tenantKey, gameDocumentId) => {
  const canonicalTenant = canonicalTenantKey(tenantKey);
  return {
    ...(gameDocumentId === undefined ? {} : { _id: gameDocumentId }),
    id: gameId,
    tenantKey: canonicalTenant === null ? { $type: 10 } : canonicalTenant,
  };
};

const exactGameIdentity = (game, gameId, tenantKey) => Boolean(
  game
  && typeof game.id === "string"
  && game.id === gameId
  && Object.hasOwn(game, "tenantKey")
  && game.tenantKey === tenantKey
  && game._id !== null
  && game._id !== undefined,
);

const gameStationId = (game) => toText(
  game?.stationId
  || game?.clubId
  || game?.booking?.studioId
  || game?.metadata?.stationId
  || game?.metadata?.studioId,
);

const gameExerciseId = (game) => toText(
  game?.exerciseId
  || game?.booking?.vivaExerciseId
  || game?.booking?.exerciseId
  || game?.metadata?.exerciseId,
);

const gameCapacity = (game, authorizedCapacity) => {
  if (typeof authorizedCapacity !== "number"
    || !Number.isSafeInteger(authorizedCapacity)
    || ![2, 4].includes(authorizedCapacity)) {
    throw new PartnerApiError("GAME_CAPACITY_POLICY_INVALID", "Authorized game capacity is invalid", {
      httpStatus: 503,
      expose: false,
    });
  }
  const rawSignals = [
    ["authorization.capacity", authorizedCapacity],
    ["maxPlayers", game?.maxPlayers],
    ["capacity", game?.capacity],
    ["invite.maxPlayers", game?.invite?.maxPlayers],
    ["splitPayment.totalSpots", game?.splitPayment?.totalSpots],
    ["splitPayment.maxPlayers", game?.splitPayment?.maxPlayers],
    ["metadata.capacity", game?.metadata?.capacity],
    ["metadata.maxPlayers", game?.metadata?.maxPlayers],
  ];
  const signals = rawSignals
    .filter(([, value]) => value !== null && value !== undefined && value !== "")
    .map(([source, value]) => {
      if (typeof value !== "number" || !Number.isSafeInteger(value) || ![2, 4].includes(value)) {
        throw new PartnerApiError("GAME_CAPACITY_INVALID", `Game capacity is invalid at ${source}`, { httpStatus: 409 });
      }
      return { source, capacity: value };
    });
  const formatSignals = [
    ["metadata.gameFormat", game?.metadata?.gameFormat],
    ["metadata.format", game?.metadata?.format],
  ];
  for (const [source, value] of formatSignals) {
    if (value === null || value === undefined || value === "") continue;
    if (typeof value !== "string") {
      throw new PartnerApiError("GAME_CAPACITY_INVALID", `Game format is invalid at ${source}`, { httpStatus: 409 });
    }
    const format = value.trim().toLowerCase();
    const capacity = format === "singles" || /^(1\s*(?:x|х|на)\s*1)$/.test(format)
      ? 2
      : (format === "doubles" || /^(2\s*(?:x|х|на)\s*2)$/.test(format) ? 4 : null);
    if (!capacity) {
      throw new PartnerApiError("GAME_CAPACITY_INVALID", `Game format is unsupported at ${source}`, { httpStatus: 409 });
    }
    signals.push({ source, capacity });
  }
  if (signals.length === 0) {
    throw new PartnerApiError("GAME_CAPACITY_UNKNOWN", "Game capacity is not available", { httpStatus: 409 });
  }
  const capacities = new Set(signals.map(({ capacity }) => capacity));
  if (capacities.size !== 1) {
    throw new PartnerApiError("GAME_CAPACITY_CONFLICT", "Game capacity sources conflict", { httpStatus: 409 });
  }
  return signals[0].capacity;
};

const activeParticipants = (game) => asArray(game?.participants).filter((participant) => {
  const status = toText(participant?.status).toUpperCase();
  return status !== "LEFT" && status !== "REMOVED" && status !== "CANCELLED";
});

export const assertGameAllowsExternalMember = (game, allowedStationIds, now = new Date(), authorizedCapacity) => {
  if (!game) throw new PartnerApiError("GAME_NOT_FOUND", "Game not found", { httpStatus: 404 });
  const statuses = [game.status, game.state]
    .map((value) => toText(value).toUpperCase())
    .filter(Boolean);
  const visibilitySignals = [];
  if (typeof game?.settings?.isPrivate === "boolean") visibilitySignals.push(!game.settings.isPrivate);
  if (typeof game?.isPublic === "boolean") visibilitySignals.push(game.isPublic);
  if (typeof game?.public === "boolean") visibilitySignals.push(game.public);
  const invalidVisibility = [game?.settings?.isPrivate, game?.isPublic, game?.public]
    .some((value) => value !== null && value !== undefined && typeof value !== "boolean");
  const hasPrivateOrConflictingVisibility = invalidVisibility
    || visibilitySignals.some((isPublic) => !isPublic);
  const hasInvalidLifecycle = statuses.length === 0
    || statuses.some((status) => !JOINABLE_GAME_STATUSES.has(status));
  if (game.archived === true || hasPrivateOrConflictingVisibility || hasInvalidLifecycle) {
    throw new PartnerApiError("GAME_NOT_OPEN", "Only an open game can accept integration members", { httpStatus: 409 });
  }
  const booking = game?.booking && typeof game.booking === "object" ? game.booking : {};
  const endTsPresent = Object.prototype.hasOwnProperty.call(booking, "endTs");
  const startTsPresent = Object.prototype.hasOwnProperty.call(booking, "startTs");
  const joinableUntilRaw = endTsPresent ? booking.endTs : (startTsPresent ? booking.startTs : null);
  const joinableUntil = joinableUntilRaw === null || joinableUntilRaw === undefined || joinableUntilRaw === ""
    ? Number.NaN
    : Number(joinableUntilRaw);
  const nowMs = now instanceof Date ? now.getTime() : new Date(now).getTime();
  if (!Number.isFinite(joinableUntil) || !Number.isFinite(nowMs)) {
    throw new PartnerApiError("GAME_SCHEDULE_UNKNOWN", "Game schedule is not available", { httpStatus: 409 });
  }
  if (joinableUntil < nowMs) {
    throw new PartnerApiError("GAME_NOT_OPEN", "Only an open game can accept integration members", { httpStatus: 409 });
  }
  const stationId = gameStationId(game);
  if (!stationId || !Array.isArray(allowedStationIds) || !allowedStationIds.includes(stationId)) {
    throw new PartnerApiError("STATION_ACCESS_DENIED", "Integration client cannot mutate this station", { httpStatus: 403 });
  }
  const exerciseId = gameExerciseId(game);
  if (!exerciseId) {
    throw new PartnerApiError("VIVA_EXERCISE_UNKNOWN", "Game has no canonical Viva exercise binding", { httpStatus: 409 });
  }
  return { stationId, exerciseId, capacity: gameCapacity(game, authorizedCapacity) };
};

const transactionOptions = {
  readConcern: { level: "snapshot" },
  writeConcern: { w: "majority" },
  readPreference: "primary",
};

export class MongoPartnerGameMembershipRepository {
  constructor(options) {
    this.client = options.client;
    this.db = options.db;
    this.ownsClient = options.ownsClient === true;
    this.transactionExecutor = options.transactionExecutor
      || ((session, callback) => session.withTransaction(callback, transactionOptions));
  }

  async close() {
    if (this.ownsClient) await this.client.close();
  }

  async ensureIndexesForIsolatedTest() {
    for (const [logicalName, specs] of Object.entries(PARTNER_MEMBERSHIP_INDEX_SPECS)) {
      const collection = this.db.collection(PARTNER_MEMBERSHIP_COLLECTIONS[logicalName]);
      for (const spec of specs) {
        const { key, ...indexOptions } = spec;
        await collection.createIndex(key, indexOptions);
      }
    }
  }

  async verifyRequiredIndexes() {
    const mismatches = [];
    for (const [logicalName, specs] of Object.entries(PARTNER_MEMBERSHIP_INDEX_SPECS)) {
      const actual = await this.db.collection(PARTNER_MEMBERSHIP_COLLECTIONS[logicalName]).indexes();
      for (const spec of specs) {
        const candidate = actual.find((item) => item.name === spec.name);
        if (!candidate) {
          mismatches.push(`${logicalName}:${spec.name}:missing`);
          continue;
        }
        if (JSON.stringify(candidate.key) !== JSON.stringify(spec.key)) mismatches.push(`${logicalName}:${spec.name}:key`);
        for (const option of ["unique", "sparse", "expireAfterSeconds"]) {
          if ((candidate[option] ?? false) !== (spec[option] ?? false)) mismatches.push(`${logicalName}:${spec.name}:${option}`);
        }
        for (const forbiddenOption of ["partialFilterExpression", "collation", "hidden"]) {
          if (candidate[forbiddenOption] !== undefined) mismatches.push(`${logicalName}:${spec.name}:${forbiddenOption}`);
        }
      }
    }
    if (mismatches.length) {
      throw new PartnerApiError("MONGO_PREREQUISITES_MISSING", "Partner API Mongo indexes are missing or weakened", {
        httpStatus: 503,
        expose: false,
        details: { mismatches },
      });
    }
    return true;
  }

  async consumeNonce(input) {
    const id = sha256Hex(`${input.clientId}\n${input.keyId}\n${input.nonce}`);
    try {
      await this.db.collection(PARTNER_MEMBERSHIP_COLLECTIONS.nonces).insertOne({
        _id: id,
        clientId: input.clientId,
        keyId: input.keyId,
        nonceHash: sha256Hex(input.nonce),
        timestamp: input.timestamp,
        correlationId: input.correlationId,
        createdAt: new Date(),
        expiresAt: input.expiresAt,
      }, { writeConcern: { w: "majority" } });
    } catch (error) {
      if (isDuplicateKey(error)) {
        throw new PartnerApiError("REQUEST_REPLAY_DETECTED", "Request nonce was already consumed", { httpStatus: 409 });
      }
      throw error;
    }
  }

  async appendAudit(entry) {
    await this.db.collection(PARTNER_MEMBERSHIP_COLLECTIONS.audit).insertOne({
      _id: crypto.randomUUID(),
      schemaVersion: 1,
      ...entry,
    }, { writeConcern: { w: "majority" } });
  }

  async beginOperation(input) {
    const operation = {
      _id: input.operationId,
      operationId: input.operationId,
      schemaVersion: 1,
      clientId: input.clientId,
      keyId: input.keyId,
      idempotencyKey: input.idempotencyKey,
      correlationId: input.correlationId,
      requestHash: input.requestHash,
      action: input.action,
      gameId: input.gameId,
      tenantKey: input.tenantKey,
      membershipId: input.membershipId,
      state: "RECEIVED",
      createdAt: input.createdAt,
      updatedAt: input.createdAt,
    };
    try {
      await this.db.collection(PARTNER_MEMBERSHIP_COLLECTIONS.operations).insertOne(operation, {
        writeConcern: { w: "majority" },
      });
      return { ...operation, replayed: false };
    } catch (error) {
      if (!isDuplicateKey(error)) throw error;
      const existing = await this.db.collection(PARTNER_MEMBERSHIP_COLLECTIONS.operations).findOne({
        clientId: input.clientId,
        idempotencyKey: input.idempotencyKey,
      }, { readPreference: "primary" });
      if (!existing) throw error;
      return { ...existing, replayed: true };
    }
  }

  async reserveAdd(input) {
    const session = this.client.startSession();
    let result;
    try {
      await this.transactionExecutor(session, async () => {
        const operations = this.db.collection(PARTNER_MEMBERSHIP_COLLECTIONS.operations);
        const memberships = this.db.collection(PARTNER_MEMBERSHIP_COLLECTIONS.memberships);
        const games = this.db.collection(PARTNER_MEMBERSHIP_COLLECTIONS.games);
        const operation = await operations.findOne({ _id: input.operationId, state: "RECEIVED" }, { session });
        if (!operation) throw new PartnerApiError("OPERATION_STATE_CONFLICT", "Operation is not reservable", { httpStatus: 409 });
        const game = await games.findOne(gameIdentifierFilter(input.gameId, input.authorizedTenantKey), { session });
        if (game && !exactGameIdentity(game, input.gameId, input.authorizedTenantKey)) {
          throw new PartnerApiError("GAME_IDENTITY_CONFLICT", "Game identity is not canonical", { httpStatus: 409 });
        }
        const gameInfo = assertGameAllowsExternalMember(
          game,
          input.allowedStationIds,
          input.now,
          input.authorizedCapacity,
        );
        const pendingCount = await memberships.countDocuments({
          tenantKey: input.authorizedTenantKey,
          gameId: input.gameId,
          gameDocumentId: game._id,
          $or: [
            { state: { $in: ["SLOT_RESERVED", "VIVA_PENDING"] } },
            { state: "UNKNOWN", removalOperationId: { $exists: false } },
          ],
        }, { session });
        if (activeParticipants(game).length + pendingCount >= gameInfo.capacity) {
          throw new PartnerApiError("GAME_FULL", "Game has no available places", { httpStatus: 409 });
        }
        const latest = await memberships.find({
          clientId: input.clientId,
          tenantKey: input.authorizedTenantKey,
          gameId: input.gameId,
          gameDocumentId: game._id,
          externalPlayerId: input.externalPlayerId,
        }, { session }).sort({ generation: -1 }).limit(1).next();
        const membershipId = crypto.randomUUID();
        const membership = {
          _id: membershipId,
          membershipId,
          schemaVersion: 1,
          activeKey: membershipActiveKey(
            input.clientId,
            input.authorizedTenantKey,
            input.gameId,
            input.externalPlayerId,
          ),
          clientId: input.clientId,
          tenantKey: input.authorizedTenantKey,
          gameId: input.gameId,
          gameDocumentId: game._id,
          externalPlayerId: input.externalPlayerId,
          displayName: input.displayName,
          payment: input.payment,
          generation: Number(latest?.generation || 0) + 1,
          authorizedCapacity: gameInfo.capacity,
          exerciseId: gameInfo.exerciseId,
          stationId: gameInfo.stationId,
          operationId: input.operationId,
          state: "SLOT_RESERVED",
          createdAt: input.now,
          updatedAt: input.now,
        };
        try {
          await memberships.insertOne(membership, { session });
        } catch (error) {
          if (isDuplicateKey(error)) {
            if (error?.keyPattern?.["payment.reference"] === 1) {
              throw new PartnerApiError("PAYMENT_REFERENCE_ALREADY_CLAIMED", "This external payment reference was already used", { httpStatus: 409 });
            }
            throw new PartnerApiError("MEMBER_ALREADY_ACTIVE", "This partner player already has an active membership", { httpStatus: 409 });
          }
          throw error;
        }
        const gameFence = await games.updateOne({ _id: game._id }, { $inc: { partnerApiReservationRevision: 1 } }, { session });
        if (gameFence.modifiedCount !== 1) throw new PartnerApiError("GAME_RESERVATION_FENCE_FAILED", "Game reservation fence was not acknowledged", { httpStatus: 409 });
        const write = await operations.updateOne(
          { _id: input.operationId, state: "RECEIVED" },
          { $set: { state: "SLOT_RESERVED", membershipId, updatedAt: input.now } },
          { session },
        );
        if (write.modifiedCount !== 1) throw new PartnerApiError("OPERATION_STATE_CONFLICT", "Operation reservation lost its state fence", { httpStatus: 409 });
        await this.insertStageAudit(session, operation, "SLOT_RESERVED", input.now, { membershipId });
        result = { membershipId, exerciseId: gameInfo.exerciseId, stationId: gameInfo.stationId };
      });
      return result;
    } finally {
      await session.endSession();
    }
  }

  async completeAdd(input) {
    const session = this.client.startSession();
    let result;
    try {
      await this.transactionExecutor(session, async () => {
        const memberships = this.db.collection(PARTNER_MEMBERSHIP_COLLECTIONS.memberships);
        const operations = this.db.collection(PARTNER_MEMBERSHIP_COLLECTIONS.operations);
        const games = this.db.collection(PARTNER_MEMBERSHIP_COLLECTIONS.games);
        const membership = await memberships.findOne({
          _id: input.membershipId,
          operationId: input.operationId,
          state: "SLOT_RESERVED",
        }, { session });
        if (!membership) throw new PartnerProviderError("LOCAL_ADD_STATE_UNKNOWN", "Reserved membership state is unavailable after Viva confirmation", { ambiguous: true });
        if (membership.gameDocumentId === undefined || membership.gameDocumentId === null) {
          throw new PartnerProviderError("LOCAL_GAME_BINDING_UNKNOWN", "Reserved game document binding is unavailable", { ambiguous: true });
        }
        const game = await games.findOne(
          gameIdentifierFilter(membership.gameId, membership.tenantKey, membership.gameDocumentId),
          { session },
        );
        if (!exactGameIdentity(game, membership.gameId, membership.tenantKey)
          || gameExerciseId(game) !== membership.exerciseId
          || gameStationId(game) !== membership.stationId) {
          throw new PartnerProviderError("LOCAL_GAME_MISSING_AFTER_VIVA", "Game binding changed after Viva confirmation", { ambiguous: true });
        }
        const capacity = gameCapacity(game, membership.authorizedCapacity);
        if (activeParticipants(game).length >= capacity) {
          throw new PartnerProviderError("LOCAL_CAPACITY_LOST_AFTER_VIVA", "Local capacity was lost after Viva confirmation", { ambiguous: true });
        }
        const playerId = `partner:${membership.membershipId}`;
        const participant = {
          id: playerId,
          membershipId: membership.membershipId,
          membershipGeneration: membership.generation,
          name: membership.displayName,
          source: "PARTNER_API",
          status: "CONFIRMED",
          vivaBookingId: input.bookingId,
        };
        const payment = {
          playerId,
          membershipId: membership.membershipId,
          membershipGeneration: membership.generation,
          bookingId: input.bookingId,
          status: "PAID",
          settlementSource: "EXTERNAL_PARTNER",
          externalPaymentReference: membership.payment.reference,
          paidAt: membership.payment.paidAt,
          amountMinor: membership.payment.amountMinor,
          currency: membership.payment.currency,
        };
        const gameWrite = await games.updateOne(
          { _id: game._id, participants: { $not: { $elemMatch: { membershipId: membership.membershipId } } } },
          {
            $push: { participants: participant, payments: payment },
            $inc: { partnerApiReservationRevision: 1 },
            $set: { updatedAt: input.now.toISOString() },
          },
          { session },
        );
        if (gameWrite.modifiedCount !== 1) {
          throw new PartnerProviderError("LOCAL_ADD_CAS_UNKNOWN", "Local membership apply was not acknowledged after Viva confirmation", { ambiguous: true });
        }
        const memberWrite = await memberships.updateOne(
          { _id: membership._id, state: "SLOT_RESERVED" },
          { $set: { state: "ACTIVE", bookingId: input.bookingId, technicalVivaClientId: input.technicalVivaClientId, updatedAt: input.now } },
          { session },
        );
        if (memberWrite.modifiedCount !== 1) {
          throw new PartnerProviderError("LOCAL_MEMBERSHIP_CAS_UNKNOWN", "Membership activation was not acknowledged after Viva confirmation", { ambiguous: true });
        }
        const response = {
          operationId: input.operationId,
          membership: {
            membershipId: membership.membershipId,
            gameId: membership.gameId,
            externalPlayerId: membership.externalPlayerId,
            state: "ACTIVE",
            paymentStatus: "PAID",
            settlementSource: "EXTERNAL_PARTNER",
          },
        };
        const operationWrite = await operations.updateOne(
          { _id: input.operationId, state: "SLOT_RESERVED" },
          { $set: { state: "COMPLETED", response, updatedAt: input.now } },
          { session },
        );
        if (operationWrite.modifiedCount !== 1) {
          throw new PartnerProviderError("LOCAL_OPERATION_CAS_UNKNOWN", "Operation completion was not acknowledged after Viva confirmation", { ambiguous: true });
        }
        await this.insertStageAudit(session, await operations.findOne({ _id: input.operationId }, { session }), "COMPLETED", input.now, { membershipId: membership.membershipId });
        await this.insertOutbox(session, input.operationId, "PARTNER_MEMBER_ADDED", input.now, {
          tenantKey: membership.tenantKey,
          gameId: membership.gameId,
          membershipId: membership.membershipId,
        });
        result = { response };
      });
      return result;
    } finally {
      await session.endSession();
    }
  }

  async prepareRemove(input) {
    const session = this.client.startSession();
    let result;
    try {
      await this.transactionExecutor(session, async () => {
        const memberships = this.db.collection(PARTNER_MEMBERSHIP_COLLECTIONS.memberships);
        const operations = this.db.collection(PARTNER_MEMBERSHIP_COLLECTIONS.operations);
        const membership = await memberships.findOne({
          _id: input.membershipId,
          membershipId: input.membershipId,
          clientId: input.clientId,
          gameId: input.gameId,
          state: "ACTIVE",
        }, { session });
        if (!membership) {
          throw new PartnerApiError("MEMBERSHIP_NOT_OWNED", "Only an active membership created by this integration client can be removed", { httpStatus: 403 });
        }
        if (!membership.stationId
          || !Array.isArray(input.allowedStationIds)
          || !input.allowedStationIds.includes(membership.stationId)) {
          throw new PartnerApiError("STATION_ACCESS_DENIED", "Integration client cannot mutate this station", { httpStatus: 403 });
        }
        if (!membership.bookingId || !membership.exerciseId || !membership.technicalVivaClientId
          || membership.gameDocumentId === undefined || membership.gameDocumentId === null) {
          throw new PartnerApiError("MEMBERSHIP_BINDING_INCOMPLETE", "Owned membership has no exact Viva binding", { httpStatus: 409 });
        }
        canonicalTenantKey(membership.tenantKey);
        const memberWrite = await memberships.updateOne(
          { _id: membership._id, state: "ACTIVE" },
          { $set: { state: "REMOVAL_PENDING", removalOperationId: input.operationId, updatedAt: input.now } },
          { session },
        );
        if (memberWrite.modifiedCount !== 1) throw new PartnerApiError("MEMBERSHIP_STATE_CONFLICT", "Membership changed concurrently", { httpStatus: 409 });
        const operationWrite = await operations.updateOne(
          { _id: input.operationId, state: "RECEIVED" },
          {
            $set: {
              state: "VIVA_PENDING",
              membershipId: membership.membershipId,
              tenantKey: membership.tenantKey,
              updatedAt: input.now,
            },
          },
          { session },
        );
        if (operationWrite.modifiedCount !== 1) throw new PartnerApiError("OPERATION_STATE_CONFLICT", "Removal operation lost its state fence", { httpStatus: 409 });
        await this.insertStageAudit(session, await operations.findOne({ _id: input.operationId }, { session }), "VIVA_PENDING", input.now, { membershipId: membership.membershipId });
        result = membership;
      });
      return result;
    } finally {
      await session.endSession();
    }
  }

  async completeRemove(input) {
    const session = this.client.startSession();
    let result;
    try {
      await this.transactionExecutor(session, async () => {
        const memberships = this.db.collection(PARTNER_MEMBERSHIP_COLLECTIONS.memberships);
        const operations = this.db.collection(PARTNER_MEMBERSHIP_COLLECTIONS.operations);
        const games = this.db.collection(PARTNER_MEMBERSHIP_COLLECTIONS.games);
        const membership = await memberships.findOne({
          _id: input.membershipId,
          removalOperationId: input.operationId,
          state: "REMOVAL_PENDING",
        }, { session });
        if (!membership) throw new PartnerProviderError("LOCAL_REMOVE_STATE_UNKNOWN", "Owned removal state is unavailable after Viva confirmation", { ambiguous: true });
        if (membership.gameDocumentId === undefined || membership.gameDocumentId === null) {
          throw new PartnerProviderError("LOCAL_GAME_BINDING_UNKNOWN", "Owned game document binding is unavailable", { ambiguous: true });
        }
        const game = await games.findOne(
          gameIdentifierFilter(membership.gameId, membership.tenantKey, membership.gameDocumentId),
          { session },
        );
        if (!exactGameIdentity(game, membership.gameId, membership.tenantKey)) {
          throw new PartnerProviderError("LOCAL_GAME_MISSING_AFTER_REMOVE", "Game binding changed after Viva removal", { ambiguous: true });
        }
        const gameWrite = await games.updateOne(
          { _id: game._id },
          {
            $pull: {
              participants: { membershipId: membership.membershipId },
              waitlist: { membershipId: membership.membershipId },
              payments: { membershipId: membership.membershipId },
            },
            $inc: { partnerApiReservationRevision: 1 },
            $set: { updatedAt: input.now.toISOString() },
          },
          { session },
        );
        if (gameWrite.modifiedCount !== 1) {
          throw new PartnerProviderError("LOCAL_REMOVE_GAME_CAS_UNKNOWN", "Game removal projection was not acknowledged after Viva confirmation", { ambiguous: true });
        }
        const memberWrite = await memberships.updateOne(
          { _id: membership._id, state: "REMOVAL_PENDING" },
          {
            $set: { state: "REMOVED", removedAt: input.now, updatedAt: input.now },
            $unset: { activeKey: "" },
          },
          { session },
        );
        if (memberWrite.modifiedCount !== 1) {
          throw new PartnerProviderError("LOCAL_REMOVE_MEMBERSHIP_CAS_UNKNOWN", "Membership removal was not acknowledged after Viva confirmation", { ambiguous: true });
        }
        const response = {
          operationId: input.operationId,
          membership: {
            membershipId: membership.membershipId,
            gameId: membership.gameId,
            externalPlayerId: membership.externalPlayerId,
            state: "REMOVED",
          },
        };
        const operationWrite = await operations.updateOne(
          { _id: input.operationId, state: "VIVA_PENDING" },
          { $set: { state: "COMPLETED", response, updatedAt: input.now } },
          { session },
        );
        if (operationWrite.modifiedCount !== 1) {
          throw new PartnerProviderError("LOCAL_REMOVE_OPERATION_CAS_UNKNOWN", "Removal operation completion was not acknowledged after Viva confirmation", { ambiguous: true });
        }
        await this.insertStageAudit(session, await operations.findOne({ _id: input.operationId }, { session }), "COMPLETED", input.now, { membershipId: membership.membershipId });
        await this.insertOutbox(session, input.operationId, "PARTNER_MEMBER_REMOVED", input.now, {
          tenantKey: membership.tenantKey,
          gameId: membership.gameId,
          membershipId: membership.membershipId,
        });
        result = { response };
      });
      return result;
    } finally {
      await session.endSession();
    }
  }

  async markUnknown(input) {
    return this.updateTerminalState(input, "UNKNOWN", false);
  }

  async failOperation(input) {
    return this.updateTerminalState(input, "FAILED", true);
  }

  async updateTerminalState(input, state, releaseReservation) {
    const session = this.client.startSession();
    let operation;
    try {
      await this.transactionExecutor(session, async () => {
        const operations = this.db.collection(PARTNER_MEMBERSHIP_COLLECTIONS.operations);
        const memberships = this.db.collection(PARTNER_MEMBERSHIP_COLLECTIONS.memberships);
        operation = await operations.findOne({ _id: input.operationId }, { session });
        if (!operation) throw new PartnerApiError("OPERATION_NOT_FOUND", "Operation not found", { httpStatus: 404 });
        if (operation.state === "COMPLETED") return;
        await operations.updateOne(
          { _id: input.operationId, state: { $ne: "COMPLETED" } },
          { $set: { state, publicError: { code: input.code }, updatedAt: input.now } },
          { session },
        );
        const removeReachedProviderBoundary = operation.action === "REMOVE_MEMBER"
          && operation.state === "VIVA_PENDING";
        if (operation.membershipId && (operation.action !== "REMOVE_MEMBER" || removeReachedProviderBoundary)) {
          const removalFailedBeforeProviderMutation = releaseReservation
            && removeReachedProviderBoundary;
          const update = removalFailedBeforeProviderMutation
            ? { $set: { state: "ACTIVE", updatedAt: input.now }, $unset: { removalOperationId: "" } }
            : { $set: { state, updatedAt: input.now } };
          if (releaseReservation && !removalFailedBeforeProviderMutation) update.$unset = { activeKey: "" };
          await memberships.updateOne({ _id: operation.membershipId, state: { $ne: "REMOVED" } }, update, { session });
        }
        operation = await operations.findOne({ _id: input.operationId }, { session });
        await this.insertStageAudit(session, operation, state, input.now, { code: input.code });
      });
      return operation;
    } finally {
      await session.endSession();
    }
  }

  async readOperation(input) {
    return this.db.collection(PARTNER_MEMBERSHIP_COLLECTIONS.operations).findOne({
      _id: input.operationId,
      clientId: input.clientId,
    }, { readPreference: "primary" });
  }

  async insertStageAudit(session, operation, state, at, details) {
    await this.db.collection(PARTNER_MEMBERSHIP_COLLECTIONS.audit).insertOne({
      _id: crypto.randomUUID(),
      schemaVersion: 1,
      type: "PARTNER_API_OPERATION",
      at,
      clientId: operation?.clientId || null,
      keyId: operation?.keyId || null,
      correlationId: operation?.correlationId || null,
      idempotencyKey: operation?.idempotencyKey || null,
      operationId: operation?.operationId || null,
      action: operation?.action || null,
      state,
      details,
    }, { session });
  }

  async insertOutbox(session, operationId, eventType, createdAt, payload) {
    await this.db.collection(PARTNER_MEMBERSHIP_COLLECTIONS.outbox).insertOne({
      _id: crypto.randomUUID(),
      schemaVersion: 1,
      operationId,
      eventType,
      state: "PENDING",
      payload,
      createdAt,
      updatedAt: createdAt,
    }, { session });
  }
}

export function isIsolatedSyntheticRuntime({ environment, mongoUri, databaseName }) {
  const safeEnvironment = toText(environment).toLowerCase();
  const safeDatabaseName = toText(databaseName).toLowerCase();
  let parsed;
  try { parsed = new URL(mongoUri); } catch { return false; }
  const loopback = new Set(["127.0.0.1", "localhost", "::1"]).has(parsed.hostname);
  return ["local", "test", "dev"].includes(safeEnvironment)
    && /(local|test|dev)/.test(safeDatabaseName)
    && loopback;
}

export function operationTouchesOnlyOwnedMembership(operation, membership) {
  return Boolean(
    operation
    && membership
    && operation.clientId === membership.clientId
    && operation.tenantKey === membership.tenantKey
    && operation.gameId === membership.gameId
    && operation.membershipId === membership.membershipId
    && ACTIVE_MEMBER_STATES.has(membership.state),
  );
}
