import assert from 'node:assert/strict';
import test from 'node:test';
import { createRequire } from 'node:module';
import { randomUUID } from 'node:crypto';
const require = createRequire(import.meta.url);
const register = require('../../node-red/max-outbox-adapter/max-outbox-send.js');
const { deliver, createRateScheduler } = register;
const command = target => ({ id: randomUUID(), leaseToken: randomUUID(), connector: 'MAX_BOT',
  text: 'synthetic', targetExternalChatId: target, leasedUntil: new Date(Date.now() + 60000).toISOString() });
const accepted = () => new Response(JSON.stringify({ message: { body: { mid: 'synthetic' } } }), { status: 200 });

test('same dialog is serialized with at least 500ms between starts across node instances/connectors', async () => {
  const original = globalThis.fetch, handlers = [], starts = [];
  let Type, active = 0, maximumActive = 0;
  const RED = { nodes: { registerType: (_name, type) => { Type = type; },
    getNode: () => ({ token: 'synthetic' }), createNode: node => {
      node.on = (name, fn) => { if (name === 'input') handlers.push(fn); }; node.warn = () => {};
    } } };
  try {
    globalThis.fetch = async () => {
      starts.push(performance.now()); maximumActive = Math.max(maximumActive, ++active);
      await new Promise(resolve => setTimeout(resolve, 15)); active--; return accepted();
    };
    register(RED); new Type({ bot: 'one' }); new Type({ bot: 'two' });
    const first = command('synthetic-shared-dialog'), second = { ...command('synthetic-shared-dialog'), connector: 'MAX_ACADEMY_BOT' };
    const receipts = [];
    await Promise.all(handlers.map((handler, index) => handler({ supportOutbox: [first, second][index] }, x => receipts.push(x), () => {})));
    assert.equal(starts.length, 2); assert.ok(starts[1] - starts[0] >= 500); assert.equal(maximumActive, 1);
    assert.ok(receipts.every(x => x.maxOutboxReceipt.kind === 'ack'));
  } finally { globalThis.fetch = original; }
});

test('different dialogs progress independently while one transport is in flight', async () => {
  let release, started;
  const began = new Promise(resolve => { started = resolve; });
  const scheduler = createRateScheduler({ intervalMs: 5 });
  const one = scheduler.run('first', () => { started(); return new Promise(resolve => { release = resolve; }); }, { latestStart: Infinity });
  await began;
  assert.equal(await scheduler.run('second', () => 'independent', { latestStart: Infinity }), 'independent');
  release('first'); assert.equal(await one, 'first'); assert.equal(scheduler.snapshot().pending, 0);
  await new Promise(resolve => setTimeout(resolve, 10)); assert.equal(scheduler.snapshot().dialogs, 0);
});

test('queued lease expiring behind an earlier attempt makes zero additional provider calls', async () => {
  let clock = 0, release, began;
  const started = new Promise(resolve => { began = resolve; });
  const scheduler = createRateScheduler({ now: () => clock, monotonicNow: () => clock, wait: async ms => { clock += ms; } });
  const first = scheduler.run('same', () => { began(); return new Promise(resolve => { release = resolve; }); }, { latestStart: 40000 });
  await started;
  let calls = 0;
  const c = { ...command('expired-during-wait'), leasedUntil: new Date(60000).toISOString() };
  // Route the real transport through the same busy key to exercise its post-wait guard.
  const queued = deliver(c, 'synthetic', { now: () => clock, fetchImpl: async () => { calls++; return accepted(); },
    scheduler: { run: (_key, operation, options) => scheduler.run('same', operation, options) } });
  clock = 40001; release(null); await first;
  assert.equal((await queued).failure.code, 'local_deferred'); assert.equal(calls, 0); assert.equal(scheduler.snapshot().pending, 0);
});

