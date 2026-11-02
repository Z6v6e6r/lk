import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import {
  serviceSnapshot,
  copy,
  run,
  context,
  birth,
  apply,
  casMessage,
  acknowledge,
  finishCas,
  respond,
  booking,
  dispatchIntent,
  recover,
  proof,
} from './helpers/monetarySelfLeaveFenceHarness.mjs';
const now = Date.parse('2026-11-01T10:00:00.000Z');
function first() {
  const h = birth(context(), now);
  h.intent = dispatchIntent(h.msg, 'booking-a', 'CURRENCY', now)[7];
  assert.ok(h.intent);
  return h;
}
function dispatch(h) {
  const ack = finishCas(h.intent, h.row, now);
  assert.ok(ack);
  const out = run('router', ack, now);
  assert.equal(out[0].method, 'DELETE');
  assert.deepEqual(out[0].payload, { refundMethod: 'CURRENCY' });
  assert.equal(out[0].followRedirects, false);
  assert.equal(out[0].requestTimeout, 10000);
  return out[0];
}
test('birth pins original multi-booking and only a newly successful CAS ACK permits DELETE', () => {
  const h = first();
  const command = casMessage(h.intent, now);
  const query = copy(command.payload);
  assert.equal(query[0].monetarySelfLeave.version, 1);
  const result = apply(h.row, query, now);
  assert.equal(result.modifiedCount, 1);
  const out = acknowledge(command, result, now)[0];
  assert.ok(out);
  assert.equal(run('router', out, now)[0].method, 'DELETE');
  assert.equal(apply(h.row, query, now).matchedCount, 0);
  for (const bad of [
    { matchedCount: 1, modifiedCount: 1 },
    { acknowledged: true, matchedCount: '1', modifiedCount: 1 },
    { acknowledged: true, matchedCount: 1, modifiedCount: 0 },
  ]) {
    assert.equal(acknowledge(copy(h.intent), bad, now)[0], null);
  }
});
test('successful DELETE must prove A cancelled before any B request; A active means zero B writes', () => {
  const h = first();
  const sent = dispatch(h);
  const get = respond(sent, {}, 200, now)[0];
  assert.equal(get.method, 'GET');
  let out = respond(
    get,
    { content: [booking('booking-a'), booking('booking-b')], last: true },
    200,
    now,
  );
  out = respond(out[0], { content: [booking('booking-a', true)], last: true }, 200, now);
  assert.equal(out[0], null);
  assert.equal(out[1].statusCode, 202);
  assert.equal(h.row.monetarySelfLeave.markers.length, 1);
});
test('lost CAS ACK has no permit; expired-lease recovery verifies A then can dispatch original B once', () => {
  const h = first();
  const cmd = casMessage(h.intent, now);
  assert.equal(apply(h.row, cmd.payload, now).modifiedCount, 1); // ACK deliberately lost
  assert.equal(recover(h.row, now + 1000)[3] !== undefined, true);
  const tooSoon = casMessage(recover(h.row, now + 1000)[3], now + 1000);
  assert.equal(apply(h.row, tooSoon.payload, now + 1000).matchedCount, 0);
  const later = now + 100_000;
  let msg = finishCas(recover(h.row, later)[3], h.row, later);
  let out = proof(msg, ['booking-b'], ['booking-a'], later);
  assert.ok(out[7]);
  msg = finishCas(out[7], h.row, later);
  out = run('router', msg, later);
  assert.equal(out[0].method, 'GET');
  assert.match(out[0].url, /booking-b\/cancel$/);
  out = respond(out[0], { cancellationOptions: { money: { available: true } } }, 200, later);
  msg = finishCas(out[7], h.row, later);
  out = run('router', msg, later);
  assert.equal(out[0].method, 'DELETE');
  assert.match(out[0].url, /booking-b$/);
  assert.deepEqual(
    h.row.monetarySelfLeave.markers.map((m) => m.bookingId),
    ['booking-a', 'booking-b'],
  );
});
test('complete exact proof rejects malformed cancellation/owner/exercise/duplicates/pages/origin without next write', () => {
  const variants = [
    { content: [{ ...booking('booking-a', true), cancelled: false, status: 'NOT_CANCELLED' }] },
    { content: [{ ...booking('booking-a', true), cancellationDate: 'invalid' }] },
    { content: [{ ...booking('booking-a', true), clientId: 'foreign' }] },
    { content: [{ ...booking('booking-a', true), exerciseId: 'other' }] },
    { content: [booking('booking-a', true), booking('booking-a', true)] },
    { content: [booking('booking-a', true)], last: false },
    { content: [booking('booking-a', true)], totalElements: 2 },
    { content: [booking('booking-a', true)], totalElements: 'unknown' },
    { content: [booking('booking-a', true)], number: 'unknown' },
    { content: [booking('booking-a', true)], items: [booking('booking-a')] },
    { content: [{ ...booking('booking-a', true), bookingId: 'other-booking' }] },
    { content: [{ id: 'booking-a', cancelled: true }] },
    null,
  ];
  for (const payload of variants) {
    const h = first();
    dispatch(h);
    const later = now + 100_000;
    let msg = finishCas(recover(h.row, later)[3], h.row, later);
    let get = run('router', msg, later)[0];
    get = respond(get, { content: [booking('booking-b')], last: true }, 200, later)[0];
    const out = respond(get, payload, 200, later);
    assert.equal(out[0], null);
    assert.equal(out[7], undefined);
  }
  const h = first();
  const sent = dispatch(h);
  sent.responseUrl = 'https://wrong.invalid';
  sent.payload = {};
  sent.statusCode = 200;
  assert.equal(run('router', sent, now)[0], null);
});
test('foreign identity/generation/request, old row, corrupt marker cannot gain capability', () => {
  for (const field of [
    'actorClientId',
    'targetClientId',
    'membershipVersion',
    'exerciseId',
    'operationId',
    'requestedRefundMethod',
  ]) {
    const h = birth(context(), now);
    const ctx = context();
    ctx[field] = 'foreign';
    const out = run('operation_route', { _splitLeaveCtx: ctx, payload: [h.row] }, now);
    assert.equal(out[0], null);
    assert.equal(out[3], undefined);
  }
  const h = birth(context(), now);
  delete h.row.monetarySelfLeave;
  const msg = run('operation_route', { _splitLeaveCtx: context(), payload: [h.row] }, now)[0];
  assert.equal(dispatchIntent(msg, 'booking-a', 'CURRENCY', now)[0], null);
  const corrupt = first();
  dispatch(corrupt);
  corrupt.row.monetarySelfLeave.markers[0].refundMethod = 'DEPOSIT';
  assert.equal(recover(corrupt.row, now + 100_000)[3], undefined);
});
test('before-dispatch lease recovery remains possible; stale executor loses CAS', () => {
  const h = first();
  const old = copy(h.intent);
  const later = now + 100_000;
  const retry = recover(h.row, later)[3];
  assert.ok(retry);
  const claimed = finishCas(retry, h.row, later);
  assert.ok(claimed);
  const stale = casMessage(old, later);
  assert.equal(apply(h.row, stale.payload, later).matchedCount, 0);
  assert.equal(h.row.monetarySelfLeave.markers.length, 0);
});
test('already-cancelled unmarked B is observed without another DELETE; final local CAS preserves money UNVERIFIED', () => {
  const h = first();
  dispatch(h);
  const later = now + 100_000;
  let msg = finishCas(recover(h.row, later)[3], h.row, later);
  const out = proof(msg, [], ['booking-a', 'booking-b'], later);
  msg = finishCas(out[7], h.row, later);
  const local = run('router', msg, later)[3];
  assert.ok(local);
  const save = run('operation_viva_confirmed', local, later)[0];
  assert.ok(save);
  assert.equal(apply(h.row, save.payload, later).matchedCount, 1);
  assert.equal(h.row.state, 'VIVA_CONFIRMED');
  assert.equal(h.row.moneyRefundState, 'UNVERIFIED');
  assert.equal(h.row.monetarySelfLeave.markers.length, 1);
});
test('rollback #270 refuses fenced state and old retry query does not select it', () => {
  const h = first();
  dispatch(h);
  const old = execFileSync(
    'git',
    [
      'show',
      '7abe118bd909b331650dc9bcf76e7492480493a7:scripts/nodered_games_nodes/fn_split_leave_operation_route.js',
    ],
    { encoding: 'utf8' },
  );
  const out = new Function('msg', 'global', old)(
    { _splitLeaveCtx: context(), payload: [h.row] },
    { get() {} },
  );
  assert.equal(out[2].statusCode, 409);
  const query = run('retry_query', {}, now).payload;
  assert.equal(
    query.$or.some((c) => c.state === h.row.state),
    false,
  );
});

