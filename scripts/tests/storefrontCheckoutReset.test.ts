import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs';
import { hasVerifiedCheckoutReset } from '../../src/components/subscription-storefront/zeroCheckoutCustody.ts';
import { patchCheckoutResetBody, resetReceiptBlock } from '../patch_storefront_checkout_reset.mjs';
import { createHash } from 'node:crypto';
const ref = 'zero-00000000-0000-4000-8000-000000000001';
const tx = '00000000-0000-4000-8000-000000000002';
const reset = { version: 1, state: 'PROVIDER_EXPIRED_UNPAID', operationId: '00000000-0000-4000-8000-000000000003', paymentRef: ref, transactionId: tx, closureKind: 'PROVIDER_CARD_EXPIRED_UNPAID', terminalCardStatus: 'REJECTED', declineOutcome: 'EXPIRED', paymentIdSha256: 'a'.repeat(64), paymentUrlSha256: 'b'.repeat(64), expireAcknowledged: false, verifiedAt: '2026-11-01T00:00:00Z' };
const response = { paymentRef: ref, transactionId: tx, counterKey: 'friendship', status: 'FAILED', failed: true, paid: false, paymentUrl: null, checkoutReset: reset };
test('only explicit exact verified reset receipts release a failed unpaid attempt', () => {
  assert.equal(hasVerifiedCheckoutReset(response, ref, 'friendship'), true);
  for (const update of [{ paid: true }, { status: 'PENDING' }, { paymentRef: 'foreign' }, { counterKey: 'ra' }, { paymentUrl: 'https://bank.example/active' }, { checkoutReset: null }, { transactionId: 'foreign' }]) assert.equal(hasVerifiedCheckoutReset({ ...response, ...update }, ref, 'friendship'), false);
  for (const update of [{ version: 2 }, { declineOutcome: 'DECLINED' }, { terminalCardStatus: 'PAID' }, { closureKind: 'EXPIRE_ACK' }, { paymentUrlSha256: '' }, { expireAcknowledged: true }, { state: 'PAYMENT_LINK_EXPIRED' }, { paymentRef: 'foreign' }, { verifiedAt: '2999-01-01T00:00:00Z' }, { operationId: 'missing' }]) assert.equal(hasVerifiedCheckoutReset({ ...response, checkoutReset: { ...reset, ...update } }, ref, 'friendship'), false);
});
test('owning confirm emits reset proof only for the exact closed, unissued record', () => {
  const source = fs.readFileSync(new URL('../nodered_games_nodes/fn_tournament_subscription_confirm_resolve.js', import.meta.url), 'utf8');
  const run = (changes = {}) => new Function('msg', 'global', 'env', 'node', source)({ payload: [{ paymentRef: ref, transactionId: tx, counterKey: 'friendship', status: 'FAILED', checkoutReset: reset, ...changes }], _summerSubscriptionCtx: { action: 'confirm', paymentRef: ref, counterKey: 'friendship' } }, { get: () => undefined }, { get: () => undefined }, {});
  const output = run(); assert.equal(hasVerifiedCheckoutReset(output[1].payload, ref, 'friendship'), true);
  for (const changes of [{ status: 'PAID' }, { paidAt: '2026-11-01T00:00:00Z' }, { clientSubscriptionId: 'issued' }, { checkoutReset: { ...reset, transactionId: 'foreign' } }, { checkoutReset: { ...reset, expireAcknowledged: true } }]) {
    const result = run(changes); assert.equal(result[1]?.payload?.checkoutReset, undefined);
  }
});
test('source-driven patch preserves foreign code and rejects every changed preimage', () => {
  const before = 'const record = {};\n// All selected confirmations pass the durable admission gate before provider I/O.\nreturn msg;';
  const hash = createHash('sha256').update(before).digest('hex');
  const after = patchCheckoutResetBody(before, hash);
  assert.equal(after.replace(resetReceiptBlock(), ''), before);
  assert.throws(() => patchCheckoutResetBody(before + '\n', hash));
  assert.throws(() => patchCheckoutResetBody(after, hash));
});
