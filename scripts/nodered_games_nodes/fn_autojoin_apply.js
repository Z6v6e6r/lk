const isObj = (value) => value && typeof value === "object" && !Array.isArray(value);
const toArray = (value) => (Array.isArray(value) ? value : []);
const toStr = (value) => {
  if (value === null || value === undefined) return null;
  const normalized = String(value).trim();
  return normalized ? normalized : null;
};
const toNum = (value) => {
  if (value === null || value === undefined) return null;
  const parsed = Number(String(value).replace(",", "."));
  return Number.isFinite(parsed) ? parsed : null;
};
const normPhone = (value) => {
  const digits = String(value || "").replace(/\D/g, "");
  if (!digits) return null;
  if (digits.length === 10) return `7${digits}`;
  if (digits.length === 11 && digits.startsWith("8")) return `7${digits.slice(1)}`;
  return digits;
};
const uniq = (items) => Array.from(new Set(items.filter(Boolean)));
const nowIso = new Date().toISOString();
const nowTs = Date.now();

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

const buildMember = (value, fallbackRole = "MEMBER") => {
  const member = isObj(value) ? value : {};
  const levelScore = toNum(member.levelScore ?? member.ratingNumeric ?? member.levelNumeric) ?? 3.2;
  return {
    id: toStr(member.id || member.clientId || member.userId || member.uuid),
    phone: normPhone(member.phone || member.phoneNorm || member.phoneNumber || member.mobile),
    name: toStr(member.name || member.displayName || [member.firstName, member.lastName].filter(Boolean).join(" ")) || "Игрок",
    avatar: toStr(member.avatar || member.photo || member.imageUrl),
    role: toStr(member.role) || fallbackRole,
    status: toStr(member.status) || "ACTIVE",
    levelScore,
    levelLabel: toStr(member.levelLabel || member.rating || member.level) || buildLevelLabel(levelScore),
    joinedAt: toStr(member.joinedAt || member.createdAt) || nowIso,
  };
};

const sameMemberIdentity = (left, right) => {
  const memberLeft = buildMember(left);
  const memberRight = buildMember(right);
  return Boolean(
    (memberLeft.id && memberRight.id && memberLeft.id === memberRight.id)
    || (memberLeft.phone && memberRight.phone && memberLeft.phone === memberRight.phone)
    || (
      !memberLeft.id
      && !memberRight.id
      && !memberLeft.phone
      && !memberRight.phone
      && memberLeft.name.toLowerCase() === memberRight.name.toLowerCase()
    )
  );
};

const normalizeComparableName = (value) => {
  const raw = toStr(value);
  if (!raw) return null;
  const normalized = raw
    .toLowerCase()
    .replace(/ё/g, "е")
    .replace(/[^a-zа-я0-9]+/gi, " ")
    .replace(/\s+/g, " ")
    .trim();
  return normalized || null;
};

const normalizeCommunityToken = (value) => {
  const normalized = normalizeComparableName(value);
  if (!normalized) return null;
  const compact = normalized
    .replace(/\b(хаб|xаб|hub|padel|падел|club|клуб|community|сообщество|станция)\b/gi, " ")
    .replace(/\s+/g, " ")
    .trim();
  return compact || normalized;
};

const stationAliases = [
  {
    studioIds: ["6a7a9edc-6869-40ad-a5a1-8a1cdfb746a1"],
    names: ["Терехово"],
    aliases: ["Терехово", "tereh"],
  },
  {
    studioIds: ["0d5504f6-ea6f-44bb-a9e4-947faf0273ab"],
    names: ["Сколково"],
    aliases: ["Сколково", "Кунцево", "kuncev"],
  },
  {
    studioIds: ["6b2d7e60-caff-4b22-89f6-6f19d7d311ab"],
    names: ["Нагатинская"],
    aliases: ["Нагатинская", "nagat"],
  },
  {
    studioIds: ["42c6d4df-833d-480a-bdc8-986716569884"],
    names: ["Нагатинская Премиум"],
    aliases: ["Нагатинская Премиум", "nagat_p"],
  },
  {
    studioIds: ["588b6151-f4f5-47d9-9449-80edf8cbc748"],
    names: ["Ясенево"],
    aliases: ["Ясенево", "yas"],
  },
  {
    studioIds: ["3656cbaa-6426-490f-a44f-915404cbdd2b"],
    names: ["Селигерская"],
    aliases: ["Селигерская", "seleger"],
  },
  {
    studioIds: ["233c1405-1eac-40de-8ec6-1cf7e24c9276"],
    names: ["Сочи"],
    aliases: ["Сочи", "sochi"],
  },
];