test('mixed ordinary queue keeps NONE semantics while never repeating original money marker', () => {
  const h = birth(context(['booking-a', 'booking-b'], null), now);
  h.intent = dispatchIntent(h.msg, 'booking-a', 'CURRENCY', now)[7];
  dispatch(h);
  const later = now + 100_000;
  let msg = finishCas(recover(h.row, later)[3], h.row, later);
  msg = finishCas(proof(msg, ['booking-b'], ['booking-a'], later)[7], h.row, later);
  const probe = run('router', msg, later)[0];
  const out = respond(
    probe,
    { cancellationOptions: { cancellationOnly: { available: true } } },
    200,
    later,
  );
  assert.equal(out[0].method, 'DELETE');
  assert.deepEqual(out[0].payload, {});
  assert.equal(h.row.monetarySelfLeave.markers.length, 1);
});
test('pending preserves existing game-wide membership gate; unrelated actor is not silently allowed', () => {
  const source = execFileSync(
    'git',
    [
      'show',
      '7abe118bd909b331650dc9bcf76e7492480493a7:scripts/nodered_organizer_handoff_nodes/fn_leave_gate_build.js',
    ],
    { encoding: 'utf8' },
  );
  const h = first();
  dispatch(h);
  const game = {
    id: h.row.gameId,
    updatedAt: 'same',
    organizer: { id: 'organizer-synthetic' },
    membershipMutation: { operationKey: h.row._id, kind: 'LEAVE', targetId: h.row.actorClientId },
  };
  const before = copy(game);
  const out = new Function('msg', source)({
    _splitLeaveCtx: {
      operationKey: 'other-operation',
      gameId: game.id,
      targetClientId: 'other-client',
      game: { updatedAt: 'same' },
    },
    payload: [game],
  });
  assert.equal(out[0], null);
  assert.equal(out[1].statusCode, 409);
  assert.deepEqual(game, before);
});
test('delayed successful ACK after lease expiry cannot issue a monetary DELETE', () => {
  const h = first(),
    command = casMessage(h.intent, now),
    ack = apply(h.row, command.payload, now);
  assert.equal(acknowledge(command, ack, now + 100_000)[0], null);
});

