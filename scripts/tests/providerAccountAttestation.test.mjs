import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import crypto from 'node:crypto';
import { Harness, actor, path, uuid, requestHash, fixture } from './helpers/providerAccountAttestationHarness.mjs';
import { providerAccountAttestationSource } from '../lib/providerAccountAttestationSource.mjs';
import {
  composeProviderAccountAttestation,
  providerAccountAttestationGameIds as gameIds,
  providerAccountAttestationIds as ids,
  PROVIDER_ACCOUNT_ROUTE,
} from '../patch_nodered_provider_account_attestation.mjs';
import { validateReviewedFlowContract } from '../nodered_reviewed_flow_deploy/runtime_contract.mjs';

const code = (r) => [r.statusCode, r.payload.code];
const noStore = (r) => {
  assert.equal(r.headers['Cache-Control'], 'no-store');
  assert.equal(r.headers['Referrer-Policy'], 'no-referrer');
};
// No credential, claim identity, delegation or private provider field may leave LK1 or be logged.
const assertClean = (h, r) => {
  const text = JSON.stringify(r);
  for (const secret of [actor, 'PRIVATE_NAME', 'PRIVATE_PHONE_VALUE', 'PRIVATE_EMAIL_VALUE', 'eyJ', uuid(5), uuid(7)]) {
    assert.ok(!text.includes(secret), secret);
  }
  assert.deepEqual(h.logs, []);
  assert.deepEqual(Object.keys(r).sort(), ['_msgid', 'headers', 'payload', 'req', 'res', 'statusCode'].filter((k) => k in r).sort());
  assert.ok(!JSON.stringify(r.req.headers).includes(actor));
};

test('attests the actor account from actor-token GETs only, in the exact v1 shape', () => {
  const h = new Harness();
  const r = h.run();
  assert.equal(r.statusCode, 200, JSON.stringify(r.payload));
  noStore(r);
  assertClean(h, r);
  assert.deepEqual(Object.keys(r.payload).sort(), ['attestedAt', 'contractVersion', 'operationId', 'providerClientId',
    'providerTenantKey', 'subscriptions']);
  assert.equal(r.payload.providerClientId, 'synthetic-client-1');
  assert.equal(r.payload.operationId, uuid(10));
  assert.equal(r.payload.providerTenantKey, 'iSkq6G');
  assert.equal(r.payload.attestedAt, '2035-04-01T09:00:00.000Z');
  assert.deepEqual(r.payload.subscriptions, [
    { clientSubscriptionId: 'synthetic-client-subscription-active', productId: null, title: 'Синтетический абонемент ACTIVE',
      state: 'ACTIVE', remainingUnits: 5, validUntil: '2035-06-01T20:59:59.000Z' },
    { clientSubscriptionId: 'synthetic-client-subscription-new', productId: null, title: 'Синтетический абонемент NEW',
      state: 'NOT_ACTIVATED', remainingUnits: 4, validUntil: null },
    { clientSubscriptionId: 'synthetic-client-subscription-hold', productId: null, title: 'Синтетический абонемент HOLD',
      state: 'PAUSED', remainingUnits: 0, validUntil: '2035-08-01T20:59:59.000Z' },
    { clientSubscriptionId: 'synthetic-client-subscription-finished', productId: null, title: 'Синтетический абонемент FINISHED',
      state: 'FINISHED', remainingUnits: 0, validUntil: '2034-04-01T20:59:59.000Z' },
  ]);
  assert.deepEqual(h.calls.map((c) => [c.method, c.url, c.auth, c.followRedirects, c.payload]), [
    ['GET', 'https://api.vivacrm.ru/end-user/api/v1/iSkq6G/profile', 'Bearer ' + actor, false, undefined],
    ['GET', 'https://api.vivacrm.ru/end-user/api/v1/iSkq6G/subscriptions?includeFinished=true&size=1000', 'Bearer ' + actor, false, undefined],
  ]);
});

test('target adds a proof derived with the booking owner findOwnedSubscriptions', () => {
  const h = new Harness();
  h.body = { contractVersion: 1, operationId: uuid(11), target: { exerciseId: 'synthetic-exercise-1' } };
  const r = h.run();
  assert.equal(r.statusCode, 200, JSON.stringify(r.payload));
  assertClean(h, r);
  assert.deepEqual(r.payload.targetProof, { exerciseId: 'synthetic-exercise-1', startsAt: '2035-04-02T09:00:00.000Z',
    durationMinutes: 90, ownedClientSubscriptionIds: ['synthetic-client-subscription-active'],
    eligibleClientSubscriptionIds: [] }, 'the reconstructed row proves no HUB product or purchase date: not eligible');
  assert.equal(h.calls.at(-1).url, 'https://api.vivacrm.ru/end-user/api/v1/iSkq6G/exercises/synthetic-exercise-1');
  const none = new Harness();
  none.body = h.body;
  none.exercise.availableClientSubscriptions = [{ subscriptionId: 'someone-else' }];
  assert.deepEqual(none.run().payload.targetProof.ownedClientSubscriptionIds, []);
  for (const exercise of [{ id: 'other-exercise', timeFrom: '2035-04-02T09:00:00.000Z', duration: 60 },
    { id: 'synthetic-exercise-1' }]) {
    const bad = new Harness();
    bad.body = h.body;
    bad.exercise = exercise;
    assert.deepEqual(code(bad.run()), [409, 'PROVIDER_ACCOUNT_INVALID']);
  }
  const missing = new Harness();
  missing.body = h.body;
  missing.statuses.exercise = 404;
  assert.deepEqual(code(missing.run()), [409, 'PROVIDER_ACCOUNT_INVALID']);
});

