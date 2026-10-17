import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { test } from 'node:test';
import { createBookedOperationMongoReader, createBookedOperationReadHandler } from '../lib/bookedOperationRead.mjs';
import { claims, receipt, token, verifier, path, operationId } from './helpers/bookedOperationReadFixture.mjs';

test('real owner GET: scoped lookup, truthful partial states, repeated reads and no write capability', async (t) => {
  let rows = [receipt()];
  let calls = 0;
  let dbError = false;
  const collection = new Proxy({ find(query, options) {
    calls++;
    assert.deepEqual(query, { tenantKey: claims.tenant_key, operationId, actorClientId: claims.provider_client_id });
    assert.equal(options.limit, 2);
    assert.equal(options.maxTimeMS, 1000);
    return { toArray: async () => { if (dbError) throw new Error('synthetic DB timeout'); return rows; } };
  } }, { get(target, property) { assert.equal(property, 'find', 'read must never access Mongo writes'); return target[property]; } });
  const handler = createBookedOperationReadHandler({ verifyDelegation: verifier, read: createBookedOperationMongoReader(collection) });
  const server = createServer((req, res) => { void handler(req, res); });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(() => new Promise((resolve) => server.close(resolve)));
  const base = `http://127.0.0.1:${server.address().port}`;
  const get = (proof = token(), route = path, method = 'GET') => fetch(base + route, { method,
    headers: { 'X-Subscription-Actor-Delegation': proof, 'X-Correlation-ID': claims.correlation_id } });
  for (let i = 0; i < 2; i++) {
    const response = await get();
    assert.equal(response.status, 200);
    assert.equal(response.headers.get('cache-control'), 'no-store');
    assert.deepEqual(await response.json(), { contractVersion: 1, operationId, status: 'CONFIRMED',
      asOf: '2026-10-06T08:01:00.000Z', reason: 'OWNER_BOOKING_CONFIRMED' });
  }
  assert.equal(calls, 2);
  for (const override of [
    { scope: 'subscription-runtime.quote' }, { caller: 'membership-pilot' }, { aud: 'other' },
    { method: 'POST' }, { path: path + '/other' }, { operation_id: randomUUID() },
    { tenant_id: randomUUID() }, { correlation_id: 'other-correlation' },
    { exp: Math.floor(Date.now() / 1000) - 1 }, { sid: null }, { provider_client_id: undefined },
  ]) assert.equal((await get(token(override))).status, 401);
  assert.equal(calls, 2, 'invalid delegations must not reach DB');
  assert.equal((await get(token({}, { alg: 'HS256' }))).status, 401);
  assert.equal((await get(token({}, { kid: 'unknown' }))).status, 401);
  assert.equal((await get('service-token-only')).status, 401);
  assert.equal((await get(token(), path, 'POST')).status, 405);
  assert.equal((await get(token(), path + '?actorClientId=guessed')).status, 404);
  for (const bad of [[], [receipt(), receipt()], [receipt({ actorClientId: 'other-actor' })],
    [receipt({ tenantKey: 'other-tenant' })], [receipt({ padlHubOperation: undefined })],
    [receipt({ padlHubOperation: { ...receipt().padlHubOperation, userId: randomUUID() } })]]) {
    rows = bad;
    const response = await get();
    assert.equal(response.status, 404);
    assert.deepEqual(await response.json(), { code: 'BOOKED_OPERATION_NOT_FOUND' });
  }
  for (const state of ['PREPARED', 'PENDING_CONFIRMATION', 'PRECREATE_ATTEMPTING']) {
    rows = [receipt({ state })];
    assert.equal((await (await get()).json()).status, 'PENDING');
  }
  for (const override of [{ state: 'FAILED' }, { state: 'RELEASED' }, { state: 'surprise' },
    { state: null }, { updatedAt: null }, { bookingId: undefined }, { activationState: 'PENDING' },
    { managedEntitlementOperationId: 'private-entitlement', managedEntitlementState: 'RESERVED' },
    { managedDecision: { outcome: 'ENTITLEMENT_APPLIED' } },
    { managedEntitlementState: 'CONFIRMED', managedEntitlementOperationId: 'private-entitlement' },
    { confirmedAt: '2026-10-06T07:59:00.000Z' }, { confirmedAt: '2026-10-06T08:02:00.000Z' },
    { managedEntitlementOperationId: '' }, { managedEntitlementState: 'CONFIRMED' },
    { activationState: 'CONFIRMED' },
    { precreatedEntitlementReserved: true }]) {
    rows = [receipt(override)];
    assert.equal((await (await get()).json()).status, 'UNKNOWN');
  }
  rows = [receipt({ activationState: 'CONFIRMED', activationRevision: 2,
    activationConfirmedAt: '2026-10-06T08:01:00.000Z', managedDecision: { outcome: 'ENTITLEMENT_APPLIED' },
    managedEntitlementOperationId: 'private-entitlement', managedEntitlementState: 'CONFIRMED',
    managedEntitlementConfirmedAt: '2026-10-06T08:01:00.000Z' })];
  assert.equal((await (await get()).json()).status, 'CONFIRMED');
  dbError = true;
  assert.equal((await get()).status, 503);
});

test('unconfigured owner route stays disabled', async () => {
  const handler = createBookedOperationReadHandler({});
  let status;
  handler({ method: 'GET', url: path }, { setHeader() {}, writeHead(code) { status = code; }, end() {} });
  assert.equal(status, 503);
});

test('owner deadline cancels a never-settling read with bounded 503', async () => {
  let aborted = false;
  const handler = createBookedOperationReadHandler({ verifyDelegation: () => claims,
    read: (_claims, { signal }) => new Promise(() => { signal.addEventListener('abort', () => { aborted = true; }); }) });
  let status;
  const started = Date.now();
  await handler({ method: 'GET', url: path, headers: {} }, { setHeader() {}, writeHead(code) { status = code; }, end() {} });
  assert.equal(status, 503);
  assert.equal(aborted, true);
  assert.ok(Date.now() - started < 2500);
});
