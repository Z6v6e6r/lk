import test from "node:test";
import assert from "node:assert/strict";
import {
  buildSplitComparableIdSet,
  filterSplitCategoryCompatibleSubscriptions,
  filterSplitEligibleSubscriptions,
  isNoSubscriptionsAvailableError,
  isSplitSubscriptionValidForGameDate,
  resolveSplitSubscriptionLifecycle,
  resolveSplitSubscriptionUnavailableMessage,
} from "../../src/components/games/splitSubscriptionAvailability.ts";

const openGameCategory = {
  hasStudioLimitation: false,
  availableStudios: [],
  hasTypeLimitation: true,
  availableTypes: [{ id: "1613", name: "Открытая игра" }],
};

test("split subscription availability accepts subscriptions that cover the game date", () => {
  assert.equal(
    isSplitSubscriptionValidForGameDate(
      { expirationDate: "2026-06-22" },
      "2026-06-22",
    ),
    true,
  );
  assert.equal(
    isSplitSubscriptionValidForGameDate(
      { expirationDate: "2026-06-21" },
      "2026-06-22",
    ),
    false,
  );
});

test("split subscription unavailable message mentions the expiry date", () => {
  const message = resolveSplitSubscriptionUnavailableMessage({
    subscriptions: [
      {
        subscriptionId: "sub-1",
        name: "Лето",
        status: "ACTIVE",
        expirationDate: "2026-06-21",
        visitsLeft: 4,
        availableMinutes: null,
      },
    ],
    gameDate: "2026-06-22",
    requiredVisits: 1,
    requiredDurationMinutes: 60,
  });

  assert.equal(
    message,
    "Вы не можете вступить в данную игру: ваша подписка действует до 21.06.2026, а игра запланирована на 22.06.2026.",
  );
});

test("split subscription error matcher recognizes Viva no-subscription payloads", () => {
  assert.equal(
    isNoSubscriptionsAvailableError({
      status: 400,
      message: "Ошибка запроса (400)",
      raw: {
        error: "Viva request failed",
        details: {
          code: "BAD_REQUEST",
          message: "No subscriptions available",
        },
      },
    }),
    true,
  );
});

test("split subscription filters ignore active unrelated subscriptions and keep matching expired ones for messaging", () => {
  const subscriptions = [
    {
      subscriptionId: "sub-active-other",
      name: "Тренировки",
      status: "ACTIVE",
      expirationDate: "2026-07-01",
      visitsLeft: 8,
      availableMinutes: null,
      hasStudioLimitation: false,
      availableStudios: [],
      hasTypeLimitation: true,
      availableTypes: [{ id: "9999", name: "Тренировка" }],
    },
    {
      subscriptionId: "sub-expired-open-game",
      name: "Открытая игра",
      status: "ACTIVE",
      expirationDate: "2026-06-21",
      visitsLeft: 4,
      availableMinutes: null,
      hasStudioLimitation: false,
      availableStudios: [],
      hasTypeLimitation: true,
      availableTypes: [{ id: "1613", name: "Открытая игра" }],
    },
  ];
  const requiredExerciseTypeIds = buildSplitComparableIdSet(["1613"]);
  const requiredDirectionIds = buildSplitComparableIdSet(["4588"]);

  const compatible = filterSplitCategoryCompatibleSubscriptions(
    subscriptions,
    requiredExerciseTypeIds,
    requiredDirectionIds,
    "studio-1",
  );
  const eligible = filterSplitEligibleSubscriptions(
    subscriptions,
    requiredExerciseTypeIds,
    requiredDirectionIds,
    "studio-1",
    1,
    60,
    "2026-06-22",
  );

  assert.deepEqual(
    compatible.map((item) => item.subscriptionId),
    ["sub-expired-open-game"],
  );
  assert.deepEqual(eligible, []);
  assert.equal(
    resolveSplitSubscriptionUnavailableMessage({
      subscriptions: compatible,
      gameDate: "2026-06-22",
      requiredVisits: 1,
      requiredDurationMinutes: 60,
    }),
    "Вы не можете вступить в данную игру: ваша подписка действует до 21.06.2026, а игра запланирована на 22.06.2026.",
  );
});

test("fresh NEW subscription remains eligible for first-use activation", () => {
  const subscriptions = [{
    subscriptionId: "sub-new",
    name: "Лето.Падел.Спорт",
    status: "NEW",
    purchaseDate: "2026-08-01T08:00:00",
    autoActivationDate: "2026-08-02",
    activationDate: null,
    expirationDate: null,
    visitsLeft: 30,
    availableMinutes: null,
    ...openGameCategory,
  }];

  assert.equal(resolveSplitSubscriptionLifecycle(subscriptions[0], "2026-08-01"), "NEW_FIRST_USE_CANDIDATE");
  assert.deepEqual(
    filterSplitEligibleSubscriptions(
      subscriptions,
      buildSplitComparableIdSet(["1613"]),
      buildSplitComparableIdSet(["4588"]),
      "studio-1",
      1,
      60,
      "2026-08-01",
    ).map((item) => item.subscriptionId),
    ["sub-new"],
  );
});

test("ACTIVE is preferred over NEW and unusable ACTIVE falls back to NEW", () => {
  const newSubscription = {
    subscriptionId: "sub-new",
    name: "New",
    status: "NEW",
    activationDate: null,
    expirationDate: null,
    visitsLeft: 30,
    availableMinutes: null,
    ...openGameCategory,
  };
  const activeSubscription = {
    subscriptionId: "sub-active",
    name: "Active",
    status: "ACTIVE",
    activationDate: "2026-07-01T08:30:00",
    expirationDate: "2026-08-15",
    visitsLeft: 5,
    availableMinutes: null,
    ...openGameCategory,
  };
  const filter = (subscriptions: Array<typeof newSubscription | typeof activeSubscription>) => (
    filterSplitEligibleSubscriptions(
      subscriptions,
      buildSplitComparableIdSet(["1613"]),
      buildSplitComparableIdSet(["4588"]),
      "studio-1",
      1,
      60,
      "2026-08-01",
    ).map((item) => item.subscriptionId)
  );

  assert.deepEqual(filter([newSubscription, activeSubscription]), ["sub-active", "sub-new"]);
  assert.deepEqual(filter([newSubscription, { ...activeSubscription, expirationDate: "2026-07-31" }]), ["sub-new"]);
});

test("unsupported and inconsistent lifecycle states stay fail-closed", () => {
  [
    "HOLD",
    "EXPIRED",
    "REFUNDED",
    "NO_VISITS",
    "INACTIVE",
    "ACTIVATED",
    "DEACTIVATED",
    "NOT_ACTIVATED",
    "REACTIVATED",
    "UNKNOWN_STATE",
    null,
  ].forEach((status) => {
    assert.equal(resolveSplitSubscriptionLifecycle({
      subscriptionId: `sub-${status}`,
      name: "Unavailable",
      status,
      purchaseDate: "2026-08-01T08:00:00",
      autoActivationDate: "2026-08-02",
      activationDate: null,
      expirationDate: "2026-09-01",
      visitsLeft: 30,
      availableMinutes: null,
    }, "2026-08-01"), "UNAVAILABLE", String(status));
  });

  assert.equal(resolveSplitSubscriptionLifecycle({
    subscriptionId: "sub-new-activated",
    name: "Inconsistent NEW",
    status: "NEW",
    activationDate: "2026-08-01T08:30:00",
    expirationDate: "2026-09-01",
    visitsLeft: 30,
    availableMinutes: null,
  }, "2026-08-01"), "UNAVAILABLE");
});