test('wrong typ, action, extra claims, lifetime or tenant are refused before any provider read', () => {
  const cases = [
    [{ typ: 'phub-subscription-runtime-actor-delegation+jwt' }, 401],
    [{ claims: { scope: 'lk1:provider-account:write' } }, 401],
    [{ claims: { scope: undefined } }, 401],
    [{ claims: { action: 'READ_PROVIDER_ACCOUNT' } }, 401],
    [{ claims: { scope: 'subscription-runtime.booked-operation.admit' } }, 401],
    [{ claims: { actor_token_sha256: undefined } }, 401],
    [{ claims: { provider_client_id: 'attacker-chosen' } }, 401],
    [{ claims: { tenant_key: 'otherTenant' } }, 401],
    [{ claims: { provider: 'OTHER' } }, 401],
    [{ claims: { caller: 'browser' } }, 401],
    [{ claims: { contract_version: 2 } }, 401],
    [{ claims: { iss: 'other-issuer' } }, 401],
    [{ claims: { aud: 'padlhub-lk1-booked-operation-other' } }, 401],
    [{ claims: { sub: 'not-a-uuid' } }, 401],
    [{ claims: { exp: Date.parse('2035-04-01T09:01:01.000Z') / 1000 } }, 401],
  ];
  for (const [options, status] of cases) {
    const h = new Harness();
    const r = h.run(options);
    assert.equal(r.statusCode, status, JSON.stringify(options));
    assert.equal(h.calls.length, 0, JSON.stringify(options));
    assertClean(h, r);
  }
  const forged = new Harness();
  const msg = forged.message();
  const [hd, pl] = msg.req.headers['x-subscription-actor-delegation'].split('.');
  const other = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
  msg.req.headers['x-subscription-actor-delegation'] = hd + '.' + pl + '.'
    + crypto.sign('RSA-SHA256', Buffer.from(hd + '.' + pl), other.privateKey).toString('base64url');
  assert.deepEqual(code(forged.run({ msg })), [401, 'PROVIDER_ACCOUNT_DELEGATION_INVALID']);
  const missing = new Harness();
  assert.deepEqual(code(missing.run({ request: (m) => delete m.req.headers['x-subscription-actor-delegation'] })),
    [401, 'PROVIDER_ACCOUNT_DELEGATION_REQUIRED']);
});

test('booked-operation routes refuse an attestation delegation', () => {
  const h = new Harness();
  const prelude = fs.readFileSync(new URL('../nodered_booked_operation_receiver_nodes/_booked_operation_delegation_prelude.js', import.meta.url), 'utf8');
  for (const [mode, url] of [['admit', '/lk/integrations/v1/booked-operation-admissions'],
    ['preflight', '/lk/integrations/v2/booked-operation-preflights'], ['read', '/lk/integrations/v1/booked-operations/' + uuid(10)]]) {
    const verify = new Function('msg', 'env', 'nodeCrypto', 'Date', prelude + '\nreturn bookedOperationVerifyDelegation(msg, env, ' + JSON.stringify(mode) + ');');
    const msg = h.message();
    msg.req.originalUrl = url;
    const result = verify(msg, { get: (n) => h.env[n] }, crypto, h.Date);
    assert.deepEqual([result.ok, result.code], [false, 'BOOKED_OPERATION_DELEGATION_INVALID'], mode);
  }
});

