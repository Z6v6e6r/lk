const isObj = (v) => v && typeof v === "object" && !Array.isArray(v);
const asArray = (v) => (Array.isArray(v) ? v : []);
const toStr = (v) => {
  if (v === null || v === undefined) return null;
  const s = String(v).trim();
  return s ? s : null;
};
const normPhone = (v) => {
  const s = String(v || "").replace(/\D/g, "");
  if (!s) return null;
  if (s.length === 10) return `7${s}`;
  if (s.length === 11 && s.startsWith("8")) return `7${s.slice(1)}`;
  return s;
};
const uniq = (arr) => Array.from(new Set(arr.filter(Boolean)));
const toNum = (v) => {
  if (v === null || v === undefined) return null;
  const n = Number(String(v).replace(",", "."));
  return Number.isFinite(n) ? n : null;
};

const parseBookingIds = (value) => {
  if (Array.isArray(value)) {
    return value
      .map((item) => toStr(item))
      .filter(Boolean);
  }
  if (typeof value === "string") {
    return value
      .split(",")
      .map((item) => item.trim())
      .filter(Boolean);
  }
  return [];
};

const reqPathRaw =
  toStr(msg.req?.path)
  || toStr(msg.req?.originalUrl)
  || toStr(msg.req?.url)
  || "";
const reqPath = reqPathRaw.toLowerCase();

const body = isObj(msg.payload) ? msg.payload : {};
const query = isObj(msg.req?.query) ? msg.req.query : {};
const nowIso = new Date().toISOString();

const explicitAction = toStr(body.action || body._action || msg._action || msg.action);
let mode = "create";
if (reqPath.includes("/payment/confirm")) mode = "confirm";
if (reqPath.includes("/draft")) mode = "draft";
if (explicitAction) {
  const normalized = explicitAction.toLowerCase();
  if (["create", "draft", "confirm"].includes(normalized)) {
    mode = normalized;
  }
}

const booking = isObj(body.booking) ? body.booking : {};
const payment = isObj(body.payment) ? body.payment : {};
const settings = isObj(body.settings) ? body.settings : {};
const invite = isObj(body.invite) ? body.invite : {};
const metadataInput = isObj(body.metadata) ? body.metadata : {};
const organizer = isObj(body.organizer) ? body.organizer : {};

const metadataPaymentRef = toStr(metadataInput.paymentRef);
const paymentRef =
  toStr(body.paymentRef)
  || metadataPaymentRef
  || toStr(payment.paymentRef)
  || toStr(query.paymentRef)
  || toStr(query.phPaymentRef);

if ((mode === "draft" || mode === "confirm") && !paymentRef) {
  const errMsg = Object.assign({}, msg, {
    statusCode: 400,
    headers: { "Content-Type": "application/json; charset=utf-8" },
    payload: { error: "paymentRef is required" },
  });
  return [null, errMsg, errMsg];
}

const normalizePlayer = (p, fallbackSource) => {
  if (!isObj(p)) return null;
  const phone = normPhone(p.phone || p.phoneNumber || p.mobile || p.phoneNorm);
  return {
    id: toStr(p.id || p.clientId || p.userId || p.uuid),
    name:
      toStr(p.name || p.fullName || [p.firstName, p.lastName].filter(Boolean).join(" "))
      || "Игрок",
    phone,
    photo: toStr(p.photo || p.avatar || p.imageUrl),
    rating: toStr(p.rating || p.level || p.grade),
    ratingNumeric: toNum(p.ratingNumeric || p.numericRating || p.levelNumeric),
    source: toStr(p.source || fallbackSource || "INVITED"),
    status: toStr(p.status || "CONFIRMED"),
  };
};

const participants = asArray(body.participants)
  .map((p) => normalizePlayer(p, "INVITED"))
  .filter(Boolean);
const waitlist = asArray(body.waitlist)
  .map((p) => normalizePlayer(p, "WAITLIST"))
  .filter(Boolean);

