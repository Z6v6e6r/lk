import assert from "node:assert/strict";
import test from "node:test";
import fs from "node:fs";
import ts from "typescript";
import {
  BOOKING_CONVERSION_SUBSCRIPTION,
  BOOKING_CONVERSION_UNVERIFIED,
  evaluateBookingConversionEvidence,
} from "../../src/components/games/bookingConversionEvidence.ts";

function fixture() {
  const exercise = {
    id: "exercise-1", studio: { id: "studio-1" }, room: { id: "room-1" },
    timeFrom: "2026-10-10T04:00:00Z", timeTo: "2026-10-10T05:00:00Z",
  };
  return {
    actorId: "actor-1", bookingId: "booking-1", exerciseId: "exercise-1",
    studioId: "studio-1", roomId: "room-1",
    timeFromIso: "2026-10-10T07:00:00+03:00", timeToIso: "2026-10-10T08:00:00+03:00",
    selfBookings: { content: [{ id: "booking-1", isCancelled: false, paymentType: "ONE_TIME", exercise }], totalElements: 1, totalPages: 1 },
    exerciseBookings: [{ id: "booking-1", client: { id: "actor-1" }, isCancelled: false, paymentType: "ONE_TIME" }],
  };
}
type Input = Parameters<typeof evaluateBookingConversionEvidence>[0];
function reject(input: Input, message = BOOKING_CONVERSION_UNVERIFIED) {
  assert.deepEqual(evaluateBookingConversionEvidence(input), { allowed: false, message });
}

test("ordinary booking with ownerless authenticated self DTO remains convertible", () => {
  const input = fixture();
  const before = structuredClone(input);
  const result = evaluateBookingConversionEvidence(input);
  assert.equal(result.allowed, true);
  if (result.allowed) {
    assert.deepEqual(result.roster, input.exerciseBookings);
    assert.equal(result.booking, input.selfBookings.content[0]);
  }
  assert.deepEqual(input, before);
});

test("exact self payment can fill an omitted roster payment type", () => {
  const input = fixture();
  delete (input.exerciseBookings[0] as Record<string, unknown>).paymentType;
  assert.equal(evaluateBookingConversionEvidence(input).allowed, true);
});

for (const signal of [
  { clientSubscriptionId: "subscription-1" }, { subscriptionId: "subscription-1" },
  { clientSubscription: { id: "subscription-1" } }, { subscription: {} },
  { paymentType: "SUBSCRIPTION" }, { detailedPaymentType: "subscription" }, { bookingPaymentType: "ABONEMENT" },
]) {
  test(`blocks subscription evidence ${JSON.stringify(signal)} on the organizer booking`, () => {
    const self = fixture();
    Object.assign(self.selfBookings.content[0], signal);
    reject(self, BOOKING_CONVERSION_SUBSCRIPTION);
  });

  test(`allows subscription evidence ${JSON.stringify(signal)} on a co-participant roster row`, () => {
    const roster = fixture();
    Object.assign(roster.exerciseBookings[0], signal);
    const result = evaluateBookingConversionEvidence(roster);
    assert.equal(result.allowed, true);
    if (result.allowed) assert.equal(result.roster.length, 1);
  });
}

test("another active participant subscription no longer blocks ordinary conversion", () => {
  const input = fixture();
  input.exerciseBookings.push({ id: "booking-2", client: { id: "actor-2" }, isCancelled: false, paymentType: "SUBSCRIPTION" });
  const result = evaluateBookingConversionEvidence(input);
  assert.equal(result.allowed, true);
  if (result.allowed) assert.equal(result.roster.length, 2);
});

test("historical cancelled participant does not change active non-subscription roster", () => {
  const input = fixture();
  input.exerciseBookings.push({ id: "booking-2", client: { id: "actor-2" }, isCancelled: true, paymentType: "SUBSCRIPTION" });
  const result = evaluateBookingConversionEvidence(input);
  assert.equal(result.allowed, true);
  if (result.allowed) assert.equal(result.roster.length, 1);
});

test("no evidence, malformed and partial lists cannot fall through to publication", () => {
  for (const value of [null, {}, [], [null], { content: [] },
    { content: fixture().exerciseBookings, totalElements: 2 },
    { content: fixture().exerciseBookings, totalPages: 2 },
    { content: fixture().exerciseBookings, last: false },
    { content: fixture().exerciseBookings, pageable: { pageNumber: 1 } },
  ]) {
    reject({ ...fixture(), exerciseBookings: value });
    reject({ ...fixture(), selfBookings: value });
  }
});

test("missing and duplicate exact bindings block publication", () => {
  const missing = fixture();
  missing.exerciseBookings[0].id = "other-booking";
  reject(missing);
  const duplicate = fixture();
  duplicate.exerciseBookings.push(structuredClone(duplicate.exerciseBookings[0]));
  reject(duplicate);
  const self = fixture();
  self.selfBookings.content.push(structuredClone(self.selfBookings.content[0]));
  self.selfBookings.totalElements = 2;
  reject(self);
});

test("foreign owner and conflicting aliases block even when one alias matches", () => {
  for (const fields of [{ clientId: "other" }, { userId: "other" }, { client: { id: "other" } }, { exerciseId: "other" }]) {
    const self = fixture(); Object.assign(self.selfBookings.content[0], fields); reject(self);
    const roster = fixture(); Object.assign(roster.exerciseBookings[0], fields); reject(roster);
  }
});