test('expired delegation or actor token, and context mismatches are refused', () => {
  const cases = [
    [{ claims: { exp: Date.parse('2035-04-01T09:00:00.000Z') / 1000, iat: Date.parse('2035-04-01T08:59:30.000Z') / 1000,
      nbf: Date.parse('2035-04-01T08:59:30.000Z') / 1000 } }, [401, 'PROVIDER_ACCOUNT_DELEGATION_INVALID']],
    [{ claims: { iat: Date.parse('2035-04-01T09:00:30.000Z') / 1000 } }, [401, 'PROVIDER_ACCOUNT_DELEGATION_INVALID']],
    [{ claims: { actor_token_expires_at: '2035-04-01T09:00:03.000Z' } }, [403, 'PROVIDER_ACCOUNT_ACTOR_TOKEN_INVALID']],
    [{ request: (m) => { m.req.headers['x-subscription-actor-token'] = 'another-actor-token-value'; } }, [403, 'PROVIDER_ACCOUNT_ACTOR_TOKEN_INVALID']],
    [{ request: (m) => { delete m.req.headers['x-subscription-actor-token']; } }, [403, 'PROVIDER_ACCOUNT_ACTOR_TOKEN_INVALID']],
    [{ request: (m) => { m.req.headers['x-correlation-id'] = 'different-correlation'; } }, [403, 'PROVIDER_ACCOUNT_CONTEXT_MISMATCH']],
    [{ request: (m) => { m.req.originalUrl = path + '/'; } }, [403, 'PROVIDER_ACCOUNT_CONTEXT_MISMATCH']],
    [{ request: (m) => { m.req.method = 'PUT'; } }, [403, 'PROVIDER_ACCOUNT_CONTEXT_MISMATCH']],
    [{ claims: { path: '/lk/integrations/v1/booked-operation-admissions' } }, [403, 'PROVIDER_ACCOUNT_CONTEXT_MISMATCH']],
    [{ request: (m) => { m.req.query = { x: '1' }; } }, [400, 'PROVIDER_ACCOUNT_REQUEST_INVALID']],
    [{ request: (m) => { m.req.headers['content-type'] = 'text/plain'; } }, [400, 'PROVIDER_ACCOUNT_REQUEST_INVALID']],
    [{ body: { contractVersion: 1, operationId: uuid(10), providerClientId: 'x' }, signedBody: { contractVersion: 1, operationId: uuid(10) } }, [400, 'PROVIDER_ACCOUNT_REQUEST_INVALID']],
    [{ body: { contractVersion: 1, operationId: uuid(12) }, signedBody: { contractVersion: 1, operationId: uuid(10) } }, [400, 'PROVIDER_ACCOUNT_REQUEST_INVALID']],
    [{ body: { contractVersion: 1, operationId: uuid(10), target: { exerciseId: 'other' } },
      signedBody: { contractVersion: 1, operationId: uuid(10), target: { exerciseId: 'signed' } } }, [400, 'PROVIDER_ACCOUNT_REQUEST_INVALID']],
    [{ body: { contractVersion: 1, operationId: uuid(10), target: { exerciseId: '../x' } } }, [400, 'PROVIDER_ACCOUNT_REQUEST_INVALID']],
  ];
  for (const [options, expected] of cases) {
    const h = new Harness();
    const r = h.run(options);
    assert.deepEqual(code(r), expected, JSON.stringify(options, (k, v) => typeof v === 'function' ? String(v) : v));
    assert.equal(h.calls.length, 0);
    assertClean(h, r);
  }
});

test('an operation id or jti is accepted once; refusals never burn an id', () => {
  const h = new Harness();
  assert.deepEqual(code(h.run({ request: (m) => { m.req.headers['x-correlation-id'] = 'different-correlation'; } })),
    [403, 'PROVIDER_ACCOUNT_CONTEXT_MISMATCH']);
  assert.equal(h.run().statusCode, 200);
  const calls = h.calls.length;
  assert.deepEqual(code(h.run()), [409, 'PROVIDER_ACCOUNT_INVALID']);
  const sameJti = { contractVersion: 1, operationId: uuid(13) };
  assert.deepEqual(code(h.run({ body: sameJti })), [409, 'PROVIDER_ACCOUNT_INVALID']);
  assert.equal(h.calls.length, calls);
  // After expiry the entry is pruned, but the expired delegation itself no longer verifies.
  h.now += 66000;
  assert.deepEqual(code(h.run({ claims: { iat: Date.parse('2035-04-01T09:00:00.000Z') / 1000,
    nbf: Date.parse('2035-04-01T09:00:00.000Z') / 1000, exp: Date.parse('2035-04-01T09:01:00.000Z') / 1000 } })),
  [401, 'PROVIDER_ACCOUNT_DELEGATION_INVALID']);
  const fresh = h.run({ claims: { jti: uuid(14) } });
  assert.equal(fresh.statusCode, 200);
  // The next accepted request prunes expired entries.
  assert.deepEqual(Object.keys(h.store.get('providerAccountAttestationSeen')).sort(), ['jti:' + uuid(14), 'op:' + uuid(10)]);
  const full = new Harness();
  full.store.set('providerAccountAttestationSeen', Object.fromEntries(Array.from({ length: 9999 }, (_, i) => ['k' + i, full.now + 60000])));
  assert.deepEqual(code(full.run()), [503, 'PROVIDER_ACCOUNT_UNAVAILABLE']);
  assert.equal(full.calls.length, 0);
});

