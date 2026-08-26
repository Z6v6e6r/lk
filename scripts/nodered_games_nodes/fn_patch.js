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
const toNum = (v) => {
  if (v === null || v === undefined) return null;
  const n = Number(String(v).replace(",", "."));
  return Number.isFinite(n) ? n : null;
};
const AUDIT_MAX_EVENTS = 200;

const buildAuditEventId = () => `g_audit_${Date.now()}_${Math.random().toString(36).slice(2, 10)}`;

const buildAuditEvent = (nowIso, payload) => ({
  id: buildAuditEventId(),
  at: nowIso,
  type: "GAME_PATCHED",
  source: "games_patch",
  payload,
});

const gameId = String(msg.req?.params?.gameId || "").trim();
if (!gameId) {
  msg.statusCode = 400;
  msg.headers = { "Content-Type": "application/json; charset=utf-8" };
  msg.payload = { error: "gameId is required" };
  return [null, msg, msg];
}

const body = isObj(msg.payload) ? msg.payload : {};
if (
  Object.prototype.hasOwnProperty.call(body, "participants")
    || Object.prototype.hasOwnProperty.call(body, "waitlist")
) {
  msg.statusCode = 403;
  msg.headers = {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store",
  };
  msg.payload = {
    code: "GAME_ROSTER_COMMAND_REQUIRED",
    error: "Состав игры изменяется только через защищённую команду записи",
  };
  return [null, msg, msg, null];
}
const reqPathRaw =
  toStr(msg.req?.path)
  || toStr(msg.req?.originalUrl)
  || toStr(msg.req?.url)
  || "";
const nowIso = new Date().toISOString();
const setDoc = {};
const responsePatch = {};
const hasOwn = (obj, key) => Object.prototype.hasOwnProperty.call(obj, key);
const cancellationMetadataKeys = [
  "deletedInViva",
  "vivaDeleted",
  "removedFromViva",
  "vivaRemoved",
  "bookingDeleted",
  "bookingRemoved",
  "bookingMissing",
  "exerciseMissing",
  "cancelledInViva",
  "canceledInViva",
];
const isCancelLikeStatus = (value) => {
  const status = String(value || "").trim().toUpperCase();
  return Boolean(status && status.includes("CANCEL"));
};
const hasTrueLikeValue = (value) => (
  value === true
  || String(value || "").trim().toLowerCase() === "true"
  || String(value || "").trim() === "1"
);
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
const dedupeByKey = (items) => {
  const seen = new Set();
  return items.filter((item) => {
    const key = item?.memberKey;
    if (!key || seen.has(key)) return false;
    seen.add(key);
    return true;
  });
};
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
    source: toStr(source) || "games_patch",
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
const hasRosterSnapshotMetadata = (value) => {
  if (!isObj(value)) return false;
  return [
    "teamSlots",
    "organizerInMatch",
    "matchResult",
    "playerPool",
    "players",
    "allPlayers",
    "participantPhones",
    "waitlistPhones",
    "allRelatedPhones",
    "exerciseId",
    "vivaExerciseId",
    "bookingIds",
  ].some((key) => hasOwn(value, key));
};

const assignIfPresent = (key) => {
  if (hasOwn(body, key)) {
    setDoc[key] = body[key];
    responsePatch[key] = body[key];
  }
};

const requestedCancelStatus = hasOwn(body, "status") && isCancelLikeStatus(body.status);
let ignoredClientCancelPatch = requestedCancelStatus;
let sanitizedCancellationMetadata = false;

if (hasOwn(body, "status") && !requestedCancelStatus) {
  setDoc.status = body.status;
  responsePatch.status = body.status;
}

["chatUrl", "inviteUrl", "settings", "payment", "invite", "archived"].forEach(assignIfPresent);

if (hasOwn(body, "metadata")) {
  if (isObj(body.metadata)) {
    const metadataPatch = { ...body.metadata };
    if (hasOwn(metadataPatch, "resultRosterSnapshot")) delete metadataPatch.resultRosterSnapshot;
    if (hasOwn(metadataPatch, "rosterSnapshot")) delete metadataPatch.rosterSnapshot;
    cancellationMetadataKeys.forEach((key) => {
      if (!hasOwn(metadataPatch, key) || !hasTrueLikeValue(metadataPatch[key])) return;
      metadataPatch[key] = false;
      sanitizedCancellationMetadata = true;
    });
    if (requestedCancelStatus || sanitizedCancellationMetadata) {
      ignoredClientCancelPatch = true;
      metadataPatch.lastIgnoredClientCancelPatchAt = nowIso;
      metadataPatch.lastIgnoredClientCancelPatchReason = "GENERIC_PATCH_CANCEL_GUARD";
    }
    setDoc.metadata = metadataPatch;
    responsePatch.metadata = metadataPatch;
  } else {
    setDoc.metadata = body.metadata;
    responsePatch.metadata = body.metadata;
  }
}

