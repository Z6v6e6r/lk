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
const EXERCISE_CATEGORY_OPEN_GAME = "open_game";
const EXERCISE_CATEGORY_COURT_RENTAL = "court_rental";
const EXERCISE_CATEGORY_GROUP_TRAINING = "group_training";
const EXERCISE_CATEGORY_TOURNAMENT = "tournament";
const OPEN_GAME_DIRECTION_IDS = [4588];
const OPEN_GAME_TYPE_IDS = [1613];
const GROUP_TRAINING_TYPE_IDS = [605, 847, 963, 1208];
const TOURNAMENT_DIRECTION_IDS = [2617, 3284, 4769];
const TOURNAMENT_TYPE_IDS = [839, 1013];
const AUDIT_MAX_EVENTS = 200;

const includesNum = (arr, value) => value !== null && arr.includes(Math.trunc(value));
const normalizeMarker = (value) => String(value || "")
  .trim()
  .toLowerCase()
  .replace(/ё/g, "е")
  .replace(/[^a-z0-9а-я]+/gi, "");
const hasTournamentMarker = (markers) => markers.some((marker) => (
  marker.includes("турнир")
  || marker.includes("tournament")
  || marker.includes("американо")
  || marker.includes("americano")
  || marker.includes("мексикано")
  || marker.includes("mexicano")
  || marker.includes("roundrobin")
  || marker.includes("олимп")
  || marker.includes("турнирособый")
  || marker.includes("padeltournament")
));
const hasGroupTrainingMarker = (markers) => markers.some((marker) => (
  marker.includes("трен")
  || marker.includes("training")
  || marker.includes("coach")
  || marker.includes("групп")
  || marker.includes("group")
  || marker.includes("игратренер")
  || marker.includes("gameplustrainer")
));
const hasOpenGameMarker = (markers) => markers.some((marker) => (
  marker.includes("свояигра")
  || marker.includes("своюигру")
  || marker.includes("открытаяигра")
  || marker.includes("opengame")
  || marker.includes("сплит")
  || marker.includes("split")
  || marker.includes("игра")
  || marker.includes("game")
));
const hasCourtRentalMarker = (markers) => markers.some((marker) => (
  marker.includes("аренда")
  || marker.includes("арендовать")
  || marker.includes("courtrental")
  || marker.includes("rentalcourt")
));
const resolveExerciseCategory = ({ typeId, directionId, typeName, directionName }) => {
  if (includesNum(OPEN_GAME_TYPE_IDS, typeId) || includesNum(OPEN_GAME_DIRECTION_IDS, directionId)) {
    return EXERCISE_CATEGORY_OPEN_GAME;
  }
  if (includesNum(TOURNAMENT_TYPE_IDS, typeId) || includesNum(TOURNAMENT_DIRECTION_IDS, directionId)) {
    return EXERCISE_CATEGORY_TOURNAMENT;
  }
  if (includesNum(GROUP_TRAINING_TYPE_IDS, typeId)) {
    return EXERCISE_CATEGORY_GROUP_TRAINING;
  }

  const markers = [
    normalizeMarker(typeName),
    normalizeMarker(directionName),
  ].filter(Boolean);
  if (hasTournamentMarker(markers)) return EXERCISE_CATEGORY_TOURNAMENT;
  if (hasGroupTrainingMarker(markers)) return EXERCISE_CATEGORY_GROUP_TRAINING;
  if (hasOpenGameMarker(markers)) return EXERCISE_CATEGORY_OPEN_GAME;
  if (hasCourtRentalMarker(markers)) return EXERCISE_CATEGORY_COURT_RENTAL;
  return null;
};

const buildAuditEventId = () => `g_audit_${Date.now()}_${Math.random().toString(36).slice(2, 10)}`;

const buildAuditEvent = (nowIso, type, payload) => ({
  id: buildAuditEventId(),
  at: nowIso,
  type,
  source: "games_create",
  payload,
});

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
const hasOwn = (obj, key) => Object.prototype.hasOwnProperty.call(obj, key);
const normalizeNameKey = (value) => String(value || "")
  .toLowerCase()
  .replace(/ё/g, "е")
  .replace(/[^a-zа-я0-9]+/gi, " ")
  .replace(/\s+/g, " ")
  .trim();
