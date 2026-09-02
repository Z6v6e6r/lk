import assert from "node:assert/strict";
import test from "node:test";

import {
  PARTNER_VIVA_ADMIN_API_BASE,
  PARTNER_VIVA_CONTRACT_REVISION,
  VivaAdminTechnicalUserProvider,
} from "../../node-red/custom-nodes/partner-game-membership-api/partner-game-membership-viva.mjs";

const TOKEN = "header.payload.signature-value-for-tests";
const OPERATION_ID = "550e8400-e29b-41d4-a716-446655440000";
const response = (status, payload) => ({
  status,
  ok: status >= 200 && status < 300,
  async text() { return payload === null ? "" : JSON.stringify(payload); },
});

const readyProvider = (fetchImpl) => new VivaAdminTechnicalUserProvider({
  fetchImpl,
  tokenResolver: async () => TOKEN,
  mutationsEnabled: true,
  contractRevision: PARTNER_VIVA_CONTRACT_REVISION,
  idempotencyConfirmed: true,
  onPlacePaymentConfirmed: true,
  timeoutMs: 1_000,
});

const addInput = {
  operationId: OPERATION_ID,
  idempotencyKey: "partner-add-001",
  exerciseId: "exercise-1",
  technicalVivaClientId: "technical-client-1",
};

test("Viva provider remains fail-closed until every external contract gate is explicit", async () => {
  const calls = [];
  const base = {
    fetchImpl: async (...args) => { calls.push(args); return response(200, {}); },
    tokenResolver: async () => TOKEN,
    mutationsEnabled: true,
    contractRevision: PARTNER_VIVA_CONTRACT_REVISION,
    idempotencyConfirmed: true,
    onPlacePaymentConfirmed: true,
  };
  for (const [field, value, code] of [
    ["mutationsEnabled", false, "VIVA_RUNTIME_NOT_CONFIGURED"],
    ["contractRevision", "unapproved", "VIVA_CONTRACT_NOT_APPROVED"],
    ["idempotencyConfirmed", false, "VIVA_IDEMPOTENCY_NOT_CONFIRMED"],
    ["onPlacePaymentConfirmed", false, "VIVA_PAYMENT_TYPE_NOT_CONFIRMED"],
    ["apiBase", "https://example.invalid/api", "VIVA_API_BASE_INVALID"],
  ]) {
    const provider = new VivaAdminTechnicalUserProvider({ ...base, [field]: value });
    await assert.rejects(() => provider.assertReady(), { code, ambiguous: false });
  }
  const missingToken = new VivaAdminTechnicalUserProvider({ ...base, tokenResolver: async () => "" });
  await assert.rejects(() => missingToken.assertReady(), { code: "VIVA_SERVICE_TOKEN_UNAVAILABLE" });
  assert.equal(calls.length, 0);
});

test("Viva add uses the pinned path, body, proof headers, and exact response binding", async () => {
  const calls = [];
  const provider = readyProvider(async (url, options) => {
    calls.push({ url, options });
    return response(201, {
      id: "booking-1",
      clientId: addInput.technicalVivaClientId,
      exerciseId: addInput.exerciseId,
    });
  });
  assert.deepEqual(await provider.addTechnicalUser(addInput), { bookingId: "booking-1" });
  assert.equal(calls.length, 1, "mutation adapter must never retry");
  assert.equal(calls[0].url, `${PARTNER_VIVA_ADMIN_API_BASE}/exercises/exercise-1/bookings`);
  assert.equal(calls[0].options.method, "POST");
  assert.equal(calls[0].options.redirect, "error");
  assert.equal(calls[0].options.headers.Authorization, `Bearer ${TOKEN}`);
  assert.equal(calls[0].options.headers["Idempotency-Key"], addInput.idempotencyKey);
  assert.equal(calls[0].options.headers["X-Correlation-ID"], OPERATION_ID);
  assert.deepEqual(JSON.parse(calls[0].options.body), {
    clientId: addInput.technicalVivaClientId,
    paymentType: "ON_PLACE",
    familyMemberId: "",
    customFields: [],
  });
});

