import type { PadelGamePlayer, PadelGameRecord } from "../../../utils/apiClient";
import type {
  CommunityPost,
  CommunityPostMemberPreview,
  CommunityRecord,
} from "../../../utils/communityApi";
import { isVisibleCommunityPostKind } from "../../../utils/communityApi";
import type { FeedEntry, News, Tournament, User } from "./feedTypes";
import {
  formatDateDayLabel,
  formatDateMonthLabel,
  formatGameBadgeLabel,
  formatNewsBadgeLabel,
  formatSlotsLabel,
  formatTournamentBadgeLabel,
  formatWeekdayLabel,
} from "./feedFormatters";
import { stripNewsTextMarkup } from "./newsTextFormatting";

interface BuildFeedEntriesParams {
  community: Pick<CommunityRecord, "id" | "name" | "members" | "minimumLevel">;
  posts: CommunityPost[];
  games: PadelGameRecord[];
  currentUser: {
    id?: string | null;
    phone?: string | null;
  };
}

function normalizePhone(value: string | null | undefined) {
  const digits = String(value || "").replace(/\D/g, "");
  if (!digits) return null;
  if (digits.length === 10) return `7${digits}`;
  if (digits.length === 11 && digits.startsWith("8")) return `7${digits.slice(1)}`;
  return digits;
}

function getPlayerIdentityKey(player: PadelGamePlayer | null | undefined) {
  if (!player) return null;
  const byPhone = normalizePhone(player.phone);
  if (byPhone) return `phone:${byPhone}`;
  const byId = (player.id || "").trim();
  if (byId) return `id:${byId}`;
  const byName = (player.name || "").trim().toLowerCase();
  return byName ? `name:${byName}` : null;
}

function toUserFromPreview(preview: CommunityPostMemberPreview | null | undefined): User | null {
  if (!preview?.name) return null;
  return {
    id: preview.id || `member-preview:${preview.name}`,
    name: preview.name,
    avatarUrl: preview.avatar ?? undefined,
    avatar: preview.avatar ?? undefined,
    level: preview.levelLabel,
  };
}

function toUserFromPlayer(player: PadelGamePlayer): User {
  return {
    id: player.id || normalizePhone(player.phone) || `player:${player.name}`,
    name: player.name,
    avatarUrl: player.photo ?? undefined,
    avatar: player.photo ?? undefined,
    level: player.rating ?? undefined,
  };
}

function fallbackUser(name: string, id: string, avatar?: string | null): User {
  return {
    id,
    name: name.trim() || "Игрок сообщества",
    avatarUrl: avatar ?? undefined,
    avatar: avatar ?? undefined,
  };
}

function mergeGamePlayers(players: PadelGamePlayer[]) {
  const mergedPlayers: PadelGamePlayer[] = [];

  players.forEach((player) => {
    const playerKey = getPlayerIdentityKey(player);
    const normalizedName = player.name.trim().toLowerCase();
    const existingIndex = mergedPlayers.findIndex((existingPlayer) => (
      (playerKey && getPlayerIdentityKey(existingPlayer) === playerKey)
      || (
        !playerKey
        && normalizedName
        && existingPlayer.name.trim().toLowerCase() === normalizedName
      )
    ));

    if (existingIndex < 0) {
      mergedPlayers.push(player);
      return;
    }

    const existingPlayer = mergedPlayers[existingIndex];
    mergedPlayers[existingIndex] = {
      ...existingPlayer,
      ...player,
      id: existingPlayer.id || player.id,
      phone: existingPlayer.phone || player.phone,
      photo: existingPlayer.photo || player.photo,
      rating: existingPlayer.rating || player.rating,
      ratingNumeric: existingPlayer.ratingNumeric ?? player.ratingNumeric,
      source: existingPlayer.source || player.source,
      status: existingPlayer.status || player.status,
    };
  });

  return mergedPlayers;
}

function normalizeAvatarUrl(value: string | null | undefined) {
  return (value || "").trim();
}

function isSameOrganizerPlayer(
  organizer: PadelGameRecord["organizer"],
  player: PadelGamePlayer,
) {
  if (!organizer) return false;

  const organizerId = (organizer.id || "").trim();
  const playerId = (player.id || "").trim();
  if (organizerId && playerId && organizerId === playerId) return true;

  const organizerPhone = normalizePhone(organizer.phone);
  const playerPhone = normalizePhone(player.phone);
  if (organizerPhone && playerPhone && organizerPhone === playerPhone) return true;

  const organizerName = (organizer.name || "").trim().toLowerCase();
  const playerName = (player.name || "").trim().toLowerCase();
  return Boolean(organizerName && playerName && organizerName === playerName);
}

function resolveTrustedOrganizerAvatar(game: PadelGameRecord | undefined) {
  const organizerAvatar = normalizeAvatarUrl(game?.organizer?.photo);
  if (!organizerAvatar) return null;

  const hasAvatarConflict = (game?.participants ?? []).some((player) => (
    normalizeAvatarUrl(player.photo) === organizerAvatar
    && !isSameOrganizerPlayer(game?.organizer ?? null, player)
  ));

  return hasAvatarConflict ? null : organizerAvatar;
}

