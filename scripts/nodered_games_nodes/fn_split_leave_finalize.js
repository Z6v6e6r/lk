const isObj = (value) => value && typeof value === "object" && !Array.isArray(value);
const ctx = isObj(msg._splitLeaveCtx) ? msg._splitLeaveCtx : null;
const matched = Number(msg.payload?.matchedCount ?? msg.payload?.modifiedCount ?? 0);
const respond = (statusCode, state, message) => {
  msg.statusCode = statusCode;
  msg.headers = {
    "Content-Type": "application/json; charset=utf-8",
    "Access-Control-Allow-Origin": "*",
    "Cache-Control": "no-store",
  };
  msg.payload = {
    ok: true,
    state,
    operationId: ctx?.operationId || null,
    gameId: ctx?.gameId || null,
    ...(message ? { message } : {}),
  };
  delete msg._splitLeaveCtx;
  if (ctx?.backgroundRetry === true) return [null, msg];
  return [msg, msg];
};
if (!ctx || msg.error || matched < 1) {
  return respond(202, "RETRY_REQUIRED", "Локальная синхронизация ожидает повторения");
}

const exerciseId = String(ctx.exerciseId || "").trim();
if (exerciseId) {
  const epochKey = "lkTournamentParticipantEpochV1";
  const epochs = global.get(epochKey) || {};
  epochs[exerciseId] = Math.max(0, Number(epochs[exerciseId]) || 0) + 1;
  global.set(epochKey, epochs);
}
return respond(200, "DONE", ctx.refundMessage || ctx.successMessage || "Вы вышли из игры");