const aliasByStudioId = new Map();
const aliasByStationName = new Map();
stationAliases.forEach((item) => {
  const normalizedAliases = uniq([
    ...item.names.map((value) => normalizeCommunityToken(value)),
    ...item.aliases.map((value) => normalizeCommunityToken(value)),
  ]);

  item.studioIds.forEach((studioId) => {
    const normalizedStudioId = toStr(studioId);
    if (normalizedStudioId) aliasByStudioId.set(normalizedStudioId, normalizedAliases);
  });
  item.names.forEach((name) => {
    const normalizedName = normalizeCommunityToken(name);
    if (normalizedName) aliasByStationName.set(normalizedName, normalizedAliases);
  });
});

const buildRankingRows = (members) => {
  const sorted = toArray(members)
    .map((item) => buildMember(item, item?.role || "MEMBER"))
    .sort((left, right) => {
      if (right.levelScore !== left.levelScore) return right.levelScore - left.levelScore;
      return left.name.localeCompare(right.name, "ru");
    });

  const levelPlaceMap = new Map();
  return sorted.map((member, index) => {
    const nextLevelPlace = (levelPlaceMap.get(member.levelLabel) || 0) + 1;
    levelPlaceMap.set(member.levelLabel, nextLevelPlace);
    return {
      id: member.id,
      phone: member.phone,
      name: member.name,
      avatar: member.avatar,
      role: member.role,
      levelScore: member.levelScore,
      levelLabel: member.levelLabel,
      overallPlace: index + 1,
      levelPlace: nextLevelPlace,
    };
  });
};

const ctx = isObj(msg._gameCommunityAutoJoin) ? msg._gameCommunityAutoJoin : {};
const game = isObj(ctx.game) ? ctx.game : null;
const member = buildMember(ctx.member, "MEMBER");
const station = isObj(ctx.station) ? ctx.station : {};
const stationStudioId = toStr(station.studioId);
const stationName = toStr(station.studioName);

if (!game?.id || (!member.id && !member.phone)) {
  msg.payload = {
    ok: false,
    reason: "AUTOJOIN_CONTEXT_INVALID",
    gameId: toStr(game?.id),
    memberId: member.id,
    memberPhone: member.phone,
  };
  return [null, null, null, null, msg];
}

const aliasCandidates = uniq([
  ...(stationStudioId ? (aliasByStudioId.get(stationStudioId) || []) : []),
  ...(normalizeCommunityToken(stationName) ? (aliasByStationName.get(normalizeCommunityToken(stationName)) || []) : []),
  normalizeCommunityToken(stationName),
]);

if (aliasCandidates.length === 0) {
  msg.payload = {
    ok: false,
    reason: "AUTOJOIN_STATION_UNKNOWN",
    gameId: game.id,
    stationStudioId,
    stationName,
  };
  return [null, null, null, null, msg];
}

let bestCommunity = null;
let bestScore = 0;

toArray(msg.payload).forEach((communityRaw) => {
  const community = isObj(communityRaw) ? communityRaw : null;
  if (!community || community.archived === true) return;

  const communityToken = normalizeCommunityToken(community.name || community.title);
  if (!communityToken) return;

  let score = 0;
  aliasCandidates.forEach((alias) => {
    if (!alias) return;
    if (communityToken === alias) {
      score = Math.max(score, 120);
      return;
    }
    if (communityToken.includes(alias) || alias.includes(communityToken)) {
      score = Math.max(score, 96);
      return;
    }
    const communityWords = new Set(communityToken.split(" ").filter((part) => part.length > 2));
    const aliasWords = alias.split(" ").filter((part) => part.length > 2);
    const overlap = aliasWords.reduce((count, word) => count + (communityWords.has(word) ? 1 : 0), 0);
    if (overlap > 0) {
      score = Math.max(score, 70 + overlap * 8);
    }
  });

  if (!score) return;
  if (community.isVerified === true || community.verified === true) score += 8;
  if (bestCommunity == null || score > bestScore) {
    bestCommunity = community;
    bestScore = score;
  }
});

