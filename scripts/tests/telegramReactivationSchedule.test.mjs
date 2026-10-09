import assert from 'node:assert/strict';
import test from 'node:test';
import { createDatedSchedule, buildDatedScheduleNode } from '../telegram_reactivation/schedule.mjs';
import { buildFlow } from '../telegram_reactivation/build_flow.mjs';

const sendWindow = { stopAt: '2026-10-08T19:00:00.000Z', resumeAt: '2026-10-09T07:00:00.000Z' };
const schedule = { batchId: 'reactivation-20261008-academy-v2', sendWindow,
  acknowledgedUnknown: { academy: 2, friendship: 1, group: 0, return: 0 } };
function clock(at) {
  let time = Date.parse(at);
  const timers = [], sends = [], cancelled = [];
  const cancel = createDatedSchedule(schedule, { now: () => time,
    setTimer: (callback, delay) => { const timer = { callback, delay }; timers.push(timer); return timer; },
    clearTimer: timer => cancelled.push(timer), send: msg => sends.push(msg) });
  return { timers, sends, cancelled, cancel, at: value => { time = Date.parse(value); } };
}

test('dated timers stop at the exact instant and resume with the fixed reviewed counts', () => {
  const c = clock('2026-10-08T18:00:00.000Z');
  assert.deepEqual(c.timers.map(t => t.delay), [3600000, 13 * 3600000]);
  c.at(sendWindow.stopAt); c.timers[0].callback();
  c.at(sendWindow.resumeAt); c.timers[1].callback();
  assert.deepEqual(c.sends, [{ action: 'stop', scheduledBatchId: schedule.batchId }, { action: 'resume_all', scheduledBatchId: schedule.batchId,
    acknowledgedUnknown: schedule.acknowledgedUnknown }]);
});

test('startup during the quiet window stops immediately; missed morning never resumes later', () => {
  const night = clock('2026-10-08T20:00:00.000Z');
  assert.equal(night.timers[0].delay, 0);
  night.timers[0].callback();
  assert.deepEqual(night.sends, [{ action: 'stop', scheduledBatchId: schedule.batchId }]);
  const late = clock('2026-10-09T07:01:00.000Z');
  assert.equal(late.timers.length, 0);
  assert.equal(late.sends.length, 0);
});

test('delayed callbacks and callbacks queued before finalize cannot resume', () => {
  const late = clock('2026-10-08T18:00:00.000Z');
  late.at('2026-10-09T07:01:00.000Z'); late.timers[1].callback();
  assert.equal(late.sends.length, 0);
  const closed = clock('2026-10-08T18:00:00.000Z');
  closed.cancel(); closed.at(sendWindow.resumeAt); closed.timers[1].callback();
  assert.equal(closed.cancelled.length, 2);
  assert.equal(closed.sends.length, 0);
});

test('an early timer callback cannot stop or resume outside its absolute interval', () => {
  const c = clock('2026-10-08T18:00:00.000Z');
  c.timers.forEach(t => t.callback());
  assert.equal(c.sends.length, 0);
});

test('schedule is explicitly opt-in, fixed to the same window and valid reviewed map', () => {
  assert.equal(buildFlow().some(n => n.id === 'tg_reactivation_schedule_v1'), false);
  const flow = buildFlow({ sendWindow, schedule });
  const controller = flow.find(n => n.id === 'tg_reactivation_engine_v1');
  assert.ok(controller.func.includes('sendWindow: ' + JSON.stringify(sendWindow)));
  const timer = flow.find(n => n.id === 'tg_reactivation_schedule_v1');
  assert.deepEqual(timer.wires, [[controller.id]]);
  assert.equal(timer.libs.length, 0);
  for (const source of [timer.func, timer.initialize, timer.finalize])
    assert.doesNotThrow(() => new Function('node', 'context', source));
  assert.throws(() => buildFlow({ schedule }), /schedule_window_mismatch/);
  for (const acknowledgedUnknown of [{}, { ...schedule.acknowledgedUnknown, academy: -1 },
    { ...schedule.acknowledgedUnknown, extra: 0 }])
    assert.throws(() => buildDatedScheduleNode({ ...schedule, acknowledgedUnknown }, { z: 'tab', controllerId: 'controller' }),
      /invalid_dated_schedule/);
});

test('generated OnStart registers without awaiting and finalize cancels its own timers', () => {
  const node = buildDatedScheduleNode(schedule, { z: 'tab', controllerId: 'controller' });
  const state = new Map(), timers = [], cancelled = [];
  const context = { get: key => state.get(key), set: (key, value) => state.set(key, value) };
  new Function('node', 'context', 'Date', 'setTimeout', 'clearTimeout', node.initialize)(
    { send: () => { throw new Error('synchronous_send_unexpected'); }, status: () => {} }, context,
    { parse: Date.parse, now: () => Date.parse('2026-10-08T18:00:00.000Z') },
    (callback, delay) => { const timer = { callback, delay }; timers.push(timer); return timer; },
    timer => cancelled.push(timer));
  assert.equal(timers.length, 2);
  new Function('context', node.finalize)(context);
  assert.equal(cancelled.length, 2);
  assert.equal(state.get('cancelSchedule'), null);
});

test('timer from another batch cannot stop or resume the controller', async () => {
  const controller = buildFlow({ sendWindow, schedule }).find(n => n.id === 'tg_reactivation_engine_v1');
  const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor;
  const execute = new AsyncFunction('msg', 'node', 'context', controller.func);
  for (const action of ['stop', 'resume_all']) {
    const stopped = [], emitted = [], job = { stopped: false, batchId: schedule.batchId };
    const state = new Map([['job', job], ['engine', { stop: () => stopped.push(true) }]]);
    await execute({ action, scheduledBatchId: 'reactivation-20261008-other' },
      { send: msg => emitted.push(msg) }, { get: key => state.get(key), set: (key, value) => state.set(key, value) });
    assert.deepEqual(emitted, [{ payload: { error: 'schedule_batch_mismatch', action: 'invalid' } }]);
    assert.equal(stopped.length, 0);
    assert.equal(job.stopped, false);
  }
  const stopped = [], emitted = [], job = { stopped: false, batchId: 'reactivation-20261008-other' };
  const state = new Map([['job', job], ['engine', { stop: () => stopped.push(true) }]]);
  await execute({ action: 'stop', scheduledBatchId: schedule.batchId },
    { send: msg => emitted.push(msg) }, { get: key => state.get(key), set: (key, value) => state.set(key, value) });
  assert.equal(emitted[0].payload.error, 'schedule_batch_mismatch');
  assert.equal(stopped.length, 0);
  assert.equal(job.stopped, false);
});
