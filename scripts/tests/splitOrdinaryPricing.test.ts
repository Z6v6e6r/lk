import test from "node:test";
import assert from "node:assert/strict";
import {
  buildSplitOrdinaryPrice,
  hasCanonicalSplitSharePrice,
  normalizeSplitShareCount,
  resolveSplitDisplayShareAmount,
  resolveSplitJoinShareCount,
  resolveSplitOrdinaryPriceContract,
} from "../../src/components/games/splitOrdinaryPricing.ts";

// Shape of the live record pay_1fb78942-4348-4cda-95cd-93634d335a60: a participant
// join materialized the split metadata without any server-derived court total.
const nominalSplitPayment = {
  enabled: true,
  status: "ACTIVE",
  shareCount: 4,
  shareAmount: 2500,
  bookingIds: ["b738d412-f3d2-4f5f-b6b1-ccf31327192d"],
  payments: [{ role: "PARTICIPANT", status: "LEFT", amount: 1000 }],
};

const canonicalSplitPayment = {
  ...nominalSplitPayment,
  shareAmount: 1000,
  totalAmount: 4000,
  pricingPolicy: null,
};

test("a nominal split share without a server-derived total is not canonical", () => {
  assert.equal(hasCanonicalSplitSharePrice(nominalSplitPayment), false);
  assert.equal(hasCanonicalSplitSharePrice(null), false);
  assert.equal(hasCanonicalSplitSharePrice({ shareAmount: 2500, totalAmount: 0 }), false);
  assert.equal(hasCanonicalSplitSharePrice({ shareAmount: 2500, totalAmount: "0" }), false);
});

test("an exact court total or a valid pricing-policy snapshot makes the stored share canonical", () => {
  assert.equal(hasCanonicalSplitSharePrice(canonicalSplitPayment), true);
  assert.equal(hasCanonicalSplitSharePrice({ shareAmount: 250, totalAmount: "4000" }), true);
  assert.equal(hasCanonicalSplitSharePrice({
    shareAmount: 250,
    pricingPolicy: {
      id: "piter-split-250-per-hour-v1",
      pricingMode: "PER_PARTICIPANT_HOUR",
      currency: "RUB",
      twoTeamsHourlyAmount: 500,
      fourPlayersHourlyAmount: 250,
    },
  }), true);
  // A malformed or empty snapshot is not a canonical price: the server fails such
  // a record closed, and the client must not treat the stored share as proven.
  for (const pricingPolicy of [{}, { id: "piter" }, null, "policy", []]) {
    assert.equal(hasCanonicalSplitSharePrice({ shareAmount: 250, pricingPolicy }), false);
  }
});

test("the join share count follows the server coercion of two versus four players", () => {
  assert.equal(resolveSplitJoinShareCount(2, 4), 2);
  assert.equal(resolveSplitJoinShareCount("2", 10), 2);
  assert.equal(resolveSplitJoinShareCount(4, 2), 2);
  assert.equal(resolveSplitJoinShareCount(4, 4), 4);
  assert.equal(resolveSplitJoinShareCount(3, 4), 4);
  assert.equal(resolveSplitJoinShareCount(null, 4), 4);
  assert.equal(resolveSplitJoinShareCount(undefined, 0), 4);
  assert.equal(resolveSplitJoinShareCount(0, 2), 2);
});

test("ordinary share is the exact court price divided by the share count", () => {
  assert.deepEqual(buildSplitOrdinaryPrice(4000, 4), { totalAmount: 4000, shareAmount: 1000 });
  assert.deepEqual(buildSplitOrdinaryPrice(8000, 4), { totalAmount: 8000, shareAmount: 2000 });
  assert.deepEqual(buildSplitOrdinaryPrice(4000, 2), { totalAmount: 4000, shareAmount: 2000 });
  assert.deepEqual(buildSplitOrdinaryPrice(2000.5, 4), { totalAmount: 2000.5, shareAmount: 500.13 });
});

test("ordinary share stays unresolved without a positive exact court price", () => {
  for (const price of [0, -1, null, undefined, "", "abc", NaN]) {
    assert.equal(buildSplitOrdinaryPrice(price, 4), null);
  }
  assert.equal(normalizeSplitShareCount(0), 4);
  assert.equal(normalizeSplitShareCount("2"), 2);
});

test("the exact-price contract mirrors the server guard and needs master service and sub-services", () => {
  const booking = {
    studioId: "studio-piter",
    roomId: "court-8",
    masterServiceId: "service-1",
    subServiceIds: ["sub-1"],
    date: "2026-09-11",
    timeFrom: "21:30",
    timeTo: "22:30",
  };
  assert.deepEqual(
    resolveSplitOrdinaryPriceContract({ booking, metadata: null, shareCount: 4 }),
    {
      studioId: "studio-piter",
      roomId: "court-8",
      masterServiceId: "service-1",
      subServiceIds: ["sub-1"],
      date: "2026-09-11",
      fromTime: "21:30",
      toTime: "22:30",
      shareCount: 4,
    },
  );
  for (const incomplete of [
    { booking: { ...booking, masterServiceId: null }, metadata: null },
    { booking: { ...booking, subServiceIds: [] }, metadata: null },
    { booking: { ...booking, roomId: null }, metadata: null },
    { booking: { ...booking, date: null }, metadata: null },
  ]) {
    assert.equal(resolveSplitOrdinaryPriceContract({ ...incomplete, shareCount: 4 }), null);
  }
});

test("the ordinary court share outranks the legacy nominal stored share", () => {
  const precedence = (params: {
    promoShareAmount?: number | null;
    ordinaryShareAmount?: number | null;
    ordinaryStatus?: "pending" | "resolved" | "failed" | "unavailable";
    storedShareAmount?: number | null;
    storedIsCanonical?: boolean;
  }) => resolveSplitDisplayShareAmount({
    promoShareAmount: params.promoShareAmount ?? null,
    ordinaryShareAmount: params.ordinaryShareAmount ?? null,
    ordinaryStatus: params.ordinaryStatus ?? "unavailable",
    storedShareAmount: params.storedShareAmount ?? null,
    storedIsCanonical: params.storedIsCanonical ?? false,
  });

  // Campaign price wins for subscription-created games.
  assert.equal(precedence({ promoShareAmount: 250, ordinaryShareAmount: 1000, storedShareAmount: 2500 }), 250);
  // Exact court share wins over the nominal 2500 fallback.
  assert.equal(precedence({ ordinaryShareAmount: 1000, storedShareAmount: 2500 }), 1000);
  // Canonical stored share is kept as-is when the game does not need re-pricing.
  assert.equal(precedence({ storedShareAmount: 1000, storedIsCanonical: true }), 1000);
  // A pending, impossible or unauthorized lookup never re-quotes the nominal fallback.
  for (const ordinaryStatus of ["pending", "unavailable"] as const) {
    assert.equal(precedence({ storedShareAmount: 2500, ordinaryStatus }), null);
  }
  // Legacy fail-open: keep the stored share only after a real lookup returned no price.
  assert.equal(precedence({ storedShareAmount: 2500, ordinaryStatus: "failed" }), 2500);
  assert.equal(precedence({}), null);
});
