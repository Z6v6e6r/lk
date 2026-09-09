import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { composeSubscriptionPaidJoinArtifacts } from '../patch_nodered_subscription_paid_join.mjs';
import { buildExactGraphContract, validateReviewedFlowContract } from '../nodered_reviewed_flow_deploy/runtime_contract.mjs';
const file = process.env.LK1_PAID_JOIN_LIVE_FIXTURE;
const bytes = file ? fs.readFileSync(file) : null;
const run = (name, fn) => test(name, { skip: !bytes }, fn);
run('Paid join candidate preserves every node and field except the two reviewed function bodies; rollback is exact', () => {
  const packet = composeSubscriptionPaidJoinArtifacts(bytes, 'fixture-paid-join');
  const before = JSON.parse(bytes);
  assert.equal(packet.candidate.length, before.length);
  assert.equal(packet.contract.allowedChanges.length, 2);
  const changed = new Set(packet.contract.allowedChanges.map(row => row.id));
  for (const row of before) {
    const after = packet.candidate.find(n => n.id === row.id);
    assert.deepEqual(changed.has(row.id) ? { ...after, func: row.func } : after, row);
  }
  const rollback = buildExactGraphContract({ liveBytes: packet.candidateBytes, candidateBytes: bytes,
    deploymentId: 'fixture-paid-join-rollback', allowedChanges: [...changed].map(id => ({ id, fields: ['func'] })) });
  validateReviewedFlowContract({ liveBytes: packet.candidateBytes, candidateBytes: bytes, contract: rollback });
  assert.throws(() => composeSubscriptionPaidJoinArtifacts(packet.candidateBytes, 'fixture-repeat'), /preimage drift/);
  for (const id of changed) {
    const drift = structuredClone(before);
    drift.find(row => row.id === id).func += '\n// unexpected change';
    assert.throws(() => composeSubscriptionPaidJoinArtifacts(Buffer.from(JSON.stringify(drift)), 'fixture-drift'), /preimage drift/);
  }
});
run('Paid join source fragments exactly match the patched live gateway', () => {
  const packet = composeSubscriptionPaidJoinArtifacts(bytes, 'fixture-source-alignment');
  const gateway = packet.candidate.find(n => n.id === 'lk_subscription_booking_router_20260804').func;
  const hooks = fs.readFileSync(new URL('../nodered_lk1_hub_nodes/gateway_hooks.js', import.meta.url), 'utf8').split(/^\/\/ HUB_([A-Z]+)\s*$/m);
  for (let i = 1; i < hooks.length; i += 2) {
    if (['HISTORY', 'BOOKING', 'CONFIRMATION'].includes(hooks[i])) assert.ok(gateway.includes(hooks[i + 1].trim()), hooks[i]);
  }
  const fragment = fs.readFileSync(new URL('../nodered_lk1_hub_nodes/gateway.js', import.meta.url), 'utf8');
  const start = fragment.indexOf('if (ctx.step === "lk1_usage_operations") {');
  const end = fragment.indexOf('\nif (ctx.step === ', start + 1);
  assert.ok(gateway.includes(fragment.slice(start, end)));
});
run('Preview counts cross-date paid benefit bookings while keeping daily free minutes scoped', () => {
  const packet = composeSubscriptionPaidJoinArtifacts(bytes, 'fixture-preview');
  const source = packet.candidate.find(n => n.id === 'lk_subscription_price_preview_20260908_router').func;
  const pure = source.slice(0, source.indexOf('// Dedicated advisory graph.'));
  const date = '2026-09-23';
  const ctx = { step: 'lk1_usage_operations', actorClientId: 'fixture:client', tenantKey: 'fixture',
    clientSubscriptionId: 'fixture:subscription', serviceDate: date, managedAction: 'JOIN_GAME',
    lk1: { rule: { productId: 'db7a5250-7369-4f43-8ac5-9111be24bc74', maxActiveBookings: 4,
      freeGameMinutesPerDay: 60, gameOverageDiscountPercent: 30, groupTrainingDiscountPercent: 50, tournamentDiscountPercent: 50 },
    target: {}, bookings: [], activeBookings: [{ id: 'fixture:booking', paymentType: 'ON_PLACE' }] } };
  const operation = { actorClientId: ctx.actorClientId, tenantKey: ctx.tenantKey, clientSubscriptionId: ctx.clientSubscriptionId,
    serviceDate: '2026-09-24', state: 'CONFIRMED', bookingId: 'fixture:booking',
    lk1: { decision: { gameMinutes: { localDate: '2026-09-24', freeMinutes: 60 } } } };
  const execute = value => new Function('msg', 'global', pure + '\nreturn canonicalUsage(msg);')(
    { _subscriptionBooking: structuredClone(ctx), payload: [value] }, { get() {} });
  const result = execute(operation);
  assert.equal(result.previewError, undefined);
  assert.equal(result._managedSubscriptionPolicyInput.usage.activeServices, 1);
  assert.equal(result._managedSubscriptionPolicyInput.usage.usedOrReservedFreeMinutesToday, 0);
  assert.equal(execute({ ...operation, serviceDate: 'invalid' }).previewError, 'LK1_ALLOWANCE_RECORD_INVALID');
});