test('Viva 401/403 map to FORBIDDEN, other failures to closed codes', () => {
  for (const [step, status, expected] of [['profile', 401, [403, 'PROVIDER_ACCOUNT_FORBIDDEN']],
    ['subscriptions', 403, [403, 'PROVIDER_ACCOUNT_FORBIDDEN']], ['profile', 500, [503, 'PROVIDER_ACCOUNT_UNAVAILABLE']],
    ['subscriptions', 429, [503, 'PROVIDER_ACCOUNT_UNAVAILABLE']], ['profile', 404, [503, 'PROVIDER_ACCOUNT_UNAVAILABLE']]]) {
    const h = new Harness();
    h.statuses[step] = status;
    const r = h.run();
    assert.deepEqual(code(r), expected, step + status);
    assertClean(h, r);
  }
  for (const options of [{ transportError: 'profile' }, { transportError: 'subscriptions' }, { redirect: 'subscriptions' },
    { rawBody: 'profile' }, { rawBody: 'subscriptions' }]) {
    const h = new Harness();
    assert.deepEqual(code(h.run(options)), [503, 'PROVIDER_ACCOUNT_UNAVAILABLE']);
  }
  const slow = new Harness();
  assert.deepEqual(code(slow.run({ mutate: (m, step) => { if (step === 'profile') slow.now += 61000; } })),
    [503, 'PROVIDER_ACCOUNT_UNAVAILABLE']);
});

test('the client id comes only from the actor profile read; inconsistent provider data is refused', () => {
  const mutations = [
    (h) => { h.profile = { name: 'PRIVATE_NAME' }; },
    (h) => { h.profile = { id: 'a-client', clientId: 'b-client' }; },
    (h) => { h.subscriptions.content[0].clientId = 'someone-else'; },
    (h) => { h.subscriptions.content[1].subscriptionId = h.subscriptions.content[0].subscriptionId; },
    (h) => { h.subscriptions.content[0].clientSubscriptionId = 'different-alias'; },
    (h) => { delete h.subscriptions.content[0].subscriptionId; },
    (h) => { h.subscriptions.last = false; },
    (h) => { h.subscriptions.totalElements = 5; },
    (h) => { h.subscriptions = { data: h.subscriptions }; },
  ];
  for (const mutate of mutations) {
    const h = new Harness();
    mutate(h);
    assert.deepEqual(code(h.run()), [409, 'PROVIDER_ACCOUNT_INVALID'], String(mutate));
  }
  const wrapped = new Harness();
  wrapped.profile = { data: { clientId: 'synthetic-client-1', phone: 'PRIVATE_PHONE_VALUE' } };
  assert.equal(wrapped.run().payload.providerClientId, 'synthetic-client-1');
  const owned = new Harness();
  owned.subscriptions.content[0].clientId = 'synthetic-client-1';
  owned.subscriptions.content[0].productId = 'B2E6A9D4-53B5-4F79-87EC-3FB076381E9B';
  const r = owned.run();
  assert.equal(r.statusCode, 200);
  assert.equal(r.payload.subscriptions[0].productId, 'b2e6a9d4-53b5-4f79-87ec-3fb076381e9b');
});

test('target proof covers subscriptions beyond the 50 shown; ids compare case-insensitively', () => {
  const h = new Harness();
  h.body = { contractVersion: 1, operationId: uuid(15), target: { exerciseId: 'Synthetic-Exercise-1' } };
  h.subscriptions = Array.from({ length: 60 }, (_, i) => ({ subscriptionId: 'synthetic-sub-' + String(i).padStart(2, '0'),
    status: 'ACTIVE', activationDate: '2035-01-01', expirationDate: '2035-12-31' }));
  h.subscriptions[59] = { subscriptionId: 'synthetic-sub-late', status: 'FINISHED', expirationDate: '2034-01-01' };
  h.exercise.id = 'synthetic-exercise-1';
  h.exercise.availableClientSubscriptions = [{ subscriptionId: 'SYNTHETIC-SUB-LATE' }];
  const r = h.run();
  assert.equal(r.statusCode, 200, JSON.stringify(r.payload));
  assert.ok(!r.payload.subscriptions.some((s) => s.clientSubscriptionId === 'synthetic-sub-late'));
  assert.deepEqual(r.payload.targetProof.ownedClientSubscriptionIds, ['synthetic-sub-late']);
});

const HUB = 'db7a5250-7369-4f43-8ac5-9111be24bc74';
const eligibleRow = (over = {}) => ({ subscriptionId: 'synthetic-hub-sub', clientId: 'synthetic-client-1', productId: HUB,
  name: 'HUB', status: 'ACTIVE', variant: 'BY_VISITS', visitsLeft: 3, purchaseDate: '2026-09-01T10:00:00.000+03:00',
  activationDate: '2035-03-01T10:00:00.000+03:00', expirationDate: '2035-04-30', holdUntil: null, ...over });
