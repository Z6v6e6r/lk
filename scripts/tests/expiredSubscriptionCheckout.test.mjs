import assert from 'node:assert/strict';
import test from 'node:test';
import { expiredSubscriptionCheckoutReason as reason, expiredSubscriptionCheckoutUpdate as update } from '../lib/expiredSubscriptionCheckout.mjs';

const id = '00000000-0000-4000-8000-000000000001', product = '00000000-0000-4000-8000-000000000002';
const owner = '00000000-0000-4000-8000-000000000003', operation = '00000000-0000-4000-8000-000000000004';
const fixturePhone = '+' + '7' + '9' + '0'.repeat(9);
const otherPhone = fixturePhone.slice(0, -1) + '1';
const now = Date.parse('2026-11-16T08:00:00Z');
function fixture() {
  const sale = { _id: 'sale', status: 'PAYMENT_PENDING', paymentRef: 'zero-' + id, transactionId: id, counterKey: 'friendship',
    clientId: owner, clientPhone: fixturePhone, productId: product, amountMinor: 980000, toPayMinor: 980000, paymentUrl: 'https://pay.vivacrm.ru/test' };
  const transaction = { id, status: 'UNPAID', client: { id: owner, phone: fixturePhone },
    products: [{ id: product, type: 'SUBSCRIPTION', count: 1, cost: 980000, discount: 0, used: false, refunded: false }],
    sum: 980000, discount: 0, toPay: 980000, deposit: 0, paymentMethod: 'SMS', paymentLegs: [{ source: 'CARD_ONLINE', amountKopecks: 980000 }],
    cardPaymentInfo: { paymentId: id, paymentUrl: sale.paymentUrl, status: 'REJECTED', declineOutcome: 'EXPIRED', declineReason: 'OTHER', declineMessage: null },
    processingStatus: null, possibleDoublePayment: false, receiptPending: false,
    purchasedServices: [], receipts: [], executedSurcharges: [], paidByOtherSaleBookingIds: [], transactionRefunds: [],
    createDate: '2026-11-14T08:00:00Z', paymentDueDate: '2026-11-14T08:20:00Z' };
  return { sale, transaction };
}
test('exact closed, expired, entirely unpaid card produces the existing reset receipt contract', () => {
  const { sale, transaction } = fixture();
  assert.equal(reason(sale, transaction, now), null);
  const result = update(sale, transaction, operation, now);
  assert.equal(result.status, 'FAILED'); assert.equal(result.paymentUrl, null);
  assert.equal(result.checkoutReset.paymentRef, sale.paymentRef);
  assert.equal(result.checkoutReset.transactionId, id);
  assert.equal(result.checkoutReset.operationId, operation);
  assert.match(result.checkoutReset.paymentUrlSha256, /^[a-f0-9]{64}$/);
  assert.equal(JSON.stringify(result).includes(sale.clientPhone), false);
  assert.equal(reason({ ...sale, ...result }, transaction, now), 'SALE_NOT_PENDING');
});
test('phone-only local purchase binds the unanimous provider client and nullable unused flags', () => {
  const { sale, transaction } = fixture();
  sale.clientId = null;
  transaction.products[0].used = null;
  transaction.products[0].refunded = null;
  assert.equal(reason(sale, transaction, now), null);
  transaction.clientId = product;
  assert.equal(reason(sale, transaction, now), 'OWNER_MISMATCH');
});
test('paid, partial, refunded, issued, ambiguous, open, foreign and mismatched payments remain held', () => {
  const mutations = [
    (s) => { s.status = 'PAID'; }, (s) => { s.paidAt = '2026-11-14'; },
    (s) => { s.counterKey = 'network_friendship'; },
    (s, t) => { t.status = 'PAID'; }, (s, t) => { t.state = 'PAID'; },
    (s, t) => { t.uuid = product; }, (s, t) => { t.client.id = product; },
    (s, t) => { t.client.phone = otherPhone; }, (s, t) => { t.clientPhone = otherPhone; },
    (s, t) => { t.products[0].id = owner; }, (s, t) => { t.products[0].count = 2; },
    (s, t) => { t.toPay = 970000; }, (s, t) => { t.deposit = 1; }, (s, t) => { t.paidAmount = 1; },
    (s, t) => { t.products[0].used = true; }, (s, t) => { t.refundSum = 1; },
    (s, t) => { t.products[0].used = 'false'; },
    (s, t) => { t.products[0].used = 0; }, (s, t) => { t.products[0].refunded = {}; },
    (s, t) => { delete t.products[0].refunded; },
    (s) => { s.clientId = product; },
    (s) => { s.clientId = ''; },
    (s, t) => { s.clientId = null; delete t.client.id; },
    (s, t) => { s.clientId = null; t.client.phone = otherPhone; },
    (s, t) => { t.clientSubscriptionId = product; }, (s, t) => { t.receipts = [{}]; },
    (s, t) => { t.cardPaymentInfo.status = 'PENDING'; }, (s, t) => { t.cardPaymentInfo.declineOutcome = 'DECLINED'; },
    (s, t) => { t.cardPaymentInfo.paymentUrl += 'other'; }, (s, t) => { t.cardPaymentInfo.extra = true; },
    (s, t) => { t.paymentLegs.push({ source: 'DEPOSIT', amountKopecks: 1 }); },
    (s, t) => { t.paymentLegs = [null]; },
    (s, t) => { t.possibleDoublePayment = true; }, (s, t) => { t.processingStatus = 'PROCESSING'; },
    (s, t) => { t.paymentDueDate = '2026-11-17T08:00:00Z'; },
    (s, t) => { t.payments = []; }, (s, t) => { t.paymentDate = '2026-11-14'; },
  ];
  for (const mutate of mutations) {
    const { sale, transaction } = fixture(); mutate(sale, transaction);
    assert.notEqual(reason(sale, transaction, now), null, mutate.toString());
    assert.throws(() => update(sale, transaction, operation, now));
  }
});
