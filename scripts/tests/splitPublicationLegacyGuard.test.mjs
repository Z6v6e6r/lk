import test from 'node:test';
import assert from 'node:assert/strict';
import { splitPublicationLegacyGuard as guard, PUBLICATION_LEGACY_ROUTES } from '../lib/splitPublicationLegacyGuard.mjs';

const env = { get: key => key === 'PADLHUB_PLATFORM_TENANT_KEY' ? 'fixture' : undefined };
const request = (body, url = '/lk/games') => ({ payload: structuredClone(body), req: { method: 'POST', url, query: {}, headers: {} } });

for (const url of PUBLICATION_LEGACY_ROUTES) test(`${url}: any durable publication state fences legacy DB/autojoin`, () => {
  for (const state of ['PENDING', 'PUBLISHED', 'BLOCKED', 'RELEASED']) {
    const msg = request({ tenantKey: 'forged', paymentRef: 'old-tab-ref', booking: { exerciseId: 'fixture-exercise' } }, url);
    const query = guard(msg, env);
    assert.equal(query[0], null); assert.equal(query[2], null);
    assert.equal(query[1].payload[0].tenantKey, 'fixture');
    assert.equal(query[1].payload[0]['lk1.publication.version'], 1);
    assert.equal(query[1].payload[0].state, undefined);
    msg.payload = [{ _id: 'fixture', state }];
    const result = guard(msg, env);
    assert.equal(result[0], null); assert.equal(result[1], null);
    assert.equal(result[2].statusCode, 409);
    assert.equal(result[2].payload.code, 'SERVER_PUBLICATION_OWNED');
    assert.doesNotMatch(JSON.stringify(result[2].payload), /fixture|old-tab-ref/);
  }
});

test('all aliases are ORed; mismatched body tenant and conflicting first IDs cannot hide ownership', () => {
  const msg = request({ tenantKey: 'other', exerciseId: 'wrong', booking: { vivaExerciseId: 'right', bookingIds: ['b1', 'b2'] },
    payment: { paymentRef: 'r1' }, metadata: { operationId: 'op', splitPayment: { organizerBookingId: 'b3' } } });
  msg.req.query = { phPaymentRef: 'r2', bookingIds: 'b4,b5', exerciseId: 'e3' };
  msg.req.headers['idempotency-key'] = 'op2';
  const q = guard(msg, env)[1].payload[0];
  const ids = key => q.$or.find(c => c[key])?.[key].$in;
  assert.deepEqual(ids('exerciseId'), ['wrong', 'e3', 'right']);
  assert.deepEqual(new Set(ids('bookingId')), new Set(['b1', 'b2', 'b3', 'b4', 'b5']));
  assert.deepEqual(new Set(ids('operationId')), new Set(['r1', 'r2', 'op', 'op2']));
});

test('reserved canonical IDs and markers are rejected even without provider references', () => {
  for (const body of [{ id: 'gsp_fixture', expectedRevision: 2 }, { gameId: ' gsp_fixture' },
    { recordId: 'gsp_fixture' }, { id: ['gsp_fixture'] }, { gameId: [['gsp_fixture']] }, { metadata: { serverPublication: null } }, { serverPublication: {} }]) {
    const r = guard(request(body), env);
    assert.equal(r[0], null); assert.equal(r[1], null); assert.equal(r[2].statusCode, 409);
  }
});

test('only a successful empty lookup allows legacy publication; errors cannot reach writes', () => {
  const body = { paymentRef: 'legacy', booking: { bookingIds: ['fixture'] } };
  const msg = request(body); guard(msg, env); msg.payload = [];
  assert.deepEqual(guard(msg, env)[0].payload, body);
  for (const value of [undefined, null, {}, '[]', { error: 'timeout' }]) {
    const bad = request(body); guard(bad, env); bad.payload = value;
    const r = guard(bad, env); assert.equal(r[0], null); assert.equal(r[1], null); assert.equal(r[2].statusCode, 503);
  }
  const failed = request(body); guard(failed, env); failed.payload = []; failed.error = { message: 'timeout' };
  assert.equal(guard(failed, env)[2].statusCode, 503);
  assert.equal(guard(request(body), { get() {} })[2].statusCode, 503);
});