const eligibleRun = (row, exerciseOver = {}) => {
  const h = new Harness();
  h.body = { contractVersion: 1, operationId: uuid(20), target: { exerciseId: 'synthetic-exercise-1' } };
  h.subscriptions = [row];
  Object.assign(h.exercise, { availableClientSubscriptions: [{ subscriptionId: row.subscriptionId }] }, exerciseOver);
  const r = h.run();
  assert.equal(r.statusCode, 200, JSON.stringify(r.payload));
  assert.ok(r.payload.targetProof.eligibleClientSubscriptionIds.every((id) => r.payload.targetProof.ownedClientSubscriptionIds.includes(id)));
  return r.payload.targetProof.eligibleClientSubscriptionIds;
};

test('eligible: owned HUB BY_VISITS bought from 2026-09-01, active over the whole game, visits left', () => {
  assert.deepEqual(eligibleRun(eligibleRow()), ['synthetic-hub-sub']);
  assert.deepEqual(eligibleRun(eligibleRow({ productId: undefined, product: { id: HUB } })), ['synthetic-hub-sub']);
  assert.deepEqual(eligibleRun(eligibleRow({ expirationDate: '2035-04-02', purchaseDate: '2026-08-31T21:30:00.000Z' })),
    ['synthetic-hub-sub'], 'expiry day covers the game; 00:30 Moscow on 1 Sep counts');
});

test('not eligible: each HUB JOIN rule refuses on its own', () => {
  const cases = {
    'another product': { productId: '6b98e7e3-5bd3-4e94-9dc3-7723ea52513e' },
    'no product in the Viva row': { productId: undefined },
    'two products': { product: { id: '6b98e7e3-5bd3-4e94-9dc3-7723ea52513e' } },
    'bought before 2026-09-01': { purchaseDate: '2026-08-31T23:59:59.000+03:00' },
    'no purchase date': { purchaseDate: undefined },
    'conflicting purchase dates': { purchaseAt: '2026-10-01T10:00:00.000+03:00' },
    'FINISHED': { status: 'FINISHED' },
    'NEW': { status: 'NEW' },
    'lowercase active': { status: 'active' },
    'row id names another instance': { id: 'synthetic-other-instance' },
    'isFrozen as a string': { isFrozen: 'true' },
    'isFrozen as 1': { isFrozen: 1 },
    'frozen': { isFrozen: true },
    'hold': { holdUntil: '2035-04-10T00:00:00.000+03:00' },
    'frozenUntil': { frozenUntil: '2035-04-10T00:00:00.000+03:00' },
    'activated after now': { activationDate: '2035-04-01T13:00:00.000+03:00' },
    'activated after game start': { activationDate: '2035-04-02T12:30:00.000+03:00' },
    'activation unparsed': { activationDate: 'soon' },
    'expires before game end': { expirationDate: '2035-04-02T12:00:00.000+03:00' },
    'expired': { expirationDate: '2035-03-31' },
    'visitsLeft 0': { visitsLeft: 0 },
    'visitsLeft not a number': { visitsLeft: '3' },
    'variant other than BY_VISITS': { variant: 'UNLIMITED' },
  };
  for (const [label, over] of Object.entries(cases)) {
    const row = eligibleRow(over);
    for (const [k, v] of Object.entries(over)) if (v === undefined) delete row[k];
    assert.deepEqual(eligibleRun(row), [], label);
  }
  assert.deepEqual(eligibleRun(eligibleRow(), { availableClientSubscriptions: [] }), [], 'not owned for this exercise');
});

test('eligible: case-insensitive product and id, matching row id, isFrozen false; always a subset of the 50 owned', () => {
  assert.deepEqual(eligibleRun(eligibleRow({ productId: HUB.toUpperCase(), id: 'SYNTHETIC-HUB-SUB', isFrozen: false })),
    ['synthetic-hub-sub']);
  const h = new Harness();
  h.body = { contractVersion: 1, operationId: uuid(21), target: { exerciseId: 'synthetic-exercise-1' } };
  h.subscriptions = [...Array.from({ length: 50 }, (_, i) => eligibleRow({ subscriptionId: 'owned-' + String(i).padStart(2, '0'),
    visitsLeft: 0 })), eligibleRow({ subscriptionId: 'owned-late' })];
  h.exercise.availableClientSubscriptions = h.subscriptions.map((row) => ({ subscriptionId: row.subscriptionId }));
  const r = h.run();
  assert.equal(r.statusCode, 200, JSON.stringify(r.payload));
  assert.equal(r.payload.targetProof.ownedClientSubscriptionIds.length, 50);
  assert.ok(r.payload.targetProof.eligibleClientSubscriptionIds.every((id) => r.payload.targetProof.ownedClientSubscriptionIds.includes(id)));
  assert.ok(!r.payload.targetProof.ownedClientSubscriptionIds.includes('owned-late'));
  assert.deepEqual(r.payload.targetProof.eligibleClientSubscriptionIds, []);
});

