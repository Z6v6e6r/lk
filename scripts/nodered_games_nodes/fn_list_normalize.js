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
const toStr = (v) => {
  if (v === null || v === undefined) return null;
  const s = String(v).trim();
  return s ? s : null;
};
const toNum = (v) => {
  if (v === null || v === undefined) return null;
  const n = Number(String(v).replace(",", "."));
  return Number.isFinite(n) ? n : null;
};

const phone = msg._lkPhone || null;
const includePast = Boolean(msg._lkIncludePast);
const limit = Number(msg._lkLimit);
const offset = Number.isFinite(Number(msg._lkOffset)) ? Math.max(0, Math.floor(Number(msg._lkOffset))) : 0;
const paymentRef = msg._lkPaymentRef || null;
const bookingIdsFilter = new Set(asArray(msg._lkBookingIds));
const publicMode = Boolean(msg._lkPublicMode);
const stationIdFilter = toStr(msg._lkStationId);
const stationNameFilter = toStr(msg._lkStationName);
const dateFilter = toStr(msg._lkDate);
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

const normalizeComparable = (value) => {
  const raw = toStr(value);
  if (!raw) return null;
  const normalized = raw
    .toLowerCase()
    .replace(/ё/g, "е")
    .replace(/[^a-zа-я0-9]+/gi, " ")
    .replace(/\s+/g, " ")
    .trim();
  return normalized || null;
};

const resolveMaxPlayers = (doc) => {
  const inviteLimit = toNum(doc?.invite?.maxPlayers);
  if (inviteLimit && inviteLimit > 0) return Math.floor(inviteLimit);
  const metaLimit = toNum(doc?.metadata?.maxPlayers || doc?.metadata?.playersLimit);
  if (metaLimit && metaLimit > 0) return Math.floor(metaLimit);
  const format = String(doc?.metadata?.gameFormat || doc?.metadata?.format || "").toLowerCase();
  if (format === "singles" || format.includes("1x1") || format.includes("1 на 1")) return 2;
  return 4;
};

const resolveWaitlistEnabled = (doc) => {
  if (typeof doc?.invite?.waitlistEnabled === "boolean") return doc.invite.waitlistEnabled;
  if (typeof doc?.metadata?.waitlistEnabled === "boolean") return doc.metadata.waitlistEnabled;
  return true;
};

const matchesStationFilter = (doc) => {
  if (stationIdFilter && toStr(doc?.booking?.studioId) !== stationIdFilter) return false;
  const stationName = normalizeComparable(stationNameFilter);
  if (!stationName) return true;
  const docStationName = normalizeComparable(doc?.booking?.studioName);
  return Boolean(docStationName && (docStationName.includes(stationName) || stationName.includes(docStationName)));
};

const matchesDateFilter = (doc) => {
  if (!dateFilter) return true;
  return toStr(doc?.booking?.date) === dateFilter;
};

rows.forEach((doc) => {
  if (!isObj(doc)) return;

  const status = String(doc.status || "").toUpperCase();
  if (status.includes("CANCEL")) return;
  if (publicMode && (status.includes("PAYMENT_PENDING") || status.includes("DRAFT"))) return;

  const endTs = Number(doc?.booking?.endTs);
  if (!includePast && Number.isFinite(endTs) && endTs < nowTs) return;

  if (publicMode) {
    if (doc?.settings?.isPrivate === true) return;
    if (doc?.payment?.paid === false) return;
    if (!matchesDateFilter(doc)) return;
    if (!matchesStationFilter(doc)) return;

    const maxPlayers = resolveMaxPlayers(doc);
    const participantCount = asArray(doc?.participants).length;
    if (participantCount >= maxPlayers && !resolveWaitlistEnabled(doc)) return;
  }

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
const safeLimit = Number.isFinite(limit) && limit > 0 ? Math.floor(limit) : null;
const slicedGames = safeLimit
  ? games.slice(offset, offset + safeLimit)
  : games;
const hasMore = safeLimit ? offset + slicedGames.length < total : false;

msg.statusCode = 200;
msg.headers = { "Content-Type": "application/json; charset=utf-8" };
msg.payload = {
  phone,
  paymentRef,
  bookingIds: Array.from(bookingIdsFilter.values()),
  public: publicMode,
  date: dateFilter,
  offset,
  limit: safeLimit,
  total,
  hasMore,
  games: slicedGames,
};

return [msg, msg];
