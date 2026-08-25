import test from "node:test";
import assert from "node:assert/strict";
import type { PadelSplitPaymentPromoConfig } from "../../src/utils/apiClient.ts";
import { resolveSplitPromoShareAmount } from "../../src/components/games/splitPromoPricing.ts";

const piterPromo: PadelSplitPaymentPromoConfig = {
  id: "piter-split-250-per-hour-v1",
  enabled: true,
  activeFrom: "2026-08-20",
  activeTo: "2026-09-07",
  stationIds: ["studio-piter"],
  stationNameIncludes: [],
  roomIds: [],
  roomNameIncludes: [],
  shareAmounts: { twoTeams: 500, fourPlayers: 250 },
  baseShareAmount: 250,
  pricingMode: "PER_PARTICIPANT_HOUR",
  currency: "RUB",
  vivaDirectionId: 4588,
  vivaExerciseTypeId: 1613,
};

const config: PadelSplitPaymentPromoConfig = {
  enabled: false,
  stationIds: [],
  stationNameIncludes: [],
  roomIds: [],
  roomNameIncludes: [],
  shareAmounts: { twoTeams: 500, fourPlayers: 250 },
  baseShareAmount: 250,
  pricingMode: "PER_PARTICIPANT_HOUR",
  currency: "RUB",
  vivaDirectionId: 4588,
  vivaExerciseTypeId: 1613,
  promos: [piterPromo],
};

test("resolves the nested Piter campaign for a 90-minute subscription-created game", () => {
  const amount = resolveSplitPromoShareAmount({
    config,
    date: "2026-08-24",
    studioId: "studio-piter",
    studioName: "Питер",
    roomId: "court-1",
    roomName: "Корт №1",
    shareCount: 4,
    durationMinutes: 90,
  });
  assert.equal(amount, 375);
});

test("keeps the Piter campaign active through September 7 inclusive", () => {
  const amount = resolveSplitPromoShareAmount({
    config,
    date: "2026-09-07",
    studioId: "studio-piter",
    studioName: "Питер",
    roomId: "court-1",
    roomName: "Корт №1",
    shareCount: 4,
    durationMinutes: 60,
  });
  assert.equal(amount, 250);
});

test("does not apply the Piter campaign to another station or outside its dates", () => {
  for (const selection of [
    { date: "2026-08-24", studioId: "studio-moscow" },
    { date: "2026-08-19", studioId: "studio-piter" },
    { date: "2026-09-08", studioId: "studio-piter" },
  ]) {
    assert.equal(resolveSplitPromoShareAmount({
      config,
      date: selection.date,
      studioId: selection.studioId,
      studioName: null,
      roomId: "court-1",
      roomName: "Корт №1",
      shareCount: 4,
      durationMinutes: 90,
    }), null);
  }
});
