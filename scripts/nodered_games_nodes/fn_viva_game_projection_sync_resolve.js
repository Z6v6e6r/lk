const AUDIT_MAX_EVENTS = 200;
const RUN_STATE_KEY = "lk_viva_game_projection_sync_run_state";

const isObj = (value) => Boolean(value && typeof value === "object" && !Array.isArray(value));
const toStr = (value) => {
  if (value === null || value === undefined) return null;
  const text = String(value).trim();
  return text || null;
};
const normalizeId = (value) => toStr(value)?.toLowerCase() || null;
const extractPage = (payload) => {
  if (Array.isArray(payload)) return { recognized: true, rows: payload, pagination: {}, responseShape: "array" };
  if (!isObj(payload)) return { recognized: false, rows: [], pagination: {}, responseShape: null };
  if (Array.isArray(payload.content)) return { recognized: true, rows: payload.content, pagination: payload, responseShape: "page" };
  if (Array.isArray(payload.items)) return { recognized: true, rows: payload.items, pagination: payload, responseShape: "page" };
  if (Array.isArray(payload.data)) return { recognized: true, rows: payload.data, pagination: payload, responseShape: "page" };
  if (isObj(payload.data)) {
    if (Array.isArray(payload.data.content)) {
      return { recognized: true, rows: payload.data.content, pagination: payload.data, responseShape: "page" };
    }
    if (Array.isArray(payload.data.items)) {
      return { recognized: true, rows: payload.data.items, pagination: payload.data, responseShape: "page" };
    }
  }
  return { recognized: false, rows: [], pagination: {}, responseShape: null };
};
const exerciseId = (row) => normalizeId(row?.id || row?.exerciseId || row?.uuid);
const roomId = (row) => toStr(row?.room?.id || row?.roomId || row?.court?.id || row?.courtId);
const roomName = (row) => toStr(row?.room?.name || row?.room?.title || row?.roomName || row?.court?.name || row?.courtName);
const studioId = (row) => toStr(row?.studio?.id || row?.studioId || row?.station?.id || row?.stationId);
const exerciseDate = (row) => toStr(row?.date || row?.booking?.date || toStr(row?.timeFrom)?.slice(0, 10));
const normalizeTime = (value) => {
  const text = toStr(value);
  if (!text) return null;
  const isoMatch = /T(\d{2}:\d{2})(?::\d{2})?/.exec(text);
  if (isoMatch) return isoMatch[1];
  const plainMatch = /^(\d{2}:\d{2})(?::\d{2})?$/.exec(text);
  return plainMatch ? plainMatch[1] : null;
};
const timeFrom = (row) => normalizeTime(row?.timeFrom || row?.startTime || row?.booking?.timeFrom);
const timeTo = (row) => normalizeTime(row?.timeTo || row?.endTime || row?.booking?.timeTo);
const isCancelled = (row) => {
  if (row?.isCancelled === true || row?.cancelled === true || row?.canceled === true || row?.deleted === true) return true;
  if (toStr(row?.cancellationDate || row?.cancelledAt || row?.canceledAt || row?.deletedAt)) return true;
  return /CANCEL|DELETE/.test(String(row?.exerciseStatus || row?.status || row?.state || "").toUpperCase());
};
const safeBase = () => {
  const copy = { ...msg };
  delete copy.headers;
  delete copy.url;
  delete copy.method;
  delete copy.statusCode;
  delete copy.vivaToken;
  delete copy._vivaProjectionSyncBearer;
  delete copy._vivaProjectionSyncGroup;
  delete copy.responseUrl;
  delete copy.requestTimeout;
  delete copy.followRedirects;
  delete copy.maxRedirects;
  return copy;
};
const report = (code, details = {}, ok = false) => {
  const output = safeBase();
  output.payload = {
    ok,
    source: "viva_game_projection_sync",
    code,
    mode: msg._vivaProjectionSync?.mode || null,
    runId: msg._vivaProjectionSync?.runId || null,
    date: msg._vivaProjectionSyncGroup?.date || null,
    at: new Date().toISOString(),
    ...details,
  };
  output._vivaProjectionSyncEvent = { kind: "DATE_DONE", ...output.payload };
  return [null, null, output];
};