const organizerPhone = normPhone(
  organizer.phone || organizer.phoneNumber || organizer.mobile || organizer.phoneNorm || body.clientPhone || body.phone,
);
const organizerNorm = {
  id: toStr(organizer.id || organizer.clientId || body.clientId),
  name:
    toStr(organizer.name || [organizer.firstName, organizer.lastName].filter(Boolean).join(" "))
    || "Организатор",
  phone: organizerPhone,
  phoneNorm: organizerPhone,
  photo: toStr(organizer.photo || organizer.avatar || body.profilePhoto),
  rating: toStr(organizer.rating || organizer.level || body.profileGrade),
  ratingNumeric: toNum(organizer.ratingNumeric || organizer.numericRating || body.profileRatingNumeric),
};

const studioId = toStr(booking.studioId || body.studioId);
const roomId = toStr(booking.roomId || body.roomId);
const date = toStr(booking.date || body.fromDate);
const timeFrom = toStr(booking.timeFrom || body.fromTime);
const timeTo = toStr(booking.timeTo || body.toTime);

const subServiceIds = uniq(
  [
    ...asArray(booking.subServiceIds),
    ...asArray(body.subServiceIds),
  ]
    .map((v) => toStr(v))
    .filter(Boolean),
).sort();

const bookingIds = uniq([
  ...parseBookingIds(body.bookingIds),
  ...parseBookingIds(metadataInput.bookingIds),
  ...parseBookingIds(payment.bookingIds),
  ...parseBookingIds(booking.bookingIds),
  ...parseBookingIds(query.bookingIds),
]);

const toIso = (baseDate, baseTime, explicitIso) => {
  const iso = toStr(explicitIso);
  if (iso) return iso;
  if (!baseDate || !baseTime) return null;
  const normalizedTime = /^\d{2}:\d{2}$/.test(baseTime) ? `${baseTime}:00` : baseTime;
  return `${baseDate}T${normalizedTime}+03:00`;
};

const startIso = toIso(date, timeFrom, booking.timeFromIso || body.timeFromIso);
const endIso = toIso(date, timeTo, booking.timeToIso || body.timeToIso);

const startTs = startIso ? Date.parse(startIso) : null;
const endTs = endIso ? Date.parse(endIso) : null;

const vivaExerciseId = toStr(
  booking.vivaExerciseId || booking.exerciseId || metadataInput.vivaExerciseId || metadataInput.exerciseId,
);

const slotKey = [studioId, roomId, date, timeFrom, timeTo, subServiceIds.join(",")].join("|");
const dedupeKey = vivaExerciseId ? `viva:${vivaExerciseId}` : `slot:${slotKey}`;

const fallbackIdBase = paymentRef ? `pay:${paymentRef}` : dedupeKey;
const fallbackId = fallbackIdBase.replace(/[^a-zA-Z0-9_-]/g, "_").slice(0, 120);
const gameId = toStr(body.id || body.gameId || body.recordId) || fallbackId || `g_${Date.now()}`;

const invitedPhonesFromPayload = uniq([
  ...asArray(body.invitedPhones).map((v) => normPhone(v)),
  ...asArray(body.invites).map((it) => normPhone(isObj(it) ? (it.phone || it.phoneNumber) : it)),
]);

const participantPhones = uniq(participants.map((p) => normPhone(p.phone)));
const waitlistPhones = uniq(waitlist.map((p) => normPhone(p.phone)));
const allRelatedPhones = uniq([
  organizerPhone,
  ...participantPhones,
  ...waitlistPhones,
  ...invitedPhonesFromPayload,
]);

const incomingPaid = typeof payment.paid === "boolean" ? payment.paid : null;
const resolvedPaid =
  mode === "draft"
    ? (incomingPaid === null ? false : incomingPaid)
    : mode === "confirm"
      ? true
      : (incomingPaid === null ? true : incomingPaid);

const incomingStatus = toStr(body.status);
const resolvedStatus =
  incomingStatus
  || (mode === "draft"
    ? "PAYMENT_PENDING"
    : resolvedPaid
      ? "PAID"
      : "PAYMENT_PENDING");

