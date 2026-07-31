import test from "node:test";
import assert from "node:assert/strict";
import {
  SUBSCRIPTION_CATEGORY_DAILY_LIMIT_SHARED_FROM,
  SUBSCRIPTION_CATEGORY_LIMIT_GROUP_TRAINING,
  SUBSCRIPTION_CATEGORY_LIMIT_OPEN_GAME,
  SUBSCRIPTION_CATEGORY_LIMIT_TOURNAMENT,
  resolveSubscriptionCategoryDailyLimitConflictFromBookings,
} from "../../src/utils/subscriptionCategoryDailyLimit.ts";

const subscriptionId = "client-subscription-summer";

const exerciseCategory = {
  open_game: {
    direction: { id: 4588, name: "Открытая игра" },
    type: { id: 1613, name: "Открытая игра" },
  },
  group_training: {
    direction: { id: 3935, name: "Игра+Тренер. Уровень D" },
    type: { id: 847, name: "Игра+Тренер" },
  },
  tournament: {
    direction: { id: 2617, name: "Падел турнир от ПадлхАБ" },
    type: { id: 839, name: "Падел Турнир" },
  },
} as const;

const booking = (
  category: keyof typeof exerciseCategory,
  date = "2026-08-01",
  timeTo = "11:00:00",
  extra: Record<string, unknown> = {},
) => ({
  id: `booking-${category}-${date}-${timeTo}`,
  paymentType: "SUBSCRIPTION",
  clientSubscriptionId: subscriptionId,
  ...extra,
  exercise: {
    id: `exercise-${category}-${date}-${timeTo}`,
    timeFrom: `${date}T10:00:00+03:00`,
    timeTo: `${date}T${timeTo}+03:00`,
    ...exerciseCategory[category],
  },
});

const conflictFor = (
  bookings: unknown[],
  options: {
    date?: string;
    category: "open_game" | "group_training" | "tournament";
    subscriptionName: string;
    currentClientSubscriptionId?: string;
  },
) => resolveSubscriptionCategoryDailyLimitConflictFromBookings(bookings, {
  targetDate: options.date ?? "2026-08-01",
  category: options.category,
  currentSubscription: { name: options.subscriptionName },
  currentClientSubscriptionId: options.currentClientSubscriptionId ?? subscriptionId,
});

test("starts the shared event limit on 2026-08-01", () => {
  assert.equal(SUBSCRIPTION_CATEGORY_DAILY_LIMIT_SHARED_FROM, "2026-08-01");

  const julyBooking = booking("open_game", "2026-07-31");
  assert.equal(conflictFor([julyBooking], {
    date: "2026-07-31",
    category: SUBSCRIPTION_CATEGORY_LIMIT_TOURNAMENT,
    subscriptionName: "Лето.Падел.Спорт",
  }), null);

  assert.ok(conflictFor([booking("open_game")], {
    category: SUBSCRIPTION_CATEGORY_LIMIT_TOURNAMENT,
    subscriptionName: "Лето.Падел.Спорт",
  }));
});

test("applies one shared event to every allowed category in each summer plan", () => {
  const openGame = booking("open_game");
  const cases = [
    ["Лето.Падел.Дружба", SUBSCRIPTION_CATEGORY_LIMIT_OPEN_GAME],
    ["Лето.Падел.Спорт", SUBSCRIPTION_CATEGORY_LIMIT_TOURNAMENT],
    ["Лето.Падел.Академия", SUBSCRIPTION_CATEGORY_LIMIT_GROUP_TRAINING],
    ["Лето.Падел.РА", SUBSCRIPTION_CATEGORY_LIMIT_GROUP_TRAINING],
    ["Лето.Падел.РА", SUBSCRIPTION_CATEGORY_LIMIT_TOURNAMENT],
  ] as const;

  for (const [subscriptionName, category] of cases) {
    assert.ok(conflictFor([openGame], { category, subscriptionName }));
  }
});

test("does not extend a plan beyond its allowed categories", () => {
  const openGame = booking("open_game");
  assert.equal(conflictFor([openGame], {
    category: SUBSCRIPTION_CATEGORY_LIMIT_GROUP_TRAINING,
    subscriptionName: "Лето.Падел.Дружба",
  }), null);
  assert.equal(conflictFor([openGame], {
    category: SUBSCRIPTION_CATEGORY_LIMIT_GROUP_TRAINING,
    subscriptionName: "Лето.Падел.Спорт",
  }), null);
  assert.equal(conflictFor([openGame], {
    category: SUBSCRIPTION_CATEGORY_LIMIT_TOURNAMENT,
    subscriptionName: "Лето.Падел.Академия",
  }), null);
});

test("counts a 60 or 120 minute game as one event", () => {
  for (const [date, timeTo] of [["2026-08-08", "11:00:00"], ["2026-08-09", "12:00:00"]] as const) {
    const existingGame = booking("open_game", date, timeTo);
    const conflict = conflictFor([existingGame], {
      date,
      category: SUBSCRIPTION_CATEGORY_LIMIT_TOURNAMENT,
      subscriptionName: "Лето.Падел.Спорт",
    });
    assert.equal(conflict?.existingEvent.exerciseId, existingGame.exercise.id);
  }
});

test("shares the limit in both directions for group trainings and tournaments", () => {
  assert.equal(
    conflictFor([booking("group_training")], {
      category: SUBSCRIPTION_CATEGORY_LIMIT_OPEN_GAME,
      subscriptionName: "Лето.Падел.Академия",
    })?.existingEvent.category,
    SUBSCRIPTION_CATEGORY_LIMIT_GROUP_TRAINING,
  );
  assert.equal(
    conflictFor([booking("tournament")], {
      category: SUBSCRIPTION_CATEGORY_LIMIT_OPEN_GAME,
      subscriptionName: "Лето.Падел.Спорт",
    })?.existingEvent.category,
    SUBSCRIPTION_CATEGORY_LIMIT_TOURNAMENT,
  );
});

test("cancelled and refunded bookings release the daily event slot", () => {
  const inactiveBookings = [
    booking("open_game", "2026-08-01", "11:00:00", { status: "CANCELLED" }),
    booking("open_game", "2026-08-01", "12:00:00", { status: "REFUNDED" }),
    booking("open_game", "2026-08-01", "13:00:00", { cancelledAt: "2026-08-01T09:00:00+03:00" }),
    booking("open_game", "2026-08-01", "14:00:00", {
      transactionStatus: { transactionStatus: "REFUNDED" },
    }),
  ];
  assert.equal(conflictFor(inactiveBookings, {
    category: SUBSCRIPTION_CATEGORY_LIMIT_TOURNAMENT,
    subscriptionName: "Лето.Падел.Спорт",
  }), null);
});

test("keeps different or unidentified client subscriptions independent", () => {
  const differentSubscription = booking("open_game");
  assert.equal(conflictFor([differentSubscription], {
    category: SUBSCRIPTION_CATEGORY_LIMIT_TOURNAMENT,
    subscriptionName: "Лето.Падел.Спорт",
    currentClientSubscriptionId: "another-client-subscription",
  }), null);

  const withoutIdentity = booking("open_game");
  delete (withoutIdentity as { clientSubscriptionId?: string }).clientSubscriptionId;
  assert.equal(conflictFor([withoutIdentity], {
    category: SUBSCRIPTION_CATEGORY_LIMIT_TOURNAMENT,
    subscriptionName: "Лето.Падел.Спорт",
  }), null);
});
