import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import test from 'node:test';
import { composeTournamentCapacityArtifacts, patchTournamentCapacityRouter,
  patchTournamentCapacityFinalizer, readCapacitySnippets } from '../patch_live_tournament_capacity_refusal.mjs';

const hash = value => crypto.createHash('sha256').update(value).digest('hex');
const router = fs.readFileSync('scripts/nodered_subscription_booking_nodes/fn_subscription_booking_router.js', 'utf8');
const finalizer = `const ctx=msg._subscriptionBooking,payload=msg.payload,responseStatus=Number(msg.statusCode)||0;\n${
  fs.readFileSync('scripts/nodered_lk1_hub_nodes/finalize.js', 'utf8')}`;
const beforeFinalizer = finalizer.replace(readCapacitySnippets().FINALIZE, '');
const fixture = [
  { id: 'tab', type: 'tab', label: 'Fixture' },
  { id: 'router', type: 'function', z: 'tab', outputs: 1, wires: [[]], initialize: '', func: router },
  { id: 'finalizer', type: 'function', z: 'tab', outputs: 1, wires: [[]], initialize: '', func: beforeFinalizer },
  { id: 'unrelated', type: 'function', z: 'tab', outputs: 1, wires: [[]], initialize: '', func: 'return msg;' },
];
const bytes = Buffer.from(`${JSON.stringify(fixture)}\n`);
const options = { expectedSourceSha256: hash(bytes), targets: {
  router: { id: 'router', outputs: 1, sha256: hash(router) },
  finalizer: { id: 'finalizer', outputs: 1, sha256: hash(beforeFinalizer) },
} };

test('candidate changes exactly two function bodies and preserves every other field', () => {
  const result = composeTournamentCapacityArtifacts(bytes, options);
  const after = JSON.parse(result.candidateBytes);
  assert.equal(result.changedNodeCount, 2);
  assert.equal(result.addedNodeCount, 0);
  assert.equal(after.length, fixture.length);
  for (let i = 0; i < fixture.length; i++) {
    assert.deepEqual({ ...after[i], func: null }, { ...fixture[i], func: null });
    if (['router', 'finalizer'].includes(fixture[i].id)) assert.notEqual(after[i].func, fixture[i].func);
    else assert.deepEqual(after[i], fixture[i]);
  }
  assert.equal(after[2].func, finalizer, 'owning source and focused finalizer must stay aligned');
});

test('whole-flow drift, body drift, disabled targets and repeated patching fail closed', () => {
  assert.throws(() => composeTournamentCapacityArtifacts(Buffer.from('[]')), /preimage drift/);
  const changed = structuredClone(fixture); changed[1].func += '\n// changed';
  const drift = Buffer.from(JSON.stringify(changed));
  assert.throws(() => composeTournamentCapacityArtifacts(drift, { ...options, expectedSourceSha256: hash(drift) }), /router preimage drift/);
  const disabled = structuredClone(fixture); disabled[2].d = true;
  const disabledBytes = Buffer.from(JSON.stringify(disabled));
  assert.throws(() => composeTournamentCapacityArtifacts(disabledBytes, { ...options, expectedSourceSha256: hash(disabledBytes) }), /finalizer preimage drift/);
  assert.throws(() => patchTournamentCapacityRouter(patchTournamentCapacityRouter(router)), /already patched/);
  assert.throws(() => patchTournamentCapacityFinalizer(finalizer), /already patched/);
  assert.throws(() => patchTournamentCapacityRouter(router.replace('if (ctx.step === "booking_create") {', '// missing')), /anchor/);
});
