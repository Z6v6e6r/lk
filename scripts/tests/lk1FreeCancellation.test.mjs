import assert from 'node:assert/strict';
import test from 'node:test';
import { lk1FreeBegin, lk1FreeBinding, lk1FreeJobKey, lk1FreeReturnedOperation } from '../lib/lk1FreeCancellation.mjs';
import { runLk1FreeCancellationJob, createLk1FreeCancellationProvider } from '../lib/lk1FreeCancellationWorker.mjs';
import { pollNativeSubscriptionCancellation, nativeSubscriptionCancellationVerified } from '../../src/utils/nativeSubscriptionCancellation.ts';

import {fixture,drive,jobOf,instant,requestId} from './fixtures/lk1FreeCancellationFixtures.mjs';

test('server-owned native cancellation returns one visit, retains original evidence and needs no guard deletion', async () => {
  const f = fixture(), before = structuredClone(f.op);
  assert.equal((await drive(f)).payload.state, 'RELEASED');
  const op = f.db.rows.get(f.op._id);
  assert.ok(lk1FreeReturnedOperation(op)); assert.equal(f.sub.visitsLeft, 29);
  assert.deepEqual(op.lk1.decision, before.lk1.decision); assert.deepEqual(op.lk1.rule, before.lk1.rule);
  assert.equal(op.lk1.fingerprint, before.lk1.fingerprint); assert.equal(jobOf(f).phase, 'DONE');
  assert.equal(f.provider.calls.filter(c => c.method === 'PUT').length, 1);
  assert.ok(f.db.writes.every(w => !String(w.query._id).startsWith('lk1-daily-visit:')));
  assert.equal((await drive(f)).payload.state, 'RELEASED');
  assert.equal(f.provider.calls.filter(c => c.method === 'PUT').length, 1);
});
test('only the exact native zero-money operation is eligible; foreign or ambiguous ownership never falls back', async () => {
  for (const change of [f => { f.b.clientId = 'other'; }, f => { f.op.lk1.decision = undefined; },
    f => { f.op.lk1.visitJob = {}; }, f => { f.op.managedEntitlementOperationId = 'cup-operation'; },
    f => { f.db.rows.set('duplicate', { ...f.op, _id: 'duplicate' }); }]) {
    const f = fixture(); change(f); f.db.rows.set(f.op._id, structuredClone(f.op));
    assert.notEqual((await drive(f)).payload.state, 'NOT_MANAGED');
    assert.equal(f.provider.calls.filter(c => c.method === 'PUT').length, 0);
  }
  const outside = fixture(); outside.b.paymentType = 'ON_PLACE';
  assert.equal((await drive(outside)).payload.state, 'NOT_MANAGED');
});
test('missing, incomplete or conflicting consumption baselines cannot authorize SERVICE', async () => {
  for (const change of [f => { f.sub.visitsTotal++; }, f => { f.sub.bookings.pop(); },
    f => { f.sub.bookings[1].id = 'booking'; }, f => { f.sub.product.id = 'other'; },
    f => { f.b.cancelled = true; }, f => { f.b.clientSubscriptionId = 'other'; }]) {
    const f = fixture(); change(f);
    assert.notEqual((await drive(f)).payload.state, 'RELEASED');
    assert.equal(f.provider.calls.filter(c => c.method === 'PUT').length, 0);
    assert.equal(f.db.rows.get(f.op._id).state, 'CONFIRMED');
  }
});
test('SERVICE unavailable and an in-flight debit decline before dispatch, without a deadlock', async () => {
  const f = fixture();
  f.db.rows.set('pending', { ...f.op, _id: 'pending', bookingId: 'pending-booking', state: 'PREPARED' });
  assert.equal((await drive(f)).payload.details.code, 'LK1_FREE_CANCEL_VISIT_IN_FLIGHT');
  assert.equal(jobOf(f).phase, 'DECLINED'); assert.equal(f.provider.calls.filter(c => c.method === 'PUT').length, 0);
  f.db.rows.get('pending').state = 'CONFIRMED';
  assert.equal((await drive(f, lk1FreeBegin({tenantKey:'fixture',actorClientId:'actor',bookingId:'booking',requestId:'next-cancel-request'}))).payload.state, 'RELEASED', 'a later explicit submission uses a new immutable job');
  assert.equal(jobOf(f).phase, 'DECLINED', 'a terminal decline is never restarted under a stale lock');
});
test('different concurrent consumption changes or top-ups keep the reservation until verified', async () => {
  for (const change of [f => { f.sub.visitsTotal++; f.sub.visitsLeft++; },
    f => { f.sub.bookings.push({ ...f.b, id: 'new-booking' }); f.sub.visitsLeft--; },
    f => { f.sub.bookings = []; f.sub.visitsLeft++; },
    f => { f.sub.visitsLeft--; }, f => { f.sub.bookings[0].exerciseId = 'changed'; }]) {
    const f = fixture(); f.provider.afterPut = () => change(f);
    assert.equal((await drive(f)).payload.details.code, 'LK1_FREE_CANCEL_RETURN_UNVERIFIED');
    assert.equal(f.db.rows.get(f.op._id).state, 'CONFIRMED');
    const count = f.provider.calls.length;
    const result = await runLk1FreeCancellationJob({ job: structuredClone(jobOf(f)), operations: f.db, provider: f.provider, now: () => instant });
    assert.notEqual(result.state, 'RELEASED');
    assert.ok(f.provider.calls.slice(count).every(c => c.method === 'GET'));
  }
});
test('lost provider reply is reconciled after browser closure without another cancellation', async () => {
  const f = fixture(); f.provider.putMode = 'LOST_ACK';
  assert.equal((await drive(f)).status, 202); assert.equal(jobOf(f).phase, 'CANCEL_INTENT');
  assert.equal((await runLk1FreeCancellationJob({ job: structuredClone(jobOf(f)), operations: f.db,
    provider: f.provider, now: () => instant })).state, 'RELEASED');
  assert.equal(f.provider.calls.filter(c => c.method === 'PUT').length, 1);
  assert.ok(lk1FreeReturnedOperation(f.db.rows.get(f.op._id)));
});
test('lost intent ACK never dispatches or repeats PUT, even when the row was committed', async () => {
  const f = fixture(); f.db.afterWrite = (_query, change, ack) => change.$set?.phase === 'CANCEL_INTENT' ? { acknowledged: false } : ack;
  assert.equal((await drive(f)).payload.details.code, 'LK1_FREE_CANCEL_INTENT_ACK_UNKNOWN');
  f.db.afterWrite = null;
  await runLk1FreeCancellationJob({ job: structuredClone(jobOf(f)), operations: f.db, provider: f.provider, now: () => instant });
  assert.equal(f.provider.calls.filter(c => c.method === 'PUT').length, 0);
  assert.equal(f.db.rows.get(f.op._id).state, 'CONFIRMED');
});
test('parallel server and worker contenders have one intent winner and one provider PUT', async () => {
  const f = fixture();
  const [a, b] = await Promise.all([drive(f), drive(f)]);
  assert.ok([a.payload.state, b.payload.state].includes('RELEASED'));
  assert.equal(f.provider.calls.filter(c => c.method === 'PUT').length, 1);
  assert.equal((await drive(f)).payload.state, 'RELEASED');
});
test('release CAS drift does not overwrite the operation or manufacture a return proof', async () => {
  const f = fixture(); f.provider.afterPut = () => { f.db.rows.get(f.op._id).updatedAt = '2099-11-11T11:59:00Z'; };
  assert.equal((await drive(f)).payload.details.code, 'LK1_FREE_CANCEL_RELEASE_UNVERIFIED');
  assert.equal(f.db.rows.get(f.op._id).state, 'CONFIRMED');
});
test('a stop after durable intent leaves recoverable evidence and never writes during shutdown', async () => {
  const f = fixture(), binding = lk1FreeBinding(f.op);
  f.db.rows.set(lk1FreeJobKey(binding, requestId), { _id: lk1FreeJobKey(binding, requestId), kind: 'LK1_FREE_CANCEL_JOB_V1',
    tenantKey: 'fixture', clientSubscriptionId: 'subscription', requestId, binding, phase: 'QUEUED', method: 'SERVICE', updatedAt: instant });
  let stopped = false; f.db.afterWrite = (_q, change, ack) => { if (change.$set?.phase === 'CANCEL_INTENT') stopped = true; return ack; };
  assert.equal((await runLk1FreeCancellationJob({ job: structuredClone(jobOf(f)), operations: f.db,
    provider: f.provider, shouldStop: () => stopped, now: () => instant })).state, 'STOPPED');
  assert.equal(f.provider.calls.filter(c => c.method === 'PUT').length, 0);
});
test('native client waits for verified release, binds the booking and never falls back on an uncertain response', async () => {
  let calls = 0;
  const result = await pollNativeSubscriptionCancellation('native-client', async () => ++calls < 3
    ? { data: { state: 'PENDING_CONFIRMATION', accepted:true, bookingId: 'native-client' }, status: 202, error: null }
    : { data: { state: 'RELEASED', bookingId: 'native-client', operationId: 'original' }, status: 200, error: null },
  { attempts: 3, wait: async () => {},session:()=> 'session-a' });
  assert.equal(result.status, 200); assert.ok(nativeSubscriptionCancellationVerified('native-client','session-a'));
  for (const status of [400, 401, 404, 500]) {
    const r = await pollNativeSubscriptionCancellation('unknown-client', async () => ({ data: null,
      status, error: { status, message: 'unavailable' } }), { attempts: 1 });
    assert.ok(r.error); assert.equal(nativeSubscriptionCancellationVerified('unknown-client','session-a'), null);
  }
  const r = await pollNativeSubscriptionCancellation('pending-client', async () => ({ data: {
    state: 'PENDING_CONFIRMATION', accepted:true, bookingId: 'pending-client' }, error: null, status: 202 }), { attempts: 1 });
  assert.equal(r.status, 202); assert.ok(r.error); assert.equal(nativeSubscriptionCancellationVerified('pending-client','session-a'), null);
});
test('provider adapter refuses non-Viva origins and honours stop after acquiring credentials', async () => {
  assert.throws(() => createLk1FreeCancellationProvider({ token: async () => 'fixture', baseUrl: 'https://other.invalid' }));
  let stopped = false, sends = 0;
  const provider = createLk1FreeCancellationProvider({ token: async () => { stopped = true; return 'fixture'; },
    fetchImpl: async () => { sends++; throw Error('must not send'); } });
  await provider.request({ method: 'PUT', path: '/api/v1/clients/a/bookings/b/cancel' }, () => stopped);
  assert.equal(sends, 0);
});

