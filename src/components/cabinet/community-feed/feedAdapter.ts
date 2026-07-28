import type { PadelGamePlayer, PadelGameRecord } from "../../../utils/apiClient";
import { PUBLIC_INVITE_ORIGIN } from "../../../consts/api_config";
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
  formatRelativePublishedLabel,
  formatSlotsLabel,
  formatTournamentBadgeLabel,
  formatWeekdayLabel,
} from "./feedFormatters";
import { stripNewsTextMarkup } from "./newsTextFormatting";
import { appendCurrentAuthModeToNavigableUrl } from "../../../utils/authMode";
import { normalizeTournamentSignupPublicUrl } from "../../../utils/tournamentSignupEntry";

const PUBLIC_TOURNAMENT_ORIGIN = PUBLIC_INVITE_ORIGIN || "https://padlhub.ru";

interface BuildFeedEntriesParams {
  community: Pick<CommunityRecord, "id" | "name" | "members" | "minimumLevel">;
  posts: CommunityPost[];
  games: PadelGameRecord[];
  tournamentStats?: Record<string, TournamentStats | undefined>;
  currentUser: {
    id?: string | null;
    phone?: string | null;
  };
}

export interface TournamentStats {
  participantsCount?: number | null;
  maxParticipants?: number | null;
  waitlistCount?: number | null;
  publicTournament?: Record<string, unknown> | null;
}

function normalizePhone(value: string | null | undefined) {
  const digits = String(value || "").replace(/\D/g, "");
  if (!digits) return null;
  if (digits.length === 10) return `7${digits}`;
  if (digits.length === 11 && digits.startsWith("8")) return `7${digits.slice(1)}`;
  return digits;
}