let organizerPhoneForRecalc = null;
let organizerTouched = false;
if (isObj(body.organizer)) {
  const organizerPatch = {};
  const applyOrganizerField = (field, value) => {
    if (value === null || value === undefined || value === "") return;
    setDoc[`organizer.${field}`] = value;
    organizerPatch[field] = value;
    organizerTouched = true;
  };

  const organizerId = toStr(
    body.organizer.id
    || body.organizer.clientId
    || body.organizer.userId
    || body.organizer.uuid,
  );
  const organizerName = toStr(
    body.organizer.name || [body.organizer.firstName, body.organizer.lastName].filter(Boolean).join(" "),
  );
  const organizerPhone = normPhone(
    body.organizer.phone || body.organizer.phoneNumber || body.organizer.mobile || body.organizer.phoneNorm,
  );
  const organizerPhoto = toStr(body.organizer.photo || body.organizer.avatar || body.organizer.imageUrl);
  const organizerRating = toStr(body.organizer.rating || body.organizer.level || body.organizer.grade);
  const organizerRatingNumeric = toNum(
    body.organizer.ratingNumeric || body.organizer.numericRating || body.organizer.levelNumeric,
  );

  applyOrganizerField("id", organizerId);
  applyOrganizerField("name", organizerName);
  applyOrganizerField("photo", organizerPhoto);
  applyOrganizerField("rating", organizerRating);
  if (organizerRatingNumeric !== null) {
    applyOrganizerField("ratingNumeric", organizerRatingNumeric);
  }
  if (organizerPhone) {
    applyOrganizerField("phone", organizerPhone);
    applyOrganizerField("phoneNorm", organizerPhone);
    organizerPhoneForRecalc = organizerPhone;
  }

  if (organizerTouched) {
    responsePatch.organizer = organizerPatch;
  }
}

if (isObj(body.booking)) {
  const b = Object.assign({}, body.booking);
  const date = toStr(b.date);
  const timeFrom = toStr(b.timeFrom);
  const timeTo = toStr(b.timeTo);
  const toIso = (baseDate, baseTime, explicitIso) => {
    const iso = toStr(explicitIso);
    if (iso) return iso;
    if (!baseDate || !baseTime) return null;
    const normalizedTime = /^\d{2}:\d{2}$/.test(baseTime) ? `${baseTime}:00` : baseTime;
    return `${baseDate}T${normalizedTime}+03:00`;
  };
  const startIso = toIso(date, timeFrom, b.timeFromIso);
  const endIso = toIso(date, timeTo, b.timeToIso);

  b.timeFromIso = startIso;
  b.timeToIso = endIso;
  b.startTs = startIso ? Date.parse(startIso) : b.startTs;
  b.endTs = endIso ? Date.parse(endIso) : b.endTs;

  setDoc.booking = b;
  responsePatch.booking = b;
}

const normalizePlayer = (p, fallbackSource) => {
  if (!isObj(p)) return null;
  const player = {
    id: toStr(p.id || p.clientId || p.userId || p.uuid),
    name: toStr(p.name || p.fullName || [p.firstName, p.lastName].filter(Boolean).join(" ")) || "Игрок",
    phone: normPhone(p.phone || p.phoneNumber || p.mobile),
    photo: toStr(p.photo || p.avatar || p.imageUrl),
    rating: toStr(p.rating || p.level || p.grade),
    ratingNumeric: toNum(p.ratingNumeric || p.numericRating || p.levelNumeric),
    source: toStr(p.source || fallbackSource || "INVITED"),
    status: toStr(p.status || "CONFIRMED"),
  };
  const membershipId = toStr(p.membershipId || p.membership_id);
  if (membershipId) player.membershipId = membershipId;
  return player;
};

if (Array.isArray(body.participants)) {
  const participants = body.participants.map((p) => normalizePlayer(p, "INVITED")).filter(Boolean);
  setDoc.participants = participants;
  responsePatch.participants = participants;
}
if (Array.isArray(body.waitlist)) {
  const waitlist = body.waitlist.map((p) => normalizePlayer(p, "WAITLIST")).filter(Boolean);
  setDoc.waitlist = waitlist;
  responsePatch.waitlist = waitlist;
}

const shouldRecalcPhones = organizerTouched
  || Array.isArray(body.participants)
  || Array.isArray(body.waitlist)
  || Array.isArray(body.invitedPhones)
  || Array.isArray(body.invites);