const sanitizeMemberKeyPart = (value) => String(value || "")
  .toLowerCase()
  .replace(/ё/g, "е")
  .replace(/[^a-zа-я0-9_-]+/gi, "_")
  .replace(/^_+|_+$/g, "")
  .slice(0, 120);
const isPlaceholderName = (value) => {
  const normalized = normalizeNameKey(value);
  return !normalized || normalized === "игрок" || normalized === "организатор";
};
const preferSnapshotStatus = (current, incoming) => {
  const rank = (value) => {
    const normalized = String(value || "").trim().toUpperCase();
    if (normalized === "CONFIRMED") return 3;
    if (normalized === "PENDING") return 2;
    if (normalized === "WAITLIST") return 1;
    return 0;
  };
  return rank(incoming) >= rank(current) ? (incoming || current || null) : (current || incoming || null);
};
const normalizeSnapshotMemberInput = (value, fallbackSource, fallbackStatus) => {
  if (value === null || value === undefined) return null;
  if (typeof value === "string" || typeof value === "number") {
    const raw = toStr(value);
    const phoneNorm = normPhone(raw);
    if (!raw && !phoneNorm) return null;
    return {
      explicitMemberKey: null,
      clientId: raw,
      phoneNorm,
      name: phoneNorm ? null : raw,
      nameKey: normalizeNameKey(phoneNorm ? null : raw),
      photo: null,
      rating: null,
      ratingNumeric: null,
      source: toStr(fallbackSource || "INVITE_LINK"),
      status: toStr(fallbackStatus || "CONFIRMED"),
      role: null,
    };
  }
  if (!isObj(value)) return null;
  const clientId = toStr(value.clientId || value.id || value.userId || value.uuid);
  const phoneNorm = normPhone(value.phoneNorm || value.phone || value.phoneNumber || value.mobile);
  const name = toStr(value.name || value.fullName || value.title || [value.firstName, value.lastName].filter(Boolean).join(" "));
  const nameKey = normalizeNameKey(name);
  if (!clientId && !phoneNorm && isPlaceholderName(name)) return null;
  return {
    explicitMemberKey: toStr(value.memberKey || value.member_key),
    clientId,
    phoneNorm,
    name: name || "Игрок",
    nameKey,
    photo: toStr(value.photo || value.avatar || value.imageUrl),
    rating: toStr(value.rating || value.level || value.grade),
    ratingNumeric: toNum(value.ratingNumeric || value.numericRating || value.levelNumeric),
    source: toStr(value.source || fallbackSource || "INVITE_LINK"),
    status: toStr(value.status || fallbackStatus || "CONFIRMED"),
    role: toStr(value.role),
  };
};
const mergeSnapshotMember = (current, incoming) => ({
  memberKey: incoming.memberKey || current.memberKey,
  clientId: current.clientId || incoming.clientId || null,
  phoneNorm: current.phoneNorm || incoming.phoneNorm || null,
  name: !isPlaceholderName(current.name) ? current.name : (incoming.name || current.name || "Игрок"),
  photo: current.photo || incoming.photo || null,
  rating: current.rating || incoming.rating || null,
  ratingNumeric: current.ratingNumeric !== null && current.ratingNumeric !== undefined
    ? current.ratingNumeric
    : (incoming.ratingNumeric !== null && incoming.ratingNumeric !== undefined ? incoming.ratingNumeric : null),
  source: current.source === "ORGANIZER" ? current.source : (incoming.source || current.source || null),
  status: preferSnapshotStatus(current.status, incoming.status),
  role: current.role || incoming.role || null,
  nameKey: current.nameKey || incoming.nameKey || null,
});
const buildSnapshotIdentityKeys = (member) => uniq([
  member?.memberKey ? `member:${member.memberKey}` : null,
  member?.phoneNorm ? `phone:${member.phoneNorm}` : null,
  member?.clientId ? `id:${member.clientId}` : null,
  member?.nameKey ? `name:${member.nameKey}` : null,
]);
const snapshotMemberForResponse = (member) => {
  if (!member) return null;
  return {
    memberKey: member.memberKey,
    clientId: member.clientId || null,
    phoneNorm: member.phoneNorm || null,
    name: member.name || "Игрок",
    photo: member.photo || null,
    rating: member.rating || null,
    ratingNumeric: member.ratingNumeric !== null && member.ratingNumeric !== undefined ? member.ratingNumeric : null,
    source: member.source || null,
    status: member.status || null,
    role: member.role || null,
  };
};
const snapshotSlotRef = (member) => (member ? {
  memberKey: member.memberKey,
  clientId: member.clientId || null,
  phoneNorm: member.phoneNorm || null,
  name: member.name || "Игрок",
} : null);
const extractSnapshotInitialTeamSlots = (metadata, seedSnapshot) => {
  const matchResult = isObj(metadata?.matchResult) ? metadata.matchResult : null;
  const firstPairing = asArray(matchResult?.setPairings || matchResult?.pairings)
    .filter((item) => isObj(item) && asArray(item.teamSlots || item.slots).some(Boolean))
    .sort((left, right) => Number(left?.setIndex || 0) - Number(right?.setIndex || 0))[0] || null;
  if (firstPairing) return asArray(firstPairing.teamSlots || firstPairing.slots);
  if (asArray(metadata?.teamSlots).some(Boolean)) return asArray(metadata.teamSlots);
  if (asArray(seedSnapshot?.initialTeamSlots).some(Boolean)) return asArray(seedSnapshot.initialTeamSlots);
  return [];
};
const buildResultRosterSnapshot = ({
  organizer: organizerSource,
  participants: participantsSource,
  waitlist: waitlistSource,
  metadata,
  booking,
  invite,
  nowIso: capturedAt,
  source,
  seedSnapshot,
}) => {
  const nowTs = Date.parse(capturedAt);
  const membersByKey = new Map();
  const memberKeyMap = new Map();
  const registerMember = (value, options = {}) => {
    const normalized = normalizeSnapshotMemberInput(value, options.fallbackSource, options.fallbackStatus);
    if (!normalized) return null;
    const identityKeys = uniq([
      normalized.clientId ? `id:${normalized.clientId}` : null,
      normalized.phoneNorm ? `phone:${normalized.phoneNorm}` : null,
      normalized.nameKey ? `name:${normalized.nameKey}` : null,
    ]);
    let memberKey = toStr(normalized.explicitMemberKey);
    if (!memberKey) {
      memberKey = identityKeys.map((key) => memberKeyMap.get(key)).find(Boolean) || null;
    }
    if (!memberKey) {
      if (normalized.clientId) {
        memberKey = `id:${sanitizeMemberKeyPart(normalized.clientId) || normalized.clientId}`;
      } else if (normalized.phoneNorm) {
        memberKey = `phone:${normalized.phoneNorm}`;
      } else if (normalized.nameKey) {
        memberKey = `name:${sanitizeMemberKeyPart(normalized.nameKey) || "player"}`;
      } else {
        memberKey = `anon:${sanitizeMemberKeyPart(options.fallbackBucket || "member") || "member"}:${Number(options.fallbackIndex || 0) + 1}`;
      }
    }
    const incoming = {
      memberKey,
      clientId: normalized.clientId || null,
      phoneNorm: normalized.phoneNorm || null,
      name: normalized.name || "Игрок",
      photo: normalized.photo || null,
      rating: normalized.rating || null,
      ratingNumeric: normalized.ratingNumeric !== null && normalized.ratingNumeric !== undefined ? normalized.ratingNumeric : null,
      source: normalized.source || null,
      status: normalized.status || null,
      role: options.role || normalized.role || null,
      nameKey: normalized.nameKey || null,
    };
    const existing = membersByKey.get(memberKey);
    const merged = existing ? mergeSnapshotMember(existing, incoming) : incoming;
    membersByKey.set(memberKey, merged);
    buildSnapshotIdentityKeys(merged).forEach((key) => memberKeyMap.set(key, memberKey));
    return merged;
  };
  const seedSources = [
    seedSnapshot?.organizer,
    ...asArray(seedSnapshot?.activeRoster),
    ...asArray(seedSnapshot?.waitlist),
    ...asArray(seedSnapshot?.allPlayers),
    ...asArray(seedSnapshot?.playerPool),
    ...asArray(seedSnapshot?.initialTeamSlots),
  ];
  seedSources.forEach((item, index) => registerMember(item, {
    fallbackSource: "SNAPSHOT",
    fallbackStatus: "CONFIRMED",
    fallbackBucket: "seed",
    fallbackIndex: index,
  }));

  const organizerEntry = registerMember(organizerSource || seedSnapshot?.organizer, {
    fallbackSource: "ORGANIZER",
    fallbackStatus: "CONFIRMED",
    fallbackBucket: "organizer",
    fallbackIndex: 0,
    role: "ORGANIZER",
  });
  const participantEntries = dedupeByKey(
    asArray(participantsSource).map((player, index) => registerMember(player, {
      fallbackSource: "INVITED",
      fallbackStatus: "CONFIRMED",
      fallbackBucket: "participant",
      fallbackIndex: index,
    })).filter(Boolean),
  );
  const seedWaitlist = Array.isArray(waitlistSource) ? [] : asArray(seedSnapshot?.waitlist);
  const waitlistEntries = dedupeByKey(
    [...asArray(waitlistSource), ...seedWaitlist].map((player, index) => registerMember(player, {
      fallbackSource: "WAITLIST",
      fallbackStatus: "WAITLIST",
      fallbackBucket: "waitlist",
      fallbackIndex: index,
    })).filter(Boolean),
  );

  const explicitOrganizerInMatch = typeof metadata?.organizerInMatch === "boolean"
    ? metadata.organizerInMatch
    : typeof seedSnapshot?.organizerInMatch === "boolean"
      ? seedSnapshot.organizerInMatch
      : null;
  const organizerInMatch = explicitOrganizerInMatch !== null
    ? explicitOrganizerInMatch
    : (organizerEntry ? (participantEntries.length === 0 || participantEntries.some((item) => item.memberKey === organizerEntry.memberKey)) : false);
  const maxPlayersRaw = Number(invite?.maxPlayers ?? seedSnapshot?.bookingContext?.maxPlayers ?? seedSnapshot?.booking?.maxPlayers);
  const maxPlayers = Number.isFinite(maxPlayersRaw) && maxPlayersRaw > 0 ? Math.floor(maxPlayersRaw) : 4;
  const activeRoster = dedupeByKey([
    organizerInMatch && organizerEntry ? organizerEntry : null,
    ...participantEntries,
  ]).slice(0, maxPlayers);
  const activeKeys = new Set(activeRoster.map((item) => item.memberKey));
  const normalizedWaitlist = waitlistEntries.filter((item) => !activeKeys.has(item.memberKey));

  const rawInitialSlots = extractSnapshotInitialTeamSlots(metadata, seedSnapshot);
  const initialTeamSlots = Array.from({ length: 4 }, (_, slotIndex) => {
    const slotEntry = registerMember(rawInitialSlots[slotIndex] || activeRoster[slotIndex] || null, {
      fallbackSource: "TEAM_SLOT",
      fallbackStatus: "CONFIRMED",
      fallbackBucket: "slot",
      fallbackIndex: slotIndex,
    });
    return snapshotSlotRef(slotEntry);
  });

  const orderedKeys = [];
  const orderedSet = new Set();
  const pushMember = (member) => {
    if (!member || orderedSet.has(member.memberKey)) return;
    orderedSet.add(member.memberKey);
    orderedKeys.push(member.memberKey);
  };
  [organizerEntry, ...activeRoster, ...normalizedWaitlist].forEach(pushMember);
  initialTeamSlots.forEach((slotRef) => {
    if (!slotRef?.memberKey) return;
    const member = membersByKey.get(slotRef.memberKey);
    pushMember(member);
  });
  Array.from(membersByKey.values()).forEach(pushMember);
  const allPlayers = orderedKeys
    .map((memberKey) => membersByKey.get(memberKey))
    .filter(Boolean)
    .map((member) => snapshotMemberForResponse(member));
  const bookingSeed = isObj(seedSnapshot?.bookingContext)
    ? seedSnapshot.bookingContext
    : (isObj(seedSnapshot?.booking) ? seedSnapshot.booking : {});
  const bookingIds = uniq([
    ...parseBookingIds(booking?.bookingIds),
    ...parseBookingIds(bookingSeed?.bookingIds),
  ]);
  const bookingContext = {
    studioId: toStr(booking?.studioId || bookingSeed?.studioId),
    studioName: toStr(booking?.studioName || bookingSeed?.studioName),
    roomId: toStr(booking?.roomId || bookingSeed?.roomId),
    roomName: toStr(booking?.roomName || bookingSeed?.roomName),
    date: toStr(booking?.date || bookingSeed?.date),
    timeFrom: toStr(booking?.timeFrom || bookingSeed?.timeFrom),
    timeTo: toStr(booking?.timeTo || bookingSeed?.timeTo),
    timeFromIso: toStr(booking?.timeFromIso || bookingSeed?.timeFromIso),
    timeToIso: toStr(booking?.timeToIso || bookingSeed?.timeToIso),
    startTs: Number.isFinite(Number(booking?.startTs)) ? Number(booking.startTs) : (Number.isFinite(Number(bookingSeed?.startTs)) ? Number(bookingSeed.startTs) : null),
    endTs: Number.isFinite(Number(booking?.endTs)) ? Number(booking.endTs) : (Number.isFinite(Number(bookingSeed?.endTs)) ? Number(bookingSeed.endTs) : null),
    bookingIds,
    vivaExerciseId: toStr(booking?.vivaExerciseId || booking?.exerciseId || bookingSeed?.vivaExerciseId || bookingSeed?.exerciseId),
    exerciseId: toStr(booking?.exerciseId || booking?.vivaExerciseId || bookingSeed?.exerciseId || bookingSeed?.vivaExerciseId),
    maxPlayers,
    waitlistEnabled: typeof invite?.waitlistEnabled === "boolean"
      ? invite.waitlistEnabled
      : (typeof bookingSeed?.waitlistEnabled === "boolean" ? bookingSeed.waitlistEnabled : true),
  };
  return {
    version: 3,
    schemaVersion: 3,
    canonical: true,
    source: toStr(source) || "games_create",
    capturedAt,
    capturedAtTs: Number.isFinite(nowTs) ? nowTs : Date.now(),
    organizerInMatch,
    organizer: snapshotMemberForResponse(organizerEntry),
    activeRoster: activeRoster.map((member) => snapshotMemberForResponse(member)),
    waitlist: normalizedWaitlist.map((member) => snapshotMemberForResponse(member)),
    allPlayers,
    playerPool: allPlayers,
    memberKeyMap: Object.fromEntries(Array.from(memberKeyMap.entries()).sort((left, right) => left[0].localeCompare(right[0]))),
    initialTeamSlots,
    bookingContext,
    booking: bookingContext,
    allowedPhoneNorms: uniq(allPlayers.map((member) => member?.phoneNorm).filter(Boolean)),
    allowedClientIds: uniq(allPlayers.map((member) => member?.clientId).filter(Boolean)),
  };
};
const dedupeByKey = (items) => {
  const seen = new Set();
  return items.filter((item) => {
    const key = item?.memberKey;
    if (!key || seen.has(key)) return false;
    seen.add(key);
    return true;
  });
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

const internalAction = toStr(msg._action);
let mode = "create";
if (reqPath.includes("/payment/confirm")) mode = "confirm";
if (reqPath.includes("/draft")) mode = "draft";
if (internalAction) {
  const normalized = internalAction.toLowerCase();
  if (["create", "draft", "confirm"].includes(normalized)) {
    mode = normalized;
  }
}

const booking = isObj(body.booking) ? body.booking : {};
const payment = isObj(body.payment) ? body.payment : {};
const settings = isObj(body.settings) ? body.settings : {};
const invite = isObj(body.invite) ? body.invite : {};
const metadataInput = isObj(body.metadata) ? body.metadata : {};
const splitPaymentInput = isObj(metadataInput.splitPayment) ? metadataInput.splitPayment : {};
const organizer = isObj(body.organizer) ? body.organizer : {};
const requestSource = toStr(metadataInput.source || body.source);
const bookingConvertTypeId = toNum(
  body.typeId
  || booking.typeId
  || metadataInput.typeId
  || splitPaymentInput.typeId,
);
const bookingConvertTypeName = toStr(
  body.typeName
  || booking.typeName
  || metadataInput.typeName
  || splitPaymentInput.typeName,
);
const bookingConvertDirectionId = toNum(
  body.directionId
  || booking.directionId
  || metadataInput.directionId
  || splitPaymentInput.directionId,
);
const bookingConvertDirectionName = toStr(
  body.directionName
  || booking.directionName
  || metadataInput.directionName
  || splitPaymentInput.directionName,
);
const bookingConvertCategory = resolveExerciseCategory({
  typeId: bookingConvertTypeId,
  typeName: bookingConvertTypeName,
  directionId: bookingConvertDirectionId,
  directionName: bookingConvertDirectionName,
});
const isCabinetBookingConvert = requestSource === "cabinet_booking_convert";

const isBookingConvertCategoryAllowed = (
  bookingConvertCategory === EXERCISE_CATEGORY_OPEN_GAME
  || bookingConvertCategory === EXERCISE_CATEGORY_COURT_RENTAL
);

if (isCabinetBookingConvert && !isBookingConvertCategoryAllowed) {
  const error = bookingConvertCategory
    ? "Из этой брони нельзя создать сборную игру. Конвертация доступна только для открытой игры или аренды корта."
    : "Не удалось определить тип брони. Конвертация доступна только для открытой игры или аренды корта.";
  const code = bookingConvertCategory
    ? "BOOKING_CONVERT_CATEGORY_NOT_ALLOWED"
    : "BOOKING_CONVERT_CATEGORY_UNKNOWN";
  const errMsg = Object.assign({}, msg, {
    statusCode: 409,
    headers: { "Content-Type": "application/json; charset=utf-8" },
    payload: {
      error,
      code,
      category: bookingConvertCategory,
      source: requestSource,
      typeId: bookingConvertTypeId,
      typeName: bookingConvertTypeName,
      directionId: bookingConvertDirectionId,
      directionName: bookingConvertDirectionName,
    },
  });
  const debugMsg = Object.assign({}, errMsg, {
    payload: {
      action: "booking_convert_blocked",
      code,
      category: bookingConvertCategory,
      source: requestSource,
      typeId: bookingConvertTypeId,
      typeName: bookingConvertTypeName,
      directionId: bookingConvertDirectionId,
      directionName: bookingConvertDirectionName,
    },
  });
  return [null, errMsg, debugMsg, null];
}

const singlesByFormat = isSinglesFormat(
  metadataInput.gameFormat
  || metadataInput.format
  || body.gameFormat
  || body.format,
);
const singlesByCourtName = [
  booking.roomName,
  body.roomName,
  metadataInput.roomName,
  metadataInput.courtName,
  metadataInput.courtTitle,
].some((value) => isSinglesCourtName(value));
const singlesMode = singlesByFormat || singlesByCourtName;

const resolveInviteMaxPlayers = (rawMaxPlayers) => {
  const parsed = Number(rawMaxPlayers);
  if (singlesMode) return 2;
  if (Number.isFinite(parsed) && parsed > 0) return Math.floor(parsed);
  return 4;
};

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

// Internal seam for a future pre-upsert Viva lookup node. Do not accept this
// value from the public request payload: only an upstream Node-RED node may
// populate msg._gameConfirmExerciseLookup after resolving bookingIds in Viva.
const confirmExerciseLookup = isObj(msg._gameConfirmExerciseLookup)
  ? msg._gameConfirmExerciseLookup
  : {};
const confirmLookupBookingIds = uniq(parseBookingIds(confirmExerciseLookup.bookingIds));
const confirmLookupMatchesBookings = (
  bookingIds.length > 0
  && confirmLookupBookingIds.length === bookingIds.length
  && bookingIds.every((bookingId) => confirmLookupBookingIds.includes(bookingId))
);
const confirmLookupIsActive = (
  (!hasOwn(confirmExerciseLookup, "active") || confirmExerciseLookup.active === true)
  && (!hasOwn(confirmExerciseLookup, "notCancelled") || confirmExerciseLookup.notCancelled === true)
  && (!hasOwn(confirmExerciseLookup, "cancelled") || confirmExerciseLookup.cancelled === false)
  && (!hasOwn(confirmExerciseLookup, "isCancelled") || confirmExerciseLookup.isCancelled === false)
);
const confirmedLookupExerciseId = confirmLookupMatchesBookings && confirmLookupIsActive
  ? toStr(confirmExerciseLookup.vivaExerciseId || confirmExerciseLookup.exerciseId)
  : null;
const vivaExerciseId = toStr(
  booking.vivaExerciseId
    || booking.exerciseId
    || metadataInput.vivaExerciseId
    || metadataInput.exerciseId
    || splitPaymentInput.vivaExerciseId
    || splitPaymentInput.exerciseId
    || confirmedLookupExerciseId,
);

const slotKey = [studioId, roomId, date, timeFrom, timeTo, subServiceIds.join(",")].join("|");
const dedupeKey = vivaExerciseId ? `viva:${vivaExerciseId}` : `slot:${slotKey}`;

const fallbackIdBase = paymentRef ? `pay:${paymentRef}` : dedupeKey;
const fallbackId = fallbackIdBase.replace(/[^a-zA-Z0-9_-]/g, "_").slice(0, 120);
const gameId = toStr(body.id || body.gameId || body.recordId) || fallbackId || `g_${Date.now()}`;
const expectedRevision = body.revision !== null && body.revision !== undefined
  && Number.isSafeInteger(Number(body.revision))
  ? Number(body.revision)
  : null;
const expectedUpdatedAt = toStr(body.updatedAt || body.expectedUpdatedAt);

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
    ? false
    : mode === "confirm"
      ? true
      : (incomingPaid === null ? true : incomingPaid);

// GAME_PAYMENT_CONFIRM_GUARD_START
const paymentVerification = isObj(msg._gamePaymentVerified) ? msg._gamePaymentVerified : null;
if (
  mode === "confirm"
  && (
    paymentVerification?.verified !== true
    || toStr(paymentVerification.paymentRef) !== paymentRef
    || toStr(paymentVerification.source) !== "viva_transaction_readback"
    || !toStr(paymentVerification.transactionId)
    || !toStr(paymentVerification.bookingId)
    || !toStr(paymentVerification.exerciseId)
  )
) {
  const errorPayload = {
    error: "Оплата должна быть подтверждена сервером по данным Viva",
    code: "GAME_PAYMENT_EVIDENCE_REQUIRED",
    paymentRef: paymentRef || null,
    retryable: true,
  };
  const errMsg = Object.assign({}, msg, {
    statusCode: 409,
    headers: { "Content-Type": "application/json; charset=utf-8" },
    payload: errorPayload,
  });
  return [null, errMsg, errMsg, null];
}

if (mode === "confirm" && expectedRevision === null && !expectedUpdatedAt) {
  const errorPayload = {
    error: "Черновик оплаты не содержит версии для безопасного подтверждения",
    code: "GAME_PAYMENT_STALE_GUARD_REQUIRED",
    paymentRef: paymentRef || null,
    retryable: true,
  };
  const errMsg = Object.assign({}, msg, {
    statusCode: 409,
    headers: { "Content-Type": "application/json; charset=utf-8" },
    payload: errorPayload,
  });
  return [null, errMsg, errMsg, null];
}

if (
  mode === "create"
  && resolvedPaid === true
  && paymentVerification?.verified !== true
  && (
    toStr(settings.payMode)?.toLowerCase() === "split"
    || splitPaymentInput.enabled === true
    || requestSource === "games_split_widget"
    || Boolean(paymentRef)
  )
) {
  const errorPayload = {
    error: "Платная split-игра требует серверного подтверждения транзакции",
    code: "GAME_PAYMENT_EVIDENCE_REQUIRED",
    paymentRef: paymentRef || null,
    retryable: true,
  };
  const errMsg = Object.assign({}, msg, {
    statusCode: 409,
    headers: { "Content-Type": "application/json; charset=utf-8" },
    payload: errorPayload,
  });
  return [null, errMsg, errMsg, null];
}
// GAME_PAYMENT_CONFIRM_GUARD_END

const incomingStatus = toStr(body.status);
const resolvedStatus =
  mode === "draft"
    ? "PAYMENT_PENDING"
    : incomingStatus
      || (resolvedPaid ? "PAID" : "PAYMENT_PENDING");

const isPaidWidgetCreate = (
  mode === "create"
  && resolvedPaid === true
  && ["games_widget", "games_widget_zero_pay"].includes(requestSource)
);
const requiresConfirmedExerciseId = mode === "confirm" || isPaidWidgetCreate;

if (requiresConfirmedExerciseId && resolvedPaid === true && bookingIds.length > 0 && !vivaExerciseId) {
  const errorPayload = {
    error: "Не удалось связать оплаченную бронь с занятием Viva. Повторите синхронизацию.",
    code: "GAME_EXERCISE_ID_MISSING",
    paymentRef: paymentRef || null,
    bookingIds,
    retryable: true,
    lookupRequired: true,
  };
  const errMsg = Object.assign({}, msg, {
    statusCode: 409,
    headers: { "Content-Type": "application/json; charset=utf-8" },
    payload: errorPayload,
  });
  const debugMsg = Object.assign({}, errMsg, {
    payload: {
      action: "paid_confirm_blocked_missing_exercise_id",
      code: errorPayload.code,
      paymentRef: errorPayload.paymentRef,
      bookingIds,
      lookupRequired: true,
    },
  });
  return [null, errMsg, debugMsg, null];
}

const metadataForRecord = Object.assign({}, metadataInput);
if (hasOwn(metadataForRecord, "resultRosterSnapshot")) delete metadataForRecord.resultRosterSnapshot;
if (hasOwn(metadataForRecord, "rosterSnapshot")) delete metadataForRecord.rosterSnapshot;
const snapshotSeed = isObj(body.resultRosterSnapshot)
  ? body.resultRosterSnapshot
  : (isObj(metadataInput.resultRosterSnapshot) ? metadataInput.resultRosterSnapshot : null);
const mergedMetadata = Object.assign({}, metadataForRecord, {
  paymentRef: paymentRef || metadataPaymentRef || null,
  bookingIds,
  vivaExerciseId: metadataForRecord.vivaExerciseId || vivaExerciseId || null,
  exerciseId: metadataForRecord.exerciseId || vivaExerciseId || null,
  sourceMode: mode,
});
const resultRosterSnapshot = buildResultRosterSnapshot({
  organizer: organizerNorm,
  participants,
  waitlist,
  metadata: mergedMetadata,
  booking: {
    studioId,
    studioName: toStr(booking.studioName),
    roomId,
    roomName: toStr(booking.roomName),
    date,
    timeFrom,
    timeTo,
    timeFromIso: startIso,
    timeToIso: endIso,
    startTs,
    endTs,
    bookingIds,
    vivaExerciseId,
    exerciseId: vivaExerciseId,
  },
  invite: {
    waitlistEnabled: typeof invite.waitlistEnabled === "boolean" ? invite.waitlistEnabled : true,
    maxPlayers: resolveInviteMaxPlayers(invite.maxPlayers),
  },
  nowIso,
  source: "games_create",
  seedSnapshot: snapshotSeed,
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
    exerciseId: vivaExerciseId,
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
    maxPlayers: resolveInviteMaxPlayers(invite.maxPlayers),
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

const auditEventType = mode === "draft"
  ? "GAME_DRAFT_SAVED"
  : mode === "confirm"
    ? "GAME_PAYMENT_CONFIRMED"
    : "GAME_CREATED";
const auditEvent = buildAuditEvent(nowIso, auditEventType, {
  requestPath: reqPathRaw || null,
  requestMode: mode,
  gameId,
  dedupeKey,
  paymentRef: paymentRef || null,
  bookingIds,
  vivaExerciseId: vivaExerciseId || null,
  status: resolvedStatus || null,
  paid: resolvedPaid,
  archived: Boolean(body.archived),
});

const paymentRefFilter = paymentRef
  ? {
      $or: [
        { "metadata.paymentRef": paymentRef },
        { "payment.paymentRef": paymentRef },
      ],
    }
  : { dedupeKey };
const queryFilter = mode === "confirm"
  ? {
      $and: [
        paymentRefFilter,
        { archived: { $ne: true } },
        { status: "PAYMENT_PENDING" },
        expectedRevision !== null
          ? { revision: expectedRevision }
          : { updatedAt: expectedUpdatedAt },
      ],
    }
  : paymentRefFilter;

const dbMsg = Object.assign({}, msg, {
  query: queryFilter,
  payload: {
    $set: {
      ...record,
      resultRosterSnapshot,
      "audit.version": 1,
      "audit.updatedAt": nowIso,
      "audit.lastEvent": auditEvent,
    },
    $setOnInsert: {
      createdAt: nowIso,
    },
    $push: {
      "audit.events": {
        $each: [auditEvent],
        $slice: -AUDIT_MAX_EVENTS,
      },
    },
  },
  _recordForResponse: Object.assign(
    {
      createdAt: nowIso,
      audit: {
        version: 1,
        updatedAt: nowIso,
        lastEvent: auditEvent,
        events: [auditEvent],
      },
    },
    record,
  ),
  _httpStatus: 200,
  _requestUrl: reqPathRaw,
  _requestMode: mode,
  ...(mode === "confirm" ? {
    _gameConfirmWriteAck: {
      step: "write_ack",
      gameId,
      paymentRef,
      transactionId: toStr(paymentVerification?.transactionId),
      bookingId: toStr(paymentVerification?.bookingId),
      exerciseId: toStr(paymentVerification?.exerciseId),
    },
  } : {}),
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

return [
  dbMsg,
  mode === "confirm" ? null : responseMsg,
  debugMsg,
  mode === "confirm" ? null : autojoinMsg,
];
