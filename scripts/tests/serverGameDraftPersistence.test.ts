import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import ts from "typescript";
import {
  isExactServerGameDraftReadback,
  persistServerGameDraftWithReadback,
  type ServerGameDraftApiResult,
} from "../../src/utils/serverGameDraftPersistencePolicy.ts";

const paymentRef = "pay-durable-1";
const bookingId = "booking-durable-1";

const payload = {
  paymentRef,
  status: "PAYMENT_PENDING" as const,
  organizer: { id: "client-1", name: "Организатор", phone: "79990000000" },
  booking: {
    studioId: "studio-1",
    studioName: "Студия",
    masterServiceId: "service-1",
    subServiceIds: [],
    roomId: "room-1",
    roomName: "Корт",
    date: "2026-08-30",
    timeFrom: "11:30",
    timeTo: "13:00",
    timeFromIso: "2026-08-30T11:30:00+03:00",
    timeToIso: "2026-08-30T13:00:00+03:00",
    durationMinutes: 90,
    slotId: null,
    bookingIds: [bookingId],
  },
  payment: {
    amount: 1800,
    paymentUrl: "https://pay.example/1",
    paymentMethod: "WIDGET" as const,
    paid: false,
    paymentRef,
    bookingIds: [bookingId],
  },
  metadata: {
    paymentRef,
    bookingIds: [bookingId],
  },
};

const record = {
  id: "game-durable-1",
  inviteUrl: null,
  status: "PAYMENT_PENDING",
  metadata: {
    paymentRef,
    bookingIds: [bookingId],
  },
  booking: {
    studioName: "Студия",
    roomName: "Корт",
    date: "2026-08-30",
    timeFrom: "11:30",
    timeTo: "13:00",
    durationMinutes: 90,
    bookingIds: [bookingId],
  },
};

const ok = (data: typeof record | null): ServerGameDraftApiResult => ({
  data,
  error: null,
  status: 200,
});

test("exact readback requires the same paymentRef and every expected booking", () => {
  assert.equal(isExactServerGameDraftReadback(record, paymentRef, [bookingId]), true);
  assert.equal(isExactServerGameDraftReadback(record, "pay-other", [bookingId]), false);
  assert.equal(isExactServerGameDraftReadback(record, paymentRef, [bookingId, "missing"]), false);
});

test("draft persistence waits for an exact durable readback before success", async () => {
  const lookups: string[][] = [];
  const waits: number[] = [];
  let lookupAttempt = 0;
  const result = await persistServerGameDraftWithReadback(
    paymentRef,
    payload,
    [bookingId],
    {
      createDraft: async (_payload, options) => {
        assert.deepEqual(options, { retries: 0, keepalive: true });
        return ok(record);
      },
      lookupDraft: async (_paymentRef, bookingIds) => {
        lookups.push(bookingIds);
        lookupAttempt += 1;
        return lookupAttempt < 3 ? ok(null) : ok(record);
      },
      wait: async (delayMs) => { waits.push(delayMs); },
      readbackDelaysMs: [0, 25, 50],
    },
  );

  assert.equal(result.record?.id, record.id);
  assert.equal(result.error, null);
  assert.deepEqual(lookups, [[bookingId], [bookingId], [bookingId]]);
  assert.deepEqual(waits, [25, 50]);
});

test("draft persistence still reads back after a lost write response, then fails closed", async () => {
  let lookupCalls = 0;
  const result = await persistServerGameDraftWithReadback(
    paymentRef,
    payload,
    [bookingId],
    {
      createDraft: async () => ({
        data: null,
        error: { message: "write failed" },
        status: 503,
      }),
      lookupDraft: async () => {
        lookupCalls += 1;
        return ok(null);
      },
      wait: async () => {},
      readbackDelaysMs: [0, 1],
    },
  );

  assert.equal(result.record, null);
  assert.equal(result.error, "write failed");
  assert.equal(lookupCalls, 2);
});

test("exact readback recovers a persisted draft after a lost write response", async () => {
  const result = await persistServerGameDraftWithReadback(
    paymentRef,
    payload,
    [bookingId],
    {
      createDraft: async () => ({
        data: null,
        error: { message: "response lost" },
        status: null,
      }),
      lookupDraft: async () => ok(record),
      readbackDelaysMs: [0],
    },
  );

  assert.equal(result.record?.id, record.id);
  assert.equal(result.error, null);
});

test("draft persistence fails closed when readback never matches", async () => {
  const result = await persistServerGameDraftWithReadback(
    paymentRef,
    payload,
    [bookingId],
    {
      createDraft: async () => ok(record),
      lookupDraft: async () => ok({
        ...record,
        metadata: { paymentRef: "pay-other", bookingIds: [bookingId] },
      }),
      wait: async () => {},
      readbackDelaysMs: [0, 1],
    },
  );

  assert.equal(result.record, null);
  assert.match(result.error ?? "", /не подтвердил сохранение/i);
});

