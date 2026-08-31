import assert from "node:assert/strict";
import crypto from "node:crypto";
import { EventEmitter } from "node:events";
import test from "node:test";

import {
  DisabledVivaProvider,
  PartnerApiError,
  PartnerGameMembershipApiService,
  PartnerProviderError,
  SyntheticVivaProvider,
  buildPartnerSignatureInput,
  canonicalJson,
  signPartnerRequest,
} from "../../node-red/custom-nodes/partner-game-membership-api/partner-game-membership-core.mjs";
import {
  MongoPartnerGameMembershipRepository,
  PARTNER_MEMBERSHIP_COLLECTIONS,
  PARTNER_MEMBERSHIP_INDEX_SPECS,
  isIsolatedSyntheticRuntime,
  operationTouchesOnlyOwnedMembership,
} from "../../node-red/custom-nodes/partner-game-membership-api/partner-game-membership-mongo.mjs";

const NOW = new Date("2026-09-01T09:00:00.000Z");
const SECRET = Buffer.from("partner-secret-for-tests-32-bytes-minimum", "utf8");
const AUDIT_KEY = Buffer.from("audit-secret-for-tests-at-least-32-bytes", "utf8");
const CLIENT_ID = "viva-test-partner";
const KEY_ID = "key-2026-09";
const GAME_ID = "game-open-1";
const STATION_ID = "station-spb-1";
const TECHNICAL_CLIENT_ID = "viva-technical-client-1";

const addBody = (overrides = {}) => ({
  externalPlayerId: "partner-player-001",
  displayName: "Тестовый игрок",
  payment: {
    reference: "partner-payment-001",
    paidAt: "2026-09-01T08:59:00.000Z",
    amountMinor: 250000,
    currency: "RUB",
  },
  ...overrides,
});

class MemoryRepository {
  constructor() {
    this.nonces = new Set();
    this.operations = new Map();
    this.operationByIdempotency = new Map();
    this.memberships = new Map();
    this.audit = [];
    this.games = new Map([[GAME_ID, {
      id: GAME_ID,
      status: "OPEN",
      isPublic: true,
      stationId: STATION_ID,
      exerciseId: "viva-exercise-1",
      maxPlayers: 4,
      participants: [],
      payments: [],
    }]]);
  }

  async consumeNonce(input) {
    const key = `${input.clientId}:${input.keyId}:${input.nonce}`;
    if (this.nonces.has(key)) throw new PartnerApiError("REQUEST_REPLAY_DETECTED", "replay", { httpStatus: 409 });
    this.nonces.add(key);
  }

  async appendAudit(entry) { this.audit.push(structuredClone(entry)); }

  async beginOperation(input) {
    const key = `${input.clientId}:${input.idempotencyKey}`;
    const existingId = this.operationByIdempotency.get(key);
    if (existingId) return { ...this.operations.get(existingId), replayed: true };
    const operation = {
      operationId: input.operationId,
      clientId: input.clientId,
      keyId: input.keyId,
      idempotencyKey: input.idempotencyKey,
      correlationId: input.correlationId,
      requestHash: input.requestHash,
      action: input.action,
      gameId: input.gameId,
      membershipId: input.membershipId,
      state: "RECEIVED",
      createdAt: input.createdAt,
      updatedAt: input.createdAt,
    };
    this.operations.set(operation.operationId, operation);
    this.operationByIdempotency.set(key, operation.operationId);
    return { ...operation, replayed: false };
  }