import {
  stages,
  gates,
  composeMonetarySelfLeaveFence,
} from '../patch_nodered_monetary_self_leave_fence.mjs';
const oldSource = (path) =>
  execFileSync('git', ['show', '7abe118bd909b331650dc9bcf76e7492480493a7:' + path], {
    encoding: 'utf8',
  });
function graph() {
  const prefix = 'organizer_handoff_20260913_provider';
  const outputs = {
    operation_start: 3,
    operation_route: 6,
    operation_claim: 3,
    operation_claim_ack: 3,
    operation_viva_confirmed: 2,
    router: 7,
  };
  const nodes = stages.map((s) => ({
    id: s.id,
    z: 'tab',
    type: 'function',
    outputs: outputs[s.name],
    wires: Array.from({ length: outputs[s.name] }, () => ['sink']),
    func: oldSource('scripts/nodered_games_nodes/fn_split_leave_' + s.name + '.js'),
  }));
  nodes.push(
    { id: 'tab', type: 'tab' },
    { id: 'sink', type: 'debug', z: 'tab', wires: [] },
    { id: '35f7c89069fc393a', type: 'http response', z: 'tab', wires: [] },
  );
  for (const g of gates)
    nodes.push({
      id: g.name === 'find' ? prefix : prefix + '_' + g.name,
      type: 'function',
      z: 'tab',
      outputs: g.name === 'build' ? 3 : 2,
      wires: Array.from({ length: g.name === 'build' ? 3 : 2 }, () => ['sink']),
      func: oldSource('scripts/nodered_organizer_handoff_nodes/fn_leave_gate_' + g.name + '.js'),
    });
  nodes.push({
    id: '7c280001a0c1e015',
    z: 'tab',
    type: 'function',
    outputs: 6,
    wires: Array.from({ length: 6 }, () => ['sink']),
    func: oldSource('scripts/nodered_games_nodes/fn_split_leave_authorize.js'),
  });
  nodes.push({
    id: 'lk_split_leave_retry_hydrate_20260801',
    z: 'tab',
    type: 'function',
    outputs: 4,
    wires: Array.from({ length: 4 }, () => ['sink']),
    func: oldSource('scripts/nodered_games_nodes/fn_split_leave_retry_hydrate.js'),
  });
  nodes.push({ id: 'mongo-client', type: 'mongodb4-client' });
  for (const [id, collection, operation] of [
    ['lk_split_leave_operation_claim_update_20260801', 'lk_game_leave_operations', 'updateOne'],
    ['lk_split_leave_operation_start_update_20260801', 'lk_game_leave_operations', 'updateOne'],
    [prefix + '_find', 'lk_games', 'find'],
    [prefix + '_update', 'lk_games', 'updateOne'],
  ])
    nodes.push({
      id,
      type: 'mongodb4',
      z: 'tab',
      collection,
      operation,
      clientNode: 'mongo-client',
      wires: [['sink']],
    });
  nodes.push({
    id: '52af61191cdbe9ef',
    type: 'http request',
    z: 'tab',
    method: 'use',
    url: '',
    authType: '',
    ret: 'obj',
    senderr: true,
    wires: [[stages[5].id]],
  });
  const n = (id) => nodes.find((n) => n.id === id),
    edge = (id, p, v) => (n(id).wires[p] = v);
  edge('7c280001a0c1e015', 3, [stages[5].id]);
  edge('lk_split_leave_retry_hydrate_20260801', 1, [prefix]);
  edge(stages[1].id, 5, [stages[2].id]);
  edge(stages[2].id, 2, [stages[5].id]);
  edge(stages[5].id, 3, [stages[4].id]);
  edge(stages[5].id, 4, [stages[0].id]);
  edge(stages[0].id, 0, ['lk_split_leave_operation_start_update_20260801']);
  edge(stages[5].id, 0, ['52af61191cdbe9ef']);
  edge(stages[2].id, 0, ['lk_split_leave_operation_claim_update_20260801']);
  edge('lk_split_leave_operation_claim_update_20260801', 0, [stages[3].id]);
  edge(stages[3].id, 0, [prefix]);
  edge(stages[1].id, 0, [prefix]);
  edge(stages[1].id, 3, [stages[2].id]);
  edge(prefix, 0, [prefix + '_find']);
  edge(prefix, 1, [stages[5].id]);
  edge(prefix + '_find', 0, [prefix + '_build']);
  edge(prefix + '_build', 0, [prefix + '_update']);
  edge(prefix + '_build', 1, ['35f7c89069fc393a']);
  edge(prefix + '_build', 2, [stages[5].id]);
  edge(prefix + '_update', 0, [prefix + '_ack']);
  edge(prefix + '_ack', 0, [stages[5].id]);
  edge(prefix + '_ack', 1, ['35f7c89069fc393a']);
  return nodes;
}
test('whole-source packet preserves SERVICE capability and original gate, adding only exact monetary CAS edge', () => {
  const before = graph(),
    { candidate, contract } = composeMonetarySelfLeaveFence(
      Buffer.from(JSON.stringify(before)),
      'money-synthetic',
    );
  const router = candidate.find((n) => n.id === stages[5].id),
    original = before.find((n) => n.id === router.id);
  assert.deepEqual(router.wires.slice(0, 7), original.wires);
  assert.deepEqual(router.wires[7], [stages[2].id]);
  assert.equal(candidate.length, before.length);
  assert.ok(contract);
  assert.deepEqual(
    candidate.find((n) => n.id === stages[3].id).wires,
    before.find((n) => n.id === stages[3].id).wires,
  );
});
test('packet refuses mixed source, bypassed gate, duplicate HTTP edge, digest auth, wrong store or dangling wire', () => {
  for (const mutate of [
    (f) => (f[0].func += '\n// drift'),
    (f) => (f.find((n) => n.id === stages[3].id).wires[0] = [stages[5].id]),
    (f) => f.find((n) => n.id === stages[5].id).wires[0].push('sink'),
    (f) => (f.find((n) => n.type === 'http request').authType = 'digest'),
    (f) => (f.find((n) => n.type === 'mongodb4').collection = 'other'),
    (f) => (f.find((n) => n.id === 'organizer_handoff_20260913_provider').func += '\n// drift'),
    (f) => (f[0].wires[1] = ['missing']),
  ]) {
    const f = graph();
    mutate(f);
    assert.throws(() =>
      composeMonetarySelfLeaveFence(Buffer.from(JSON.stringify(f)), 'money-synthetic'),
    );
  }
});

