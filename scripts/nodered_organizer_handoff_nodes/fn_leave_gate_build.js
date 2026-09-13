const ctx = msg._splitLeaveCtx;
const game = Array.isArray(msg.payload) ? msg.payload.find(row => row?.id === ctx?.gameId) : null;
const fail = message => { msg.statusCode = 409; msg.payload = { ok: false, state: "CONFLICT", message }; return [null, msg]; };
const id = value => String(value || "").trim().toLowerCase();
if (msg.error || !game || !ctx?.operationKey) return fail("Не удалось проверить блокировку выхода");
const organizerIds = [game.organizer?.id, game.organizer?.clientId, game.metadata?.organizerId].map(id).filter(Boolean);
if (organizerIds.includes(id(ctx.targetClientId))) return fail("Организатор должен передать роль перед выходом");
if (game.membershipMutation && game.membershipMutation.operationKey !== ctx.operationKey) return fail("Другая операция изменяет состав. Повторите позже");
// Membership already applied: refund verification cannot remove the new organizer's place.
if (ctx.localAlreadyApplied === true) {
  msg.payload = msg._membershipGatePayload;
  return [null, null, msg];
}
if (game.archived || /CANCEL|ARCHIVE|REMOV/i.test(game.status || "")) return fail("Игра уже отменяется");
if (ctx.game?.updatedAt !== game.updatedAt) return fail("Поколение записи изменилось. Обновите игру и повторите выход");
msg._splitLeaveCtx = ctx;
const query = { id: ctx.gameId, updatedAt: game.updatedAt ?? { $exists: false }, organizer: game.organizer ?? null,
  $or: [{ membershipMutation: { $exists: false } }, { "membershipMutation.operationKey": ctx.operationKey }] };
msg.payload = [query, { $set: { membershipMutation: { operationKey: ctx.operationKey,
  kind: "LEAVE", targetId: ctx.targetClientId, startedAt: game.membershipMutation?.startedAt || new Date().toISOString() } } }, { upsert: false }];
return [msg, null, null];