test("Viva mutation transport and 5xx outcomes are ambiguous and never retried", async () => {
  for (const fetchImpl of [
    async () => { throw new Error("socket closed"); },
    async () => response(503, { error: "unavailable" }),
  ]) {
    let calls = 0;
    const provider = readyProvider(async (...args) => { calls += 1; return fetchImpl(...args); });
    await assert.rejects(() => provider.addTechnicalUser(addInput), {
      code: "VIVA_ADD_OUTCOME_UNKNOWN",
      ambiguous: true,
      httpStatus: 202,
    });
    assert.equal(calls, 1);
  }
});

test("Viva add rejects missing or mismatched booking identity as ambiguous", async () => {
  for (const payload of [
    {},
    { id: "booking-1", clientId: "someone-else", exerciseId: "exercise-1" },
    { id: "booking-1", bookingId: "booking-2" },
    { id: "booking-1", data: { id: "booking-2" } },
    {
      data: { id: "booking-1", clientId: "technical-client-1", exerciseId: "exercise-1" },
      booking: { id: "booking-2", clientId: "technical-client-1", exerciseId: "exercise-1" },
    },
  ]) {
    const provider = readyProvider(async () => response(201, payload));
    await assert.rejects(() => provider.addTechnicalUser(addInput), { ambiguous: true });
  }
});

test("Viva readback binds one booking and rejects duplicate identities", async () => {
  const readInput = { ...addInput, bookingId: "booking-1" };
  const provider = readyProvider(async (url, options) => {
    assert.equal(url, `${PARTNER_VIVA_ADMIN_API_BASE}/exercises/exercise-1/bookings?showCancelled=true&page=0&size=200`);
    assert.equal(options.method, "GET");
    return response(200, { content: [{
      id: "booking-1",
      clientId: "technical-client-1",
      exerciseId: "exercise-1",
      status: "ACTIVE",
    }] });
  });
  assert.deepEqual(await provider.readBooking(readInput), {
    bookingId: "booking-1",
    exerciseId: "exercise-1",
    clientId: "technical-client-1",
    active: true,
  });

  const duplicate = readyProvider(async () => response(200, [
    { id: "booking-1" },
    { id: "booking-1" },
  ]));
  await assert.rejects(() => duplicate.readBooking(readInput), {
    code: "VIVA_READBACK_AMBIGUOUS",
    ambiguous: true,
  });

  for (const row of [
    { id: "booking-1", clientId: "other", exerciseId: "exercise-1", status: "ACTIVE" },
    { id: "booking-1", clientId: "technical-client-1", exerciseId: "exercise-1" },
  ]) {
    const ambiguous = readyProvider(async () => response(200, [row]));
    await assert.rejects(() => ambiguous.readBooking(readInput), { ambiguous: true });
  }

  const incompleteAbsence = readyProvider(async () => response(200, { content: [], last: false }));
  await assert.rejects(() => incompleteAbsence.readBooking(readInput), {
    code: "VIVA_READBACK_INCOMPLETE",
    ambiguous: true,
  });
  const completeAbsence = readyProvider(async () => response(200, {
    content: [],
    number: 0,
    totalPages: 0,
    totalElements: 0,
  }));
  assert.equal((await completeAbsence.readBooking(readInput)).active, false);

  const conflictingContainers = readyProvider(async () => response(200, {
    content: [],
    items: [{
      id: "booking-1",
      clientId: "technical-client-1",
      exerciseId: "exercise-1",
      status: "ACTIVE",
    }],
    number: 0,
    totalPages: 0,
  }));
  await assert.rejects(() => conflictingContainers.readBooking(readInput), {
    code: "VIVA_READBACK_AMBIGUOUS",
    ambiguous: true,
  });

  const sharedRows = [{
    id: "booking-1",
    clientId: "technical-client-1",
    exerciseId: "exercise-1",
    status: "ACTIVE",
  }];
  const agreeingContainers = readyProvider(async () => response(200, {
    content: sharedRows,
    items: structuredClone(sharedRows),
  }));
  assert.equal((await agreeingContainers.readBooking(readInput)).active, true);
});