test('empty/discovery and existing no-capability journals cannot be upgraded by setOnInsert replay', () => {
  const ctx = context([]);
  ctx.vivaTargetMode = 'NONE';
  const empty = run('operation_start', { _splitLeaveCtx: ctx }, now)[0].payload[1].$setOnInsert;
  assert.equal(Object.hasOwn(empty, 'monetarySelfLeave'), false);
  const h = birth(context(), now);
  const old = copy(h.row);
  delete old.monetarySelfLeave;
  const retry = run('operation_start', { _splitLeaveCtx: context() }, now)[0];
  assert.equal(Object.hasOwn(retry.payload[1].$set, 'monetarySelfLeave'), false);
  const restored = run(
    'operation_route',
    { _splitLeaveCtx: retry._splitLeaveCtx, payload: [old] },
    now,
  )[0];
  assert.equal(dispatchIntent(restored, 'booking-a', 'CURRENCY', now)[0], null);
});
test('pre-dispatch authoritative read refuses partial, conflicting and foreign booking facts', () => {
  for (const payload of [
    { content: [booking('booking-a')], last: false },
    { content: [{ ...booking('booking-a'), clientId: 'foreign' }, booking('booking-b')] },
    { content: [{ ...booking('booking-a'), bookingId: 'conflicting' }, booking('booking-b')] },
    { content: [booking('booking-a'), booking('booking-b'), booking('new-generation-booking')] },
  ]) {
    const h = birth(context(), now),
      ctx = h.msg._splitLeaveCtx;
    ctx.step = 'monetary_initial_active';
    ctx.currentBookingId = 'booking-a';
    ctx.currentRefundMethod = 'CURRENCY';
    h.msg.statusCode = 200;
    h.msg.payload = payload;
    const out = run('router', h.msg, now);
    assert.equal(out[0], null);
    assert.equal(out[7], undefined);
  }
});
test('new explicit SERVICE/NONE rows retain legacy lane; background money without birth context fails closed', () => {
  for (const method of ['SERVICE', 'NONE']) {
    const row = run('operation_start', { _splitLeaveCtx: context(['booking-a'], method) }, now)[0]
      .payload[1].$setOnInsert;
    assert.equal(Object.hasOwn(row, 'monetarySelfLeave'), false);
  }
  const h = birth(context(), now);
  h.msg._splitLeaveCtx.backgroundStartedRecovery = true;
  assert.equal(dispatchIntent(h.msg, 'booking-a', 'CURRENCY', now)[0], null);
});

