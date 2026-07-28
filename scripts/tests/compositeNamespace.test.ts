import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";

function runNodeRedFunction(file: string, msg: Record<string, unknown>) {
  const source = fs.readFileSync(file, "utf8");
  return new Function("msg", source)(msg);
}

function asRecord(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  return value as Record<string, unknown>;
}

function buildSlot(overrides: Record<string, unknown> = {}) {
  return {
    id: "slot-1",
    stationId: "station-1",
    studioId: "studio-1",
    roomId: "room-a",
    roomName: "Court A",
    date: "2026-06-20",
    timeFrom: "18:00",
    timeTo: "19:00",
    ...overrides,
  };
}

test("composite options builds single and two-segment candidates from raw slots", () => {
  const out = runNodeRedFunction("scripts/nodered_games_nodes/fn_composite_options.js", {
    payload: {
      slots: [
        buildSlot({ id: "slot-1", roomId: "room-a", timeFrom: "18:00", timeTo: "19:00" }),
        buildSlot({ id: "slot-2", roomId: "room-b", roomName: "Court B", timeFrom: "19:00", timeTo: "20:00" }),
      ],
    },
  }) as unknown[];

  const response = asRecord(out[0]);
  assert.ok(response);
  assert.equal(response.statusCode, 200);

  const payload = asRecord(response.payload);
  assert.ok(payload);
  assert.equal(payload.mode, "slots");

  const candidates = Array.isArray(payload.candidates) ? payload.candidates : [];
  assert.equal(candidates.length, 3);

  const twoSegment = candidates.find((candidate) => asRecord(candidate)?.compositeBooking && asRecord(candidate)?.compositeBooking?.segmentCount === 2) as Record<string, unknown> | undefined;
  assert.ok(twoSegment);
  assert.equal(asRecord(twoSegment.compositeBooking)?.transitionCount, 1);
});

test("composite options rejects more than two segments", () => {
  const out = runNodeRedFunction("scripts/nodered_games_nodes/fn_composite_options.js", {
    payload: {
      segments: [
        buildSlot({ id: "slot-1", timeFrom: "18:00", timeTo: "19:00" }),
        buildSlot({ id: "slot-2", roomId: "room-b", timeFrom: "19:00", timeTo: "20:00" }),
        buildSlot({ id: "slot-3", roomId: "room-c", timeFrom: "20:00", timeTo: "21:00" }),
      ],
    },
  }) as unknown[];

  const response = asRecord(out[0]);
  assert.ok(response);
  assert.equal(response.statusCode, 400);
  const payload = asRecord(response.payload);
  assert.ok(payload);
  assert.equal(payload.error, "Composite supports at most 2 segments");
});

test("composite options rejects patterns outside the supported whitelist", () => {
  const out = runNodeRedFunction("scripts/nodered_games_nodes/fn_composite_options.js", {
    payload: {
      segments: [
        buildSlot({ id: "slot-1", timeFrom: "18:00", timeTo: "18:30" }),
      ],
    },
  }) as unknown[];

  const response = asRecord(out[0]);
  assert.ok(response);
  assert.equal(response.statusCode, 400);
  assert.equal(
    asRecord(response.payload)?.error,
    "Composite supports only 60, 30+30, 60+30, 30+60 or 60+60 patterns",
  );
});

test("composite options rejects gaps and mixed studios", () => {
  const gapOut = runNodeRedFunction("scripts/nodered_games_nodes/fn_composite_options.js", {
    payload: {
      segments: [
        buildSlot({ id: "slot-1", timeFrom: "18:00", timeTo: "19:00" }),
        buildSlot({ id: "slot-2", timeFrom: "19:30", timeTo: "20:30" }),
      ],
    },
  }) as unknown[];
  assert.equal(asRecord(gapOut[0])?.statusCode, 400);
  assert.equal(asRecord(asRecord(gapOut[0])?.payload)?.error, "Composite segments must be contiguous without gaps");

  const mixedOut = runNodeRedFunction("scripts/nodered_games_nodes/fn_composite_options.js", {
    payload: {
      segments: [
        buildSlot({ id: "slot-1", timeFrom: "18:00", timeTo: "19:00" }),
        buildSlot({ id: "slot-2", studioId: "studio-2", timeFrom: "19:00", timeTo: "20:00" }),
      ],
    },
  }) as unknown[];
  assert.equal(asRecord(mixedOut[0])?.statusCode, 400);
  assert.equal(asRecord(asRecord(mixedOut[0])?.payload)?.error, "Composite segments must belong to the same station, studio and date");
});