if (shouldRecalcPhones) {
  const metadataOrganizerPhone = isObj(body.metadata)
    ? normPhone(body.metadata.organizerPhone || body.metadata.organizerPhoneNorm)
    : null;
  const organizerPhone = organizerPhoneForRecalc || metadataOrganizerPhone;
  const participants = asArray(setDoc.participants || body.participants);
  const waitlist = asArray(setDoc.waitlist || body.waitlist);
  const participantPhones = uniq(participants.map((p) => normPhone(p.phone)));
  const waitlistPhones = uniq(waitlist.map((p) => normPhone(p.phone)));
  const invitedPhones = uniq([
    ...asArray(body.invitedPhones).map((v) => normPhone(v)),
    ...asArray(body.invites).map((it) => normPhone(isObj(it) ? (it.phone || it.phoneNumber) : it)),
  ]);

  setDoc.participantPhones = participantPhones;
  setDoc.waitlistPhones = waitlistPhones;
  setDoc.invitedPhones = invitedPhones;
  responsePatch.participantPhones = participantPhones;
  responsePatch.waitlistPhones = waitlistPhones;
  responsePatch.invitedPhones = invitedPhones;
  setDoc.allRelatedPhones = uniq([
    organizerPhone,
    ...asArray(isObj(body.metadata) ? body.metadata.allRelatedPhones : null).map((p) => normPhone(p)),
    ...participantPhones,
    ...waitlistPhones,
    ...invitedPhones,
  ]);
  responsePatch.allRelatedPhones = setDoc.allRelatedPhones;
}

const snapshotSeed = isObj(body.resultRosterSnapshot)
  ? body.resultRosterSnapshot
  : (isObj(body.metadata?.resultRosterSnapshot) ? body.metadata.resultRosterSnapshot : null);
const shouldRebuildResultRosterSnapshot = organizerTouched
  || Array.isArray(body.participants)
  || Array.isArray(body.waitlist)
  || isObj(body.booking)
  || hasRosterSnapshotMetadata(setDoc.metadata || body.metadata)
  || isObj(snapshotSeed);

if (shouldRebuildResultRosterSnapshot) {
  setDoc.resultRosterSnapshot = buildResultRosterSnapshot({
    organizer: organizerTouched ? (responsePatch.organizer || body.organizer) : (body.organizer || snapshotSeed?.organizer || null),
    participants: Array.isArray(setDoc.participants) ? setDoc.participants : (Array.isArray(body.participants) ? body.participants : snapshotSeed?.activeRoster),
    waitlist: Array.isArray(setDoc.waitlist) ? setDoc.waitlist : (Array.isArray(body.waitlist) ? body.waitlist : snapshotSeed?.waitlist),
    metadata: isObj(setDoc.metadata) ? setDoc.metadata : (isObj(body.metadata) ? body.metadata : {}),
    booking: isObj(setDoc.booking) ? setDoc.booking : (isObj(body.booking) ? body.booking : {}),
    invite: isObj(setDoc.invite) ? setDoc.invite : (isObj(body.invite) ? body.invite : {}),
    nowIso,
    source: "games_patch",
    seedSnapshot: snapshotSeed,
  });
}

if (ignoredClientCancelPatch && !hasOwn(setDoc, "metadata")) {
  setDoc["metadata.lastIgnoredClientCancelPatchAt"] = nowIso;
  setDoc["metadata.lastIgnoredClientCancelPatchReason"] = "GENERIC_PATCH_CANCEL_GUARD";
}

setDoc.updatedAt = nowIso;
responsePatch.updatedAt = nowIso;

if (Object.keys(setDoc).length === 1 && setDoc.updatedAt) {
  msg.statusCode = 400;
  msg.headers = { "Content-Type": "application/json; charset=utf-8" };
  msg.payload = { error: "Empty patch" };
  return [null, msg, msg];
}

const patchKeys = Object.keys(body).sort();
const setKeys = Object.keys(setDoc)
  .filter((key) => key !== "updatedAt")
  .sort();
const auditEvent = buildAuditEvent(nowIso, {
  requestPath: reqPathRaw || null,
  gameId,
  patchKeys,
  setKeys,
  status: hasOwn(body, "status") ? toStr(body.status) : null,
  ignoredClientCancelPatch,
  sanitizedCancellationMetadata,
  archived: hasOwn(body, "archived") ? Boolean(body.archived) : null,
  participantsCount: Array.isArray(body.participants) ? body.participants.length : null,
  waitlistCount: Array.isArray(body.waitlist) ? body.waitlist.length : null,
  resultRosterSnapshotRebuilt: shouldRebuildResultRosterSnapshot,
  resultRosterSnapshotPlayers: Array.isArray(setDoc.resultRosterSnapshot?.allPlayers)
    ? setDoc.resultRosterSnapshot.allPlayers.length
    : null,
});

const dbMsg = Object.assign({}, msg, {
  query: { id: gameId, archived: { $ne: true } },
  payload: {
    $set: {
      ...setDoc,
      "audit.version": 1,
      "audit.updatedAt": nowIso,
      "audit.lastEvent": auditEvent,
    },
    $push: {
      "audit.events": {
        $each: [auditEvent],
        $slice: -AUDIT_MAX_EVENTS,
      },
    },
  },
});

const responseMsg = Object.assign({}, msg, {
  statusCode: 200,
  headers: { "Content-Type": "application/json; charset=utf-8" },
  payload: Object.assign({ id: gameId }, responsePatch),
});

const autojoinProbeMsg = Object.assign({}, msg, {
  _gameAutojoinPatch: {
    gameId,
    patch: responsePatch,
    source: "games_patch",
  },
  payload: { id: gameId, archived: { $ne: true } },
});

return [dbMsg, responseMsg, responseMsg, autojoinProbeMsg];
