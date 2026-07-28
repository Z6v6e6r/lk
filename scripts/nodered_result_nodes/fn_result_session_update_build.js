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

const sanitizeSnapshot = (snapshot) => {
  const lookup = buildLookup(snapshot);
  const resolveKey = (memberKey) => {
    if (!memberKey) return null;
    return sanitizeMember(lookup.byMemberKey.get(memberKey) || null);
  };
  return {
    version: "result-roster-snapshot-v3",
    schemaVersion: 3,
    capturedAt: snapshot?.capturedAt || null,
    capturedAtTs: Number(snapshot?.capturedAtTs || 0) || null,
    booking: snapshot?.booking || null,
    members: asArray(snapshot?.members).map((item) => sanitizeMember(item)).filter(Boolean),
    playerPool: asArray(snapshot?.members).map((item) => sanitizeMember(item)).filter(Boolean),
    allowedMemberKeys: asArray(snapshot?.allowedMemberKeys).map((item) => {
      const key = toStr(item);
      return key ? buildPublicMemberKey(key) : null;
    }).filter(Boolean),
    participantMemberKeys: asArray(snapshot?.participantMemberKeys).map((item) => {
      const key = toStr(item);
      return key ? buildPublicMemberKey(key) : null;
    }).filter(Boolean),
    waitlistMemberKeys: asArray(snapshot?.waitlistMemberKeys).map((item) => {
      const key = toStr(item);
      return key ? buildPublicMemberKey(key) : null;
    }).filter(Boolean),
    initialTeamMemberKeys: asArray(snapshot?.initialTeamMemberKeys).map((item) => {
      const key = toStr(item);
      return key ? buildPublicMemberKey(key) : null;
    }).filter(Boolean),
    initialTeamSlots: Array.from({ length: 4 }, (_, index) => resolveKey(asArray(snapshot?.initialTeamMemberKeys)[index])),
  };
};

const normalizeDraftPairings = (pairings, snapshot) => asArray(pairings)
  .map((item, rawIndex) => {
    if (!item || typeof item !== "object") return null;
    const setIndex = Number.isInteger(Number(item.setIndex))
      ? Number(item.setIndex)
      : Number.isInteger(Number(item.setNumber))
        ? Number(item.setNumber) - 1
        : rawIndex;
    if (setIndex < 0) return null;
    const rawSlots = asArray(item.teamSlots || item.slots || item.players || item.pairing);
    return {
      setIndex,
      teamSlots: Array.from({ length: 4 }, (_, index) => sanitizeMember(resolveMember(snapshot, rawSlots[index]))),
    };
  })
  .filter(Boolean);

const resolveActorMember = (snapshot, actor, fallbackPhone) => {
  const lookup = buildLookup(snapshot);
  const actorId = toStr(actor?.id);
  const actorPhone = normPhone(actor?.phoneNorm || actor?.phone || fallbackPhone);
  if (actorId && lookup.byId.has(actorId)) return lookup.byId.get(actorId);
  if (actorPhone && lookup.byPhone.has(actorPhone)) return lookup.byPhone.get(actorPhone);
  return null;
};

const rows = asArray(msg.payload);
if (rows.length === 0) {
  msg.statusCode = 404;
  msg.headers = { "Content-Type": "application/json; charset=utf-8" };
  msg.payload = { error: "Result session not found" };
  return [null, msg, msg];
}

const session = rows[0] || {};
const ctx = msg._resultSessionPatch || {};
const resultRosterSnapshot = session?.resultRosterSnapshot && typeof session.resultRosterSnapshot === "object"
  ? session.resultRosterSnapshot
  : session?.rosterSnapshot && typeof session.rosterSnapshot === "object"
    ? session.rosterSnapshot
    : null;
const actorMember = resolveActorMember(resultRosterSnapshot, ctx.actor, ctx.phone);

if (!resultRosterSnapshot || !actorMember) {
  msg.statusCode = 403;
  msg.headers = { "Content-Type": "application/json; charset=utf-8" };
  msg.payload = { error: "Only roster member can update result session" };
  return [null, msg, msg];
}

const allowedMemberKeys = uniq([
  ...asArray(resultRosterSnapshot.allowedMemberKeys).map(toStr),
  ...asArray(resultRosterSnapshot.members).map((item) => buildMember(item, "Игрок", item?.bucket || "participant")?.memberKey),
]);
if (!allowedMemberKeys.includes(actorMember.memberKey)) {
  msg.statusCode = 403;
  msg.headers = { "Content-Type": "application/json; charset=utf-8" };
  msg.payload = { error: "Only roster member can update result session" };
  return [null, msg, msg];
}

const currentRevision = Number.isInteger(Number(session?.revision)) ? Number(session.revision) : 1;
if (Number.isInteger(ctx.expectedRevision) && ctx.expectedRevision !== currentRevision) {
  msg.statusCode = 409;
  msg.headers = { "Content-Type": "application/json; charset=utf-8" };
  msg.payload = {
    error: "Result session revision conflict",
    sessionId: session.id || session._id || ctx.sessionId,
    revision: currentRevision,
  };
  return [null, msg, msg];
}

const now = new Date();
const nowIso = now.toISOString();
const nowTs = now.getTime();
const nextRevision = currentRevision + 1;
const draftSets = ctx.hasDraftSets ? asArray(ctx.draftSets) : asArray(session?.draftSets);
const draftPairings = ctx.hasDraftPairings
  ? normalizeDraftPairings(ctx.draftPairings, resultRosterSnapshot)
  : normalizeDraftPairings(session?.draftPairings, resultRosterSnapshot);
const attachments = ctx.hasAttachments ? asArray(ctx.attachments) : asArray(session?.attachments);
const lastTouchedBy = sanitizeMember(actorMember);

const responsePayload = {
  gameId: session.gameId || ctx.gameId,
  sessionId: session.id || session._id || ctx.sessionId,
  status: "ACTIVE",
  revision: nextRevision,
  resultRosterSnapshot: sanitizeSnapshot(resultRosterSnapshot),
  rosterSnapshot: sanitizeSnapshot(resultRosterSnapshot),
  draftSets,
  draftPairings,
  attachments,
  openedBy: sanitizeActor(session.openedBy) || sanitizeMember(actorMember),
  lastTouchedBy,
  lastTouchedAt: nowIso,
  lastTouchedAtTs: nowTs,
};

const writeMsg = Object.assign({}, msg, {
  _resultSessionResponse: responsePayload,
  _resultSessionExpectedRevision: currentRevision,
  payload: [
    { _id: responsePayload.sessionId, revision: currentRevision },
    {
      $set: {
        status: "ACTIVE",
        revision: nextRevision,
        draftSets,
        draftPairings,
        attachments,
        lastTouchedBy,
        lastTouchedAt: nowIso,
        lastTouchedAtTs: nowTs,
        updatedAt: nowIso,
        updatedTs: nowTs,
        resultRosterSnapshot,
        rosterSnapshot: sanitizeSnapshot(resultRosterSnapshot),
      },
    },
    { upsert: false },
  ],
});
return [writeMsg, null, null];
