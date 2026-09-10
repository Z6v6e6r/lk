import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import test from 'node:test';
import { composeGroupBookingConfirmationArtifacts, patchGroupBookingConfirmation, GROUP_BOOKING_ROUTER_ID } from '../patch_nodered_group_booking_confirmation.mjs';

const fixture = process.env.LK_GROUP_CONFIRMATION_FLOW_FIXTURE;
const live = fixture ? fs.readFileSync(fixture) : null;
const artifacts = live ? composeGroupBookingConfirmationArtifacts(live, 'group-confirmation-test') : null;
const source = artifacts?.candidate.find(row => row.id === GROUP_BOOKING_ROUTER_ID).func;
const run = (name, fn) => test(name, { skip: !source && 'Requires private installed flow fixture' }, fn);
const actor = '00000000-0000-4000-8000-000000000001';
const bookingId = '00000000-0000-4000-8000-000000000002';
const exerciseId = '00000000-0000-4000-8000-000000000003';
const context = () => ({ caller: 'http', managedAction: 'BOOK_GROUP_TRAINING', category: 'group_training',
  tenantKey: 'fixture-tenant', actorClientId: actor, authHeader: 'Bearer fixture-end-user',
  operationId: 'fixture-operation', operationKey: 'fixture-operation-key', exerciseId,
  clientSubscriptionId: 'fixture-subscription',
  lk1: { decision: { eligible: true, subscriptionVisitCount: 0,
    benefit: { kind: 'PERCENT_DISCOUNT', finalPriceMinor: 275000 } } } });
// Anonymized own-bookings DTO shape from the supplied HAR; no owner echo.
const booking = () => ({ id: bookingId, exercise: { id: exerciseId }, paymentType: 'ON_PLACE',
  isCancelled: false, clientSubscriptionId: null, clientOneTimeId: null, cost: null,
  transactionStatus: null, pendingPayments: [] });
const execute = (msg, code = source) => vm.runInNewContext(`(function(){${code}\n})()`, {
  msg, global: { get: name => name === 'vivacrm_access_token' ? 'fixture-service' : undefined },
  Date, Intl, Set, Map, JSON, Buffer, URL,
});
const entry = 'const ctx = isObj(msg._subscriptionBooking) ? msg._subscriptionBooking : null;';
function callPrepare(ctx) {
  return execute({ _subscriptionBooking: ctx }, source.slice(0, source.indexOf(entry))
    + '\nreturn prepareBookingCreate(msg._subscriptionBooking);')[0];
}
function readback(rows = [booking()], mutate = () => {}) {
  const ctx = context();
  ctx.step = 'operation_accept'; ctx.immediateBookingId = bookingId;
  const msg = { _subscriptionBooking: ctx, payload: { acknowledged: true, matchedCount: 1, modifiedCount: 1, upsertedCount: 0, upsertedId: null } };
  assert.equal(execute(msg)[0], msg);
  assert.equal(ctx.step, 'confirmation_bookings');
  assert.ok(ctx.lk1GroupConfirmationRead);
  msg.statusCode = 200; msg.responseUrl = msg.url;
  msg.headers = { 'content-type': 'application/json' }; // Node-RED replaces request headers.
  msg.payload = { content: rows, totalElements: rows.length, last: true, number: 0, totalPages: 1 };
  mutate(msg, ctx);
  const result = execute(msg);
  assert.equal(ctx.lk1GroupConfirmationRead, undefined, 'dispatch proof must be consumed');
  return { msg, ctx, result };
}
function unresolved(rows, mutate) {
  const { msg, result } = readback(rows, mutate);
  assert.equal(result[4], msg, 'must finish without provider or Mongo dispatch');
  assert.equal(msg.statusCode, 202);
  assert.match(msg.payload.details.code, /^LK1_BOOKING_/);
  assert.ok(result.slice(0, 4).every(row => row === null));
}

