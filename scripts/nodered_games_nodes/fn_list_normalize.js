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
  if (!status) return false;
  return inactiveStatusMarkers.some((marker) => status.includes(marker));
};

const phone = msg._lkPhone || null;
const includePast = Boolean(msg._lkIncludePast);
const needsResult = Boolean(msg._lkNeedsResult);
const windowHours = Number.isFinite(Number(msg._lkWindowHours))
  ? Math.max(1, Math.min(168, Math.floor(Number(msg._lkWindowHours))))
  : null;
const limit = Number(msg._lkLimit);
const offset = Number.isFinite(Number(msg._lkOffset)) ? Math.max(0, Math.floor(Number(msg._lkOffset))) : 0;
const paymentRef = msg._lkPaymentRef || null;
const bookingIdsFilter = new Set(asArray(msg._lkBookingIds));
const clientId = toStr(msg._lkClientId);
const publicMode = Boolean(msg._lkPublicMode);
const stationIdFilter = toStr(msg._lkStationId);
const stationNameFilter = toStr(msg._lkStationName);
const dateFilter = toStr(msg._lkDate);
const nowTs = Date.now();
const windowStartTs = windowHours ? nowTs - (windowHours * 60 * 60 * 1000) : null;

const rows = Array.isArray(msg.payload) ? msg.payload : [];
const byKey = new Map();

const stripHeavyPhotoPayload = (photo) => {
  if (!isObj(photo)) return photo;
  const next = { ...photo };
  if (Object.prototype.hasOwnProperty.call(next, "dataUrl")) delete next.dataUrl;
  if (Object.prototype.hasOwnProperty.call(next, "base64")) delete next.base64;
  if (Object.prototype.hasOwnProperty.call(next, "blob")) delete next.blob;
  if (Object.prototype.hasOwnProperty.call(next, "binary")) delete next.binary;
  if (Object.prototype.hasOwnProperty.call(next, "fileData")) delete next.fileData;
  return next;
};

const sanitizeListDoc = (doc) => {
  if (!isObj(doc)) return doc;
  const metadata = isObj(doc.metadata) ? doc.metadata : null;
  if (!metadata) return doc;
  const matchResult = isObj(metadata.matchResult) ? metadata.matchResult : null;
  if (!matchResult || !Array.isArray(matchResult.photos)) return doc;

  const sanitizedPhotos = matchResult.photos.map((photo) => stripHeavyPhotoPayload(photo));
  return {
    ...doc,
    metadata: {
      ...metadata,
      matchResult: {
        ...matchResult,
        photos: sanitizedPhotos,
      },
    },
  };
};

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
  const metadataOrganizerPhone = normPhone(doc?.metadata?.organizerPhoneNorm || doc?.metadata?.organizerPhone);
  const pPhones = asArray(doc?.participants)
    .filter((p) => !isInactiveStatus(p?.status))
    .map((p) => normPhone(p?.phone));
  const wPhones = asArray(doc?.waitlist)
    .filter((p) => !isInactiveStatus(p?.status))
    .map((p) => normPhone(p?.phone));
  const splitPayment = isObj(doc?.metadata?.splitPayment) ? doc.metadata.splitPayment : null;
  const splitPaymentPhones = asArray(splitPayment?.payments).flatMap((item) => {
    if (!isObj(item)) return [];
    if (isInactiveStatus(item.status)) return [];
    return [
      normPhone(item.clientPhoneNorm),
      normPhone(item.phoneNorm),
      normPhone(item.clientPhone),
      normPhone(item.phone),
    ];
  });
  return uniq([
    organizerPhone,
    metadataOrganizerPhone,
    ...asArray(doc?.invitedPhones).map((p) => normPhone(p)),
    ...pPhones,
    ...wPhones,
    ...splitPaymentPhones,
  ]);
};

const collectBookingIds = (doc) => {
  const splitPayment = isObj(doc?.metadata?.splitPayment) ? doc.metadata.splitPayment : null;
  const splitPaymentBookingIds = asArray(splitPayment?.payments).flatMap((item) => {
    if (!isObj(item)) return [];
    return [
      ...asArray(item.bookingIds),
      toStr(item.bookingId),
      ...asArray(item.booking_ids),
      toStr(item.booking_id),
    ];
  });
  return uniq([
    ...asArray(doc?.booking?.bookingIds),
    toStr(doc?.booking?.bookingId),
    ...asArray(doc?.metadata?.bookingIds),
    toStr(doc?.metadata?.bookingId),
    ...asArray(splitPayment?.bookingIds),
    toStr(splitPayment?.bookingId),
    ...asArray(splitPayment?.booking_ids),
    toStr(splitPayment?.booking_id),
    toStr(splitPayment?.organizerBookingId),
    ...asArray(doc?.payment?.bookingIds),
    toStr(doc?.payment?.bookingId),
    ...splitPaymentBookingIds,
  ]);
};

