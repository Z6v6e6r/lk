import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import test from 'node:test';
import {
  f,
  actor,
  run,
  legacy,
  message,
  accepted,
  capability,
  original,
  freshToInsert,
  ownerDoc,
  terminal,
  readMessage,
  readTerminal,
  hash,
} from './helpers/managedSelfLeaveOwnerHarness.mjs';
test('frozen request hashes, operation id and actual strict admit/read JWT', () => {
  assert.equal(
    hash('managed-self-leave-admission:v1\0' + JSON.stringify(f.request)),
    f.requestSha256,
  );
  assert.ok(accepted());
  assert.ok(run('verify', message('read'))[0]);
});
test('request/actor/scope/path/recovery tampering fails closed before any store message', () => {
  for (const patch of [
    { recovery_only: false },
    { scope: 'subscription-runtime.booked-operation.admit' },
    { contract_version: 2 },
    { provider_mapping_id: 'wrong' },
    { actor_token_sha256: hash('swapped') },
    { actor_token_expires_at: '2000-01-01T00:00:00.000Z' },
    { unknown_claim: true },
  ])
    assert.equal(run('verify', message('admit', patch))[0], null);
  for (const mutate of [
    (m) => (m.payload.reservationId = crypto.randomUUID()),
    (m) => (m.payload.returnMode = 'NONE'),
    (m) => (m.payload.joinReceiptSha256 = hash('forged')),
    (m) => (m.req.originalUrl = '/lk/games/foreign/split/leave'),
    (m) => (m.req.headers['x-subscription-actor-token'] = 'synthetic-swapped-actor-token'),
  ]) {
    const m = message();
    mutate(m);
    assert.equal(run('verify', m)[0], null);
  }
  assert.ok(accepted({ recovery_only: true }));
});
test('fresh admission derives original JOIN and SERVICE eligibility before first journal insertion', () => {
  const { msg, out } = freshToInsert();
  assert.equal(out[1], msg);
  const doc = msg.payload[1].$setOnInsert;
  assert.equal(doc.kind, 'MANAGED_SELF_LEAVE_ADMISSION');
  assert.deepEqual(doc.originalJoinReceipt, f.originalJoinReceipt);
  assert.equal(doc._id, f.identity.operationId);
  assert.equal(doc.actorClientId, undefined);
  assert.equal(doc.serviceDate, undefined);
  assert.equal(doc.lk1, undefined);
  const serialized = JSON.stringify(doc);
  assert.ok(!serialized.includes(actor));
  assert.ok(!serialized.includes('Bearer'));
});
test('foreign original JOIN mapping, paid decision and wrong legacy exercise cannot admit', () => {
  for (const change of ['mapping', 'money', 'game']) {
    const facts = original();
    if (change === 'mapping') facts.stored.providerMappingId = crypto.randomUUID();
    if (change === 'money') facts.booking.managedDecision.money.finalPriceMinor = 1;
    if (change === 'game') facts.game.metadata.vivaExerciseId = 'foreign-exercise';
    if (change === 'mapping') {
      const m = accepted();
      m.payload = [];
      run('router', m);
      capability(m);
      run('router', m);
      m.payload = [facts.stored];
      assert.ok(run('router', m)[7]);
    } else assert.ok(freshToInsert(facts).out[7]);
  }
});
test('recovery-only missing outer record is UNKNOWN and cannot create canonical SELF', () => {
  const msg = accepted({ recovery_only: true });
  msg.payload = [];
  const out = run('router', msg);
  assert.equal(out[7].payload.status, 'UNKNOWN');
  assert.equal(out.filter(Boolean).length, 1);
});
test('exact terminal owner/CUP receipt commits via full admission CAS; lost ACK re-reads without release', () => {
  const doc = ownerDoc();
  const { m, out } = readTerminal(doc);
  assert.equal(out[2], m);
  const [query, update] = m.payload;
  assert.equal(query.bindingSha256, doc.bindingSha256);
  assert.equal(query.state, 'PENDING');
  assert.equal(update.$set.receipt.requestSha256, f.requestSha256);
  const committed = { ...doc, ...update.$set };
  m.error = { message: 'synthetic lost ACK' };
  m.payload = undefined;
  assert.equal(run('router', m)[0], m);
  m.payload = [committed];
  const done = run('router', m)[7];
  assert.equal(done.payload.status, 'CONFIRMED');
  assert.equal(done.payload.receipt.reservationId, f.request.reservationId);
  assert.deepEqual(done.payload.receipt.compensation, f.confirmed.receipt.compensation);
  const replay = readTerminal(committed);
  assert.equal(replay.out[7].payload.status, 'CONFIRMED');
  assert.equal(replay.out[2], null);
});
test('cancelled/returned/DONE alone never confirms without exact original compensation and generation', () => {
  for (const mutate of [
    (x) => (x.booking.managedSelfLeaveReceipt.compensationState = 'PENDING'),
    (x) => (x.booking.managedSelfLeaveReceipt.releaseReason = 'PROVIDER_REJECTED'),
    (x) => (x.booking.managedSelfLeaveReceipt.operationId = 'booking:' + 'e'.repeat(48)),
    (x) => (x.booking.managedSelfLeaveReceipt.providerBookingId = 'new-booking'),
    (x) => (x.leave.membershipVersion = 'new-generation'),
    (x) => (x.leave.bookingIds = ['rejoined-booking']),
    (x) => delete x.leave.managedSelfLeaveOwner,
    (x) => (x.booking.managedSelfLeaveCancellation.binding.serviceDate = '2099-01-01'),
    (x) => (x.booking.managedSelfLeaveCancellation.binding.extra = 'forged'),
    (x) => (x.booking.managedSubscriptionInstanceId = 'foreign-instance'),
  ]) {
    const { out } = readTerminal(ownerDoc(), mutate);
    assert.equal(out[7].payload.status, 'UNKNOWN');
    assert.equal(out[2], null);
  }
});
test('same key changed authoritative request conflicts before provider or canonical dispatch', () => {
  const doc = ownerDoc();
  doc.bindingSha256 = hash('other-binding');
  const { out } = readMessage(doc, 'admit');
  assert.equal(out[7].statusCode, 409);
  assert.equal(out[5], null);
  assert.equal(out[6], null);
});
test('same-key recovery never creates a missing canonical SELF row', () => {
  const doc = ownerDoc();
  doc.state = 'ATTEMPTING';
  const { m, out } = readMessage(doc, 'admit', { recovery_only: true });
  assert.equal(out[3], m);
  m.payload = [];
  const result = run('router', m);
  assert.equal(result[7].payload.status, 'UNKNOWN');
  assert.equal(result[1], null);
  assert.equal(result[6], null);
});
test('ordinary actorKnown authorization remains closed; exact owner context alone enables pinned SELF', () => {
  const doc = ownerDoc();
  const { bind } = terminal(doc);
  const facts = original();
  const base = {
    req: { params: { gameId: doc.legacyGameId } },
    payload: { refundMethod: 'SERVICE' },
    _splitCleanupAuth: {
      verified: true,
      actorClientId: doc.providerClientId,
      actorPhoneNorm: null,
      authHeader: 'Bearer ' + actor,
    },
  };
  const legacyMsg = structuredClone(base);
  assert.ok(legacy('prepare', legacyMsg)[0]);
  legacyMsg.payload = [facts.game];
  assert.equal(legacy('authorize', legacyMsg)[1].statusCode, 403);
  const m = structuredClone(base);
  m._managedSelfLeave = {
    mode: 'admit',
    step: 'canonical',
    canonicalIngress: {
      binding: bind,
      recoveryOnly: false,
      actorTokenExpiresAt: new Date(Date.now() + 60000).toISOString(),
      delegationExpiresAt: Date.now() + 60000,
    },
  };
  assert.ok(legacy('prepare', m)[0]);
  m.payload = [facts.game];
  assert.ok(legacy('authorize', m)[0]);
  assert.deepEqual(m._splitLeaveCtx.initialBookingIds, [doc.originalJoinReceipt.bookingId]);
  assert.equal(m._splitLeaveCtx.operationId, doc.ownerLeaveOperationId);
  const started = legacy('operation_start', m)[0];
  const stored = started.payload[1].$setOnInsert;
  assert.deepEqual(stored.managedSelfLeaveOwner, bind);
  assert.equal(stored.requestedRefundMethod, 'SERVICE');
});
test('bound canonical active lease cannot be stolen by same actor or stale claim', () => {
  const doc = ownerDoc();
  const { leave, bind } = terminal(doc);
  const ctx = {
    managedSelfLeaveOwner: bind,
    mode: 'SELF',
    gameId: doc.legacyGameId,
    operationId: doc.ownerLeaveOperationId,
    actorClientId: doc.providerClientId,
    targetClientId: doc.providerClientId,
    claimToken: 'new-claim',
    membershipVersion: doc.membershipVersion,
    initialBookingIds: [doc.originalJoinReceipt.bookingId],
  };
  const row = {
    ...leave,
    state: 'STARTED',
    claimToken: 'old-claim',
    claimLeaseUntil: new Date(Date.now() + 60000).toISOString(),
  };
  const out = legacy('operation_route', { _splitLeaveCtx: ctx, payload: [row] });
  assert.equal(out[2].statusCode, 202);
  assert.equal(out[0], null);
});

