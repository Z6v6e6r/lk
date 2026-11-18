import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import test from 'node:test';

import { createBookedOperationV3Receiver } from '../lib/bookedOperationV3Receiver.mjs';
import { BOOKED_OPERATION_V3 } from '../lib/bookedOperationV3Contract.mjs';

const fixture = JSON.parse(
  fs.readFileSync(new URL('./fixtures/booked-operation-v3-contract.json', import.meta.url), 'utf8'),
);
const hash = (value) =>
  'sha256:' + createHash('sha256').update(JSON.stringify(value), 'utf8').digest('hex');
const exp = Math.floor(Date.now() / 1000) + 600;
const claims = (scope, path = BOOKED_OPERATION_V3.preflightPath, method = 'POST') => ({
  contract_version: 3,
  scope,
  path,
  method,
  exp,
  operation_id: fixture.preflightResult.operationId,
  quote_id: fixture.preflightResult.quote.quoteId,
  request_sha256: hash(fixture.admissionRequest),
});
const receiver = createBookedOperationV3Receiver({
  preflight: async () => ({
    quote: fixture.preflightResult.quote,
    settlement: fixture.preflightResult.settlement,
    requestSha256: fixture.preflightResult.requestSha256,
  }),
  admit: async () => ({
    status: 'PENDING',
    asOf: '2027-01-10T08:30:00.000Z',
    payment: fixture.readPending.payment,
    booking: fixture.readPending.booking,
    visit: fixture.readPending.visit,
    reason: fixture.readPending.reason,
  }),
  read: async () => fixture.readPending,
  cancel: async () => ({
    operationId: fixture.cancelRequest.operationId,
    status: 'CLOSED',
    cancelled: true,
    limitReleased: true,
    visitReturned: false,
  }),
});

test('receiver routes preflight/admit/read/cancel with matching scopes', async () => {
  const preflight = await receiver.handle({
    method: 'POST',
    path: BOOKED_OPERATION_V3.preflightPath,
    body: fixture.preflightRequest,
    delegationClaims: claims(BOOKED_OPERATION_V3.scopes.preflight),
  });
  assert.equal(preflight.status, 200);
  assert.equal(preflight.body.quote.durationMinutes, 120);

  const admit = await receiver.handle({
    method: 'POST',
    path: BOOKED_OPERATION_V3.admissionPath,
    body: fixture.admissionRequest,
    delegationClaims: claims(BOOKED_OPERATION_V3.scopes.admit, BOOKED_OPERATION_V3.admissionPath),
  });
  assert.equal(admit.status, 202);
  assert.equal(admit.body.status, 'PENDING');

  const read = await receiver.handle({
    method: 'GET',
    path: BOOKED_OPERATION_V3.readPrefix + fixture.preflightResult.operationId,
    delegationClaims: claims(
      BOOKED_OPERATION_V3.scopes.read,
      BOOKED_OPERATION_V3.readPrefix + fixture.preflightResult.operationId,
      'GET',
    ),
  });
  assert.equal(read.status, 200);

  const cancel = await receiver.handle({
    method: 'POST',
    path: BOOKED_OPERATION_V3.cancelPrefix + fixture.preflightResult.operationId + '/cancel',
    body: fixture.cancelRequest,
    delegationClaims: claims(
      BOOKED_OPERATION_V3.scopes.cancel,
      BOOKED_OPERATION_V3.cancelPrefix + fixture.preflightResult.operationId + '/cancel',
    ),
  });
  assert.equal(cancel.status, 200);
  assert.equal(cancel.body.status, 'CLOSED');
});

test('receiver rejects path, scope, quote and request-hash drift before owner calls', async () => {
  let calls = 0;
  const guarded = createBookedOperationV3Receiver({
    preflight: async () => {
      calls += 1;
      return {};
    },
    admit: async () => {
      calls += 1;
      return {};
    },
    read: async () => {
      calls += 1;
      return {};
    },
    cancel: async () => {
      calls += 1;
      return {};
    },
  });
  const wrongPath = await guarded.handle({
    method: 'POST',
    path: BOOKED_OPERATION_V3.preflightPath + 'x',
    body: fixture.preflightRequest,
    delegationClaims: claims(BOOKED_OPERATION_V3.scopes.preflight),
  });
  assert.equal(wrongPath.status, 401);
  const wrongScope = await guarded.handle({
    method: 'POST',
    path: BOOKED_OPERATION_V3.preflightPath,
    body: fixture.preflightRequest,
    delegationClaims: claims(BOOKED_OPERATION_V3.scopes.admit),
  });
  assert.equal(wrongScope.status, 403);
  const wrongQuote = await guarded.handle({
    method: 'POST',
    path: BOOKED_OPERATION_V3.admissionPath,
    body: {
      ...fixture.admissionRequest,
      quoteId: '00000000-0000-4000-8000-000000000099',
      settlementConsent: {
        ...fixture.admissionRequest.settlementConsent,
        quoteId: '00000000-0000-4000-8000-000000000099',
      },
    },
    delegationClaims: claims(BOOKED_OPERATION_V3.scopes.admit, BOOKED_OPERATION_V3.admissionPath),
  });
  assert.equal(wrongQuote.status, 409);
  const wrongHash = await guarded.handle({
    method: 'POST',
    path: BOOKED_OPERATION_V3.admissionPath,
    body: fixture.admissionRequest,
    delegationClaims: {
      ...claims(BOOKED_OPERATION_V3.scopes.admit, BOOKED_OPERATION_V3.admissionPath),
      request_sha256: 'sha256:' + 'f'.repeat(64),
    },
  });
  assert.equal(wrongHash.status, 409);
  assert.equal(calls, 0);
});
