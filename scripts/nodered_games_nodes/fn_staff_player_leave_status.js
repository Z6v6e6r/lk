const operation = Array.isArray(msg.payload) && msg.payload[0] && typeof msg.payload[0] === "object"
  ? msg.payload[0]
  : null;
const ctx = msg._staffLeaveStatusCtx && typeof msg._staffLeaveStatusCtx === "object"
  ? msg._staffLeaveStatusCtx
  : null;
const respond = (statusCode, payload) => {
  msg.statusCode = statusCode;
  msg.headers = { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" };
  msg.payload = payload;
  delete msg._staffLeaveStatusCtx;
  return [msg, null];
};
if (!ctx) return respond(500, { ok: false, code: "CONTEXT_MISSING", message: "Status context missing" });
if (!operation || operation.gameId !== ctx.gameId || operation.operationId !== ctx.operationId
  || String(operation.mode || "").toUpperCase() !== "STAFF_TARGET") {
  return respond(404, { ok: false, code: "OPERATION_NOT_FOUND", message: "Operation not found" });
}
const state = String(operation.state || "STARTED").toUpperCase();
const attempts = Math.max(Number(operation.recoveryAttempts) || 0, Number(operation.localApplyAttempts) || 0);
let status = "IN_PROGRESS";
if (state === "DONE") status = "DONE";
else if (attempts >= 20) status = "ATTENTION_REQUIRED";
else if (["VIVA_CONFIRMED", "LK_APPLIED"].includes(state)) status = "FINALIZING";
const messages = {
  IN_PROGRESS: "Удаление игрока выполняется",
  FINALIZING: "Отмена подтверждена, освобождаем место",
  DONE: "Игрок удалён из игры",
  ATTENTION_REQUIRED: "Удаление требует проверки сотрудником",
};
const stages = {
  IN_PROGRESS: "CANCELLING",
  FINALIZING: "FINALIZING",
  DONE: "DONE",
  ATTENTION_REQUIRED: "ATTENTION_REQUIRED",
};
const isoOrNull = (value) => {
  const normalized = String(value || "").trim();
  return /^\d{4}-\d{2}-\d{2}T/.test(normalized) ? normalized : null;
};
const outcome = status === "DONE" && ["REMOVED", "REJOIN_PRESERVED"].includes(operation.outcome)
  ? operation.outcome
  : null;
return respond(200, {
  ok: true,
  operationId: operation.operationId,
  gameId: operation.gameId,
  playerId: operation.targetClientId || null,
  status,
  state: status,
  stage: stages[status],
  visitAction: operation.requestedRefundMethod === "SERVICE" ? "RETURN_VISIT" : "NO_RETURN",
  outcome,
  createdAt: isoOrNull(operation.createdAt),
  updatedAt: isoOrNull(operation.updatedAt || operation.lastSeenAt),
  doneAt: isoOrNull(operation.doneAt),
  message: messages[status],
  ...(status === "IN_PROGRESS" || status === "FINALIZING" ? { retryAfterMs: 2000 } : {}),
});
