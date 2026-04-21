const asArray = (v) => (Array.isArray(v) ? v : []);
const toStr = (v) => {
  if (v === null || v === undefined) return null;
  const s = String(v).trim();
  return s ? s : null;
};
const toNum = (v) => {
  if (v === null || v === undefined || v === "") return null;
  const n = Number(String(v).replace(",", "."));
  return Number.isFinite(n) ? n : null;
};
const normPhone = (v) => {
  const s = String(v || "").replace(/\D/g, "");
  if (!s) return null;
  if (s.length === 10) return `7${s}`;
  if (s.length === 11 && s.startsWith("8")) return `7${s.slice(1)}`;
  return s;
};

const body = msg.payload && typeof msg.payload === "object" ? msg.payload : {};
const rawPlayers = asArray(body.players || body.items);
const players = rawPlayers
  .map((item) => {
    const p = item && typeof item === "object" ? item : {};
    return {
      clientId: toStr(p.clientId || p.id),
      phoneNorm: normPhone(p.phone || p.phoneNorm || p.phoneNumber),
      name: toStr(p.name),
      rating: toStr(p.rating || p.level || p.grade),
      ratingNumeric: toNum(p.ratingNumeric || p.numericRating || p.levelNumeric),
    };
  })
  .filter((p) => p.clientId || p.phoneNorm);

if (players.length === 0) {
  msg.statusCode = 400;
  msg.headers = { "Content-Type": "application/json; charset=utf-8" };
  msg.payload = { error: "players[] is required" };
  return [null, msg, msg];
}

msg._liveRatingsCtx = { players };
msg.payload = players;
return [msg, null, msg];