test('durable admission readback precedes lease CAS and exact canonical SELF entry', async () => {
  const { resumeFreshToClaim } = await import('./helpers/managedSelfLeaveOwnerHarness.mjs');
  const doc = ownerDoc();
  const m = resumeFreshToClaim(doc);
  const query = m.payload[0];
  assert.equal(query.state, 'PENDING');
  assert.equal(query.bindingSha256, doc.bindingSha256);
  assert.deepEqual(query.leaseToken, { $exists: false });
  m.payload = { acknowledged: true, matchedCount: 1, modifiedCount: 1 };
  assert.equal(run('router', m)[6], m);
  assert.deepEqual(m.payload, { refundMethod: 'SERVICE' });
  assert.equal(
    m._managedSelfLeave.canonicalIngress.binding.reservationId,
    doc.request.reservationId,
  );
  assert.equal(legacy('prepare', m)[0], m);
  m.payload = [original().game];
  assert.equal(legacy('authorize', m)[0], m);
  assert.equal(legacy('operation_start', m)[0], m);
  const row = m.payload[1].$setOnInsert;
  assert.equal(row.managedSelfLeaveOwner.providerBookingId, doc.originalJoinReceipt.bookingId);
  assert.equal(row.claimToken, m._splitLeaveCtx.claimToken);
  m.payload = [row];
  assert.equal(legacy('operation_route', m)[0], m);
  assert.equal(legacy('router', m)[0], m);
  assert.equal(m.method, 'GET');
  assert.match(m.url, /bookings\?size=1000$/);
});
test('ambiguous/missed outer claim ACK never enters canonical SELF or issues cancellation', async () => {
  const { resumeFreshToClaim } = await import('./helpers/managedSelfLeaveOwnerHarness.mjs');
  for (const result of [
    undefined,
    { acknowledged: false },
    { acknowledged: true, matchedCount: 0, modifiedCount: 0 },
    { acknowledged: true, matchedCount: 1, modifiedCount: 0 },
  ]) {
    const m = resumeFreshToClaim(ownerDoc());
    m.payload = result;
    const out = run('router', m);
    assert.equal(out[7].payload.status, 'UNKNOWN');
    assert.equal(out[6], null);
  }
});
test('SERVICE unavailable, wrong provider actor, transport error and redirect cannot insert or cancel', () => {
  for (const mutate of [
    (m) =>
      (m.payload = {
        cancellationOptions: { currency: { available: true }, subscription: { available: false } },
      }),
    (m) => (m.error = { message: 'timeout' }),
    (m) => (m.responseUrl = 'https://other.test'),
    (m) => (m.statusCode = 503),
  ]) {
    const { msg } = freshToInsert();
    msg._managedSelfLeave.step = 'service';
    msg.statusCode = 200;
    msg.responseUrl = msg._managedSelfLeave.expectedUrl;
    msg.payload = { cancellationOptions: { subscription: { available: true } } };
    mutate(msg);
    const out = run('router', msg);
    assert.ok(out[7]);
    assert.equal(out[1], null);
    assert.equal(out[6], null);
  }
  const { msg } = freshToInsert();
  msg._managedSelfLeave.step = 'profile';
  msg.statusCode = 200;
  msg.responseUrl = msg._managedSelfLeave.expectedUrl;
  msg.payload = { id: 'foreign' };
  assert.equal(run('router', msg)[7].statusCode, 403);
});
test('malformed owner expiries cannot bypass private SELF entry freshness', () => {
  const doc = ownerDoc();
  const { bind } = terminal(doc);
  for (const expiry of [null, undefined, 'bad', 0]) {
    const m = {
      req: { params: { gameId: doc.legacyGameId } },
      payload: { refundMethod: 'SERVICE' },
      _splitCleanupAuth: {
        verified: true,
        actorClientId: doc.providerClientId,
        authHeader: 'Bearer ' + actor,
      },
      _managedSelfLeave: {
        step: 'canonical',
        mode: 'admit',
        canonicalIngress: {
          binding: bind,
          actorTokenExpiresAt: expiry,
          delegationExpiresAt: Date.now() + 60000,
        },
      },
    };
    assert.equal(legacy('prepare', m)[1].statusCode, 403);
  }
});
test('fresh or recovered leave never targets the replacement membership', () => {
  const facts = original();
  facts.game.participants = [
    {
      id: f.originalJoinReceipt.providerClientId,
      bookingId: 'new-booking',
      membershipId: 'new-generation',
      status: 'CONFIRMED',
    },
  ];
  assert.equal(freshToInsert(facts).out[7].payload.status, 'UNKNOWN');
  const doc = ownerDoc();
  const { bind } = terminal(doc);
  const m = {
    req: { params: { gameId: doc.legacyGameId } },
    payload: { refundMethod: 'SERVICE' },
    _splitCleanupAuth: {
      verified: true,
      actorClientId: doc.providerClientId,
      authHeader: 'Bearer ' + actor,
    },
    _managedSelfLeave: {
      step: 'canonical',
      mode: 'admit',
      canonicalIngress: {
        binding: bind,
        actorTokenExpiresAt: new Date(Date.now() + 60000).toISOString(),
        delegationExpiresAt: Date.now() + 60000,
      },
    },
  };
  legacy('prepare', m);
  m.payload = [facts.game];
  assert.equal(legacy('authorize', m)[1].statusCode, 409);
});

