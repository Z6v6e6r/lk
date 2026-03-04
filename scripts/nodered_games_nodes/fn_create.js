const isObj = (v) => v && typeof v === "object" && !Array.isArray(v);
const asArray = (v) => Array.isArray(v) ? v : [];
const toStr = (v) => {
  if (v === null || v === undefined) return null;
  const s = String(v).trim();
  return s ? s : null;
};
const normPhone = (v) => {
  const s = String(v || "").replace(/\D/g, "");
  if (!s) return null;
  if (s.length === 10) return "7" + s;
  if (s.length === 11 && s.startsWith("8")) return "7" + s.slice(1);
  return s;
};
const uniq = (arr) => Array.from(new Set(arr.filter(Boolean)));

const body = isObj(msg.payload) ? msg.payload : {};
const nowIso = new Date().toISOString();

const booking = isObj(body.booking) ? body.booking : {};
const payment = isObj(body.payment) ? body.payment : {};
const settings = isObj(body.settings) ? body.settings : {};
const invite = isObj(body.invite) ? body.invite : {};
const metadata = isObj(body.metadata) ? body.metadata : {};
const organizer = isObj(body.organizer) ? body.organizer : {};

const normalizePlayer = (p, fallbackSource) => {
  if (!isObj(p)) return null;
  const phone = normPhone(p.phone || p.phoneNumber || p.mobile);
  return {
    id: toStr(p.id || p.clientId || p.userId || p.uuid),
    name: toStr(p.name || p.fullName || [p.firstName, p.lastName].filter(Boolean).join(" ")) || "Игрок",
    phone,
    photo: toStr(p.photo || p.avatar || p.imageUrl),
    rating: toStr(p.rating || p.level || p.grade),
    source: toStr(p.source || fallbackSource || "INVITED"),
    status: toStr(p.status || "CONFIRMED"),
  };
};

const participants = asArray(body.participants).map((p) => normalizePlayer(p, "INVITED")).filter(Boolean);
const waitlist = asArray(body.waitlist).map((p) => normalizePlayer(p, "WAITLIST")).filter(Boolean);

const organizerPhone = normPhone(organizer.phone || organizer.phoneNumber || body.clientPhone || body.phone);
const organizerNorm = {
  id: toStr(organizer.id || organizer.clientId || body.clientId),
  name: toStr(organizer.name || [organizer.firstName, organizer.lastName].filter(Boolean).join(" ")) || "Организатор",
  phone: organizerPhone,
  phoneNorm: organizerPhone,
  photo: toStr(organizer.photo || organizer.avatar || body.profilePhoto),
  rating: toStr(organizer.rating || organizer.level || body.profileGrade),
};

const studioId = toStr(booking.studioId || body.studioId);
const roomId = toStr(booking.roomId || body.roomId);
const date = toStr(booking.date || body.fromDate);
const timeFrom = toStr(booking.timeFrom || body.fromTime);
const timeTo = toStr(booking.timeTo || body.toTime);

const subServiceIds = uniq([
  ...asArray(booking.subServiceIds),
  ...asArray(body.subServiceIds),
].map((v) => toStr(v))).filter(Boolean).sort();

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
  booking.vivaExerciseId || booking.exerciseId || metadata.vivaExerciseId || metadata.exerciseId,
);

const slotKey = [studioId, roomId, date, timeFrom, timeTo, subServiceIds.join(",")].join("|");
const dedupeKey = vivaExerciseId ? `viva:${vivaExerciseId}` : `slot:${slotKey}`;

const fallbackId = dedupeKey.replace(/[^a-zA-Z0-9_-]/g, "_").slice(0, 120);
const gameId = toStr(body.id || body.gameId || body.recordId) || fallbackId || (`g_${Date.now()}`);

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

const record = {
  id: gameId,
  tenantKey: toStr(body.tenantKey) || null,
  source: toStr(body.source) || "padlhub_lk",
  dedupeKey,
  createdByFlow: true,
  status: toStr(body.status) || "PAID",
  organizer: organizerNorm,
  booking: {
    studioId,
    studioName: toStr(booking.studioName),
    masterServiceId: toStr(booking.masterServiceId),
    subServiceIds,
    roomId,
    roomName: toStr(booking.roomName),
    date,
    timeFrom,
    timeTo,
    timeFromIso: startIso,
    timeToIso: endIso,
    startTs,
    endTs,
    durationMinutes: Number.isFinite(Number(booking.durationMinutes)) ? Number(booking.durationMinutes) : null,
    slotId: toStr(booking.slotId),
    vivaExerciseId,
  },
  payment: {
    amount: Number.isFinite(Number(payment.amount)) ? Number(payment.amount) : null,
    paymentUrl: toStr(payment.paymentUrl || payment.paymentLink || payment.url),
    paymentMethod: toStr(payment.paymentMethod || "WIDGET"),
    baseRedirectUrl: toStr(payment.baseRedirectUrl),
    paid: typeof payment.paid === "boolean" ? payment.paid : true,
    paidAt: toStr(payment.paidAt) || nowIso,
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
  metadata,
  archived: Boolean(body.archived),
  updatedAt: nowIso,
};

const dbMsg = Object.assign({}, msg, {
  query: { dedupeKey },
  payload: {
    $set: record,
    $setOnInsert: {
      id: gameId,
      createdAt: nowIso,
    },
  },
});

const responseMsg = Object.assign({}, msg, {
  statusCode: 200,
  headers: { "Content-Type": "application/json; charset=utf-8" },
  payload: Object.assign({ createdAt: nowIso }, record),
});

return [dbMsg, responseMsg, responseMsg];