const LEGACY = 'pay_79c6fd04-8e68-4ef9-9b63-cb132f83de66';
const legacyRun = (setup = (h) => h, options = {}) => {
  const h = new Harness();
  h.body = { contractVersion: 1, operationId: uuid(30), target: { legacyGameId: LEGACY } };
  setup(h);
  return [h, h.run(options)];
};

test('legacyGameId: one read-only lk_games find, then the record exercise, proof by legacyGameId only', () => {
  const [h, r] = legacyRun();
  assert.equal(r.statusCode, 200, JSON.stringify(r.payload));
  assertClean(h, r);
  assert.deepEqual(r.payload.targetProof, { legacyGameId: LEGACY, startsAt: '2035-04-02T09:00:00.000Z', durationMinutes: 90,
    ownedClientSubscriptionIds: ['synthetic-client-subscription-active'], eligibleClientSubscriptionIds: [] });
  assert.ok(!JSON.stringify(r.payload).includes('synthetic-exercise-1'), 'the raw Viva exercise id is never returned');
  assert.ok(!JSON.stringify(r.payload).includes('PRIVATE_GAME_TITLE'));
  assert.deepEqual(h.mongoCalls, [{ payload: { id: LEGACY, archived: { $ne: true } }, limit: 2, url: undefined, headers: undefined }],
    'no provider URL or actor token travels to the database node');
  assert.deepEqual(h.calls.map((c) => c.url.split('/iSkq6G/')[1]), ['profile', 'subscriptions?includeFinished=true&size=1000',
    'exercises/synthetic-exercise-1']);
  // Same eligibility rules through the legacy path.
  const [, ok] = legacyRun((x) => { x.subscriptions = [eligibleRow()];
    x.exercise.availableClientSubscriptions = [{ subscriptionId: 'synthetic-hub-sub' }]; });
  assert.deepEqual(ok.payload.targetProof.eligibleClientSubscriptionIds, ['synthetic-hub-sub']);
  // Aliases that agree (case, dedupeKey) resolve.
  const [, agree] = legacyRun((x) => { x.gameRecords = [{ id: LEGACY, vivaExerciseId: 'SYNTHETIC-EXERCISE-1',
    dedupeKey: 'viva:synthetic-exercise-1', metadata: { splitPayment: { exerciseId: 'synthetic-exercise-1' } } }]; });
  assert.equal(agree.statusCode, 200, JSON.stringify(agree.payload));
});

test('legacyGameId: game record problems refuse with 409 before any exercise read', () => {
  const cases = {
    'no record': [],
    'two records': [{ id: LEGACY, exerciseId: 'synthetic-exercise-1' }, { id: LEGACY, exerciseId: 'synthetic-exercise-1' }],
    'other id': [{ id: 'pay_00000000-0000-4000-8000-000000000000', exerciseId: 'synthetic-exercise-1' }],
    'foreign tenant': [{ id: LEGACY, tenantKey: 'otherTenant', exerciseId: 'synthetic-exercise-1' }],
    'archived': [{ id: LEGACY, archived: true, exerciseId: 'synthetic-exercise-1' }],
    'no exercise id': [{ id: LEGACY, booking: {} }],
    'conflicting aliases': [{ id: LEGACY, booking: { exerciseId: 'synthetic-exercise-1' }, metadata: { vivaExerciseId: 'synthetic-exercise-2' } }],
    'conflicting dedupeKey': [{ id: LEGACY, exerciseId: 'synthetic-exercise-1', dedupeKey: 'viva:synthetic-exercise-9' }],
    'non-string alias': [{ id: LEGACY, exerciseId: 12345678 }],
    'path-like alias': [{ id: LEGACY, exerciseId: '../profile' }],
  };
  for (const [label, records] of Object.entries(cases)) {
    const [h, r] = legacyRun((x) => { x.gameRecords = records; });
    assert.deepEqual(code(r), [409, 'PROVIDER_ACCOUNT_INVALID'], label);
    assert.ok(!h.calls.some((c) => c.step === 'exercise'), label);
  }
  const [h, r] = legacyRun((x) => x, { mongoError: true });
  assert.deepEqual(code(r), [503, 'PROVIDER_ACCOUNT_UNAVAILABLE'], 'database failure');
  assert.ok(!h.calls.some((c) => c.step === 'exercise'));
  const [, notArray] = legacyRun((x) => x, { mutateGame: (m) => { m.payload = { id: LEGACY }; } });
  assert.deepEqual(code(notArray), [503, 'PROVIDER_ACCOUNT_UNAVAILABLE']);
  const [, wrongExercise] = legacyRun((x) => { x.exercise.id = 'synthetic-exercise-2'; });
  assert.deepEqual(code(wrongExercise), [409, 'PROVIDER_ACCOUNT_INVALID'], 'Viva returned another exercise');
});

