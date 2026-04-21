const normPhone = (v) => {
  const s = String(v || "").replace(/\D/g, "");
  if (!s) return null;
  if (s.length === 10) return "7" + s;
  if (s.length === 11 && s.startsWith("8")) return "7" + s.slice(1);
  return s;
};
const uniq = (arr) => Array.from(new Set(arr.filter(Boolean)));
const asArray = (v) => Array.isArray(v) ? v : [];

const toTs = (game) => {
  const endTs = Number(game?.booking?.endTs);
  if (Number.isFinite(endTs)) return endTs;
  const date = game?.booking?.date || null;
  const timeTo = game?.booking?.timeTo || null;
  if (date && timeTo) {
    const ts = Date.parse(`${date}T${/^\d{2}:\d{2}$/.test(timeTo) ? `${timeTo}:00` : timeTo}+03:00`);
    if (Number.isFinite(ts)) return ts;
  }
  return null;
};

const normalizePlayer = (p) => ({
  id: p?.id || p?.clientId || null,
  name: p?.name || 'Игрок',
  phoneNorm: normPhone(p?.phoneNorm || p?.phone || p?.phoneNumber),
  rating: p?.rating ?? null,
  ratingNumeric: Number.isFinite(Number(p?.ratingNumeric)) ? Number(p.ratingNumeric) : null,
});

const resolveTeams = (game) => {
  const fromTeams = game?.teams || game?.metadata?.teams || null;
  const toTeam = (arr) => asArray(arr).map(normalizePlayer).filter((p) => p.phoneNorm);

  if (fromTeams) {
    const teamA = toTeam(fromTeams.teamA || fromTeams.a || fromTeams.team1 || []);
    const teamB = toTeam(fromTeams.teamB || fromTeams.b || fromTeams.team2 || []);
    if (teamA.length > 0 && teamB.length > 0) return { teamA, teamB, source: 'explicit' };
  }

  const participants = asArray(game?.participants).map(normalizePlayer).filter((p) => p.phoneNorm);
  if (participants.length >= 4) {
    return { teamA: participants.slice(0, 2), teamB: participants.slice(2, 4), source: 'participants_split_2x2' };
  }
  if (participants.length >= 2) {
    const mid = Math.floor(participants.length / 2);
    return { teamA: participants.slice(0, mid), teamB: participants.slice(mid), source: 'participants_half_split' };
  }

  return { teamA: [], teamB: [], source: 'none' };
};

const rows = Array.isArray(msg.payload) ? msg.payload : [];
const ctx = msg._resultSubmit || {};
if (rows.length === 0) {
  msg.statusCode = 404;
  msg.headers = { "Content-Type": "application/json; charset=utf-8" };
  msg.payload = { error: 'Game not found' };
  return [null, msg, msg];
}

const game = rows[0] || {};
const allPhones = uniq([
  normPhone(game?.organizer?.phoneNorm || game?.organizer?.phone),
  ...asArray(game?.allRelatedPhones).map(normPhone),
  ...asArray(game?.participantPhones).map(normPhone),
  ...asArray(game?.waitlistPhones).map(normPhone),
  ...asArray(game?.invitedPhones).map(normPhone),
]);
if (allPhones.length > 0 && !allPhones.includes(ctx.phone)) {
  msg.statusCode = 403;
  msg.headers = { "Content-Type": "application/json; charset=utf-8" };
  msg.payload = { error: 'Access denied' };
  return [null, msg, msg];
}

const teams = resolveTeams(game);
if (teams.teamA.length === 0 || teams.teamB.length === 0) {
  msg.statusCode = 409;
  msg.headers = { "Content-Type": "application/json; charset=utf-8" };
  msg.payload = { error: 'Teams are not formed for this game' };
  return [null, msg, msg];
}

const submitterTeam = teams.teamA.some((p) => p.phoneNorm === ctx.phone)
  ? 'A'
  : teams.teamB.some((p) => p.phoneNorm === ctx.phone)
    ? 'B'
    : null;

if (!submitterTeam) {
  msg.statusCode = 403;
  msg.headers = { "Content-Type": "application/json; charset=utf-8" };
  msg.payload = { error: 'Only participant can submit result' };
  return [null, msg, msg];
}

const endTs = toTs(game);
if (!Number.isFinite(endTs) || endTs > Date.now()) {
  msg.statusCode = 409;
  msg.headers = { "Content-Type": "application/json; charset=utf-8" };
  msg.payload = { error: 'Game is not finished yet' };
  return [null, msg, msg];
}

msg._resultSubmit = Object.assign({}, ctx, { game, teams, endTs, submitterTeam });
msg.payload = { gameId: game.id, deleted: { $ne: true } };
return [msg, null, msg];
