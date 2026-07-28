import test from "node:test";
import assert from "node:assert/strict";

import {
  buildBookingCancellationPayload,
  findBookingCancellationActionByRefundMethod,
  formatMinorCurrency,
  pickAutomaticBookingCancellationAction,
  resolveBookingCancellationVerification,
  resolveBookingCancellationPlan,
} from "../../src/utils/bookingCancellation.ts";

test("mixed cancellation options ask user to choose card or deposit using minor amounts", () => {
  const plan = resolveBookingCancellationPlan({
    bookingId: "booking-1",
    cancellationOptions: {
      money: { available: true, refundSum: 900, refundMethod: "ONLINE" },
      deposit: { available: true, refundSum: 3000 },
      exercise: { available: true },
      settlementAccount: { available: true, refundSum: 900 },
      cancellationOnly: { available: true },
      subscription: { available: false },
    },
  });

  assert.equal(plan.mode, "selection");
  assert.equal(plan.actions.length, 2);
  assert.equal(plan.actions[0].id, "card");
  assert.equal(plan.actions[0].label, "На карту · 9 ₽");
  assert.equal(plan.actions[1].id, "deposit");
  assert.equal(plan.actions[1].label, "На депозит · 30 ₽");
  assert.equal(findBookingCancellationActionByRefundMethod(plan, "CURRENCY")?.id, "card");
  assert.equal(findBookingCancellationActionByRefundMethod(plan, "DEPOSIT")?.id, "deposit");
});

test("subscription cancellation returns visit to subscription", () => {
  const plan = resolveBookingCancellationPlan({
    bookingId: "booking-2",
    cancellationOptions: {
      money: { available: false, refundSum: null, refundMethod: null },
      deposit: { available: false, refundSum: null },
      subscription: { available: true },
      cancellationOnly: { available: true },
    },
  });

  assert.equal(plan.mode, "confirm");
  assert.equal(plan.actions.length, 1);
  assert.equal(plan.actions[0].id, "subscription");
  assert.equal(plan.actions[0].successMessage, "Вернули 1 занятие на абонемент.");
  assert.deepEqual(buildBookingCancellationPayload(plan.actions[0]), {});
});

test("cancellation only keeps plain no-refund flow", () => {
  const plan = resolveBookingCancellationPlan({
    bookingId: "booking-3",
    cancellationOptions: {
      cancellationOnly: { available: true },
    },
  });

  assert.equal(plan.mode, "confirm");
  assert.equal(plan.actions[0].id, "none");
  assert.deepEqual(buildBookingCancellationPayload(plan.actions[0]), {});
});

test("automatic cancellation keeps subscription when it is the supported action", () => {
  const plan = resolveBookingCancellationPlan({
    bookingId: "booking-3a",
    cancellationOptions: {
      subscription: { available: true },
      cancellationOnly: { available: true },
    },
  });

  const action = pickAutomaticBookingCancellationAction(plan);
  assert.equal(action?.id, "subscription");
});

test("automatic cancellation can respect preferred deposit refund method", () => {
  const plan = resolveBookingCancellationPlan({
    bookingId: "booking-3b",
    cancellationOptions: {
      money: { available: true, refundSum: 900, refundMethod: "ONLINE" },
      deposit: { available: true, refundSum: 3000 },
    },
  });

  const action = pickAutomaticBookingCancellationAction(plan, "DEPOSIT");
  assert.equal(action?.id, "deposit");
});

test("settlement account only is blocked as unsupported", () => {
  const plan = resolveBookingCancellationPlan({
    bookingId: "booking-4",
    cancellationOptions: {
      settlementAccount: { available: true, refundSum: 1000 },
    },
  });

  assert.equal(plan.mode, "unsupported");
  assert.match(plan.unsupportedReason || "", /лицевой счет/i);
});

test("exercise only is blocked as unsupported service refund", () => {
  const plan = resolveBookingCancellationPlan({
    bookingId: "booking-5",
    cancellationOptions: {
      exercise: { available: true },
    },
  });

  assert.equal(plan.mode, "unsupported");
  assert.match(plan.unsupportedReason || "", /в виде услуги/i);
});

test("minor currency formatting keeps kopecks semantics", () => {
  assert.equal(formatMinorCurrency(900), "9 ₽");
  assert.equal(formatMinorCurrency(1050), "10,50 ₽");
});

test("booking cancellation verification confirms an exact cancelled history row", () => {
  const result = resolveBookingCancellationVerification(
    "booking-1",
    [],
    [{
      id: "booking-1",
      isCancelled: true,
      cancellationDate: "2026-07-28T10:00:00+03:00",
    }],
  );

  assert.equal(result.state, "cancelled");
  assert.equal(result.record?.id, "booking-1");
});

test("booking cancellation verification rejects an exact active row", () => {
  const result = resolveBookingCancellationVerification(
    "booking-2",
    [{
      id: "booking-2",
      isCancelled: false,
    }],
    [],
  );

  assert.equal(result.state, "active");
  assert.equal(result.record?.id, "booking-2");
});

test("active booking wins over a conflicting cancelled history projection", () => {
  const result = resolveBookingCancellationVerification(
    "booking-race",
    [{
      id: "booking-race",
      isCancelled: false,
    }],
    [{
      id: "booking-race",
      isCancelled: true,
    }],
  );

  assert.equal(result.state, "active");
  assert.equal(result.record?.isCancelled, false);
});

test("booking cancellation verification never treats absence as confirmed cancellation", () => {
  const result = resolveBookingCancellationVerification(
    "booking-3",
    [],
    [{
      id: "another-booking",
      isCancelled: true,
    }],
  );

  assert.equal(result.state, "unverified");
  assert.equal(result.record, null);
});