test('legacyGameId request shape: exact pay_<uuid>, one target key, signed hash includes it', () => {
  for (const target of [{ legacyGameId: 'pay_79C6FD04-8E68-4EF9-9B63-CB132F83DE66' }, { legacyGameId: '79c6fd04-8e68-4ef9-9b63-cb132f83de66' },
    { legacyGameId: LEGACY, exerciseId: 'synthetic-exercise-1' }, { legacyGameId: LEGACY + 'x' }, { legacyGameId: 1 }]) {
    const h = new Harness();
    const body = { contractVersion: 1, operationId: uuid(31), target };
    assert.deepEqual(code(h.run({ body })), [400, 'PROVIDER_ACCOUNT_REQUEST_INVALID'], JSON.stringify(target));
    assert.equal(h.calls.length + h.mongoCalls.length, 0);
  }
  const h = new Harness();
  const body = { contractVersion: 1, operationId: uuid(32), target: { legacyGameId: LEGACY } };
  const signedBody = { contractVersion: 1, operationId: uuid(32), target: { exerciseId: 'synthetic-exercise-1' } };
  assert.deepEqual(code(h.run({ body, signedBody })), [400, 'PROVIDER_ACCOUNT_REQUEST_INVALID'], 'target kind is signed');
  assert.equal(requestHash(body), 'sha256:' + crypto.createHash('sha256').update('provider-account-attestation:v1\0'
    + JSON.stringify({ contractVersion: 1, operationId: uuid(32), target: { legacyGameId: LEGACY } })).digest('hex'));
});

test('validity follows the LK1 money gate: Moscow wall time, date-only expiry is end of day', () => {
  const h = new Harness();
  h.now = Date.parse('2035-04-01T20:30:00.000Z'); // 23:30 Moscow on 1 April
  h.subscriptions = [{ subscriptionId: 'sub-a', status: 'ACTIVE', expirationDate: '2035-04-01' },
    { subscriptionId: 'sub-b', status: 'ACTIVE', expirationDate: '2035-04-01T23:00:00' },
    { subscriptionId: 'sub-c', status: 'ACTIVE', expirationDate: '2035-04-02T10:00:00.123456+03:00' }];
  const r = h.run();
  assert.equal(r.statusCode, 200, JSON.stringify(r.payload));
  const by = Object.fromEntries(r.payload.subscriptions.map((s) => [s.clientSubscriptionId, [s.state, s.validUntil]]));
  assert.deepEqual(by, { 'sub-a': ['ACTIVE', '2035-04-01T20:59:59.999Z'], 'sub-b': ['FINISHED', '2035-04-01T20:00:00.000Z'],
    'sub-c': ['ACTIVE', '2035-04-02T07:00:00.123Z'] });
});

test('bounds: at most 50 subscriptions, 120-character titles, 32 KiB', () => {
  const h = new Harness();
  h.subscriptions = Array.from({ length: 60 }, (_, i) => ({ subscriptionId: 'synthetic-sub-' + String(i).padStart(2, '0'),
    name: 'Й'.repeat(200) + '\n\u2028', status: 'ACTIVE', activationDate: '2035-01-01T00:00:00.000Z',
    expirationDate: new Date(Date.parse('2035-05-01T00:00:00.000Z') + i * 86400000).toISOString(), visitsLeft: i }));
  const r = h.run();
  assert.equal(r.statusCode, 200);
  assert.equal(r.payload.subscriptions.length, 50);
  assert.equal(r.payload.subscriptions[0].clientSubscriptionId, 'synthetic-sub-59');
  assert.ok(r.payload.subscriptions.every((s) => Array.from(s.title).length === 120 && !/[\n\u2028]/.test(s.title)));
  assert.ok(Buffer.byteLength(JSON.stringify(r.payload)) <= 32 * 1024);
  const weird = new Harness();
  weird.subscriptions.content[0].visitsLeft = '5';
  weird.subscriptions.content[0].expirationDate = 'not a date';
  const w = weird.run().payload.subscriptions.find((s) => s.clientSubscriptionId === 'synthetic-client-subscription-active');
  assert.deepEqual([w.remainingUnits, w.validUntil, w.state], [null, null, 'FINISHED']);
});

test('kill switches close the route before any read', () => {
  for (const key of ['LK1_PROVIDER_ACCOUNT_ATTESTATION_ENABLED', 'LK1_BOOKED_OPERATION_RECEIVER_ENABLED',
    'LK2_BOOKED_OPERATION_DELEGATION_PUBLIC_KEY_PEM']) {
    const h = new Harness();
    h.env[key] = key.endsWith('PEM') ? undefined : 'false';
    assert.deepEqual(code(h.run()), [503, 'PROVIDER_ACCOUNT_UNAVAILABLE'], key);
    assert.equal(h.calls.length, 0);
  }
  const h = new Harness();
  delete h.env.BOOKED_OPERATION_EXECUTION_ENABLED;
  assert.equal(h.run().statusCode, 200, 'read-only route does not depend on the booking execution flag');
});