function toTrimmedString(value: unknown) {
  return typeof value === "string" ? value.trim() : "";
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

function pickRecord(source: Record<string, unknown> | null | undefined, keys: string[]) {
  if (!source) return null;
  for (const key of keys) {
    if (isRecord(source[key])) return source[key] as Record<string, unknown>;
  }
  return null;
}

function pickStringValue(source: Record<string, unknown> | null | undefined, keys: string[]) {
  if (!source) return "";
  for (const key of keys) {
    const picked = toTrimmedString(source[key]);
    if (picked) return picked;
  }
  return "";
}

function pickNumberValue(
  source: Record<string, unknown> | null | undefined,
  keys: string[],
  fallback: number | null = null,
) {
  if (!source) return fallback;
  for (const key of keys) {
    const value = source[key];
    if (typeof value === "number" && Number.isFinite(value)) return Math.max(0, Math.floor(value));
    if (typeof value === "string") {
      const parsed = Number.parseInt(value.trim(), 10);
      if (Number.isFinite(parsed)) return Math.max(0, parsed);
    }
  }
  return fallback;
}

function normalizeStringArray(value: unknown) {
  return Array.isArray(value)
    ? value.map((item) => toTrimmedString(item)).filter(Boolean)
    : [];
}

function formatAccessLevelRange(value: unknown) {
  const levels = normalizeStringArray(value);
  if (levels.length === 0) return "";
  if (levels.length === 1) return levels[0];
  return `${levels[0]}-${levels[levels.length - 1]}`;
}

function formatIsoTime(value: string | null | undefined) {
  const parsed = Date.parse(value || "");
  if (!Number.isFinite(parsed)) return "";
  return new Date(parsed).toLocaleTimeString("ru-RU", { hour: "2-digit", minute: "2-digit" });
}

function formatTournamentDuration(startsAt: string, endsAt: string) {
  const startMs = Date.parse(startsAt);
  const endMs = Date.parse(endsAt);
  if (!Number.isFinite(startMs) || !Number.isFinite(endMs) || endMs <= startMs) return "";

  const totalMinutes = Math.round((endMs - startMs) / 60000);
  const hours = Math.floor(totalMinutes / 60);
  const minutes = totalMinutes % 60;
  if (hours > 0 && minutes > 0) return `${hours} ч ${minutes} мин`;
  if (hours > 0) return `${hours} ч`;
  return `${minutes} мин`;
}

function normalizeTournamentGenderLabel(value: string | null | undefined) {
  const normalized = String(value || "").trim().toLowerCase();
  if (!normalized) return "";
  if (["male", "men", "m", "м", "мужской", "мужчины"].includes(normalized)) return "Мужчины";
  if (["female", "women", "f", "ж", "женский", "женщины"].includes(normalized)) return "Женщины";
  if (["mixed", "mix", "микст", "м/ж"].includes(normalized)) return "М/Ж";
  if (["any", "all", "open", "любой", "любой пол", "без ограничений"].includes(normalized)) return "М/Ж";
  return value?.trim() || "";
}

function getGameBookingIds(game: PadelGameRecord | undefined) {
  const bookingIds = Array.isArray(game?.booking?.bookingIds) ? game.booking.bookingIds : [];
  const metadataBookingIds = Array.isArray(game?.metadata?.bookingIds) ? game.metadata.bookingIds : [];
  const singleBookingId = game?.booking?.bookingId ?? toTrimmedString(game?.metadata?.bookingId);

  return [...bookingIds, ...metadataBookingIds, singleBookingId]
    .map((value) => toTrimmedString(value))
    .filter(Boolean)
    .sort();
}

function getGameFeedDedupeKey(post: CommunityPost, game: PadelGameRecord | undefined) {
  const bookingIds = getGameBookingIds(game);
  if (bookingIds.length > 0) {
    return `booking:${bookingIds.join("|")}`;
  }

  const booking = game?.booking;
  const slotKey = [
    booking?.studioId,
    booking?.roomId,
    booking?.date,
    booking?.timeFrom,
    booking?.timeTo,
  ]
    .map((value) => toTrimmedString(value))
    .join("|");

  if (slotKey.replace(/\|/g, "")) {
    return `slot:${slotKey}`;
  }

  return post.relatedGameId ? `game:${post.relatedGameId}` : `post:${post.id}`;
}

function getGamePostDisplayScore(post: CommunityPost, game: PadelGameRecord | undefined) {
  const confirmedPlayersCount = getConfirmedPlayers(game).length;
  const waitlistPlayersCount = getWaitlistPlayers(game).length;
  const hasResult = getMatchResultDisplayState(game) !== "none" ? 1000 : 0;
  const hasInvite = game?.inviteUrl || game?.invite?.waitlistEnabled ? 100 : 0;
  return hasResult + hasInvite + (confirmedPlayersCount * 10) + waitlistPlayersCount + (post.createdTs / 1_000_000_000_000_000);
}

function dedupeGameFeedPosts(posts: CommunityPost[], gameById: Map<string, PadelGameRecord>) {
  const selectedByKey = new Map<string, { post: CommunityPost; game: PadelGameRecord | undefined; score: number }>();
  const result: CommunityPost[] = [];

  posts.forEach((post) => {
    if (post.kind !== "GAME") {
      result.push(post);
      return;
    }

    const game = post.relatedGameId ? gameById.get(post.relatedGameId) : undefined;
    const dedupeKey = getGameFeedDedupeKey(post, game);
    const score = getGamePostDisplayScore(post, game);
    const current = selectedByKey.get(dedupeKey);

    if (!current || score > current.score) {
      selectedByKey.set(dedupeKey, { post, game, score });
    }
  });

  const selectedGamePostIds = new Set(
    Array.from(selectedByKey.values()).map((entry) => entry.post.id),
  );

  posts.forEach((post) => {
    if (post.kind === "GAME" && !selectedGamePostIds.has(post.id)) {
      return;
    }
    if (post.kind === "GAME") {
      result.push(post);
    }
  });

  return result;
}

function buildOrganizerUser(post: CommunityPost, game: PadelGameRecord | undefined): User | null {
  if (game?.organizer?.name) {
    return fallbackUser(
      game.organizer.name,
      game.organizer.id || normalizePhone(game.organizer.phone) || `organizer:${post.id}`,
      resolveTrustedOrganizerAvatar(game),
    );
  }

  if (post.memberPreview) {
    return toUserFromPreview(post.memberPreview);
  }

  if (post.authorName) {
    return fallbackUser(post.authorName, `author:${post.id}`);
  }

  return null;
}

function mergePlayersWithOrganizer(players: User[], organizer: User | null): User[] {
  if (!organizer) return players;
  if (players.length === 0) return [organizer];

  const normalizedOrganizerName = organizer.name.trim().toLowerCase();
  const sameIndex = players.findIndex((player) => (
    player.id === organizer.id
    || player.name.trim().toLowerCase() === normalizedOrganizerName
  ));

  if (sameIndex >= 0) {
    const matched = players[sameIndex];
    const hasAvatar = Boolean(matched.avatarUrl || matched.avatar);
    if (hasAvatar) return players;

    const nextPlayers = [...players];
    nextPlayers[sameIndex] = {
      ...matched,
      avatarUrl: organizer.avatarUrl,
      avatar: organizer.avatar,
    };
    return nextPlayers;
  }

  return [organizer, ...players];
}

function buildGameDateTime(post: CommunityPost, game: PadelGameRecord | undefined) {
  const bookingDate = game?.booking?.date?.trim();
  const timeFrom = game?.booking?.timeFrom?.trim();
  if (bookingDate && timeFrom) {
    return `${bookingDate}T${timeFrom}:00`;
  }
  if (bookingDate) {
    return `${bookingDate}T12:00:00`;
  }
  return post.publishedAt;
}

function buildGameLocation(post: CommunityPost, game: PadelGameRecord | undefined) {
  const location = [game?.booking?.studioName, game?.booking?.roomName]
    .map((value) => value?.trim() || "")
    .filter(Boolean)
    .join(" • ");

  return location || post.previewLabel || "Локация уточняется";
}

function buildGameDateLine(post: CommunityPost, game: PadelGameRecord | undefined) {
  const timeFrom = game?.booking?.timeFrom?.trim();
  const timeTo = game?.booking?.timeTo?.trim();
  const timeLabel = [timeFrom, timeTo].filter(Boolean).join(" – ");
  const location = buildGameLocation(post, game);
  return [timeLabel, location].filter(Boolean).join(" • ");
}

function getGameTotalSlots(game: PadelGameRecord | undefined) {
  const maxPlayers = game?.invite?.maxPlayers;
  if (typeof maxPlayers === "number" && Number.isFinite(maxPlayers) && maxPlayers > 0) {
    return Math.max(2, Math.round(maxPlayers));
  }

  const format =
    game?.metadata && typeof game.metadata.gameFormat === "string"
      ? game.metadata.gameFormat.trim().toLowerCase()
      : "";
  return format === "singles" ? 2 : 4;
}

function getConfirmedPlayers(game: PadelGameRecord | undefined) {
  return mergeGamePlayers((game?.participants ?? []).filter((player) => player.status !== "WAITLIST"));
}

function getWaitlistPlayers(game: PadelGameRecord | undefined) {
  return mergeGamePlayers(game?.waitlist ?? []);
}

function isPrivateGameRecord(game: PadelGameRecord | undefined) {
  return game?.settings?.isPrivate === true;
}

function getGameMatchResult(game: PadelGameRecord | undefined) {
  const metadata = game?.metadata;
  if (!metadata || typeof metadata !== "object" || Array.isArray(metadata)) return null;
  const rawMatchResult = (metadata as Record<string, unknown>).matchResult;
  return rawMatchResult && typeof rawMatchResult === "object" && !Array.isArray(rawMatchResult)
    ? rawMatchResult as Record<string, unknown>
    : null;
}

function normalizeMatchResultStatus(value: unknown) {
  return typeof value === "string" ? value.trim().toUpperCase() : "";
}

function parseIsoTimestamp(value: unknown) {
  if (typeof value !== "string") return null;
  const parsed = Date.parse(value.trim());
  return Number.isFinite(parsed) ? parsed : null;
}

function getIdentityKeys(value: unknown) {
  if (!value) return [] as string[];

  if (typeof value === "string") {
    const normalized = value.trim();
    if (!normalized) return [] as string[];
    const normalizedPhone = normalizePhone(normalized);
    return [
      `raw:${normalized}`,
      normalizedPhone ? `phone:${normalizedPhone}` : null,
      `name:${normalized.toLowerCase()}`,
    ].filter((item): item is string => Boolean(item));
  }

  if (typeof value === "object" && !Array.isArray(value)) {
    const record = value as Record<string, unknown>;
    const id = typeof record.id === "string" ? record.id.trim() : "";
    const phone = typeof record.phone === "string" ? normalizePhone(record.phone) : null;
    const name = typeof record.name === "string" ? record.name.trim().toLowerCase() : "";
    return [
      id ? `id:${id}` : null,
      phone ? `phone:${phone}` : null,
      name ? `name:${name}` : null,
    ].filter((item): item is string => Boolean(item));
  }

  return [] as string[];
}

function getResultTeamSlots(game: PadelGameRecord | undefined) {
  const metadata = game?.metadata;
  if (metadata && typeof metadata === "object" && !Array.isArray(metadata)) {
    const rawTeamSlots = (metadata as Record<string, unknown>).teamSlots;
    if (Array.isArray(rawTeamSlots) && rawTeamSlots.length > 0) {
      return rawTeamSlots.slice(0, 4);
    }
  }

  return getConfirmedPlayers(game).slice(0, 4);
}

function getTeamIndexForIdentity(
  teamSlots: unknown[],
  identity: unknown,
) {
  const identityKeys = new Set(getIdentityKeys(identity));
  if (identityKeys.size === 0) return null;

  for (let index = 0; index < Math.min(teamSlots.length, 4); index += 1) {
    const slotKeys = getIdentityKeys(teamSlots[index]);
    if (slotKeys.some((key) => identityKeys.has(key))) {
      return index < 2 ? 1 : 2;
    }
  }

  return null;
}

function getMatchResultDisplayState(game: PadelGameRecord | undefined) {
  const rawMatchResult = getGameMatchResult(game);
  if (!rawMatchResult) return "none" as const;

  const status = normalizeMatchResultStatus(rawMatchResult.status);
  if (status === "CONFIRMED" || Boolean(rawMatchResult.confirmedAt || rawMatchResult.confirmedBy)) {
    return "confirmed" as const;
  }
  if (status === "DISPUTED" || Boolean(rawMatchResult.disputedAt || rawMatchResult.disputedBy)) {
    return "disputed" as const;
  }
  if (
    status === "PENDING_CONFIRMATION"
    || status === "PENDING_DISPUTE"
    || Boolean(rawMatchResult.submittedAt || rawMatchResult.submittedBy)
  ) {
    return "pending" as const;
  }

  return "none" as const;
}

function canCurrentUserDisputeMatchResult(
  game: PadelGameRecord | undefined,
  currentUser: {
    id?: string | null;
    phone?: string | null;
  },
) {
  const rawMatchResult = getGameMatchResult(game);
  if (!rawMatchResult) return false;
  if (getMatchResultDisplayState(game) !== "pending") return false;

  const disputeDeadlineTs = parseIsoTimestamp(rawMatchResult.disputeDeadlineAt);
  if (disputeDeadlineTs != null && disputeDeadlineTs <= Date.now()) {
    return false;
  }

  const teamSlots = getResultTeamSlots(game);
  const currentUserTeamIndex = getTeamIndexForIdentity(teamSlots, {
    id: currentUser.id ?? null,
    phone: currentUser.phone ?? null,
  });
  const submittedByTeamIndex = getTeamIndexForIdentity(teamSlots, rawMatchResult.submittedBy);

  return currentUserTeamIndex != null
    && submittedByTeamIndex != null
    && currentUserTeamIndex !== submittedByTeamIndex;
}

function getGameEndTimestamp(game: PadelGameRecord | undefined, fallbackIso: string) {
  const date = game?.booking?.date?.trim();
  const timeTo = game?.booking?.timeTo?.trim();
  const timeFrom = game?.booking?.timeFrom?.trim();

  if (date && timeTo) {
    const parsed = Date.parse(`${date}T${timeTo}:00`);
    if (Number.isFinite(parsed)) return parsed;
  }

  if (date && timeFrom) {
    const parsedStart = Date.parse(`${date}T${timeFrom}:00`);
    const durationMinutes = game?.booking?.durationMinutes ?? 60;
    if (Number.isFinite(parsedStart) && Number.isFinite(durationMinutes)) {
      return parsedStart + (Math.max(30, durationMinutes) * 60_000);
    }
  }

  const fallbackTs = Date.parse(fallbackIso);
  return Number.isFinite(fallbackTs) ? fallbackTs : null;
}

function getMatchResultScore(game: PadelGameRecord | undefined) {
  const rawMatchResult = getGameMatchResult(game);
  const rawSets = Array.isArray(rawMatchResult?.sets) ? rawMatchResult.sets : [];
  const completedSets = rawSets
    .map((item) => {
      if (!item || typeof item !== "object" || Array.isArray(item)) return null;
      const record = item as Record<string, unknown>;
      const left = Number(record.left);
      const right = Number(record.right);
      if (!Number.isFinite(left) || !Number.isFinite(right)) return null;
      return {
        left: Math.max(0, Math.floor(left)),
        right: Math.max(0, Math.floor(right)),
      };
    })
    .filter((item): item is { left: number; right: number } => Boolean(item));

  if (completedSets.length === 0) return null;
  return completedSets.map((setItem) => `${setItem.left}:${setItem.right}`).join(" · ");
}

function buildResultTeams(
  game: PadelGameRecord | undefined,
  players: User[],
  organizerUser: User | null,
) {
  const confirmedPlayers = getConfirmedPlayers(game);
  const metadata = game?.metadata;
  const participantKeyMap = new Map<string, User>();

  const pushUser = (user: User | null | undefined) => {
    if (!user) return;
    participantKeyMap.set(user.id, user);
  };

  players.forEach(pushUser);
  pushUser(organizerUser);
  confirmedPlayers.forEach((player) => {
    const key = getPlayerIdentityKey(player);
    if (!key) return;
    participantKeyMap.set(key, toUserFromPlayer(player));
  });

  const resolveUser = (value: unknown): User | null => {
    if (typeof value === "string") {
      const byRaw = participantKeyMap.get(value.trim());
      if (byRaw) return byRaw;
      const byPhone = participantKeyMap.get(`phone:${normalizePhone(value) || ""}`);
      if (byPhone) return byPhone;
    }

    if (value && typeof value === "object" && !Array.isArray(value)) {
      const record = value as Record<string, unknown>;
      const byId = typeof record.id === "string" ? participantKeyMap.get(`id:${record.id.trim()}`) : null;
      if (byId) return byId;
      const byPhone = typeof record.phone === "string"
        ? participantKeyMap.get(`phone:${normalizePhone(record.phone) || ""}`)
        : null;
      if (byPhone) return byPhone;
      const byName = typeof record.name === "string"
        ? participantKeyMap.get(`name:${record.name.trim().toLowerCase()}`)
        : null;
      if (byName) return byName;
    }

    return null;
  };

  const rawTeamSlots = metadata && typeof metadata === "object" && !Array.isArray(metadata) && Array.isArray((metadata as Record<string, unknown>).teamSlots)
    ? (metadata as Record<string, unknown>).teamSlots as unknown[]
    : [];
  const slotUsers = rawTeamSlots.slice(0, 4).map(resolveUser);
  const left = slotUsers.slice(0, 2).filter((item): item is User => Boolean(item));
  const right = slotUsers.slice(2, 4).filter((item): item is User => Boolean(item));

  if (left.length > 0 && right.length > 0) {
    return { left, right };
  }

  const fallbackPlayers = players.slice(0, 4);
  const middle = Math.ceil(fallbackPlayers.length / 2);
  return {
    left: fallbackPlayers.slice(0, middle),
    right: fallbackPlayers.slice(middle, 4),
  };
}

function getGameLevel(
  community: Pick<CommunityRecord, "minimumLevel">,
  post: CommunityPost,
  game: PadelGameRecord | undefined,
  players: User[],
) {
  const range = [game?.settings?.minRating, game?.settings?.maxRating].filter(Boolean).join(" – ");
  if (range) return range;
  const previewLevel = post.memberPreview?.levelLabel?.trim();
  if (previewLevel) return previewLevel;
  const playerLevel = players.find((player) => player.level)?.level?.trim();
  if (playerLevel) return playerLevel;
  return community.minimumLevel || "D+";
}

function isCurrentUserInGame(
  game: PadelGameRecord | undefined,
  currentUserId: string | null | undefined,
  currentUserPhone: string | null | undefined,
) {
  const normalizedPhone = normalizePhone(currentUserPhone);
  const playerMatch = (player: PadelGamePlayer) => {
    const byId = Boolean(currentUserId && player.id && player.id === currentUserId);
    const byPhone = Boolean(normalizedPhone && player.phone && normalizePhone(player.phone) === normalizedPhone);
    return byId || byPhone;
  };

  if ((game?.participants ?? []).some(playerMatch)) return true;
  if ((game?.waitlist ?? []).some(playerMatch)) return true;

  const phoneLists = [
    ...(game?.participantPhones ?? []),
    ...(game?.waitlistPhones ?? []),
    ...(game?.allRelatedPhones ?? []),
  ]
    .map((value) => normalizePhone(value))
    .filter((value): value is string => Boolean(value));

  return Boolean(normalizedPhone && phoneLists.includes(normalizedPhone));
}

function toIsoDate(value: string) {
  const parsed = Date.parse(value);
  if (!Number.isFinite(parsed)) return value;
  return new Date(parsed).toISOString();
}

function pickTournamentLevel(text: string) {
  const matched = text.match(/\b(?:level\s*)?(D\+?|C\+?|B\+?|A)\b/i);
  return matched?.[1]?.toUpperCase();
}

function pickTournamentPairCount(text: string) {
  const matched = text.match(/\b(\d{1,2})\s*пар\b/i);
  if (!matched) return null;
  const parsed = Number.parseInt(matched[1], 10);
  return Number.isFinite(parsed) ? parsed : null;
}

function pickParticipantsProgress(text: string) {
  const matched = text.match(/\b(\d{1,3})\s*\/\s*(\d{1,3})\b/);
  if (!matched) return null;
  const participants = Number.parseInt(matched[1], 10);
  const maxParticipants = Number.parseInt(matched[2], 10);
  if (!Number.isFinite(participants) || !Number.isFinite(maxParticipants)) return null;
  return { participants, maxParticipants };
}

function pickTime(text: string) {
  const matched = text.match(/\b(\d{1,2}):(\d{2})\b/);
  if (!matched) return null;
  const hours = Number.parseInt(matched[1], 10);
  const minutes = Number.parseInt(matched[2], 10);
  if (!Number.isFinite(hours) || !Number.isFinite(minutes)) return null;
  return `${String(hours).padStart(2, "0")}:${String(minutes).padStart(2, "0")}`;
}

const TOURNAMENT_MONTH_INDEX_BY_TOKEN: Record<string, number> = {
  "янв": 0,
  "январь": 0,
  "января": 0,
  "фев": 1,
  "февраль": 1,
  "февраля": 1,
  "мар": 2,
  "март": 2,
  "марта": 2,
  "апр": 3,
  "апрель": 3,
  "апреля": 3,
  "май": 4,
  "мая": 4,
  "июн": 5,
  "июнь": 5,
  "июня": 5,
  "июл": 6,
  "июль": 6,
  "июля": 6,
  "авг": 7,
  "август": 7,
  "августа": 7,
  "сен": 8,
  "сент": 8,
  "сентябрь": 8,
  "сентября": 8,
  "окт": 9,
  "октябрь": 9,
  "октября": 9,
  "ноя": 10,
  "ноябрь": 10,
  "ноября": 10,
  "дек": 11,
  "декабрь": 11,
  "декабря": 11,
};

function buildLocalDateTimeLabel(
  year: number,
  monthIndex: number,
  day: number,
  time = "10:00",
) {
  const [hoursRaw = "10", minutesRaw = "00"] = time.split(":");
  const hours = Number.parseInt(hoursRaw, 10);
  const minutes = Number.parseInt(minutesRaw, 10);
  return `${String(year).padStart(4, "0")}-${String(monthIndex + 1).padStart(2, "0")}-${String(day).padStart(2, "0")}T${String(Number.isFinite(hours) ? hours : 10).padStart(2, "0")}:${String(Number.isFinite(minutes) ? minutes : 0).padStart(2, "0")}:00`;
}

function resolveEventYear(day: number, monthIndex: number, fallbackDate: Date) {
  const fallbackStart = new Date(
    fallbackDate.getFullYear(),
    fallbackDate.getMonth(),
    fallbackDate.getDate(),
  );
  const sameYear = new Date(fallbackDate.getFullYear(), monthIndex, day);
  const diffDays = Math.round((sameYear.getTime() - fallbackStart.getTime()) / (1000 * 60 * 60 * 24));

  if (diffDays < -120) return fallbackDate.getFullYear() + 1;
  if (diffDays > 240) return fallbackDate.getFullYear() - 1;
  return fallbackDate.getFullYear();
}

function pickTournamentEventDate(text: string, fallbackIso: string, startTime: string) {
  const fallbackParsed = Date.parse(fallbackIso);
  const fallbackDate = Number.isFinite(fallbackParsed) ? new Date(fallbackParsed) : new Date();

  const isoDateMatch = text.match(/\b(20\d{2})-(\d{2})-(\d{2})\b/);
  if (isoDateMatch) {
    const year = Number.parseInt(isoDateMatch[1], 10);
    const monthIndex = Number.parseInt(isoDateMatch[2], 10) - 1;
    const day = Number.parseInt(isoDateMatch[3], 10);
    if (monthIndex >= 0 && monthIndex <= 11 && day >= 1 && day <= 31) {
      return buildLocalDateTimeLabel(year, monthIndex, day, startTime);
    }
  }

  const dotDateMatch = text.match(/\b(\d{1,2})\.(\d{1,2})(?:\.(20\d{2}))?\b/);
  if (dotDateMatch) {
    const day = Number.parseInt(dotDateMatch[1], 10);
    const monthIndex = Number.parseInt(dotDateMatch[2], 10) - 1;
    const year = dotDateMatch[3]
      ? Number.parseInt(dotDateMatch[3], 10)
      : resolveEventYear(day, monthIndex, fallbackDate);
    if (monthIndex >= 0 && monthIndex <= 11 && day >= 1 && day <= 31) {
      return buildLocalDateTimeLabel(year, monthIndex, day, startTime);
    }
  }

  const slashDateMatch = text.match(/\b(\d{1,2})\/(\d{1,2})\/(20\d{2})\b/);
  if (slashDateMatch) {
    const day = Number.parseInt(slashDateMatch[1], 10);
    const monthIndex = Number.parseInt(slashDateMatch[2], 10) - 1;
    const year = Number.parseInt(slashDateMatch[3], 10);
    if (monthIndex >= 0 && monthIndex <= 11 && day >= 1 && day <= 31) {
      return buildLocalDateTimeLabel(year, monthIndex, day, startTime);
    }
  }

  const monthDateMatch = text.match(
    /\b(\d{1,2})\s+(января|январь|янв|февраля|февраль|фев|марта|март|мар|апреля|апрель|апр|мая|май|июня|июнь|июн|июля|июль|июл|августа|август|авг|сентября|сентябрь|сент|сен|октября|октябрь|окт|ноября|ноябрь|ноя|декабря|декабрь|дек)(?:\s+(20\d{2}))?\b/i,
  );
  if (monthDateMatch) {
    const day = Number.parseInt(monthDateMatch[1], 10);
    const normalizedMonthToken = monthDateMatch[2].trim().toLowerCase();
    const monthIndex = TOURNAMENT_MONTH_INDEX_BY_TOKEN[normalizedMonthToken];
    const year = monthDateMatch[3]
      ? Number.parseInt(monthDateMatch[3], 10)
      : resolveEventYear(day, monthIndex, fallbackDate);

    if (Number.isInteger(monthIndex) && day >= 1 && day <= 31) {
      return buildLocalDateTimeLabel(year, monthIndex, day, startTime);
    }
  }

  return buildLocalDateTimeLabel(
    fallbackDate.getFullYear(),
    fallbackDate.getMonth(),
    fallbackDate.getDate(),
    startTime,
  );
}

function pickTournamentStation(previewLabel: string | null | undefined, text: string) {
  const preview = (previewLabel || "").trim();
  if (preview) return preview;

  const explicitStationMatch = text.match(
    /\b(?:станция|клуб|локация|площадка)\s*[:\-]?\s*([^\n•,.;]+)/i,
  );
  const explicitStation = explicitStationMatch?.[1]?.trim();
  return explicitStation || null;
}

function pickTournamentType(text: string) {
  const knownTypes = [
    { pattern: /\bамерикано\b/i, label: "Американо" },
    { pattern: /\bмексикано\b/i, label: "Мексикано" },
    { pattern: /\bмикст\b/i, label: "Микст" },
    { pattern: /\bmixed\b/i, label: "Микст" },
    { pattern: /\bround\s*robin\b/i, label: "Round robin" },
    { pattern: /\bолимпийк[аи]\b/i, label: "Олимпийка" },
    { pattern: /\bсетк[аи]\b/i, label: "Сетка" },
  ];

  const matchedKnownType = knownTypes.find((item) => item.pattern.test(text));
  if (matchedKnownType) return matchedKnownType.label;

  const explicitTypeMatch = text.match(/\b(?:тип|формат)\s*[:\-]?\s*([^\n•,.;]+)/i);
  return explicitTypeMatch?.[1]?.trim() || null;
}

function normalizeTournamentRatingLabel(value: string | null | undefined) {
  const normalized = String(value || "")
    .replace(/\s+/g, " ")
    .replace(/\s*[–-]\s*/g, "–")
    .replace(/\s*\/\s*/g, "/")
    .trim();
  return normalized || null;
}

function pickTournamentRatingLabel(text: string, fallbackLevel: string | null | undefined) {
  const prefixedMatch = text.match(
    /\b(?:рейтинг|уровень)\s*[:\-]?\s*((?:[A-D]\+?)(?:\s*[–/-]\s*(?:[A-D]\+?))?|(?:\d(?:[.,]\d+)?)(?:\s*[–/-]\s*(?:\d(?:[.,]\d+)?))?)\b/i,
  );
  if (prefixedMatch) {
    return normalizeTournamentRatingLabel(prefixedMatch[1]?.replace(/,/g, "."));
  }

  const levelRangeMatch = text.match(/\b([A-D]\+?)\s*[–/-]\s*([A-D]\+?)\b/i);
  if (levelRangeMatch) {
    return normalizeTournamentRatingLabel(
      `${levelRangeMatch[1]?.toUpperCase()}/${levelRangeMatch[2]?.toUpperCase()}`,
    );
  }

  return normalizeTournamentRatingLabel(fallbackLevel?.toUpperCase());
}

function pickTournamentGenderLabel(text: string) {
  const explicitGenderMatch = text.match(
    /\b(?:пол|категория)\s*[:\-]?\s*(мужчины|мужской|женщины|женский|микст|mixed|любой пол|без ограничений)\b/i,
  );
  const explicitGender = explicitGenderMatch?.[1]?.trim().toLowerCase();
  if (explicitGender) {
    if (explicitGender === "мужчины" || explicitGender === "мужской") return "Мужчины";
    if (explicitGender === "женщины" || explicitGender === "женский") return "Женщины";
    if (explicitGender === "микст" || explicitGender === "mixed") return "Микст";
    return "Любой пол";
  }

  if (/\bмикст\b/i.test(text) || /\bmixed\b/i.test(text)) return "Микст";
  if (/\bмужчины\b/i.test(text) || /\bмужской\b/i.test(text)) return "Мужчины";
  if (/\bженщины\b/i.test(text) || /\bженский\b/i.test(text)) return "Женщины";
  if (/\bлюбой пол\b/i.test(text) || /\bбез ограничений\b/i.test(text)) return "Любой пол";
  return null;
}

function buildTournament(post: CommunityPost): Tournament {
  const details = post.details ?? {};
  const publicTournament =
    pickRecord(details, ["publicTournament", "tournament", "customTournament"]) ?? {};
  const skin = pickRecord(publicTournament, ["skin"]) ?? pickRecord(details, ["skin", "tournamentSkin"]) ?? {};
  const searchableText = [post.previewLabel, post.body, post.title].filter(Boolean).join(" • ");
  const parsedProgress = pickParticipantsProgress(searchableText);
  const pairCount = pickTournamentPairCount(searchableText);
  const maxParticipants =
    pickNumberValue(publicTournament, ["maxPlayers"], null) ??
    pickNumberValue(details, ["maxPlayers"], null) ??
    parsedProgress?.maxParticipants ??
    (pairCount ? pairCount * 2 : 16);
  const participants =
    pickNumberValue(publicTournament, ["participantsCount"], null) ??
    pickNumberValue(details, ["participantsCount"], null) ??
    parsedProgress?.participants ??
    0;
  const waitlistCount =
    pickNumberValue(publicTournament, ["waitlistCount"], null) ??
    pickNumberValue(details, ["waitlistCount"], 0) ??
    0;
  const level = pickTournamentLevel(searchableText);
  const startsAt =
    pickStringValue(publicTournament, ["startsAt", "startAt"]) ||
    pickStringValue(details, ["startsAt", "startAt"]) ||
    "";
  const endsAt =
    pickStringValue(publicTournament, ["endsAt", "endAt"]) ||
    pickStringValue(details, ["endsAt", "endAt"]) ||
    "";
  const startTime = formatIsoTime(startsAt) || (pickTime(searchableText) ?? (() => {
    const parsed = Date.parse(post.publishedAt);
    if (!Number.isFinite(parsed)) return "10:00";
    return new Date(parsed).toLocaleTimeString("ru-RU", { hour: "2-digit", minute: "2-digit" });
  })());
  const eventDate = startsAt || pickTournamentEventDate(searchableText, toIsoDate(post.publishedAt), startTime);
  const stationLabel =
    pickStringValue(publicTournament, ["studioName", "stationName", "clubName"]) ||
    pickStringValue(details, ["studioName", "stationName", "clubName"]) ||
    pickTournamentStation(post.previewLabel, searchableText) ||
    "Станция уточняется";
  const tournamentTypeLabel =
    pickStringValue(publicTournament, ["tournamentType"]) ||
    pickStringValue(details, ["tournamentType"]) ||
    pickTournamentType(searchableText) ||
    "Турнир";
  const ratingLabel =
    pickStringValue(details, ["levelLabel"]) ||
    formatAccessLevelRange(publicTournament.accessLevels || details.accessLevels) ||
    pickTournamentRatingLabel(searchableText, level);
  const genderLabel =
    normalizeTournamentGenderLabel(
      pickStringValue(publicTournament, ["gender"]) ||
      pickStringValue(details, ["gender"]),
    ) ||
    pickTournamentGenderLabel(searchableText) ||
    "М/Ж";
  const slotsLabel = `${participants}/${maxParticipants} мест`;
  const trainerName =
    pickStringValue(publicTournament, ["trainerName"]) ||
    pickStringValue(details, ["trainerName"]) ||
    post.authorName ||
    "PadelHub";
  const trainerAvatarUrl =
    pickStringValue(publicTournament, ["trainerAvatarUrl"]) ||
    pickStringValue(details, ["trainerAvatarUrl"]) ||
    pickStringValue(skin, ["imageUrl"]) ||
    post.authorAvatar ||
    post.imageUrl ||
    "";
  const title =
    pickStringValue(skin, ["title"]) ||
    pickStringValue(publicTournament, ["name", "title"]) ||
    post.title;
  const ctaLabel =
    pickStringValue(skin, ["ctaLabel"]) ||
    post.ctaLabel?.trim() ||
    "Записаться";
  const publicUrl =
    pickStringValue(publicTournament, ["publicUrl", "joinUrl"]) ||
    pickStringValue(details, ["publicUrl", "joinUrl"]) ||
    "";
  const endTime = formatIsoTime(endsAt);
  const duration = formatTournamentDuration(startsAt, endsAt);
  const spotsLeft = maxParticipants > 0 ? Math.max(0, maxParticipants - participants) : null;

  return {
    id: post.relatedTournamentId || post.id,
    badgeLabel: formatTournamentBadgeLabel(eventDate),
    title,
    subtitle: stationLabel,
    metaText: [tournamentTypeLabel, `Старт ${startTime}`, slotsLabel].join(" • "),
    progress: maxParticipants > 0 ? participants / maxParticipants : 0,
    imageUrl: trainerAvatarUrl || post.imageUrl || "",
    date: eventDate,
    level,
    participants,
    maxParticipants,
    startTime,
    endTime,
    duration,
    media: post.imageUrl ?? undefined,
    stationLabel,
    tournamentTypeLabel,
    ratingLabel: ratingLabel ?? undefined,
    genderLabel,
    slotsLabel,
    ctaLabel,
    trainerName,
    trainerAvatarUrl: trainerAvatarUrl || undefined,
    profileHandle: stationLabel,
    publicUrl: publicUrl || undefined,
    waitlistCount,
    spotsLeft,
    isJoined: Boolean(ctaLabel && /откры/i.test(ctaLabel)),
    isFull: maxParticipants > 0 && participants >= maxParticipants,
  };
}

function buildNewsPreviewText(value: string) {
  return value
    .replace(/\r\n?/g, "\n")
    .split("\n")
    .map((line) => line.replace(/[^\S\n]+/g, " ").trim())
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

function isCurrentUserAuthorOfPost(
  post: CommunityPost,
  currentUserId: string | null | undefined,
  currentUserPhone: string | null | undefined,
) {
  const normalizedCurrentUserId = (currentUserId || "").trim() || null;
  const normalizedCurrentUserPhone = normalizePhone(currentUserPhone);
  const postAuthorId = (post.memberPreview?.id || post.authorId || "").trim() || null;
  const postAuthorPhone = normalizePhone(post.memberPreview?.phone || post.authorPhone);

  return Boolean(
    (normalizedCurrentUserId && postAuthorId && normalizedCurrentUserId === postAuthorId)
    || (normalizedCurrentUserPhone && postAuthorPhone && normalizedCurrentUserPhone === postAuthorPhone),
  );
}

function buildNews(
  post: CommunityPost,
  communityName: string,
  currentUser: BuildFeedEntriesParams["currentUser"],
): News {
  const fullText = (post.body || "Обновление сообщества").trim();
  const plainText = stripNewsTextMarkup(fullText);
  const fallbackLikes = Math.max(4, Math.min(18, Math.round((post.body || post.title).length / 12)));
  const likes = Math.max(0, post.likesCount ?? fallbackLikes);
  const dislikes = Math.max(0, post.dislikesCount ?? 0);
  const comments = Math.max(
    0,
    post.commentsCount ?? Math.max(1, Math.min(8, Math.round(fallbackLikes / 2.8))),
  );
  const previewText = buildNewsPreviewText(plainText || fullText);
  return {
    id: post.id,
    badgeLabel: formatNewsBadgeLabel(post.publishedAt),
    publishedAt: post.publishedAt,
    title: post.title,
    text: fullText,
    previewText,
    fullText,
    likes,
    dislikes,
    comments,
    reaction:
      post.viewerReaction === "LIKE"
        ? "like"
        : post.viewerReaction === "DISLIKE"
          ? "dislike"
          : null,
    media: post.imageUrl ?? undefined,
    imageUrl: post.imageUrl ?? "",
    author:
      toUserFromPreview(post.memberPreview)
      ?? (post.authorName
        ? fallbackUser(post.authorName, `author:${post.id}`, post.authorAvatar)
        : fallbackUser(communityName, `community:${post.communityId}`, post.authorAvatar)),
    canEdit: isCurrentUserAuthorOfPost(post, currentUser.id, currentUser.phone),
  };
}

function compareName(left: string, right: string) {
  return left.localeCompare(right, "ru-RU");
}

function isSameDay(timestamp: number, compareTo: number) {
  const left = new Date(timestamp);
  const right = new Date(compareTo);
  return left.getFullYear() === right.getFullYear()
    && left.getMonth() === right.getMonth()
    && left.getDate() === right.getDate();
}

function getEventTimestamp(entry: FeedEntry) {
  const value =
    entry.item.type === "game"
      ? entry.item.data.datetime
      : entry.item.type === "tournament"
        ? `${entry.item.data.date}T${entry.item.data.startTime}:00`
        : entry.publishedAt;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : Date.parse(entry.publishedAt);
}

function getGameRank(entry: FeedEntry) {
  if (entry.item.type !== "game") return null;
  if (entry.item.data.isPastGame) return 3;
  const gameTimestamp = getEventTimestamp(entry);
  const isToday = Number.isFinite(gameTimestamp) && isSameDay(gameTimestamp, Date.now());
  return isToday && entry.item.data.slotsLeft > 0 ? 0 : 1;
}

function getSortRank(entry: FeedEntry) {
  if (entry.item.type === "game") return getGameRank(entry) ?? 1;
  if (entry.item.type === "tournament") return 2;
  if (entry.item.type === "news") return 3;
  return 4;
}

function compareEventDistance(leftTs: number, rightTs: number) {
  const now = Date.now();
  const leftDistance = leftTs >= now ? leftTs - now : Number.MAX_SAFE_INTEGER + (now - leftTs);
  const rightDistance = rightTs >= now ? rightTs - now : Number.MAX_SAFE_INTEGER + (now - rightTs);
  return leftDistance - rightDistance;
}

function sortFeedEntries(entries: FeedEntry[]) {
  return [...entries].sort((left, right) => {
    const rankDiff = getSortRank(left) - getSortRank(right);
    if (rankDiff !== 0) return rankDiff;

    if (
      left.item.type === "game"
      || left.item.type === "tournament"
      || left.item.type === "news"
    ) {
      if (
        left.item.type === "news"
        || right.item.type === "news"
        || (left.item.type === "game" && left.item.data.isPastGame)
        || (right.item.type === "game" && right.item.data.isPastGame)
      ) {
        const publishedDiff = getEventTimestamp(right) - getEventTimestamp(left);
        if (publishedDiff !== 0) return publishedDiff;
      }

      const eventDiff = compareEventDistance(getEventTimestamp(left), getEventTimestamp(right));
      if (eventDiff !== 0) return eventDiff;
    }

    return compareName(left.id, right.id);
  });
}

export function buildFeedEntries({
  community,
  posts,
  games,
  currentUser,
}: BuildFeedEntriesParams): FeedEntry[] {
  const gameById = new Map(
    games
      .filter((game) => Boolean(game.id))
      .map((game) => [game.id, game] as const),
  );

  const entries: FeedEntry[] = [];
  const visiblePosts = dedupeGameFeedPosts(posts, gameById);

  visiblePosts.forEach((post) => {
    if (!isVisibleCommunityPostKind(post.kind)) {
      return;
    }

    if (post.kind === "GAME") {
      const game = post.relatedGameId ? gameById.get(post.relatedGameId) : undefined;
      if (isPrivateGameRecord(game)) {
        return;
      }
      const isCurrentUserParticipant = isCurrentUserInGame(game, currentUser.id, currentUser.phone);
      const confirmedPlayers = getConfirmedPlayers(game);
      const waitlistPlayers = getWaitlistPlayers(game).map(toUserFromPlayer);
      const totalSlots = getGameTotalSlots(game);
      const organizerUser = buildOrganizerUser(post, game);
      const players = mergePlayersWithOrganizer(
        confirmedPlayers.map(toUserFromPlayer),
        organizerUser,
      );
      const occupiedSlots = Math.max(confirmedPlayers.length, players.length);
      const slotsLeft = Math.max(totalSlots - occupiedSlots, 0);
      const gameEndTs = getGameEndTimestamp(game, buildGameDateTime(post, game));
      const isPastGame = gameEndTs !== null && gameEndTs <= Date.now();
      const resultDisplayState = getMatchResultDisplayState(game);
      const resultScore = resultDisplayState !== "none" ? getMatchResultScore(game) : null;
      const hasVisibleResult = Boolean(resultScore);
      const hasConfirmedResult = resultDisplayState === "confirmed" && hasVisibleResult;
      const hasPendingResult = resultDisplayState === "pending" && hasVisibleResult;
      const isResultDisputed = resultDisplayState === "disputed" && hasVisibleResult;
      const canDisputeResult = hasPendingResult
        && canCurrentUserDisputeMatchResult(game, currentUser);
      const needsResult = isPastGame && !hasVisibleResult;
      if (needsResult && !isCurrentUserParticipant) {
        return;
      }
      const resultTeams = hasVisibleResult ? buildResultTeams(game, players, organizerUser) : null;
      const resultStatusLabel = hasPendingResult
        ? (canDisputeResult ? "Можно оспорить" : "На оспаривании")
        : isResultDisputed
          ? "Результат оспорен"
          : null;
      const ctaLabel = hasConfirmedResult || hasPendingResult || isResultDisputed
        ? "Открыть игру"
        : needsResult
          ? "Внести результаты игры"
          : isCurrentUserParticipant
            ? "Открыть игру"
            : slotsLeft === 0
              ? "В лист ожидания"
              : "Играть";

      entries.push({
        id: `game:${post.id}`,
        item: {
          type: "game",
          data: {
            id: post.relatedGameId || post.id,
            isRatingGame: game?.settings?.ratingGame ?? null,
            dateMonth: formatDateMonthLabel(buildGameDateTime(post, game)),
            dateDay: formatDateDayLabel(buildGameDateTime(post, game)),
            dateWeekday: formatWeekdayLabel(buildGameDateTime(post, game)),
            badgeLabel: formatGameBadgeLabel(buildGameDateTime(post, game)),
            title: post.title,
            datetimeText: buildGameDateLine(post, game),
            duration: `${game?.booking?.durationMinutes ?? 60} мин`,
            level: getGameLevel(community, post, game, players),
            slotsText: formatSlotsLabel(slotsLeft),
            datetime: buildGameDateTime(post, game),
            location: buildGameLocation(post, game),
            slotsLeft,
            totalSlots,
            players,
            waitlistPlayers,
            extraPlayersCount: Math.max(players.length - 4, 0),
            confirmedPlayersCount: occupiedSlots,
            media: post.imageUrl ?? undefined,
            isJoined: isCurrentUserParticipant,
            isFull: slotsLeft === 0,
            ctaLabel,
            showWaitlist: !isPastGame && !hasConfirmedResult,
            isPastGame,
            needsResult,
            hasConfirmedResult,
            hasPendingResult,
            isResultDisputed,
            canDisputeResult,
            resultStatusLabel,
            resultScore,
            resultTeams,
          },
        },
        publishedAt: post.publishedAt,
        author:
          toUserFromPreview(post.memberPreview)
          ?? organizerUser
          ?? (post.authorName ? fallbackUser(post.authorName, `author:${post.id}`) : undefined),
        relatedGameId: post.relatedGameId,
      });
      return;
    }

    if (post.kind === "TOURNAMENT") {
      entries.push({
        id: `tournament:${post.id}`,
        item: {
          type: "tournament",
          data: buildTournament(post),
        },
        publishedAt: post.publishedAt,
        author: post.authorName ? fallbackUser(post.authorName, `author:${post.id}`) : undefined,
        relatedTournamentId: post.relatedTournamentId,
      });
      return;
    }

    if (post.kind === "PHOTO") {
      entries.push({
        id: `news:${post.id}`,
        item: {
          type: "news",
          data: buildNews(post, community.name, currentUser),
        },
        publishedAt: post.publishedAt,
      });
      return;
    }

  });

  return sortFeedEntries(entries);
}