  async reserveAdd(input) {
    const operation = this.operations.get(input.operationId);
    const game = this.games.get(input.gameId);
    if (!game) throw new PartnerApiError("GAME_NOT_FOUND", "missing", { httpStatus: 404 });
    if (!game.isPublic || game.status !== "OPEN") throw new PartnerApiError("GAME_NOT_OPEN", "closed", { httpStatus: 409 });
    if (!input.allowedStationIds.includes(game.stationId)) throw new PartnerApiError("STATION_ACCESS_DENIED", "denied", { httpStatus: 403 });
    if (game.participants.length >= game.maxPlayers) throw new PartnerApiError("GAME_FULL", "full", { httpStatus: 409 });
    const duplicate = [...this.memberships.values()].find((membership) => (
      membership.clientId === input.clientId
      && membership.gameId === input.gameId
      && membership.externalPlayerId === input.externalPlayerId
      && ["SLOT_RESERVED", "ACTIVE", "REMOVAL_PENDING", "UNKNOWN"].includes(membership.state)
    ));
    if (duplicate) throw new PartnerApiError("MEMBER_ALREADY_ACTIVE", "duplicate", { httpStatus: 409 });
    const duplicatePayment = [...this.memberships.values()].find((membership) => (
      membership.clientId === input.clientId
      && membership.payment.reference === input.payment.reference
    ));
    if (duplicatePayment) throw new PartnerApiError("PAYMENT_REFERENCE_ALREADY_CLAIMED", "payment duplicate", { httpStatus: 409 });
    const membershipId = crypto.randomUUID();
    const membership = {
      membershipId,
      clientId: input.clientId,
      gameId: input.gameId,
      externalPlayerId: input.externalPlayerId,
      displayName: input.displayName,
      payment: input.payment,
      generation: 1,
      exerciseId: game.exerciseId,
      stationId: game.stationId,
      operationId: input.operationId,
      state: "SLOT_RESERVED",
    };
    this.memberships.set(membershipId, membership);
    Object.assign(operation, { state: "SLOT_RESERVED", membershipId, updatedAt: input.now });
    return { membershipId, exerciseId: game.exerciseId, stationId: game.stationId };
  }

  async completeAdd(input) {
    const operation = this.operations.get(input.operationId);
    const membership = this.memberships.get(input.membershipId);
    const game = this.games.get(membership.gameId);
    const playerId = `partner:${membership.membershipId}`;
    game.participants.push({
      id: playerId,
      membershipId: membership.membershipId,
      source: "PARTNER_API",
      name: membership.displayName,
      vivaBookingId: input.bookingId,
    });
    game.payments.push({
      playerId,
      membershipId: membership.membershipId,
      status: "PAID",
      settlementSource: "EXTERNAL_PARTNER",
      ...membership.payment,
    });
    Object.assign(membership, {
      state: "ACTIVE",
      bookingId: input.bookingId,
      technicalVivaClientId: input.technicalVivaClientId,
    });
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
    Object.assign(operation, { state: "COMPLETED", response, updatedAt: input.now });
    return { response };
  }

  async prepareRemove(input) {
    const membership = this.memberships.get(input.membershipId);
    if (!membership
      || membership.clientId !== input.clientId
      || membership.gameId !== input.gameId
      || membership.state !== "ACTIVE") {
      throw new PartnerApiError("MEMBERSHIP_NOT_OWNED", "not owned", { httpStatus: 403 });
    }
    membership.state = "REMOVAL_PENDING";
    membership.removalOperationId = input.operationId;
    const operation = this.operations.get(input.operationId);
    Object.assign(operation, { state: "VIVA_PENDING", membershipId: membership.membershipId });
    return membership;
  }

  async completeRemove(input) {
    const operation = this.operations.get(input.operationId);
    const membership = this.memberships.get(input.membershipId);
    const game = this.games.get(membership.gameId);
    game.participants = game.participants.filter((item) => item.membershipId !== membership.membershipId);
    game.payments = game.payments.filter((item) => item.membershipId !== membership.membershipId);
    membership.state = "REMOVED";
    const response = {
      operationId: input.operationId,
      membership: {
        membershipId: membership.membershipId,
        gameId: membership.gameId,
        externalPlayerId: membership.externalPlayerId,
        state: "REMOVED",
      },
    };
    Object.assign(operation, { state: "COMPLETED", response, updatedAt: input.now });
    return { response };
  }

  async markUnknown(input) {
    const operation = this.operations.get(input.operationId);
    Object.assign(operation, { state: "UNKNOWN", publicError: { code: input.code }, updatedAt: input.now });
    const membership = this.memberships.get(operation.membershipId);
    if (membership) membership.state = "UNKNOWN";
    return operation;
  }

  async failOperation(input) {
    const operation = this.operations.get(input.operationId);
    Object.assign(operation, { state: "FAILED", publicError: { code: input.code }, updatedAt: input.now });
    const membership = this.memberships.get(operation.membershipId);
    if (membership?.state === "REMOVAL_PENDING") membership.state = "ACTIVE";
    else if (membership) membership.state = "FAILED";
    return operation;
  }

  async readOperation(input) {
    const operation = this.operations.get(input.operationId);
    return operation?.clientId === input.clientId ? operation : null;
  }
}