test("Viva readback accepts agreeing aliases and rejects contradictory identity or lifecycle evidence", async () => {
  const readInput = { ...addInput, bookingId: "booking-1" };
  for (const [row, active] of [
    [{
      id: "booking-1",
      bookingId: "booking-1",
      uuid: "booking-1",
      clientId: "technical-client-1",
      client: { id: "technical-client-1" },
      customer: { id: "technical-client-1" },
      exerciseId: "exercise-1",
      exercise: { id: "exercise-1" },
      service: { id: "exercise-1" },
      active: true,
      cancelled: false,
      canceled: false,
      status: "ACTIVE",
      state: "active",
    }, true],
    [{
      bookingId: "booking-1",
      client: { id: "technical-client-1" },
      service: { id: "exercise-1" },
      state: "CONFIRMED",
    }, true],
    [{
      uuid: "booking-1",
      customer: { id: "technical-client-1" },
      exercise: { id: "exercise-1" },
      active: false,
      status: "CANCELLED",
    }, false],
  ]) {
    const provider = readyProvider(async () => response(200, [row]));
    assert.equal((await provider.readBooking(readInput)).active, active);
  }

  for (const row of [
    { id: "booking-1", bookingId: "booking-2", clientId: "technical-client-1", exerciseId: "exercise-1", status: "ACTIVE" },
    { id: "booking-1", clientId: "technical-client-1", client: { id: "other" }, exerciseId: "exercise-1", status: "ACTIVE" },
    { id: "booking-1", clientId: "technical-client-1", exerciseId: "exercise-1", service: { id: "other" }, status: "ACTIVE" },
    { id: "booking-1", clientId: "technical-client-1", exerciseId: "exercise-1", active: false, status: "ACTIVE" },
    { id: "booking-1", clientId: "technical-client-1", exerciseId: "exercise-1", active: true, status: "CANCELLED" },
    { id: "booking-1", clientId: "technical-client-1", exerciseId: "exercise-1", status: "ACTIVE", state: "CANCELLED" },
    { id: "booking-1", clientId: "technical-client-1", exerciseId: "exercise-1", cancelled: true, canceled: false },
    { id: "booking-1", clientId: "technical-client-1", exerciseId: "exercise-1", active: "false", status: "CANCELLED" },
  ]) {
    const provider = readyProvider(async () => response(200, [row]));
    await assert.rejects(() => provider.readBooking(readInput), {
      code: "VIVA_READBACK_AMBIGUOUS",
      ambiguous: true,
    });
  }
});

test("Viva removal requires cancellation-only proof before the pinned cancellation command", async () => {
  const calls = [];
  const input = { ...addInput, bookingId: "booking-1", idempotencyKey: "partner-remove-001" };
  const provider = readyProvider(async (url, options) => {
    calls.push({ url, options });
    if (options.method === "GET") {
      return response(200, { cancellationOptions: { cancellationOnly: { available: true } } });
    }
    return response(200, { id: "booking-1" });
  });
  assert.deepEqual(await provider.removeTechnicalUser(input), { bookingId: "booking-1" });
  const expectedPath = "/clients/technical-client-1/bookings/booking-1/cancel";
  assert.equal(calls[0].url, `${PARTNER_VIVA_ADMIN_API_BASE}${expectedPath}`);
  assert.equal(calls[0].options.method, "GET");
  assert.equal(calls[1].options.method, "PUT");
  assert.equal(calls[1].options.headers["Idempotency-Key"], input.idempotencyKey);
  assert.deepEqual(JSON.parse(calls[1].options.body), { refundMethod: "NONE", cancelExercise: false });

  const unsafe = readyProvider(async () => response(200, { cancellationOptions: {} }));
  await assert.rejects(() => unsafe.removeTechnicalUser(input), {
    code: "VIVA_CANCEL_CONTRACT_MISMATCH",
    ambiguous: false,
    httpStatus: 409,
  });
});