function normalizeTournamentPublicUrl(value: string | null | undefined) {
  const raw = (value || "").trim();
  if (!raw) return "";

  return appendCurrentAuthModeToNavigableUrl(
    normalizeTournamentSignupPublicUrl(raw, { publicOrigin: PUBLIC_TOURNAMENT_ORIGIN }),
  ).toString();
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

function getSplitPaymentMetadata(game: PadelGameRecord | undefined) {
  const metadata = isRecord(game?.metadata) ? game.metadata : null;
  const splitPayment = metadata && isRecord(metadata.splitPayment)
    ? metadata.splitPayment
    : null;

  return splitPayment;
}

const INACTIVE_GAME_MEMBERSHIP_STATUS_MARKERS = [
  "CANCEL",
  "DECLIN",
  "FAIL",
  "ERROR",
  "EXPIRE",
  "REFUND",
  "REJECT",
  "VOID",
  "CLOSE",
  "ARCHIVE",
  "LEFT",
  "REMOV",
] as const;

function isInactiveGameMembershipStatus(value: unknown) {
  const status = String(value || "").trim().toUpperCase();
  if (!status) return false;
  return INACTIVE_GAME_MEMBERSHIP_STATUS_MARKERS.some((marker) => status.includes(marker));
}

function normalizeIdentityId(value: unknown) {
  if (typeof value !== "string") return null;
  const normalized = value.trim().toLowerCase();
  return normalized || null;
}

function playerMatchesIdentity(
  player: PadelGamePlayer,
  currentUserId: string | null,
  currentUserPhone: string | null,
) {
  if (isInactiveGameMembershipStatus(player.status)) return false;
  const byId = Boolean(currentUserId && normalizeIdentityId(player.id) === currentUserId);
  const playerPhone = normalizePhone(player.phone);
  const byPhone = Boolean(currentUserPhone && playerPhone && playerPhone === currentUserPhone);
  return byId || byPhone;
}

function splitPaymentItemMatchesIdentity(
  item: Record<string, unknown>,
  currentUserId: string | null,
  currentUserPhone: string | null,
) {
  if (isInactiveGameMembershipStatus(item.status)) return false;
  const itemIds = [item.clientId, item.playerId, item.userId, item.id]
    .map((value) => normalizeIdentityId(value))
    .filter((value): value is string => Boolean(value));
  if (currentUserId && itemIds.includes(currentUserId)) return true;

  const itemPhones = [
    item.clientPhoneNorm,
    item.phoneNorm,
    item.clientPhone,
    item.phone,
    item.phoneNumber,
    item.mobile,
  ]
    .map((value) => (typeof value === "string" ? normalizePhone(value) : null))
    .filter((value): value is string => Boolean(value));
  return Boolean(currentUserPhone && itemPhones.includes(currentUserPhone));
}

function hasActiveSplitPaymentIdentity(
  game: PadelGameRecord | undefined,
  currentUserId: string | null,
  currentUserPhone: string | null,
) {
  const splitPayment = getSplitPaymentMetadata(game);
  const payments = Array.isArray(splitPayment?.payments)
    ? splitPayment.payments.filter((item) => isRecord(item))
    : [];
  return payments.some((item) => splitPaymentItemMatchesIdentity(item, currentUserId, currentUserPhone));
}

function leaveEventMatchesIdentity(
  item: Record<string, unknown>,
  currentUserId: string | null,
  currentUserPhone: string | null,
) {
  const itemIds = [item.playerId, item.clientId, item.userId, item.id]
    .map((value) => normalizeIdentityId(value))
    .filter((value): value is string => Boolean(value));
  if (currentUserId && itemIds.includes(currentUserId)) return true;

  const itemPhones = [item.playerPhone, item.phoneNorm, item.phone, item.clientPhone]
    .map((value) => (typeof value === "string" ? normalizePhone(value) : null))
    .filter((value): value is string => Boolean(value));
  return Boolean(currentUserPhone && itemPhones.includes(currentUserPhone));
}

function hasLeaveEventForIdentity(
  game: PadelGameRecord | undefined,
  currentUserId: string | null,
  currentUserPhone: string | null,
) {
  const metadata = isRecord(game?.metadata) ? game.metadata : null;
  const sources = [metadata?.leaveEvents, metadata?.playerLeaveEvents, metadata?.leftPlayers];
  return sources.some((source) => (
    Array.isArray(source)
    && source.some((item) => isRecord(item) && leaveEventMatchesIdentity(item, currentUserId, currentUserPhone))
  ));
}

function isSplitPaymentGame(game: PadelGameRecord | undefined) {
  if (!game) return false;
  if (game.settings?.payMode === "split") return true;

  const splitPayment = getSplitPaymentMetadata(game);
  return Boolean(splitPayment?.enabled);
}

function extractGameCustomTitle(metadata: Record<string, unknown> | null | undefined) {
  if (!metadata) return null;
  const value = typeof metadata.gameTitle === "string" ? metadata.gameTitle.trim() : "";
  return value || null;
}

function extractGameJoinPriceLabel(metadata: Record<string, unknown> | null | undefined) {
  if (!metadata) return null;
  if (typeof metadata.joinPrice === "number" && Number.isFinite(metadata.joinPrice)) {
    return formatRubPrice(Math.max(0, Math.round(metadata.joinPrice)));
  }
  const raw = typeof metadata.joinPrice === "string" ? metadata.joinPrice.trim() : "";
  if (!raw) return null;
  const digitsOnly = raw.replace(/[^\d]/g, "").replace(/^0+(?=\d)/, "");
  if (!digitsOnly) return null;
  const parsed = Number(digitsOnly);
  return Number.isFinite(parsed) ? formatRubPrice(parsed) : null;
}

function parseCustomRubPriceLabel(value: string) {
  const withoutCurrency = value
    .replace(/₽/g, "")
    .replace(/руб(?:\.|лей|ля|ль)?/gi, "")
    .replace(/\s*р\.?\s*$/i, "")
    .trim();
  if (!/^\d[\d\s.,\u00a0]*$/.test(withoutCurrency)) return null;

  const compact = withoutCurrency.replace(/[\s\u00a0]/g, "");
  const lastSeparatorIndex = Math.max(compact.lastIndexOf(","), compact.lastIndexOf("."));
  const normalized = lastSeparatorIndex >= 0
    ? (() => {
      const integerPart = compact.slice(0, lastSeparatorIndex).replace(/[.,]/g, "");
      const fractionalPart = compact.slice(lastSeparatorIndex + 1);
      return fractionalPart.length > 0 && fractionalPart.length <= 2
        ? `${integerPart}.${fractionalPart}`
        : compact.replace(/[.,]/g, "");
    })()
    : compact;
  const parsed = Number(normalized);
  return Number.isFinite(parsed) ? parsed : null;
}

function formatRubPrice(value: number | null) {
  if (value === null || !Number.isFinite(value)) return null;
  return `${Math.round(value).toLocaleString("ru-RU")} ₽`;
}

function normalizeCustomRubPriceLabel(value: string) {
  const label = value.trim();
  if (!label || label.includes("₽")) return label;
  const parsed = parseCustomRubPriceLabel(label);
  return parsed === null ? label : formatRubPrice(parsed) || label;
}

function formatTournamentCardPrice(value: number | null) {
  if (value === null || !Number.isFinite(value)) return null;
  const rubles = value >= 10000 ? value / 100 : value;
  return formatRubPrice(rubles);
}

function resolveTournamentPriceLabel(
  publicTournament: Record<string, unknown>,
  details: Record<string, unknown>,
  skin: Record<string, unknown>,
) {
  const skinPriceLabel = pickStringValue(skin, ["priceLabel", "priceText", "costLabel", "costText"]);
  if (skinPriceLabel) return normalizeCustomRubPriceLabel(skinPriceLabel);

  const skinPrice = pickNumberValue(skin, ["price", "amount", "cost", "customPrice", "customCost"], null);
  const source =
    pickRecord(details, ["sourceTournamentSnapshot", "sourceTournament", "tournament", "exercise", "baseTournament"]) ??
    publicTournament;
  const sourcePrice = pickNumberValue(source, ["price", "amount", "cost"], null);
  if (skinPrice !== null && sourcePrice !== null && Math.round(skinPrice) !== Math.round(sourcePrice)) {
    return formatTournamentCardPrice(skinPrice);
  }
  return "энергия";
}

function getSplitJoinPriceText(game: PadelGameRecord | undefined) {
  const metadata = isRecord(game?.metadata) ? game.metadata : null;
  const metadataJoinPriceLabel = extractGameJoinPriceLabel(metadata);
  if (!isSplitPaymentGame(game)) return metadataJoinPriceLabel;

  const splitPayment = getSplitPaymentMetadata(game);
  const shareAmountMinor = pickNumberValue(splitPayment, ["shareAmountMinor", "amountMinor", "toPayMinor"]);
  const shareAmount =
    pickNumberValue(splitPayment, ["shareAmount", "amount", "toPay"])
    ?? (shareAmountMinor !== null ? shareAmountMinor / 100 : null);

  return formatRubPrice(shareAmount) ?? metadataJoinPriceLabel;
}

function getSplitCancelDeadlineAt(game: PadelGameRecord | undefined) {
  if (!isSplitPaymentGame(game)) return null;

  const splitPayment = getSplitPaymentMetadata(game);
  const deadlineAt = pickStringValue(splitPayment, ["deadlineAt", "cancelAt", "expiresAt", "expires_at"]);
  if (!deadlineAt || !Number.isFinite(Date.parse(deadlineAt))) return null;

  return deadlineAt;
}

function normalizeStringArray(value: unknown) {
  return Array.isArray(value)
    ? value.map((item) => toTrimmedString(item)).filter(Boolean)
    : [];
}

function parseTournamentAccessLevel(value: string) {
  const normalized = value.replace(",", ".").trim();
  const parsed = Number.parseFloat(normalized);
  return Number.isFinite(parsed) ? parsed : null;
}

function formatTournamentAccessLevel(value: string) {
  const parsed = parseTournamentAccessLevel(value);
  if (parsed === null) return value;
  if (parsed < 2) return "D1";
  if (parsed < 3) return "D+";
  if (parsed < 3.5) return "C";
  if (parsed <= 4) return "C+";
  if (parsed < 4.7) return "B";
  if (parsed < 5.5) return "B+";
  return "A";
}

function formatAccessLevelRange(value: unknown) {
  const levels = normalizeStringArray(value);
  if (levels.length === 0) return "";

  const normalizedLevels = levels
    .map((level) => ({
      raw: level,
      numeric: parseTournamentAccessLevel(level),
      label: formatTournamentAccessLevel(level),
    }))
    .sort((left, right) => {
      if (left.numeric == null && right.numeric == null) return left.raw.localeCompare(right.raw, "ru-RU");
      if (left.numeric == null) return 1;
      if (right.numeric == null) return -1;
      return left.numeric - right.numeric;
    });

  if (normalizedLevels.length === 1) return normalizedLevels[0].label;
  return `${normalizedLevels[0].label} - ${normalizedLevels[normalizedLevels.length - 1].label}`;
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

function sanitizeGameLocationText(value: string | null | undefined) {
  const normalized = (value || "")
    .replace(/\s+/g, " ")
    .replace(/\s*•\s*/g, " • ")
    .trim();
  if (!normalized) return "";

  const withoutMap = normalized
    .replace(/\s+на карте\b/gi, "")
    .replace(/\s{2,}/g, " ")
    .trim();

  return withoutMap
    .split("•")
    .map((part) => part.trim())
    .filter(Boolean)
    .join(" • ");
}

function buildGameLocation(post: CommunityPost, game: PadelGameRecord | undefined) {
  const location = [game?.booking?.studioName, game?.booking?.roomName]
    .map((value) => value?.trim() || "")
    .filter(Boolean)
    .join(" • ");

  const fallbackLocation = sanitizeGameLocationText(post.previewLabel);
  return sanitizeGameLocationText(location) || fallbackLocation || "Локация уточняется";
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

function normalizeResultPairingSlots(value: unknown) {
  if (Array.isArray(value)) {
    if (Array.isArray(value[0]) || Array.isArray(value[1])) {
      return [
        ...(Array.isArray(value[0]) ? value[0] : []),
        ...(Array.isArray(value[1]) ? value[1] : []),
      ].slice(0, 4);
    }

    return value.slice(0, 4);
  }

  if (!value || typeof value !== "object") return null;
  const record = value as Record<string, unknown>;
  const left = Array.isArray(record.left)
    ? record.left
    : Array.isArray(record.teamA)
      ? record.teamA
      : Array.isArray(record.a)
        ? record.a
        : Array.isArray(record.team1)
          ? record.team1
          : Array.isArray(record.first)
            ? record.first
            : [];
  const right = Array.isArray(record.right)
    ? record.right
    : Array.isArray(record.teamB)
      ? record.teamB
      : Array.isArray(record.b)
        ? record.b
        : Array.isArray(record.team2)
          ? record.team2
          : Array.isArray(record.second)
            ? record.second
            : [];

  if (left.length > 0 || right.length > 0) {
    return [...left, ...right].slice(0, 4);
  }

  const slots = Array.isArray(record.teamSlots)
    ? record.teamSlots
    : Array.isArray(record.slots)
      ? record.slots
      : Array.isArray(record.players)
        ? record.players
        : Array.isArray(record.pairing)
          ? record.pairing
          : [];
  return slots.length > 0 ? slots.slice(0, 4) : null;
}

function getDisplayResultSlots(game: PadelGameRecord | undefined) {
  const rawMatchResult = getGameMatchResult(game);
  const rawSetPairings = Array.isArray(rawMatchResult?.setPairings) ? rawMatchResult.setPairings : [];
  let lastKnownSlots: unknown[] | null = null;

  rawSetPairings.forEach((pairing) => {
    const slots = normalizeResultPairingSlots(pairing);
    if (slots && slots.length > 0) {
      lastKnownSlots = slots;
    }
  });

  return lastKnownSlots ?? getResultTeamSlots(game);
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
  if (status === "DISPUTED" || Boolean(rawMatchResult.disputedAt || rawMatchResult.disputedBy)) {
    return "disputed" as const;
  }
  if (status === "NO_RESULT_EXPIRED") {
    return "none" as const;
  }
  if (status === "CONFIRMED" || Boolean(rawMatchResult.confirmedAt || rawMatchResult.confirmedBy)) {
    return "confirmed" as const;
  }
  if (
    status === "CORRECTION_PENDING"
    || status === "PENDING_REVIEW"
    || status === "PENDING_CONFIRMATION"
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
  const waitlistPlayers = getWaitlistPlayers(game);
  const participantKeyMap = new Map<string, User>();

  const pushUser = (key: string | null | undefined, user: User | null | undefined) => {
    if (!key || !user) return;
    participantKeyMap.set(key, user);
  };

  const pushIdentityUser = (
    user: User | null | undefined,
    identity: {
      id?: string | null;
      phone?: string | null;
      name?: string | null;
      memberKey?: string | null;
    } | null | undefined,
  ) => {
    if (!user) return;
    pushUser(user.id, user);
    if (!identity) return;
    const normalizedPhone = typeof identity.phone === "string" ? normalizePhone(identity.phone) : null;
    pushUser(typeof identity.memberKey === "string" ? identity.memberKey.trim() : null, user);
    pushUser(typeof identity.id === "string" ? `id:${identity.id.trim()}` : null, user);
    pushUser(normalizedPhone ? `phone:${normalizedPhone}` : null, user);
    pushUser(typeof identity.name === "string" ? `name:${identity.name.trim().toLowerCase()}` : null, user);
  };

  players.forEach((user) => pushIdentityUser(user, { id: user.id, name: user.name }));
  pushIdentityUser(organizerUser, organizerUser ? { id: organizerUser.id, name: organizerUser.name } : null);
  confirmedPlayers.forEach((player) => {
    const user = toUserFromPlayer(player);
    pushIdentityUser(user, player);
  });
  waitlistPlayers.forEach((player) => {
    const user = toUserFromPlayer(player);
    pushIdentityUser(user, player);
  });

  const rawMatchResult = getGameMatchResult(game);
  const resultRosterSnapshot = rawMatchResult && typeof rawMatchResult === "object" && !Array.isArray(rawMatchResult)
    && rawMatchResult.resultRosterSnapshot && typeof rawMatchResult.resultRosterSnapshot === "object" && !Array.isArray(rawMatchResult.resultRosterSnapshot)
      ? rawMatchResult.resultRosterSnapshot as Record<string, unknown>
      : null;
  const resultRosterMembers = Array.isArray(resultRosterSnapshot?.members) ? resultRosterSnapshot.members : [];
  resultRosterMembers.forEach((member, index) => {
    if (!member || typeof member !== "object" || Array.isArray(member)) return;
    const record = member as Record<string, unknown>;
    const resolvedUser = (
      (typeof record.memberKey === "string" && participantKeyMap.get(record.memberKey.trim()))
      || (typeof record.id === "string" && participantKeyMap.get(`id:${record.id.trim()}`))
      || (() => {
        const normalizedPhone = typeof record.phone === "string" ? normalizePhone(record.phone) : null;
        return normalizedPhone ? participantKeyMap.get(`phone:${normalizedPhone}`) : null;
      })()
      || null
    );
    const fallbackName = typeof record.name === "string" && record.name.trim()
      ? record.name.trim()
      : `Игрок ${index + 1}`;
    const fallbackId = typeof record.memberKey === "string" && record.memberKey.trim()
      ? record.memberKey.trim()
      : typeof record.id === "string" && record.id.trim()
        ? record.id.trim()
        : `result-member:${index + 1}`;
    const fallbackAvatar = typeof record.photo === "string"
      ? record.photo
      : typeof record.avatar === "string"
        ? record.avatar
        : null;
    pushIdentityUser(
      resolvedUser ?? fallbackUser(fallbackName, fallbackId, fallbackAvatar),
      {
        memberKey: typeof record.memberKey === "string" ? record.memberKey : null,
        id: typeof record.id === "string" ? record.id : null,
        phone: typeof record.phone === "string" ? record.phone : null,
        name: typeof record.name === "string" ? record.name : null,
      },
    );
  });

  const resolveUser = (value: unknown): User | null => {
    if (typeof value === "string") {
      const byRaw = participantKeyMap.get(value.trim());
      if (byRaw) return byRaw;
      const normalizedPhone = normalizePhone(value);
      const byPhone = normalizedPhone ? participantKeyMap.get(`phone:${normalizedPhone}`) : null;
      if (byPhone) return byPhone;
    }

    if (value && typeof value === "object" && !Array.isArray(value)) {
      const record = value as Record<string, unknown>;
      const byId = typeof record.id === "string" ? participantKeyMap.get(`id:${record.id.trim()}`) : null;
      if (byId) return byId;
      const normalizedPhone = typeof record.phone === "string" ? normalizePhone(record.phone) : null;
      const byPhone = normalizedPhone ? participantKeyMap.get(`phone:${normalizedPhone}`) : null;
      if (byPhone) return byPhone;
      const byName = typeof record.name === "string"
        ? participantKeyMap.get(`name:${record.name.trim().toLowerCase()}`)
        : null;
      if (byName) return byName;
    }

    return null;
  };

  const rawTeamSlots = getDisplayResultSlots(game);
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
  const normalizedId = normalizeIdentityId(currentUserId);

  const organizerId = normalizeIdentityId(game?.organizer?.id);
  if (normalizedId && organizerId && normalizedId === organizerId) return true;
  const organizerPhone = normalizePhone(game?.organizer?.phone);
  if (normalizedPhone && organizerPhone && normalizedPhone === organizerPhone) return true;

  if ((game?.participants ?? []).some((player) => playerMatchesIdentity(player, normalizedId, normalizedPhone))) {
    return true;
  }
  if ((game?.waitlist ?? []).some((player) => playerMatchesIdentity(player, normalizedId, normalizedPhone))) {
    return true;
  }

  const phoneLists = [
    ...(game?.participantPhones ?? []),
    ...(game?.waitlistPhones ?? []),
  ]
    .map((value) => normalizePhone(value))
    .filter((value): value is string => Boolean(value));
  if (normalizedPhone && phoneLists.includes(normalizedPhone)) return true;

  if (hasActiveSplitPaymentIdentity(game, normalizedId, normalizedPhone)) return true;

  if (!hasLeaveEventForIdentity(game, normalizedId, normalizedPhone)) {
    const allRelatedPhones = (game?.allRelatedPhones ?? [])
      .map((value) => normalizePhone(value))
      .filter((value): value is string => Boolean(value));
    return Boolean(normalizedPhone && allRelatedPhones.includes(normalizedPhone));
  }

  return false;
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
    /\b(?:станция|клуб|локация|площадка)\s*[:-]?\s*([^\n•,.;]+)/i,
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

  const explicitTypeMatch = text.match(/\b(?:тип|формат)\s*[:-]?\s*([^\n•,.;]+)/i);
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
    /\b(?:рейтинг|уровень)\s*[:-]?\s*((?:[A-D]\+?)(?:\s*[–/-]\s*(?:[A-D]\+?))?|(?:\d(?:[.,]\d+)?)(?:\s*[–/-]\s*(?:\d(?:[.,]\d+)?))?)\b/i,
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
    /\b(?:пол|категория)\s*[:-]?\s*(мужчины|мужской|женщины|женский|микст|mixed|любой пол|без ограничений)\b/i,
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

function buildTournament(post: CommunityPost, stats?: TournamentStats): Tournament {
  const details = post.details ?? {};
  const savedPublicTournament =
    pickRecord(details, ["publicTournament", "sourceTournamentSnapshot", "tournament", "customTournament"]) ?? {};
  const publicTournament = stats?.publicTournament ?? savedPublicTournament;
  const skin = pickRecord(publicTournament, ["skin"]) ?? pickRecord(details, ["skin", "tournamentSkin"]) ?? {};
  const searchableText = [post.previewLabel, post.body, post.title].filter(Boolean).join(" • ");
  const parsedProgress = pickParticipantsProgress(searchableText);
  const pairCount = pickTournamentPairCount(searchableText);
  const maxParticipants =
    stats?.maxParticipants ??
    pickNumberValue(publicTournament, ["maxPlayers"], null) ??
    pickNumberValue(publicTournament, ["maxParticipants", "maxClientsCount", "playersLimit", "limit"], null) ??
    pickNumberValue(details, ["maxPlayers"], null) ??
    pickNumberValue(details, ["maxParticipants", "maxClientsCount", "playersLimit", "limit"], null) ??
    parsedProgress?.maxParticipants ??
    (pairCount ? pairCount * 2 : 16);
  const participants =
    stats?.participantsCount ??
    pickNumberValue(publicTournament, ["participantsCount"], null) ??
    pickNumberValue(publicTournament, ["clientsCount", "joinedCount"], null) ??
    pickNumberValue(details, ["participantsCount"], null) ??
    pickNumberValue(details, ["clientsCount", "joinedCount"], null) ??
    parsedProgress?.participants ??
    0;
  const waitlistCount =
    stats?.waitlistCount ??
    pickNumberValue(publicTournament, ["waitlistCount"], null) ??
    pickNumberValue(details, ["waitlistCount"], 0) ??
    0;
  const level =
    normalizeTournamentRatingLabel(
      pickStringValue(skin, ["levelLabel", "ratingLabel", "level", "rating"]) ||
      pickStringValue(publicTournament, ["levelLabel", "ratingLabel", "level", "rating"]) ||
      pickStringValue(details, ["levelLabel", "ratingLabel", "level", "rating"]) ||
      formatAccessLevelRange(publicTournament.accessLevels || details.accessLevels) ||
      pickTournamentLevel(searchableText),
    ) || undefined;
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
    pickStringValue(publicTournament, ["locationName", "studioName", "stationName", "clubName"]) ||
    pickStringValue(details, ["studioName", "stationName", "clubName"]) ||
    pickTournamentStation(post.previewLabel, searchableText) ||
    "Станция уточняется";
  const tournamentTypeLabel =
    pickStringValue(publicTournament, ["tournamentType"]) ||
    pickStringValue(details, ["tournamentType"]) ||
    pickTournamentType(searchableText) ||
    "Турнир";
  const ratingLabel =
    normalizeTournamentRatingLabel(
      pickStringValue(skin, ["ratingLabel", "levelLabel", "level", "rating"]) ||
      pickStringValue(publicTournament, ["ratingLabel", "levelLabel", "level", "rating"]) ||
      pickStringValue(details, ["ratingLabel", "levelLabel", "level", "rating"]) ||
      formatAccessLevelRange(publicTournament.accessLevels || details.accessLevels) ||
      pickTournamentRatingLabel(searchableText, level),
    ) || undefined;
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
  const publicUrl = normalizeTournamentPublicUrl(
    pickStringValue(publicTournament, ["publicUrl", "joinUrl"]) ||
    pickStringValue(details, ["publicUrl", "joinUrl"]) ||
    "",
  );
  const endTime = formatIsoTime(endsAt);
  const duration = formatTournamentDuration(startsAt, endsAt);
  const spotsLeft = maxParticipants > 0 ? Math.max(0, maxParticipants - participants) : null;
  const priceLabel = resolveTournamentPriceLabel(publicTournament, details, skin);

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
    priceLabel,
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
        ? getTournamentDateTime(entry.item.data)
        : entry.publishedAt;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : Date.parse(entry.publishedAt);
}

function getTournamentDateTime(tournament: Tournament) {
  const date = tournament.date.trim();
  const startTime = tournament.startTime.trim();
  if (!date) return "";

  if (/[T\s]\d{1,2}:\d{2}/.test(date)) {
    return date;
  }

  return startTime ? `${date}T${startTime}:00` : date;
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
  tournamentStats = {},
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
      const hasLiveGameRecord = Boolean(game);
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
      const gameEndTs = hasLiveGameRecord ? getGameEndTimestamp(game, buildGameDateTime(post, game)) : null;
      const fallbackTs = Date.parse(buildGameDateTime(post, game));
      const effectiveGameTs = gameEndTs ?? (Number.isFinite(fallbackTs) ? fallbackTs : null);
      const isPastGame = effectiveGameTs !== null && effectiveGameTs <= Date.now();
      const resultDisplayState = getMatchResultDisplayState(game);
      const resultScore = resultDisplayState !== "none" ? getMatchResultScore(game) : null;
      const hasVisibleResult = Boolean(resultScore);
      const hasConfirmedResult = resultDisplayState === "confirmed" && hasVisibleResult;
      const hasPendingResult = resultDisplayState === "pending" && hasVisibleResult;
      const isResultDisputed = resultDisplayState === "disputed" && hasVisibleResult;
      const canDisputeResult = hasLiveGameRecord
        && hasPendingResult
        && canCurrentUserDisputeMatchResult(game, currentUser);
      const needsResult = hasLiveGameRecord && isPastGame && !hasVisibleResult;
      if (hasLiveGameRecord && needsResult && !isCurrentUserParticipant) {
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
          : isPastGame
            ? "Открыть игру"
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
            title: extractGameCustomTitle(isRecord(game?.metadata) ? game.metadata : null) ?? post.title,
            datetimeText: buildGameDateLine(post, game),
            publishedLabel: formatRelativePublishedLabel(post.publishedAt),
            level: getGameLevel(community, post, game, players),
            slotsText: formatSlotsLabel(slotsLeft),
            datetime: buildGameDateTime(post, game),
            location: buildGameLocation(post, game),
            slotsLeft,
            totalSlots,
            splitJoinPriceText: getSplitJoinPriceText(game),
            splitCancelDeadlineAt: getSplitCancelDeadlineAt(game),
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
      const tournamentId = post.relatedTournamentId || post.id;
      entries.push({
        id: `tournament:${post.id}`,
        item: {
          type: "tournament",
          data: buildTournament(post, tournamentStats[tournamentId]),
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
