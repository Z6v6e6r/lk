import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";

function runFunction(
  file: string,
  msg: Record<string, any>,
  values = new Map<string, unknown>(),
) {
  const source = fs.readFileSync(file, "utf8");
  const globalContext = {
    get(name: string) { return values.get(name); },
    set(name: string, value: unknown) { values.set(name, value); },
  };
  const env = {
    get(name: string) {
      if (name === "VIVA_SERVICE_USERNAME") return "service@example.test";
      if (name === "VIVA_SERVICE_PASSWORD") return "test-password";
      return undefined;
    },
  };
  return new Function("msg", "global", "env", source)(msg, globalContext, env) as Array<Record<string, any> | null>;
}

const lookupFile = "scripts/nodered_games_nodes/fn_game_payment_confirm_lookup.js";
const routerFile = "scripts/nodered_games_nodes/fn_game_payment_confirm_router.js";
const createFile = "scripts/nodered_games_nodes/fn_create.js";
const upsertArgsFile = "scripts/nodered_games_nodes/fn_game_upsert_args.js";
const writeAckFile = "scripts/nodered_games_nodes/fn_game_confirm_write_ack.js";

const draft = {
  id: "pay-payment-ref-1",
  revision: 3,
  updatedAt: "2026-08-26T12:00:00.000Z",
  status: "PAYMENT_PENDING",
  organizer: { id: "client-1", name: "Organizer", phone: "79990000000" },
  booking: {
    studioId: "studio-1",
    studioName: "Studio",
    roomId: "room-1",
    roomName: "Court",
    date: "2026-08-30",
    timeFrom: "11:30",
    timeTo: "13:00",
    durationMinutes: 90,
    bookingIds: ["booking-1"],
    exerciseId: "exercise-1",
    vivaExerciseId: "exercise-1",
  },
  payment: {
    paymentRef: "payment-ref-1",
    bookingIds: ["booking-1"],
    amount: 375,
    paid: false,
  },
  settings: { payMode: "split", isPrivate: false },
  invite: { maxPlayers: 4, waitlistEnabled: true },
  participants: [{ id: "client-1", name: "Organizer" }],
  waitlist: [],
  metadata: {
    paymentRef: "payment-ref-1",
    bookingIds: ["booking-1"],
    source: "games_split_widget",
    splitPayment: {
      enabled: true,
      paymentRef: "payment-ref-1",
      exerciseId: "exercise-1",
      payments: [{
        role: "ORGANIZER",
        status: "PAYMENT_PENDING",
        paymentRef: "payment-ref-1",
        transactionId: "transaction-1",
        bookingId: "booking-1",
        clientId: "client-1",
        amount: 375,
        amountMinor: 37500,
      }],
    },
  },
};

function transaction(status: string, overrides: Record<string, unknown> = {}) {
  return {
    id: "transaction-1",
    status,
    toPay: 37500,
    currency: "RUB",
    client: { id: "client-1" },
    exercise: { id: "exercise-1" },
    products: [{ bookingIds: ["booking-1"] }],
    ...overrides,
  };
}

test("confirm lookup accepts only paymentRef and requests a collision-aware server read", () => {
  const invalid = runFunction(lookupFile, { payload: {} });
  assert.equal(invalid[1]?.statusCode, 400);

  const out = runFunction(lookupFile, {
    payload: {
      paymentRef: "payment-ref-1",
      status: "PAID",
      payment: { paid: true },
    },
  });
  assert.equal(out[0]?.limit, 2);
  assert.deepEqual(out[0]?.payload?.$or?.[0], { "metadata.paymentRef": "payment-ref-1" });
  assert.equal(out[0]?._gamePaymentConfirmCtx?.paymentRef, "payment-ref-1");
});

