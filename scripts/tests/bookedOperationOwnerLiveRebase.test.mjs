import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { LIVE_REBASE_UNITS, LIVE_REBASE_RESOLUTIONS, hash, rebaseUnitSource } from '../lib/bookedOperationOwnerLiveRebase.mjs';
import { composeOwnerLiveRebase, LIVE_REBASE_TOPOLOGY } from '../prepare_booked_operation_owner_live_rebase.mjs';
import * as H from './helpers/ownerLiveRebaseCharacterization.mjs';

// The live preimage is private (it is the production graph); characterization runs
// only against a fresh external copy: LK1_OWNER_LIVE_FLOW_FIXTURE=/private/path/flows.json
const LIVE_FIXTURE = process.env.LK1_OWNER_LIVE_FLOW_FIXTURE;
const live = { skip: !LIVE_FIXTURE && 'LK1_OWNER_LIVE_FLOW_FIXTURE is not set (private live preimage)' };
const temporaries = [];
const tmp = () => { const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'owner-live-rebase-test-')); temporaries.push(dir); return dir; };
test.after(() => temporaries.forEach(dir => fs.rmSync(dir, { recursive: true, force: true })));

// ---- merge mechanics (no live input) ----------------------------------------------
const BASE = 'const a = 1;\nconst helper = () => {\n  return a;\n};\nif (ctx.step === "x") {\n  return helper();\n}\n';
test('installed-only statements are protected while canonical-only changes are taken or added', () => {
  const liveSource = BASE.replace('if (ctx.step === "x")', 'const liveOnly = () => 7;\nif (ctx.step === "x")');
  const canonical = BASE.replace('return a;', 'return a + 1;') + 'const added = () => 2;\n';
  const result = rebaseUnitSource('fixture', liveSource, BASE, canonical, tmp());
  assert.match(result.source, /const liveOnly = \(\) => 7;/);
  assert.match(result.source, /return a \+ 1;/);
  assert.match(result.source, /const added = \(\) => 2;/);
  assert.deepEqual(result.taken, ['var:helper']);
  assert.equal(result.protectedStatements, 1);
});
test('auto-merged statements keep every installed line', () => {
  const liveSource = BASE.replace('  return helper();', '  if (ctx.lk1) return null;\n  return helper();');
  const canonical = BASE.replace('  return helper();\n}', '  return helper();\n  // canonical tail\n}');
  const result = rebaseUnitSource('fixture', liveSource, BASE, canonical, tmp());
  assert.match(result.source, /if \(ctx\.lk1\) return null;[\s\S]*canonical tail/);
});
for (const [name, liveSource, canonical, error] of [
  ['unreviewed overlapping edit', BASE.replace('return a;', 'return a * 2;'), BASE.replace('return a;', 'return a + 1;'), /Unreviewed live rebase conflict/],
  ['installed base statement removed', BASE.replace('const a = 1;\n', ''), BASE, /Installed base statement missing/],
  ['canonical removed a base statement', BASE, BASE.replace('const a = 1;\n', ''), /Canonical removed a base statement/],
  ['same statement added differently on both sides', BASE + 'const z = 1;\n', BASE + 'const z = 2;\n', /added on both sides/],
]) test('merge refuses: ' + name, () => assert.throws(() => rebaseUnitSource('fixture', liveSource, BASE, canonical, tmp()), error));

test('reviewed resolutions are exactly the five pinned hunks', () => {
  assert.deepEqual(Object.keys(LIVE_REBASE_RESOLUTIONS).sort(), [
    'prepare|expr:msg._subscriptionBooking = {', 'router|if:ctx.step === "managed_entitlement_reserve"',
    'router|if:ctx.step === "profile"', 'router|var:emit', 'router|var:prepareBookingCreate']);
  for (const rule of Object.values(LIVE_REBASE_RESOLUTIONS)) {
    assert.match(rule.live, /^[a-f0-9]{64}$/); assert.match(rule.main, /^[a-f0-9]{64}$/);
  }
});
test('pinned canonical sources and installed base blobs are the reviewed ones', () => {
  for (const [, , files] of LIVE_REBASE_UNITS) for (const [file, blob, sha] of files) {
    assert.equal(hash(fs.readFileSync(new URL('../nodered_subscription_booking_nodes/' + file, import.meta.url), 'utf8')), sha, file);
    assert.equal(execFileSync('git', ['cat-file', '-t', blob], { encoding: 'utf8' }).trim(), 'blob', file);
  }
});
test('composition refuses any flow other than the pinned installed preimage', () => {
  assert.throws(() => composeOwnerLiveRebase(Buffer.from('[]'), 'owner-live-rebase-fixture'), /whole-flow preimage drift/);
});