test('probe advertises contract v1 only when installed and enabled', () => {
  const h = new Harness();
  const r = h.probe();
  assert.equal(r.statusCode, 200);
  noStore(r);
  assert.deepEqual(r.payload, { contractVersion: 1, capability: 'PROVIDER_ACCOUNT_ATTESTATION', maxSubscriptions: 50, targetProof: true });
  assert.deepEqual(code(h.probe({})), [404, 'PROVIDER_ACCOUNT_ATTESTATION_PROBE_NOT_FOUND']);
  assert.deepEqual(code(h.probe({ 'x-provider-account-attestation-contract': '2' })), [404, 'PROVIDER_ACCOUNT_ATTESTATION_PROBE_NOT_FOUND']);
  h.env.LK1_PROVIDER_ACCOUNT_ATTESTATION_ENABLED = 'false';
  assert.deepEqual(code(h.probe()), [503, 'PROVIDER_ACCOUNT_UNAVAILABLE']);
});

test('node sources never log, touch storage or use a global credential', () => {
  for (const name of ['verify', 'router', 'response', 'probe']) {
    const own = fs.readFileSync(new URL(`../nodered_provider_account_attestation_nodes/fn_provider_account_attestation_${name}.js`, import.meta.url), 'utf8')
      + fs.readFileSync(new URL('../nodered_provider_account_attestation_nodes/_provider_account_attestation_contract.js', import.meta.url), 'utf8');
    const code = own.replace(/^\s*\/\/.*$/gm, '');
    assert.ok(!/\bnode\.(warn|error|log|status|send)|console\.|global\.(get|set)|flow\.(get|set)|mongo/i.test(code), name);
    assert.ok(!/method\s*=\s*["'](POST|PUT|PATCH|DELETE)/.test(providerAccountAttestationSource(name)), name);
  }
});

test('graph is one additive suffix with an exact contract; collisions refuse', () => {
  const live = [{ id: 'tab1', type: 'tab', label: 'LK1' },
    { id: 'n1', type: 'http in', z: 'tab1', url: '/lk/subscription-bookings', method: 'get', wires: [[]] }];
  const bytes = Buffer.from(JSON.stringify(live, null, 2) + '\n');
  const r = composeProviderAccountAttestation(bytes, 'provider-account-attestation-synthetic');
  assert.deepEqual(r.candidate.slice(0, live.length), live);
  assert.deepEqual(r.candidate.slice(live.length).map((n) => n.id), [...Object.values(ids), ...Object.values(gameIds)]);
  validateReviewedFlowContract({ liveBytes: bytes, candidateBytes: r.candidateBytes, contract: r.contract });
  const added = r.candidate.slice(live.length);
  assert.deepEqual(added.filter((n) => n.type === 'http in').map((n) => n.method + ' ' + n.url).sort(),
    ['get ' + PROVIDER_ACCOUNT_ROUTE, 'post ' + PROVIDER_ACCOUNT_ROUTE]);
  assert.ok(!added.some((n) => /link (in|out)|inject|email|file|exec/.test(n.type)));
  // Exactly one database node: a read-only find on lk_games, fed only by the router.
  const mongo = added.filter((n) => /mongodb/.test(n.type));
  assert.deepEqual(mongo.map((n) => [n.id, n.operation, n.collection, n.clientNode]),
    [[gameIds.find, 'find', 'lk_games', '4e820638cc39c730']]);
  assert.deepEqual(r.candidate.filter((n) => (n.wires || []).flat().includes(gameIds.find)).map((n) => n.id), [ids.router]);
  assert.deepEqual(added.find((n) => n.id === gameIds.catch).scope, [gameIds.find]);
  assert.equal(added.find((n) => n.id === ids.http).senderr, false);
  for (const extra of [{ id: 'x', type: 'http in', url: PROVIDER_ACCOUNT_ROUTE.toUpperCase() + '/', method: 'post' },
    { id: ids.verify, type: 'comment' }, { id: 'y', type: 'link out', links: [ids.router] }]) {
    assert.throws(() => composeProviderAccountAttestation(Buffer.from(JSON.stringify([...live, extra])), 'x'), /PROVIDER_ACCOUNT_/);
  }
});

test('fixture: reconstructed Viva page shape parses as documented', () => {
  assert.equal(fixture.response.content.length, fixture.response.totalElements);
  assert.ok(fixture.response.content.every((row) => typeof row.subscriptionId === 'string'));
  assert.equal(requestHash({ contractVersion: 1, operationId: uuid(1) }),
    'sha256:' + crypto.createHash('sha256').update('provider-account-attestation:v1\0{"contractVersion":1,"operationId":"' + uuid(1) + '","target":null}').digest('hex'));
});