class CountingProvider extends SyntheticVivaProvider {
  constructor() {
    super();
    this.addCalls = 0;
    this.removeCalls = 0;
    this.readCalls = 0;
  }
  async addTechnicalUser(input) { this.addCalls += 1; return super.addTechnicalUser(input); }
  async removeTechnicalUser(input) { this.removeCalls += 1; return super.removeTechnicalUser(input); }
  async readBooking(input) { this.readCalls += 1; return super.readBooking(input); }
}

const buildFixture = (overrides = {}) => {
  const repository = overrides.repository || new MemoryRepository();
  const provider = overrides.provider || new CountingProvider();
  const service = new PartnerGameMembershipApiService({
    repository,
    provider,
    technicalVivaClientId: TECHNICAL_CLIENT_ID,
    auditKey: AUDIT_KEY,
    now: () => new Date(NOW),
    keyResolver: async (clientId, keyId) => ({
      enabled: clientId === (overrides.clientId || CLIENT_ID) && keyId === KEY_ID,
      secret: SECRET,
      scopes: overrides.scopes || ["members:add", "members:remove", "operations:read"],
      stationIds: overrides.stationIds || [STATION_ID],
    }),
  });
  return { repository, provider, service };
};

const signedRequest = ({
  method = "POST",
  path = `/lk/integrations/v1/open-games/${GAME_ID}/members`,
  body = addBody(),
  clientId = CLIENT_ID,
  keyId = KEY_ID,
  timestamp = String(Math.floor(NOW.getTime() / 1000)),
  nonce = crypto.randomBytes(24).toString("base64url"),
  idempotencyKey = crypto.randomUUID(),
  correlationId = crypto.randomUUID(),
  secret = SECRET,
} = {}) => {
  const signature = signPartnerRequest({
    method,
    path,
    body,
    clientId,
    keyId,
    timestamp,
    nonce,
    idempotencyKey,
    correlationId,
  }, secret);
  return {
    method,
    path,
    body,
    remoteAddress: "203.0.113.7",
    headers: {
      "x-padlhub-client-id": clientId,
      "x-padlhub-key-id": keyId,
      "x-padlhub-timestamp": timestamp,
      "x-padlhub-nonce": nonce,
      "x-padlhub-signature": signature,
      "idempotency-key": idempotencyKey,
      "x-correlation-id": correlationId,
    },
  };
};

test("canonical JSON is stable and rejects ambiguous numeric input", () => {
  assert.equal(canonicalJson({ z: 2, a: { y: true, x: [3, "v"] } }), '{"a":{"x":[3,"v"],"y":true},"z":2}');
  assert.throws(() => canonicalJson({ amount: 0.1 }), { code: "INVALID_JSON_NUMBER" });
  assert.throws(() => canonicalJson({ amount: Number.MAX_SAFE_INTEGER + 1 }), { code: "INVALID_JSON_NUMBER" });
});

test("published cross-team signature vector remains stable", () => {
  const input = {
    method: "POST",
    path: "/lk/integrations/v1/open-games/game-001/members",
    body: {
      externalPlayerId: "player-001",
      displayName: "Test Player",
      payment: {
        reference: "pay-001",
        paidAt: "2026-09-01T08:59:00.000Z",
        amountMinor: 250000,
        currency: "RUB",
      },
    },
    clientId: "partner-test",
    keyId: "key-2026-09",
    timestamp: "1788253200",
    nonce: "MDEyMzQ1Njc4OWFiY2RlZjAxMjM0",
    idempotencyKey: "11111111-1111-4111-8111-111111111111",
    correlationId: "22222222-2222-4222-8222-222222222222",
  };
  const testOnlyKey = Buffer.from("public-test-vector-key-32-bytes!!");
  assert.match(buildPartnerSignatureInput(input), /38e85283a47d9c00aab3a4dbda49757cbd3f031c32f524376420e245d9ca6d66/);
  assert.equal(signPartnerRequest(input, testOnlyKey), "v1=4KBpuvfSZVlFUjufjfL3fNYcxENPjQ1bBIE0WnFrE6A");
});