test("composite create builds isolated draft record with compositeBooking subtree", () => {
  const out = runNodeRedFunction("scripts/nodered_games_nodes/fn_composite_create.js", {
    payload: {
      compositeId: "composite-1",
      clientId: "client-1",
      clientPhone: "79990000001",
      clientName: "Игрок 1",
      segments: [
        buildSlot({ id: "slot-1", timeFrom: "18:00", timeTo: "19:00" }),
        buildSlot({ id: "slot-2", roomId: "room-b", roomName: "Court B", timeFrom: "19:00", timeTo: "20:00" }),
      ],
    },
  }) as unknown[];

  const dbMsg = asRecord(out[0]);
  const response = asRecord(out[1]);
  assert.ok(dbMsg);
  assert.ok(response);
  assert.deepEqual(dbMsg.query, { id: "composite-1" });
  assert.equal(response.statusCode, 201);

  const record = asRecord(response.payload);
  assert.ok(record);
  assert.equal(record.type, "COMPOSITE_BOOKING");
  assert.equal(record.status, "DRAFT");
  assert.equal(record.paymentStatus, "NOT_READY_FOR_PAYMENT");

  const compositeBooking = asRecord(record.compositeBooking);
  assert.ok(compositeBooking);
  assert.equal(compositeBooking.segmentCount, 2);
  assert.equal(compositeBooking.transitionCount, 1);
  assert.equal(compositeBooking.status, "DRAFT");

  const segments = Array.isArray(record.segments) ? record.segments : [];
  assert.equal(segments.length, 2);
  assert.equal(asRecord(record.payment)?.status, "NOT_READY_FOR_PAYMENT");
});

test("composite confirm moves draft into isolated not-ready status", () => {
  const queryOut = runNodeRedFunction("scripts/nodered_games_nodes/fn_composite_confirm_query.js", {
    payload: { compositeId: "composite-1" },
  }) as unknown[];
  const queryMsg = asRecord(queryOut[0]);
  assert.ok(queryMsg);
  assert.deepEqual(queryMsg.query, { id: "composite-1" });

  const applyOut = runNodeRedFunction("scripts/nodered_games_nodes/fn_composite_confirm_apply.js", {
    payload: [
      {
        id: "composite-1",
        status: "DRAFT",
        paymentStatus: "NOT_READY_FOR_PAYMENT",
        compositeBooking: {
          dedupeKey: "composite:station-1|studio-1|2026-06-20|room-a:18:00-19:00",
          status: "DRAFT",
          paymentStatus: "NOT_READY_FOR_PAYMENT",
        },
        payment: {
          paymentRef: "composite-pay-1",
          status: "NOT_READY_FOR_PAYMENT",
          ready: false,
        },
      },
    ],
    _compositeConfirmCtx: queryMsg._compositeConfirmCtx,
  }) as unknown[];

  const dbMsg = asRecord(applyOut[0]);
  const response = asRecord(applyOut[1]);
  assert.ok(dbMsg);
  assert.ok(response);
  assert.deepEqual(dbMsg.query, { id: "composite-1" });
  assert.equal(response.statusCode, 200);

  const record = asRecord(response.payload);
  assert.ok(record);
  assert.equal(record.status, "NOT_READY_FOR_PAYMENT");
  assert.equal(asRecord(record.compositeBooking)?.status, "NOT_READY_FOR_PAYMENT");
  assert.equal(asRecord(record.payment)?.status, "NOT_READY_FOR_PAYMENT");
});

test("composite confirm rejects ambiguous non-id lookup", () => {
  const applyOut = runNodeRedFunction("scripts/nodered_games_nodes/fn_composite_confirm_apply.js", {
    payload: [
      { id: "composite-1", compositeBooking: { dedupeKey: "dedupe-1" }, payment: { paymentRef: "pay-1" } },
      { id: "composite-2", compositeBooking: { dedupeKey: "dedupe-1" }, payment: { paymentRef: "pay-1" } },
    ],
    _compositeConfirmCtx: {
      compositeId: null,
      paymentRef: "pay-1",
      dedupeKey: null,
      nowIso: "2026-06-14T12:00:00.000Z",
    },
  }) as unknown[];

  const response = asRecord(applyOut[1]);
  assert.ok(response);
  assert.equal(response.statusCode, 409);
  assert.equal(
    asRecord(response.payload)?.error,
    "Composite confirmation query matched multiple records",
  );
});
