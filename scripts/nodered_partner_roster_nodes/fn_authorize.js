const ctx = msg._partnerRosterPatch;
const fail = (statusCode, code, error) => {
  msg.statusCode = statusCode;
  msg.headers = { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store", "Access-Control-Allow-Origin": "*" };
  msg.payload = { code, error };
  delete msg._partnerRosterPatch;
  return [null, msg];
};
if (!ctx || msg.error) return fail(503, "GAME_ROSTER_READ_FAILED", "Не удалось проверить состав игры");
const rows = Array.isArray(msg.payload) ? msg.payload : [];
if (rows.length !== 1 || rows[0]?.id !== ctx.gameId || rows[0]._id == null) {
  return fail(rows.length === 0 ? 404 : 409, "GAME_ROSTER_BINDING_UNKNOWN", "Не удалось определить актуальную игру");
}
const game = rows[0];
if (Object.prototype.hasOwnProperty.call(game, "revision") && (!Number.isSafeInteger(game.revision) || game.revision < 0 || game.revision >= Number.MAX_SAFE_INTEGER)) {
  return fail(503, "GAME_PATCH_REVISION_INVALID", "Не удалось проверить версию игры");
}
const hasPartner = (Array.isArray(game.participants) ? game.participants : []).some((p) => p?.source === "PARTNER_API")
  || (Array.isArray(game.payments) ? game.payments : []).some((p) => p?.settlementSource === "EXTERNAL_PARTNER" && p?.status === "PAID" && p?.membershipId);
if (hasPartner) return fail(403, "GAME_PARTNER_ROSTER_COMMAND_REQUIRED", "Состав игры с участием партнёра изменяется только через защищённую команду записи");
const own = (key) => Object.prototype.hasOwnProperty.call(ctx.body, key);
if (!own("expectedUpdatedAt") && !own("expectedRevision")) {
  return fail(428, "GAME_PATCH_PRECONDITION_REQUIRED", "Обновите данные игры перед изменением состава");
}
if ((own("expectedUpdatedAt") && ctx.body.expectedUpdatedAt !== (game.updatedAt ?? null))
  || (own("expectedRevision") && ctx.body.expectedRevision !== (game.revision ?? 0))) {
  return fail(409, "GAME_PATCH_VERSION_CONFLICT", "Игра уже изменилась. Обновите данные");
}
ctx.preimage = {};
for (const key of ["_id", "id", "tenantKey", "participants", "waitlist", "payments", "updatedAt", "revision"]) {
  ctx.preimage[key] = { exists: Object.prototype.hasOwnProperty.call(game, key), value: game[key] };
}
msg.payload = ctx.body;
return [msg, null];