const ctx = isObj(msg._vivaProjectionSync) ? msg._vivaProjectionSync : null;
const group = isObj(msg._vivaProjectionSyncGroup) ? msg._vivaProjectionSyncGroup : null;
const statusCode = Number(msg.statusCode);
if (!ctx || !group || !Array.isArray(group.games)) return report("RUN_CONTEXT_INVALID");
const runState = global.get(RUN_STATE_KEY);
if (!isObj(runState) || runState.runId !== ctx.runId) {
  const output = safeBase();
  output.payload = {
    ok: false,
    source: "viva_game_projection_sync",
    code: "STALE_RUN_IGNORED",
    runId: ctx.runId,
    date: group.date || null,
    at: new Date().toISOString(),
  };
  return [null, null, output];
}
if (!Number.isFinite(statusCode) || statusCode < 200 || statusCode >= 300) {
  return report("PROVIDER_READ_FAILED", { statusCode: Number.isFinite(statusCode) ? statusCode : null });
}

const pageData = extractPage(msg.payload);
if (!pageData.recognized) return report("PROVIDER_RESPONSE_SCHEMA_INVALID");
const rows = pageData.rows;
const pagination = pageData.pagination;
const page = Number.isSafeInteger(Number(group.page)) ? Number(group.page) : 0;
const pageSize = Number(group.pageSize || 200);
const maxPages = Number(group.maxPages || 5);
const isUnpagedArray = pageData.responseShape === "array";
if (isUnpagedArray && (page !== 0 || rows.length >= pageSize * maxPages)) {
  return report("PROVIDER_PAGE_TRUNCATED", { page, providerRowCount: rows.length });
}
const hasLast = Object.hasOwn(pagination, "last");
const hasTotalPages = Object.hasOwn(pagination, "totalPages");
const totalPages = Number(pagination.totalPages);
if (!isUnpagedArray && ((hasLast && typeof pagination.last !== "boolean")
  || (hasTotalPages && (!Number.isInteger(totalPages) || totalPages < 0))
  || (!hasLast && !hasTotalPages))) {
  return report("PROVIDER_PAGE_METADATA_INVALID", { page });
}
if (!isUnpagedArray && hasLast && hasTotalPages) {
  const expectedLast = totalPages === 0 || page + 1 >= totalPages;
  if (pagination.last !== expectedLast) {
    return report("PROVIDER_PAGE_METADATA_CONFLICT", { page, totalPages });
  }
}
const fingerprint = rows.map((row) => exerciseId(row) || "missing").join("|");
if (page > 0 && fingerprint && fingerprint === group.lastFingerprint) {
  return report("PROVIDER_PAGE_REPEATED", { page, providerRowCount: rows.length });
}
const providerRows = [...(Array.isArray(group.providerRows) ? group.providerRows : []), ...rows];
const pageComplete = isUnpagedArray || (hasLast ? pagination.last === true : page + 1 >= totalPages);
if (!pageComplete) {
  if (page + 1 >= maxPages) {
    return report("PROVIDER_PAGE_TRUNCATED", { page, providerRowCount: providerRows.length });
  }
  const token = toStr(msg._vivaProjectionSyncBearer);
  if (!token) return report("RUN_CONTEXT_INVALID");
  const next = {
    _vivaProjectionSync: { ...ctx },
    _vivaProjectionSyncGroup: {
      ...group,
      page: page + 1,
      providerRows,
      lastFingerprint: fingerprint || null,
    },
    _vivaProjectionSyncBearer: token,
    method: "GET",
    url: `https://api.vivacrm.ru/api/v1/exercises?date=${encodeURIComponent(group.date)}`
      + `&includeCanceled=true&page=${page + 1}&size=${pageSize}`,
    headers: { Authorization: `Bearer ${token}`, Accept: "application/json" },
    requestTimeout: 8 * 1000,
    followRedirects: false,
    maxRedirects: 0,
    payload: undefined,
  };
  return [null, next, null];
}

const byExerciseId = new Map();
for (const row of providerRows) {
  const id = exerciseId(row);
  if (!id) continue;
  const matches = byExerciseId.get(id) || [];
  matches.push(row);
  byExerciseId.set(id, matches);
}

