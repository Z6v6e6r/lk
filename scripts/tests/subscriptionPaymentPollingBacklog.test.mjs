// Contract of the stale payment-polling backlog closure (2026-09-17).
//
// The script rewrites checkout-polling metadata of 2 000+ live sale records, so its
// reviewed shape matters: dry run by default, a receipt for every run, compare-and-swap
// on the exact preimage it read, and no financial field touched.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';
import { createSubscriptionPaymentPolling } from '../lib/subscriptionPaymentPolling.mjs';

const source = fs.readFileSync(new URL('../close_subscription_payment_polling_backlog.mjs', import.meta.url), 'utf8');

test('the closure script is dry-run by default and needs an explicit receipt', () => {
  assert.ok(source.includes("const APPLY = flag('--apply');"));
  assert.ok(source.includes("if (!flowsPath || !reportPath)"));
  assert.ok(source.includes('fs.writeFileSync(reportPath'));
  assert.ok(source.includes('dryRun: !APPLY'));
});

test('the closure touches only checkout-polling metadata', () => {
  const update = source.slice(source.indexOf('$set: {'), source.indexOf('$set: {') + 400);
  assert.ok(update.includes("'paymentPolling.recoveryClosedAt': nowIso"));
  assert.ok(update.includes("'paymentPolling.recoveryClosedReason': 'RECOVERY_CHECK_LIMIT'"));
  assert.ok(update.includes("'paymentPolling.nextCheckAt': null"));
  // No top-level financial or lifecycle field may be written by this operation.
  for (const forbidden of ["status: 'PAID'", "status: 'FAILED'", 'paidAt', 'transactionId:', 'amountMinor', 'toPayMinor', 'expiresAt:']) {
    assert.equal(update.includes(forbidden), false, `the closure must not write ${forbidden}`);
  }
});

test('the closure selects only rows past the reviewed recovery bound', () => {
  const { maxRecoveryChecks } = createSubscriptionPaymentPolling();
  assert.equal(maxRecoveryChecks, 24);
  assert.ok(source.includes("'paymentPolling.recoveryChecks': { $gte: maxRecoveryChecks }"));
  assert.ok(source.includes("'paymentPolling.recoveryClosedAt': { $exists: false }"));
  assert.ok(source.includes("status: 'PAYMENT_PENDING'"));
  assert.ok(source.includes("'paymentPolling.status': 'FAILED'"));
  // The compare-and-swap pins the preimage the script actually read.
  assert.ok(source.includes("'paymentPolling.recoveryChecks': row.paymentPolling?.recoveryChecks"));
  assert.ok(source.includes('if (result.modifiedCount === 1) report.applied += 1'));
});

test('the closure records a postcheck of the financial state', () => {
  assert.ok(source.includes('paidWithClosedPolling'));
  assert.ok(source.includes('schedulableInFuture'));
  assert.ok(source.includes('closedForPolling'));
  assert.ok(source.includes('preimages: selected.slice(0, 200)'));
});