test('async timestamps complete the inline job using the exact persisted intent timestamp', async () => {
  const f = fixture(); let clock = Date.parse(instant);
  assert.equal((await drive(f, undefined, () => new Date(clock += 17).toISOString())).payload.state, 'RELEASED');
  assert.equal(jobOf(f).phase, 'DONE');
});
test('prequeue failures and missing durable ACK never promise accepted background work', async () => {
  const f = fixture(); f.provider.request = async () => { throw Error('unavailable'); };
  const first = await drive(f); assert.equal(first.status, 503); assert.equal(first.payload.accepted, false);
  const g = fixture(); g.db.afterWrite = (_q, change, ack) => change.$inc?.durableReadbacks ? { acknowledged: false } : ack;
  const unconfirmed = await drive(g); assert.equal(unconfirmed.status, 503); assert.equal(unconfirmed.payload.accepted, false);
  assert.equal(g.provider.calls.filter(c => c.method === 'PUT').length, 0);
});
test('new explicit request after a lost reply attaches to the same immutable pending job', async () => {
  const f = fixture(); f.provider.putMode = 'LOST_ACK';
  assert.equal((await drive(f)).status, 202);
  const later = lk1FreeBegin({tenantKey:'fixture',actorClientId:'actor',bookingId:'booking',requestId:'another-explicit-request'});
  assert.equal((await drive(f, later)).payload.state, 'RELEASED');
  assert.equal(f.provider.calls.filter(c => c.method === 'PUT').length, 1);
  assert.equal([...f.db.rows.values()].filter(r => r.kind === 'LK1_FREE_CANCEL_JOB_V1').length, 1);
});
test('DECLINED is immutable and a delayed old request never resets it or dispatches', async () => {
  const f = fixture(); f.db.rows.set('pending', {...f.op,_id:'pending',bookingId:'other',state:'PREPARED'});
  assert.equal((await drive(f)).payload.state,'DECLINED');const frozen=structuredClone(jobOf(f));
  f.db.rows.get('pending').state='CONFIRMED';
  assert.equal((await drive(f)).payload.state,'DECLINED');
  assert.equal(jobOf(f).phase,frozen.phase);assert.equal(f.provider.calls.filter(c=>c.method==='PUT').length,0);
});
test('session switch and logout invalidate native cancellation confirmations', async () => {
  let session='owner-a';
  const send=async()=>({data:{state:'RELEASED',bookingId:'session-booking',operationId:'original'},status:200,error:null});
  await pollNativeSubscriptionCancellation('session-booking',send,{session:()=>session});
  assert.ok(nativeSubscriptionCancellationVerified('session-booking',session));
  assert.equal(nativeSubscriptionCancellationVerified('session-booking','owner-b'),null);
  assert.equal(nativeSubscriptionCancellationVerified('session-booking',null),null);
  const result=await pollNativeSubscriptionCancellation('session-booking',async()=>{session='owner-b';return send();},{session:()=>session});
  assert.equal(result.status,409);assert.equal(nativeSubscriptionCancellationVerified('session-booking',session),null);
});
test('Moscow service date is bound to the event, including a UTC previous-day start', async () => {
  const f=fixture();f.op.lk1.target.startsAt='2099-11-12T21:30:00Z';f.db.rows.set(f.op._id,structuredClone(f.op));
  assert.equal((await drive(f)).payload.state,'RELEASED');
  const g=fixture();g.op.serviceDate='2099-11-12';g.db.rows.set(g.op._id,structuredClone(g.op));
  assert.notEqual((await drive(g)).payload.state,'RELEASED');
  assert.equal(g.provider.calls.filter(c=>c.method==='PUT').length,0);
});