test('terminal ACK loss followed by canonical rejoin replays immutable original receipt without store/provider dispatch', () => {
  const doc = ownerDoc();
  const { m } = readTerminal(doc);
  const committed = { ...doc, ...m.payload[1].$set };
  for (const mode of ['read', 'admit']) {
    const replay = readMessage(committed, mode, mode === 'admit' ? { recovery_only: true } : {});
    assert.equal(replay.out[7].payload.status, 'CONFIRMED');
    assert.equal(replay.out.filter(Boolean).length, 1);
    assert.equal(replay.out[7].payload.receipt.reservationId, doc.request.reservationId);
    assert.equal(
      replay.out[7].payload.receipt.providerBookingId,
      doc.originalJoinReceipt.bookingId,
    );
  }
});
test('corrupt terminal receipt, actor/mapping/hash and pre-proof legacy row never replay success', () => {
  const doc = ownerDoc();
  const { m } = readTerminal(doc);
  const committed = { ...doc, ...m.payload[1].$set };
  for (const mutate of [
    (d) => (d.receipt.providerBookingId = 'new-booking'),
    (d) => (d.receipt.reservationId = crypto.randomUUID()),
    (d) => (d.receipt.requestSha256 = hash('forged')),
    (d) => (d.receipt.compensation.releaseReason = 'PROVIDER_REJECTED'),
    (d) => (d.receipt.compensation.extra = 'forged'),
    (d) => (d.receipt.joinReceiptSha256 = hash('wrong-join')),
    (d) => (d.receipt.unknown = true),
    (d) => delete d.receiptSha256,
    (d) => (d.receiptSha256 = hash('mismatch')),
    (d) => (d.userId = crypto.randomUUID()),
    (d) => (d.providerMappingId = crypto.randomUUID()),
    (d) => (d.receipt.completedAt = '2099-01-01T00:00:00.000Z'),
    (d) => (d.idempotencyKeySha256 = hash('changed-key')),
  ]) {
    const changed = structuredClone(committed);
    mutate(changed);
    const { out } = readMessage(changed);
    assert.ok(out[7]);
    assert.notEqual(out[7].payload.status, 'CONFIRMED');
    assert.equal(out[6], null);
  }
});
test('canonical cancellation requires exact original SERVICE and a fresh delegated actor immediately before DELETE', () => {
  const doc = ownerDoc();
  const { bind } = terminal(doc);
  const make = () => ({
    _splitLeaveCtx: {
      managedSelfLeaveOwner: bind,
      mode: 'SELF',
      requestedRefundMethod: 'SERVICE',
      actorClientId: doc.providerClientId,
      targetClientId: doc.providerClientId,
      exerciseId: bind.providerExerciseId,
      membershipVersion: bind.membershipVersion,
      step: 'snapshot_subscription_before',
      currentBookingId: bind.providerBookingId,
      currentClientId: bind.providerClientId,
      currentRefundMethod: 'SERVICE',
      clientSubscriptionId: bind.providerClientSubscriptionId,
      expectedReturnCount: 1,
      bookingResults: [],
      trace: [],
      managedOwnerActorExpiresAt: new Date(Date.now() + 60000).toISOString(),
      managedOwnerDelegationExpiresAt: Date.now() + 60000,
      upstreamAuthHeader: 'Bearer ' + actor,
    },
    statusCode: 200,
    payload: [
      {
        subscriptionId: bind.providerClientSubscriptionId,
        visitsLeft: 3,
        bookings: [{ id: bind.providerBookingId }],
      },
    ],
  });
  const valid = make();
  assert.equal(legacy('router', valid)[0], valid);
  assert.equal(valid.method, 'DELETE');
  assert.match(valid.url, new RegExp('/bookings/' + bind.providerBookingId + '$'));
  for (const mutate of [
    (m) => (m._splitLeaveCtx.managedOwnerActorExpiresAt = 'invalid'),
    (m) => (m._splitLeaveCtx.managedOwnerDelegationExpiresAt = undefined),
    (m) => (m._splitLeaveCtx.currentRefundMethod = 'CURRENCY'),
    (m) => (m._splitLeaveCtx.currentClientId = 'other-actor'),
    (m) => (m._splitLeaveCtx.currentBookingId = 'replacement'),
  ]) {
    const m = make();
    mutate(m);
    assert.equal(legacy('router', m)[0], null);
    assert.notEqual(m.method, 'DELETE');
  }
});

