import { createCampaignEngine } from './engine.mjs';

// Embedded into a separate Node-RED Function. Dates are absolute UTC instants,
// never recurring cron expressions or delays awaited during startup.
export function createDatedSchedule(schedule, { now, setTimer, clearTimer, send }) {
  const stopAt = Date.parse(schedule.sendWindow.stopAt);
  const resumeAt = Date.parse(schedule.sendWindow.resumeAt);
  const job = { cancelled: false, timers: [] };
  const emit = (action, at) => {
    if (job.cancelled) return;
    const time = now();
    if (action === 'stop' ? time < stopAt || time >= resumeAt : time < at || time >= at + 60000) return;
    send(action === 'stop' ? { action, scheduledBatchId: schedule.batchId } : {
      action, scheduledBatchId: schedule.batchId, acknowledgedUnknown: { ...schedule.acknowledgedUnknown }
    });
  };
  const time = now();
  if (time < resumeAt) job.timers.push(setTimer(() => emit('stop', stopAt), Math.max(0, stopAt - time)));
  if (time < resumeAt + 60000)
    job.timers.push(setTimer(() => emit('resume_all', resumeAt), Math.max(0, resumeAt - time)));
  return () => {
    job.cancelled = true;
    for (const timer of job.timers) clearTimer(timer);
  };
}

export function buildDatedScheduleNode(schedule, { z, controllerId }) {
  createCampaignEngine({ sendWindow: schedule?.sendWindow });
  const ids = ['academy', 'friendship', 'group', 'return'];
  const counts = schedule?.acknowledgedUnknown;
  if (!schedule?.sendWindow || !/^reactivation-[0-9]{8}-[a-z0-9-]{1,32}$/.test(schedule.batchId) ||
    !counts || typeof counts !== 'object' || Array.isArray(counts) || Object.keys(counts).length !== 4 ||
    !ids.every(id => Object.hasOwn(counts, id) && Number.isSafeInteger(counts[id]) && counts[id] >= 0) ||
    Date.parse(schedule.sendWindow.resumeAt) - Date.parse(schedule.sendWindow.stopAt) > 86400000)
    throw new Error('invalid_dated_schedule');
  const publicPlan = { batchId: schedule.batchId, sendWindow: { ...schedule.sendWindow },
    acknowledgedUnknown: Object.fromEntries(ids.map(id => [id, counts[id]])) };
  return { id: 'tg_reactivation_schedule_v1', z, type: 'function',
    name: 'One dated STOP / RESUME (UTC, reviewed unknown only)',
    outputs: 1, timeout: 0, x: 390, y: 870, wires: [[controllerId]], libs: [],
    func: 'return null;',
    initialize: 'const createDatedSchedule = ' + createDatedSchedule.toString() + ';\n' +
      'const schedule = ' + JSON.stringify(publicPlan) + ';\n' +
      "context.set('cancelSchedule', createDatedSchedule(schedule, {\n" +
      '  now: () => Date.now(), setTimer: setTimeout, clearTimer: clearTimeout, send: msg => node.send(msg)\n' +
      '}));\n' +
      "node.status({fill:'blue',shape:'ring',text:'UTC stop '+schedule.sendWindow.stopAt+' / resume '+schedule.sendWindow.resumeAt});",
    finalize: "const cancel = context.get('cancelSchedule'); if (cancel) cancel(); context.set('cancelSchedule', null);"
  };
}
