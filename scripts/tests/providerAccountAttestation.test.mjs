import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import crypto from 'node:crypto';
import { Harness, actor, path, uuid, requestHash, fixture } from './helpers/providerAccountAttestationHarness.mjs';
import { providerAccountAttestationSource } from '../lib/providerAccountAttestationSource.mjs';
import {
  composeProviderAccountAttestation,
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
  for (const secret of [actor, 'PRIVATE_NAME', '+70000000000', 'private@example.invalid', 'eyJ', uuid(5), uuid(7)]) {
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
    durationMinutes: 90, ownedClientSubscriptionIds: ['synthetic-client-subscription-active'] });
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
  for (const options of [{ transportError: 'profile' }, { redirect: 'subscriptions' }]) {
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
  wrapped.profile = { data: { clientId: 'synthetic-client-1', phone: '+70000000000' } };
  assert.equal(wrapped.run().payload.providerClientId, 'synthetic-client-1');
  const owned = new Harness();
  owned.subscriptions.content[0].clientId = 'synthetic-client-1';
  owned.subscriptions.content[0].productId = 'B2E6A9D4-53B5-4F79-87EC-3FB076381E9B';
  const r = owned.run();
  assert.equal(r.statusCode, 200);
  assert.equal(r.payload.subscriptions[0].productId, 'b2e6a9d4-53b5-4f79-87ec-3fb076381e9b');
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
  assert.deepEqual(r.candidate.slice(live.length).map((n) => n.id), Object.values(ids));
  validateReviewedFlowContract({ liveBytes: bytes, candidateBytes: r.candidateBytes, contract: r.contract });
  const added = r.candidate.slice(live.length);
  assert.deepEqual(added.filter((n) => n.type === 'http in').map((n) => n.method + ' ' + n.url).sort(),
    ['get ' + PROVIDER_ACCOUNT_ROUTE, 'post ' + PROVIDER_ACCOUNT_ROUTE]);
  assert.ok(!added.some((n) => /mongodb|link (in|out)|inject|email|file/.test(n.type)));
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
