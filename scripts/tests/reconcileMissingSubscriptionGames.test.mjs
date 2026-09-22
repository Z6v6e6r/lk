import test from "node:test";
import assert from "node:assert/strict";
import {
  GAP_REASONS,
  buildRestoredGamePayload,
  classifyMissingGame,
} from "../reconcile_missing_subscription_games.mjs";

const services = {
  masterServiceId: "master-1",
  subServiceIds: ["sub-1"],
};

const exercise = {
  id: "exercise-1",
  canceled: false,
  timeFrom: "2026-09-22T07:00:00+03:00",
  timeTo: "2026-09-22T08:30:00+03:00",
  maxClientsCount: 4,
  direction: { id: 4588, name: "Открытая игра на 4-ых человек." },
  type: { id: 1613, name: "Открытая игра" },
  studio: { id: "studio-1", name: "Питер" },
  room: { id: "room-1", name: "Корт №7" },
};

const subscriptionBooking = {
  id: "booking-1",
  isCancelled: false,
  paymentType: "SUBSCRIPTION",
  clientSubscriptionId: "subscription-1",
  spot: 1,
};

const operation = {
  _id: "op-1",
  exerciseId: "exercise-1",
  bookingId: "booking-1",
  actorClientId: "actor-1",
  clientSubscriptionId: "subscription-1",
};

const client = { id: "actor-1", firstName: "Виталий", lastName: "Коняхин", phone: "79939674020", photo: null };

test("active subscription gap without a game is restorable", () => {
  const verdict = classifyMissingGame({
    exercise,
    rosterBooking: subscriptionBooking,
    services,
    shareAmountMinor: 250000,
  });
  assert.equal(verdict.kind, GAP_REASONS.RESTORABLE);
  assert.deepEqual(verdict.reasons, []);
});

test("non-subscription payment gap is never auto-restored", () => {
  for (const paymentType of ["ON_PLACE", "ONE_TIME", null]) {
    const verdict = classifyMissingGame({
      exercise,
      rosterBooking: { ...subscriptionBooking, paymentType, clientSubscriptionId: null },
      services,
      shareAmountMinor: 250000,
    });
    assert.equal(verdict.kind, GAP_REASONS.MANUAL_PAYMENT);
    assert.ok(verdict.reasons.includes("payment_not_subscription"));
  }
});

test("cancelled exercise or booking gap needs no restoration", () => {
  const cancelledBooking = classifyMissingGame({
    exercise,
    rosterBooking: { ...subscriptionBooking, isCancelled: true },
    services,
    shareAmountMinor: 250000,
  });
  assert.equal(cancelledBooking.kind, GAP_REASONS.CANCELLED);
  const cancelledExercise = classifyMissingGame({
    exercise: { ...exercise, canceled: true },
    rosterBooking: subscriptionBooking,
    services,
    shareAmountMinor: 250000,
  });
  assert.equal(cancelledExercise.kind, GAP_REASONS.CANCELLED);
});

test("missing court services or price stays unresolved instead of guessed", () => {
  assert.equal(classifyMissingGame({
    exercise, rosterBooking: subscriptionBooking, services: null, shareAmountMinor: 250000,
  }).kind, GAP_REASONS.UNRESOLVED);
  assert.equal(classifyMissingGame({
    exercise, rosterBooking: subscriptionBooking, services, shareAmountMinor: null,
  }).kind, GAP_REASONS.UNRESOLVED);
});

test("restored payload mirrors the browser split widget contract", () => {
  const payload = buildRestoredGamePayload({
    operation, exercise, client, rosterBooking: subscriptionBooking, services,
    shareAmountMinor: 250000, nowIso: "2026-09-18T14:07:00.000Z",
  });

  assert.equal(payload.status, "PAID");
  assert.equal(payload.settings.payMode, "split");
  assert.equal(payload.metadata.source, "games_split_widget");
  assert.equal(payload.metadata.vivaExerciseId, "exercise-1");
  assert.deepEqual(payload.booking.bookingIds, ["booking-1"]);
  assert.equal(payload.booking.masterServiceId, "master-1");
  assert.deepEqual(payload.booking.subServiceIds, ["sub-1"]);
  assert.equal(payload.booking.durationMinutes, 90);
  assert.equal(payload.booking.date, "2026-09-22");
  assert.equal(payload.invite.maxPlayers, 4);

  const split = payload.metadata.splitPayment;
  assert.equal(split.selectedPaymentMode, "subscription");
  assert.equal(split.clientSubscriptionId, "subscription-1");
  assert.equal(split.shareAmount, 2500);
  assert.equal(split.shareAmountMinor, 250000);
  assert.equal(split.totalAmount, 10000);
  assert.equal(split.organizerBookingId, "booking-1");
  assert.equal(split.directionId, 4588);
  assert.equal(split.exerciseTypeId, 1613);
  assert.equal(split.restoredBy, "reconcile_missing_subscription_games");

  assert.equal(split.payments.length, 1);
  assert.equal(split.payments[0].role, "ORGANIZER");
  assert.equal(split.payments[0].status, "PAID");
  assert.equal(split.payments[0].amount, 0);
  assert.equal(split.payments[0].bookingId, "booking-1");
  assert.equal(payload.payment.amount, 0);
  assert.equal(payload.payment.paid, true);
  assert.equal(payload.participants.length, 1);
  assert.equal(payload.participants[0].source, "ORGANIZER");
  assert.equal(payload.participants[0].phone, "79939674020");
});
