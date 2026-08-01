const isObj = (value) => value && typeof value === "object" && !Array.isArray(value);
const asArray = (value) => (Array.isArray(value) ? value : []);

const toStr = (value) => {
  if (value === null || value === undefined) return null;
  const normalized = String(value).trim();
  return normalized || null;
};

const normalizeId = (value) => {
  const normalized = toStr(value);
  return normalized ? normalized.toLowerCase() : null;
};

const normalizePhone = (value) => {
  const digits = String(value || "").replace(/\D/g, "");
  if (!digits) return null;
  if (digits.length === 10) return `7${digits}`;
  if (digits.length === 11 && digits.startsWith("8")) return `7${digits.slice(1)}`;
  return digits;
};

const inactiveStatusMarkers = [
  "CANCEL",
  "DECLIN",
  "FAIL",
  "ERROR",
  "EXPIRE",
  "REFUND",
  "REJECT",
  "VOID",
  "CLOSE",
  "ARCHIVE",
  "LEFT",
  "REMOV",
];
const isInactiveStatus = (value) => {
  const status = String(value || "").trim().toUpperCase();
  return Boolean(status && inactiveStatusMarkers.some((marker) => status.includes(marker)));
};

const strongId = (member) => (isObj(member)
  ? normalizeId(member.clientId || member.playerId || member.userId || member.id || member.uuid)
  : null);

const memberMatchesActor = (member, actor) => {
  if (!isObj(member)) return false;
  const memberId = strongId(member);
  const memberPhone = normalizePhone(member.phoneNorm || member.phone || member.phoneNumber || member.mobile);
  if (actor.clientId && memberId) return actor.clientId === memberId;
  return Boolean(actor.phoneNorm && memberPhone && actor.phoneNorm === memberPhone);
};

const phoneIdentityAmbiguous = (members, actor) => {
  if (!actor.phoneNorm) return false;
  const linkedIds = members
    .filter((member) => normalizePhone(
      member.phoneNorm || member.phone || member.phoneNumber || member.mobile,
    ) === actor.phoneNorm)
    .map(strongId)
    .filter(Boolean);
  if (actor.clientId) return linkedIds.some((memberId) => memberId !== actor.clientId);
  return new Set(linkedIds).size > 1;
};

const gameHasActiveActor = (game, actor) => {
  if (!isObj(game) || game.archived === true || isInactiveStatus(game.status)) return false;

  const metadata = isObj(game.metadata) ? game.metadata : {};
  const participants = asArray(game.participants);
  const waitlist = asArray(game.waitlist);
  const splitPayment = isObj(metadata.splitPayment) ? metadata.splitPayment : {};
  const payments = asArray(splitPayment.payments);
  const activeMembers = [
    game.organizer,
    {
      id: metadata.organizerId,
      phoneNorm: metadata.organizerPhoneNorm || metadata.organizerPhone,
    },
    ...participants.filter((member) => isObj(member) && !isInactiveStatus(member.status)),
    ...waitlist.filter((member) => isObj(member) && !isInactiveStatus(member.status)),
    ...payments.filter((member) => isObj(member) && !isInactiveStatus(member.status)),
  ].filter(isObj);

  return !phoneIdentityAmbiguous(activeMembers, actor)
    && activeMembers.some((member) => memberMatchesActor(member, actor));
};

const context = isObj(msg._chatList) ? msg._chatList : null;
const actor = {
  phoneNorm: normalizePhone(context?.phone),
  clientId: normalizeId(context?.clientId),
};
if (!context || !context.verified || (!actor.phoneNorm && !actor.clientId)) {
  msg.statusCode = 401;
  msg.headers = { "Content-Type": "application/json; charset=utf-8", "Access-Control-Allow-Origin": "*", "Cache-Control": "no-store" };
  msg.payload = { error: "Verified chat actor is required", code: "CHAT_AUTH_REQUIRED" };
  return [null, msg, msg];
}

const activeGameIds = Array.from(new Set(
  asArray(msg.payload)
    .filter((game) => gameHasActiveActor(game, actor))
    .map((game) => toStr(game.id))
    .filter(Boolean),
));

msg._chatList.activeGameIds = activeGameIds;
msg.payload = {
  gameId: { $in: activeGameIds },
  deleted: { $ne: true },
};
return [msg, null, msg];
