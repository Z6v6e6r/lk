import test from "node:test";
import assert from "node:assert/strict";
import {
  SUBSCRIPTION_CATEGORY_DAILY_LIMIT_CODE,
  SUBSCRIPTION_CATEGORY_LIMIT_GROUP_TRAINING,
  SUBSCRIPTION_CATEGORY_LIMIT_OPEN_GAME,
  SUBSCRIPTION_CATEGORY_LIMIT_PRODUCT_IDS,
  SUBSCRIPTION_CATEGORY_LIMIT_TOURNAMENT,
  resolveSubscriptionCategoryDailyLimitCategoryFromEvent,
  resolveSubscriptionCategoryDailyLimitConflictFromBookings,
  resolveSubscriptionCategoryDailyLimitPlanKey,
  resolveSubscriptionCategoryDailyLimitErrorMessage,
  subscriptionPlanAllowsDailyLimitCategory,
  buildSubscriptionCategoryDailyLimitApiError,
  withSubscriptionCategoryDailyLimitResolvedName,
} from "../../src/utils/subscriptionCategoryDailyLimit.ts";

test("recognizes tracked summer subscription products by ids and names", () => {
  assert.equal(
    resolveSubscriptionCategoryDailyLimitPlanKey({ productId: SUBSCRIPTION_CATEGORY_LIMIT_PRODUCT_IDS.friendship }),
    "friendship",
  );
  assert.equal(
    resolveSubscriptionCategoryDailyLimitPlanKey({ productId: SUBSCRIPTION_CATEGORY_LIMIT_PRODUCT_IDS.sport }),
    "sport",
  );
  assert.equal(
    resolveSubscriptionCategoryDailyLimitPlanKey({ product: { id: SUBSCRIPTION_CATEGORY_LIMIT_PRODUCT_IDS.academy } }),
    "academy",
  );
  assert.equal(
    resolveSubscriptionCategoryDailyLimitPlanKey({ name: "Лето.Падел.РА" }),
    "ra",
  );
});

test("maps subscription products to allowed daily categories", () => {
  const friendship = { name: "Лето.Падел.Дружба" };
  const sport = { name: "Лето.Падел.Спорт" };
  const academy = { name: "Лето.Падел.Академия" };
  const ra = { name: "РА" };

  assert.equal(subscriptionPlanAllowsDailyLimitCategory(friendship, SUBSCRIPTION_CATEGORY_LIMIT_OPEN_GAME), true);
  assert.equal(subscriptionPlanAllowsDailyLimitCategory(friendship, SUBSCRIPTION_CATEGORY_LIMIT_TOURNAMENT), false);

  assert.equal(subscriptionPlanAllowsDailyLimitCategory(sport, SUBSCRIPTION_CATEGORY_LIMIT_OPEN_GAME), true);
  assert.equal(subscriptionPlanAllowsDailyLimitCategory(sport, SUBSCRIPTION_CATEGORY_LIMIT_TOURNAMENT), true);
  assert.equal(subscriptionPlanAllowsDailyLimitCategory(sport, SUBSCRIPTION_CATEGORY_LIMIT_GROUP_TRAINING), false);

  assert.equal(subscriptionPlanAllowsDailyLimitCategory(academy, SUBSCRIPTION_CATEGORY_LIMIT_OPEN_GAME), true);
  assert.equal(subscriptionPlanAllowsDailyLimitCategory(academy, SUBSCRIPTION_CATEGORY_LIMIT_GROUP_TRAINING), true);
  assert.equal(subscriptionPlanAllowsDailyLimitCategory(academy, SUBSCRIPTION_CATEGORY_LIMIT_TOURNAMENT), false);

  assert.equal(subscriptionPlanAllowsDailyLimitCategory(ra, SUBSCRIPTION_CATEGORY_LIMIT_OPEN_GAME), true);
  assert.equal(subscriptionPlanAllowsDailyLimitCategory(ra, SUBSCRIPTION_CATEGORY_LIMIT_GROUP_TRAINING), true);
  assert.equal(subscriptionPlanAllowsDailyLimitCategory(ra, SUBSCRIPTION_CATEGORY_LIMIT_TOURNAMENT), true);
});

