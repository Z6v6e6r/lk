// Diagnostic observer: optional, no-throw; sourceHash is the uninstrumented business preimage.
const lkDiagnostic = (fields = {}) => {
  try {
    if (typeof global === "undefined" || typeof global.get !== "function") return;
    const observer = global.get("lkDiagnostics");
    observer?.observe(msg, "roster_ack", { sourceHash: "1fe6d992b56fecd77dd8142f57b77eb8ace51d2f398edeee5b7d35c3aeceeb94", ...fields });
  } catch { /* Observability cannot alter business execution. */ }
};
lkDiagnostic({ code: "STAGE_ENTER" });
const ctx = msg._partnerRosterPatch;
const result = msg.payload;
lkDiagnostic({ eventKind: "operation_result", code: result?.acknowledged === true ? "DB_ACK" : "DB_UNACKNOWLEDGED",
  acknowledged: result?.acknowledged === true, matchedCount: result?.matchedCount, modifiedCount: result?.modifiedCount,
  errorPresent: Boolean(msg.error), outcome: !msg.error && result?.acknowledged === true && result?.matchedCount === 1 ? "acknowledged" : result?.acknowledged === true && result?.matchedCount === 0 ? "refused" : "outcome_unknown" });
const success = ctx && !msg.error && result?.acknowledged === true && result?.matchedCount === 1;
const statusCode = success ? ctx.response.statusCode : result?.acknowledged === true && result?.matchedCount === 0 ? 409 : 503;
const payload = success ? ctx.response.payload : {
  code: statusCode === 409 ? "GAME_PATCH_VERSION_CONFLICT" : "GAME_PATCH_WRITE_UNACKNOWLEDGED",
  error: statusCode === 409 ? "Игра уже изменилась. Обновите данные" : "Хранилище не подтвердило изменение состава",
};
lkDiagnostic({ code: payload.code || "DB_ACK", httpStatus: statusCode });
const response = { ...msg, statusCode, headers: { ...(ctx?.response?.headers || {}), "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store", "Access-Control-Allow-Origin": "*" }, payload };
delete response._partnerRosterPatch;
delete response.error;
const autojoin = success && ctx.autojoin ? {
  ...msg, statusCode: undefined, headers: undefined,
  payload: ctx.autojoin.payload, _gameAutojoinPatch: ctx.autojoin.patch,
} : null;
if (autojoin) { delete autojoin._partnerRosterPatch; delete autojoin.error; }
return [response, response, autojoin];
