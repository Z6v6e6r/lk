import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';

import {
  BOOKED_OPERATION_V3,
  buildBookedOperationV3CancelResult,
  buildBookedOperationV3PreflightResult,
  buildBookedOperationV3ReadOutcome,
  parseBookedOperationV3AdmissionRequest,
  parseBookedOperationV3CancelRequest,
  parseBookedOperationV3CancelResult,
  parseBookedOperationV3PreflightRequest,
  parseBookedOperationV3PreflightResult,
  parseBookedOperationV3ReadOutcome,
} from '../lib/bookedOperationV3Contract.mjs';

const fixture = JSON.parse(
  fs.readFileSync(new URL('./fixtures/booked-operation-v3-contract.json', import.meta.url), 'utf8'),
);

test('v3 routes and scopes are the frozen wire', () => {
  assert.equal(BOOKED_OPERATION_V3.contractVersion, 3);
  assert.equal(
    BOOKED_OPERATION_V3.preflightPath,
    '/lk/integrations/v3/booked-operation-preflights',
  );
  assert.equal(
    BOOKED_OPERATION_V3.admissionPath,
    '/lk/integrations/v3/booked-operation-admissions',
  );
  assert.equal(
    BOOKED_OPERATION_V3.cancelPrefix + 'x/cancel',
    '/lk/integrations/v3/booked-operations/x/cancel',
  );
});

test('producer parser accepts the same fixture as the LK2 consumer', () => {
  assert.deepEqual(
    parseBookedOperationV3PreflightRequest(fixture.preflightRequest),
    fixture.preflightRequest,
  );
  assert.equal(
    parseBookedOperationV3PreflightResult(fixture.preflightResult).quote.durationMinutes,
    120,
  );
  assert.equal(
    parseBookedOperationV3AdmissionRequest(fixture.admissionRequest).settlementConsent.amountMinor,
    90000,
  );
  assert.equal(parseBookedOperationV3ReadOutcome(fixture.readPending).status, 'PENDING');
  assert.equal(
    parseBookedOperationV3ReadOutcome(fixture.readConfirmed).receipt.receiptId,
    'receipt-7',
  );
  assert.deepEqual(
    parseBookedOperationV3CancelRequest(fixture.cancelRequest),
    fixture.cancelRequest,
  );
  assert.equal(parseBookedOperationV3CancelResult(fixture.cancelClosed).limitReleased, true);
});

test('builders emit the exact bound shapes and reject release before CLOSED', () => {
  const preflight = buildBookedOperationV3PreflightResult({
    operationId: fixture.preflightResult.operationId,
    action: 'JOIN_GAME',
    target: fixture.preflightResult.target,
    quote: fixture.preflightResult.quote,
    settlement: fixture.preflightResult.settlement,
    requestSha256: fixture.preflightResult.requestSha256,
  });
  assert.deepEqual(preflight, fixture.preflightResult);

  const read = buildBookedOperationV3ReadOutcome({
    operationId: fixture.readConfirmed.operationId,
    quoteId: fixture.readConfirmed.quoteId,
    requestSha256: fixture.readConfirmed.requestSha256,
    status: 'CONFIRMED',
    asOf: fixture.readConfirmed.asOf,
    payment: fixture.readConfirmed.payment,
    booking: fixture.readConfirmed.booking,
    visit: fixture.readConfirmed.visit,
    reason: fixture.readConfirmed.reason,
    receipt: fixture.readConfirmed.receipt,
  });
  assert.deepEqual(read, fixture.readConfirmed);

  assert.throws(
    () =>
      buildBookedOperationV3CancelResult({
        operationId: fixture.cancelRequest.operationId,
        status: 'CLOSING',
        limitReleased: true,
      }),
    /BOOKED_OPERATION_V3_CONTRACT_INVALID/,
  );
  assert.equal(
    buildBookedOperationV3CancelResult({
      operationId: fixture.cancelClosed.operationId,
      status: 'CLOSED',
      limitReleased: true,
      visitReturned: false,
    }).cancelled,
    true,
  );
});

test('producer parser fails closed on binding, receipt and consent drift', () => {
  assert.throws(
    () =>
      parseBookedOperationV3PreflightResult({
        ...fixture.preflightResult,
        requestSha256: 'sha256:short',
      }),
    /BOOKED_OPERATION_V3_CONTRACT_INVALID/,
  );
  assert.throws(
    () =>
      parseBookedOperationV3PreflightResult({
        ...fixture.preflightResult,
        settlement: { ...fixture.preflightResult.settlement, toPayMinor: 1 },
      }),
    /BOOKED_OPERATION_V3_CONTRACT_INVALID/,
  );
  assert.throws(
    () =>
      parseBookedOperationV3ReadOutcome({
        ...fixture.readConfirmed,
        receipt: null,
      }),
    /BOOKED_OPERATION_V3_CONTRACT_INVALID/,
  );
  assert.throws(
    () =>
      parseBookedOperationV3AdmissionRequest({
        ...fixture.admissionRequest,
        settlementConsent: { ...fixture.admissionRequest.settlementConsent, quoteId: 'foreign' },
      }),
    /BOOKED_OPERATION_V3_CONTRACT_INVALID/,
  );
  assert.throws(
    () =>
      parseBookedOperationV3ReadOutcome({
        ...fixture.readPending,
        quoteId: fixture.readConfirmed.quoteId,
        requestSha256: 'sha256:' + 'd'.repeat(64),
        receipt: {
          ...fixture.readConfirmed.receipt,
          priceCharged: { amountMinor: 1, currency: 'RUB' },
        },
        status: 'PENDING',
      }),
    /BOOKED_OPERATION_V3_CONTRACT_INVALID/,
  );
});
