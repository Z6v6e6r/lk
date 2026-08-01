const normPhone = (v) => {
  const s = String(v || "").replace(/\D/g, "");
  if (!s) return null;
  if (s.length === 10) return "7" + s;
  if (s.length === 11 && s.startsWith("8")) return "7" + s.slice(1);
  return s;
};
const normalizeId = (v) => {
  if (v === null || v === undefined) return null;
  const normalized = String(v).trim().toLowerCase();
  return normalized || null;
};

const actor = msg._chatActor && typeof msg._chatActor === "object" ? msg._chatActor : null;
const phone = actor?.verified === true ? normPhone(actor.phoneNorm) : null;
const clientId = actor?.verified === true ? normalizeId(actor.clientId) : null;
if (!actor || actor.verified !== true || (!phone && !clientId)) {
  msg.statusCode = 401;
  msg.headers = { "Content-Type": "application/json; charset=utf-8", "Access-Control-Allow-Origin": "*", "Cache-Control": "no-store" };
  msg.payload = { error: "Verified chat actor is required", code: "CHAT_AUTH_REQUIRED" };
  return [null, msg, msg];
}

const identityQueries = [];
if (phone) {
  identityQueries.push(
    { "organizer.phoneNorm": phone },
    { "organizer.phone": phone },
    { participantPhones: phone },
    { waitlistPhones: phone },
    { "participants.phone": phone },
    { "participants.phoneNorm": phone },
    { "waitlist.phone": phone },
    { "waitlist.phoneNorm": phone },
    { "metadata.splitPayment.payments.phoneNorm": phone },
    { "metadata.splitPayment.payments.phone": phone },
    { "metadata.splitPayment.payments.clientPhoneNorm": phone },
  );
}
if (clientId) {
  identityQueries.push(
    { "organizer.id": clientId },
    { "organizer.clientId": clientId },
    { "participants.id": clientId },
    { "participants.clientId": clientId },
    { "waitlist.id": clientId },
    { "waitlist.clientId": clientId },
    { "metadata.splitPayment.payments.clientId": clientId },
    { "metadata.splitPayment.payments.playerId": clientId },
  );
}

msg._chatList = { phone, clientId, verified: true };
msg.payload = {
  archived: { $ne: true },
  status: { $not: /CANCEL|ARCHIV/i },
  $or: identityQueries,
};
return [msg, null, msg];