test("only exact terminal-paid Viva evidence produces an internal verified upsert", () => {
  const values = new Map<string, unknown>([
    ["vivacrm_access_token", "cached-token"],
    ["vivacrm_token_expires_at", Date.now() + 300_000],
  ]);
  const initial = runFunction(routerFile, {
    payload: [draft],
    _gamePaymentConfirmCtx: { step: "draft_lookup", paymentRef: "payment-ref-1" },
  }, values);
  assert.equal(initial[0]?.method, "GET");
  assert.match(initial[0]?.url || "", /\/transactions\/transaction-1$/);

  const paid = runFunction(routerFile, {
    ...initial[0],
    statusCode: 200,
    payload: transaction("PAID"),
  }, values);
  assert.equal(paid[4]?._gamePaymentConfirmCtx?.step, "claim_write");
  assert.deepEqual(paid[4]?.payload?.[2], { upsert: true });
  const claimRead = runFunction(routerFile, {
    ...paid[4],
    payload: { acknowledged: true },
  }, values);
  assert.equal(claimRead[5]?._gamePaymentConfirmCtx?.step, "claim_read");
  const claimChecked = runFunction(routerFile, {
    ...claimRead[5],
    payload: [{
      _id: "viva_transaction:transaction-1",
      transactionId: "transaction-1",
      bookingId: "booking-1",
      exerciseId: "exercise-1",
      clientId: "client-1",
      gameId: draft.id,
      paymentRef: "payment-ref-1",
    }],
  }, values);
  const verified = claimChecked[1];
  assert.equal(verified?._gamePaymentVerified?.source, "viva_transaction_readback");
  assert.equal(verified?.payload?.status, "PAID");
  assert.equal(verified?.payload?.payment?.paid, true);
  assert.equal(verified?.payload?.metadata?.splitPayment?.payments?.[0]?.status, "PAID");

  const create = runFunction(createFile, {
    ...verified,
    req: { path: "/lk/games/payment/confirm", query: {} },
  });
  assert.ok(create[0]);
  assert.equal(create[1], null);
  assert.deepEqual(create[0]?.query?.$and?.slice(-2), [
    { status: "PAYMENT_PENDING" },
    { revision: 3 },
  ]);
  assert.equal(create[3], null);
  const upsertArgs = new Function(
    "msg",
    fs.readFileSync(upsertArgsFile, "utf8"),
  )(structuredClone(create[0]));
  assert.deepEqual(upsertArgs.payload[2], { upsert: false });

  const readback = runFunction(writeAckFile, {
    ...upsertArgs,
    payload: { acknowledged: true, matchedCount: 1 },
  });
  assert.deepEqual(readback[0]?.payload, { id: draft.id });
  const acknowledged = runFunction(writeAckFile, {
    ...readback[0],
    payload: [create[0]?._recordForResponse],
  });
  assert.equal(acknowledged[1]?.statusCode, 200);
  assert.equal(acknowledged[1]?.payload?.status, "PAID");
  assert.equal(acknowledged[1]?.payload?.payment?.paid, true);
});

test("Mongo acknowledgement and exact durable readback gate the confirm response", () => {
  const context = {
    step: "write_ack",
    gameId: draft.id,
    paymentRef: "payment-ref-1",
    transactionId: "transaction-1",
    bookingId: "booking-1",
    exerciseId: "exercise-1",
  };
  const invalidAck = runFunction(writeAckFile, {
    _gameConfirmWriteAck: structuredClone(context),
    payload: { acknowledged: false, matchedCount: 0 },
  });
  assert.equal(invalidAck[1]?.statusCode, 503);
  assert.equal(invalidAck[1]?.payload?.code, "GAME_PAYMENT_WRITE_ACK_INVALID");

  const casRead = runFunction(writeAckFile, {
    _gameConfirmWriteAck: structuredClone(context),
    payload: { acknowledged: true, matchedCount: 0 },
  });
  assert.equal(casRead[0], null);
  assert.equal(casRead[1]?.statusCode, 409);
  assert.equal(casRead[1]?.payload?.code, "GAME_PAYMENT_CAS_MISS");
});

