import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import {
  attachPaymentSyncExerciseId,
  collectPaymentSyncPayloadExerciseIds,
  isGameExerciseIdMissingGuard,
  recoverGameExerciseIdWithFetcher,
  resolvePaymentSyncExerciseIdFromBookings,
} from "../../src/utils/paymentSyncBookingResolution.ts";

const booking = (
  id: string,
  exerciseId: string | null,
  overrides: Record<string, unknown> = {},
) => ({
  id,
  isCancelled: false,
  exercise: exerciseId ? { id: exerciseId } : {},
  ...overrides,
});

test("payment sync restores one exerciseId from all active bookingIds", () => {
  const result = resolvePaymentSyncExerciseIdFromBookings(
    ["booking-1", "booking-2"],
    [booking("booking-1", "exercise-1"), booking("booking-2", "exercise-1")],
    [],
  );
  assert.deepEqual(result, {
    ok: true,
    exerciseId: "exercise-1",
    bookingIds: ["booking-1", "booking-2"],
  });
  if (result.ok) {
    const payload = attachPaymentSyncExerciseId({ booking: {}, metadata: {} }, result.exerciseId);
    assert.deepEqual(collectPaymentSyncPayloadExerciseIds(payload), ["exercise-1"]);
    assert.equal(payload.booking?.exerciseId, "exercise-1");
    assert.equal(payload.booking?.vivaExerciseId, "exercise-1");
  }
});

test("shared async recovery loads active and history bookings for zero-pay create", async () => {
  const calls: boolean[] = [];
  const result = await recoverGameExerciseIdWithFetcher({
    bookingIds: ["booking-1", "booking-2"],
    exerciseIds: [],
    fetchBookings: async (includeCanceled) => {
      calls.push(includeCanceled);
      return {
        data: {
          content: includeCanceled
            ? []
            : [booking("booking-1", "exercise-1"), booking("booking-2", "exercise-1")],
        },
        error: null,
        status: 200,
      };
    },
  });
  assert.deepEqual(calls.sort(), [false, true]);
  assert.equal(result.ok, true);
  if (result.ok) {
    assert.equal(result.exerciseId, "exercise-1");
    assert.equal(result.source, "viva_bookings");
  }

  const gamesPageSource = fs.readFileSync("src/components/games/GamesPage.tsx", "utf8");
  const recoverySource = fs.readFileSync("src/utils/gameExerciseIdRecovery.ts", "utf8");
  assert.match(recoverySource, /fetchBookings: apiFetchBookings/);
  const handlerStart = gamesPageSource.indexOf("const handleMasterServicePay = useCallback");
  const handlerEnd = gamesPageSource.indexOf("const handleCreateSubmit = useCallback", handlerStart);
  const handler = gamesPageSource.slice(handlerStart, handlerEnd);
  assert.match(handler, /!paymentResult\.data\.paymentUrl[\s\S]*resolvedPaymentAmount <= 0[\s\S]*!resolvedExerciseId[\s\S]*await recoverGameExerciseId/);
  const recoveryCall = gamesPageSource.indexOf("await recoverGameExerciseId", handlerStart);
  const zeroPayBranch = gamesPageSource.indexOf("if (paymentResult.data && !paymentResult.data.paymentUrl", handlerStart);
  const directCreate = gamesPageSource.indexOf("apiCreatePadelGameRecord(directPayload)", handlerStart);
  assert.ok(recoveryCall > handlerStart);
  assert.ok(zeroPayBranch > recoveryCall);
  assert.ok(directCreate > zeroPayBranch);
});

test("paid paymentUrl branch does not wait for Viva list recovery", () => {
  const gamesPageSource = fs.readFileSync("src/components/games/GamesPage.tsx", "utf8");
  const handlerStart = gamesPageSource.indexOf("const handleMasterServicePay = useCallback");
  const handlerEnd = gamesPageSource.indexOf("const handleCreateSubmit = useCallback", handlerStart);
  const handler = gamesPageSource.slice(handlerStart, handlerEnd);
  const guardedRecovery = handler.indexOf("await recoverGameExerciseId");
  const paymentUrlBranch = handler.indexOf("if (paymentResult.data?.paymentUrl)", guardedRecovery);

  assert.ok(guardedRecovery >= 0);
  assert.ok(paymentUrlBranch > guardedRecovery);
  assert.match(handler, /if \([\s\S]*!paymentResult\.data\.paymentUrl[\s\S]*await recoverGameExerciseId/);
  assert.match(handler.slice(paymentUrlBranch), /exerciseId: resolvedExerciseId/);
  assert.match(handler.slice(paymentUrlBranch), /savePendingPaidGameDraft\([\s\S]*navigateToExternalUrl/);
});

test("payment sync fails closed when a booking is missing", () => {
  const result = resolvePaymentSyncExerciseIdFromBookings(
    ["booking-1", "booking-missing"],
    [booking("booking-1", "exercise-1")],
    [],
  );
  assert.equal(result.ok, false);
  if (!result.ok) assert.equal(result.code, "BOOKING_NOT_FOUND");
});

test("payment sync fails closed when bookingIds have different exercises", () => {
  const result = resolvePaymentSyncExerciseIdFromBookings(
    ["booking-1", "booking-2"],
    [booking("booking-1", "exercise-1"), booking("booking-2", "exercise-2")],
    [],
  );
  assert.equal(result.ok, false);
  if (!result.ok) assert.equal(result.code, "EXERCISE_ID_MISMATCH");
});

test("payment sync fails closed for cancelled booking or exercise", () => {
  for (const cancelled of [
    booking("booking-1", "exercise-1", { isCancelled: true }),
    booking("booking-1", "exercise-1", { status: "CANCELLED" }),
    booking("booking-1", "exercise-1", { exercise: { id: "exercise-1", archived: true } }),
  ]) {
    const result = resolvePaymentSyncExerciseIdFromBookings(["booking-1"], [], [cancelled]);
    assert.equal(result.ok, false);
    if (!result.ok) assert.equal(result.code, "BOOKING_CANCELLED");
  }
});

test("backend missing-exercise 409 cannot fall through aliases or legacy create", () => {
  assert.equal(isGameExerciseIdMissingGuard(409, { code: "GAME_EXERCISE_ID_MISSING" }), true);
  assert.equal(isGameExerciseIdMissingGuard(409, { code: "GAME_SLOT_CONFLICT" }), false);

  const apiClientSource = fs.readFileSync("src/utils/apiClient.ts", "utf8");
  const writerStart = apiClientSource.indexOf("async function writePadelGameRecord(");
  const writerEnd = apiClientSource.indexOf("async function hydratePadelGameRecordAfterWrite", writerStart);
  const writer = apiClientSource.slice(writerStart, writerEnd);
  const failFast = writer.indexOf("isGameExerciseIdMissingGuard(response.status, response.error.raw)");
  const fallbackContinue = writer.indexOf("continue;", failFast);
  assert.ok(failFast >= 0);
  assert.ok(fallbackContinue > failFast);
  assert.match(writer.slice(failFast, fallbackContinue), /return \{ data: null/);

  const syncSource = fs.readFileSync("src/utils/paymentSync.ts", "utf8");
  const syncGuard = syncSource.indexOf(
    "isGameExerciseIdMissingGuard(confirmResult.status, confirmResult.error?.raw)",
  );
  const legacyCreate = syncSource.indexOf('stage: "legacy_create"', syncGuard);
  assert.ok(syncGuard >= 0);
  assert.ok(legacyCreate > syncGuard);
  assert.match(syncSource.slice(syncGuard, legacyCreate), /continue;/);
});
