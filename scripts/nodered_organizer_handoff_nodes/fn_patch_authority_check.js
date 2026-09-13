const body = msg._organizerGuardBody;
const game = Array.isArray(msg.payload) ? msg.payload[0] : null;
const fail = () => { msg.statusCode = 409; msg.payload = { code: "ORGANIZER_COMMAND_REQUIRED", error: "Обновите игру. Роль организатора изменяется только через передачу роли." }; return [null, msg]; };
if (msg.error || !game || !body || typeof body !== "object") return fail();
const identity = row => String(row?.id || row?.clientId || "").trim().toLowerCase();
const phone = value => { const digits = String(value || "").replace(/\D/g, ""); return digits.length === 10 ? `7${digits}` : digits.length === 11 && digits[0] === "8" ? `7${digits.slice(1)}` : digits; };
if (game.membershipMutation) return fail();
if (body.organizer && (identity(body.organizer) !== identity(game.organizer)
  || phone(body.organizer.phoneNorm || body.organizer.phone) !== phone(game.organizer?.phoneNorm || game.organizer?.phone))) return fail();
const authority = ["organizerId", "organizerPhone", "organizerPhoneNorm"];
if (Object.prototype.hasOwnProperty.call(body, "metadata")) {
  if (!body.metadata || typeof body.metadata !== "object" || Array.isArray(body.metadata)) return fail();
  for (const key of authority) {
    if (body.metadata[key] != null && String(body.metadata[key]) !== String(game.metadata?.[key] ?? "")) return fail();
    if (game.metadata?.[key] !== undefined) body.metadata[key] = game.metadata[key];
    else delete body.metadata[key];
  }
}
if (body.resultRosterSnapshot) body.resultRosterSnapshot.organizer = game.organizer;
msg._organizerGuardSnapshot = { updatedAt: game.updatedAt, organizer: game.organizer };
msg.payload = body;
delete msg._organizerGuardBody;
return [msg, null];
