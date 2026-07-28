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
const asArray = (v) => (Array.isArray(v) ? v : []);
const uniq = (arr) => Array.from(new Set(arr.filter(Boolean)));
const toNum = (v) => {
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
};
const toNumericOrNull = (value) => {
  if (value === null || value === undefined) return null;
  if (typeof value === "string" && !value.trim()) return null;
  const numeric = Number(value);
  return Number.isFinite(numeric) ? numeric : null;
};

const buildMember = (value, fallbackName, bucket) => {
  if (!value || typeof value !== "object") return null;
  const explicitMemberKey = toStr(value.memberKey);
  const id = toStr(value.id || value.clientId || value.uuid || value.userId || value.playerId);
  const phoneNorm = normPhone(value.phoneNorm || value.phone || value.phoneNumber || value.mobile);
  const name = toStr(value.name || value.fullName || value.title || value.displayName) || fallbackName;
  const memberKey = explicitMemberKey || (
    id
      ? `id:${id}`
      : phoneNorm
        ? `phone:${phoneNorm}`
        : null
  );
  if (!memberKey) return null;
  return {
    memberKey,
    id,
    phoneNorm,
    name: name || "Игрок",
    bucket: toStr(value.bucket || value.source || bucket) || bucket || "participant",
    rating: value.rating ?? null,
    ratingNumeric: toNumericOrNull(value.ratingNumeric),
  };
};

const buildGameSnapshot = (game, nowIso, nowTs) => {
  const members = [];
  const seen = new Set();
  const push = (value, index, bucket) => {
    const member = buildMember(value, `Игрок ${index + 1}`, bucket);
    if (!member) return;
    const sameId = member.id ? members.find((item) => item.id === member.id) : null;
    const samePhone = member.phoneNorm ? members.find((item) => item.phoneNorm === member.phoneNorm) : null;
    const existing = sameId || samePhone || (seen.has(member.memberKey)
      ? members.find((item) => item.memberKey === member.memberKey)
      : null);
    if (existing) {
      if ((existing.id && member.id && existing.id !== member.id)
        || (existing.phoneNorm && member.phoneNorm && existing.phoneNorm !== member.phoneNorm)) {
        return;
      }
      existing.id = existing.id || member.id;
      existing.phoneNorm = existing.phoneNorm || member.phoneNorm;
      existing.name = existing.name || member.name;
      existing.rating = existing.rating ?? member.rating;
      existing.ratingNumeric = existing.ratingNumeric ?? member.ratingNumeric;
      if (existing.bucket === "waitlist" && member.bucket !== "waitlist") existing.bucket = member.bucket;
      return;
    }
    seen.add(member.memberKey);
    members.push(member);
  };

  const storedSnapshot = game?.resultRosterSnapshot && typeof game.resultRosterSnapshot === "object"
    ? game.resultRosterSnapshot
    : null;
  const storedMembers = asArray(storedSnapshot?.members).length > 0
    ? storedSnapshot.members
    : storedSnapshot?.playerPool;
  asArray(storedMembers)
    .forEach((item, index) => push(item, index, item?.bucket || "participant"));
  asArray(game?.participants).forEach((item, index) => push(item, members.length + index, "participant"));
  asArray(game?.waitlist).forEach((item, index) => push(item, members.length + index, "waitlist"));

  if (members.length === 0) {
    const organizer = buildMember(game?.organizer || game?.createdBy, "Организатор", "participant");
    if (organizer) members.push(organizer);
  }

  const resolveStoredMemberKey = (value) => {
    if (value === null || value === undefined) return null;
    const raw = typeof value === "string" || typeof value === "number"
      ? toStr(value)
      : null;
    const candidate = typeof value === "object"
      ? buildMember(value, "Игрок", value?.bucket || "participant")
      : null;
    const candidateId = toStr(candidate?.id);
    const candidatePhone = normPhone(candidate?.phoneNorm);
    const candidateKey = toStr(candidate?.memberKey || raw);
    const matched = members.find((member) => (
      (candidateKey && member.memberKey === candidateKey)
      || (candidateId && member.id === candidateId)
      || (candidatePhone && member.phoneNorm === candidatePhone)
      || (raw && (member.id === raw || member.phoneNorm === normPhone(raw)))
    ));
    return matched?.memberKey || null;
  };
  const resolveStoredKeys = (values) => uniq(asArray(values).map(resolveStoredMemberKey).filter(Boolean));
  const participantMemberKeys = uniq([
    ...resolveStoredKeys(storedSnapshot?.participantMemberKeys),
    ...members.filter((item) => item.bucket !== "waitlist").map((item) => item.memberKey),
  ]);
  const waitlistMemberKeys = uniq([
    ...resolveStoredKeys(storedSnapshot?.waitlistMemberKeys),
    ...members.filter((item) => item.bucket === "waitlist").map((item) => item.memberKey),
  ]);
  const storedInitialTeam = asArray(storedSnapshot?.initialTeamMemberKeys).length > 0
    ? storedSnapshot.initialTeamMemberKeys
    : asArray(storedSnapshot?.initialTeamSlots);
  const legacyInitialTeam = Array.isArray(game?.metadata?.teamSlots)
    ? game.metadata.teamSlots
    : Array.isArray(game?.teamSlots)
      ? game.teamSlots
      : [];
  const initialTeamMemberKeys = resolveStoredKeys(
    storedInitialTeam.length > 0 ? storedInitialTeam : legacyInitialTeam,
  ).slice(0, 4);

  return {
    version: "result-roster-snapshot-v3",
    schemaVersion: 3,
    capturedAt: nowIso,
    capturedAtTs: nowTs,
    booking: {
      date: toStr(game?.booking?.date || game?.date),
      timeFrom: toStr(game?.booking?.timeFrom || game?.timeFrom),
      timeTo: toStr(game?.booking?.timeTo || game?.timeTo),
      vivaExerciseId: toStr(game?.booking?.vivaExerciseId || game?.vivaExerciseId),
    },
    members,
    allowedMemberKeys: members.map((item) => item.memberKey),
    participantMemberKeys,
    waitlistMemberKeys,
    initialTeamMemberKeys: initialTeamMemberKeys.length === 4
      ? initialTeamMemberKeys
      : members.slice(0, 4).map((item) => item.memberKey),
  };
};