test('mixed CURRENCY then SERVICE lost ACK retains baseline and cannot falsely complete without visit verification', () => {
  const h = birth(context(['booking-a', 'booking-b'], null), now);
  h.intent = dispatchIntent(h.msg, 'booking-a', 'CURRENCY', now)[7];
  dispatch(h);
  let when = now + 100_000;
  let msg = finishCas(recover(h.row, when)[3], h.row, when);
  msg = finishCas(proof(msg, ['booking-b'], ['booking-a'], when)[7], h.row, when);
  let out = serviceSnapshot(run('router', msg, when)[0], 'booking-b', when);
  if (out[7]) out = run('router', finishCas(out[7], h.row, when), when);
  assert.equal(out[0].method, 'DELETE');
  assert.deepEqual(out[0].payload, {});
  // Drop provider ACK and reconstruct context exclusively from durable journal.
  when += 100_000;
  msg = finishCas(recover(h.row, when, 'claim-next')[3], h.row, when);
  msg = finishCas(proof(msg, [], ['booking-a', 'booking-b'], when)[7], h.row, when);
  out = run('router', msg, when);
  assert.equal(out[3]?._splitLeaveCtx.subscriptionReturnState, 'RETURN_PENDING');
  assert.equal(out[3]._splitLeaveCtx.subscriptionReturnChecks[0].visitsLeftBefore, 8);
});