test('composer rejects unreviewed body, missing node and duplicate graph IDs', () => {
  assert.throws(() => patchGroupBookingConfirmation('unknown source'), /preimage drift/);
  assert.throws(() => composeGroupBookingConfirmationArtifacts(Buffer.from('[]'), 'test'), /Missing/);
  assert.throws(() => composeGroupBookingConfirmationArtifacts(Buffer.from('[{"id":"a"},{"id":"a"}]'), 'test'), /Invalid/);
});
test('owner validator permits absence but rejects conflicting and malformed aliases', () => {
  const helpers = fs.readFileSync(new URL('../nodered_group_booking_confirmation_nodes/helpers.js', import.meta.url), 'utf8');
  const matches = (row, id = actor) => vm.runInNewContext(`${helpers}\nlk1GroupOwnerMatches(row, actor)`, {
    row, actor: id, isObj: value => value !== null && typeof value === 'object' && !Array.isArray(value),
    normalizeId: value => String(value || '').trim().toLowerCase(),
  });
  assert.equal(matches({}), true);
  assert.equal(matches({ clientId: actor, client: { id: actor } }), true);
  for (const row of [{ clientId: null }, { clientId: '' }, { clientId: 5 }, { clientId: undefined },
    { client: null }, { client: [] }, { clientId: actor, userId: 'other' }, { client: { id: actor, clientId: 'other' } }]) {
    assert.equal(matches(row), false);
  }
  assert.equal(matches({}, ''), false);
});
run('only HTTP group monetary discount uses Admin v1 and ON_PLACE without consuming a visit', () => {
  const request = callPrepare(context());
  assert.equal(request.method, 'POST');
  assert.match(request.url, /\/api\/v1\/exercises\//);
  assert.equal(request.payload.paymentType, 'ON_PLACE');
  assert.equal(request.payload.clientSubscriptionId, undefined);
  assert.equal(request.payload.count, undefined);
  for (const change of [ctx => ctx.caller = 'other', ctx => ctx.managedAction = 'BOOK_TOURNAMENT',
    ctx => ctx.category = 'tournament', ctx => ctx.lk1.decision.subscriptionVisitCount = 1,
    ctx => ctx.lk1.decision.benefit.finalPriceMinor = 0, ctx => delete ctx.lk1]) {
    const ctx = context(); change(ctx);
    assert.match(callPrepare(ctx).url, /\/api\/v2\/exercises\//);
  }
  const ctx = context(); ctx.caller = 'split'; ctx.subscriptionVisitCount = 1;
  assert.match(callPrepare(ctx).url, /\/api\/v1\/exercises\//);
});
run('exact synchronous ID is durably accepted, self-list confirmed, and checkout starts only after Mongo ack', () => {
  const ctx = context(); ctx.step = 'booking_create';
  const msg = { _subscriptionBooking: ctx, statusCode: 200, payload: { id: bookingId } };
  execute(msg);
  assert.equal(ctx.step, 'operation_accept');
  assert.equal(ctx.immediateBookingId, bookingId);
  assert.equal(msg.payload[1].$set.upstreamBookingId, bookingId);
  const confirmed = readback();
  assert.equal(confirmed.ctx.step, 'operation_confirm');
  assert.equal(confirmed.ctx.confirmedBookingId, bookingId);
  assert.equal(JSON.stringify(confirmed.msg.payload).includes('fixture-end-user'), false);
  confirmed.msg.payload = { acknowledged: true, matchedCount: 1, modifiedCount: 1, upsertedCount: 0, upsertedId: null };
  assert.equal(execute(confirmed.msg)[0], confirmed.msg);
  assert.equal(confirmed.ctx.step, 'lk1_payment_products');
  assert.equal(confirmed.msg.payload.bookingIds[0], bookingId);
});
run('idless 2xx acknowledgements cannot be adopted or cause a second provider write', () => {
  for (const payload of [{ correlationId: 'fixture-correlation' }, {}, { id: null }]) {
    const ctx = context(); ctx.step = 'booking_create';
    const msg = { _subscriptionBooking: ctx, statusCode: 202, payload };
    const result = execute(msg);
    assert.equal(result[4], msg);
    assert.equal(msg.payload.details.code, 'LK1_BOOKING_OUTCOME_UNKNOWN');
    assert.ok(result.slice(0, 4).every(row => row === null));
  }
  unresolved([booking()], (_msg, ctx) => delete ctx.immediateBookingId);
});
run('wrong identity, exercise, cancelled, paid, subscription and duplicate bookings cannot be confirmed', () => {
  for (const delta of [{ id: 'other' }, { exercise: { id: 'other' } }, { isCancelled: true },
    { clientId: 'other' }, { clientId: null }, { clientId: actor, client: { id: 'other' } },
    { paymentType: 'SUBSCRIPTION' }, { paymentType: 'CARD' }, { paymentMethod: 'CARD' },
    { clientSubscriptionId: 'other' }, { transactionStatus: { transactionStatus: 'SUCCESS' } },
    { pendingPayments: [{ id: 'fixture-existing-payment' }] }]) unresolved([{ ...booking(), ...delta }]);
  unresolved([booking(), booking()]); unresolved([]);
});
run('missing or changed self-list transport proof fails closed including cross-operation reuse', () => {
  for (const mutate of [msg => msg.method = 'POST', msg => msg.url += '&other=true',
    msg => msg.responseUrl = 'https://example.invalid/bookings', msg => msg.followRedirects = true,
    msg => msg.maxRedirects = 1, (_msg, ctx) => delete ctx.lk1GroupConfirmationRead,
    (_msg, ctx) => ctx.authHeader = 'Bearer changed', (_msg, ctx) => ctx.actorClientId = 'other',
    (_msg, ctx) => ctx.operationId = 'other', (_msg, ctx) => ctx.operationKey = 'other',
    (_msg, ctx) => ctx.tenantKey = 'other', msg => msg.statusCode = 503,
    msg => msg.payload.last = false]) unresolved([booking()], mutate);
});
run('unknown or zero-modification durable acknowledgements never dispatch checkout or transactions', () => {
  for (const step of ['operation_accept', 'operation_confirm', 'lk1_payment_attempt_saved']) {
    for (const payload of [{ acknowledged: true, matchedCount: 1, modifiedCount: 0, upsertedCount: 0, upsertedId: null },
      { acknowledged: true, matchedCount: 0, modifiedCount: 0, upsertedCount: 0, upsertedId: null }, {}]) {
      const ctx = context(); ctx.step = step; ctx.confirmedBookingId = bookingId;
      const msg = { _subscriptionBooking: ctx, payload };
      const outputs = execute(msg);
      assert.equal(outputs[4], msg, step);
      assert.ok(outputs.slice(0, 4).every(row => row === null));
    }
  }
});
run('other LK1 booking categories retain the original explicit-owner requirement', () => {
  const ctx = context(); ctx.managedAction = 'BOOK_TOURNAMENT'; ctx.category = 'tournament';
  ctx.step = 'confirmation_bookings'; ctx.immediateBookingId = bookingId;
  const msg = { _subscriptionBooking: ctx, statusCode: 200, payload: [booking()] };
  assert.equal(execute(msg)[4], msg);
  assert.equal(msg.payload.details.code, 'LK1_BOOKING_OUTCOME_UNRESOLVED');
});
run('candidate changes only the reviewed router function and rejects a second application', () => {
  const original = JSON.parse(live);
  assert.equal(artifacts.candidate.length, original.length);
  for (let i = 0; i < original.length; i++) {
    const before = structuredClone(original[i]); const after = structuredClone(artifacts.candidate[i]);
    if (before.id === GROUP_BOOKING_ROUTER_ID) { delete before.func; delete after.func; }
    assert.deepEqual(after, before);
  }
  assert.throws(() => composeGroupBookingConfirmationArtifacts(artifacts.candidateBytes, 'test'), /preimage drift/);
});
