import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { isDeepStrictEqual } from "node:util";

import {
  buildFutureVisibilityCandidate,
  FUTURE_VISIBILITY_CONTRACT,
  FUTURE_VISIBILITY_NODE_IDS,
  patchPaymentRouter,
} from "../patch_live_game_future_visibility.mjs";
import { buildExactGraphContract } from "../nodered_reviewed_flow_deploy/runtime_contract.mjs";

const sha256 = (value) => crypto.createHash("sha256").update(value).digest("hex");
const nodeSource = (name) => fs.readFileSync(path.resolve("scripts/nodered_games_nodes", name), "utf8");
const runNode = (name, msg, tenant = null) => new Function(
  "msg",
  "env",
  nodeSource(name),
)(structuredClone(msg), { get: (key) => key === "PADLHUB_PLATFORM_TENANT_KEY" ? tenant : null });

test("frontend game record writes forward the current bearer", () => {
  const source = fs.readFileSync(path.resolve("src/utils/apiClient.ts"), "utf8");
  const start = source.indexOf("async function writePadelGameRecord(");
  const end = source.indexOf("async function hydratePadelGameRecordAfterWrite(", start);
  assert.ok(start >= 0 && end > start);
  assert.match(source.slice(start, end), /method: candidate\.method,\s*auth: true,/);
});

const persistentId = "lk_game_v1:6:iSkq6G:dedupe:8:slot:one";
const update = {
  $set: {
    id: "game-1",
    tenantKey: "iSkq6G",
    dedupeKey: "slot:one",
    createdByFlow: true,
    status: "PAID",
    updatedAt: "2026-09-06T18:30:00.000Z",
  },
  $setOnInsert: { _id: persistentId, createdAt: "2026-09-06T18:30:00.000Z" },
  $inc: { revision: 1 },
};
const writeContext = (overrides = {}) => {
  const result = {
    step: "identity_lookup",
    tenantKey: "iSkq6G",
    gameId: "game-1",
    mode: "create",
    dedupeKey: "slot:one",
    paymentRef: null,
    expectedRevision: null,
    httpStatus: 200,
    update,
    ...overrides,
  };
  const identityKind = "dedupe";
  const identityValue = result.dedupeKey;
  result.persistentId = overrides.persistentId || `lk_game_v1:${result.tenantKey.length}:${result.tenantKey}:${identityKind}:${identityValue.length}:${identityValue}`;
  return result;
};

test("future identity resolver inserts only an unused deterministic identity", () => {
  const resolved = runNode("fn_future_game_identity_resolve.js", {
    payload: [],
    _futureGameWrite: writeContext(),
  });
  assert.equal(resolved[1], null);
  assert.equal(resolved[0]._futureGameWrite.upsert, true);
  assert.equal(resolved[0]._futureGameWrite.expectedNextRevision, 1);
  assert.deepEqual(resolved[0].query, {
    _id: persistentId,
    tenantKey: "iSkq6G",
    id: "game-1",
    revision: { $exists: false },
    dedupeKey: "slot:one",
  });
});

test("different client game IDs for one durable slot share one deterministic Mongo _id", () => {
  const first = writeContext({ gameId: "client-game-a" });
  const second = writeContext({ gameId: "client-game-b" });
  assert.equal(first.persistentId, second.persistentId);
  const firstWrite = runNode("fn_future_game_identity_resolve.js", { payload: [], _futureGameWrite: first })[0];
  const secondWrite = runNode("fn_future_game_identity_resolve.js", { payload: [], _futureGameWrite: second })[0];
  assert.equal(firstWrite.query._id, secondWrite.query._id);
  assert.equal(firstWrite._futureGameWrite.upsert, true);
  assert.equal(secondWrite._futureGameWrite.upsert, true);
});

test("ordinary create cannot replace an existing future-write record", () => {
  const existing = {
    _id: persistentId,
    tenantKey: "iSkq6G",
    id: "game-1",
    dedupeKey: "slot:one",
    createdByFlow: true,
    revision: 4,
  };
  const resolved = runNode("fn_future_game_identity_resolve.js", {
    payload: [existing],
    _futureGameWrite: writeContext({ expectedRevision: 4 }),
  });
  assert.equal(resolved[0], null);
  assert.equal(resolved[1].statusCode, 409);
  assert.equal(resolved[1].payload.code, "GAME_WRITE_ALREADY_EXISTS");
});

test("different payment references for the same slot keep one deterministic Mongo identity", () => {
  const first = writeContext({ paymentRef: "payment-a" });
  const second = writeContext({ paymentRef: "payment-b" });
  assert.equal(first.persistentId, second.persistentId);
});

