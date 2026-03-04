const normPhone = (v) => {
  const s = String(v || "").replace(/\D/g, "");
  if (!s) return null;
  if (s.length === 10) return "7" + s;
  if (s.length === 11 && s.startsWith("8")) return "7" + s.slice(1);
  return s;
};
const uniq = (arr) => Array.from(new Set(arr.filter(Boolean)));

const rows = Array.isArray(msg.payload) ? msg.payload : [];
if (rows.length === 0) {
  msg.statusCode = 404;
  msg.headers = { "Content-Type": "application/json; charset=utf-8" };
  msg.payload = { error: "Game not found" };
  return [null, msg, msg];
}

const game = rows[0] || {};
const ctx = msg._chatRead || {};
const allPhones = uniq([
  normPhone(game?.organizer?.phoneNorm || game?.organizer?.phone),
  ...(Array.isArray(game?.allRelatedPhones) ? game.allRelatedPhones.map(normPhone) : []),
  ...(Array.isArray(game?.participantPhones) ? game.participantPhones.map(normPhone) : []),
  ...(Array.isArray(game?.waitlistPhones) ? game.waitlistPhones.map(normPhone) : []),
  ...(Array.isArray(game?.invitedPhones) ? game.invitedPhones.map(normPhone) : []),
]);

if (allPhones.length > 0 && !allPhones.includes(ctx.phone)) {
  msg.statusCode = 403;
  msg.headers = { "Content-Type": "application/json; charset=utf-8" };
  msg.payload = { error: "Access denied for this game" };
  return [null, msg, msg];
}

const nowIso = new Date().toISOString();
const doc = {
  gameId: ctx.gameId,
  phoneNorm: ctx.phone,
  lastReadTs: ctx.lastReadTs,
  updatedAt: nowIso,
};

msg._chatReadDoc = doc;
msg.payload = doc;
return [msg, null, msg];