test('bounded pending work and abort while queued do not start provider attempts', async () => {
  let clock = 0, release, began;
  const started = new Promise(resolve => { began = resolve; });
  const scheduler = createRateScheduler({ maximumPending: 2, now: () => clock, monotonicNow: () => clock, wait: async ms => { clock += ms; } });
  const one = scheduler.run('same', () => { began(); return new Promise(resolve => { release = resolve; }); }, { latestStart: 10000 });
  await started;
  const abort = new AbortController();
  const two = scheduler.run('same', () => assert.fail('Aborted queue must not run'), { signal: abort.signal, latestStart: 10000 });
  assert.equal(await scheduler.run('overflow', () => assert.fail('Bound must hold'), { latestStart: 10000 }), null);
  abort.abort(); clock = 1000; release(null); await one; assert.equal(await two, null);
  assert.deepEqual(scheduler.snapshot(), { pending: 0, dialogs: 0 });
});

test('backward clock jump cannot extend queued lease beyond its original monotonic budget', async () => {
  let wall = 0, monotonic = 0, release, began, calls = 0;
  const started = new Promise(resolve => { began = resolve; });
  const scheduler = createRateScheduler({ now: () => wall, monotonicNow: () => monotonic });
  const first = scheduler.run('same', () => { began(); return new Promise(resolve => { release = resolve; }); }, { latestStart: 40000 });
  await started;
  const c = { ...command('clock-rollback'), leasedUntil: new Date(60000).toISOString() };
  const queued = deliver(c, 'synthetic', {now:()=>wall,fetchImpl:async()=>{ calls++; return accepted(); },
    scheduler:{run:(_key,operation,options)=>scheduler.run('same',operation,options)}});
  monotonic = 50000; wall = -100000; release(null); await first;
  assert.equal((await queued).failure.code,'local_deferred'); assert.equal(calls,0);
});

test('consecutive scheduling remembers cooldown after prior request has completed', async () => {
  let clock = 0;
  const waits = [], starts = [];
  const scheduler = createRateScheduler({ now: () => clock, monotonicNow: () => clock, wait: async ms => { waits.push(ms); clock += ms; } });
  for (let i = 0; i < 3; i++) await scheduler.run('same', () => starts.push(clock), { latestStart: 10000 });
  assert.deepEqual(starts, [0, 500, 1000]); assert.deepEqual(waits, [500, 500]);
});


test('wall-clock jumps cannot bypass monotonic dialog spacing', async () => {
  let wall = 0, monotonic = 0;
  const waits = [];
  const scheduler = createRateScheduler({ now: () => wall, monotonicNow: () => monotonic,
    wait: async ms => { waits.push(ms); monotonic += ms; } });
  await scheduler.run('same', () => true, { latestStart: Infinity });
  wall = 1_000_000;
  await scheduler.run('same', () => true, { latestStart: Infinity });
  assert.deepEqual(waits, [500]);
});


test('provider body cannot impersonate local pre-send deferral', async () => {
  const result = await deliver(command('synthetic-provider-spoof'), 'synthetic', {
    fetchImpl: async () => new Response(JSON.stringify({code:'local_deferred'}),{status:503}) });
  assert.equal(result.failure.code, 'unclassified'); assert.equal(result.failure.status, 503);
});

test('backward wall-clock jump preserves monotonic cooldown and idle state cleanup', async () => {
  let wall = 100000, monotonic = 0;
  const scheduler = createRateScheduler({ now: () => wall, monotonicNow: () => monotonic,
    wait: async ms => { monotonic += ms; } });
  const starts = [];
  await scheduler.run('same', () => starts.push(monotonic), {latestStart: Infinity});
  wall = -100000;
  await scheduler.run('same', () => { starts.push(monotonic); monotonic += 500; }, {latestStart: Infinity});
  assert.deepEqual(starts,[0,500]); assert.deepEqual(scheduler.snapshot(),{pending:0,dialogs:0});
});


test('early timer wake rechecks the monotonic interval before transport start', async () => {
  let monotonic = 0;
  const waits = [];
  const scheduler = createRateScheduler({ now: () => 0, monotonicNow: () => monotonic,
    wait: async ms => { waits.push(ms); monotonic += waits.length === 1 ? ms - 1 : ms; } });
  await scheduler.run('same', () => true, {latestStart: Infinity});
  await scheduler.run('same', () => true, {latestStart: Infinity});
  assert.deepEqual(waits,[500,1]); assert.equal(monotonic,500);
});
