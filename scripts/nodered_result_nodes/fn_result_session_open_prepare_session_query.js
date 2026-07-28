const toStr = (value) => {
  if (value === null || value === undefined) return null;
  const text = String(value).trim();
  return text ? text : null;
};
const normPhone = (value) => {
  const digits = String(value || "").replace(/\D/g, "");
  if (!digits) return null;
  if (digits.length === 10) return `7${digits}`;
  if (digits.length === 11 && digits.startsWith("8")) return `7${digits.slice(1)}`;
  return digits;
};
const asArray = (value) => (Array.isArray(value) ? value : []);
const uniq = (value) => Array.from(new Set(asArray(value).filter(Boolean)));

const buildMember = (value, fallbackName, bucket) => {
  if (!value || typeof value !== "object") return null;
  const memberKey = toStr(value.memberKey || value.playerKey || value.participantKey || value.rosterMemberKey);
  const id = toStr(value.id || value.clientId || value.uuid || value.userId || value.playerId);
  const phoneNorm = normPhone(value.phoneNorm || value.phone || value.phoneNumber || value.mobile);
  const name = toStr(value.name || value.fullName || value.title || value.displayName) || fallbackName;
  const resolvedMemberKey = memberKey
    || (id ? `id:${id}` : null)
    || (phoneNorm ? `phone:${phoneNorm}` : null)
    || (name ? `name:${String(name).trim().toLowerCase()}` : null);
  if (!resolvedMemberKey) return null;
  return {
    memberKey: resolvedMemberKey,
    id,
    phoneNorm,
    name: name || "Игрок",
    bucket: toStr(value.bucket || value.source || bucket) || bucket || "participant",
  };
};

const buildSnapshotFromGame = (game) => {
  const stored = game?.resultRosterSnapshot;
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
      if (existing.bucket === "waitlist" && member.bucket !== "waitlist") existing.bucket = member.bucket;
      return;
    }
    seen.add(member.memberKey);
    members.push(member);
  };

  if (stored && typeof stored === "object") {
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

  return {
    members,
    allowedMemberKeys: uniq([
      ...asArray(stored?.allowedMemberKeys).map(toStr),
      ...members.map((item) => item.memberKey),
    ]),
  };
};

const resolveActorMemberKey = (snapshot, actor) => {
  const actorId = toStr(actor?.id);
  const actorPhone = normPhone(actor?.phoneNorm || actor?.phone);
  const byId = actorId ? snapshot.members.find((item) => item.id === actorId) : null;
  if (byId) return byId.memberKey;
  const byPhone = actorPhone ? snapshot.members.find((item) => item.phoneNorm === actorPhone) : null;
  return byPhone ? byPhone.memberKey : null;
};

const rows = asArray(msg.payload);
if (rows.length === 0) {
  msg.statusCode = 404;
  msg.headers = { "Content-Type": "application/json; charset=utf-8" };
  msg.payload = { error: "Game not found" };
  return [null, msg, msg];
}

const ctx = msg._resultSessionOpen || {};
const game = rows[0] || {};
const snapshot = buildSnapshotFromGame(game);
const actorMemberKey = resolveActorMemberKey(snapshot, ctx.actor || { phoneNorm: ctx.phone });

if (!actorMemberKey) {
  msg.statusCode = 403;
  msg.headers = { "Content-Type": "application/json; charset=utf-8" };
  msg.payload = { error: "Only roster member can open result session" };
  return [null, msg, msg];
}

ctx.game = game;
ctx.sessionId = ctx.requestedSessionId || `result_session_${toStr(game.id) || ctx.gameId}`;
ctx.allowedMemberKeys = uniq(snapshot.allowedMemberKeys);
ctx.actorMemberKey = actorMemberKey;
msg._resultSessionOpen = ctx;
msg.payload = { _id: ctx.sessionId, deleted: { $ne: true } };
return [msg, null, msg];
