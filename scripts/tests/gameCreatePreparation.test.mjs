import test from 'node:test';
import assert from 'node:assert/strict';
import { Harness, hash, actor } from './helpers/gameCreatePreparationHarness.mjs';
import {
  gameCreateServiceTable,
  gameCreateSelectorSha256,
} from '../lib/gameCreatePreparationSource.mjs';
const refused = (h, options) => {
  const r = h.run(options);
  assert.ok(r.statusCode >= 400, JSON.stringify(r.payload));
  return r;
};
test('original eight selector pairs are extracted with exact onboarding/preview parity', () => {
  assert.equal(Object.keys(gameCreateServiceTable).length, 8);
  assert.equal(
    gameCreateSelectorSha256,
    'sha256:5506b32696f8c1844c3006bae873f5c519ed027291d386183c99b5457d3a8cc9',
  );
});
test('all eight pairs produce private nonbinding whole/quarter observations through six GETs', () => {
  for (const station of Object.keys(gameCreateServiceTable)) {
    const h = new Harness(),
      r = h.run({ claims: { provider_station_id: station } });
    assert.equal(r.statusCode, 200, JSON.stringify(r.payload));
    assert.equal(r.payload.nonBinding, true);
    assert.equal(r.payload.pricing.priceBasis, 'WHOLE_COURT_WINDOW');
    assert.equal(r.payload.pricing.courtWindowPriceMinor, 600000);
    assert.equal(r.payload.pricing.quarterPriceMinor, 150000);
    assert.equal(r.payload.pricing.participantCount, 4);
    assert.deepEqual(r.payload.pricing.subServiceIds, [
      gameCreateServiceTable[station].subServiceId,
    ]);
    assert.equal(h.calls.length, 6);
    assert.ok(h.calls.every((c) => c.method === 'GET'));
    assert.ok(
      h.calls[5].url.includes(
        '/sub-services/' +
          gameCreateServiceTable[station].subServiceId +
          '/price?fromDate=2035-04-02&fromTime=12%3A00&toTime=13%3A30&size=100',
      ),
    );
    const { sha256, ...capsule } = r.payload;
    assert.equal(sha256, hash('game-create-capsule:v1\0' + JSON.stringify(capsule)));
    assert.equal(Date.parse(capsule.expiresAt) - Date.parse(capsule.observedAt), 60000);
    assert.equal(r.headers['Cache-Control'], 'no-store');
    assert.equal(r.headers['Referrer-Policy'], 'no-referrer');
    for (const secret of [
      actor,
      'synthetic-create-admin-token',
      'PRIVATE_PROFILE',
      'PRIVATE_PHONE',
    ])
      assert.ok(!JSON.stringify(r).includes(secret));
    for (const key of ['eligible', 'usageRef', 'reservationId', 'providerExerciseId'])
      assert.ok(!Object.hasOwn(r.payload, key));
  }
});
test('signature/context/version/actor/mapping/body binding fail before any read', () => {
  for (const claims of [
    { scope: 'subscription-runtime.booked-operation.admit' },
    { path: '/wrong' },
    { method: 'GET' },
    { tenant_key: 'foreign' },
    { contract_version: 2 },
    { actor_token_sha256: hash('wrong') },
    { actor_token_expires_at: '2030-01-01T00:00:00.000Z' },
    { provider_client_id: 'bad\n' },
    { mapping_version: 'bad\r' },
    { station_mapping_id: 'bad' },
    { recovery_only: true },
    { expected_revision: 2 },
    { subscription_id: '11111111-1111-4111-8111-000000000099' },
    { exp: 1 },
    { nbf: 9999999999 },
  ]) {
    const h = new Harness();
    refused(h, { claims });
    assert.equal(h.calls.length, 0, JSON.stringify(claims));
  }
  for (const request of [
    (m) => {
      m.req.headers['x-subscription-actor-delegation'] += 'x';
    },
    (m) => {
      m.req.originalUrl += '?ignored';
    },
    (m) => {
      m.req.query = { extra: 'x' };
    },
    (m) => {
      m.req.headers['x-subscription-actor-token'] = 'foreign-synthetic-token';
    },
    (m) => {
      m.req.headers['x-correlation-id'] = 'different-correlation';
    },
  ]) {
    const h = new Harness();
    refused(h, { request });
    assert.equal(h.calls.length, 0);
  }
});
test('client selectors/amounts and invalid windows cannot enter preparation', () => {
  for (const transform of [
    (b) => ({ ...b, masterServiceId: 'chosen' }),
    (b) => ({ ...b, amount: 0 }),
    (b) => ({ ...b, target: { ...b.target, shareCount: 2 } }),
    (b) => ({ ...b, target: { ...b.target, startsAt: '2035-04-02T20:30:00.000Z' } }),
    (b) => ({ ...b, target: { ...b.target, startsAt: '2035-04-02T09:00:01.000Z' } }),
    (b) => ({ ...b, target: { ...b.target, startsAt: '+275760-09-13T00:00:00.000Z' } }),
    () => null,
    () => [],
  ]) {
    const h = new Harness(),
      body = transform(h.body);
    refused(h, {
      body,
      claims: { request_sha256: hash('game-create-preparation:v1\0' + JSON.stringify(body)) },
    });
    assert.equal(h.calls.length, 0);
  }
});
test('both existing closed flags prevent reads; missing admin credential prevents admin request', () => {
  for (const flag of [
    'LK1_BOOKED_OPERATION_RECEIVER_ENABLED',
    'BOOKED_OPERATION_EXECUTION_ENABLED',
  ]) {
    const h = new Harness();
    h.env[flag] = 'false';
    refused(h);
    assert.equal(h.calls.length, 0);
  }
  const h = new Harness();
  delete h.globals.vivacrm_access_token;
  refused(h);
  assert.equal(h.calls.length, 2);
});
test('unknown station never falls back to cached or client-provided service', () => {
  const h = new Harness();
  h.globals['subscriptions_lk1_court_service:unknown'] = JSON.stringify({
    masterServiceId: 'a',
    subServiceIds: ['b'],
  });
  refused(h, { claims: { provider_station_id: 'unknown' } });
  assert.equal(h.calls.length, 0);
});
test('foreign actor, subscription, duplicate or incomplete catalog and conflicting aliases refuse', () => {
  const cases = [
    ['profile', { id: 'foreign' }],
    ['profile', { id: 'synthetic-player', clientId: 'foreign' }],
    ['subscriptions', []],
    [
      'subscriptions',
      [
        { clientSubscriptionId: 'synthetic-subscription' },
        { clientSubscriptionId: 'synthetic-subscription' },
      ],
    ],
    ['subscriptions', [{ clientSubscriptionId: 'synthetic-subscription', clientId: 'foreign' }]],
    [
      'subscriptions',
      {
        content: [{ clientSubscriptionId: 'synthetic-subscription' }],
        number: 0,
        last: false,
        totalElements: 2,
        totalPages: 2,
      },
    ],
    ['room', { id: 'foreign' }],
    ['room', { id: 'synthetic-room', studioId: 'foreign' }],
    ['studios', []],
    ['subservices', []],
    ['subservices', { content: [], last: true, totalElements: 0 }],
    ['price', { total: 0 }],
    ['price', { total: 600001 }],
    ['price', { total: 600000.5 }],
    ['price', { total: '600000' }],
    ['price', { total: 600000, currency: 'USD' }],
    ['price', { total: 10000004 }],
  ];
  for (const [step, value] of cases) {
    const h = new Harness();
    refused(h, {
      mutate: (m, s) => {
        if (s === step) m.payload = structuredClone(value);
      },
    });
  }
  for (const step of ['studios', 'subservices']) {
    const h = new Harness();
    refused(h, {
      mutate: (m, s) => {
        if (s === step) m.payload.push({ ...m.payload[0] });
      },
    });
    const a = new Harness();
    refused(a, {
      mutate: (m, s) => {
        if (s === step) m.payload[0].archived = true;
      },
    });
    const b = new Harness();
    refused(b, {
      mutate: (m, s) => {
        if (s === step) m.payload[0].uuid = 'foreign';
      },
    });
  }
  const h = new Harness();
  refused(h, {
    mutate: (m, s) => {
      if (s === 'subservices') m.payload[0].roomIds = ['foreign'];
    },
  });
});
test('every response requires exact origin and status; timeout and expiry do not retry', () => {
  for (const step of ['profile', 'subscriptions', 'room', 'studios', 'subservices', 'price'])
    for (const change of [
      (m) => {
        m.statusCode = 429;
      },
      (m) => {
        m.statusCode = 500;
      },
      (m) => {
        m.error = { message: 'PRIVATE_ERROR' };
      },
      (m) => {
        delete m.responseUrl;
      },
      (m) => {
        m.responseUrl = 'https://foreign.invalid/';
      },
      (m) => {
        m.url += 'changed';
      },
    ]) {
      const h = new Harness(),
        r = refused(h, {
          mutate: (m, s) => {
            if (s === step) change(m);
          },
        });
      assert.equal(h.calls.filter((c) => c.step === step).length, 1);
      assert.ok(!JSON.stringify(r).includes('PRIVATE_ERROR'));
    }
  const h = new Harness();
  refused(h, {
    mutate: (m, s, h) => {
      if (s === 'price') h.now += 121000;
    },
  });
  assert.equal(h.calls.length, 6);
});
test('partial minor units refuse and repeated new preparation can observe price without reserve', () => {
  const h = new Harness(),
    first = h.run();
  h.calls = [];
  const second = h.run({
    mutate: (m, s) => {
      if (s === 'price') m.payload.total = 800000;
    },
  });
  assert.equal(second.statusCode, 200);
  assert.equal(second.payload.pricing.quarterPriceMinor, 200000);
  assert.notEqual(first.payload.sha256, second.payload.sha256);
  assert.equal(first.payload.operationId, second.payload.operationId);
  assert.equal(h.calls.length, 6);
});
