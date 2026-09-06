import test from 'node:test';
import assert from 'node:assert/strict';
import { buildHubPolicyTransition, HUB_POLICY_KEY, HUB_POLICY_PRODUCT } from '../lib/lk1HubPolicyTransition.mjs';

const rule = { productId: HUB_POLICY_PRODUCT, maxActiveBookings: 4, freeGameMinutesPerDay: 60,
  gameOverageDiscountPercent: 30, groupTrainingDiscountPercent: 50, tournamentDiscountPercent: 50 };
const on = buildHubPolicyTransition({ expectedPrior: null, desired: rule });
const off = buildHubPolicyTransition({ expectedPrior: rule, desired: null });
function context(initial: unknown) {
  let value = structuredClone(initial);
  let writes = 0;
  return { get writes() { return writes; }, get value() { return structuredClone(value); },
    global: { get(key: string) { assert.equal(key, HUB_POLICY_KEY); return structuredClone(value); },
      set(key: string, next: unknown) { assert.equal(key, HUB_POLICY_KEY); writes++; value = structuredClone(next); } } };
}
const initialize = (transition: typeof on, global: object) => new Function('global', transition.initialize)(global);
const read = (transition: typeof on, global: object) => new Function('global', transition.reader + '\nreturn lk1ReadBoundPolicy();')(global);

test('HUB initializer is exact-prior, idempotent and source-bound with explicit OFF', () => {
  const state = context(undefined);
  initialize(on, state.global);
  assert.deepEqual(read(on, state.global), rule);
  initialize(on, state.global);
  assert.equal(state.writes, 1);
  initialize(off, state.global);
  assert.equal(read(off, state.global), null);
  assert.equal(state.writes, 2);
  initialize(off, state.global);
  assert.equal(state.writes, 2);
  assert.throws(() => read(on, state.global), /source policy mismatch/);
});

test('HUB foreign prior, invalid values and initializer failures never authorize stale shape-valid policy', () => {
  const foreign = context({ ...rule, maxActiveBookings: 5 });
  assert.throws(() => initialize(on, foreign.global), /prior mismatch/);
  assert.equal(foreign.writes, 0);
  assert.throws(() => read(on, foreign.global), /source policy mismatch/);
  const ignoredWrite = { get: () => rule, set() {} };
  assert.throws(() => initialize(off, ignoredWrite), /readback mismatch/);
  assert.throws(() => read(off, ignoredWrite), /source policy mismatch/);
  const failingStore = { get() { throw new Error('fixture store failure'); }, set() { assert.fail('no write after read failure'); } };
  assert.throws(() => initialize(on, failingStore), /store failure/);
  assert.throws(() => read(on, failingStore), /store failure/);
  for (const bad of [{ ...rule, extra: true }, { ...rule, gameOverageDiscountPercent: 101 },
    { ...rule, freeGameMinutesPerDay: '60' }, { ...rule, productId: 'foreign' }]) {
    assert.throws(() => buildHubPolicyTransition({ expectedPrior: null, desired: bad }), /shape mismatch/);
  }
  assert.throws(() => buildHubPolicyTransition(), /Explicit/);
});

test('HUB memory and persisted-context restart rehearsal retains source-bound OFF semantics', () => {
  // Synthetic context-store lifecycle, not a real Node-RED persistence proof.
  for (const persisted of [false, true]) {
    const running = context(undefined);
    initialize(on, running.global);
    const restartedOn = context(persisted ? running.value : undefined);
    initialize(on, restartedOn.global);
    assert.deepEqual(read(on, restartedOn.global), rule);
    initialize(off, restartedOn.global);
    const restartedOff = context(persisted ? restartedOn.value : undefined);
    initialize(off, restartedOff.global);
    assert.equal(read(off, restartedOff.global), null);
    assert.equal(restartedOff.writes, 0);
    // Restoring an initializer is not permission to serve a stale ON global.
    const stale = context(rule);
    assert.throws(() => read(off, stale.global), /source policy mismatch/);
  }
});
