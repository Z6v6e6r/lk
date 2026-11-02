import fs from 'node:fs';
import assert from 'node:assert/strict';
import { isDeepStrictEqual } from 'node:util';
export const copy = (value) => structuredClone(value);
export function run(name, msg, now = Date.now(), globals = {}) {
  class Clock extends Date {
    constructor(...args) {
      super(...(args.length ? args : [now]));
    }
    static now() {
      return now;
    }
  }
  const source = fs.readFileSync(
    new URL(`../../nodered_games_nodes/fn_split_leave_${name}.js`, import.meta.url),
    'utf8',
  );
  return new Function('msg', 'global', 'flow', 'Date', source)(
    msg,
    {
      get(key) {
        return globals[key];
      },
    },
    { get() {} },
    Clock,
  );
}
export function context(bookings = ['booking-a', 'booking-b'], method = 'CURRENCY') {
  return {
    mode: 'SELF',
    gameId: 'game-synthetic',
    exerciseId: 'exercise-synthetic',
    actorClientId: 'client-synthetic',
    targetClientId: 'client-synthetic',
    membershipVersion: 'generation-a',
    operationId: 'self-leave:game-synthetic:client-synthetic:generation-a',
    claimToken: 'claim-a',
    requestedRefundMethod: method,
    initialBookingIds: [...bookings],
    bookingQueue: bookings.map((bookingId) => ({ bookingId, clientId: 'client-synthetic' })),
    actorAuthHeader: 'Bearer synthetic-fixture',
    upstreamAuthHeader: 'Bearer synthetic-fixture',
    vivaTargetMode: 'BOOKINGS',
    bookingResults: [],
    subscriptionReturnChecks: [],
    step: 'start_cancel',
  };
}
export function birth(ctx = context(), now = Date.now()) {
  const msg = { _splitLeaveCtx: copy(ctx) };
  const start = run('operation_start', msg, now)[0];
  const row = copy(start.payload[1].$setOnInsert);
  const routed = run(
    'operation_route',
    { _splitLeaveCtx: start._splitLeaveCtx, payload: [row] },
    now,
  );
  assert.ok(routed[0], 'new journal must route to initial read');
  return { row, msg: routed[0] };
}
// Synthetic CAS model is explicit: physical suite runs these SAME actual node queries in Mongo.
export function apply(row, payload, now = Date.now()) {
  const [query, update] = payload;
  const match = Object.entries(query).every(([key, expected]) => {
    if (key === '$expr') {
      const op = expected.$gt ? '$gt' : '$lte';
      const ms = Date.parse(row.claimLeaseUntil);
      return Number.isFinite(ms) && (op === '$gt' ? ms > now : ms <= now);
    }
    if (expected && typeof expected === 'object' && '$exists' in expected)
      return Object.hasOwn(row, key) === expected.$exists;
    return isDeepStrictEqual(row[key], expected);
  });
  if (!match) return { acknowledged: true, matchedCount: 0, modifiedCount: 0 };
  const changed = Object.entries(update.$set || {}).some(([k, v]) => !isDeepStrictEqual(row[k], v));
  // BSON persistence duplicates nested values; JavaScript reference aliases do not survive it.
  Object.assign(row, JSON.parse(JSON.stringify(update.$set || {})));
  for (const [k, v] of Object.entries(update.$inc || {})) row[k] = (row[k] || 0) + v;
  return { acknowledged: true, matchedCount: 1, modifiedCount: changed || update.$inc ? 1 : 0 };
}
export function casMessage(msg, now = Date.now()) {
  return run('operation_claim', msg, now)[0];
}
export function acknowledge(msg, ack, now = Date.now()) {
  msg.payload = ack;
  return run('operation_claim_ack', msg, now);
}
export function finishCas(msg, row, now = Date.now()) {
  msg = casMessage(msg, now);
  assert.ok(msg);
  return acknowledge(msg, apply(row, msg.payload, now), now)[0];
}
export function respond(msg, payload, statusCode = 200, now = Date.now()) {
  msg.payload = payload;
  msg.statusCode = statusCode;
  msg.responseUrl = msg.url;
  return run('router', msg, now);
}
export const booking = (id, cancelled = false) => ({
  id,
  clientId: 'client-synthetic',
  exerciseId: 'exercise-synthetic',
  cancelled,
});
export function dispatchIntent(msg, id = 'booking-a', method = 'CURRENCY', now = Date.now()) {
  const ctx = msg._splitLeaveCtx;
  ctx.step = 'cancel_probe';
  ctx.currentBookingId = id;
  ctx.currentClientId = ctx.actorClientId;
  // A real probe response arrives from the URL set by startNextBooking.
  msg.url = `https://api.vivacrm.ru/end-user/api/v1/iSkq6G/bookings/${id}/cancel`;
  ctx.monetaryExpectedUrl = msg.url;
  ctx.monetaryExpectedStep = ctx.step;
  let result = respond(
    msg,
    {
      cancellationOptions: {
        money: { available: method === 'CURRENCY' },
        deposit: { available: method === 'DEPOSIT' },
        cancellationOnly: { available: method === 'NONE' },
      },
    },
    200,
    now,
  );
  if (result[0]?._splitLeaveCtx.step === 'monetary_initial_active') {
    result = respond(
      result[0],
      { content: ctx.initialBookingIds.map((id) => booking(id)), last: true },
      200,
      now,
    );
  }
  return result;
}
export function recover(row, now, token = 'claim-recovery') {
  const ctx = context(row.bookingIds, row.requestedRefundMethod);
  ctx.claimToken = token;
  return run('operation_route', { _splitLeaveCtx: ctx, payload: [copy(row)] }, now);
}
export function proof(msg, active = ['booking-b'], cancelled = ['booking-a'], now = Date.now()) {
  let out = run('router', msg, now);
  assert.equal(out[0]?.method, 'GET');
  out = respond(out[0], { content: active.map((id) => booking(id)), last: true }, 200, now);
  assert.equal(out[0]?.method, 'GET');
  return respond(
    out[0],
    { content: cancelled.map((id) => booking(id, true)), last: true },
    200,
    now,
  );
}

export function serviceSnapshot(msg, id, when) {
  const ctx = msg._splitLeaveCtx;
  ctx.currentBookingId = id;
  ctx.currentClientId = ctx.actorClientId;
  ctx.currentRefundMethod = 'SERVICE';
  ctx.clientSubscriptionId = 'subscription-synthetic';
  ctx.expectedReturnCount = 1;
  ctx.subscriptionVisitCount = 1;
  ctx.step = 'snapshot_subscription_before';
  delete ctx.monetaryExpectedStep;
  delete ctx.monetaryExpectedUrl;
  msg.statusCode = 200;
  msg.payload = {
    content: [
      { subscriptionId: 'subscription-synthetic', visitsLeft: 8, bookings: [{ id, count: 1 }] },
    ],
  };
  let out = run('router', msg, when);
  if (out[0]?._splitLeaveCtx.step === 'monetary_initial_active')
    out = respond(
      out[0],
      { content: ctx.initialBookingIds.map((id) => booking(id)), last: true },
      200,
      when,
    );
  return out;
}