test("recognizes client subscription when SERV2 resolved name is attached", () => {
  const rawClientSubscription = {
    subscriptionId: "97c895c6-0580-45ae-bec1-4c0f746d7fce",
    name: null,
    availableTypes: [{ id: 1613, name: "Открытая игра" }],
  };
  const resolved = withSubscriptionCategoryDailyLimitResolvedName(
    rawClientSubscription,
    "Лето.Падел.Спорт",
  );

  assert.equal(resolveSubscriptionCategoryDailyLimitPlanKey(rawClientSubscription), null);
  assert.equal(resolveSubscriptionCategoryDailyLimitPlanKey(resolved), "sport");
  assert.equal(subscriptionPlanAllowsDailyLimitCategory(resolved, SUBSCRIPTION_CATEGORY_LIMIT_OPEN_GAME), true);
  assert.equal(subscriptionPlanAllowsDailyLimitCategory(resolved, SUBSCRIPTION_CATEGORY_LIMIT_TOURNAMENT), true);
  assert.equal(subscriptionPlanAllowsDailyLimitCategory(resolved, SUBSCRIPTION_CATEGORY_LIMIT_GROUP_TRAINING), false);
});

test("classifies Viva exercise categories by stable type and direction ids", () => {
  assert.equal(
    resolveSubscriptionCategoryDailyLimitCategoryFromEvent({
      direction: { id: 4588, name: "Открытая игра" },
      type: { id: 1613, name: "Открытая игра" },
    }),
    SUBSCRIPTION_CATEGORY_LIMIT_OPEN_GAME,
  );
  assert.equal(
    resolveSubscriptionCategoryDailyLimitCategoryFromEvent({
      direction: { id: 3935, name: "Игра+Тренер. Уровень D" },
      type: { id: 847, name: "Игра+Тренер" },
    }),
    SUBSCRIPTION_CATEGORY_LIMIT_GROUP_TRAINING,
  );
  assert.equal(
    resolveSubscriptionCategoryDailyLimitCategoryFromEvent({
      direction: { id: 3686, name: "Групповая тренировка уровень D+" },
      type: { id: 605, name: "Падел групповая тренировка" },
    }),
    SUBSCRIPTION_CATEGORY_LIMIT_GROUP_TRAINING,
  );
  assert.equal(
    resolveSubscriptionCategoryDailyLimitCategoryFromEvent({
      direction: { id: 2617, name: "Падел турнир от ПадлхАБ" },
      type: { id: 839, name: "Падел Турнир" },
    }),
    SUBSCRIPTION_CATEGORY_LIMIT_TOURNAMENT,
  );
  assert.equal(
    resolveSubscriptionCategoryDailyLimitCategoryFromEvent({
      direction: { id: 3284, name: "Турнир особый от ПадлхАБ" },
      type: { id: 1013, name: "Падел Турнир (Особый)" },
    }),
    SUBSCRIPTION_CATEGORY_LIMIT_TOURNAMENT,
  );
  assert.equal(
    resolveSubscriptionCategoryDailyLimitCategoryFromEvent({
      direction: { id: 9001, name: "Аренда корта" },
      type: { id: 9002, name: "Падел — аренда" },
    }),
    null,
  );
});

