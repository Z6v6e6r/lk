import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import test from 'node:test';
import { composeBookingPaymentLifecycle, patchBookingPaymentFunction, splitBookingPaymentAttemptSource, PAYMENT_GRAPH_IDS as ids } from '../prepare_booking_payment_lifecycle.mjs';
import { bookingPaymentAttemptSource } from '../lib/eventPaymentSources.mjs';
import { splitCreateResultFunctionSource } from '../lib/splitCreateResultFlow.mjs';
const targets = JSON.parse(fs.readFileSync(new URL('../lib/bookingPaymentAttemptSourceEdits.json', import.meta.url))).functions;
const sha = v => crypto.createHash('sha256').update(v).digest('hex');
function baseline(t) {
  if (t.reader) return t.beforeSource;
  let s = fs.readFileSync(t.file, 'utf8');
  assert.equal(sha(s), t.afterSha256, 'maintained source changed without refreshing reviewed edits: ' + t.file);
  for (const { before, after } of [...t.edits].reverse()) {
    assert.equal(s.split(after).length, 2, 'inverse anchor must be unique'); s = s.replace(after, () => before);
  }
  assert.equal(sha(s), t.beforeSha256, 'historical preimage must remain exact');
  return s;
}
function fixture() {
  const nodes = [{ id: 'tab', type: 'tab', label: 'Synthetic complete canonical baseline', disabled: false },
    { id: 'db', type: 'mongodb4-client' },
    { id: 'lk_subscription_booking_find_20260804', type: 'mongodb4', z: 'tab', operation: 'find',
      collection: 'lk_subscription_daily_booking_ops', clientNode: 'db', wires: [['lk_subscription_booking_router_20260804']] },
    { id: 'game-reader', type: 'mongodb4', z: 'tab', operation: 'find', collection: 'lk_games', clientNode: 'db', wires: [[ids.ack]] },
    { id: 'legacy_payment_confirm_canonical_prepare_20260816', type: 'function', z: 'tab', func: 'return msg;', outputs: 1, wires: [[]] }];
  for (const t of targets) {
    const count = t.id === ids.router ? 5 : t.id === ids.cleanup ? 6 : t.id === ids.ack ? 4 : t.reader ? 3 : 8;
    const wires = Array.from({ length: count }, () => []);
    if (t.id === ids.router) wires[4] = ['legacy_payment_confirm_canonical_prepare_20260816'];
    if (t.id === ids.ack) wires[0] = ['game-reader'];
    if (t.id === 'lk_subscription_booking_router_20260804') wires[1] = ['lk_subscription_booking_find_20260804'];
    nodes.push({ id: t.id, type: 'function', z: 'tab', func: baseline(t), outputs: count, wires });
  }
  return nodes;
}
const compose = nodes => { const bytes = Buffer.from(JSON.stringify(nodes)); return composeBookingPaymentLifecycle(bytes, sha(bytes)); };
test('offline complete candidate preserves canonical lanes and source functions, adds eight bound Mongo callbacks', () => {
  const original = fixture(), result = compose(original), next = JSON.parse(result.candidateBytes);
  assert.equal(next.length, original.length + 8);
  for (const owner of [ids.router, ids.cleanup, ids.ack]) {
    const before = original.find(n => n.id === owner), after = next.find(n => n.id === owner);
    assert.deepEqual(after.wires.slice(0, before.wires.length), before.wires);
  }
  for (const t of targets) {
    const actual = next.find(n => n.id === t.id).func;
    let expected = t.reader ? splitCreateResultFunctionSource() : fs.readFileSync(t.file, 'utf8');
    if (t.id === 'lk_subscription_booking_router_20260804') expected = bookingPaymentAttemptSource() + expected;
    if ([ids.router, ids.cleanup, ids.ack].includes(t.id)) expected = splitBookingPaymentAttemptSource() + expected;
    assert.equal(actual, expected); new Function('msg', 'node', 'global', 'env', 'flow', actual);
  }
  for (const n of next.slice(original.length)) {
    assert.equal(n.type, 'mongodb4'); assert.equal(n.clientNode, 'db');
    assert.equal(n.z, 'tab'); assert.equal(n.wires[0].length, 1);
  }
  assert.equal(result.sourceSha256, sha(Buffer.from(JSON.stringify(original))));
  assert.notEqual(result.candidateSha256, result.sourceSha256);
});
test('composed ordinary function includes native terminal-proof contract in its own Function scope', () => {
  const next = JSON.parse(compose(fixture()).candidateBytes);
  const source = next.find(n => n.id === ids.router).func;
  const message = { _splitCtx: { step: 'ordinary_attempt_native_owner_found', action: 'join',
    ordinaryHeadKey: 'booking-payment-head:' + JSON.stringify(['iSkq6G', 'actor', ['EVENT', 'exercise']]),
    trustedPaymentActor: 'actor', operationId: 'explicit-new-click', ordinaryNativeHead: {
      ownerOperationKey: 'owner', ownerOperationId: 'old-native', history: [] } }, payload: [] };
  const fn = new Function('msg', 'global', 'env', source);
  const result = fn(message, { get: () => undefined }, { get: () => undefined });
  assert.equal(result[1].statusCode, 202); // no injected helper global, unknown owner stays held
  assert.equal(typeof new Function(source.slice(0, source.indexOf('// Diagnostic observer:'))
    + '\nreturn bookingPaymentLifecycle.nativeReleased;')(), 'function');
});
for (const [name, mutate] of Object.entries({
  'deployed old cleanup4': n => { n.find(n => n.id === ids.cleanup).outputs = 4; },
  'missing ACK': n => n.splice(n.findIndex(n => n.id === ids.ack), 1),
  'lost paid lane': n => { n.find(n => n.id === ids.router).wires[4] = []; },
  'foreign database': n => { n.find(n => n.id === 'game-reader').clientNode = 'other-db'; },
  'disabled tab': n => { n[0].disabled = true; },
  'source drift': n => { n.find(n => n.id === ids.router).func = 'return msg;'; },
  'dangling wire': n => { n.find(n => n.id === ids.router).wires[0] = ['missing']; },
  'new callback collision': n => n.push({ id: ids.routerFind, type: 'debug', wires: [] }),
})) test('composer rejects ' + name, () => { const n = fixture(); mutate(n); assert.throws(() => compose(n)); });
test('whole-source drift and reapplication cannot produce another candidate', () => {
  const n = fixture(), bytes = Buffer.from(JSON.stringify(n));
  assert.throws(() => composeBookingPaymentLifecycle(bytes, '0'.repeat(64)), /SOURCE_DRIFT/);
  const result = compose(n); assert.throws(() => composeBookingPaymentLifecycle(result.candidateBytes, result.candidateSha256));
  const t = targets.find(t => t.id === ids.router), once = patchBookingPaymentFunction(baseline(t), t);
  assert.throws(() => patchBookingPaymentFunction(once, t), /ANCHOR_DRIFT/);
});