test("provider-verified confirm updates only the exact tenant, id, revision and deterministic _id", () => {
  const existing = {
    _id: persistentId,
    tenantKey: "iSkq6G",
    id: "game-1",
    dedupeKey: "slot:one",
    createdByFlow: true,
    revision: 4,
    status: "PAYMENT_PENDING",
  };
  const resolved = runNode("fn_future_game_identity_resolve.js", {
    payload: [existing],
    _futureGameWrite: writeContext({ mode: "confirm", expectedRevision: 4 }),
  });
  assert.equal(resolved[0]._futureGameWrite.upsert, false);
  assert.equal(resolved[0]._futureGameWrite.expectedNextRevision, 5);
  assert.equal(resolved[0].query.revision, 4);
  assert.equal(resolved[0].query.status, "PAYMENT_PENDING");

  const stale = runNode("fn_future_game_identity_resolve.js", {
    payload: [existing],
    _futureGameWrite: writeContext({ mode: "confirm", expectedRevision: 3 }),
  });
  assert.equal(stale[1].statusCode, 409);
  assert.equal(stale[1].payload.code, "GAME_WRITE_VERSION_CONFLICT");
});

test("legacy and colliding identities stop before a Mongo write", () => {
  const legacy = runNode("fn_future_game_identity_resolve.js", {
    payload: [{ id: "game-1", dedupeKey: "slot:one", createdByFlow: true }],
    _futureGameWrite: writeContext(),
  });
  assert.equal(legacy[0], null);
  assert.equal(legacy[1].payload.code, "GAME_WRITE_LEGACY_IDENTITY");

  const collision = runNode("fn_future_game_identity_resolve.js", {
    payload: [{}, {}],
    _futureGameWrite: writeContext(),
  });
  assert.equal(collision[0], null);
  assert.equal(collision[1].payload.code, "GAME_WRITE_IDENTITY_COLLISION");

  const readFailure = runNode("fn_future_game_identity_resolve.js", {
    payload: [],
    error: { message: "read failed" },
    _futureGameWrite: writeContext(),
  });
  assert.equal(readFailure[0], null);
  assert.equal(readFailure[1].statusCode, 503);
  assert.equal(readFailure[1].payload.code, "GAME_WRITE_IDENTITY_READ_FAILED");
});

test("Mongo adapter binds upsert mode and majority acknowledgement", () => {
  const resolved = runNode("fn_future_game_identity_resolve.js", {
    payload: [],
    _futureGameWrite: writeContext(),
  })[0];
  const args = runNode("fn_future_game_upsert_args.js", resolved);
  assert.deepEqual(args.payload[2], {
    upsert: true,
    writeConcern: { w: "majority", j: true },
    maxTimeMS: 5000,
  });
});

test("ordinary create response and autojoin wait for exact durable readback", () => {
  const ctx = {
    ...writeContext(),
    step: "write_ack",
    upsert: true,
    sourceRevision: null,
    expectedNextRevision: 1,
    expectedUpdatedAt: "2026-09-06T18:30:00.000Z",
  };
  const read = runNode("fn_future_game_write_ack.js", {
    payload: { acknowledged: true, matchedCount: 0, upsertedCount: 1, upsertedId: persistentId },
    _futureGameWrite: ctx,
  });
  assert.equal(read[1], null);
  assert.deepEqual(read[0].payload, {
    _id: persistentId,
    tenantKey: "iSkq6G",
    id: "game-1",
    revision: 1,
    updatedAt: "2026-09-06T18:30:00.000Z",
    createdByFlow: true,
  });

  const record = {
    _id: persistentId,
    tenantKey: "iSkq6G",
    id: "game-1",
    dedupeKey: "slot:one",
    createdByFlow: true,
    revision: 1,
    updatedAt: "2026-09-06T18:30:00.000Z",
    status: "PAID",
  };
  const released = runNode("fn_future_game_write_ack.js", {
    ...read[0],
    payload: [record],
  });
  assert.equal(released[1].statusCode, 200);
  assert.equal(released[1].payload.revision, 1);
  assert.equal(released[3].payload._id, persistentId);
  assert.equal(released[0], null);
});