test("blocks the same tracked subscription only within the same category and date", () => {
  const bookings = [
    {
      id: "booking-open-game",
      paymentType: "SUBSCRIPTION",
      clientSubscriptionId: "client-sub-sport-1",
      exercise: {
        id: "exercise-open-game",
        timeFrom: "2026-07-03T10:00:00+03:00",
        timeTo: "2026-07-03T11:00:00+03:00",
        direction: { id: 4588, name: "Открытая игра" },
        type: { id: 1613, name: "Открытая игра" },
        studio: { name: "Терехово" },
      },
    },
    {
      id: "booking-tournament",
      paymentType: "SUBSCRIPTION",
      clientSubscriptionId: "client-sub-sport-1",
      exercise: {
        id: "exercise-tournament",
        timeFrom: "2026-07-03T19:00:00+03:00",
        timeTo: "2026-07-03T21:00:00+03:00",
        direction: { id: 2617, name: "Падел турнир от ПадлхАБ" },
        type: { id: 839, name: "Падел Турнир" },
        studio: { name: "Нагатинская" },
      },
    },
    {
      id: "booking-open-game-other-sub",
      paymentType: "SUBSCRIPTION",
      clientSubscriptionId: "client-sub-ra-1",
      exercise: {
        id: "exercise-open-game-ra",
        timeFrom: "2026-07-03T12:00:00+03:00",
        timeTo: "2026-07-03T13:00:00+03:00",
        direction: { id: 4588, name: "Открытая игра" },
        type: { id: 1613, name: "Открытая игра" },
      },
    },
  ];

  const sameCategoryConflict = resolveSubscriptionCategoryDailyLimitConflictFromBookings(bookings, {
    targetDate: "2026-07-03",
    category: SUBSCRIPTION_CATEGORY_LIMIT_OPEN_GAME,
    currentSubscription: { name: "Лето.Падел.Спорт" },
    currentClientSubscriptionId: "client-sub-sport-1",
  });
  assert.equal(sameCategoryConflict?.code, SUBSCRIPTION_CATEGORY_DAILY_LIMIT_CODE);
  assert.equal(sameCategoryConflict?.existingEvent.exerciseId, "exercise-open-game");

  const allowedOtherCategory = resolveSubscriptionCategoryDailyLimitConflictFromBookings(bookings, {
    targetDate: "2026-07-03",
    category: SUBSCRIPTION_CATEGORY_LIMIT_TOURNAMENT,
    currentSubscription: { name: "Лето.Падел.Спорт" },
    currentClientSubscriptionId: "client-sub-ra-1",
  });
  assert.equal(allowedOtherCategory, null);

  const nextDay = resolveSubscriptionCategoryDailyLimitConflictFromBookings(bookings, {
    targetDate: "2026-07-04",
    category: SUBSCRIPTION_CATEGORY_LIMIT_OPEN_GAME,
    currentSubscription: { name: "Лето.Падел.Спорт" },
    currentClientSubscriptionId: "client-sub-sport-1",
  });
  assert.equal(nextDay, null);
});

test("does not apply group or tournament limits to products that do not include them", () => {
  const bookings = [
    {
      id: "booking-group",
      paymentType: "SUBSCRIPTION",
      clientSubscriptionId: "client-sub-friendship-1",
      exercise: {
        id: "exercise-group",
        timeFrom: "2026-07-03T09:00:00+03:00",
        direction: { id: 3685, name: "Групповая тренировка уровень D" },
        type: { id: 605, name: "Падел групповая тренировка" },
      },
    },
  ];

  assert.equal(
    resolveSubscriptionCategoryDailyLimitConflictFromBookings(bookings, {
      targetDate: "2026-07-03",
      category: SUBSCRIPTION_CATEGORY_LIMIT_GROUP_TRAINING,
      currentSubscription: { name: "Лето.Падел.Дружба" },
      currentClientSubscriptionId: "client-sub-friendship-1",
    }),
    null,
  );
});

test("maps category daily limit api errors back to user-facing messages", () => {
  const conflict = resolveSubscriptionCategoryDailyLimitConflictFromBookings([
    {
      id: "booking-group",
      paymentType: "SUBSCRIPTION",
      clientSubscriptionId: "client-sub-ra-1",
      exercise: {
        id: "exercise-group",
        timeFrom: "2026-07-03T09:00:00+03:00",
        timeTo: "2026-07-03T10:00:00+03:00",
        direction: { id: 3935, name: "Игра+Тренер. Уровень D" },
        type: { id: 847, name: "Игра+Тренер" },
        studio: { name: "Сколково" },
      },
    },
  ], {
    targetDate: "2026-07-03",
    category: SUBSCRIPTION_CATEGORY_LIMIT_GROUP_TRAINING,
    currentSubscription: { name: "РА" },
    currentClientSubscriptionId: "client-sub-ra-1",
  });

  assert.ok(conflict);
  const message = resolveSubscriptionCategoryDailyLimitErrorMessage(
    buildSubscriptionCategoryDailyLimitApiError(conflict),
  );
  assert.match(message ?? "", /Вам доступно использование абонемента на одно событие данной категории/);
  assert.match(message ?? "", /у вас уже есть Групповая тренировка: Игра\+Тренер/);
  assert.match(message ?? "", /на станции Сколково в 09:00-10:00 на 03\.07\.2026/);
});
