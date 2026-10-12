const ctx = msg._partnerRosterPatch;
const result = msg.payload;
const success = ctx && !msg.error && result?.acknowledged === true && result?.matchedCount === 1;
const statusCode = success ? ctx.response.statusCode : result?.acknowledged === true && result?.matchedCount === 0 ? 409 : 503;
const payload = success ? ctx.response.payload : {
  code: statusCode === 409 ? "GAME_PATCH_VERSION_CONFLICT" : "GAME_PATCH_WRITE_UNACKNOWLEDGED",
  error: statusCode === 409 ? "Игра уже изменилась. Обновите данные" : "Хранилище не подтвердило изменение состава",
};
const response = { ...msg, statusCode, headers: { ...(ctx?.response?.headers || {}), "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store", "Access-Control-Allow-Origin": "*" }, payload };
delete response._partnerRosterPatch;
delete response.error;
const autojoin = success && ctx.autojoin ? {
  ...msg, statusCode: undefined, headers: undefined,
  payload: ctx.autojoin.payload, _gameAutojoinPatch: ctx.autojoin.patch,
} : null;
if (autojoin) { delete autojoin._partnerRosterPatch; delete autojoin.error; }
return [response, response, autojoin];
