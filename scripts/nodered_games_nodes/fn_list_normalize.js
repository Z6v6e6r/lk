const isObj = (v) => v && typeof v === "object" && !Array.isArray(v);
const normPhone = (v) => {
  const s = String(v || "").replace(/\D/g, "");
  if (!s) return null;
  if (s.length === 10) return `7${s}`;
  if (s.length === 11 && s.startsWith("8")) return `7${s.slice(1)}`;
  return s;
};
const uniq = (arr) => Array.from(new Set(arr.filter(Boolean)));
const asArray = (v) => (Array.isArray(v) ? v : []);

const phone = msg._lkPhone || null;
const includePast = Boolean(msg._lkIncludePast);
const limit = Number(msg._lkLimit);
const paymentRef = msg._lkPaymentRef || null;
const bookingIdsFilter = new Set(asArray(msg._lkBookingIds));
const nowTs = Date.now();

const rows = Array.isArray(msg.payload) ? msg.payload : [];
const byKey = new Map();

const getTs = (doc) => {
  const endTs = Number(doc?.booking?.endTs);
  const startTs = Number(doc?.booking?.startTs);
  return Number.isFinite(startTs)
    ? startTs
    : (Number.isFinite(endTs) ? endTs : Number.MAX_SAFE_INTEGER);
};

const getUpdateTs = (doc) => {
  const ts = Date.parse(doc?.updatedAt || doc?.createdAt || "");
  return Number.isFinite(ts) ? ts : 0;
};

const collectPhones = (doc) => {
  const organizerPhone = normPhone(doc?.organizer?.phoneNorm || doc?.organizer?.phone);
  const pPhones = asArray(doc?.participants).map((p) => normPhone(p?.phone));
  const wPhones = asArray(doc?.waitlist).map((p) => normPhone(p?.phone));
  return uniq([
    organizerPhone,
    ...asArray(doc?.allRelatedPhones).map((p) => normPhone(p)),
    ...asArray(doc?.participantPhones).map((p) => normPhone(p)),
    ...asArray(doc?.waitlistPhones).map((p) => normPhone(p)),
    ...asArray(doc?.invitedPhones).map((p) => normPhone(p)),
    ...pPhones,
    ...wPhones,
  ]);
};

const collectBookingIds = (doc) => {
  return uniq([
    ...asArray(doc?.booking?.bookingIds),
    ...asArray(doc?.metadata?.bookingIds),
    ...asArray(doc?.payment?.bookingIds),
  ]);
};

rows.forEach((doc) => {
  if (!isObj(doc)) return;

  const status = String(doc.status || "").toUpperCase();
  if (status.includes("CANCEL")) return;

  const endTs = Number(doc?.booking?.endTs);
  if (!includePast && Number.isFinite(endTs) && endTs < nowTs) return;

  if (phone) {
    const phones = collectPhones(doc);
    if (phones.length > 0 && !phones.includes(phone)) return;
  }

  if (paymentRef) {
    const docPaymentRef =
      String(doc?.metadata?.paymentRef || doc?.payment?.paymentRef || "").trim() || null;
    if (docPaymentRef !== paymentRef) return;
  }

  if (bookingIdsFilter.size > 0) {
    const recordBookingIds = collectBookingIds(doc);
    const hasIntersect = recordBookingIds.some((id) => bookingIdsFilter.has(id));
    if (!hasIntersect) return;
  }

  const docPaymentRef =
    String(doc?.metadata?.paymentRef || doc?.payment?.paymentRef || "").trim() || null;
  const vivaId =
    doc?.booking?.vivaExerciseId
    || doc?.metadata?.vivaExerciseId
    || doc?.metadata?.exerciseId
    || null;
  const slotFallback = [
    doc?.booking?.studioId || "",
    doc?.booking?.roomId || "",
    doc?.booking?.date || "",
    doc?.booking?.timeFrom || "",
    doc?.booking?.timeTo || "",
    asArray(doc?.booking?.subServiceIds).join(","),
  ].join("|");

  const dedupeKey =
    (docPaymentRef ? `paymentRef:${docPaymentRef}` : null)
    || (vivaId ? `viva:${vivaId}` : null)
    || doc.dedupeKey
    || `slot:${slotFallback}`;

  const prev = byKey.get(dedupeKey);
  if (!prev || getUpdateTs(doc) >= getUpdateTs(prev)) {
    byKey.set(dedupeKey, doc);
  }
});

const games = Array.from(byKey.values()).sort((a, b) => getTs(a) - getTs(b));
const total = games.length;
const slicedGames = Number.isFinite(limit) && limit > 0
  ? games.slice(0, limit)
  : games;

msg.statusCode = 200;
msg.headers = { "Content-Type": "application/json; charset=utf-8" };
msg.payload = {
  phone,
  paymentRef,
  bookingIds: Array.from(bookingIdsFilter.values()),
  total,
  games: slicedGames,
};

return [msg, msg];