test("shared Mongo output drops ordinary create and draft acknowledgements", () => {
  for (const mode of ["create", "draft"]) {
    const out = runFunction(writeAckFile, {
      _requestMode: mode,
      payload: { acknowledged: true, matchedCount: 1 },
    });
    assert.deepEqual(out, [null, null, null]);
  }
  const brokenConfirm = runFunction(writeAckFile, {
    _requestMode: "confirm",
    payload: { acknowledged: true, matchedCount: 1 },
  });
  assert.equal(brokenConfirm[1]?.statusCode, 500);
  assert.equal(brokenConfirm[1]?.payload?.code, "GAME_PAYMENT_WRITE_ACK_CONTEXT_MISSING");
});

test("missing provider client or currency cannot produce a payment claim", () => {
  const values = new Map<string, unknown>([
    ["vivacrm_access_token", "cached-token"],
    ["vivacrm_token_expires_at", Date.now() + 300_000],
  ]);
  const initial = runFunction(routerFile, {
    payload: [draft],
    _gamePaymentConfirmCtx: { step: "draft_lookup", paymentRef: "payment-ref-1" },
  }, values)[0] as Record<string, any>;
  for (const payload of [
    transaction("PAID", { client: undefined }),
    transaction("PAID", { currency: undefined }),
  ]) {
    const out = runFunction(routerFile, { ...initial, statusCode: 200, payload }, values);
    assert.equal(out[4], null);
    assert.equal(out[2]?.payload?.code, "GAME_PAYMENT_EVIDENCE_MISMATCH");
  }
});

test("waiting, failed and mismatched transactions cannot publish the game", () => {
  const values = new Map<string, unknown>([
    ["vivacrm_access_token", "cached-token"],
    ["vivacrm_token_expires_at", Date.now() + 300_000],
  ]);
  const initial = runFunction(routerFile, {
    payload: [draft],
    _gamePaymentConfirmCtx: { step: "draft_lookup", paymentRef: "payment-ref-1" },
  }, values)[0] as Record<string, any>;

  for (const [payload, code] of [
    [transaction("WAITING"), "GAME_PAYMENT_PENDING"],
    [transaction("UNPAID"), "GAME_PAYMENT_TERMINAL_FAILED"],
    [transaction("PAID", { products: [{ bookingIds: ["booking-other"] }] }), "GAME_PAYMENT_EVIDENCE_MISMATCH"],
  ] as const) {
    const out = runFunction(routerFile, { ...initial, statusCode: 200, payload }, values);
    assert.equal(out[1], null);
    assert.equal(out[2]?.payload?.code, code);
  }
});

test("duplicate durable drafts fail closed before any Viva request", () => {
  const out = runFunction(routerFile, {
    payload: [draft, { ...draft, id: "duplicate" }],
    _gamePaymentConfirmCtx: { step: "draft_lookup", paymentRef: "payment-ref-1" },
  });
  assert.equal(out[0], null);
  assert.equal(out[2]?.payload?.code, "GAME_PAYMENT_DRAFT_COLLISION");
});

test("cancelled durable draft wins over a stale paid marker", () => {
  const out = runFunction(routerFile, {
    payload: [{ ...draft, status: "CANCELLED", payment: { paid: true } }],
    _gamePaymentConfirmCtx: { step: "draft_lookup", paymentRef: "payment-ref-1" },
  });
  assert.equal(out[0], null);
  assert.equal(out[2]?.payload?.code, "GAME_PAYMENT_TERMINAL_FAILED");
});

test("provider evidence already bound to another game is rejected", () => {
  const out = runFunction(routerFile, {
    payload: [{
      _id: "viva_transaction:transaction-1",
      transactionId: "transaction-1",
      bookingId: "booking-1",
      gameId: "another-game",
      paymentRef: "payment-ref-other",
    }],
    _gamePaymentConfirmCtx: {
      step: "claim_read",
      claimId: "viva_transaction:transaction-1",
      paymentRef: "payment-ref-1",
      transactionId: "transaction-1",
      bookingId: "booking-1",
      exerciseId: "exercise-1",
      record: draft,
    },
  });
  assert.equal(out[1], null);
  assert.equal(out[2]?.payload?.code, "GAME_PAYMENT_EVIDENCE_REPLAY");
});