test("successful add creates a partner-owned membership and an external paid projection", async () => {
  const { service, repository, provider } = buildFixture();
  const result = await service.handle(signedRequest());
  assert.equal(result.statusCode, 201);
  assert.equal(result.body.membership.state, "ACTIVE");
  assert.equal(result.body.membership.paymentStatus, "PAID");
  assert.equal(result.body.membership.settlementSource, "EXTERNAL_PARTNER");
  assert.equal(provider.addCalls, 1);
  assert.equal(provider.readCalls, 1);
  const game = repository.games.get(GAME_ID);
  assert.equal(game.participants[0].source, "PARTNER_API");
  assert.equal(game.payments[0].status, "PAID");
  assert.equal(game.payments[0].settlementSource, "EXTERNAL_PARTNER");
});

test("an intercepted signed request cannot be replayed", async () => {
  const { service, provider } = buildFixture();
  const request = signedRequest();
  await service.handle(request);
  await assert.rejects(() => service.handle(structuredClone(request)), { code: "REQUEST_REPLAY_DETECTED", httpStatus: 409 });
  assert.equal(provider.addCalls, 1);
});

test("tampering with method, path, or body invalidates the signature before a provider call", async () => {
  for (const mutate of [
    (request) => { request.method = "DELETE"; },
    (request) => { request.path = `${request.path}/another-member`; },
    (request) => { request.body.payment.amountMinor += 1; },
  ]) {
    const { service, provider } = buildFixture();
    const request = signedRequest();
    mutate(request);
    await assert.rejects(() => service.handle(request), { code: "INVALID_SIGNATURE", httpStatus: 401 });
    assert.equal(provider.addCalls, 0);
    assert.equal(provider.removeCalls, 0);
  }
});

test("duplicate security headers and encoded path confusion are rejected", async () => {
  const duplicateFixture = buildFixture();
  const duplicateRequest = signedRequest();
  duplicateRequest.headers["X-PadlHub-Nonce"] = duplicateRequest.headers["x-padlhub-nonce"];
  await assert.rejects(
    () => duplicateFixture.service.handle(duplicateRequest),
    { code: "AMBIGUOUS_AUTH_HEADER", httpStatus: 400 },
  );
  assert.equal(duplicateFixture.provider.addCalls, 0);

  const pathFixture = buildFixture();
  const encodedPath = "/lk/integrations/v1/open-games/game%2Fother/members";
  await assert.rejects(
    () => pathFixture.service.handle(signedRequest({ path: encodedPath })),
    { code: "INVALID_REQUEST_PATH", httpStatus: 400 },
  );
  assert.equal(pathFixture.provider.addCalls, 0);
});

test("expired proof is rejected before nonce consumption and provider access", async () => {
  const { service, repository, provider } = buildFixture();
  const request = signedRequest({ timestamp: String(Math.floor(NOW.getTime() / 1000) - 91) });
  await assert.rejects(() => service.handle(request), { code: "REQUEST_EXPIRED", httpStatus: 401 });
  assert.equal(repository.nonces.size, 0);
  assert.equal(provider.addCalls, 0);
});

test("a validly signed unknown integration route is durably audited as rejected", async () => {
  const { service, repository } = buildFixture();
  const request = signedRequest({
    method: "POST",
    path: "/lk/integrations/v1/unknown-command",
    body: {},
  });
  await assert.rejects(() => service.handle(request), { code: "ROUTE_NOT_FOUND", httpStatus: 404 });
  assert.equal(repository.audit.at(-1).outcome, "REJECTED");
  assert.equal(repository.audit.at(-1).code, "ROUTE_NOT_FOUND");
});

test("legitimate retry uses a new proof and the same idempotency key without a second Viva add", async () => {
  const { service, provider } = buildFixture();
  const idempotencyKey = crypto.randomUUID();
  const first = await service.handle(signedRequest({ idempotencyKey }));
  const retry = await service.handle(signedRequest({ idempotencyKey }));
  assert.equal(first.statusCode, 201);
  assert.equal(retry.statusCode, 200);
  assert.deepEqual(retry.body, first.body);
  assert.equal(provider.addCalls, 1);
});