test('SERVICE before CURRENCY stores baseline before HTTP, never replays SERVICE, preserves it through money CAS/lost ACK', () => {
  const h = birth(context(['booking-a', 'booking-b'], null), now);
  let out = serviceSnapshot(h.msg, 'booking-a', now);
  assert.ok(out[7]);
  let msg = finishCas(out[7], h.row, now);
  assert.equal(h.row.subscriptionReturnChecks[0].visitsLeftBefore, 8);
  assert.equal(h.row.subscriptionReturnState, 'RETURN_PENDING');
  out = run('router', msg, now);
  assert.equal(out[0].method, 'DELETE');
  assert.deepEqual(out[0].payload, {});
  let when = now + 100_000;
  msg = finishCas(recover(h.row, when)[3], h.row, when);
  const active = proof(copy(msg), ['booking-a', 'booking-b'], [], when);
  assert.equal(active[0], null);
  assert.equal(active[7], undefined);
  msg = finishCas(proof(msg, ['booking-b'], ['booking-a'], when)[7], h.row, when);
  const probe = run('router', msg, when)[0];
  assert.match(probe.url, /booking-b\/cancel$/);
  out = respond(probe, { cancellationOptions: { money: { available: true } } }, 200, when);
  msg = finishCas(out[7], h.row, when);
  out = run('router', msg, when);
  assert.equal(out[0].method, 'DELETE');
  assert.deepEqual(out[0].payload, { refundMethod: 'CURRENCY' });
  assert.equal(h.row.subscriptionReturnChecks[0].visitsLeftBefore, 8);
  when += 100_000;
  msg = finishCas(recover(h.row, when, 'claim-third')[3], h.row, when);
  msg = finishCas(proof(msg, [], ['booking-a', 'booking-b'], when)[7], h.row, when);
  out = run('router', msg, when, { vivacrm_access_token: 'synthetic-service-token' });
  assert.equal(out[0].method, 'GET');
  assert.equal(out[0]._splitLeaveCtx.step, 'verify_subscription_return');
  out = respond(
    out[0],
    { content: [{ subscriptionId: 'subscription-synthetic', visitsLeft: 8, bookings: [] }] },
    200,
    when,
  );
  assert.equal(out[3]._splitLeaveCtx.subscriptionReturnState, 'RETURN_PENDING');
  assert.equal(h.row.moneyRefundState, 'UNVERIFIED');
});
test('missing, modified or conflicting persisted SERVICE baseline refuses recovery and local completion CAS', () => {
  const h = birth(context(['booking-a', 'booking-b'], null), now);
  const pending = serviceSnapshot(h.msg, 'booking-a', now)[7];
  finishCas(pending, h.row, now);
  for (const alter of [
    (row) => (row.subscriptionReturnChecks = []),
    (row) => row.subscriptionReturnChecks[0].visitsLeftBefore++,
    (row) => row.monetarySelfLeave.markers[0].subscriptionBaseline.visitsLeftBefore++,
    (row) => (row.clientSubscriptionId = 'foreign'),
    (row) => (row.subscriptionVisitCount = 2),
    (row) => delete row.monetarySelfLeave.markers[0].subscriptionBaseline,
  ]) {
    const row = copy(h.row);
    alter(row);
    assert.equal(recover(row, now + 100_000)[3], undefined);
  }
  const when = now + 100_000;
  let msg = finishCas(recover(h.row, when)[3], h.row, when);
  msg = finishCas(proof(msg, [], ['booking-a', 'booking-b'], when)[7], h.row, when);
  const local = run('router', msg, when)[3];
  const save = run('operation_viva_confirmed', local, when)[0];
  h.row.subscriptionReturnChecks[0].visitsLeftBefore++;
  assert.equal(apply(h.row, save.payload, when).matchedCount, 0);
});
test('fresh graph preimages cannot inject or observe an ACK/permit through extra incoming edges, complete/catch/link', () => {
  const variants = [
    (f) =>
      f.push({
        id: 'duplicate-ack',
        type: 'function',
        z: 'tab',
        func: 'return msg;',
        outputs: 1,
        wires: [[stages[3].id]],
      }),
    (f) =>
      f.push({
        id: 'duplicate-router',
        type: 'function',
        z: 'tab',
        func: 'return msg;',
        outputs: 1,
        wires: [[stages[5].id]],
      }),
    (f) =>
      f.push({
        id: 'duplicate-http',
        type: 'function',
        z: 'tab',
        func: 'return msg;',
        outputs: 1,
        wires: [['52af61191cdbe9ef']],
      }),
    (f) =>
      f.push({
        id: 'watch-ack',
        type: 'complete',
        z: 'tab',
        scope: ['lk_split_leave_operation_claim_update_20260801'],
        wires: [['sink']],
      }),
    (f) => f.push({ id: 'catch-global', type: 'catch', z: 'tab', scope: null, wires: [['sink']] }),
    (f) =>
      f.push({
        id: 'watch-gate',
        type: 'complete',
        z: 'tab',
        scope: ['organizer_handoff_20260913_provider_ack'],
        wires: [['sink']],
      }),
    (f) =>
      f.push({
        id: 'link-dynamic',
        type: 'link call',
        z: 'tab',
        linkType: 'dynamic',
        links: [],
        wires: [['sink']],
      }),
    (f) => {
      f.push({ id: 'watch-other', type: 'catch', z: 'tab', scope: ['sink'], wires: [['relay']] });
      f.push({
        id: 'relay',
        type: 'function',
        z: 'tab',
        func: 'return msg;',
        outputs: 1,
        wires: [['7c280001a0c1e015']],
      });
    },
  ];
  for (const mutate of variants) {
    const f = graph();
    mutate(f);
    assert.throws(
      () => composeMonetarySelfLeaveFence(Buffer.from(JSON.stringify(f)), 'money-fresh-preimage'),
      /incoming edge|observer|link/,
    );
  }
});
test('provably unrelated explicitly scoped observers and fixed disconnected links remain compatible', () => {
  const f = graph();
  f.push({
    id: 'unrelated',
    type: 'function',
    z: 'tab',
    func: 'return null;',
    outputs: 1,
    wires: [[]],
  });
  f.push({
    id: 'unrelated-observer',
    type: 'complete',
    z: 'tab',
    scope: ['unrelated'],
    wires: [['sink']],
  });
  f.push({
    id: 'unrelated-in',
    type: 'link in',
    z: 'tab',
    links: ['unrelated-out'],
    wires: [['sink']],
  });
  f.push({ id: 'unrelated-out', type: 'link out', z: 'tab', links: ['unrelated-in'], wires: [] });
  assert.ok(
    composeMonetarySelfLeaveFence(Buffer.from(JSON.stringify(f)), 'money-unrelated').contract,
  );
});