const surchargeBinding = {
  exerciseId: "synthetic-exercise",
  transactionId: "synthetic-transaction",
  operationId: "lk-split-create-synthetic",
  clientId: payload.organizer.id,
  amountMinor: 180000,
  canWrite: () => true,
};
const paidSurcharge = {
  ...record,
  status: "PAID",
  organizer: { ...payload.organizer, photo: null, rating: null },
  booking: { ...record.booking, exerciseId: surchargeBinding.exerciseId },
  payment: { amount: 1800, paymentUrl: null, paid: true },
  metadata: { ...record.metadata, splitPayment: {
    createOperationId: surchargeBinding.operationId,
    payments: [{ role: "ORGANIZER", status: "PAID", paymentRef, bookingId, amountMinor: surchargeBinding.amountMinor,
      clientId: surchargeBinding.clientId, transactionId: surchargeBinding.transactionId }],
  } },
};
const absent = { data: null, status: 200, error: null, missing: true } as const;

test("surcharge recovery reuses an exact paid card before attempting any draft write", async () => {
  const result = await persistServerGameDraftWithReadback(paymentRef, payload, [bookingId], {
    createDraft: async () => assert.fail("would overwrite existing paid card"),
    lookupDraft: async () => ok(paidSurcharge),
  }, surchargeBinding);
  assert.equal(result.record, paidSurcharge);
});

test("surcharge recovery writes one draft after proved absence and resumes via durable readback", async () => {
  let reads = 0;
  let writes = 0;
  const result = await persistServerGameDraftWithReadback(paymentRef, payload, [bookingId], {
    createDraft: async () => { writes++; return { data: null, error: { message: "response lost" }, status: null }; },
    lookupDraft: async () => ++reads === 1 ? absent : ok(paidSurcharge),
    readbackDelaysMs: [0],
  }, surchargeBinding);
  assert.equal(result.record, paidSurcharge);
  assert.equal(writes, 1);
  assert.equal(reads, 2);
});

test("surcharge recovery never writes on mismatch, unknown absence or stale wizard owner", async () => {
  for (const existing of [
    ok({ ...paidSurcharge, booking: { ...paidSurcharge.booking, exerciseId: "other" } }),
    ok({ ...paidSurcharge, metadata: { ...paidSurcharge.metadata, paymentRef: "another-payment-ref",
      splitPayment: { ...paidSurcharge.metadata.splitPayment,
        payments: paidSurcharge.metadata.splitPayment.payments.map(payment => ({ ...payment, paymentRef: "another-payment-ref" })) },
    } }),
    ok({ ...paidSurcharge, payment: { ...paidSurcharge.payment, amount: 2100 } }),
    ok(null),
    { data: null, status: 409, error: { message: "collision" } },
    absent,
  ]) {
    const result = await persistServerGameDraftWithReadback(paymentRef, payload, [bookingId], {
      createDraft: async () => assert.fail("unsafe draft write"),
      lookupDraft: async () => existing,
    }, { ...surchargeBinding, canWrite: () => existing !== absent });
    assert.equal(result.record, null);
  }
});

test("the surcharge lookup requires a complete union and reports separate alias collisions", async () => {
  const source = fs.readFileSync("src/utils/serverGameDraftPersistence.ts", "utf8");
  const ast = ts.createSourceFile("serverGameDraftPersistence.ts", source, ts.ScriptTarget.ES2022, true);
  const fn = ast.statements.find(node => ts.isFunctionDeclaration(node) && node.name?.text === "lookupGameByBothReferences");
  assert.ok(fn);
  const js = ts.transpileModule(fn.getText(ast), { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText;
  const alias = { ...paidSurcharge, id: "other-alias" };
  for (const data of [
    { games: [], complete: false, total: 0 },
    { games: [], complete: true, total: 1 },
    { games: [paidSurcharge, alias], complete: true, total: 2 },
    { games: [alias], complete: true, total: 1 },
    { games: [], complete: true, total: 0 },
  ]) {
    const lookup = new Function("apiFetchPadelGamesByBookingReferences", js + "\nreturn lookupGameByBothReferences;")(
      async (ref: string, ids: string[]) => {
        assert.equal(ref, paymentRef);
        assert.deepEqual(ids, [bookingId]);
        return { data, status: 200, error: null };
      },
    );
    const result = await lookup(paymentRef, [bookingId]);
    assert.equal(result.missing === true, data.complete && data.total === 0);
    assert.equal(result.data, data.games.length === 1 ? alias : null);
  }
});