const writes = [];
const skipped = {
  missing: 0,
  duplicate: 0,
  cancelled: 0,
  studioMismatch: 0,
  slotMismatch: 0,
  roomMissing: 0,
  unchanged: 0,
};
const nowIso = new Date().toISOString();
for (const game of group.games) {
  const matches = byExerciseId.get(normalizeId(game.exerciseId)) || [];
  if (matches.length === 0) { skipped.missing += 1; continue; }
  if (matches.length !== 1) { skipped.duplicate += 1; continue; }
  const provider = matches[0];
  if (isCancelled(provider)) { skipped.cancelled += 1; continue; }
  const nextStudioId = studioId(provider);
  if (!nextStudioId || normalizeId(nextStudioId) !== normalizeId(game.studioId)) {
    skipped.studioMismatch += 1;
    continue;
  }
  if (
    exerciseDate(provider) !== game.date
    || timeFrom(provider) !== normalizeTime(game.timeFrom)
    || timeTo(provider) !== normalizeTime(game.timeTo)
  ) {
    skipped.slotMismatch += 1;
    continue;
  }
  const nextRoomId = roomId(provider);
  const nextRoomName = roomName(provider);
  if (!nextRoomId || !nextRoomName) { skipped.roomMissing += 1; continue; }
  if (normalizeId(nextRoomId) === normalizeId(game.roomId) && nextRoomName === game.roomName) {
    skipped.unchanged += 1;
    continue;
  }

  const event = {
    id: `g_audit_${Date.now()}_${Math.random().toString(36).slice(2, 10)}`,
    at: nowIso,
    type: "GAME_BOOKING_ROOM_RECONCILED",
    source: "viva_game_projection_sync",
    payload: {
      gameId: game.id,
      vivaExerciseId: game.exerciseId,
      studioId: game.studioId,
      date: game.date,
      previousRoomId: game.roomId,
      previousRoomName: game.roomName,
      roomId: nextRoomId,
      roomName: nextRoomName,
      mode: ctx.mode,
    },
  };
  if (ctx.mode !== "ENFORCE") continue;

  const write = {
    _vivaProjectionSync: { runId: ctx.runId, mode: ctx.mode },
  };
  const filter = {
    _id: game._id,
    id: game.id,
    tenantKey: game.tenantKey,
    archived: { $ne: true },
    status: game.status,
    revision: game.revision,
    "booking.vivaExerciseId": game.exerciseId,
    "booking.studioId": game.studioId,
    "booking.date": game.date,
    "booking.timeFrom": game.timeFrom,
    "booking.timeTo": game.timeTo,
    "booking.roomId": game.roomId,
    "booking.roomName": game.roomName === null ? { $in: [null, ""] } : game.roomName,
  };
  const update = {
    $set: {
      "booking.roomId": nextRoomId,
      "booking.roomName": nextRoomName,
      updatedAt: nowIso,
      "audit.version": 1,
      "audit.updatedAt": nowIso,
      "audit.lastEvent": event,
    },
    $push: {
      "audit.events": { $each: [event], $slice: -AUDIT_MAX_EVENTS },
    },
    $inc: { revision: 1 },
  };
  write.payload = [filter, update, { upsert: false }];
  write._vivaProjectionSyncWriteAck = {
    runId: ctx.runId,
    date: group.date,
    gameId: game.id,
    exerciseId: game.exerciseId,
    expectedRevision: game.revision,
    expectedNextRevision: game.revision + 1,
    previousRoomId: game.roomId,
    roomId: nextRoomId,
  };
  writes.push(write);
}

const driftCount = writes.length + (ctx.mode === "SHADOW"
  ? group.games.length - Object.values(skipped).reduce((sum, count) => sum + count, 0)
  : 0);
const currentState = global.get(RUN_STATE_KEY);
if (!isObj(currentState) || currentState.runId !== ctx.runId) {
  const output = safeBase();
  output.payload = {
    ok: false,
    source: "viva_game_projection_sync",
    code: "STALE_RUN_IGNORED",
    runId: ctx.runId,
    date: group.date,
    at: nowIso,
  };
  return [null, null, output];
}
currentState.pendingWrites += writes.length;
currentState.writeScheduled += writes.length;
currentState.updatedAt = nowIso;
global.set(RUN_STATE_KEY, currentState);
const completion = report(
  ctx.mode === "ENFORCE" ? "PROVIDER_DATE_RESOLVED" : "SHADOW_DATE_RESOLVED",
  {
  checkedCount: group.games.length,
  providerRowCount: providerRows.length,
  driftCount,
  writeCount: writes.length,
  skipped,
  },
  true,
)[2];
return [writes.length > 0 ? writes : null, null, completion];
