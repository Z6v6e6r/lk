import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import crypto from 'node:crypto';
import {
  Harness,
  actor,
  fixture,
  hash,
  booking,
  exercise,
} from './helpers/trainingRegistrationOwnerHarness.mjs';
test('frozen wire is unchanged and hashes roundtrip with actual JS parser', () => {
  assert.equal(
    crypto
      .createHash('sha256')
      .update(
        fs.readFileSync(
          new URL('./fixtures/training-registration-owner-v1-contract.json', import.meta.url),
        ),
      )
      .digest('hex'),
    'ad6b0447943617233fd4677dc61205fef054e22d1b1d19a3fcf12ede3b7e88b8',
  );
  const c = new Harness().contract;
  for (const mode of ['prepare', 'admit'])
    assert.equal(
      c.trHash(
        fixture.hashPrefixes[mode] +
          JSON.stringify(c.trRequest(fixture.requests[mode], mode === 'admit')),
      ),
      fixture.requestHashes[mode],
    );
  assert.equal(c.trOperationId(fixture.claims.admit), fixture.ids.operationId);
  assert.equal(c.trPublicId(fixture.ids.providerExerciseId), fixture.ids.targetId);
  assert.deepEqual(
    c.trCapsule(fixture.requests.admit.preparation),
    fixture.requests.admit.preparation,
  );
});
test('whole preparation -> admission -> canonical subscription writer -> exact receipt -> fresh read', () => {
  const h = new Harness();
  const prepare = h.run('prepare');
  assert.deepEqual(prepare.payload, fixture.responses.preparation);
  assert.equal(h.rows.size, 0);
  assert.ok(h.calls.every((c) => !['insert', 'update'].includes(c.kind) && c.method !== 'POST'));
  const result = h.run();
  assert.equal(result.payload.status, 'CONFIRMED', JSON.stringify(result.payload));
  const receipt = result.payload.receipt;
  assert.equal(receipt.providerBookingId, booking.id);
  assert.equal(receipt.authority, 'LK1_SUBSCRIPTION');
  assert.equal(
    h.calls.filter((c) => c.method === 'POST' && c.url.startsWith('https://api.vivacrm.ru')).length,
    1,
  );
  const before = JSON.stringify([...h.rows]);
  h.now += 120000;
  assert.equal(h.run('read').payload.status, 'CONFIRMED');
  assert.equal(JSON.stringify([...h.rows]), before);
});
test('unknown method/scope/route/version/token/body and signed false recovery are rejected before reads', () => {
  for (const change of [
    { scope: 'subscription-runtime.booked-operation.admit' },
    { contract_version: 2 },
    { method: 'GET' },
    { path: '/wrong' },
    { recovery_only: false },
    { actor_token_sha256: hash('foreign') },
  ]) {
    const h = new Harness();
    const r = h.run('admit', change);
    assert.ok(r.statusCode >= 400, JSON.stringify(change));
    assert.equal(h.calls.length, 0);
  }
});
test('missing config, managed selection and matched zero-charge rules cannot dispatch', () => {
  const pid = exercise.availableClientSubscriptions[0].productId;
  const rule = {
    productId: pid,
    planKey: 'synthetic',
    enforceFrom: null,
    maxActiveBookings: 4,
    freeGameMinutesPerDay: 60,
    gameOverageDiscountPercent: 100,
    groupTrainingDiscountPercent: 100,
    tournamentDiscountPercent: 100,
  };
  for (const globals of [
    { subscriptions_managed_enforcement_product_ids: undefined },
    { subscriptions_lk1_plan_rules: null },
    { subscriptions_lk1_plan_rules: { formatVersion: 1, rules: [rule] } },
  ]) {
    const h = new Harness({ globals });
    assert.notEqual(h.run().payload.status, 'CONFIRMED');
    assert.equal(h.calls.filter((c) => c.method === 'POST').length, 0);
  }
});
test('old owner probe and duplicate public target refuse without durable writes', () => {
  for (const options of [{ oldCapability: true }, { schedule: [exercise, exercise] }]) {
    const h = new Harness(options);
    assert.notEqual(h.run().payload.status, 'CONFIRMED');
    assert.equal(h.rows.size, 0);
    assert.equal(h.calls.filter((c) => c.method === 'POST').length, 0);
  }
});
test('lost provider ACK is UNKNOWN and fresh exact recovery never adopts or repeats POST', () => {
  const h = new Harness({ loseProviderAck: true });
  assert.equal(h.run().payload.status, 'UNKNOWN');
  h.now += 121000;
  assert.equal(h.run('admit', { recovery_only: true }).payload.status, 'UNKNOWN');
  assert.equal(
    h.calls.filter((c) => c.method === 'POST' && c.url.startsWith('https://api.vivacrm.ru')).length,
    1,
  );
});
test('lost local acceptance ACK recovers original booking across selector drift without new POST', () => {
  const h = new Harness({ loseMongoAck: 'operation_accept' });
  assert.equal(h.run().payload.status, 'UNKNOWN');
  h.now += 121000;
  h.globals.subscriptions_lk1_plan_rules = null;
  const result = h.run('admit', { recovery_only: true });
  assert.equal(result.payload.status, 'CONFIRMED', JSON.stringify(result.payload));
  assert.equal(
    h.calls.filter((c) => c.method === 'POST' && c.url.startsWith('https://api.vivacrm.ru')).length,
    1,
  );
});
test('read refuses cancellation, rejoined booking, waitlist, foreign actor and contradictory statuses', () => {
  const h = new Harness();
  assert.equal(h.run().payload.status, 'CONFIRMED');
  for (const changed of [
    { status: 'CANCELLED' },
    { id: 'replacement-booking' },
    { status: 'WAITLIST' },
    { clientId: 'foreign-client' },
    { status: 'CONFIRMED', bookingStatus: 'CANCELLED' },
  ]) {
    h.options.bookings = [{ ...booking, ...changed }];
    const before = JSON.stringify([...h.rows]);
    assert.equal(h.run('read').payload.status, 'UNKNOWN');
    assert.equal(JSON.stringify([...h.rows]), before);
  }
});
test('interleaved same-key admissions use atomic CAS and exactly one provider booking', () => {
  const first = new Harness(),
    second = new Harness();
  second.rows = first.rows;
  let raced = false;
  first.options.beforeMongo = (msg, kind) => {
    if (!raced && kind === 'update' && msg._trainingRegistration?.step === 'claim_ack') {
      raced = true;
      assert.equal(second.run().payload.status, 'CONFIRMED');
    }
  };
  assert.equal(first.run().payload.status, 'PENDING');
  assert.equal(
    [...first.calls, ...second.calls].filter(
      (c) => c.method === 'POST' && c.url.startsWith('https://api.vivacrm.ru'),
    ).length,
    1,
  );
});
test('stale attempt cannot dispatch after another lease token replaces it', () => {
  const h = new Harness({
    beforeHttp: (msg, self) => {
      if (msg._trainingRegistration?.step === 'owner')
        self.rows.get(fixture.ids.operationId).attemptId = '88888888-8888-4888-8888-888888888888';
    },
  });
  assert.equal(h.run().payload.status, 'UNKNOWN');
  assert.equal(
    h.calls.filter((c) => c.method === 'POST' && c.url.startsWith('https://api.vivacrm.ru')).length,
    0,
  );
});
test('capsule expiry applies to new writes; exact terminal replay survives expiry with fresh actor proof', () => {
  const expired = new Harness();
  expired.now += 61000;
  assert.equal(expired.run().statusCode, 409);
  assert.equal(expired.rows.size, 0);
  const h = new Harness();
  assert.equal(h.run().payload.status, 'CONFIRMED');
  h.now += 121000;
  assert.equal(h.run().payload.status, 'CONFIRMED');
  const changed = structuredClone(fixture.requests.admit);
  changed.preparation.observedAt = new Date(h.now).toISOString();
  changed.preparation.expiresAt = new Date(h.now + 60000).toISOString();
  const core = { ...changed.preparation };
  delete core.sha256;
  changed.preparation.sha256 = hash(fixture.hashPrefixes.capsule + JSON.stringify(core));
  assert.equal(
    h.run(
      'admit',
      { request_sha256: hash(fixture.hashPrefixes.admit + JSON.stringify(changed)) },
      changed,
    ).statusCode,
    409,
  );
});
test('direct restrictive context without durable admission is not authority', () => {
  const h = new Harness();
  const r = h.canonical({
    req: { headers: { authorization: `Bearer ${actor}` } },
    payload: structuredClone(fixture.canonicalOwner.request),
  });
  assert.equal(r.payload.state, 'UNKNOWN');
  assert.equal(h.rows.size, 0);
  assert.equal(h.calls.filter((c) => c.method === 'POST').length, 0);
});
test('unbound canonical rows cannot be adopted; new journal kind cannot match daily selectors', () => {
  const h = new Harness();
  h.rows.set('foreign-canonical', {
    _id: 'foreign-canonical',
    tenantKey: 'iSkq6G',
    actorClientId: fixture.ids.providerClientId,
    operationId: fixture.ids.operationId,
    state: 'CONFIRMED',
    bookingId: booking.id,
  });
  assert.equal(h.run().payload.status, 'UNKNOWN');
  assert.equal(h.calls.filter((c) => c.method === 'POST').length, 0);
  const outer = h.rows.get(fixture.ids.operationId);
  for (const key of ['actorClientId', 'clientSubscriptionId', 'exerciseId', 'serviceDate', 'lk1'])
    assert.equal(Object.hasOwn(outer, key), false);
});
test('no credentials/proofs in journal or response; diagnostics suppressed for training', () => {
  let observed = 0;
  const h = new Harness({
    loseCallback: true,
    globals: {
      lkDiagnostics: {
        observe() {
          observed++;
        },
      },
    },
  });
  const result = h.run();
  assert.equal(result.payload.status, 'CONFIRMED');
  assert.equal(observed, 0);
  const serialized = JSON.stringify({ rows: [...h.rows], result });
  for (const privateValue of [
    'synthetic-training-actor-credential',
    'synthetic-admin-credential',
    'x-subscription-actor-delegation',
    ['BEGIN', 'PRIVATE KEY'].join(' '),
  ])
    assert.equal(serialized.includes(privateValue), false);
  const msg = {
    _subscriptionBooking: {
      trainingRegistration: fixture.canonicalOwner.request.trainingRegistration,
      operationId: fixture.ids.operationId,
    },
    headers: { Authorization: 'private' },
    req: { headers: { authorization: 'private', 'x-subscription-owner-evidence': 'private' } },
    payload: { ...fixture.canonicalOwner.confirmation, debugToken: 'private' },
  };
  const out = h.functions.finalize(msg)[1];
  assert.equal(out.payload.state, 'UNKNOWN');
  assert.equal(JSON.stringify(out).includes('private'), false);
});
test('wrong actor, target aliases, subscription ownership, category and incomplete lists fail before writer', () => {
  for (const options of [
    { profile: { id: 'foreign-client' } },
    { exercise: { ...exercise, startsAt: '2035-04-02T14:00:00.000Z' } },
    { exercise: { ...exercise, direction: { id: 6306 }, type: { id: 2349 } } },
    {
      exercise: {
        ...exercise,
        availableClientSubscriptions: [
          { ...exercise.availableClientSubscriptions[0], clientId: 'foreign-client' },
        ],
      },
    },
    {
      onHttp: (msg) => {
        if (msg._trainingRegistration?.step === 'schedule') msg.payload.last = false;
      },
    },
  ]) {
    const h = new Harness(options);
    assert.notEqual(h.run().payload.status, 'CONFIRMED');
    assert.equal(h.calls.filter((c) => c.method === 'POST').length, 0);
    assert.equal(h.rows.size, 0);
  }
});
test('canonical managed selector and PRO rules are actual shared source, not price/name inference', () => {
  const piter = '8bf334ba-3050-4017-b40a-7eef2db1eb16';
  const managed = new Harness({
    exercise: {
      ...exercise,
      availableClientSubscriptions: [
        {
          ...exercise.availableClientSubscriptions[0],
          productId: piter,
          purchaseDate: '2034-01-01',
        },
      ],
    },
    globals: {
      subscriptions_managed_enforcement_product_ids: [piter],
      subscriptions_runtime_environment: 'PROD',
    },
  });
  assert.notEqual(managed.run().payload.status, 'CONFIRMED');
  assert.equal(managed.calls.filter((c) => c.method === 'POST').length, 0);
  const pro = new Harness({
    exercise: { ...exercise, direction: { id: 5507, name: 'Synthetic ПРО training' } },
  });
  assert.notEqual(pro.run().payload.status, 'CONFIRMED');
  assert.equal(pro.calls.filter((c) => c.method === 'POST').length, 0);
});
test('completed canonical operation with lost outer ACK is reachable through original recovery-only admission', () => {
  const h = new Harness();
  assert.equal(h.run().payload.status, 'CONFIRMED');
  const outer = h.rows.get(fixture.ids.operationId);
  outer.state = 'ATTEMPTING';
  delete outer.receipt;
  outer.leaseUntil = new Date(h.now + 120000).toISOString();
  h.now += 121000;
  h.globals.subscriptions_lk1_plan_rules = null;
  assert.equal(h.run('admit', { recovery_only: true }).payload.status, 'CONFIRMED');
  assert.equal(
    h.calls.filter((c) => c.method === 'POST' && c.url.startsWith('https://api.vivacrm.ru')).length,
    1,
  );
});
test('active lease duplicate, missing canonical recovery and foreign issuer binding never dispatch', () => {
  const h = new Harness({ loseProviderAck: true });
  assert.equal(h.run().payload.status, 'UNKNOWN');
  assert.equal(h.run('admit', { recovery_only: true }).payload.status, 'PENDING');
  const posts = h.calls.filter((c) => c.method === 'POST').length;
  h.now += 121000;
  for (const [key, row] of h.rows)
    if (row.kind !== 'TRAINING_REGISTRATION_ADMISSION') h.rows.delete(key);
  assert.equal(h.run('admit', { recovery_only: true }).payload.status, 'UNKNOWN');
  assert.equal(h.calls.filter((c) => c.method === 'POST').length, posts);
  assert.equal(
    h.run('read', { provider_mapping_id: '99999999-9999-4999-8999-999999999999' }).statusCode,
    409,
  );
});
test('cancelled or archived exercise flags deny preparation, initial dispatch, recovery and fresh read', () => {
  for (const flag of ['isCancelled', 'cancelled', 'canceled', 'archived']) {
    const h = new Harness({ exercise: { ...exercise, [flag]: true } });
    assert.notEqual(h.run('prepare').payload.nonBinding, true);
    assert.notEqual(h.run().payload.status, 'CONFIRMED');
    assert.equal(h.calls.filter((c) => c.method === 'POST').length, 0);
    const read = new Harness();
    assert.equal(read.run().payload.status, 'CONFIRMED');
    read.options.bookings = [{ ...booking, exercise: { ...booking.exercise, [flag]: true } }];
    assert.equal(read.run('read').payload.status, 'UNKNOWN');
    const recovery = new Harness({ loseMongoAck: 'operation_accept' });
    assert.equal(recovery.run().payload.status, 'UNKNOWN');
    recovery.now += 121000;
    recovery.options.bookings = [{ ...booking, exercise: { ...booking.exercise, [flag]: true } }];
    assert.equal(recovery.run('admit', { recovery_only: true }).payload.status, 'UNKNOWN');
  }
});

