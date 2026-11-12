import assert from 'node:assert/strict';
import {isDeepStrictEqual} from 'node:util';
import {lk1FreeBegin,lk1FreeStep,lk1FreeBinding,lk1FreeJobKey} from '../../lib/lk1FreeCancellation.mjs';
export const instant = '2099-11-11T12:00:00.000Z';
export const requestId = 'fixture-cancel-request';
const get = (row, path) => path.split('.').reduce((r, k) => r?.[k], row);
function matches(row, query) {
  return Object.entries(query).every(([key, value]) => {
    if (key === '$or') return value.some(q => matches(row, q));
    const actual = get(row, key);
    if (value && typeof value === 'object' && !Array.isArray(value)) {
      if ('$in' in value) return value.$in.includes(actual);
      if ('$nin' in value) return !value.$nin.includes(actual);
      if ('$exists' in value) return (actual !== undefined) === value.$exists;
      if ('$ne' in value) return !isDeepStrictEqual(actual, value.$ne);
    }
    return isDeepStrictEqual(actual, value);
  });
}
function set(row, path, value) {
  const keys = path.split('.'); let target = row;
  for (const key of keys.slice(0, -1)) target = target[key] ||= {};
  target[keys.at(-1)] = structuredClone(value);
}
function store(op) {
  const rows = new Map([[op._id, structuredClone(op)]]), writes = [];
  return { rows, writes, afterWrite: null,
    find(query) { return { limit() { return this; }, async toArray() { return [...rows.values()].filter(r => matches(r, query)).map(r => structuredClone(r)); } }; },
    async updateOne(query, change, options) {
      writes.push({ query: structuredClone(query), change: structuredClone(change), options });
      assert.deepEqual(options.writeConcern, { w: 'majority', j: true });
      let row = [...rows.values()].find(r => matches(r, query)); const inserted = !row;
      if (!row && options.upsert) { row = { _id: query._id, ...structuredClone(change.$setOnInsert) }; rows.set(row._id, row); }
      if (!row) return { acknowledged: true, matchedCount: 0, modifiedCount: 0, upsertedCount: 0 };
      const before = structuredClone(row);
      for (const [k, v] of Object.entries(change.$set || {})) set(row, k, v);
      for (const k of Object.keys(change.$unset || {})) { const parts = k.split('.'); const parent = parts.slice(0, -1).reduce((r, p) => r?.[p], row); if (parent) delete parent[parts.at(-1)]; }
      for (const [k, v] of Object.entries(change.$inc || {})) set(row, k, (get(row, k) || 0) + v);
      for (const [k, v] of Object.entries(change.$addToSet || {})) { const a = get(row, k) || []; if (!a.includes(v)) set(row, k, [...a, v]); }
      const ack = { acknowledged: true, matchedCount: inserted ? 0 : 1,
        modifiedCount: inserted || isDeepStrictEqual(before, row) ? 0 : 1, upsertedCount: inserted ? 1 : 0 };
      return this.afterWrite?.(query, change, ack) || ack;
    } };
}
export function fixture() {
  const op = { _id: 'lk1-product:["fixture","actor","lk-subscription-fixture"]', tenantKey: 'fixture',
    actorClientId: 'actor', operationId: 'lk-subscription-fixture', clientSubscriptionId: 'subscription',
    exerciseId: 'exercise', bookingId: 'booking', serviceDate: '2099-11-13', category: 'tournament', state: 'CONFIRMED',
    createdAt: '2099-11-01T11:00:00.000Z', updatedAt: '2099-11-01T11:01:00.000Z',
    lk1: { rule: { productId: 'product' }, fingerprint: 'fixture-fingerprint', target: { eventId: 'exercise',
      category: 'TOURNAMENT', startsAt: '2099-11-13T15:00:00Z' },
      decision: { eligible: true, subscriptionVisitCount: 1, benefit: { finalPriceMinor: 0 } } } };
  const b = { id: 'booking', clientId: 'actor', exerciseId: 'exercise', clientSubscriptionId: 'subscription',
    paymentType: 'SUBSCRIPTION', isCancelled: false, cancelled: false };
  const sub = { subscriptionId: 'subscription', product: { id: 'product' }, visitsTotal: 30, visitsLeft: 28,
    bookings: [{ ...b }, { ...b, id: 'other-booking', exerciseId: 'other-exercise' }] };
  const db = store(op), calls = [];
  const provider = { b, sub, calls, putMode: 'OK', afterPut: null, async request(effect) {
    calls.push({ method: effect.method, path: effect.path, body: effect.body });
    if (effect.method === 'PUT') {
      assert.deepEqual(effect.body, { refundMethod: 'SERVICE', cancelExercise: false });
      assert.equal(calls.filter(c => c.method === 'PUT').length, 1, 'a cancellation is never repeated');
      if (this.putMode !== 'NO_EFFECT') {
        b.isCancelled = true; b.cancelled = true;
        sub.visitsLeft++; sub.bookings = sub.bookings.filter(r => r.id !== b.id);
      }
      this.afterPut?.();
      if (this.putMode === 'LOST_ACK') throw Error('NETWORK');
      return { status: 200, payload: {} };
    }
    if (effect.path.includes('/exercises/')) return { status: 200,
      payload: { content: [structuredClone(b)], last: true, totalElements: 1 } };
    if (effect.path.includes('/subscriptions?')) return { status: 200,
      payload: { content: [structuredClone(sub)], last: true, totalElements: 1 } };
    if (effect.path.endsWith('/cancel')) return { status: 200,
      payload: { bookingId: 'booking', cancellationOptions: { subscription: { available: true } } } };
    return { status: 200, payload: structuredClone(b) };
  } };
  return { op, b, sub, db, provider };
}
export async function drive(f, begun = lk1FreeBegin({ tenantKey: 'fixture', actorClientId: 'actor', bookingId: 'booking', requestId }), now = () => instant) {
  let effect = begun.effect;
  for (let hop = 0; hop < 100; hop++) {
    if (effect.kind === 'reply') return effect;
    let input;
    try {
      if (effect.kind === 'find') input = { payload: await f.db.find(effect.query).limit(1001).toArray() };
      if (effect.kind === 'update') input = { payload: await f.db.updateOne(effect.query, effect.change, effect.options) };
      if (effect.kind === 'http') input = await f.provider.request(effect);
    } catch { input = { error: true }; }
    effect = lk1FreeStep(begun.state, input, now());
  }
  throw Error('HOP_LIMIT');
}
export const jobOf = (f, request = requestId) => f.db.rows.get(lk1FreeJobKey(lk1FreeBinding(f.op), request));