const collectClientIds = (doc) => {
  const splitPayment = isObj(doc?.metadata?.splitPayment) ? doc.metadata.splitPayment : null;
  const splitPaymentClientIds = asArray(splitPayment?.payments).flatMap((item) => {
    if (!isObj(item)) return [];
    if (isInactiveStatus(item.status)) return [];
    return [
      toStr(item.clientId),
      toStr(item.playerId),
      toStr(item.userId),
      toStr(item.id),
    ];
  });
  return uniq([
    toStr(doc?.organizer?.id),
    toStr(doc?.metadata?.organizerId),
    ...asArray(doc?.participants).filter((item) => !isInactiveStatus(item?.status)).map((item) => toStr(item?.id)),
    ...asArray(doc?.waitlist).filter((item) => !isInactiveStatus(item?.status)).map((item) => toStr(item?.id)),
    ...splitPaymentClientIds,
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

const isSinglesFormat = (value) => {
  const normalized = String(value || "").trim().toLowerCase();
  return (
    normalized === "singles"
    || normalized.includes("1x1")
    || normalized.includes("1х1")
    || normalized.includes("1 на 1")
  );
};

const isSinglesCourtName = (value) => /сингл|single|1\s*[xх]\s*1|1\s*на\s*1/i.test(String(value || ""));

const isSinglesGame = (doc) => {
  if (!isObj(doc)) return false;
  const metadata = isObj(doc.metadata) ? doc.metadata : null;
  if (isSinglesFormat(metadata?.gameFormat || metadata?.format)) return true;
  const splitPayment = isObj(metadata?.splitPayment) ? metadata.splitPayment : null;
  const splitShareCount = Math.floor(toNum(splitPayment?.shareCount) || 0);
  if (splitShareCount === 2) return true;
  return [
    doc?.booking?.roomName,
    metadata?.roomName,
    metadata?.courtName,
    metadata?.courtTitle,
  ].some((value) => isSinglesCourtName(value));
};

const resolveMaxPlayers = (doc) => {
  if (isSinglesGame(doc)) return 2;
  const inviteLimit = toNum(doc?.invite?.maxPlayers);
  if (inviteLimit && inviteLimit > 0) return Math.floor(inviteLimit);
  const metaLimit = toNum(doc?.metadata?.maxPlayers || doc?.metadata?.playersLimit);
  if (metaLimit && metaLimit > 0) return Math.floor(metaLimit);
  if (isSinglesFormat(doc?.metadata?.gameFormat || doc?.metadata?.format)) return 2;
  return 4;
};

const resolveWaitlistEnabled = (doc) => {
  if (typeof doc?.invite?.waitlistEnabled === "boolean") return doc.invite.waitlistEnabled;
  if (typeof doc?.metadata?.waitlistEnabled === "boolean") return doc.metadata.waitlistEnabled;
  return true;
};

const normalizeName = (value) => String(value || "")
  .trim()
  .toLowerCase()
  .replace(/ё/g, "е")
  .replace(/\s+/g, " ");

const isPlaceholderName = (value) => {
  const normalized = normalizeName(value);
  return normalized === "игрок" || normalized === "организатор";
};

const hasMeaningfulPlayerIdentity = (player) => {
  if (!isObj(player) || isInactiveStatus(player.status)) return false;
  if (toStr(player.id)) return true;
  if (normPhone(player.phoneNorm || player.phone)) return true;
  const name = toStr(player.name || player.firstName || null);
  return Boolean(name && !isPlaceholderName(name));
};

const countActiveParticipants = (doc) => (
  asArray(doc?.participants).filter((player) => hasMeaningfulPlayerIdentity(player)).length
);

const hasMeaningfulOrganizerIdentity = (doc) => {
  const organizer = isObj(doc?.organizer) ? doc.organizer : null;
  if (!organizer) return false;
  if (toStr(organizer.id)) return true;
  if (normPhone(organizer.phoneNorm || organizer.phone)) return true;
  const fullName = [toStr(organizer.name), toStr(organizer.firstName), toStr(organizer.lastName)]
    .filter(Boolean)
    .join(" ")
    .trim();
  return Boolean(fullName && !isPlaceholderName(fullName));
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

const hasConfirmedResult = (doc) => {
  const matchResult = isObj(doc?.metadata?.matchResult) ? doc.metadata.matchResult : null;
  if (!matchResult) return false;
  const status = String(matchResult.status || "").trim().toUpperCase();
  if (status.includes("CONFIRM") || status.includes("COMPLET")) return true;
  if (matchResult.confirmedAt) return true;
  return false;
};

const isInsideResultWindow = (doc) => {
  if (windowStartTs === null) return true;
  const endTs = Number(doc?.booking?.endTs);
  if (Number.isFinite(endTs)) {
    return endTs <= nowTs && endTs >= windowStartTs;
  }
  const startTs = Number(doc?.booking?.startTs);
  if (Number.isFinite(startTs)) {
    return startTs <= nowTs && startTs >= windowStartTs;
  }
  return false;
};

rows.forEach((doc) => {
  if (!isObj(doc)) return;

  const status = String(doc.status || "").toUpperCase();
  if (status.includes("CANCEL")) return;
  if (publicMode && (status.includes("PAYMENT_PENDING") || status.includes("DRAFT"))) return;

  const endTs = Number(doc?.booking?.endTs);
  if (!includePast && Number.isFinite(endTs) && endTs < nowTs) return;

  if (needsResult) {
    if (hasConfirmedResult(doc)) return;
    if (!isInsideResultWindow(doc)) return;
  }

  if (publicMode) {
    if (doc?.settings?.isPrivate === true) return;
    if (doc?.payment?.paid === false) return;
    if (!matchesDateFilter(doc)) return;
    if (!matchesStationFilter(doc)) return;

    const maxPlayers = resolveMaxPlayers(doc);
    const participantCount = countActiveParticipants(doc);
    if (participantCount === 0 && !hasMeaningfulOrganizerIdentity(doc)) return;
    if (participantCount >= maxPlayers && !resolveWaitlistEnabled(doc)) return;
  }

  const hasPhoneMatch = phone ? collectPhones(doc).includes(phone) : false;
  const hasClientIdMatch = clientId ? collectClientIds(doc).includes(clientId) : false;
  if (phone && clientId) {
    // Viva may expose an active booking participant by clientId without a phone.
    // The list query is intentionally identity-based, so either current identity is sufficient.
    if (!hasPhoneMatch && !hasClientIdMatch) return;
  } else if (phone && !hasPhoneMatch) {
    return;
  } else if (clientId && !hasClientIdMatch) {
    return;
  }

  if (paymentRef) {
    const splitPayment = isObj(doc?.metadata?.splitPayment) ? doc.metadata.splitPayment : null;
    const splitPaymentRefs = asArray(splitPayment?.payments)
      .map((item) => (isObj(item) ? toStr(item.paymentRef) : null))
      .filter(Boolean);
    const paymentRefs = uniq([
      toStr(doc?.metadata?.paymentRef),
      toStr(splitPayment?.paymentRef),
      toStr(doc?.payment?.paymentRef),
      ...splitPaymentRefs,
    ]);
    if (!paymentRefs.includes(paymentRef)) return;
  }

  if (bookingIdsFilter.size > 0) {
    const recordBookingIds = collectBookingIds(doc);
    const hasIntersect = recordBookingIds.some((id) => bookingIdsFilter.has(id));
    if (!hasIntersect) return;
  }

  const splitPayment = isObj(doc?.metadata?.splitPayment) ? doc.metadata.splitPayment : null;
  const docPaymentRef =
    toStr(doc?.metadata?.paymentRef)
    || toStr(splitPayment?.paymentRef)
    || toStr(doc?.payment?.paymentRef)
    || toStr(asArray(splitPayment?.payments).find((item) => isObj(item) && toStr(item.paymentRef))?.paymentRef)
    || null;
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
const sanitizedGames = slicedGames.map((doc) => sanitizeListDoc(doc));
const hasMore = safeLimit ? offset + slicedGames.length < total : false;

msg.statusCode = 200;
msg.headers = { "Content-Type": "application/json; charset=utf-8" };
msg.payload = {
  phone,
  clientId,
  paymentRef,
  bookingIds: Array.from(bookingIdsFilter.values()),
  public: publicMode,
  date: dateFilter,
  offset,
  limit: safeLimit,
  total,
  hasMore,
  games: sanitizedGames,
};

return [msg, msg];