test('bound failure/finalizer never duplicate private owner proof or credential to debug; ordinary debug remains', () => {
  const doc = ownerDoc();
  const { bind } = terminal(doc);
  const msg = {
    _managedSelfLeave: { privateProof: 'synthetic' },
    _splitLeaveCtx: { managedSelfLeaveOwner: bind, requestedRefundMethod: 'NONE' },
  };
  const failed = legacy('router', msg);
  assert.equal(failed[2], null);
  assert.ok(failed[1]);
  const bound = { _managedSelfLeave: { privateProof: 'synthetic' }, payload: { matchedCount: 0 } };
  assert.equal(legacy('finalize', bound)[1], null);
  const ordinary = { payload: { matchedCount: 0 } };
  assert.equal(legacy('finalize', ordinary)[1], ordinary);
});
test('provider identifiers may compose a canonical operation key longer than a single opaque identifier', () => {
  const facts = original();
  facts.booking._id = 'managed:iSkq6G:' + 's'.repeat(199) + ':' + 'e'.repeat(199) + ':JOIN_GAME';
  const { msg, out } = freshToInsert(facts);
  assert.equal(out[1], msg);
  assert.equal(msg.payload[1].$setOnInsert.bookingOperationKey, facts.booking._id);
});

test('bound canonical SELF rows cannot drop authority through legacy background or ordinary foreground recovery', () => {
  const doc = ownerDoc();
  const { leave } = terminal(doc);
  for (const state of ['STARTED', 'VIVA_CONFIRMED', 'LK_APPLIED', 'RETURN_PENDING', 'DONE']) {
    for (const pin of [leave.managedSelfLeaveOwner, null, {}]) {
      const row = { ...leave, state, managedSelfLeaveOwner: pin };
      const selected = legacy('retry_select', { payload: [row] });
      assert.equal(selected[0], null);
      assert.equal(selected[1].payload.reason, 'managed_owner_foreground_required');
      const ordinary = legacy('operation_route', {
        payload: [row],
        _splitLeaveCtx: {
          mode: 'SELF',
          actorClientId: doc.providerClientId,
          targetClientId: doc.providerClientId,
          claimToken: 'ordinary',
        },
      });
      assert.equal(ordinary[0], null);
      assert.equal(ordinary[3], undefined);
      assert.equal(ordinary[2].payload.state, 'RETRY_REQUIRED');
    }
  }
  const query = legacy('retry_query', {});
  assert.deepEqual(query.payload.managedSelfLeaveOwner, { $exists: false });
  const unbound = { ...leave, state: 'VIVA_CONFIRMED', localApplyAttempts: 0 };
  delete unbound.managedSelfLeaveOwner;
  assert.ok(
    legacy('retry_select', { payload: [unbound] })[0],
    'ordinary legacy retry remains unchanged',
  );
});

