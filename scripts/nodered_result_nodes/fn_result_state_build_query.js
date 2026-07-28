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
const toNumericOrNull = (value) => {
  if (value === null || value === undefined) return null;
  if (typeof value === "string" && !value.trim()) return null;
  const numeric = Number(value);
  return Number.isFinite(numeric) ? numeric : null;
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

const buildMember = (value, fallbackName, bucket) => {
  if (!value || typeof value !== "object") return null;
  const explicitMemberKey = toStr(value.memberKey || value.playerKey || value.participantKey || value.rosterMemberKey);
  const id = toStr(value.id || value.clientId || value.uuid || value.userId || value.playerId);
  const phoneNorm = normPhone(value.phoneNorm || value.phone || value.phoneNumber || value.mobile);
  const name = toStr(value.name || value.fullName || value.title || value.displayName) || fallbackName;
  const memberKey = explicitMemberKey
    || (id ? `id:${id}` : null)
    || (phoneNorm ? `phone:${phoneNorm}` : null)
    || (name ? `name:${String(name).trim().toLowerCase()}` : null);
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

const buildLookup = (snapshot) => {
  const byMemberKey = new Map();
  const byId = new Map();
  const byPhone = new Map();
  asArray(snapshot?.members).forEach((item) => {
    const member = buildMember(item, "Игрок", item?.bucket || "participant");
    if (!member) return;
    byMemberKey.set(member.memberKey, member);
    if (member.id) byId.set(member.id, member);
    if (member.phoneNorm) byPhone.set(member.phoneNorm, member);
  });
  return { byMemberKey, byId, byPhone };
};

const resolveMember = (snapshot, value) => {
  const lookup = buildLookup(snapshot);
  if (typeof value === "string" || typeof value === "number") {
    const raw = toStr(value);
    if (!raw) return null;
    return lookup.byMemberKey.get(raw)
      || lookup.byId.get(raw)
      || lookup.byPhone.get(normPhone(raw))
      || null;
  }
  const member = buildMember(value, "Игрок", value?.bucket || "participant");
  if (!member) return null;
  return lookup.byMemberKey.get(member.memberKey)
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

const buildSnapshotFromGame = (game) => {
  const stored = game?.resultRosterSnapshot && typeof game.resultRosterSnapshot === "object"
    ? game.resultRosterSnapshot
    : null;
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
    members,
    participantMemberKeys: uniq([
      ...asArray(stored?.participantMemberKeys).map(toStr),
      ...members.filter((item) => item.bucket !== "waitlist").map((item) => item.memberKey),
    ]),
  };
  const rawInitial = asArray(stored?.initialTeamMemberKeys).length > 0
    ? asArray(stored.initialTeamMemberKeys)
    : (asArray(stored?.initialTeamSlots).length > 0
      ? asArray(stored.initialTeamSlots)
      : extractLegacyInitialSlots(game));
  snapshot.initialTeamMemberKeys = Array.from({ length: 4 }, (_, index) => {
    const member = resolveMember(snapshot, rawInitial[index]);
    return member ? member.memberKey : null;
  }).filter(Boolean);
  if (snapshot.initialTeamMemberKeys.length === 0) {
    snapshot.initialTeamMemberKeys = members.slice(0, 4).map((item) => item.memberKey);
  }
  return snapshot;
};

const rows = Array.isArray(msg.payload) ? msg.payload : [];
const ctx = msg._resultState || {};

if (rows.length === 0) {
  msg.statusCode = 404;
  msg.headers = { "Content-Type": "application/json; charset=utf-8" };
  msg.payload = { error: "Game not found" };
  return [null, msg, msg];
}

const game = rows[0] || {};
const resultRosterSnapshot = buildSnapshotFromGame(game);
const viewerMember = resolveMember(
  resultRosterSnapshot,
  ctx.actor || (ctx.phone ? { phone: ctx.phone } : null),
);
const lookup = buildLookup(resultRosterSnapshot);
const initialTeamSlots = Array.from({ length: 4 }, (_, index) => {
  const key = asArray(resultRosterSnapshot.initialTeamMemberKeys)[index];
  return key ? lookup.byMemberKey.get(key) || null : null;
});

msg._resultState = {
  gameId: game.id,
  phone: ctx.phone || null,
  actor: ctx.actor || null,
  game,
  resultRosterSnapshot,
  viewerMember,
  teams: {
    source: "resultRosterSnapshot",
    teamA: initialTeamSlots.slice(0, 2).filter(Boolean),
    teamB: initialTeamSlots.slice(2, 4).filter(Boolean),
  },
  endTs: toTs(game),
  isFinished: Number.isFinite(toTs(game)) ? toTs(game) <= Date.now() : false,
};

msg.payload = { gameId: game.id, deleted: { $ne: true } };
return [msg, null, msg];