if (!bestCommunity || bestScore < 70) {
  msg.payload = {
    ok: false,
    reason: "AUTOJOIN_COMMUNITY_NOT_FOUND",
    gameId: game.id,
    stationStudioId,
    stationName,
    aliases: aliasCandidates,
    bestScore,
  };
  return [null, null, null, null, msg];
}

const members = toArray(bestCommunity.members).map((item) => buildMember(item, item?.role || "MEMBER"));
const pendingMembers = toArray(bestCommunity.pendingMembers).map((item) => buildMember(item, "MEMBER"));
const bannedMembers = toArray(bestCommunity.bannedMembers).map((item) => buildMember(item, "MEMBER"));

if (bannedMembers.some((item) => sameMemberIdentity(item, member))) {
  msg.payload = {
    ok: false,
    reason: "AUTOJOIN_MEMBER_BANNED",
    gameId: game.id,
    communityId: toStr(bestCommunity.id),
    communityName: toStr(bestCommunity.name || bestCommunity.title),
  };
  return [null, null, null, null, msg];
}

if (members.some((item) => sameMemberIdentity(item, member))) {
  msg.payload = {
    ok: true,
    reason: "AUTOJOIN_ALREADY_MEMBER",
    gameId: game.id,
    communityId: toStr(bestCommunity.id),
    communityName: toStr(bestCommunity.name || bestCommunity.title),
  };
  return [null, null, null, null, msg];
}

const cleanedPendingMembers = pendingMembers.filter((item) => !sameMemberIdentity(item, member));
const nextMembers = [member, ...members];
const rankingRows = buildRankingRows(nextMembers);
const communityId = toStr(bestCommunity.id);
const communityName = toStr(bestCommunity.name || bestCommunity.title) || "Сообщество станции";

const communityMsg = Object.assign({}, msg, {
  query: { id: communityId, archived: { $ne: true } },
  payload: {
    $set: {
      members: nextMembers,
      memberCount: nextMembers.length,
      pendingMembers: cleanedPendingMembers,
      updatedAt: nowIso,
    },
  },
});

const rankingMsg = Object.assign({}, msg, {
  query: { communityId },
  payload: {
    $set: {
      communityId,
      rows: rankingRows,
      updatedAt: nowIso,
    },
    $setOnInsert: {
      createdAt: nowIso,
    },
  },
});

const feedMsg = Object.assign({}, msg, {
  payload: {
    id: `${communityId}:post:${nowTs}:game-autojoin:${member.id || member.phone || "member"}`,
    communityId,
    kind: "SYSTEM",
    title: "Новый участник",
    body: `${member.name} вступил в сообщество после оплаты игры на станции.`,
    imageUrl: null,
    previewLabel: member.levelLabel,
    memberPreview: {
      id: member.id,
      phone: member.phone,
      name: member.name,
      avatar: member.avatar,
      levelScore: member.levelScore,
      levelLabel: member.levelLabel,
      stats: {
        matchesPlayed: 0,
        wins: 0,
        losses: 0,
        draws: 0,
      },
    },
    ctaLabel: null,
    relatedGameId: game.id,
    relatedTournamentId: null,
    author: {
      id: member.id,
      phone: member.phone,
      name: member.name,
      avatar: member.avatar,
      levelScore: member.levelScore,
      levelLabel: member.levelLabel,
    },
    authorName: member.name,
    publishedAt: nowIso,
    createdAt: nowIso,
    createdTs: nowTs,
    archived: false,
  },
});

const eventMsg = Object.assign({}, msg, {
  payload: {
    id: `${communityId}:event:${nowTs}:game-autojoin:${member.id || member.phone || "member"}`,
    communityId,
    type: "MEMBER_JOINED_BY_GAME_PAYMENT",
    actor: {
      id: member.id,
      phone: member.phone,
      name: member.name,
    },
    createdAt: nowIso,
    createdTs: nowTs,
    payload: {
      source: "LK_GAME_PAYMENT",
      gameId: game.id,
      stationStudioId,
      stationName,
      flowSource: toStr(ctx.source) || "games_flow",
    },
  },
});

const debugMsg = Object.assign({}, msg, {
  payload: {
    ok: true,
    reason: "AUTOJOIN_APPLIED",
    gameId: game.id,
    communityId,
    communityName,
    stationStudioId,
    stationName,
    memberId: member.id,
    memberPhone: member.phone,
  },
});

return [communityMsg, rankingMsg, feedMsg, eventMsg, debugMsg];