test("CAS miss and readback mismatch cannot emit success while ambiguous writes reconcile", () => {
  const base = {
    ...writeContext(),
    step: "write_ack",
    upsert: false,
    sourceRevision: 3,
    expectedNextRevision: 4,
    expectedUpdatedAt: "2026-09-06T18:30:00.000Z",
  };
  const casMiss = runNode("fn_future_game_write_ack.js", {
    payload: { acknowledged: true, matchedCount: 0, upsertedCount: 0 },
    _futureGameWrite: base,
  });
  assert.equal(casMiss[1].statusCode, 409);
  assert.equal(casMiss[3], null);

  const error = runNode("fn_future_game_write_ack.js", {
    payload: {},
    error: { message: "write failed" },
    _futureGameWrite: base,
  });
  assert.equal(error[1], null);
  assert.equal(error[0]._futureGameWrite.ambiguousAck, true);
  assert.equal(error[0]._futureGameWrite.step, "readback");

  const absent = runNode("fn_future_game_write_ack.js", {
    ...error[0],
    payload: [],
  });
  assert.equal(absent[1].statusCode, 503);
  assert.equal(absent[1].payload.code, "GAME_WRITE_READBACK_FAILED");

  const mismatch = runNode("fn_future_game_write_ack.js", {
    payload: [{
      _id: persistentId,
      tenantKey: "iSkq6G",
      id: "game-1",
      dedupeKey: "slot:one",
      createdByFlow: true,
      revision: 5,
      updatedAt: base.expectedUpdatedAt,
    }],
    _futureGameWrite: { ...base, step: "readback" },
  });
  assert.equal(mismatch[1].payload.code, "GAME_WRITE_READBACK_MISMATCH");
  assert.equal(mismatch[3], null);
});

test("confirm write is delegated to the existing Viva-confirmation ACK", () => {
  const delegated = runNode("fn_future_game_write_ack.js", {
    payload: { acknowledged: true, matchedCount: 1 },
    _futureGameWrite: {
      ...writeContext({ mode: "confirm" }),
      step: "write_ack",
      upsert: false,
      expectedNextRevision: 2,
    },
  });
  assert.equal(delegated[0], null);
  assert.equal(delegated[4].payload.matchedCount, 1);
});

const confirmAckContext = (overrides = {}) => ({
  step: "write_ack",
  persistentId,
  gameId: "game-1",
  tenantKey: "iSkq6G",
  expectedRevision: 4,
  expectedNextRevision: 5,
  expectedUpdatedAt: "2026-09-06T18:31:00.000Z",
  paymentRef: "payment-1",
  transactionId: "transaction-1",
  bookingId: "booking-1",
  exerciseId: "exercise-1",
  ...overrides,
});
const confirmedRecord = (overrides = {}) => ({
  _id: persistentId,
  id: "game-1",
  tenantKey: "iSkq6G",
  dedupeKey: "slot:one",
  createdByFlow: true,
  revision: 5,
  updatedAt: "2026-09-06T18:31:00.000Z",
  status: "PAID",
  booking: { bookingIds: ["booking-1"], exerciseId: "exercise-1" },
  metadata: { paymentRef: "payment-1", bookingIds: ["booking-1"], exerciseId: "exercise-1" },
  payment: { paid: true, paymentRef: "payment-1", transactionId: "transaction-1", bookingIds: ["booking-1"] },
  ...overrides,
});

test("ambiguous payment confirmation ACK succeeds only after exact paid-state readback", () => {
  const read = runNode("fn_future_game_confirm_write_ack.js", {
    payload: {},
    error: { message: "write timeout" },
    _requestMode: "confirm",
    _gameConfirmWriteAck: confirmAckContext(),
  });
  assert.equal(read[1], null);
  assert.equal(read[0]._gameConfirmWriteAck.ambiguousAck, true);
  assert.deepEqual(read[0].payload, {
    _id: persistentId,
    tenantKey: "iSkq6G",
    id: "game-1",
    revision: 5,
    updatedAt: "2026-09-06T18:31:00.000Z",
    createdByFlow: true,
  });

  const success = runNode("fn_future_game_confirm_write_ack.js", {
    ...read[0],
    payload: [confirmedRecord()],
  });
  assert.equal(success[1].statusCode, 200);

  const absent = runNode("fn_future_game_confirm_write_ack.js", {
    ...read[0],
    payload: [],
  });
  assert.equal(absent[1].payload.code, "GAME_PAYMENT_WRITE_READBACK_FAILED");

  const mismatch = runNode("fn_future_game_confirm_write_ack.js", {
    ...read[0],
    payload: [confirmedRecord({ payment: { paid: true, paymentRef: "payment-1", transactionId: "other" } })],
  });
  assert.equal(mismatch[1].payload.code, "GAME_PAYMENT_CAS_MISS");
});

test("exact payment confirmation retry reads back the already committed revision", () => {
  const ack = confirmAckContext();
  const resolved = runNode("fn_future_game_identity_resolve.js", {
    payload: [confirmedRecord()],
    _futureGameWrite: writeContext({
      mode: "confirm",
      paymentRef: "payment-1",
      expectedRevision: 4,
    }),
    _gameConfirmWriteAck: ack,
  });
  assert.equal(resolved[0], null);
  assert.equal(resolved[1], null);
  assert.equal(resolved[3]._gameConfirmWriteAck.step, "readback");
  assert.equal(resolved[3]._gameConfirmWriteAck.expectedNextRevision, 5);
  const success = runNode("fn_future_game_confirm_write_ack.js", {
    ...resolved[3],
    payload: [confirmedRecord()],
  });
  assert.equal(success[1].statusCode, 200);
});