const mergedMetadata = Object.assign({}, metadataInput, {
  paymentRef: paymentRef || metadataPaymentRef || null,
  bookingIds,
  sourceMode: mode,
});

const record = {
  id: gameId,
  tenantKey: toStr(body.tenantKey) || null,
  source: toStr(body.source) || "padlhub_lk",
  dedupeKey,
  createdByFlow: true,
  status: resolvedStatus,
  organizer: organizerNorm,
  booking: {
    studioId,
    studioName: toStr(booking.studioName),
    masterServiceId: toStr(booking.masterServiceId),
    subServiceIds,
    roomId,
    roomName: toStr(booking.roomName),
    bookingIds,
    date,
    timeFrom,
    timeTo,
    timeFromIso: startIso,
    timeToIso: endIso,
    startTs,
    endTs,
    durationMinutes: Number.isFinite(Number(booking.durationMinutes))
      ? Number(booking.durationMinutes)
      : null,
    slotId: toStr(booking.slotId),
    vivaExerciseId,
  },
  payment: {
    amount: Number.isFinite(Number(payment.amount)) ? Number(payment.amount) : null,
    paymentUrl: toStr(payment.paymentUrl || payment.paymentLink || payment.url),
    paymentMethod: toStr(payment.paymentMethod || "WIDGET"),
    baseRedirectUrl: toStr(payment.baseRedirectUrl),
    paymentRef: paymentRef || null,
    bookingIds,
    paid: resolvedPaid,
    paidAt: resolvedPaid ? (toStr(payment.paidAt) || nowIso) : null,
  },
  settings: {
    ratingGame: typeof settings.ratingGame === "boolean" ? settings.ratingGame : null,
    minRating: toStr(settings.minRating),
    maxRating: toStr(settings.maxRating),
    isPrivate: typeof settings.isPrivate === "boolean" ? settings.isPrivate : null,
    payMode: toStr(settings.payMode),
  },
  invite: {
    inviteUrl: toStr((isObj(body.invite) ? body.invite.inviteUrl : null) || body.inviteUrl),
    waitlistEnabled: typeof invite.waitlistEnabled === "boolean" ? invite.waitlistEnabled : true,
    maxPlayers: Number.isFinite(Number(invite.maxPlayers)) ? Number(invite.maxPlayers) : 4,
  },
  participants,
  waitlist,
  participantPhones,
  waitlistPhones,
  invitedPhones: invitedPhonesFromPayload,
  allRelatedPhones,
  chatUrl: toStr(body.chatUrl),
  metadata: mergedMetadata,
  archived: Boolean(body.archived),
  updatedAt: nowIso,
};

const queryFilter = paymentRef
  ? {
      $or: [
        { "metadata.paymentRef": paymentRef },
        { "payment.paymentRef": paymentRef },
      ],
    }
  : { dedupeKey };

const dbMsg = Object.assign({}, msg, {
  query: queryFilter,
  payload: {
    $set: record,
    $setOnInsert: {
      createdAt: nowIso,
    },
  },
  _recordForResponse: Object.assign({ createdAt: nowIso }, record),
  _httpStatus: 200,
  _requestUrl: reqPathRaw,
  _requestMode: mode,
});

const responseMsg = Object.assign({}, msg, {
  statusCode: dbMsg._httpStatus || 200,
  headers: { "Content-Type": "application/json; charset=utf-8" },
  payload: dbMsg._recordForResponse || Object.assign({ createdAt: nowIso }, record),
});

const debugMsg = Object.assign({}, dbMsg, {
  payload: {
    mode,
    paymentRef: paymentRef || null,
    dedupeKey,
    queryFilter,
    gameId,
  },
});

const autojoinMsg = Object.assign({}, msg, {
  _requestMode: mode,
  _gameAutojoinSource: "games_create",
  payload: dbMsg._recordForResponse || Object.assign({ createdAt: nowIso }, record),
});

return [dbMsg, responseMsg, debugMsg, autojoinMsg];
