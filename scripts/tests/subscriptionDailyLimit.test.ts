import test from "node:test";
import assert from "node:assert/strict";
import {
  SUBSCRIPTION_DAILY_LIMIT_CODE,
  isSubscriptionDailyLimitError,
  isUnlimitedEnergy5SubscriptionProduct,
  resolveSubscriptionDailyLimitConflictFromBookings,
  resolveSubscriptionDailyLimitErrorMessage,
} from "../../src/utils/subscriptionDailyLimit.ts";

test("daily subscription limit blocks an active same-day subscription booking", () => {
  const conflict = resolveSubscriptionDailyLimitConflictFromBookings(
    [
      {
        id: "booking-1",
        paymentType: "SUBSCRIPTION",
        clientSubscriptionId: "subscription-ra-1",
        isCancelled: false,
        exercise: {
          id: "exercise-1",
          timeFrom: "2026-07-01T10:00:00+03:00",
          timeTo: "2026-07-01T11:30:00+03:00",
          type: { name: "Игра + тренер" },
          studio: { name: "РА" },
          room: { name: "Корт 1" },
        },
      },
    ],
    {
      targetDate: "2026-07-01",
      currentClientSubscriptionId: "subscription-ra-1",
    },
  );

  assert.equal(conflict?.code, SUBSCRIPTION_DAILY_LIMIT_CODE);
  assert.match(conflict?.message ?? "", /Вы уже записаны на Игра \+ тренер/);
  assert.match(conflict?.message ?? "", /на станции РА/);
  assert.match(conflict?.message ?? "", /в 10:00-11:30/);
  assert.match(conflict?.message ?? "", /1 раз в день/);
  assert.match(conflict?.message ?? "", /на завтра/);
});

test("daily subscription limit allows another subscription on the same day", () => {
  const conflict = resolveSubscriptionDailyLimitConflictFromBookings(
    [
      {
        id: "booking-1",
        paymentType: "SUBSCRIPTION",
        clientSubscriptionId: "subscription-ra-1",
        exercise: {
          id: "exercise-1",
          timeFrom: "2026-07-01T10:00:00+03:00",
          timeTo: "2026-07-01T11:00:00+03:00",
        },
      },
    ],
    {
      targetDate: "2026-07-01",
      currentClientSubscriptionId: "subscription-sport-2",
    },
  );

  assert.equal(conflict, null);
});

test("daily subscription limit does not apply to Energy 5 subscriptions", () => {
  assert.equal(
    isUnlimitedEnergy5SubscriptionProduct({
      subscriptionId: "energy-client-subscription",
      name: "Энергия 5 🎾",
    }),
    true,
  );
  assert.equal(
    isUnlimitedEnergy5SubscriptionProduct({
      id: "dfa72adf-233b-4285-8d69-e5eab4234fbe",
      name: "Direct product",
    }),
    true,
  );

  const conflict = resolveSubscriptionDailyLimitConflictFromBookings(
    [
      {
        id: "booking-energy-5",
        paymentType: "SUBSCRIPTION",
        clientSubscriptionId: "energy-client-subscription",
        subscription: { name: "Энергия-5" },
        exercise: {
          id: "exercise-1",
          timeFrom: "2026-07-01T10:00:00+03:00",
        },
      },
    ],
    {
      targetDate: "2026-07-01",
      currentClientSubscriptionId: "another-subscription",
    },
  );

  assert.equal(conflict, null);
});

test("daily subscription limit ignores cancelled, one-time, other-day and same-exercise bookings", () => {
  const conflict = resolveSubscriptionDailyLimitConflictFromBookings(
    [
      {
        id: "cancelled",
        paymentType: "SUBSCRIPTION",
        isCancelled: true,
        exercise: { id: "cancelled-ex", timeFrom: "2026-07-01T09:00:00+03:00" },
      },
      {
        id: "one-time",
        paymentType: "ON_PLACE",
        exercise: { id: "one-time-ex", timeFrom: "2026-07-01T10:00:00+03:00" },
      },
      {
        id: "other-day",
        paymentType: "SUBSCRIPTION",
        exercise: { id: "other-day-ex", timeFrom: "2026-07-02T10:00:00+03:00" },
      },
      {
        id: "same-exercise",
        paymentType: "SUBSCRIPTION",
        exercise: { id: "target-exercise", timeFrom: "2026-07-01T11:00:00+03:00" },
      },
    ],
    {
      targetDate: "2026-07-01",
      currentExerciseId: "target-exercise",
    },
  );

  assert.equal(conflict, null);
});

test("daily subscription limit error matcher reads nested backend payloads", () => {
  const error = {
    status: 409,
    message: "Viva request failed",
    raw: {
      details: {
        code: SUBSCRIPTION_DAILY_LIMIT_CODE,
        existingEvent: {
          title: "Групповая тренировка",
          studioName: "Сириус",
          timeLabel: "12:00-13:00",
        },
      },
    },
  };

  assert.equal(isSubscriptionDailyLimitError(error), true);
  assert.equal(
    resolveSubscriptionDailyLimitErrorMessage(error),
    "Вы уже записаны на Групповая тренировка на станции Сириус в 12:00-13:00. Подписка позволяет создавать или присоединяться к событию 1 раз в день. Создайте игру или присоединитесь к тренировке на завтра.",
  );
});