test("payment lookup is tenant-bound and detects conflicting runtime configuration", () => {
  const lookup = runNode("fn_future_game_payment_confirm_lookup.js", {
    payload: { paymentRef: "payment-1" },
  });
  assert.equal(lookup[0].payload.tenantKey, "iSkq6G");
  assert.equal(lookup[0]._gamePaymentConfirmCtx.tenantKey, "iSkq6G");

  const mismatch = runNode("fn_future_game_payment_confirm_lookup.js", {
    payload: { paymentRef: "payment-1" },
  }, "other-tenant");
  assert.equal(mismatch[1].statusCode, 503);
  assert.equal(mismatch[1].payload.code, "GAME_TENANT_CONFIG_MISMATCH");
});

test("payment claim write requires majority durability and explicit acknowledgement", () => {
  const source = patchPaymentRouter(nodeSource("fn_game_payment_confirm_router.js"));
  assert.match(source, /upsert: true, writeConcern: \{ w: "majority", j: true \}, maxTimeMS: 5000/);
  const runRouter = (msg) => new Function("msg", "env", "global", source)(
    structuredClone(msg),
    { get: () => null },
    { get: () => null, set: () => {} },
  );

  const failed = runRouter({
    payload: { acknowledged: false },
    _gamePaymentConfirmCtx: { step: "claim_write", paymentRef: "payment-1", claimId: "claim-1" },
  });
  assert.equal(failed[2].statusCode, 503);
  assert.equal(failed[2].payload.code, "GAME_PAYMENT_CLAIM_WRITE_FAILED");

  const readback = runRouter({
    payload: { acknowledged: true },
    _gamePaymentConfirmCtx: { step: "claim_write", paymentRef: "payment-1", claimId: "claim-1" },
  });
  assert.equal(readback[5]._gamePaymentConfirmCtx.step, "claim_read");
  assert.deepEqual(readback[5].payload, { _id: "claim-1" });
});

const authPayload = (overrides = {}) => ({
  organizer: { id: "client-1", phone: "79990000001" },
  booking: {
    studioId: "studio-1",
    roomId: "room-1",
    date: "2026-09-10",
    timeFrom: "18:00",
    timeTo: "19:30",
    vivaExerciseId: "exercise-1",
    bookingIds: ["booking-actor", "booking-participant"],
  },
  payment: { amount: 0, paid: true },
  metadata: { bookingId: "booking-actor" },
  ...overrides,
});
const providerBooking = (overrides = {}) => ({
  id: "booking-actor",
  exercise: { id: "exercise-1" },
  studio: { id: "studio-1" },
  room: { id: "room-1" },
  timeFrom: "2026-09-10T18:00:00+03:00",
  timeTo: "2026-09-10T19:30:00+03:00",
  cost: 0,
  ...overrides,
});
const prepareAuth = (payload = authPayload(), pathName = "/lk/games") => runNode(
  "fn_future_game_auth_prepare.js",
  {
    req: { path: pathName, query: {}, headers: { authorization: "Bearer test-token" } },
    payload,
  },
)[0];
const resolveProfile = (prepared) => runNode("fn_future_game_auth_resolve.js", {
  ...prepared,
  statusCode: 200,
  payload: { id: "client-1", phone: "79990000001" },
})[0];
const resolveBookings = (prepared, rows, pagination = {}) => runNode(
  "fn_future_game_auth_resolve.js",
  {
    ...prepared,
    statusCode: 200,
    payload: { content: rows, number: prepared._futureGameAuth.bookingsPage, totalPages: 1, last: true, ...pagination },
  },
);

test("future create authorization requires a bearer and binds only the organizer booking", () => {
  const missing = runNode("fn_future_game_auth_prepare.js", {
    req: { path: "/lk/games", query: {}, headers: {} },
    payload: authPayload(),
  });
  assert.equal(missing[1].statusCode, 401);
  assert.equal(missing[1].payload.code, "GAME_AUTH_TOKEN_REQUIRED");

  const prepared = prepareAuth();
  assert.equal(prepared._futureGameAuth.actorBookingId, "booking-actor");
  assert.deepEqual(prepared._futureGameAuth.associatedBookingIds, ["booking-actor", "booking-participant"]);
  const bookingsRequest = resolveProfile(prepared);
  assert.match(bookingsRequest.url, /bookings\?page=0&size=200$/);
  const resolved = resolveBookings(bookingsRequest, [providerBooking()]);
  assert.equal(resolved[1]._futureGameAuth.verified, true);
  assert.equal(resolved[1]._futureGameAuth.providerEvidence.actorBookingId, "booking-actor");
  assert.deepEqual(resolved[1]._futureGameAuth.providerEvidence.bookingIds, ["booking-actor"]);
  assert.equal(resolved[1]._futureGameAuth.providerEvidence.settlementKind, "ZERO_DUE");
  assert.equal(resolved[1]._futureGameAuth.providerEvidence.providerCost, 0);
  assert.equal(resolved[1]._futureGameAuth.providerEvidence.providerCostMinor, 0);
  assert.equal(resolved[1]._futureGameAuth.providerEvidence.providerCurrency, "RUB");
});

