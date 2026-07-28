import test from "node:test";
import assert from "node:assert/strict";
import {
  buildSplitComparableIdSet,
  filterSplitCategoryCompatibleSubscriptions,
  filterSplitEligibleSubscriptions,
  isNoSubscriptionsAvailableError,
  isSplitSubscriptionValidForGameDate,
  resolveSplitSubscriptionUnavailableMessage,
} from "../../src/components/games/splitSubscriptionAvailability.ts";

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
