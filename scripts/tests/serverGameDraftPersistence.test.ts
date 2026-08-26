import test from "node:test";
import assert from "node:assert/strict";
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
        assert.deepEqual(options, { retries: 2, keepalive: true });
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
