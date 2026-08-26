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
  };
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

  return { members };
};

const resolveActorMember = (snapshot, actor, fallbackPhone) => {
  const actorId = toStr(actor?.id || actor?.clientId || actor?.uuid || actor?.userId || actor?.playerId);
  const normalizedPhone = normPhone(actor?.phoneNorm || actor?.phone || fallbackPhone);
  if (actorId) {
    const byId = snapshot.members.find((item) => item.id === actorId) || null;
    if (byId) return byId;
  }
  return normalizedPhone
    ? snapshot.members.find((item) => item.phoneNorm === normalizedPhone) || null
    : null;
};

const rows = Array.isArray(msg.payload) ? msg.payload : [];
const ctx = msg._resultConfirm || {};
if (rows.length === 0) {
  msg.statusCode = 404;
  msg.headers = { "Content-Type": "application/json; charset=utf-8" };
  msg.payload = { error: "Game not found" };
  return [null, msg, msg];
}

const game = rows[0] || {};
const resultRosterSnapshot = buildSnapshotFromGame(game);
const actorMember = resolveActorMember(resultRosterSnapshot, ctx.actor, ctx.phone);
if (!actorMember) {
  msg.statusCode = 403;
  msg.headers = { "Content-Type": "application/json; charset=utf-8" };
  msg.payload = { error: ctx.action === "DISPUTE" ? "Only roster member can dispute result" : "Only roster member can confirm result" };
  return [null, msg, msg];
}

const endTs = toTs(game);
if (!Number.isFinite(endTs) || endTs > Date.now()) {
  msg.statusCode = 409;
  msg.headers = { "Content-Type": "application/json; charset=utf-8" };
  msg.payload = { error: "Game is not finished yet" };
  return [null, msg, msg];
}

if (!ctx.tenantKey || game.tenantKey !== ctx.tenantKey) {
  msg.statusCode = 409;
  msg.payload = { error: "Game tenant mismatch", code: "LEGACY_GAME_TENANT_CONFLICT" };
  return [null, msg, msg];
}
msg._resultConfirm = Object.assign({}, ctx, { game, endTs, resultRosterSnapshot, actorMember });
msg.payload = { tenantKey: ctx.tenantKey, gameId: game.id, deleted: { $ne: true } };
return [msg, null, msg];
