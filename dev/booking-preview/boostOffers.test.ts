import test from 'node:test';
import assert from 'node:assert/strict';
import { boostPurchaseOption, boostBenefits } from './boostOffers.ts';
import { createPreviewOrder, readBoostPrice } from './bookingCheckout.ts';
import { type PaymentContext, type Privileges } from './paymentMatrix.ts';

const resident: Privileges = { residency: true, subscription: false, pass: false };
const subscriber: Privileges = { residency: false, subscription: true, pass: false };
const fits = { subscription: true, pass: false };
const context: PaymentContext = { subscriptionPlan: 'ra', dailyQuota: 'available', dailyUsage: 'none', durationMinutes: 90, excludedGroups: false, raFits: true };

test('Boost purchase requires an owned base, full stage and missing Boost', () => {
  assert.equal(boostPurchaseOption('training', { ...resident, residency: false }, fits, context, 'full'), undefined);
  assert.equal(boostPurchaseOption('training', resident, fits, context, 'current'), undefined);
  assert.equal(boostPurchaseOption('training', resident, fits, { ...context, boost: true }, 'full'), undefined);
  const offer = boostPurchaseOption('training', resident, fits, context, 'full')!;
  assert.equal(offer.mode, 'offer'); assert.equal(offer.kind, 'boost'); assert.equal(offer.amount, 0);
  assert.equal(offer.withResidency, true); assert.equal(offer.withSubscription, undefined);
  assert.equal(createPreviewOrder(offer), null, 'Free participation cannot bypass purchasing the missing Boost');
  assert.deepEqual(createPreviewOrder(offer, null, null, 8800), { method: 'boost', bookingAmount: 0, product: 'boost', productAmount: 8800, total: 8800 });
});

test('Boost event copay follows actual game duration; base product is never purchased again', () => {
  for (const [durationMinutes, courtAmount, bookingAmount] of [[60, 4000, 0], [90, 6000, 350], [120, 8000, 700]] as const) {
    const offer = boostPurchaseOption('game', resident, fits, { ...context, durationMinutes }, 'full', 'quarter', courtAmount)!;
    assert.equal(offer.amount, bookingAmount);
    assert.deepEqual(createPreviewOrder(offer, 790, 23800, 8800), { method: 'boost', bookingAmount, product: 'boost', productAmount: 8800, total: 8800 + bookingAmount });
  }
  assert.equal(boostPurchaseOption('game', resident, fits, context, 'full', 'court', 6000), undefined);
  assert.equal(boostPurchaseOption('game', resident, fits, context, 'full', 'quarter', null), undefined);
});

test('subscription-backed Boost is one combined offer only when it adds an event benefit', () => {
  assert.equal(boostPurchaseOption('training', subscriber, fits, context, 'full'), undefined, 'RA already covers this event');
  const afterGame = boostPurchaseOption('training', subscriber, fits, { ...context, dailyQuota: 'used', dailyUsage: 'game-hour' }, 'full')!;
  assert.equal(afterGame.withSubscription, true); assert.equal(afterGame.withResidency, undefined); assert.equal(afterGame.amount, 0);
  const friendship = boostPurchaseOption('training', subscriber, fits, { ...context, subscriptionPlan: 'friendship' }, 'full')!;
  assert.equal(friendship.amount, 0);
  assert.equal(boostPurchaseOption('game', subscriber, fits, { ...context, subscriptionPlan: 'friendship-2' }, 'full', 'quarter', 6000), undefined);
  const usedResident = boostPurchaseOption('training', resident, fits, { ...context, dailyQuota: 'used', dailyUsage: 'training' }, 'full');
  assert.equal(usedResident, undefined, 'Do not offer to buy Boost for the same exhausted-limit price');
});

test('PRO, exclusions and active/daily limits retain the established Boost rules', () => {
  assert.equal(boostPurchaseOption('training', resident, fits, { ...context, proDirection: true }, 'full'), undefined);
  assert.equal(boostPurchaseOption('training', subscriber, fits, { ...context, subscriptionPlan: 'friendship', proDirection: true }, 'full'), undefined);
  const pro = boostPurchaseOption('training', subscriber, fits, { ...context, proDirection: true }, 'full')!;
  assert.equal(pro.amount, 0);
  assert.equal(boostPurchaseOption('training', subscriber, fits, { ...context, proDirection: true, proQuotaUsed: true }, 'full'), undefined);
  assert.equal(boostPurchaseOption('training', subscriber, fits, { ...context, proDirection: true, activeLimitExceeded: true }, 'full'), undefined);
  assert.equal(boostPurchaseOption('training', resident, fits, { ...context, excludedGroups: true }, 'full'), undefined);
  assert.equal(boostPurchaseOption('training', subscriber, fits, { ...context, dailyQuota: 'used', dailyUsage: 'two-events' }, 'full'), undefined);
});

test('Boost price is a validated setting and owned Boost pays for participation only', () => {
  assert.equal(readBoostPrice(new URLSearchParams()), 8800);
  assert.equal(readBoostPrice(new URLSearchParams('boostPrice=12000.50')), 12000.5);
  const offer = boostPurchaseOption('training', resident, fits, context, 'full')!;
  for (const value of ['', '0', '-1', 'no', 'Infinity', '0.001']) assert.equal(readBoostPrice(new URLSearchParams({ boostPrice: value })), null);
  for (const price of [null, 0, -1, NaN, Infinity, Number.MAX_VALUE]) assert.equal(createPreviewOrder(offer, null, null, price), null);
  assert.deepEqual(createPreviewOrder({ ...offer, mode: 'book', amount: 350 }, null, null, 8800), { method: 'boost', bookingAmount: 350, product: null, productAmount: 0, total: 350 });
  assert.equal(createPreviewOrder({ ...offer, amount: 0.1 }, null, null, 0.2)?.total, 0.3);
});

test('offer benefits describe the owned base without granting Residency PRO access', () => {
  assert.ok(boostBenefits(resident, 'ra').some(line => line.includes('ПРО не входит')));
  assert.ok(boostBenefits(subscriber, 'friendship').some(line => line.includes('ПРО не входит')));
  for (const plan of ['ra', 'friendship-2'] as const) assert.ok(boostBenefits(subscriber, plan).some(line => line.includes('общий дневной лимит')));
});