test("future create authorization paginates to a complete provider result", () => {
  const first = resolveBookings(resolveProfile(prepareAuth()), [], {
    totalPages: 2,
    last: false,
  });
  assert.match(first[0].url, /bookings\?page=1&size=200$/);
  const second = resolveBookings(first[0], [providerBooking()], {
    totalPages: 2,
    last: true,
  });
  assert.equal(second[1]._futureGameAuth.verified, true);

  const unpaged = runNode("fn_future_game_auth_resolve.js", {
    ...resolveProfile(prepareAuth()),
    statusCode: 200,
    payload: [providerBooking()],
  });
  assert.equal(unpaged[2].payload.code, "GAME_AUTH_BOOKINGS_UNAVAILABLE");
});

test("future create authorization rejects slot drift and organizer mismatch", () => {
  const mismatch = resolveBookings(resolveProfile(prepareAuth()), [
    providerBooking({ room: { id: "room-other" } }),
  ]);
  assert.equal(mismatch[2].payload.code, "GAME_AUTH_BOOKING_SLOT_MISMATCH");

  const profileMismatch = runNode("fn_future_game_auth_resolve.js", {
    ...prepareAuth(),
    statusCode: 200,
    payload: { id: "client-other", phone: "79990000001" },
  });
  assert.equal(profileMismatch[2].payload.code, "GAME_AUTH_ORGANIZER_MISMATCH");
});

test("future create settlement is fail-closed for missing and negative payment evidence", () => {
  for (const cost of [null, "", undefined, -1, 1500.5]) {
    const row = providerBooking({ cost });
    const resolved = resolveBookings(resolveProfile(prepareAuth()), [row]);
    assert.equal(resolved[2].payload.code, "GAME_AUTH_BOOKING_NOT_SETTLED");
  }
  for (const status of ["FAILED", "REFUNDED", "UNPAID"]) {
    const row = providerBooking({
      paymentType: "SUBSCRIPTION",
      transactionStatus: { transactionStatus: status },
    });
    const resolved = resolveBookings(resolveProfile(prepareAuth()), [row]);
    assert.equal(resolved[2].payload.code, "GAME_AUTH_BOOKING_NOT_SETTLED");
  }
  for (const paymentType of ["SUBSCRIPTION_PENDING", "NOT_SUBSCRIPTION", "ABONEMENT"]) {
    const resolved = resolveBookings(resolveProfile(prepareAuth(authPayload({
      payment: { amount: 1500, paid: true },
    }))), [providerBooking({ cost: 150000, paymentType })]);
    assert.equal(resolved[2].payload.code, "GAME_AUTH_BOOKING_NOT_SETTLED");
  }
});

