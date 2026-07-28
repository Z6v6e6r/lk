const TOKEN_URL = "https://kc.vivacrm.ru/realms/prod/protocol/openid-connect/token";

const toStr = (value) => {
  if (value === null || value === undefined) return null;
  const text = String(value).trim();
  return text ? text : null;
};

const asArray = (value) => (Array.isArray(value) ? value : []);

const uniq = (values) => {
  const result = [];
  const used = new Set();
  values.forEach((item) => {
    const normalized = toStr(item);
    if (!normalized || used.has(normalized)) return;
    used.add(normalized);
    result.push(normalized);
  });
  return result;
};

const normalizePhone = (value) => {
  const digits = String(value || "").replace(/\D/g, "");
  if (!digits) return null;
  if (digits.length === 10) return `7${digits}`;
  if (digits.length === 11 && digits.startsWith("8")) return `7${digits.slice(1)}`;
  return digits;
};

const normalizeBookingItem = (value, fallbackClientId) => {
  if (value && typeof value === "object" && !Array.isArray(value)) {
    const bookingId = toStr(value.bookingId || value.id || value.uuid);
    if (!bookingId) return null;
    return {
      bookingId,
      clientId: toStr(value.clientId || value.playerId || value.userId) || fallbackClientId || null,
    };
  }

  const bookingId = toStr(value);
  if (!bookingId) return null;
  return {
    bookingId,
    clientId: fallbackClientId || null,
  };
};

const uniqBookingItems = (values) => {
  const result = [];
  const byBookingId = new Map();
  values.forEach((item) => {
    if (!item?.bookingId) return;
    const existing = byBookingId.get(item.bookingId);
    if (existing) {
      if (!existing.clientId && item.clientId) existing.clientId = item.clientId;
      return;
    }
    const next = {
      bookingId: item.bookingId,
      clientId: item.clientId || null,
    };
    byBookingId.set(item.bookingId, next);
    result.push(next);
  });
  return result;
};

const fail = (status, error, details) => {
  msg.statusCode = status;
  msg.headers = { "Content-Type": "application/json; charset=utf-8" };
  msg.payload = { ok: false, error, details: details || null };
  return [null, msg, msg];
};

const body = msg.payload && typeof msg.payload === "object" ? msg.payload : {};
const gameId = toStr(msg.req?.params?.gameId || body.gameId);
const exerciseId = toStr(body.exerciseId);
const playerClientId = toStr(body.clientId || body.playerId || body.userId);
const bookingItems = uniqBookingItems([
  ...asArray(body.bookings).map((item) => normalizeBookingItem(item, playerClientId)),
  ...asArray(body.bookingItems).map((item) => normalizeBookingItem(item, playerClientId)),
  ...asArray(body.cancellations).map((item) => normalizeBookingItem(item, playerClientId)),
  ...asArray(body.bookingIds).map((item) => normalizeBookingItem(item, playerClientId)),
  normalizeBookingItem(body.bookingId, playerClientId),
].filter(Boolean));
const bookingIds = uniq(bookingItems.map((item) => item.bookingId));

if (!gameId) {
  return fail(400, "gameId is required");
}

if (bookingIds.length === 0) {
  return fail(400, "bookingIds are required");
}

msg._splitLeaveCtx = {
  gameId,
  bookingQueue: bookingItems.map((item) => ({ ...item })),
  initialBookingIds: [...bookingIds],
  bookingResults: [],
  exerciseId,
  clientId: playerClientId,
  playerId: toStr(body.playerId || body.clientId),
  playerPhone: normalizePhone(body.playerPhone || body.phone || body.clientPhone),
  playerName: toStr(body.playerName || body.name),
  reason: toStr(body.reason) || "PLAYER_LEFT",
  token: null,
  step: "token_request",
  trace: [],
};

msg.method = "POST";
msg.url = TOKEN_URL;
msg.headers = { "Content-Type": "application/x-www-form-urlencoded" };
msg.payload =
  "grant_type=password&client_id=React-auth-dev&username=it@citysport.pro&password=mhF-ma6-4Ju-QsJ";

return [msg, null, msg];
