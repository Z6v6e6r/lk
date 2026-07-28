import test from "node:test";
import assert from "node:assert/strict";
import {
  applyTournamentCustomPricingToEnergyProduct,
  buildTournamentCustomEnergyDiscountReason,
  buildTournamentCustomEnergyProduct,
  buildTournamentVivaTransactionProductPayload,
  resolveTournamentCustomPricing,
  toTournamentRubMinorAmount,
} from "../../src/utils/tournamentCustomPricing.ts";

test("custom tournament energy product uses skin price as server checkout price", () => {
  const pricing = resolveTournamentCustomPricing([{ skin: { priceLabel: "2 500 ₽" } }]);
  assert.deepEqual(pricing, {
    priceLabel: "2 500 ₽",
    amount: 2500,
    baseAmount: 20000,
    discountAmount: 17500,
    productName: "Энергия турниры",
  });

  const syntheticProduct = buildTournamentCustomEnergyProduct(pricing);
  assert.equal(syntheticProduct.id, "custom-tournament-energy");
  assert.equal(syntheticProduct.name, "Энергия турниры");
  assert.equal(syntheticProduct.source, "custom-tournament-energy");
  assert.equal(syntheticProduct.cost, 250000);
  assert.equal(syntheticProduct.priceLabel, "2 500 ₽");
  assert.equal(syntheticProduct.baseAmount, 20000);
  assert.equal(syntheticProduct.discountAmount, 17500);
  assert.equal(syntheticProduct.targetAmount, 2500);
  assert.equal(toTournamentRubMinorAmount(pricing.discountAmount), 1750000);
  assert.equal(
    buildTournamentCustomEnergyDiscountReason("Padel League", "09.05.2026"),
    "Участие в турнире «Padel League» 09.05.2026",
  );
});

test("legacy visible Viva energy product can still carry a discount payload", () => {
  const pricing = resolveTournamentCustomPricing([{ skin: { priceLabel: "2 500 ₽" } }]);
  assert.ok(pricing);
  const product = applyTournamentCustomPricingToEnergyProduct([
    {
      id: "energy-tournaments",
      name: "Энергия турниры",
      type: "SUBSCRIPTION",
      cost: 2000000,
    },
  ], pricing);

  assert.ok(product);
  assert.equal(product.priceLabel, "2 500 ₽");
  assert.equal(product.baseAmount, 20000);
  assert.equal(product.discountAmount, 17500);
  assert.equal(product.targetAmount, 2500);

  const transactionProduct = buildTournamentVivaTransactionProductPayload(product, "tournament-1");
  assert.equal(transactionProduct.discountAmount, 17500);
  assert.deepEqual(transactionProduct.bookingRequests, [
    {
      exerciseId: "tournament-1",
      client: null,
      comment: null,
      marketingAttribution: {},
    },
  ]);
});