test("subscription and already-paid card creates require exact provider price evidence", () => {
  const subscriptionPayload = authPayload({
    payment: { amount: 1500, paid: true },
    metadata: { bookingId: "booking-actor" },
  });
  const subscription = resolveBookings(resolveProfile(prepareAuth(subscriptionPayload)), [
    providerBooking({ cost: 150000, paymentType: "SUBSCRIPTION" }),
  ]);
  assert.equal(subscription[1]._futureGameAuth.providerEvidence.settlementKind, "SUBSCRIPTION");
  assert.equal(subscription[1]._futureGameAuth.providerEvidence.providerCost, 1500);
  assert.equal(subscription[1]._futureGameAuth.providerEvidence.providerCostMinor, 150000);

  const paidSubscriptionPayload = authPayload({
    payment: { amount: 1500, paid: true, paymentRef: "subscription-payment-1" },
    metadata: { bookingId: "booking-actor", paymentRef: "subscription-payment-1" },
  });
  const paidSubscription = resolveBookings(resolveProfile(prepareAuth(paidSubscriptionPayload)), [
    providerBooking({
      cost: 150000,
      paymentType: "SUBSCRIPTION",
      transactionStatus: { transactionStatus: "PAID" },
    }),
  ]);
  assert.equal(paidSubscription[1]._futureGameAuth.providerEvidence.settlementKind, "SUBSCRIPTION");

  const cardPayload = authPayload({
    payment: { amount: 1500, paid: true },
    metadata: { bookingId: "booking-actor" },
  });
  const card = resolveBookings(resolveProfile(prepareAuth(cardPayload)), [providerBooking({
    cost: 150000,
    transactionStatus: { transactionStatus: "PAID" },
  })]);
  assert.equal(card[1]._futureGameAuth.providerEvidence.settlementKind, "ONE_TIME_PAID");

  const referencedCardPayload = authPayload({
    payment: { amount: 1500, paid: true, paymentRef: "payment-1" },
    metadata: { bookingId: "booking-actor", paymentRef: "payment-1" },
  });
  const referencedCard = resolveBookings(resolveProfile(prepareAuth(referencedCardPayload)), [providerBooking({
    cost: 150000,
    transactionStatus: { transactionStatus: "PAID" },
  })]);
  assert.equal(referencedCard[2].payload.code, "GAME_AUTH_TRANSACTION_CONFIRM_REQUIRED");

  const nestedReferencedCardPayload = authPayload({
    payment: { amount: 1500, paid: true },
    metadata: {
      bookingId: "booking-actor",
      splitPayment: { payments: [{ paymentRef: "nested-payment-1" }] },
    },
  });
  const nestedReferencedCard = resolveBookings(
    resolveProfile(prepareAuth(nestedReferencedCardPayload)),
    [providerBooking({ cost: 150000, transactionStatus: { transactionStatus: "PAID" } })],
  );
  assert.equal(nestedReferencedCard[2].payload.code, "GAME_AUTH_TRANSACTION_CONFIRM_REQUIRED");

  const clientPaidWithoutProviderPaid = resolveBookings(resolveProfile(prepareAuth(cardPayload)), [
    providerBooking({ cost: 150000, transactionStatus: { transactionStatus: "PENDING" } }),
  ]);
  assert.equal(clientPaidWithoutProviderPaid[2].payload.code, "GAME_AUTH_BOOKING_NOT_SETTLED");

  const priceMismatch = resolveBookings(resolveProfile(prepareAuth(cardPayload)), [providerBooking({
    cost: 149900,
    transactionStatus: { transactionStatus: "PAID" },
  })]);
  assert.equal(priceMismatch[2].payload.code, "GAME_AUTH_BOOKING_PAYMENT_MISMATCH");

  const currencyMismatch = resolveBookings(resolveProfile(prepareAuth(cardPayload)), [providerBooking({
    cost: 150000,
    currency: "USD",
    transactionStatus: { transactionStatus: "PAID" },
  })]);
  assert.equal(currencyMismatch[2].payload.code, "GAME_AUTH_BOOKING_PAYMENT_MISMATCH");

  const fractionalRequest = resolveBookings(resolveProfile(prepareAuth(authPayload({
    payment: { amount: 1499.5, paid: true },
  }))), [providerBooking({ cost: 149950, paymentType: "SUBSCRIPTION" })]);
  assert.equal(fractionalRequest[2].payload.code, "GAME_AUTH_BOOKING_NOT_SETTLED");

  const draft = resolveBookings(resolveProfile(prepareAuth(cardPayload, "/lk/games/drafts")), [
    providerBooking({ cost: 150000, transactionStatus: { transactionStatus: "PENDING" } }),
  ]);
  assert.equal(draft[1]._futureGameAuth.mode, "draft");
  assert.equal(draft[1]._futureGameAuth.providerEvidence.settled, false);
});

