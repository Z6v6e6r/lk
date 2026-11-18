// Diagnostic observer: optional, no-throw; sourceHash is the uninstrumented business preimage.
const lkDiagnostic = (fields = {}) => {
  try {
    if (typeof global === "undefined" || typeof global.get !== "function") return;
    const observer = global.get("lkDiagnostics");
    observer?.observe(msg, "patch", { sourceHash: "9c6aaf4578c69fa30daa2326506900a5ee0a265f2299f1f0e3ab20b11e01a130", ...fields });
  } catch { /* Observability cannot alter business execution. */ }
};
lkDiagnostic({ code: "STAGE_ENTER" });
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
// BEGIN PRIVATE GAME PROJECTION
function createGamePrivateProjection() {
const isObj = (value) => value && typeof value === "object" && !Array.isArray(value);
const phoneFieldPattern = /(?:^|[^a-z0-9])(?:phones?|mobiles?|telephones?|msisdn)(?:[^a-z0-9]|$)/i;
const isPhoneField = (key) => phoneFieldPattern.test(
  String(key || "").replace(/([a-z0-9])([A-Z])/g, "$1_$2"),
);
const phoneIdentityPattern = /^(phone|mobile|telephone|msisdn):/i;
const exactPhoneValuePattern = /^(?:\+?7|8)(?:[\s().-]*\d){10}$/;
const embeddedPhoneValuePattern = /(^|[^\d])((?:\+?7|8)(?:[\s().-]*\d){10})(?!\d)/g;
const phoneQueryValuePattern = /([?&][^=&#]*(?:phone|mobile|telephone|msisdn)[^=&#]*=)[^&#]*/gi;
// A canonical UUID can contain an 11-digit phone-shaped run across its hyphens.
// Preserve only complete UUID spans; phone fields/identities/query values still
// take precedence, and text surrounding each UUID remains subject to redaction.
const uuidSpanPattern = /((?<![0-9a-f])[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}(?![0-9a-f]))/gi;
const isPlainRecord = (value) => {
  if (!isObj(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  if (prototype === null) return true;
  const constructor = Object.prototype.hasOwnProperty.call(prototype, "constructor")
    ? prototype.constructor
    : null;
  // MongoDB results enter a Node-RED Function from a different VM realm, so
  // their Object.prototype is not reference-equal to the sandbox prototype.
  // Constructor identity by name still excludes Date, Buffer, BSON/ObjectId,
  // and other special instances that must keep their serialization behavior.
  return typeof constructor === "function" && constructor.name === "Object";
};

const redactPhoneString = (value) => {
  const trimmed = value.trim();
  if (phoneIdentityPattern.test(trimmed) || exactPhoneValuePattern.test(trimmed)) {
    return null;
  }
  return value
    .replace(phoneQueryValuePattern, "$1[redacted]")
    .split(uuidSpanPattern)
    .map((part, index) => index % 2 === 1
      ? part
      : part.replace(embeddedPhoneValuePattern, "$1[redacted]"))
    .join("");
};

const redactPhoneData = (value) => {
  if (Array.isArray(value)) {
    return value.map((item) => redactPhoneData(item));
  }
  if (isPlainRecord(value)) {
    const next = {};
    Object.entries(value).forEach(([key, item]) => {
      if (isPhoneField(key)) return;
      const redacted = redactPhoneData(item);
      if (redacted !== null || item === null) {
        next[key] = redacted;
      }
    });
    return next;
  }
  if (typeof value === "string") {
    return redactPhoneString(value);
  }
  if (
    typeof value === "number"
    && Number.isInteger(value)
    && exactPhoneValuePattern.test(String(value))
  ) {
    return null;
  }
  return value;
};


const own = (object, key) => Object.prototype.hasOwnProperty.call(object, key);
const clone = value => Array.isArray(value) ? value.map(clone)
  : isPlainRecord(value) ? Object.fromEntries(Object.entries(value).map(([key, item]) => [key, clone(item)])) : value;
const stable = value => {
  if (typeof value !== "string" || !value.trim()) return null;
  const text = value.trim();
  if (phoneIdentityPattern.test(text) || exactPhoneValuePattern.test(text)) return null;
  return /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i.test(text) ? text.toLowerCase() : text;
};
const bindingKeys = ["operationId", "paymentRef", "membershipId", "bookingId", "vivaBookingId", "memberKey", "id", "clientId", "playerId", "userId"];
const publicEqual = (left, right) => {
  if (left === right) return true;
  if (Array.isArray(left) && Array.isArray(right)) return left.length === right.length && left.every((item, i) => publicEqual(item, right[i]));
  if (!isPlainRecord(left) || !isPlainRecord(right)) return false;
  const keys = [...new Set([...Object.keys(left), ...Object.keys(right)])];
  return keys.every(key => publicEqual(left[key] ?? null, right[key] ?? null));
};
const bindingError = () => { throw Error("GAME_PATCH_PRIVATE_BINDING_UNKNOWN"); };
const actorKeys = ["id", "clientId", "playerId", "userId", "uuid"];
const values = (row, keys) => [...new Set(keys.map(key => stable(row?.[key])).filter(Boolean))];
const matchRow = (submitted, canonicalRows, roster) => {
  const groups = roster ? [actorKeys, ["memberKey", "playerKey"], ["membershipId", "membership_id"], ["bookingId", "vivaBookingId"]]
    : [["operationId"], ["paymentRef"], ["membershipId", "membership_id"], ["bookingId", "vivaBookingId"], ["memberKey"], ["id"], ["clientId", "playerId", "userId"]];
  if (roster && values(submitted, actorKeys).length > 1) return bindingError();
  for (const keys of groups) {
    const supplied = values(submitted, keys);
    if (!supplied.length || !canonicalRows.some(row => values(row, keys).length)) continue;
    if (supplied.length > 1) return bindingError();
    let matches = canonicalRows.filter(row => values(row, keys).includes(supplied[0]));
    if (!matches.length) return null; // New binding: never borrow another booking's private fields.
    if (roster && matches.some(row => values(row, actorKeys).length > 1)) return bindingError();
    matches = matches.filter(row => bindingKeys.every(other => !stable(submitted[other]) || !stable(row[other]) || stable(submitted[other]) === stable(row[other])));
    if (!matches.length) return bindingError();
    if (matches.length > 1) return bindingError();
    if (matches.length !== 1) return bindingError();
    return matches[0];
  }
  if (bindingKeys.some(key => stable(submitted[key]))) return null;
  // Legacy rows require an exact full public projection, never name-only or position matching.
  const matches = canonicalRows.filter(row => publicEqual(redactPhoneData(row), submitted));
  if (matches.length === 1) return matches[0];
  if (matches.length > 1 || canonicalRows.some(row => !publicEqual(redactPhoneData(row), row))) return bindingError();
  return null;
};
const restore = (submitted, canonical, depth = 0, roster = false) => {
  if (depth > 64) return bindingError();
  if (Array.isArray(submitted)) {
    const rows = Array.isArray(canonical) ? canonical : [];
    if (publicEqual(redactPhoneData(rows), rows)) return clone(submitted);
    return submitted.map(item => {
      if (!isPlainRecord(item)) {
        if (item === null && rows.some(row => row !== null && redactPhoneData(row) === null)) return bindingError();
        return clone(item);
      }
      const match = matchRow(item, rows.filter(isPlainRecord), roster);
      return match ? restore(item, match, depth + 1) : clone(item);
    });
  }
  if (!isPlainRecord(submitted) || !isPlainRecord(canonical)) {
    return publicEqual(submitted, redactPhoneData(canonical)) && !publicEqual(canonical, submitted) ? clone(canonical) : clone(submitted);
  }
  const result = { ...submitted };
  for (const [key, value] of Object.entries(canonical)) {
    const projected = isPhoneField(key) ? undefined : redactPhoneData(value);
    if ((!own(submitted, key) && (isPhoneField(key) || (projected === null && value !== null)))
      || (isPhoneField(key) && (submitted[key] === null || submitted[key] === ""))) result[key] = clone(value);
    else if (own(submitted, key)) result[key] = restore(submitted[key], value, depth + 1, ["participants", "waitlist", "players", "teamSlots", "allPlayers", "activeRoster", "playerPool"].includes(key));
  }
  return result;
};
return { project: redactPhoneData, restore, restoreRoster: (submitted, rows) => restore(submitted, rows, 0, true) };
}
// END PRIVATE GAME PROJECTION

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
// A public GET is a projection, not a replacement for canonical private identity fields.
const privateGame = msg._organizerGuardSnapshot?.privateGame;
if (isObj(privateGame)) {
  try {
    const projection = createGamePrivateProjection();
    const roster = [...asArray(privateGame.participants), ...asArray(privateGame.waitlist)];
    if (Array.isArray(body.participants)) body.participants = projection.restoreRoster(body.participants, roster);
    if (Array.isArray(body.waitlist)) body.waitlist = projection.restoreRoster(body.waitlist, roster);
    for (const key of ["metadata", "payment", "booking", "invite", "resultRosterSnapshot"]) {
      if (isObj(body[key])) body[key] = projection.restore(body[key], privateGame[key]);
    }
  } catch {
    msg.statusCode = 409;
    msg.headers = { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" };
    msg.payload = { code: "GAME_PATCH_PRIVATE_BINDING_UNKNOWN", error: "Не удалось однозначно сопоставить состав. Обновите игру." };
    return [null, msg, msg, null];
  }
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

let organizerPhoneForRecalc = normPhone(
  msg._organizerGuardSnapshot?.organizer?.phoneNorm || msg._organizerGuardSnapshot?.organizer?.phone,
);
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
    phone: normPhone(p.phone || p.phoneNorm || p.phoneNumber || p.mobile),
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
  const participants = asArray(setDoc.participants || body.participants || privateGame?.participants);
  const waitlist = asArray(setDoc.waitlist || body.waitlist || privateGame?.waitlist);
  const participantPhones = uniq(participants.map((p) => normPhone(p.phone || p.phoneNorm || p.phoneNumber || p.mobile)));
  const waitlistPhones = uniq(waitlist.map((p) => normPhone(p.phone || p.phoneNorm || p.phoneNumber || p.mobile)));
  const invitedPhones = uniq([
    ...asArray(body.invitedPhones).map((v) => normPhone(v)),
    ...asArray(body.invites).map((it) => normPhone(isObj(it) ? (it.phone || it.phoneNumber) : it)),
    ...(!hasOwn(body, "invitedPhones") && !hasOwn(body, "invites") ? asArray(privateGame?.invitedPhones).map(normPhone) : []),
  ]);

  setDoc.participantPhones = participantPhones;
  setDoc.waitlistPhones = waitlistPhones;
  setDoc.invitedPhones = invitedPhones;
  responsePatch.participantPhones = participantPhones;
  responsePatch.waitlistPhones = waitlistPhones;
  responsePatch.invitedPhones = invitedPhones;
  const splitPaymentPhones = asArray((setDoc.metadata ?? body.metadata ?? privateGame?.metadata)?.splitPayment?.payments)
    .filter((item) => !["CANCEL", "DECLIN", "FAIL", "ERROR", "EXPIRE", "REFUND", "REJECT", "VOID", "CLOSE", "ARCHIVE", "LEFT", "REMOV", "RELEASE"]
      .some((marker) => String(item?.status || "").toUpperCase().includes(marker)))
    .map((item) => normPhone(item?.phoneNorm || item?.clientPhoneNorm || item?.phone || item?.clientPhone));
  setDoc.allRelatedPhones = uniq([
    organizerPhone,
    ...splitPaymentPhones,
    ...participantPhones,
    ...waitlistPhones,
    ...invitedPhones,
  ]);
  responsePatch.allRelatedPhones = setDoc.allRelatedPhones;
  const phoneIndexes = { participantPhones, waitlistPhones, allRelatedPhones: setDoc.allRelatedPhones, invitedPhones };
  for (const [key, value] of Object.entries(phoneIndexes)) {
    if (isObj(setDoc.metadata) && (key !== "invitedPhones" || hasOwn(setDoc.metadata, key))) setDoc.metadata[key] = value;
    else if (!isObj(setDoc.metadata) && isObj(privateGame?.metadata) && hasOwn(privateGame.metadata, key)) setDoc[`metadata.${key}`] = value;
  }
}

const snapshotSeed = isObj(body.resultRosterSnapshot)
  ? body.resultRosterSnapshot
  : (isObj(body.metadata?.resultRosterSnapshot) ? body.metadata.resultRosterSnapshot : (isObj(privateGame?.resultRosterSnapshot) ? privateGame.resultRosterSnapshot : null));
const shouldRebuildResultRosterSnapshot = organizerTouched
  || Array.isArray(body.participants)
  || Array.isArray(body.waitlist)
  || isObj(body.booking)
  || hasRosterSnapshotMetadata(setDoc.metadata || body.metadata)
  || isObj(snapshotSeed);

if (shouldRebuildResultRosterSnapshot) {
  setDoc.resultRosterSnapshot = buildResultRosterSnapshot({
    organizer: organizerTouched ? (responsePatch.organizer || body.organizer) : (msg._organizerGuardSnapshot?.organizer || body.organizer || snapshotSeed?.organizer || null),
    participants: Array.isArray(setDoc.participants) ? setDoc.participants : (Array.isArray(body.participants) ? body.participants : (privateGame?.participants ?? snapshotSeed?.activeRoster)),
    waitlist: Array.isArray(setDoc.waitlist) ? setDoc.waitlist : (Array.isArray(body.waitlist) ? body.waitlist : (privateGame?.waitlist ?? snapshotSeed?.waitlist)),
    metadata: isObj(setDoc.metadata) ? setDoc.metadata : (isObj(body.metadata) ? body.metadata : (privateGame?.metadata ?? {})),
    booking: isObj(setDoc.booking) ? setDoc.booking : (isObj(body.booking) ? body.booking : (privateGame?.booking ?? {})),
    invite: isObj(setDoc.invite) ? setDoc.invite : (isObj(body.invite) ? body.invite : (privateGame?.invite ?? {})),
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