test("different exercise, station, court or times cannot reuse stale cabinet details", () => {
  for (const fields of [{ id: "other" }, { studio: { id: "other" } }, { room: { id: "other" } },
    { timeFrom: "2026-10-11T04:00:00Z" }, { timeTo: "2026-10-10T06:00:00Z" },
  ]) {
    const input = fixture(); Object.assign(input.selfBookings.content[0].exercise, fields); reject(input);
  }
});

test("cancelled, conflicting and missing cancellation state is not active proof", () => {
  for (const fields of [{ isCancelled: true }, { canceled: true }, { cancelled: true },
    { cancelledAt: "2026-10-01T00:00:00Z" }, { status: "CANCELLED" }, { cancelled: "false" }, { isCancelled: undefined },
  ]) {
    const self = fixture(); Object.assign(self.selfBookings.content[0], fields); reject(self);
    const roster = fixture(); Object.assign(roster.exerciseBookings[0], fields); reject(roster);
  }
});

test("unknown or conflicting own payments do not become non-subscription by default", () => {
  for (const fields of [{ paymentType: "FUTURE_METHOD" }, { paymentType: "" },
    { detailedPaymentType: "DEPOSIT" }, { bookingPaymentType: "ON_PLACE" },
  ]) {
    const input = fixture(); Object.assign(input.selfBookings.content[0], fields); reject(input);
  }
  // Roster payment aliases no longer decide the organizer's publication.
  const conflict = fixture(); conflict.exerciseBookings[0].paymentType = "DEPOSIT";
  assert.equal(evaluateBookingConversionEvidence(conflict).allowed, true);
  const other = fixture(); other.exerciseBookings.push({ id: "booking-2", client: { id: "actor-2" }, isCancelled: false, paymentType: "" });
  assert.equal(evaluateBookingConversionEvidence(other).allowed, true);
});

test("explicit supported non-subscription payment modes preserve conversion", () => {
  for (const paymentType of ["ONE_TIME", "ON_PLACE", "DEPOSIT"]) {
    const input = fixture();
    input.selfBookings.content[0].paymentType = paymentType;
    input.exerciseBookings[0].paymentType = paymentType;
    assert.equal(evaluateBookingConversionEvidence(input).allowed, true);
  }
});

test("conflicting cancellation on any roster row still blocks publication", () => {
  const input = fixture();
  input.exerciseBookings.push({ id: "booking-2", client: { id: "actor-2" }, isCancelled: false, paymentType: "SUBSCRIPTION" });
  Object.assign(input.exerciseBookings[1], { cancelled: true });
  reject(input);
});

test("wrapper needs explicit completeness, not just content", () => {
  reject({ ...fixture(), exerciseBookings: { content: fixture().exerciseBookings } });
  reject({ ...fixture(), selfBookings: { content: fixture().selfBookings.content } });
  assert.equal(evaluateBookingConversionEvidence({ ...fixture(), exerciseBookings: { content: fixture().exerciseBookings, totalElements: 1 } }).allowed, true);
});

test("malformed own payment fails closed rather than disappearing", () => {
  for (const fields of [{ detailedPaymentType: { type: "SUBSCRIPTION" } }, { bookingPaymentType: false }]) {
    const self = fixture(); Object.assign(self.selfBookings.content[0], fields); reject(self);
  }
});

test("malformed owner fields fail closed on the organizer and roster rows", () => {
  for (const fields of [{ client: { id: { value: "other" } } }, { client: "other" }, { clientId: {} }]) {
    const self = fixture(); Object.assign(self.selfBookings.content[0], fields); reject(self);
    const roster = fixture(); Object.assign(roster.exerciseBookings[0], fields); reject(roster);
  }
});

test("malformed or cancelled exercise cannot be published from stale preset", () => {
  for (const fields of [{ canceled: "true" }, { cancelled: true, isCancelled: false },
    { cancelledAt: "2026-10-01T00:00:00Z" }, { archived: true },
  ]) {
    const input = fixture(); Object.assign(input.selfBookings.content[0].exercise, fields); reject(input);
  }
});

test("fresh preflight reads use authenticated GET with browser cache disabled", async () => {
  const source = fs.readFileSync("src/utils/apiClient.ts", "utf8");
  for (const [name, end, args] of [
    ["apiFetchBookings", "export interface SubscriptionDailyLimitBookingsResponse", [false, { fresh: true }]],
    ["apiFetchExerciseBookings", "function isPhoneLikeRatingValue", ["exercise-1", { fresh: true }]],
  ] as const) {
    const start = source.indexOf(`export async function ${name}(`);
    const code = source.slice(start, source.indexOf(end, start)).replace("export async", "async");
    const js = ts.transpileModule(code, { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText;
    const calls: Array<{ url: string; options: Record<string, unknown> }> = [];
    const call = new Function("request", "API_BASE", "TENANT_KEY", `${js}; return ${name};`)(
      async (url: string, options: Record<string, unknown>) => { calls.push({ url, options }); return { data: [] }; },
      "https://viva.invalid", "test",
    );
    await call(...args);
    assert.equal(calls.length, 1);
    assert.equal(calls[0].options.method, "GET");
    assert.equal(calls[0].options.auth, true);
    assert.equal(calls[0].options.cache, "no-store");
    assert.match(calls[0].url, /\/end-user\/api\/v[12]\/test\//);
    await call(args[0]);
    assert.equal(calls[1].options.cache, undefined, "other callers retain their previous cache behavior");
  }
});