const liveFixture = process.env.FUTURE_GAME_LIVE_FLOW_FIXTURE;
test("fresh production preimage builds exact candidate and forward-safe recovery", {
  skip: liveFixture ? false : "Set FUTURE_GAME_LIVE_FLOW_FIXTURE to the fresh private production snapshot",
}, () => {
  const sourceBytes = fs.readFileSync(path.resolve(liveFixture));
  const source = JSON.parse(sourceBytes.toString("utf8"));
  const result = buildFutureVisibilityCandidate(source, sha256(sourceBytes), {
    notBefore: "2026-09-06T00:00:00.000Z",
  });
  assert.equal(result.candidate.length, FUTURE_VISIBILITY_CONTRACT.sourceNodeCount + 18);
  assert.equal(result.foundation.length, FUTURE_VISIBILITY_CONTRACT.sourceNodeCount + 10);
  assert.equal(result.recovery.length, FUTURE_VISIBILITY_CONTRACT.sourceNodeCount + 18);
  assert.equal(result.report.httpRouteCount, FUTURE_VISIBILITY_CONTRACT.httpRouteCount);
  assert.deepEqual(result.report.candidateBrokenReferences, { brokenWires: 0, brokenLinks: 0 });
  assert.deepEqual(result.report.recoveryBrokenReferences, { brokenWires: 0, brokenLinks: 0 });

  const candidateById = new Map(result.candidate.map((node) => [node.id, node]));
  assert.deepEqual(candidateById.get(FUTURE_VISIBILITY_CONTRACT.createNodeId).wires[0], [FUTURE_VISIBILITY_NODE_IDS.identityFind]);
  assert.deepEqual(candidateById.get(FUTURE_VISIBILITY_CONTRACT.mongoWriteNodeId).wires, [[FUTURE_VISIBILITY_NODE_IDS.writeAck]]);
  assert.match(candidateById.get(FUTURE_VISIBILITY_CONTRACT.createNodeId).func, /const PLATFORM_TENANT_KEY = "iSkq6G"/);
  assert.match(candidateById.get(FUTURE_VISIBILITY_CONTRACT.createNodeId).func, /FUTURE_GAME_WRITES_NOT_BEFORE/);
  assert.match(candidateById.get(FUTURE_VISIBILITY_CONTRACT.createNodeId).func, /GAME_FUTURE_WRITE_NOT_ACTIVE/);
  assert.match(candidateById.get(FUTURE_VISIBILITY_CONTRACT.createNodeId).func, /lk_game_v1:/);
  assert.match(candidateById.get(FUTURE_VISIBILITY_CONTRACT.createNodeId).func, /\$inc: \{ revision: 1 \}/);
  assert.match(candidateById.get("lk_game_payment_confirm_lookup_20260826").func, /tenantKey: PLATFORM_TENANT_KEY/);

  const runCandidateFunction = (id, msg, tenant = null) => new Function(
    "msg",
    "env",
    candidateById.get(id).func,
  )(structuredClone(msg), { get: (key) => key === "PADLHUB_PLATFORM_TENANT_KEY" ? tenant : null });
  const prepared = runCandidateFunction(FUTURE_VISIBILITY_CONTRACT.createNodeId, {
    req: { path: "/lk/games", query: {} },
    payload: {
      id: "future-game-1",
      status: "CANCELLED",
      archived: true,
      organizer: { id: "organizer-1", name: "Organizer" },
      booking: {
        studioId: "studio-1",
        roomId: "room-1",
        date: "2026-09-10",
        timeFrom: "18:00",
        timeTo: "19:30",
        vivaExerciseId: "exercise-1",
        bookingIds: ["booking-actor", "booking-participant"],
      },
      payment: { amount: 0, paid: false },
      settings: {},
      invite: {},
    },
    _futureGameAuth: {
      verified: true,
      mode: "create",
      tenantKey: "iSkq6G",
      actorClientId: "organizer-1",
      providerEvidence: {
        source: "viva_end_user_bookings",
        exerciseId: "exercise-1",
        actorBookingId: "booking-actor",
        bookingIds: ["booking-actor"],
        studioId: "studio-1",
        roomId: "room-1",
        date: "2026-09-10",
        timeFrom: "18:00",
        timeTo: "19:30",
        settled: true,
        settlementKind: "ZERO_DUE",
        providerCost: 0,
        providerCostMinor: 0,
        providerCurrency: "RUB",
      },
    },
  });
  assert.ok(prepared[0]);
  assert.equal(prepared[1], null);
  assert.equal(prepared[3], null);
  assert.equal(prepared[0]._futureGameWrite.tenantKey, "iSkq6G");
  assert.equal(
    prepared[0]._futureGameWrite.persistentId,
    "lk_game_v1:6:iSkq6G:dedupe:15:viva:exercise-1",
  );
  assert.equal(prepared[0]._futureGameWrite.update.$set.tenantKey, "iSkq6G");
  assert.equal(prepared[0]._futureGameWrite.update.$set.status, "PAID");
  assert.equal(prepared[0]._futureGameWrite.update.$set.archived, false);
  assert.equal(prepared[0]._futureGameWrite.update.$set.payment.paid, true);
  assert.equal(prepared[0]._futureGameWrite.update.$inc.revision, 1);

  const callerTenantMismatch = runCandidateFunction(FUTURE_VISIBILITY_CONTRACT.createNodeId, {
    req: { path: "/lk/games", query: {} },
    payload: { id: "future-game-2", tenantKey: "caller-tenant", booking: {}, payment: {}, settings: {}, invite: {} },
  });
  assert.equal(callerTenantMismatch[1].statusCode, 403);
  assert.equal(callerTenantMismatch[1].payload.code, "GAME_TENANT_MISMATCH");

  const runtimeTenantMismatch = runCandidateFunction(FUTURE_VISIBILITY_CONTRACT.createNodeId, {
    req: { path: "/lk/games", query: {} },
    payload: { id: "future-game-3", booking: {}, payment: {}, settings: {}, invite: {} },
  }, "unexpected-tenant");
  assert.equal(runtimeTenantMismatch[1].statusCode, 503);
  assert.equal(runtimeTenantMismatch[1].payload.code, "GAME_TENANT_CONFIG_MISMATCH");

  const recoveryById = new Map(result.recovery.map((node) => [node.id, node]));
  assert.match(recoveryById.get(FUTURE_VISIBILITY_CONTRACT.createNodeId).func, /GAME_PAYMENT_CONFIRMATION_DISABLED/);
  assert.equal(recoveryById.has("lk_game_payment_confirm_lookup_20260826"), true);
  assert.deepEqual(recoveryById.get("715662c56fc5eac6").wires, [[FUTURE_VISIBILITY_CONTRACT.createNodeId]]);
  assert.deepEqual(recoveryById.get(FUTURE_VISIBILITY_NODE_IDS.writeAck).wires[4], []);
  for (const url of ["/lk/games", "/lk/games/records", "/lk/games/drafts", "/lk/games/draft"]) {
    const route = result.foundation.find((node) => node.type === "http in" && node.method === "post" && node.url === url);
    assert.deepEqual(route.wires, [[FUTURE_VISIBILITY_NODE_IDS.authPrepare]]);
  }
  const gamesGet = result.foundation.find((node) => node.type === "http in" && node.method === "get" && node.url === "/lk/games");
  const sourceGamesGet = source.find((node) => node.id === gamesGet.id);
  assert.deepEqual(gamesGet, sourceGamesGet);

  const futureFenceBuild = buildFutureVisibilityCandidate(source, sha256(sourceBytes), {
    notBefore: "2099-09-06T00:00:00.000Z",
  });
  const fencedCreate = new Function(
    "msg",
    "env",
    futureFenceBuild.foundation.find((node) => node.id === FUTURE_VISIBILITY_CONTRACT.createNodeId).func,
  );
  const fenced = fencedCreate({
    req: { path: "/lk/games", query: {} },
    payload: { id: "fenced-game", booking: {}, payment: {}, settings: {}, invite: {} },
  }, { get: () => null });
  assert.equal(fenced[0], null);
  assert.equal(fenced[1].statusCode, 503);
  assert.equal(fenced[1].payload.code, "GAME_FUTURE_WRITE_NOT_ACTIVE");

  const exactGraphInputs = (before, after) => {
    const beforeById = new Map(before.map((node) => [node.id, node]));
    const afterById = new Map(after.map((node) => [node.id, node]));
    const allowedChanges = [];
    const allowedAdditionIds = [];
    for (const node of after) {
      const previous = beforeById.get(node.id);
      if (!previous) {
        allowedAdditionIds.push(node.id);
        continue;
      }
      const fields = [...new Set([...Object.keys(previous), ...Object.keys(node)])]
        .filter((field) => !isDeepStrictEqual(previous[field], node[field]));
      if (fields.length) allowedChanges.push({ id: node.id, fields });
    }
    assert.equal([...beforeById.keys()].every((id) => afterById.has(id)), true);
    return { allowedChanges, allowedAdditionIds };
  };
  const flowBytes = (flow) => Buffer.from(`${JSON.stringify(flow, null, 2)}\n`);
  for (const [deploymentId, before, after] of [
    ["future-games-foundation-test", source, result.foundation],
    ["future-games-payment-test", result.foundation, result.candidate],
    ["future-games-recovery-test", result.candidate, result.recovery],
  ]) {
    const allowances = exactGraphInputs(before, after);
    assert.doesNotThrow(() => buildExactGraphContract({
      liveBytes: flowBytes(before),
      candidateBytes: flowBytes(after),
      deploymentId,
      ...allowances,
      ...(deploymentId === "future-games-foundation-test" ? {
        activationBoundary: {
          nodeId: FUTURE_VISIBILITY_CONTRACT.createNodeId,
          notBefore: "2026-09-06T00:00:00.000Z",
        },
      } : {}),
    }));
  }

  for (const id of [
    FUTURE_VISIBILITY_CONTRACT.createNodeId,
    FUTURE_VISIBILITY_CONTRACT.upsertArgsNodeId,
    FUTURE_VISIBILITY_NODE_IDS.authPrepare,
    FUTURE_VISIBILITY_NODE_IDS.authResolve,
    FUTURE_VISIBILITY_NODE_IDS.identityResolve,
    FUTURE_VISIBILITY_NODE_IDS.writeAck,
    "lk_game_payment_confirm_lookup_20260826",
    "lk_game_payment_confirm_router_20260826",
    "lk_game_payment_confirm_write_ack_20260826",
  ]) {
    assert.doesNotThrow(() => new Function("msg", "env", "global", candidateById.get(id).func), `${id} syntax`);
  }
});