test('ordinary unbound or background callbacks cannot reclaim persisted training operation', () => {
  const h = new Harness();
  assert.equal(h.run().payload.status, 'CONFIRMED');
  const row = [...h.rows.values()].find((r) => r.trainingRegistrationBinding);
  for (const caller of [undefined, 'background']) {
    const before = JSON.stringify([...h.rows]);
    const out = h.functions.canonical({
      _subscriptionBooking: {
        step: 'operation_find',
        operationId: fixture.ids.operationId,
        caller,
      },
      payload: [structuredClone(row)],
    });
    assert.equal(out.findIndex(Boolean), 4);
    assert.equal(out[4].payload.details.code, 'TRAINING_REGISTRATION_BINDING_REQUIRED');
    assert.equal(JSON.stringify([...h.rows]), before);
  }
});
test('read cannot replace stored terminal receipt with a changed canonical booking', () => {
  const h = new Harness();
  assert.equal(h.run().payload.status, 'CONFIRMED');
  const row = [...h.rows.values()].find((r) => r.trainingRegistrationBinding);
  row.bookingId = 'replacement-booking';
  row.upstreamBookingId = 'replacement-booking';
  h.options.bookings = [{ ...booking, id: 'replacement-booking' }];
  assert.equal(h.run('read').payload.status, 'UNKNOWN');
});
