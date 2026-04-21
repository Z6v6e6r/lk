const isObj = (value) => value && typeof value === "object" && !Array.isArray(value);
const toStr = (value) => {
  if (value === null || value === undefined) return null;
  const normalized = String(value).trim();
  return normalized ? normalized : null;
};
const normPhone = (value) => {
  const digits = String(value || "").replace(/\D/g, "");
  if (!digits) return null;
  if (digits.length === 10) return `7${digits}`;
  if (digits.length === 11 && digits.startsWith("8")) return `7${digits.slice(1)}`;
  return digits;
};
const toNum = (value) => {
  if (value === null || value === undefined) return null;
  const parsed = Number(String(value).replace(",", "."));
  return Number.isFinite(parsed) ? parsed : null;
};

const buildLevelLabel = (score) => {
  const normalized = Number.isFinite(score) ? score : 3.2;
  if (normalized >= 5.75) return "A";
  if (normalized >= 5.25) return "B+";
  if (normalized >= 4.75) return "B";
  if (normalized >= 4.25) return "C+";
  if (normalized >= 3.75) return "C";
  if (normalized >= 3.25) return "D+";
  return "D";
};

const game = isObj(msg.payload) ? msg.payload : null;
const payment = isObj(game?.payment) ? game.payment : {};
const status = toStr(game?.status)?.toUpperCase() || "";
const paid = typeof payment.paid === "boolean"
  ? payment.paid
  : (status.includes("PAID") || status.includes("PAYED"));

if (!game?.id || !paid) {
  msg.payload = {
    ok: false,
    reason: "GAME_NOT_ELIGIBLE",
    gameId: toStr(game?.id),
    paid,
    status: game?.status || null,
  };
  return [null, msg];
}

const booking = isObj(game.booking) ? game.booking : {};
const organizer = isObj(game.organizer) ? game.organizer : {};
const stationName = toStr(booking.studioName);
const stationStudioId = toStr(booking.studioId);
const memberPhone = normPhone(
  organizer.phone || organizer.phoneNorm || organizer.phoneNumber || organizer.mobile,
);
const memberId = toStr(organizer.id || organizer.clientId || organizer.userId || organizer.uuid);
const levelScore = toNum(organizer.ratingNumeric || organizer.levelScore || organizer.levelNumeric) ?? 3.2;

if ((!memberId && !memberPhone) || (!stationName && !stationStudioId)) {
  msg.payload = {
    ok: false,
    reason: "MISSING_MEMBER_OR_STATION",
    gameId: game.id,
    stationName,
    stationStudioId,
    memberId,
    memberPhone,
  };
  return [null, msg];
}

msg._gameCommunityAutoJoin = {
  source: toStr(msg._requestMode || msg._gameAutojoinSource) || "games_flow",
  game: game,
  member: {
    id: memberId,
    phone: memberPhone,
    name: toStr(organizer.name || organizer.displayName) || "Игрок",
    avatar: toStr(organizer.avatar || organizer.photo || organizer.imageUrl),
    role: "MEMBER",
    status: "ACTIVE",
    levelScore,
    levelLabel: toStr(organizer.rating || organizer.level || organizer.levelLabel) || buildLevelLabel(levelScore),
  },
  station: {
    studioId: stationStudioId,
    studioName: stationName,
  },
};

msg.payload = { archived: { $ne: true } };
return [msg, null];
