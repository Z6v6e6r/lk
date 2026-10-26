// Diagnostic observer: optional, no-throw; sourceHash is the uninstrumented business preimage.
const lkDiagnostic = (fields = {}) => {
  try {
    if (typeof global === "undefined" || typeof global.get !== "function") return;
    const observer = global.get("lkDiagnostics");
    observer?.observe(msg, "roster_authorize", { sourceHash: "a453f06ef56661227277391248222e7f6e0979ea601f157fde0226b8bf87bc75", ...fields });
  } catch { /* Observability cannot alter business execution. */ }
};
lkDiagnostic({ code: "STAGE_ENTER" });
const ctx = msg._partnerRosterPatch;
const fail = (statusCode, code, error) => {
  lkDiagnostic({ code, httpStatus: statusCode, eventKind: "stage", outcome: "refused" });
  msg.statusCode = statusCode;
  msg.headers = { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store", "Access-Control-Allow-Origin": "*" };
  msg.payload = { code, error };
  delete msg._partnerRosterPatch;
  return [null, msg];
};
if (!ctx || msg.error) return fail(503, "GAME_ROSTER_READ_FAILED", "Не удалось проверить состав игры");
const rows = Array.isArray(msg.payload) ? msg.payload : [];
lkDiagnostic({ lookupCount: Math.min(rows.length, 2), bindingEqual: rows.length === 1 && rows[0]?.id === ctx.gameId, bindingPresent: rows.length === 1 && rows[0]?._id != null });
if (rows.length !== 1 || rows[0]?.id !== ctx.gameId || rows[0]._id == null) {
  return fail(rows.length === 0 ? 404 : 409, "GAME_ROSTER_BINDING_UNKNOWN", "Не удалось определить актуальную игру");
}
const game = rows[0];
lkDiagnostic({ lookupCount: Math.min(rows.length, 2), bindingPresent: game._id != null, bindingEqual: game.id === ctx.gameId,
  expectedRevisionPresent: Object.hasOwn(ctx.body, "expectedRevision"), actualRevisionPresent: Object.hasOwn(game, "revision"),
  expectedRevisionType: typeof ctx.body.expectedRevision, actualRevisionType: typeof game.revision,
  revisionEqual: ctx.body.expectedRevision === (game.revision ?? 0),
  expectedUpdatedAtPresent: Object.hasOwn(ctx.body, "expectedUpdatedAt"), actualUpdatedAtPresent: Object.hasOwn(game, "updatedAt"),
  expectedUpdatedAtType: typeof ctx.body.expectedUpdatedAt, actualUpdatedAtType: typeof game.updatedAt,
  updatedAtEqual: ctx.body.expectedUpdatedAt === (game.updatedAt ?? null) });
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