test("concurrent requests with one idempotency key have exactly one mutation owner", async () => {
  let releaseProvider;
  const providerGate = new Promise((resolve) => { releaseProvider = resolve; });
  class DelayedProvider extends CountingProvider {
    async addTechnicalUser(input) {
      this.addCalls += 1;
      await providerGate;
      return SyntheticVivaProvider.prototype.addTechnicalUser.call(this, input);
    }
  }
  const provider = new DelayedProvider();
  const { service } = buildFixture({ provider });
  const idempotencyKey = crypto.randomUUID();
  const firstPromise = service.handle(signedRequest({ idempotencyKey }));
  await new Promise((resolve) => setImmediate(resolve));
  const duplicate = await service.handle(signedRequest({ idempotencyKey }));
  assert.equal(duplicate.statusCode, 202);
  assert.equal(provider.addCalls, 1);
  releaseProvider();
  const first = await firstPromise;
  assert.equal(first.statusCode, 201);
  assert.equal(provider.addCalls, 1);
});

test("same idempotency key with a different signed body is rejected", async () => {
  const { service, provider } = buildFixture();
  const idempotencyKey = crypto.randomUUID();
  await service.handle(signedRequest({ idempotencyKey }));
  await assert.rejects(
    () => service.handle(signedRequest({ idempotencyKey, body: addBody({ externalPlayerId: "another-player" }) })),
    { code: "IDEMPOTENCY_CONFLICT", httpStatus: 409 },
  );
  assert.equal(provider.addCalls, 1);
});

test("one external payment reference cannot mark two memberships paid", async () => {
  const { service, provider } = buildFixture();
  await service.handle(signedRequest());
  await assert.rejects(
    () => service.handle(signedRequest({ body: addBody({ externalPlayerId: "partner-player-002" }) })),
    { code: "PAYMENT_REFERENCE_ALREADY_CLAIMED", httpStatus: 409 },
  );
  assert.equal(provider.addCalls, 1);
});

test("scope and station allowlists fail closed", async () => {
  const scoped = buildFixture({ scopes: ["operations:read"] });
  await assert.rejects(() => scoped.service.handle(signedRequest()), { code: "SCOPE_DENIED", httpStatus: 403 });
  assert.equal(scoped.provider.addCalls, 0);

  const station = buildFixture({ stationIds: ["different-station"] });
  await assert.rejects(() => station.service.handle(signedRequest()), { code: "STATION_ACCESS_DENIED", httpStatus: 403 });
  assert.equal(station.provider.addCalls, 0);
});

test("only the exact membership created by the same client can be removed", async () => {
  const fixture = buildFixture();
  const added = await fixture.service.handle(signedRequest());
  const membershipId = added.body.membership.membershipId;
  const remove = signedRequest({
    method: "DELETE",
    path: `/lk/integrations/v1/open-games/${GAME_ID}/members/${membershipId}`,
    body: {},
  });
  const removed = await fixture.service.handle(remove);
  assert.equal(removed.statusCode, 200);
  assert.equal(removed.body.membership.state, "REMOVED");
  assert.equal(fixture.provider.removeCalls, 1);
  assert.equal(fixture.repository.games.get(GAME_ID).participants.length, 0);
});

test("deleting an LK or Viva participant without a canonical partner ownership row never calls Viva", async () => {
  const fixture = buildFixture();
  fixture.repository.games.get(GAME_ID).participants.push({ id: "lk-user-1", source: "LK" });
  const request = signedRequest({
    method: "DELETE",
    path: `/lk/integrations/v1/open-games/${GAME_ID}/members/${crypto.randomUUID()}`,
    body: {},
  });
  await assert.rejects(() => fixture.service.handle(request), { code: "MEMBERSHIP_NOT_OWNED", httpStatus: 403 });
  assert.equal(fixture.provider.removeCalls, 0);
  assert.deepEqual(fixture.repository.games.get(GAME_ID).participants, [{ id: "lk-user-1", source: "LK" }]);
});

test("another integration client cannot delete the first client's membership", async () => {
  const repository = new MemoryRepository();
  const provider = new CountingProvider();
  const owner = buildFixture({ repository, provider });
  const added = await owner.service.handle(signedRequest());
  const attackerClientId = "second-test-partner";
  const attacker = buildFixture({ repository, provider, clientId: attackerClientId });
  const request = signedRequest({
    clientId: attackerClientId,
    method: "DELETE",
    path: `/lk/integrations/v1/open-games/${GAME_ID}/members/${added.body.membership.membershipId}`,
    body: {},
  });
  await assert.rejects(() => attacker.service.handle(request), { code: "MEMBERSHIP_NOT_OWNED", httpStatus: 403 });
  assert.equal(provider.removeCalls, 0);
});