test('mixed historical rows cannot select bound owner proof after the initial ordinary row', () => {
  const doc = ownerDoc();
  const { leave } = terminal(doc);
  const ordinary = {
    ...leave,
    operationId: 'self-leave:legacy-ordinary',
    _id: `${doc.legacyGameId}:self-leave:legacy-ordinary`,
    createdAt: '2026-10-30T12:00:00.000Z',
  };
  delete ordinary.managedSelfLeaveOwner;
  const context = (step) => ({
    mode: 'SELF',
    step,
    gameId: doc.legacyGameId,
    game: { updatedAt: '2026-10-31T16:00:00.000Z' },
    exerciseId: doc.originalJoinReceipt.providerExerciseId,
    actorClientId: doc.providerClientId,
    targetClientId: doc.providerClientId,
  });
  for (const step of ['find_absent_self_leave', 'find_local_reconciliation_proof']) {
    for (const pin of [leave.managedSelfLeaveOwner, null, {}, undefined]) {
      const bound = {
        ...leave,
        state: 'RETURN_PENDING',
        createdAt: '2026-10-31T12:00:00.000Z',
        managedSelfLeaveOwner: pin,
      };
      const mixed = { _splitLeaveCtx: context(step), payload: [structuredClone(ordinary), bound] };
      const output = legacy('operation_route', mixed);
      assert.equal(output[0], null);
      assert.equal(output[4], undefined);
      assert.equal(output[2].payload.state, 'RETRY_REQUIRED');
      // A nonmatching first row must not let bound proof seed discovery/recovery.
      const unavailable = {
        _splitLeaveCtx: context(step),
        payload: [{ ...ordinary, gameId: 'foreign-game' }, bound],
      };
      const refused = legacy('operation_route', unavailable);
      assert.equal(refused[0], null);
      assert.equal(refused[4], undefined);
      assert.ok(refused[2]);
    }
    const legacyOnly = { _splitLeaveCtx: context(step), payload: [structuredClone(ordinary)] };
    const output = legacy('operation_route', legacyOnly);
    assert.equal(output[step === 'find_absent_self_leave' ? 4 : 0], legacyOnly);
  }
});
