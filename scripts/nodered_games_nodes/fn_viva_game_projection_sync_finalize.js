const LEASE_KEY = "lk_viva_game_projection_sync_lease_until";
const RUN_STATE_KEY = "lk_viva_game_projection_sync_run_state";
const LAST_REPORT_KEY = "lk_viva_game_projection_sync_last_report";
const FAILURE_LIMIT = 20;

const isObj = (value) => Boolean(value && typeof value === "object" && !Array.isArray(value));
const toStr = (value) => {
  if (value === null || value === undefined) return null;
  const text = String(value).trim();
  return text || null;
};
const count = (value) => Number.isSafeInteger(value) && value >= 0 ? value : 0;
const event = isObj(msg._vivaProjectionSyncEvent) ? msg._vivaProjectionSyncEvent : null;
const runId = toStr(event?.runId || msg._vivaProjectionSync?.runId);
const state = global.get(RUN_STATE_KEY);

if (!event) {
  delete msg._vivaProjectionSyncGroup;
  delete msg._vivaProjectionSyncBearer;
  return msg;
}
if (!runId || !isObj(state) || state.runId !== runId) {
  msg.payload = {
    ok: false,
    source: "viva_game_projection_sync",
    code: "STALE_RUN_EVENT_IGNORED",
    runId,
    at: new Date().toISOString(),
  };
  delete msg._vivaProjectionSyncEvent;
  delete msg._vivaProjectionSyncGroup;
  delete msg._vivaProjectionSyncBearer;
  return msg;
}

const latchFailure = () => {
  state.failed = true;
  if (!Array.isArray(state.failures)) state.failures = [];
  if (state.failures.length < FAILURE_LIMIT) {
    state.failures.push({
      code: toStr(event.code) || "RUN_EVENT_FAILED",
      kind: toStr(event.kind),
      date: toStr(event.date),
      gameId: toStr(event.gameId),
      sourceId: toStr(event.sourceId),
    });
  }
};

if (event.kind === "DATE_DONE") {
  if (count(state.pendingDates) < 1) {
    event.code = "RUN_DATE_COUNTER_INVALID";
    latchFailure();
  } else {
    state.pendingDates -= 1;
    state.completedDates = count(state.completedDates) + 1;
  }
  state.driftCount = count(state.driftCount) + count(event.driftCount);
  if (!isObj(state.skipped)) state.skipped = {};
  if (isObj(event.skipped)) {
    for (const [key, value] of Object.entries(event.skipped)) {
      state.skipped[key] = count(state.skipped[key]) + count(value);
    }
  }
  if (event.ok !== true) latchFailure();
} else if (event.kind === "WRITE_DONE") {
  if (count(state.pendingWrites) < 1) {
    event.code = "RUN_WRITE_COUNTER_INVALID";
    latchFailure();
  } else {
    state.pendingWrites -= 1;
  }
  if (event.ok === true) state.writeSucceeded = count(state.writeSucceeded) + 1;
  else {
    state.writeFailed = count(state.writeFailed) + 1;
    latchFailure();
  }
} else {
  event.code = "RUN_EVENT_KIND_INVALID";
  latchFailure();
}

const nowIso = new Date().toISOString();
state.updatedAt = nowIso;
const complete = count(state.pendingDates) === 0 && count(state.pendingWrites) === 0;
if (complete) {
  state.completedAt = nowIso;
  const report = {
    ok: state.failed !== true,
    source: "viva_game_projection_sync",
    code: state.failed === true ? "RUN_COMPLETED_WITH_ERRORS" : "RUN_COMPLETED",
    runId: state.runId,
    mode: state.mode,
    startedAt: state.startedAt,
    completedAt: nowIso,
    checkedCount: count(state.checkedCount),
    eligibleCount: count(state.eligibleCount),
    dateCount: count(state.dateCount),
    completedDates: count(state.completedDates),
    driftCount: count(state.driftCount),
    writeScheduled: count(state.writeScheduled),
    writeSucceeded: count(state.writeSucceeded),
    writeFailed: count(state.writeFailed),
    skipped: isObj(state.skipped) ? state.skipped : {},
    failures: Array.isArray(state.failures) ? state.failures : [],
  };
  global.set(LAST_REPORT_KEY, report);
  const lease = global.get(LEASE_KEY);
  if (isObj(lease) && lease.runId === runId) global.set(LEASE_KEY, null);
  msg.payload = report;
} else {
  msg.payload = {
    ok: event.ok === true,
    source: "viva_game_projection_sync",
    code: "RUN_PROGRESS",
    eventCode: toStr(event.code),
    runId,
    pendingDates: count(state.pendingDates),
    pendingWrites: count(state.pendingWrites),
    failed: state.failed === true,
    at: nowIso,
  };
}
global.set(RUN_STATE_KEY, state);
delete msg._vivaProjectionSyncEvent;
delete msg._vivaProjectionSyncGroup;
delete msg._vivaProjectionSyncBearer;
return msg;