test("ambiguous Viva outcome is fenced as UNKNOWN and is not automatically retried", async () => {
  class AmbiguousProvider extends CountingProvider {
    async addTechnicalUser() {
      this.addCalls += 1;
      throw new PartnerProviderError("VIVA_TIMEOUT", "timeout", { ambiguous: true });
    }
  }
  const provider = new AmbiguousProvider();
  const { service } = buildFixture({ provider });
  const idempotencyKey = crypto.randomUUID();
  const first = await service.handle(signedRequest({ idempotencyKey }));
  const retry = await service.handle(signedRequest({ idempotencyKey }));
  assert.equal(first.statusCode, 202);
  assert.equal(first.body.operation.state, "UNKNOWN");
  assert.equal(retry.statusCode, 202);
  assert.equal(provider.addCalls, 1);
});

test("a dropped provider response after mutation is conservatively fenced as UNKNOWN", async () => {
  class MutateThenDropProvider extends CountingProvider {
    async addTechnicalUser(input) {
      this.addCalls += 1;
      await SyntheticVivaProvider.prototype.addTechnicalUser.call(this, input);
      throw new Error("connection reset after provider commit");
    }
  }
  const provider = new MutateThenDropProvider();
  const { service } = buildFixture({ provider });
  const idempotencyKey = crypto.randomUUID();
  const result = await service.handle(signedRequest({ idempotencyKey }));
  const retry = await service.handle(signedRequest({ idempotencyKey }));
  assert.equal(result.statusCode, 202);
  assert.equal(result.body.operation.state, "UNKNOWN");
  assert.equal(retry.statusCode, 202);
  assert.equal(provider.addCalls, 1);
});

test("any local commit error after exact Viva read-back remains UNKNOWN", async () => {
  class CommitFailingRepository extends MemoryRepository {
    async completeAdd() { throw new Error("Mongo commit result unavailable"); }
  }
  const repository = new CommitFailingRepository();
  const provider = new CountingProvider();
  const { service } = buildFixture({ repository, provider });
  const result = await service.handle(signedRequest());
  assert.equal(result.statusCode, 202);
  assert.equal(result.body.operation.state, "UNKNOWN");
  assert.equal(provider.addCalls, 1);
  assert.equal(provider.readCalls, 1);
});

test("durable audit never contains raw nonce, IP, display name, or whole body", async () => {
  const { service, repository } = buildFixture();
  const request = signedRequest();
  await service.handle(request);
  const serialized = JSON.stringify(repository.audit);
  assert.doesNotMatch(serialized, new RegExp(request.headers["x-padlhub-nonce"]));
  assert.doesNotMatch(serialized, /203\.0\.113\.7/);
  assert.doesNotMatch(serialized, /Тестовый игрок/);
  assert.doesNotMatch(serialized, /partner-payment-001/);
  assert.match(serialized, /nonceHash/);
  assert.match(serialized, /remoteAddressHash/);
});

test("closed request schema rejects caller-controlled source, paid flag, and Viva identifiers", async () => {
  for (const injectedField of ["source", "paid", "vivaBookingId", "technicalVivaClientId", "clientId"]) {
    const { service, provider } = buildFixture();
    const body = { ...addBody(), [injectedField]: "attacker-value" };
    await assert.rejects(() => service.handle(signedRequest({ body })), { code: "UNKNOWN_REQUEST_FIELD" });
    assert.equal(provider.addCalls, 0);
  }
});

test("real provider is fail-closed in the test release", async () => {
  const { service } = buildFixture({ provider: new DisabledVivaProvider() });
  await assert.rejects(() => service.handle(signedRequest()), { code: "VIVA_RUNTIME_NOT_CONFIGURED", httpStatus: 503 });
});

test("Node-RED custom node registers and remains disabled before any Mongo connection", async () => {
  const registered = new Map();
  const configNodes = new Map();
  const RED = {
    nodes: {
      createNode(node) {
        const events = new EventEmitter();
        node.on = events.on.bind(events);
        node.emit = events.emit.bind(events);
        node.send = () => {};
        node.warn = () => {};
      },
      registerType(name, constructor) { registered.set(name, constructor); },
      getNode(id) { return configNodes.get(id); },
    },
  };
  const register = (await import("../../node-red/custom-nodes/partner-game-membership-api/partner-game-membership-node.cjs")).default;
  register(RED);
  const Store = registered.get("padlhub-partner-game-membership-store");
  assert.equal(typeof Store, "function");
  assert.equal(typeof registered.get("padlhub-partner-game-membership-http"), "function");
  const store = new Store({ enabledEnv: "LK_PARTNER_TEST_UNSET_ENABLED" });
  await assert.rejects(() => store.getRuntime(), { code: "PARTNER_API_DISABLED", httpStatus: 503 });
});

