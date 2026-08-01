const normPhone = (v) => {
  const s = String(v || "").replace(/\D/g, "");
  if (!s) return null;
  if (s.length === 10) return "7" + s;
  if (s.length === 11 && s.startsWith("8")) return "7" + s.slice(1);
  return s;
};
const isObj = (v) => v && typeof v === "object" && !Array.isArray(v);
const normalizeId = (v) => {
  if (v === null || v === undefined) return null;
  const id = String(v).trim().toLowerCase();
  return id || null;
};
const strongId = (value) => (isObj(value)
  ? normalizeId(value.clientId || value.playerId || value.userId || value.id)
  : null);
const inactiveStatusMarkers = [
  "CANCEL", "DECLIN", "FAIL", "ERROR", "EXPIRE", "REFUND", "REJECT", "VOID", "CLOSE", "ARCHIVE", "LEFT", "REMOV",
];
const isInactiveStatus = (value) => {
  const status = String(value || "").trim().toUpperCase();
  return Boolean(status && inactiveStatusMarkers.some((marker) => status.includes(marker)));
};
const activeMembers = (game) => {
  const metadata = isObj(game?.metadata) ? game.metadata : {};
  const splitPayment = isObj(metadata?.splitPayment) ? metadata.splitPayment : {};
  const splitPayments = Array.isArray(splitPayment?.payments) ? splitPayment.payments : [];
  const participants = Array.isArray(game?.participants) ? game.participants : [];
  const waitlist = Array.isArray(game?.waitlist) ? game.waitlist : [];
  return [
    game?.organizer,
    { id: metadata?.organizerId, phoneNorm: metadata?.organizerPhoneNorm || metadata?.organizerPhone },
    ...participants.filter((item) => isObj(item) && !isInactiveStatus(item.status)),
    ...waitlist.filter((item) => isObj(item) && !isInactiveStatus(item.status)),
    ...splitPayments.filter((item) => isObj(item) && !isInactiveStatus(item.status)),
  ].filter(isObj);
};
const memberMatches = (member, actor) => {
  const memberId = strongId(member);
  const memberPhone = normPhone(member?.phoneNorm || member?.phone || member?.mobile || member?.clientPhoneNorm || member?.clientPhone);
  if (actor.clientId && memberId) return actor.clientId === memberId;
  return Boolean(actor.phone && memberPhone && actor.phone === memberPhone);
};
const phoneIdentityAmbiguous = (members, actor) => {
  if (!actor.phone) return false;
  const linkedIds = members
    .filter((member) => normPhone(
      member?.phoneNorm || member?.phone || member?.mobile || member?.clientPhoneNorm || member?.clientPhone,
    ) === actor.phone)
    .map(strongId)
    .filter(Boolean);
  if (actor.clientId) return linkedIds.some((memberId) => memberId !== actor.clientId);
  return new Set(linkedIds).size > 1;
};
const rows = Array.isArray(msg.payload) ? msg.payload : [];
if (rows.length === 0) {
  msg.statusCode = 404;
  msg.headers = { "Content-Type": "application/json; charset=utf-8", "Access-Control-Allow-Origin": "*", "Cache-Control": "no-store" };
  msg.payload = { error: "Game not found" };
  return [null, msg, msg];
}
const game = rows[0] || {};
const ctx = msg._chatRead || {};
const actor = { clientId: normalizeId(ctx.clientId), phone: normPhone(ctx.phone) };
const members = activeMembers(game);
if (
  game.archived === true
  || isInactiveStatus(game.status)
  || phoneIdentityAmbiguous(members, actor)
  || !members.some((member) => memberMatches(member, actor))
) {
  msg.statusCode = 403;
  msg.headers = { "Content-Type": "application/json; charset=utf-8", "Access-Control-Allow-Origin": "*", "Cache-Control": "no-store" };
  msg.payload = { error: "Access denied for this game" };
  return [null, msg, msg];
}
const doc = { gameId: ctx.gameId, phoneNorm: ctx.phone, lastReadTs: ctx.lastReadTs, updatedAt: new Date().toISOString() };
msg._chatReadDoc = doc;
msg.payload = doc;
return [msg, null, msg];