// ---- characterization against the private live preimage ---------------------------
let packet, liveFlow;
const load = () => {
  if (!packet) {
    const bytes = fs.readFileSync(LIVE_FIXTURE);
    liveFlow = JSON.parse(bytes);
    packet = composeOwnerLiveRebase(bytes, 'owner-live-rebase-fixture');
  }
  return { liveFlow, candidate: packet.candidate, packet };
};
const ROUTER = 'lk_subscription_booking_router_20260804', POST = 'lk_subscription_booking_post_20260804';
const node = (flow, id) => flow.find(row => row.id === id);

test('LIVE: only four func fields change; ids, wires, initialize and every other node are byte-identical', live, () => {
  const { liveFlow, candidate, packet } = load();
  assert.equal(candidate.length, liveFlow.length);
  const changed = new Set(LIVE_REBASE_UNITS.map(unit => unit[1]));
  liveFlow.forEach((before, index) => {
    const after = candidate[index];
    if (!changed.has(before.id)) return assert.deepEqual(after, before, before.id);
    assert.deepEqual({ ...after, func: null }, { ...before, func: null }, before.id);
    assert.notEqual(after.func, before.func, before.id);
  });
  assert.deepEqual(packet.contract.allowedChanges.map(row => [row.id, row.fields]).sort(),
    [...changed].sort().map(id => [id, ['func']]));
  assert.equal(packet.contract.allowedAdditions.length, 0);
  for (const id of Object.keys(LIVE_REBASE_TOPOLOGY)) assert.deepEqual(node(candidate, id).wires, node(liveFlow, id).wires);
  assert.deepEqual(packet.reports.flatMap(r => r.conflictDecisions.map(d => r.name + ':' + d.decision)).sort(), [
    'prepare:LIVE_THEN_MAIN', 'router:LIVE_THEN_MAIN', 'router:LIVE_THEN_MAIN', 'router:MAIN_THEN_LIVE',
    'router:RELOCATE_MAIN:if:ctx.step === "lk1_profile_continue"']);
});