const buildPublicMemberKey = (internalMemberKey) => {
  const source = toStr(internalMemberKey) || "member";
  if (/^rm_[a-z0-9]+$/i.test(source)) return source;
  let hash = 2166136261;
  for (let index = 0; index < source.length; index += 1) {
    hash ^= source.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return `rm_${(hash >>> 0).toString(36)}`;
};

const buildLookup = (snapshot) => {
  const byMemberKey = new Map();
  const byPublicMemberKey = new Map();
  const byId = new Map();
  const byPhone = new Map();
  asArray(snapshot?.members).forEach((value) => {
    const member = buildMember(value, "Игрок", value?.bucket || "participant");
    if (!member) return;
    byMemberKey.set(member.memberKey, member);
    byPublicMemberKey.set(buildPublicMemberKey(member.memberKey), member);
    if (member.id) byId.set(member.id, member);
    if (member.phoneNorm) byPhone.set(member.phoneNorm, member);
  });
  return { byMemberKey, byPublicMemberKey, byId, byPhone };
};

const resolveMember = (snapshot, ref) => {
  const lookup = buildLookup(snapshot);
  if (typeof ref === "string" || typeof ref === "number") {
    const raw = toStr(ref);
    if (!raw) return null;
    return lookup.byMemberKey.get(raw)
      || lookup.byPublicMemberKey.get(raw)
      || lookup.byId.get(raw)
      || lookup.byPhone.get(normPhone(raw))
      || null;
  }
  const explicitMemberKey = toStr(ref?.memberKey || ref?.playerKey || ref?.participantKey || ref?.rosterMemberKey);
  if (explicitMemberKey) {
    const resolvedByKey = lookup.byMemberKey.get(explicitMemberKey) || lookup.byPublicMemberKey.get(explicitMemberKey);
    if (resolvedByKey) return resolvedByKey;
  }
  const member = buildMember(ref, "Игрок", ref?.bucket || "participant");
  if (!member) return null;
  return lookup.byMemberKey.get(member.memberKey)
    || lookup.byPublicMemberKey.get(buildPublicMemberKey(member.memberKey))
    || (member.id ? lookup.byId.get(member.id) : null)
    || (member.phoneNorm ? lookup.byPhone.get(member.phoneNorm) : null)
    || null;
};

const migrateSnapshot = (rawSnapshot, fallbackSnapshot) => {
  const base = rawSnapshot && typeof rawSnapshot === "object" ? rawSnapshot : {};
  const nowIso = toStr(base.capturedAt) || fallbackSnapshot.capturedAt;
  const nowTs = toNum(base.capturedAtTs) || fallbackSnapshot.capturedAtTs;
  const members = [];
  const seen = new Set();
  const push = (value, index, bucket) => {
    const member = buildMember(value, `Игрок ${index + 1}`, bucket);
    if (!member) return;
    const sameId = member.id ? members.find((item) => item.id === member.id) : null;
    const samePhone = member.phoneNorm ? members.find((item) => item.phoneNorm === member.phoneNorm) : null;
    const existing = sameId || samePhone || (seen.has(member.memberKey)
      ? members.find((item) => item.memberKey === member.memberKey)
      : null);
    if (existing) {
      if ((existing.id && member.id && existing.id !== member.id)
        || (existing.phoneNorm && member.phoneNorm && existing.phoneNorm !== member.phoneNorm)) {
        return;
      }
      existing.id = existing.id || member.id;
      existing.phoneNorm = existing.phoneNorm || member.phoneNorm;
      existing.name = existing.name || member.name;
      existing.rating = existing.rating ?? member.rating;
      existing.ratingNumeric = existing.ratingNumeric ?? member.ratingNumeric;
      if (existing.bucket === "waitlist" && member.bucket !== "waitlist") existing.bucket = member.bucket;
      return;
    }
    seen.add(member.memberKey);
    members.push(member);
  };

  asArray(base.members).forEach((item, index) => push(item, index, item?.bucket || "participant"));
  asArray(base.playerPool).forEach((item, index) => push(item, members.length + index, item?.bucket || "participant"));
  fallbackSnapshot.members.forEach((item, index) => push(item, index, item?.bucket || "participant"));

  const lookup = buildLookup({ members });
  const rawInitialKeys = asArray(base.initialTeamMemberKeys);
  const rawInitialSlots = rawInitialKeys.length > 0 ? rawInitialKeys : asArray(base.initialTeamSlots);
  const initialTeamMemberKeys = Array.from({ length: 4 }, (_, index) => {
    const resolved = resolveMember({ members }, rawInitialSlots[index]);
    return resolved ? resolved.memberKey : null;
  }).filter(Boolean);

  const participantMemberKeys = uniq([
    ...asArray(base.participantMemberKeys).map(toStr),
    ...members.filter((item) => item.bucket !== "waitlist").map((item) => item.memberKey),
  ]);
  const waitlistMemberKeys = uniq([
    ...asArray(base.waitlistMemberKeys).map(toStr),
    ...members.filter((item) => item.bucket === "waitlist").map((item) => item.memberKey),
  ]);
  const allowedMemberKeys = uniq([
    ...asArray(base.allowedMemberKeys).map(toStr),
    ...members.map((item) => item.memberKey),
  ]);

  return {
    version: "result-roster-snapshot-v3",
    schemaVersion: 3,
    capturedAt: nowIso,
    capturedAtTs: nowTs,
    booking: {
      date: toStr(base?.booking?.date) || fallbackSnapshot.booking.date,
      timeFrom: toStr(base?.booking?.timeFrom) || fallbackSnapshot.booking.timeFrom,
      timeTo: toStr(base?.booking?.timeTo) || fallbackSnapshot.booking.timeTo,
      vivaExerciseId: toStr(base?.booking?.vivaExerciseId) || fallbackSnapshot.booking.vivaExerciseId,
    },
    members,
    allowedMemberKeys: allowedMemberKeys.length > 0 ? allowedMemberKeys : members.map((item) => item.memberKey),
    participantMemberKeys,
    waitlistMemberKeys,
    initialTeamMemberKeys: initialTeamMemberKeys.length > 0
      ? initialTeamMemberKeys
      : fallbackSnapshot.initialTeamMemberKeys,
  };
};

const sanitizeMember = (member) => {
  const normalized = buildMember(member, "Игрок", member?.bucket || "participant");
  if (!normalized) return null;
  return {
    memberKey: buildPublicMemberKey(normalized.memberKey),
    name: normalized.name,
    bucket: normalized.bucket,
    rating: normalized.rating ?? null,
    ratingNumeric: normalized.ratingNumeric ?? null,
  };
};

const sanitizeActor = (value) => {
  if (!value || typeof value !== "object") return null;
  return {
    memberKey: toStr(value.memberKey) ? buildPublicMemberKey(value.memberKey) : null,
    name: toStr(value.name) || "Игрок",
  };
};

const buildSlotRef = (snapshot, value) => {
  const member = resolveMember(snapshot, value);
  return member ? sanitizeMember(member) : null;
};

const normalizeDraftPairings = (pairings, snapshot) => asArray(pairings)
  .map((item, rawIndex) => {
    if (!item || typeof item !== "object") return null;
    const setIndex = Number.isInteger(Number(item.setIndex))
      ? Number(item.setIndex)
      : Number.isInteger(Number(item.setNumber))
        ? Number(item.setNumber) - 1
        : rawIndex;
    const rawSlots = asArray(item.teamSlots || item.slots || item.players || item.pairing);
    const teamSlots = Array.from({ length: 4 }, (_, index) => buildSlotRef(snapshot, rawSlots[index]));
    return setIndex >= 0 ? { setIndex, teamSlots } : null;
  })
  .filter(Boolean);

const sanitizeSnapshot = (snapshot) => {
  const lookup = buildLookup(snapshot);
  const resolveKey = (memberKey) => {
    if (!memberKey) return null;
    return sanitizeMember(lookup.byMemberKey.get(memberKey) || null);
  };
  return {
    version: "result-roster-snapshot-v3",
    schemaVersion: 3,
    capturedAt: snapshot.capturedAt || null,
    capturedAtTs: Number(snapshot.capturedAtTs || 0) || null,
    booking: snapshot.booking || null,
    members: asArray(snapshot.members).map((item) => sanitizeMember(item)).filter(Boolean),
    playerPool: asArray(snapshot.members).map((item) => sanitizeMember(item)).filter(Boolean),
    allowedMemberKeys: asArray(snapshot.allowedMemberKeys).map((item) => {
      const key = toStr(item);
      return key ? buildPublicMemberKey(key) : null;
    }).filter(Boolean),
    participantMemberKeys: asArray(snapshot.participantMemberKeys).map((item) => {
      const key = toStr(item);
      return key ? buildPublicMemberKey(key) : null;
    }).filter(Boolean),
    waitlistMemberKeys: asArray(snapshot.waitlistMemberKeys).map((item) => {
      const key = toStr(item);
      return key ? buildPublicMemberKey(key) : null;
    }).filter(Boolean),
    initialTeamMemberKeys: asArray(snapshot.initialTeamMemberKeys).map((item) => {
      const key = toStr(item);
      return key ? buildPublicMemberKey(key) : null;
    }).filter(Boolean),
    initialTeamSlots: Array.from({ length: 4 }, (_, index) => resolveKey(asArray(snapshot.initialTeamMemberKeys)[index])),
  };
};

const rows = asArray(msg.payload);
const existing = rows.find((item) => item && typeof item === "object" && item.deleted !== true) || null;
const ctx = msg._resultSessionOpen || {};
const game = ctx.game || {};
const now = new Date();
const nowIso = now.toISOString();
const nowTs = now.getTime();
const baseSnapshot = buildGameSnapshot(game, nowIso, nowTs);
const resultRosterSnapshot = migrateSnapshot(existing?.resultRosterSnapshot || existing?.rosterSnapshot, baseSnapshot);
const lookup = buildLookup(resultRosterSnapshot);
const actorMemberKey = toStr(ctx.actorMemberKey)
  || (() => {
    const actorId = toStr(ctx.actor?.id);
    const actorPhone = normPhone(ctx.actor?.phoneNorm || ctx.phone);
    if (actorId && lookup.byId.has(actorId)) return lookup.byId.get(actorId).memberKey;
    if (actorPhone && lookup.byPhone.has(actorPhone)) return lookup.byPhone.get(actorPhone).memberKey;
    return null;
  })();
const actorMember = actorMemberKey ? lookup.byMemberKey.get(actorMemberKey) || null : null;

if (!actorMember) {
  msg.statusCode = 403;
  msg.headers = { "Content-Type": "application/json; charset=utf-8" };
  msg.payload = { error: "Only roster member can open result session" };
  return [null, msg, msg];
}

const sessionId = ctx.sessionId || toStr(existing?.id || existing?._id) || `result_session_${ctx.gameId}`;
const revision = Number.isInteger(Number(existing?.revision)) ? Number(existing.revision) : 1;
const draftSets = asArray(existing?.draftSets);
const draftPairings = normalizeDraftPairings(
  asArray(existing?.draftPairings).length > 0
    ? existing.draftPairings
    : [
      {
        setIndex: 0,
        teamSlots: resultRosterSnapshot.initialTeamMemberKeys,
      },
    ],
  resultRosterSnapshot,
);
const attachments = asArray(existing?.attachments);
const openedBy = sanitizeActor(existing?.openedBy) || sanitizeMember(actorMember);
const lastTouchedBy = sanitizeMember(actorMember);

const responsePayload = {
  gameId: ctx.gameId,
  sessionId,
  status: "ACTIVE",
  revision,
  isRestored: Boolean(existing),
  resultRosterSnapshot: sanitizeSnapshot(resultRosterSnapshot),
  rosterSnapshot: sanitizeSnapshot(resultRosterSnapshot),
  draftSets,
  draftPairings,
  attachments,
  openedBy,
  lastTouchedBy,
  lastTouchedAt: nowIso,
  lastTouchedAtTs: nowTs,
};

const insertDoc = {
  _id: sessionId,
  id: sessionId,
  gameId: ctx.gameId,
  revision,
  draftSets,
  draftPairings,
  attachments,
  openedBy,
  createdAt: existing?.createdAt || nowIso,
  createdTs: Number(existing?.createdTs || nowTs),
  deleted: false,
};

const update = existing
  ? {
    $set: {
      status: "ACTIVE",
      resultRosterSnapshot,
      rosterSnapshot: sanitizeSnapshot(resultRosterSnapshot),
      updatedAt: nowIso,
      updatedTs: nowTs,
      lastTouchedAt: nowIso,
      lastTouchedAtTs: nowTs,
      lastTouchedBy,
    },
  }
  : {
    $setOnInsert: insertDoc,
    $set: {
      status: "ACTIVE",
      resultRosterSnapshot,
      rosterSnapshot: sanitizeSnapshot(resultRosterSnapshot),
      updatedAt: nowIso,
      updatedTs: nowTs,
      lastTouchedAt: nowIso,
      lastTouchedAtTs: nowTs,
      lastTouchedBy,
    },
  };

const writeMsg = Object.assign({}, msg, {
  _resultSessionResponse: responsePayload,
  payload: [
    { _id: sessionId },
    update,
    { upsert: true },
  ],
});
return [writeMsg, null, null];
