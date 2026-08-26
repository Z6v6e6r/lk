const normPhone = (value) => {
  const digits = String(value || "").replace(/\D/g, "");
  if (!digits) return null;
  if (digits.length === 10) return `7${digits}`;
  if (digits.length === 11 && digits.startsWith("8")) return `7${digits.slice(1)}`;
  return digits;
};
const toStr = (value) => {
  if (value === null || value === undefined) return null;
  const text = String(value).trim();
  return text ? text : null;
};
const uniq = (value) => Array.from(new Set((Array.isArray(value) ? value : []).filter(Boolean)));
const asArray = (value) => (Array.isArray(value) ? value : []);

const toTs = (game) => {
  const endTs = Number(game?.booking?.endTs);
  if (Number.isFinite(endTs)) return endTs;
  const date = game?.booking?.date || game?.date || null;
  const timeTo = game?.booking?.timeTo || game?.timeTo || null;
  if (date && timeTo) {
    const ts = Date.parse(`${date}T${/^\d{2}:\d{2}$/.test(timeTo) ? `${timeTo}:00` : timeTo}+03:00`);
    if (Number.isFinite(ts)) return ts;
  }
  return null;
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
const toNumericOrNull = (value) => {
  if (value === null || value === undefined) return null;
  if (typeof value === "string" && !value.trim()) return null;
  const numeric = Number(value);
  return Number.isFinite(numeric) ? numeric : null;
};

const buildMemberIdentityKey = (member) => (
  toStr(member?.id)
    ? `id:${member.id}`
    : toStr(member?.phoneNorm)
      ? `phone:${member.phoneNorm}`
      : toStr(member?.memberKey)
);
const buildStableIdentityKey = (member) => (
  toStr(member?.id)
    ? `id:${member.id}`
    : toStr(member?.phoneNorm)
      ? `phone:${member.phoneNorm}`
      : null
);

const buildMember = (value, fallbackName, bucket) => {
  if (!value || typeof value !== "object") return null;
  const explicitMemberKey = toStr(value.memberKey || value.playerKey || value.participantKey || value.rosterMemberKey);
  const id = toStr(value.id || value.clientId || value.uuid || value.userId || value.playerId);
  const phoneNorm = normPhone(value.phoneNorm || value.phone || value.phoneNumber || value.mobile);
  const name = toStr(value.name || value.fullName || value.title || value.displayName) || fallbackName;
  const memberKey = explicitMemberKey
    || (id ? `id:${id}` : null)
    || (phoneNorm ? `phone:${phoneNorm}` : null);
  if (!memberKey) return null;
  return {
    memberKey,
    publicMemberKey: buildPublicMemberKey(memberKey),
    id,
    phoneNorm,
    name: name || "Игрок",
    bucket: toStr(value.bucket || value.source || bucket) || bucket || "participant",
    rating: value.rating ?? null,
    ratingNumeric: toNumericOrNull(value.ratingNumeric),
  };
};

const sanitizeMember = (member) => {
  const normalized = buildMember(member, "Игрок", member?.bucket || "participant");
  if (!normalized) return null;
  return {
    memberKey: normalized.publicMemberKey,
    name: normalized.name,
    bucket: normalized.bucket,
    rating: normalized.rating ?? null,
    ratingNumeric: normalized.ratingNumeric ?? null,
  };
};

const buildLookup = (snapshot) => {
  const byMemberKey = new Map();
  const byPublicMemberKey = new Map();
  const byId = new Map();
  const byPhone = new Map();
  asArray(snapshot?.members).forEach((item) => {
    const member = buildMember(item, "Игрок", item?.bucket || "participant");
    if (!member) return;
    byMemberKey.set(member.memberKey, member);
    byPublicMemberKey.set(member.publicMemberKey, member);
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
  if (!ref || typeof ref !== "object") return null;
  const explicitMemberKey = toStr(ref.memberKey || ref.playerKey || ref.participantKey || ref.rosterMemberKey);
  if (explicitMemberKey) {
    const byExplicit = lookup.byMemberKey.get(explicitMemberKey) || lookup.byPublicMemberKey.get(explicitMemberKey);
    if (byExplicit) return byExplicit;
  }
  const member = buildMember(ref, "Игрок", ref?.bucket || "participant");
  if (!member) return null;
  return lookup.byMemberKey.get(member.memberKey)
    || lookup.byPublicMemberKey.get(member.publicMemberKey)
    || (member.id ? lookup.byId.get(member.id) : null)
    || (member.phoneNorm ? lookup.byPhone.get(member.phoneNorm) : null)
    || null;
};

const extractLegacyInitialSlots = (game) => {
  const matchResult = game?.metadata?.matchResult && typeof game.metadata.matchResult === "object"
    ? game.metadata.matchResult
    : null;
  const firstPairing = asArray(matchResult?.setPairings || matchResult?.pairings)
    .filter((item) => item && typeof item === "object" && asArray(item.teamSlots || item.slots || item.players || item.pairing).some(Boolean))
    .sort((left, right) => Number(left?.setIndex || 0) - Number(right?.setIndex || 0))[0] || null;
  if (firstPairing) return asArray(firstPairing.teamSlots || firstPairing.slots || firstPairing.players || firstPairing.pairing);
  if (Array.isArray(game?.teamSlots)) return asArray(game.teamSlots);
  if (Array.isArray(game?.metadata?.teamSlots)) return asArray(game.metadata.teamSlots);
  return [];
};

const buildSnapshotFromGame = (game, ctx = {}) => {
  const nowIso = new Date().toISOString();
  const stored = game?.resultRosterSnapshot && typeof game.resultRosterSnapshot === "object"
    ? game.resultRosterSnapshot
    : null;
  const submittedSnapshot = ctx?.rosterSnapshot && typeof ctx.rosterSnapshot === "object"
    ? ctx.rosterSnapshot
    : null;
  const members = [];
  const seenMemberKeys = new Set();
  const identityConflicts = [];
  const push = (value, index, bucket) => {
    const member = buildMember(value, `Игрок ${index + 1}`, bucket);
    if (!member) return;
    const sameId = member.id ? members.find((item) => item.id === member.id) : null;
    const samePhone = member.phoneNorm ? members.find((item) => item.phoneNorm === member.phoneNorm) : null;
    if (sameId && samePhone && sameId !== samePhone) {
      identityConflicts.push({
        identityKey: `id:${member.id}`,
        existingMemberKey: sameId.memberKey,
        duplicateMemberKey: samePhone.memberKey,
      });
      return;
    }
    const existing = sameId || samePhone || (seenMemberKeys.has(member.memberKey)
      ? members.find((item) => item.memberKey === member.memberKey)
      : null);
    if (existing) {
      if (existing.id && member.id && existing.id !== member.id) {
        identityConflicts.push({
          identityKey: `phone:${member.phoneNorm}`,
          existingMemberKey: existing.memberKey,
          duplicateMemberKey: member.memberKey,
        });
        return;
      }
      if (existing.phoneNorm && member.phoneNorm && existing.phoneNorm !== member.phoneNorm) {
        identityConflicts.push({
          identityKey: `id:${member.id}`,
          existingMemberKey: existing.memberKey,
          duplicateMemberKey: member.memberKey,
        });
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
    seenMemberKeys.add(member.memberKey);
    members.push(member);
  };

  if (stored) {
    const storedMembers = asArray(stored.members).length > 0
      ? stored.members
      : (asArray(stored.playerPool).length > 0 ? stored.playerPool : stored.allPlayers);
    asArray(storedMembers).forEach((item, index) => push(item, index, item?.bucket || "participant"));
  }
  asArray(game?.participants).forEach((item, index) => push(item, index, "participant"));
  asArray(game?.waitlist).forEach((item, index) => push(item, members.length + index, "waitlist"));
  if (members.length === 0) {
    const organizer = buildMember(game?.organizer || game?.createdBy, "Организатор", "participant");
    if (organizer) members.push(organizer);
  }

  const snapshot = {
    version: "result-roster-snapshot-v3",
    schemaVersion: 3,
    capturedAt: toStr(stored?.capturedAt) || nowIso,
    members,
    participantMemberKeys: uniq([
      ...asArray(stored?.participantMemberKeys).map(toStr),
      ...members.filter((item) => item.bucket !== "waitlist").map((item) => item.memberKey),
    ]),
    waitlistMemberKeys: uniq([
      ...asArray(stored?.waitlistMemberKeys).map(toStr),
      ...members.filter((item) => item.bucket === "waitlist").map((item) => item.memberKey),
    ]),
  };

  const lookup = buildLookup(snapshot);
  const rawSubmittedInitial = asArray(submittedSnapshot?.initialTeamMemberKeys).length > 0
    ? asArray(submittedSnapshot.initialTeamMemberKeys)
    : asArray(submittedSnapshot?.initialTeamSlots);
  const rawStoredInitial = asArray(stored?.initialTeamMemberKeys).length > 0
    ? asArray(stored.initialTeamMemberKeys)
    : (asArray(stored?.initialTeamSlots).length > 0
      ? asArray(stored.initialTeamSlots)
      : extractLegacyInitialSlots(game));
  const rawInitial = rawSubmittedInitial.length > 0 ? rawSubmittedInitial : rawStoredInitial;
  const initialTeamMemberKeys = Array.from({ length: 4 }, (_, index) => {
    const member = resolveMember(snapshot, rawInitial[index]);
    return member ? member.memberKey : null;
  }).filter(Boolean);

  snapshot.initialTeamMemberKeys = initialTeamMemberKeys.length > 0
    ? initialTeamMemberKeys
    : members.slice(0, 4).map((item) => item.memberKey);
  snapshot.allowedMemberKeys = uniq([
    ...asArray(stored?.allowedMemberKeys).map(toStr),
    ...members.map((item) => item.memberKey),
  ]);
  snapshot.identityConflicts = identityConflicts;
  snapshot.lookup = lookup;
  return snapshot;
};

const sanitizeSnapshot = (snapshot) => {
  const lookup = buildLookup(snapshot);
  const resolveKey = (memberKey) => {
    const key = toStr(memberKey);
    if (!key) return null;
    return sanitizeMember(lookup.byMemberKey.get(key) || null);
  };
  return {
    version: "result-roster-snapshot-v3",
    schemaVersion: 3,
    capturedAt: snapshot.capturedAt || null,
    members: asArray(snapshot.members).map((item) => sanitizeMember(item)).filter(Boolean),
    playerPool: asArray(snapshot.members).map((item) => sanitizeMember(item)).filter(Boolean),
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

const ensureDistinctResolvedSet = (members) => {
  const keys = members.map((member) => buildMemberIdentityKey(member)).filter(Boolean);
  return keys.length === 4 && new Set(keys).size === 4;
};
const findDuplicateField = (members, selector) => {
  const seen = new Set();
  for (const member of members) {
    const key = selector(member);
    if (!key) continue;
    if (seen.has(key)) return key;
    seen.add(key);
  }
  return null;
};
const validateResolvedSnapshot = (snapshot, resolvedSetPairings) => {
  if (asArray(snapshot?.identityConflicts).length > 0) {
    return "Result roster snapshot contains duplicated player identities";
  }

  const members = asArray(snapshot?.members);
  const duplicatePhone = findDuplicateField(members, (member) => toStr(member?.phoneNorm));
  if (duplicatePhone) {
    return `Result roster snapshot contains duplicated phoneNorm: ${duplicatePhone}`;
  }

  const duplicateId = findDuplicateField(members, (member) => toStr(member?.id));
  if (duplicateId) {
    return `Result roster snapshot contains duplicated player id: ${duplicateId}`;
  }

  const playedMembers = [];
  const seenPlayed = new Set();
  asArray(resolvedSetPairings).forEach((pairing) => {
    asArray(pairing?.teamSlots).forEach((member) => {
      const memberKey = toStr(member?.memberKey);
      if (!memberKey || seenPlayed.has(memberKey)) return;
      seenPlayed.add(memberKey);
      playedMembers.push(member);
    });
  });

  if (playedMembers.length < 4) {
    return "Result must contain a valid 2v2 lineup";
  }

  if (playedMembers.some((member) => !buildStableIdentityKey(member))) {
    return "Every played player must have stable id or phone in result roster snapshot";
  }

  return null;
};

const resolveSetPairings = (snapshot, rawPairings, setCount) => {
  const lookup = buildLookup(snapshot);
  const explicit = new Map();
  asArray(rawPairings).forEach((item) => {
    if (!item || typeof item !== "object") return;
    const setIndex = Number(item.setIndex);
    if (!Number.isInteger(setIndex) || setIndex < 0) return;
    explicit.set(setIndex, item);
  });

  let lastKeys = asArray(snapshot.initialTeamMemberKeys).slice(0, 4);
  const resolved = [];
  for (let setIndex = 0; setIndex < setCount; setIndex += 1) {
    const rawPairing = explicit.get(setIndex) || null;
    let teamSlots = null;
    if (rawPairing) {
      const rawSlots = asArray(rawPairing.teamSlots || rawPairing.slots || rawPairing.players || rawPairing.pairing);
      const resolvedMembers = Array.from({ length: 4 }, (_, slotIndex) => resolveMember(snapshot, rawSlots[slotIndex]));
      if (!ensureDistinctResolvedSet(resolvedMembers)) {
        return { error: `Invalid set pairing for set ${setIndex + 1}` };
      }
      teamSlots = resolvedMembers;
      lastKeys = resolvedMembers.map((member) => member.memberKey);
    } else if (lastKeys.length === 4) {
      teamSlots = lastKeys.map((key) => lookup.byMemberKey.get(key) || null);
    }

    if (!teamSlots || !ensureDistinctResolvedSet(teamSlots)) {
      return { error: `No valid pairing for set ${setIndex + 1}` };
    }

    resolved.push({
      setIndex,
      teamSlots,
      publicTeamSlots: teamSlots.map((item) => sanitizeMember(item)),
      teamA: teamSlots.slice(0, 2),
      teamB: teamSlots.slice(2, 4),
    });
  }

  return { resolved };
};

const rows = Array.isArray(msg.payload) ? msg.payload : [];
const ctx = msg._resultSubmit || {};
if (rows.length === 0) {
  msg.statusCode = 404;
  msg.headers = { "Content-Type": "application/json; charset=utf-8" };
  msg.payload = { error: "Game not found" };
  return [null, msg, msg];
}

const game = rows[0] || {};
const endTs = toTs(game);
if (!Number.isFinite(endTs) || endTs > Date.now()) {
  msg.statusCode = 409;
  msg.headers = { "Content-Type": "application/json; charset=utf-8" };
  msg.payload = { error: "Game is not finished yet" };
  return [null, msg, msg];
}

const resultRosterSnapshot = buildSnapshotFromGame(game, ctx);
const actorMember = resolveMember(
  resultRosterSnapshot,
  ctx.actor || { id: null, phone: ctx.phone },
);
if (!actorMember) {
  msg.statusCode = 403;
  msg.headers = { "Content-Type": "application/json; charset=utf-8" };
  msg.payload = { error: "Only roster member can submit result" };
  return [null, msg, msg];
}

const scoringSets = asArray(ctx.sets).length > 0
  ? asArray(ctx.sets)
  : [{ left: Number(ctx.scoreA || 0), right: Number(ctx.scoreB || 0) }];
const resolvedPairingsResult = resolveSetPairings(resultRosterSnapshot, ctx.setPairings, scoringSets.length);
if (resolvedPairingsResult.error) {
  msg.statusCode = 409;
  msg.headers = { "Content-Type": "application/json; charset=utf-8" };
  msg.payload = { error: resolvedPairingsResult.error };
  return [null, msg, msg];
}

const resolvedSetPairings = resolvedPairingsResult.resolved;
const snapshotValidationError = validateResolvedSnapshot(resultRosterSnapshot, resolvedSetPairings);
if (snapshotValidationError) {
  msg.statusCode = 409;
  msg.headers = { "Content-Type": "application/json; charset=utf-8" };
  msg.payload = { error: snapshotValidationError };
  return [null, msg, msg];
}
const actorPlayedSet = resolvedSetPairings.find((pairing) => pairing.teamSlots.some((member) => member.memberKey === actorMember.memberKey)) || null;
if (!actorPlayedSet) {
  msg.statusCode = 403;
  msg.headers = { "Content-Type": "application/json; charset=utf-8" };
  msg.payload = { error: "Only player from submitted lineups can submit result" };
  return [null, msg, msg];
}

const latestPairing = resolvedSetPairings[resolvedSetPairings.length - 1] || null;
const submitterTeam = actorPlayedSet.teamA.some((member) => member.memberKey === actorMember.memberKey)
  ? "A"
  : actorPlayedSet.teamB.some((member) => member.memberKey === actorMember.memberKey)
    ? "B"
    : null;
const activeMembers = [];
const seenActive = new Set();
resolvedSetPairings.forEach((pairing) => {
  pairing.teamSlots.forEach((member) => {
    const identityKey = buildMemberIdentityKey(member);
    if (!member || !identityKey || seenActive.has(identityKey)) return;
    seenActive.add(identityKey);
    activeMembers.push(member);
  });
});
const ratingEnabled = game?.settings?.ratingGame !== false;

msg._resultSubmit = Object.assign({}, ctx, {
  game,
  endTs,
  ratingEnabled,
  submitterTeam,
  actorMember,
  teams: latestPairing ? {
    source: "setPairings",
    teamA: latestPairing.teamA,
    teamB: latestPairing.teamB,
  } : { source: "snapshot", teamA: [], teamB: [] },
  resultRosterSnapshot,
  publicRosterSnapshot: sanitizeSnapshot(resultRosterSnapshot),
  scoringSets,
  resolvedSetPairings,
  activeMembers,
  activeIds: uniq(activeMembers.map((member) => member.id)),
  activePhones: uniq(activeMembers.map((member) => member.phoneNorm)),
  setPairings: resolvedSetPairings.map((pairing) => ({
    setIndex: pairing.setIndex,
    teamSlots: pairing.publicTeamSlots,
  })),
});
if (!ctx.tenantKey || game.tenantKey !== ctx.tenantKey) {
  msg.statusCode = 409;
  msg.payload = { error: "Game tenant mismatch", code: "LEGACY_GAME_TENANT_CONFLICT" };
  return [null, msg, msg];
}
msg.payload = { tenantKey: ctx.tenantKey, gameId: game.id, deleted: { $ne: true } };
return [msg, null, msg];