test("synthetic runtime is restricted to loopback test-like databases", () => {
  assert.equal(isIsolatedSyntheticRuntime({
    environment: "test",
    mongoUri: "mongodb://127.0.0.1:27017/?directConnection=true",
    databaseName: "lk_partner_test",
  }), true);
  assert.equal(isIsolatedSyntheticRuntime({
    environment: "test",
    mongoUri: "mongodb://mongo.internal:27017",
    databaseName: "lk_partner_test",
  }), false);
  assert.equal(isIsolatedSyntheticRuntime({
    environment: "production",
    mongoUri: "mongodb://127.0.0.1:27017",
    databaseName: "lk_partner_test",
  }), false);
  assert.equal(isIsolatedSyntheticRuntime({
    environment: "test",
    mongoUri: "mongodb://127.0.0.1:27017",
    databaseName: "production",
  }), false);
});

test("Mongo prerequisites include unique idempotency, active ownership, nonce TTL, and outbox fences", () => {
  assert.deepEqual(PARTNER_MEMBERSHIP_INDEX_SPECS.operations[0], {
    key: { clientId: 1, idempotencyKey: 1 },
    name: "uniq_partner_client_idempotency",
    unique: true,
  });
  assert.equal(PARTNER_MEMBERSHIP_INDEX_SPECS.memberships[0].unique, true);
  assert.equal(PARTNER_MEMBERSHIP_INDEX_SPECS.memberships[0].sparse, true);
  assert.equal(PARTNER_MEMBERSHIP_INDEX_SPECS.memberships[1].name, "uniq_partner_payment_reference");
  assert.equal(PARTNER_MEMBERSHIP_INDEX_SPECS.memberships[1].unique, true);
  assert.equal(PARTNER_MEMBERSHIP_INDEX_SPECS.nonces[0].expireAfterSeconds, 0);
  assert.equal(PARTNER_MEMBERSHIP_INDEX_SPECS.outbox[0].unique, true);
});

test("Mongo prerequisite verifier rejects partial, collated, hidden, and otherwise weakened indexes", async () => {
  for (const weakening of [
    { partialFilterExpression: { clientId: { $exists: true } } },
    { collation: { locale: "en", strength: 2 } },
    { hidden: true },
    { sparse: true },
  ]) {
    const db = {
      collection(collectionName) {
        return {
          async indexes() {
            return Object.entries(PARTNER_MEMBERSHIP_INDEX_SPECS).flatMap(([logicalName, specs]) => {
              if (PARTNER_MEMBERSHIP_COLLECTIONS[logicalName] !== collectionName) return [];
              return specs.map((spec, index) => ({
                name: spec.name,
                key: spec.key,
                ...(spec.unique ? { unique: true } : {}),
                ...(spec.sparse ? { sparse: true } : {}),
                ...(spec.expireAfterSeconds !== undefined ? { expireAfterSeconds: spec.expireAfterSeconds } : {}),
                ...(logicalName === "operations" && index === 0 ? weakening : {}),
              }));
            });
          },
        };
      },
    };
    const repository = new MongoPartnerGameMembershipRepository({ client: {}, db });
    await assert.rejects(() => repository.verifyRequiredIndexes(), { code: "MONGO_PREREQUISITES_MISSING" });
  }
});

test("ownership helper requires an exact client, game, membership, and active state", () => {
  const operation = { clientId: "c1", gameId: "g1", membershipId: "m1" };
  const membership = { clientId: "c1", gameId: "g1", membershipId: "m1", state: "ACTIVE" };
  assert.equal(operationTouchesOnlyOwnedMembership(operation, membership), true);
  assert.equal(operationTouchesOnlyOwnedMembership(operation, { ...membership, clientId: "c2" }), false);
  assert.equal(operationTouchesOnlyOwnedMembership(operation, { ...membership, state: "REMOVED" }), false);
});