test('LIVE: router step matrix answers identically for every installed step, context and provider reply', live, () => {
  const { liveFlow, candidate } = load();
  const before = H.makeRunner(node(liveFlow, ROUTER)), after = H.makeRunner(node(candidate, ROUTER));
  const steps = [...new Set([...node(liveFlow, ROUTER).func.matchAll(/ctx\.step === (["'])([a-z0-9_]+)\1/g)].map(m => m[2]))];
  assert.ok(steps.length >= 50);
  let runs = 0;
  for (const step of steps) for (const c of Object.keys(H.CONTEXTS)) for (const p of Object.keys(H.PAYLOADS)) {
    runs++;
    assert.equal(H.observe(after(H.routerMessage(step, c, p))), H.observe(before(H.routerMessage(step, c, p))), `${step}/${c}/${p}`);
  }
  assert.ok(runs > 7000);
});

test('LIVE: prepare, finalize and persistence-error nodes answer identically for ordinary LK1 input', live, () => {
  const { liveFlow, candidate } = load();
  const pair = id => [H.makeRunner(node(liveFlow, id)), H.makeRunner(node(candidate, id))];
  const [p0, p1] = pair('lk_subscription_booking_prepare_20260804');
  for (const body of Object.keys(H.PREPARE_BODIES).filter(name => name !== 'training')) for (const opts of [{}, { auth: false }, { idempotency: false }]) {
    assert.equal(H.observe(p1(H.prepareMessage(body, opts))), H.observe(p0(H.prepareMessage(body, opts))), body + JSON.stringify(opts));
  }
  const [f0, f1] = pair('lk_subscription_booking_finalize_20260804');
  for (const state of ['CONFIRMED', 'PENDING_CONFIRMATION', 'RELEASED', 'PREFLIGHT_ATTEMPT_BOUND', 'LK1_TARIFF_REQUIRED', undefined]) {
    for (const extra of [{}, { caller: 'split' }, { statusCode: 409 }, { statusCode: 503 }, { ctx: { lk1IngressReplay: true, lk1: {} } },
      { caller: 'split', split: { action: 'create', step: 'subscription_create_preflight' } }]) {
      assert.equal(H.observe(f1(H.finalizeMessage(state, extra))), H.observe(f0(H.finalizeMessage(state, extra))), state + JSON.stringify(extra));
    }
  }
  const [e0, e1] = pair('lk_subscription_booking_mongo_error_20260804');
  for (const step of ['operation_insert', 'operation_confirm', 'operation_find', 'lk1_ingress_operation_find']) {
    const msg = () => ({ _subscriptionBooking: { step, operationId: 'idem-operation-1', caller: 'http' }, error: { message: 'E11000 duplicate key', code: 11000 }, payload: null });
    assert.equal(H.observe(e1(msg())), H.observe(e0(msg())), step);
  }
});

const CANCELLED = { id: 'booking-existing', status: 'CANCELED', canceled: true, paymentType: 'SUBSCRIPTION', clientSubscriptionId: H.SUBSCRIPTION,
  exerciseId: 'exercise-existing', exerciseDate: '2026-11-10', clientId: H.CLIENT, exerciseDirection: { id: 4588 }, exerciseType: { id: 1613 },
  timeFrom: '10:00:00', timeTo: '11:00:00' };
const OP_ROW = { _id: 'iSkq6G:' + H.SUBSCRIPTION + ':2026-11-10', tenantKey: 'iSkq6G', actorClientId: H.CLIENT, serviceDate: '2026-11-10',
  exerciseId: 'exercise-existing', bookingId: 'booking-existing', operationId: 'idem-operation-0', state: 'CONFIRMED', clientSubscriptionId: H.SUBSCRIPTION };
const graph = (flow, w, body, opts, seed = {}) => {
  const store = new H.FakeStore({ ...H.storeSeed(w), ...seed });
  return { trace: H.simulate(flow, POST, H.prepareMessage(body, opts), { viva: H.fakeViva(H.world(w)), store }), store: store.collections };
};
const responseOf = trace => trace.filter(row => row.response).at(-1)?.response;
for (const [name, w, body, opts, seed] of [
  ['open game (HUB product)', { productId: 'db7a5250-7369-4f43-8ac5-9111be24bc74' }, 'book'],
  ['open game (sport plan)', {}, 'book'],
  ['tournament with LK1 money evidence', { exerciseDirection: 2617, exerciseType: 839 }, 'book'],
  ['group training', { exerciseDirection: 6233, exerciseType: 605 }, 'book'],
  ['tournament/group discounts in body', { exerciseDirection: 2617, exerciseType: 839 }, 'bookDiscounts'],
  ['spot selection', {}, 'bookSpot'],
  ['release after Viva cancel', { history: [CANCELLED] }, 'release'],
  ['release with stored operation', { history: [CANCELLED] }, 'release', {}, { lk_subscription_daily_booking_ops: [OP_ROW] }],
  ['release still active', { active: [{ ...CANCELLED, status: 'BOOKED', canceled: false }] }, 'release'],
  ['missing authorization', {}, 'book', { auth: false }],
  ['missing idempotency key', {}, 'book', { idempotency: false }],
  ['invalid release body', {}, 'releaseBad'],
]) test('LIVE: POST /lk/subscription-bookings trace is identical — ' + name, live, () => {
  const { liveFlow, candidate } = load();
  const before = graph(liveFlow, w, body, opts, seed), after = graph(candidate, w, body, opts, seed);
  assert.ok(responseOf(before.trace), 'ordinary request must be answered');
  assert.deepEqual(after.trace, before.trace);
  assert.deepEqual(after.store, before.store);
});

const writes = trace => ({ post: trace.filter(row => row.http?.method === 'POST').map(row => row.http.url),
  stores: trace.filter(row => row.mongo && row.mongo.operation !== 'find').map(row => row.mongo.operation) });
test('LIVE: ordinary write path (legacy cohort) books, persists and confirms identically', live, () => {
  const { liveFlow, candidate } = load();
  const w = { productId: H.LEGACY_PRODUCT };
  const before = graph(liveFlow, w, 'book'), after = graph(candidate, w, 'book');
  assert.deepEqual(after.trace, before.trace); assert.deepEqual(after.store, before.store);
  assert.equal(responseOf(after.trace).statusCode, 201); assert.equal(responseOf(after.trace).payload.state, 'CONFIRMED');
  const { post, stores } = writes(after.trace);
  assert.ok(post.some(url => /\/exercises\/[^/]+\/bookings$/.test(url)), 'Viva booking POST must be exercised');
  assert.ok(stores.includes('insertOne') && stores.filter(op => op === 'updateOne').length >= 2);
});
for (const [name, discountMinor, expected] of [['free entitlement: reserve, bind, Viva POST, confirm', 150000, 201],
  ['partial price: provider rejection releases the entitlement', 75000, 202]]) {
  test('LIVE: managed CUP tournament is identical — ' + name, live, async () => {
    const { liveFlow, candidate } = load();
    const scenario = await H.managedScenario({ discountMinor });
    const run = flow => { const store = new H.FakeStore(scenario.seed());
      return { trace: H.simulate(flow, POST, H.prepareMessage('book'), { viva: H.fakeViva(scenario.make()), store, globals: scenario.globals }), store: store.collections }; };
    const before = run(liveFlow), after = run(candidate);
    assert.deepEqual(after.trace, before.trace); assert.deepEqual(after.store, before.store);
    assert.equal(responseOf(after.trace).statusCode, expected);
    const { post } = writes(after.trace);
    assert.ok(post.some(url => url.endsWith('/entitlements/reserve')), 'entitlement reserve must be exercised');
    assert.ok(post.some(url => url.endsWith(expected === 201 ? '/entitlements/confirm' : '/entitlements/release')));
    if (expected === 201) assert.ok(post.some(url => /\/exercises\/[^/]+\/bookings$/.test(url)));
  });
}

test('LIVE: release reconciliation reaches RELEASED on both graphs', live, () => {
  const { candidate } = load();
  assert.equal(responseOf(graph(candidate, { history: [CANCELLED] }, 'release').trace).payload.state, 'RELEASED');
});

test('LIVE: intended delta — trainingRegistration body is refused instead of booked as ordinary', live, () => {
  const { liveFlow, candidate } = load();
  assert.notEqual(responseOf(graph(liveFlow, {}, 'training').trace).statusCode, 400);
  const after = graph(candidate, {}, 'training');
  assert.deepEqual(responseOf(after.trace), { node: 'lk_subscription_booking_response_20260804', statusCode: 400,
    payload: { error: 'Некорректная привязка тренировки', details: { code: 'TRAINING_REGISTRATION_INVALID' } } });
  assert.equal(after.trace.filter(row => row.http || row.mongo).length, 0);
});

test('LIVE: intended delta — lk2LegacyJoin runs JOIN owner recovery only after LK1 ingress and product identity', live, () => {
  const { liveFlow, candidate } = load();
  const before = graph(liveFlow, {}, 'lk2Join').trace, after = graph(candidate, {}, 'lk2Join').trace;
  const recovery = after.findIndex(row => row.fn === ROUTER && row.step === 'managed_join_owner_recovery_find');
  const identity = after.findIndex(row => row.fn === 'lk_subscription_product_finish_20260907');
  const ingress = after.findIndex(row => row.mongo?.payload?._id?.startsWith?.('lk1-product:'));
  assert.ok(ingress >= 0 && identity > ingress && recovery > identity, 'JOIN recovery must follow LK1 guards');
  assert.deepEqual(after.slice(0, recovery), before.slice(0, recovery));
});

test('LIVE: SELF leave fails closed and never reaches the installed product continuation', live, () => {
  const { candidate } = load();
  const leave = { schemaVersion: 1, actorClientId: H.CLIENT, bookingId: 'booking-existing', bookingOperationId: 'idem-operation-0',
    bookingOperationKey: OP_ROW._id, clientSubscriptionId: H.SUBSCRIPTION, entitlementOperationId: 'ent-op-1', exerciseId: 'exercise-existing',
    gameId: 'game-1', leaveClaimToken: 'claim-token-1', leaveOperationId: 'leave-op-1', leaveOperationKey: 'game-1:leave-op-1',
    membershipVersion: 'v1', serviceDate: '2026-11-10', subscriptionInstanceId: 'instance-1', tenantKey: 'iSkq6G' };
  const msg = H.prepareMessage('release');
  msg.payload = msg.req.body = { action: 'release', bookingId: 'booking-existing', managedSelfLeave: leave, operationId: 'leave-op-1' };
  msg.req.headers['idempotency-key'] = 'leave-op-1';
  const trace = H.simulate(candidate, POST, msg, { viva: H.fakeViva(H.world({})), store: new H.FakeStore() });
  assert.equal(responseOf(trace).payload.details.code, 'MANAGED_SELF_LEAVE_GRAPH_UNAVAILABLE');
  assert.equal(trace.some(row => row.fn === 'lk_subscription_product_router_20260907'), false);
  assert.equal(trace.some(row => row.mongo && row.mongo.operation !== 'find'), false);
});

test('LIVE: owner capability probe advertises exactly the installed contracts', live, () => {
  const { liveFlow, candidate } = load();
  const probe = (flow, headers) => responseOf(H.simulate(flow, 'lk_subscription_booking_owner_probe_get_20261023',
    { _msgid: 'msg-1', payload: {}, req: { method: 'GET', url: '/lk/subscription-bookings', originalUrl: '/lk/subscription-bookings', headers, query: {} } },
    { viva: H.fakeViva(H.world({})), store: new H.FakeStore() }));
  const v = version => ({ 'x-booked-operation-owner-contract': version });
  // JOIN v2 (2) needs the upgraded receiver and SELF leave (3) its own graph: neither is advertised yet.
  for (const headers of [v('1'), v('2'), v('3'), v('4'), {}]) assert.deepEqual(probe(candidate, headers), probe(liveFlow, headers), JSON.stringify(headers));
  assert.equal(probe(candidate, v('1')).statusCode, 200);
  for (const version of ['2', '3']) assert.equal(probe(candidate, v(version)).statusCode, 404, version);
  // Training owner is a later step: still refused, now with its own code.
  assert.equal(probe(candidate, { 'x-training-registration-owner-contract': '1' }).statusCode, 404);
});
