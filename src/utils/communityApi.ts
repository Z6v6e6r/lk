import {
  getServ2Origin,
  request,
  type ApiError,
  type ApiResult,
  type ApiStatus,
  type RequestOptions,
} from "./apiClient";
import {
  IS_DEV_RELEASE_CHANNEL,
  PUBLIC_COMMUNITY_JOIN_PATH,
  PUBLIC_INVITE_ORIGIN,
  SERV2,
  SERV2_FALLBACK,
} from "../consts/api_config";
import {
  COMMUNITY_RATING_CALCULATION_VERSION,
  normalizeCommunityRatingPeriod,
  normalizeCommunityRatingTab,
  toCommunityRatingTransportTab,
  type CommunityRatingPeriod,
  type CommunityRatingTab,
  type CommunityRatingTabInput,
} from "../services/community-rating/contract.ts";
import { resolveLkApiBaseUrlCandidates } from "./lkApiBaseUrls";

export type { CommunityRatingPeriod, CommunityRatingTab, CommunityRatingTabInput };

export type CommunityVisibility = "OPEN" | "CLOSED";
export type CommunityJoinRule = "INSTANT" | "MODERATED" | "INVITE_ONLY";
export type CommunityRole = "OWNER" | "ADMIN" | "MODERATOR" | "MEMBER";
export type CommunityMembershipStatus = "ACTIVE" | "PENDING";
export type CommunityPostKind = "SYSTEM" | "PHOTO" | "GAME" | "TOURNAMENT";
export type CommunityMemberAction = "REMOVE" | "BAN";
export type CommunityPostReaction = "LIKE" | "DISLIKE";

export function isVisibleCommunityPostKind(
  value: CommunityPostKind | null | undefined,
): value is Exclude<CommunityPostKind, "SYSTEM"> {
  return value === "PHOTO" || value === "GAME" || value === "TOURNAMENT";
}

export interface CommunityMember {
  id: string | null;
  phone: string | null;
  name: string;
  avatar: string | null;
  role: CommunityRole;
  status: CommunityMembershipStatus;
  levelScore: number;
  levelLabel: string;
  joinedAt: string;
}

export interface CommunityRecord {
  id: string;
  name: string;
  slug: string | null;
  logo: string | null;
  logoUrl: string | null;
  logoThumbUrl: string | null;
  isVerified: boolean;
  visibility: CommunityVisibility;
  description: string;
  city: string;
  focusTags: string[];
  minimumLevel: string;
  joinRule: CommunityJoinRule;
  rules: string;
  inviteCode: string;
  inviteLink: string;
  createdAt: string;
  updatedAt: string | null;
  lastVisibleFeedActivityAt: string | null;
  lastVisibleFeedActivityTs: number | null;
  members: CommunityMember[];
  membersLoaded: boolean;
  memberCount: number;
  pendingCount: number;
}

export interface CommunityConnection {
  left: string;
  right: string;
  overlap: number;
}

export interface CommunityPost {
  id: string;
  communityId: string;
  kind: CommunityPostKind;
  title: string;
  body: string;
  publishedAt: string;
  createdTs: number;
  imageUrl: string | null;
  previewLabel: string | null;
  ctaLabel: string | null;
  relatedGameId: string | null;
  relatedTournamentId: string | null;
  details: Record<string, unknown> | null;
  authorId: string | null;
  authorPhone: string | null;
  authorName: string | null;
  authorAvatar: string | null;
  memberPreview: CommunityPostMemberPreview | null;
  likesCount: number;
  dislikesCount: number;
  commentsCount: number;
  viewerReaction: CommunityPostReaction | null;
}

export interface CommunityPostMemberPreview {
  id: string | null;
  phone: string | null;
  name: string;
  avatar: string | null;
  levelScore: number;
  levelLabel: string;
  stats: {
    matchesPlayed: number;
    wins: number;
    losses: number;
    draws: number;
  };
}

export interface CommunityFeedResponse {
  communityId: string | null;
  posts: CommunityPost[];
  hasMore: boolean;
  nextBeforeTs: number | null;
  totalFetched: number;
}

export interface CommunityPostComment {
  id: string;
  communityId: string;
  postId: string;
  text: string;
  createdAt: string;
  createdTs: number;
  authorId: string | null;
  authorPhone: string | null;
  authorName: string;
  authorAvatar: string | null;
}

export interface CommunityPostThread {
  communityId: string;
  postId: string;
  likesCount: number;
  dislikesCount: number;
  commentsCount: number;
  viewerReaction: CommunityPostReaction | null;
  comments: CommunityPostComment[];
}

export interface CommunityRankingRow {
  id: string | null;
  phone: string | null;
  name: string;
  avatar: string | null;
  role: CommunityRole;
  levelScore: number;
  levelLabel: string;
  overallPlace: number;
  levelPlace: number;
}

export interface CommunityRatingItem {
  rank: number;
  communityId: string | null;
  playerId: string | null;
  playerName: string;
  avatarUrl: string | null;
  currentLevel: number;
  levelDelta: number;
  lastRatingDelta: number | null;
  lastRatingChangedAt: string | null;
  gamesPlayed: number;
  gamesWon: number;
  gamesLost: number;
  winRate: number;
  setsWon: number;
  gamesWonCount: number;
  gamesDiff: number;
  gamesRawScore: number;
  gamesReliabilityFactor: number;
  gamesScore: number;
  gamesNormalized: number;
  tournamentsPlayed: number;
  tournamentMatchesWon: number;
  tournamentPointsScored: number;
  tournamentPointsDiff: number;
  bestPlace: number | null;
  averagePlace: number | null;
  tournamentRawScore: number;
  tournamentReliabilityFactor: number;
  tournamentScore: number;
  tournamentNormalized: number;
  visitsAttended: number;
  activityScore: number;
  overallScore: number;
  totalEventsPlayed: number;
  lastActivityAt: string | null;
  badges: string[];
}

export interface CommunityListResponse {
  communities: CommunityRecord[];
  connections: CommunityConnection[];
}

export interface CommunityRankingResponse {
  communityId: string;
  updatedAt: string | null;
  calculationVersion: string | null;
  tab: CommunityRatingTab;
  period: CommunityRatingPeriod;
  confirmedGamesCount: number | null;
  items: CommunityRatingItem[];
  rows: CommunityRatingItem[];
}

export interface ArchiveCommunityFeedPostResponse {
  ok: boolean;
  communityId: string | null;
  postId: string | null;
  archived: boolean;
}

export interface CommunityActionResponse {
  ok: boolean;
  membershipStatus: CommunityMembershipStatus | null;
  message: string | null;
  community: CommunityRecord | null;
  feedPost: CommunityPost | null;
  ranking: CommunityRankingResponse | null;
}

export interface CommunityChatMessage {
  id: string;
  communityId: string;
  text: string;
  createdAt: string;
  createdTs: number;
  authorId: string | null;
  authorPhone: string | null;
  authorName: string;
  authorAvatar: string | null;
}

export interface CommunityChatMessagesResponse {
  communityId: string | null;
  messages: CommunityChatMessage[];
  hasMore: boolean;
  nextBeforeTs: number | null;
  totalFetched: number;
}

export interface CommunityActorPayload {
  id?: string | null;
  phone?: string | null;
  name: string;
  avatar?: string | null;
  role?: CommunityRole;
  levelScore: number;
  levelLabel: string;
}

export interface CreateCommunityPayload {
  name: string;
  logo?: string | null;
  logoUrl?: string | null;
  logoThumbUrl?: string | null;
  visibility: CommunityVisibility;
  description: string;
  city: string;
  focusTags: string[];
  minimumLevel: string;
  joinRule: CommunityJoinRule;
  rules: string;
  creator: CommunityActorPayload;
}

export interface JoinCommunityPayload {
  member: CommunityActorPayload;
}

export interface JoinCommunityByInvitePayload {
  inviteCode?: string | null;
  inviteLink?: string | null;
  member: CommunityActorPayload;
}

export interface UpdateCommunityPayload {
  name: string;
  logo?: string | null;
  logoUrl?: string | null;
  logoThumbUrl?: string | null;
  visibility: CommunityVisibility;
  description: string;
  city: string;
  focusTags: string[];
  minimumLevel: string;
  joinRule: CommunityJoinRule;
  rules: string;
  actor: CommunityActorPayload;
}

export interface ManageCommunityMemberPayload {
  action: CommunityMemberAction;
  actor: CommunityActorPayload;
  member: CommunityActorPayload;
}

export interface CreateCommunityFeedPostPayload {
  member: CommunityActorPayload;
  kind: Exclude<CommunityPostKind, "SYSTEM">;
  title: string;
  body: string;
  imageUrl?: string | null;
  previewLabel?: string | null;
  ctaLabel?: string | null;
  relatedGameId?: string | null;
  relatedTournamentId?: string | null;
  details?: Record<string, unknown> | null;
}

export interface ArchiveCommunityFeedPostPayload {
  member: CommunityActorPayload;
}

export interface CreateCommunityPostCommentPayload {
  member: CommunityActorPayload;
  text: string;
}

export interface SetCommunityPostReactionPayload {
  member: CommunityActorPayload;
  reaction: CommunityPostReaction | null;
}

export interface CreateCommunityChatMessagePayload {
  member: CommunityActorPayload;
  text: string;
}

export interface CommunityLogoUploadResponse {
  ok: boolean;
  logoUrl: string | null;
  logoThumbUrl: string | null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function toTrimmedString(value: unknown): string | null {
  if (typeof value === "string") {
    const normalized = value.trim();
    return normalized ? normalized : null;
  }
  if (typeof value === "number" && Number.isFinite(value)) {
    return String(value);
  }
  return null;
}

function toNumeric(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value)) {
    return value;
  }
  if (typeof value === "string") {
    const normalized = value.trim().replace(",", ".");
    if (!normalized) return null;
    const parsed = Number(normalized);
    return Number.isFinite(parsed) ? parsed : null;
  }
  return null;
}

function normalizePublicPath(value: string | null | undefined, fallback: string) {
  const normalized = (value || "").trim();
  if (!normalized) return fallback;
  const withLeadingSlash = normalized.startsWith("/") ? normalized : `/${normalized}`;
  const withoutTrailingSlash = withLeadingSlash.replace(/\/+$/, "");
  return withoutTrailingSlash || fallback;
}

function toAbsoluteCommunityAssetUrl(value: string | null) {
  if (!value) return null;
  if (/^(?:https?:)?\/\//i.test(value) || /^data:/i.test(value)) {
    return value;
  }

  const baseUrl = (getServ2Origin() || "").trim();
  if (!baseUrl) return value;

  const normalizedBase = baseUrl.replace(/\/+$/, "");
  const normalizedPath = value.startsWith("/") ? value : `/${value}`;
  return `${normalizedBase}${normalizedPath}`;
}

export function buildCommunityLogoCandidates(
  community: Pick<CommunityRecord, "id" | "logo" | "logoUrl" | "logoThumbUrl"> | null | undefined,
) {
  if (!community) return [] as string[];

  const candidates = [
    community.logoThumbUrl,
    community.logoUrl,
    community.logo,
    community.id ? `/lk/media/community-logo-legacy/${encodeURIComponent(community.id)}/thumb` : null,
    community.id ? `/lk/media/community-logo-legacy/${encodeURIComponent(community.id)}` : null,
  ]
    .map((value) => toAbsoluteCommunityAssetUrl(value))
    .filter((value): value is string => Boolean(value));

  return Array.from(new Set(candidates));
}

function decodeInviteSegment(value: string) {
  const normalized = value.trim();
  if (!normalized) return "";

  try {
    return decodeURIComponent(normalized);
  } catch {
    return normalized;
  }
}

const COMMUNITY_INVITE_ORIGIN = (PUBLIC_INVITE_ORIGIN || "https://padlhub.ru").trim().replace(/\/+$/, "")
  || "https://padlhub.ru";
const COMMUNITY_JOIN_PATH = normalizePublicPath(PUBLIC_COMMUNITY_JOIN_PATH, "/community_join");

export function extractCommunityInviteCode(value: string | null | undefined) {
  const raw = (value || "").trim();
  if (!raw) return "";

  try {
    const parsed = new URL(raw);
    const byParam = parsed.searchParams.get("invite") ?? parsed.searchParams.get("code");
    if (byParam) return decodeInviteSegment(byParam);
    const pathParts = parsed.pathname.split("/").filter(Boolean);
    return decodeInviteSegment(pathParts.at(-1) ?? "");
  } catch {
    return decodeInviteSegment(
      raw
        .replace(/^invite:/i, "")
        .split("/")
        .filter(Boolean)
        .at(-1)
        ?.trim() ?? "",
    );
  }
}

export function buildCommunityInviteLink(inviteCode: string | null | undefined) {
  const normalizedInviteCode = extractCommunityInviteCode(inviteCode);
  if (!normalizedInviteCode) return "";
  return `${COMMUNITY_INVITE_ORIGIN}${COMMUNITY_JOIN_PATH}?invite=${encodeURIComponent(normalizedInviteCode)}`;
}

function normalizeCommunityInvite(inviteCode: string | null, inviteLink: string | null) {
  const resolvedInviteCode = extractCommunityInviteCode(inviteCode || inviteLink || "") || "";
  const resolvedInviteLink = buildCommunityInviteLink(resolvedInviteCode) || (inviteLink?.trim() ?? "");

  return {
    inviteCode: resolvedInviteCode,
    inviteLink: resolvedInviteLink,
  };
}

function toCountNumber(value: unknown): number | null {
  const parsed = toNumeric(value);
  return parsed === null ? null : Math.max(0, Math.trunc(parsed));
}

function pickString(source: Record<string, unknown>, keys: string[]): string | null {
  for (const key of keys) {
    const picked = toTrimmedString(source[key]);
    if (picked) return picked;
  }
  return null;
}

function pickNumber(source: Record<string, unknown>, keys: string[]): number | null {
  for (const key of keys) {
    const picked = toCountNumber(source[key]);
    if (picked !== null) return picked;
  }
  return null;
}

function toBooleanFlag(value: unknown): boolean | null {
  if (typeof value === "boolean") return value;
  if (typeof value === "number" && Number.isFinite(value)) return value !== 0;
  if (typeof value !== "string") return null;

  const normalized = value.trim().toLowerCase();
  if (!normalized) return null;

  if (["true", "1", "yes", "y", "verified", "official", "approved"].includes(normalized)) {
    return true;
  }
  if (["false", "0", "no", "n", "unverified", "rejected"].includes(normalized)) {
    return false;
  }

  return null;
}

function pickBoolean(source: Record<string, unknown>, keys: string[]): boolean | null {
  for (const key of keys) {
    const picked = toBooleanFlag(source[key]);
    if (picked !== null) return picked;
  }
  return null;
}

function normalizePhone(value: unknown): string | null {
  const digits = String(value || "").replace(/\D/g, "");
  if (!digits) return null;
  if (digits.length === 10) return `7${digits}`;
  if (digits.length === 11 && digits.startsWith("8")) return `7${digits.slice(1)}`;
  return digits;
}

function extractArray(value: unknown): unknown[] {
  if (Array.isArray(value)) return value;
  if (!isRecord(value)) return [];

  const listKeys = ["items", "content", "data", "result", "communities", "posts", "rows"];
  for (const key of listKeys) {
    const candidate = value[key];
    if (Array.isArray(candidate)) return candidate;
  }

  return [];
}

function normalizeRole(value: unknown): CommunityRole {
  const raw = toTrimmedString(value)?.toUpperCase();
  if (raw === "OWNER" || raw === "ADMIN" || raw === "MODERATOR" || raw === "MEMBER") {
    return raw;
  }
  return "MEMBER";
}

function normalizeMembershipStatus(value: unknown): CommunityMembershipStatus {
  const raw = toTrimmedString(value)?.toUpperCase();
  return raw === "PENDING" ? "PENDING" : "ACTIVE";
}

function normalizeVisibility(value: unknown): CommunityVisibility {
  return toTrimmedString(value)?.toUpperCase() === "CLOSED" ? "CLOSED" : "OPEN";
}

function normalizeCommunityVerified(value: Record<string, unknown>) {
  const directFlag = pickBoolean(value, ["isVerified", "verified", "isOfficial", "official"]);
  if (directFlag !== null) return directFlag;

  const verificationStatus = pickString(value, ["verificationStatus", "officialStatus", "status"]);
  if (verificationStatus) {
    const normalizedStatus = verificationStatus.toUpperCase();
    if (["VERIFIED", "APPROVED", "OFFICIAL"].includes(normalizedStatus)) {
      return true;
    }
    if (["UNVERIFIED", "REJECTED"].includes(normalizedStatus)) {
      return false;
    }
  }

  const verificationRecord = isRecord(value.verification)
    ? value.verification
    : isRecord(value.verificationInfo)
      ? value.verificationInfo
      : null;
  if (verificationRecord) {
    const nestedFlag = pickBoolean(verificationRecord, ["isVerified", "verified", "isOfficial", "official"]);
    if (nestedFlag !== null) return nestedFlag;

    const nestedStatus = pickString(verificationRecord, ["status", "verificationStatus", "officialStatus"]);
    if (nestedStatus) {
      const normalizedStatus = nestedStatus.toUpperCase();
      if (["VERIFIED", "APPROVED", "OFFICIAL"].includes(normalizedStatus)) {
        return true;
      }
      if (["UNVERIFIED", "REJECTED"].includes(normalizedStatus)) {
        return false;
      }
    }
  }

  return Boolean(pickString(value, ["verifiedAt", "officialAt"]));
}

function normalizeJoinRule(value: unknown, fallbackVisibility: CommunityVisibility): CommunityJoinRule {
  const raw = toTrimmedString(value)?.toUpperCase();
  if (raw === "MODERATED" || raw === "INVITE_ONLY" || raw === "INSTANT") {
    return raw;
  }
  return fallbackVisibility === "CLOSED" ? "INVITE_ONLY" : "INSTANT";
}

function normalizePostKind(value: unknown): CommunityPostKind {
  const raw = toTrimmedString(value)?.toUpperCase();
  if (raw === "PHOTO" || raw === "GAME" || raw === "TOURNAMENT" || raw === "SYSTEM") {
    return raw;
  }
  return "SYSTEM";
}

function normalizePostReaction(value: unknown): CommunityPostReaction | null {
  const raw = toTrimmedString(value)?.toUpperCase();
  if (raw === "LIKE") return "LIKE";
  if (raw === "DISLIKE") return "DISLIKE";
  return null;
}

function extractStringArray(value: unknown): string[] {
  if (Array.isArray(value)) {
    return value
      .map((item) => toTrimmedString(item))
      .filter((item): item is string => Boolean(item));
  }
  if (typeof value === "string") {
    return value
      .split(",")
      .map((item) => item.trim())
      .filter(Boolean);
  }
  return [];
}

function dedupeStrings(values: string[]) {
  return Array.from(new Set(values.map((value) => value.trim()).filter(Boolean)));
}

function normalizeCommunityMember(value: unknown): CommunityMember | null {
  if (!isRecord(value)) return null;

  const name = pickString(value, ["name", "fullName", "displayName"]);
  const id = pickString(value, ["id", "clientId", "userId", "uuid"]);
  const phone = normalizePhone(value.phone ?? value.phoneNorm ?? value.phoneNumber ?? value.mobile);
  if (!name && !id && !phone) return null;

  const levelScore = toNumeric(value.levelScore ?? value.ratingNumeric ?? value.levelNumeric) ?? 3.2;

  return {
    id: id ?? null,
    phone,
    name: name ?? "Игрок",
    avatar: pickString(value, ["avatar", "photo", "imageUrl"]),
    role: normalizeRole(value.role),
    status: normalizeMembershipStatus(value.status),
    levelScore,
    levelLabel: pickString(value, ["levelLabel", "rating", "level"]) ?? "C",
    joinedAt: pickString(value, ["joinedAt", "createdAt"]) ?? new Date(0).toISOString(),
  };
}

function normalizeCommunityRecord(value: unknown): CommunityRecord | null {
  if (!isRecord(value)) return null;
  const id = pickString(value, ["id", "communityId", "uuid"]);
  const name = pickString(value, ["name", "title"]);
  if (!id || !name) return null;

  const visibility = normalizeVisibility(value.visibility ?? value.type);
  const members = extractArray(value.members)
    .map((item) => normalizeCommunityMember(item))
    .filter((item): item is CommunityMember => item !== null);
  const memberCount =
    pickNumber(value, ["memberCount", "membersCount", "membersTotal"]) ?? members.length;
  const pendingRaw = extractArray(value.pendingMembers);
  const invite = normalizeCommunityInvite(
    pickString(value, ["inviteCode", "code"]),
    pickString(value, ["inviteLink", "link"]),
  );
  const lastVisibleFeedActivityAt = pickString(value, ["lastVisibleFeedActivityAt"]);
  const parsedLastVisibleFeedActivityTs = lastVisibleFeedActivityAt
    ? Date.parse(lastVisibleFeedActivityAt)
    : Number.NaN;
  const lastVisibleFeedActivityTs =
    pickNumber(value, ["lastVisibleFeedActivityTs"])
    ?? (Number.isFinite(parsedLastVisibleFeedActivityTs) ? parsedLastVisibleFeedActivityTs : null);

  const explicitLogoUrl = toAbsoluteCommunityAssetUrl(pickString(value, ["logoUrl", "imageUrl"]));
  const explicitLogoThumbUrl = toAbsoluteCommunityAssetUrl(
    pickString(value, ["logoThumbUrl", "logoThumb", "thumbnailUrl"]),
  );
  const logo = toAbsoluteCommunityAssetUrl(
    explicitLogoThumbUrl
    ?? explicitLogoUrl
    ?? pickString(value, ["logo", "avatar"]),
  );

  return {
    id,
    name,
    slug: pickString(value, ["slug"]),
    logo,
    logoUrl: explicitLogoUrl ?? logo,
    logoThumbUrl: explicitLogoThumbUrl ?? explicitLogoUrl ?? logo,
    isVerified: normalizeCommunityVerified(value),
    visibility,
    description: pickString(value, ["description", "body"]) ?? "",
    city: pickString(value, ["city"]) ?? "Москва",
    focusTags: dedupeStrings(extractStringArray(value.focusTags ?? value.tags)),
    minimumLevel: pickString(value, ["minimumLevel", "levelFrom"]) ?? "C",
    joinRule: normalizeJoinRule(value.joinRule, visibility),
    rules: pickString(value, ["rules", "policy"]) ?? "",
    inviteCode: invite.inviteCode,
    inviteLink: invite.inviteLink,
    createdAt: pickString(value, ["createdAt"]) ?? new Date(0).toISOString(),
    updatedAt: pickString(value, ["updatedAt"]),
    lastVisibleFeedActivityAt,
    lastVisibleFeedActivityTs,
    members,
    membersLoaded: typeof value.membersLoaded === "boolean" ? value.membersLoaded : true,
    memberCount,
    pendingCount: pickNumber(value, ["pendingCount", "pendingMembersCount", "pendingTotal"]) ?? pendingRaw.length,
  };
}

function normalizeCommunityConnection(value: unknown): CommunityConnection | null {
  if (!isRecord(value)) return null;
  const left = pickString(value, ["left", "from", "communityIdLeft"]);
  const right = pickString(value, ["right", "to", "communityIdRight"]);
  const overlap = pickNumber(value, ["overlap", "sharedMembers", "weight"]);
  if (!left || !right || overlap === null || overlap <= 0) return null;
  return { left, right, overlap };
}

function normalizeCommunityPost(value: unknown): CommunityPost | null {
  if (!isRecord(value)) return null;
  const id = pickString(value, ["id", "postId", "uuid"]);
  const communityId = pickString(value, ["communityId"]);
  const title = pickString(value, ["title"]);
  const body = pickString(value, ["body", "text", "description"]);
  const kind = normalizePostKind(value.kind ?? value.type);
  if (!id || !communityId || !title || (!body && kind !== "TOURNAMENT")) return null;

  const publishedAt = pickString(value, ["publishedAt", "createdAt"]) ?? new Date(0).toISOString();
  const createdTs =
    pickNumber(value, ["createdTs", "publishedTs", "timestamp"]) ??
    Date.parse(publishedAt) ??
    0;
  const rawDetails = isRecord(value.details) ? value.details : null;
  const nestedDetails = rawDetails && isRecord(rawDetails.details) ? rawDetails.details : null;
  const sourceTournamentSnapshot = isRecord(value.sourceTournamentSnapshot)
    ? value.sourceTournamentSnapshot
    : null;
  const details = rawDetails
    ? { ...rawDetails, ...(nestedDetails ?? {}), ...(sourceTournamentSnapshot ? { sourceTournamentSnapshot } : {}) }
    : sourceTournamentSnapshot
      ? { sourceTournamentSnapshot, publicTournament: sourceTournamentSnapshot }
      : null;
  const publicTournament = details && isRecord(details.publicTournament) ? details.publicTournament : null;
  const normalizedSourceTournamentSnapshot = details && isRecord(details.sourceTournamentSnapshot)
    ? details.sourceTournamentSnapshot
    : null;

  return {
    id,
    communityId,
    kind,
    title,
    body: body ?? "",
    publishedAt,
    createdTs,
    imageUrl: pickString(value, ["imageUrl", "image", "photo"]),
    previewLabel: pickString(value, ["previewLabel", "preview", "label"]),
    ctaLabel: pickString(value, ["ctaLabel", "buttonLabel", "actionLabel"]),
    relatedGameId: pickString(value, ["relatedGameId", "gameId"]),
    relatedTournamentId:
      pickString(value, ["relatedTournamentId", "tournamentId"]) ??
      (details ? pickString(details, ["relatedTournamentId", "tournamentId"]) : null) ??
      (publicTournament ? pickString(publicTournament, ["exerciseId", "sourceTournamentId", "tournamentId", "id"]) : null) ??
      (normalizedSourceTournamentSnapshot
        ? pickString(normalizedSourceTournamentSnapshot, ["exerciseId", "sourceTournamentId", "tournamentId", "id"])
        : null),
    details,
    authorId:
      pickString(value, ["authorId"]) ??
      (isRecord(value.author) ? pickString(value.author, ["id", "clientId", "userId", "uuid"]) : null),
    authorPhone: normalizePhone(
      value.authorPhone
      ?? (isRecord(value.author) ? value.author.phone ?? value.author.phoneNorm ?? value.author.phoneNumber ?? value.author.mobile : null),
    ),
    authorName:
      pickString(value, ["authorName"]) ??
      (isRecord(value.author) ? pickString(value.author, ["name", "displayName"]) : null),
    authorAvatar:
      pickString(value, ["authorAvatar"]) ??
      (isRecord(value.author) ? pickString(value.author, ["avatar", "photo", "imageUrl"]) : null),
    memberPreview: (() => {
      const memberPreview = isRecord(value.memberPreview) ? value.memberPreview : null;
      if (!memberPreview) return null;

      const name =
        pickString(memberPreview, ["name", "displayName", "fullName"])
        ?? pickString(value, ["authorName"])
        ?? (isRecord(value.author) ? pickString(value.author, ["name", "displayName"]) : null);
      if (!name) return null;

      const levelScore = toNumeric(
        memberPreview.levelScore ?? memberPreview.ratingNumeric ?? memberPreview.levelNumeric,
      ) ?? 3.2;

      return {
        id: pickString(memberPreview, ["id", "clientId", "userId", "uuid"]),
        phone: normalizePhone(
          memberPreview.phone ?? memberPreview.phoneNorm ?? memberPreview.phoneNumber ?? memberPreview.mobile,
        ),
        name,
        avatar: pickString(memberPreview, ["avatar", "photo", "imageUrl"]),
        levelScore,
        levelLabel: pickString(memberPreview, ["levelLabel", "rating", "level"]) ?? "C",
        stats: {
          matchesPlayed: pickNumber(memberPreview, ["matchesPlayed", "gamesPlayed", "played"]) ?? 0,
          wins: pickNumber(memberPreview, ["wins"]) ?? 0,
          losses: pickNumber(memberPreview, ["losses"]) ?? 0,
          draws: pickNumber(memberPreview, ["draws"]) ?? 0,
        },
      };
    })(),
    likesCount: pickNumber(value, ["likesCount", "likes", "positiveReactions", "goodCount"]) ?? 0,
    dislikesCount: pickNumber(value, ["dislikesCount", "dislikes", "negativeReactions", "badCount"]) ?? 0,
    commentsCount: pickNumber(value, ["commentsCount", "comments", "commentCount", "repliesCount"]) ?? 0,
    viewerReaction: normalizePostReaction(
      value.viewerReaction
      ?? value.myReaction
      ?? value.reaction
      ?? value.userReaction,
    ),
  };
}

function normalizeCommunityPostComment(value: unknown): CommunityPostComment | null {
  if (!isRecord(value)) return null;

  const id = pickString(value, ["id", "commentId", "uuid"]);
  const communityId = pickString(value, ["communityId"]);
  const postId = pickString(value, ["postId", "feedPostId"]);
  const text = pickString(value, ["text", "body", "message"]);
  if (!id || !communityId || !postId || !text) return null;

  const createdAt = pickString(value, ["createdAt", "publishedAt"]) ?? new Date(0).toISOString();
  const createdTs =
    pickNumber(value, ["createdTs", "publishedTs", "timestamp"]) ??
    Date.parse(createdAt) ??
    0;

  return {
    id,
    communityId,
    postId,
    text,
    createdAt,
    createdTs,
    authorId: pickString(value, ["authorId"]) ?? (isRecord(value.author) ? pickString(value.author, ["id", "clientId", "userId"]) : null),
    authorPhone: normalizePhone(
      value.authorPhone
      ?? (isRecord(value.author) ? value.author.phone ?? value.author.phoneNorm : null),
    ),
    authorName:
      pickString(value, ["authorName"])
      ?? (isRecord(value.author) ? pickString(value.author, ["name", "displayName"]) : null)
      ?? "Игрок",
    authorAvatar:
      pickString(value, ["authorAvatar"])
      ?? (isRecord(value.author) ? pickString(value.author, ["avatar", "photo", "imageUrl"]) : null),
  };
}

function normalizeCommunityChatMessage(value: unknown): CommunityChatMessage | null {
  if (!isRecord(value)) return null;

  const id = pickString(value, ["id", "messageId", "uuid"]);
  const communityId = pickString(value, ["communityId"]);
  const text = pickString(value, ["text", "body", "message"]);
  if (!id || !communityId || !text) return null;

  const author = isRecord(value.author)
    ? value.author
    : isRecord(value.sender)
      ? value.sender
      : null;
  const createdAt = pickString(value, ["createdAt", "publishedAt"]) ?? new Date(0).toISOString();
  const createdTs =
    pickNumber(value, ["createdTs", "timestamp"]) ??
    Date.parse(createdAt) ??
    0;

  return {
    id,
    communityId,
    text,
    createdAt,
    createdTs,
    authorId:
      pickString(value, ["authorId"]) ??
      (author ? pickString(author, ["id", "clientId", "userId", "uuid"]) : null),
    authorPhone: normalizePhone(
      value.authorPhone
      ?? (author ? author.phone ?? author.phoneNorm ?? author.phoneNumber ?? author.mobile : null),
    ),
    authorName:
      pickString(value, ["authorName"]) ??
      (author ? pickString(author, ["name", "displayName", "fullName"]) : null) ??
      "Игрок",
    authorAvatar:
      pickString(value, ["authorAvatar"]) ??
      (author ? pickString(author, ["avatar", "photo", "imageUrl"]) : null),
  };
}

function normalizeRatingTab(value: string | null | undefined): CommunityRatingTab {
  return normalizeCommunityRatingTab(value);
}

function normalizeRatingPeriod(value: string | null | undefined): CommunityRatingPeriod {
  return normalizeCommunityRatingPeriod(value);
}

function normalizeCommunityRatingItem(
  value: unknown,
  index: number,
  fallbackCommunityId: string | null,
): CommunityRatingItem | null {
  if (!isRecord(value)) return null;
  const playerName = pickString(value, ["playerName", "name", "displayName"]);
  if (!playerName) return null;

  return {
    rank: pickNumber(value, ["rank", "overallPlace", "place", "position"]) ?? (index + 1),
    communityId: pickString(value, ["communityId"]) ?? fallbackCommunityId,
    playerId: pickString(value, ["playerId", "id", "clientId", "userId", "uuid"]),
    playerName,
    avatarUrl: pickString(value, ["avatarUrl", "avatar", "photo", "imageUrl"]),
    currentLevel: toNumeric(value.currentLevel ?? value.levelScore ?? value.ratingNumeric ?? value.levelNumeric) ?? 0,
    levelDelta: toNumeric(value.levelDelta) ?? 0,
    lastRatingDelta: toNumeric(value.lastRatingDelta),
    lastRatingChangedAt: pickString(value, ["lastRatingChangedAt"]),
    gamesPlayed: pickNumber(value, ["gamesPlayed", "matchesPlayed"]) ?? 0,
    gamesWon: pickNumber(value, ["gamesWon", "matchesWon"]) ?? 0,
    gamesLost: pickNumber(value, ["gamesLost", "matchesLost"]) ?? 0,
    winRate: toNumeric(value.winRate) ?? 0,
    setsWon: pickNumber(value, ["setsWon"]) ?? 0,
    gamesWonCount: pickNumber(value, ["gamesWonCount", "gamesWon"]) ?? 0,
    gamesDiff: toNumeric(value.gamesDiff) ?? 0,
    gamesRawScore: toNumeric(value.gamesRawScore) ?? 0,
    gamesReliabilityFactor: toNumeric(value.gamesReliabilityFactor) ?? 0,
    gamesScore: toNumeric(value.gamesScore) ?? 0,
    gamesNormalized: toNumeric(value.gamesNormalized) ?? 0,
    tournamentsPlayed: pickNumber(value, ["tournamentsPlayed"]) ?? 0,
    tournamentMatchesWon: pickNumber(value, ["tournamentMatchesWon"]) ?? 0,
    tournamentPointsScored: toNumeric(value.tournamentPointsScored) ?? 0,
    tournamentPointsDiff: toNumeric(value.tournamentPointsDiff) ?? 0,
    bestPlace: pickNumber(value, ["bestPlace"]),
    averagePlace: toNumeric(value.averagePlace),
    tournamentRawScore: toNumeric(value.tournamentRawScore) ?? 0,
    tournamentReliabilityFactor: toNumeric(value.tournamentReliabilityFactor) ?? 0,
    tournamentScore: toNumeric(value.tournamentScore) ?? 0,
    tournamentNormalized: toNumeric(value.tournamentNormalized) ?? 0,
    visitsAttended: pickNumber(value, ["visitsAttended", "visitsPlayed"]) ?? 0,
    activityScore: toNumeric(value.activityScore) ?? 0,
    overallScore: toNumeric(value.overallScore) ?? 0,
    totalEventsPlayed: pickNumber(value, ["totalEventsPlayed"]) ?? 0,
    lastActivityAt: pickString(value, ["lastActivityAt"]),
    badges: Array.isArray(value.badges)
      ? value.badges.map((item) => toTrimmedString(item)).filter((item): item is string => Boolean(item))
      : [],
  };
}

function extractCommunityListResponse(payload: unknown): CommunityListResponse {
  if (Array.isArray(payload)) {
    return {
      communities: payload
        .map((item) => normalizeCommunityRecord(item))
        .filter((item): item is CommunityRecord => item !== null),
      connections: [],
    };
  }

  if (!isRecord(payload)) {
    return { communities: [], connections: [] };
  }

  const communities = extractArray(payload.communities ?? payload.items ?? payload.data ?? payload.result)
    .map((item) => normalizeCommunityRecord(item))
    .filter((item): item is CommunityRecord => item !== null);

  const connections = extractArray(payload.connections)
    .map((item) => normalizeCommunityConnection(item))
    .filter((item): item is CommunityConnection => item !== null);

  return { communities, connections };
}

function extractCommunityFeed(payload: unknown): CommunityPost[] {
  if (Array.isArray(payload)) {
    return payload
      .map((item) => normalizeCommunityPost(item))
      .filter((item): item is CommunityPost => item !== null)
      .filter((item) => isVisibleCommunityPostKind(item.kind))
      .sort((left, right) => right.createdTs - left.createdTs);
  }

  if (!isRecord(payload)) return [];

  return extractArray(payload.posts ?? payload.items ?? payload.data ?? payload.result)
    .map((item) => normalizeCommunityPost(item))
    .filter((item): item is CommunityPost => item !== null)
    .filter((item) => isVisibleCommunityPostKind(item.kind))
    .sort((left, right) => right.createdTs - left.createdTs);
}

function extractCommunityFeedResponse(payload: unknown, requestedLimit?: number): CommunityFeedResponse {
  const isPayloadRecord = isRecord(payload);
  const posts = extractCommunityFeed(isPayloadRecord ? (payload.posts ?? payload) : payload);
  const explicitCommunityId = isPayloadRecord ? pickString(payload, ["communityId"]) : null;
  const explicitHasMoreRaw = isPayloadRecord ? payload.hasMore : null;
  const explicitHasMore = typeof explicitHasMoreRaw === "boolean" ? explicitHasMoreRaw : null;
  const explicitNextBeforeTs = isPayloadRecord ? pickNumber(payload, ["nextBeforeTs", "nextBefore"]) : null;
  const explicitTotalFetched = isPayloadRecord ? pickNumber(payload, ["totalFetched", "count"]) : null;
  const inferredNextBeforeTs = posts.length > 0
    ? (() => {
        const lastPost = posts[posts.length - 1];
        const ts = Number.isFinite(lastPost?.createdTs) ? lastPost.createdTs : Date.parse(lastPost?.publishedAt ?? "");
        return Number.isFinite(ts) ? ts : null;
      })()
    : null;

  return {
    communityId: explicitCommunityId,
    posts,
    hasMore: explicitHasMore ?? (
      Number.isFinite(requestedLimit)
        ? posts.length >= Math.max(1, Math.min(100, Math.floor(requestedLimit as number)))
        : posts.length > 0
    ),
    nextBeforeTs: explicitNextBeforeTs ?? inferredNextBeforeTs,
    totalFetched: explicitTotalFetched ?? posts.length,
  };
}

function extractCommunityChatMessages(payload: unknown): CommunityChatMessage[] {
  if (Array.isArray(payload)) {
    return payload
      .map((item) => normalizeCommunityChatMessage(item))
      .filter((item): item is CommunityChatMessage => item !== null)
      .sort((left, right) => left.createdTs - right.createdTs);
  }

  if (!isRecord(payload)) return [];

  return extractArray(payload.messages ?? payload.items ?? payload.data ?? payload.result)
    .map((item) => normalizeCommunityChatMessage(item))
    .filter((item): item is CommunityChatMessage => item !== null)
    .sort((left, right) => left.createdTs - right.createdTs);
}

function extractCommunityChatMessagesResponse(
  payload: unknown,
  requestedLimit?: number,
): CommunityChatMessagesResponse {
  const isPayloadRecord = isRecord(payload);
  const messages = extractCommunityChatMessages(isPayloadRecord ? (payload.messages ?? payload) : payload);
  const explicitCommunityId = isPayloadRecord ? pickString(payload, ["communityId"]) : null;
  const explicitHasMoreRaw = isPayloadRecord ? payload.hasMore : null;
  const explicitHasMore = typeof explicitHasMoreRaw === "boolean" ? explicitHasMoreRaw : null;
  const explicitNextBeforeTs = isPayloadRecord ? pickNumber(payload, ["nextBeforeTs", "nextBefore"]) : null;
  const explicitTotalFetched = isPayloadRecord ? pickNumber(payload, ["totalFetched", "count"]) : null;
  const inferredNextBeforeTs = messages.length > 0
    ? (() => {
        const firstMessage = messages[0];
        const ts = Number.isFinite(firstMessage?.createdTs) ? firstMessage.createdTs : Date.parse(firstMessage?.createdAt ?? "");
        return Number.isFinite(ts) ? ts : null;
      })()
    : null;

  return {
    communityId: explicitCommunityId,
    messages,
    hasMore: explicitHasMore ?? (
      Number.isFinite(requestedLimit)
        ? messages.length >= Math.max(1, Math.min(100, Math.floor(requestedLimit as number)))
        : messages.length > 0
    ),
    nextBeforeTs: explicitNextBeforeTs ?? inferredNextBeforeTs,
    totalFetched: explicitTotalFetched ?? messages.length,
  };
}

function extractCommunityRanking(payload: unknown): CommunityRankingResponse | null {
  if (!isRecord(payload)) return null;

  const communityId = pickString(payload, ["communityId"]);
  if (!communityId) return null;

  const items = extractArray(payload.items ?? payload.rows ?? payload.data ?? payload.result)
    .map((item, index) => normalizeCommunityRatingItem(item, index, communityId))
    .filter((item): item is CommunityRatingItem => item !== null);
  const payloadMeta = isRecord(payload.meta) ? payload.meta : null;
  const confirmedGamesCount = pickNumber(payload, ["confirmedGamesCount", "gamesCount", "matchesCount"])
    ?? (payloadMeta ? pickNumber(payloadMeta, ["confirmedGamesCount", "gamesCount", "matchesCount"]) : null);

  return {
    communityId,
    tab: normalizeRatingTab(pickString(payload, ["tab"])),
    period: normalizeRatingPeriod(pickString(payload, ["period"])),
    updatedAt: pickString(payload, ["updatedAt"]),
    calculationVersion: pickString(payload, ["calculationVersion", "ratingVersion"]),
    confirmedGamesCount,
    items,
    rows: items,
  };
}

export function isCurrentCommunityRatingCalculationVersion(value: unknown): boolean {
  return String(value ?? "").trim() === COMMUNITY_RATING_CALCULATION_VERSION;
}

function extractCommunityRecord(payload: unknown): CommunityRecord | null {
  if (isRecord(payload)) {
    return (
      normalizeCommunityRecord(payload.community) ??
      normalizeCommunityRecord(payload.data) ??
      normalizeCommunityRecord(payload.result) ??
      normalizeCommunityRecord(payload)
    );
  }

  return normalizeCommunityRecord(payload);
}

function extractCommunityLogoUploadResponse(payload: unknown): CommunityLogoUploadResponse | null {
  if (!isRecord(payload)) return null;

  return {
    ok: Boolean(payload.ok ?? true),
    logoUrl: toAbsoluteCommunityAssetUrl(pickString(payload, ["logoUrl", "url", "originalUrl"])),
    logoThumbUrl: toAbsoluteCommunityAssetUrl(
      pickString(payload, ["logoThumbUrl", "thumbUrl", "thumbnailUrl", "logoUrl", "url"]),
    ),
  };
}

function extractCommunityPostThread(payload: unknown): CommunityPostThread | null {
  if (!isRecord(payload)) return null;
  const nestedData = isRecord(payload.data) ? payload.data : null;
  const source = nestedData ?? payload;

  const communityId = pickString(source, ["communityId"]);
  const postId = pickString(source, ["postId"]);
  if (!communityId || !postId) return null;

  const comments = extractArray(source.comments)
    .map((item) => normalizeCommunityPostComment(item))
    .filter((item): item is CommunityPostComment => item !== null)
    .sort((left, right) => left.createdTs - right.createdTs);

  return {
    communityId,
    postId,
    likesCount: pickNumber(source, ["likesCount", "likes", "positiveReactions", "goodCount"]) ?? 0,
    dislikesCount: pickNumber(source, ["dislikesCount", "dislikes", "negativeReactions", "badCount"]) ?? 0,
    commentsCount: pickNumber(source, ["commentsCount", "comments", "commentCount", "repliesCount"]) ?? comments.length,
    viewerReaction: normalizePostReaction(
      source.viewerReaction
      ?? source.myReaction
      ?? source.reaction
      ?? source.userReaction,
    ),
    comments,
  };
}

function normalizeActionResponse(payload: unknown): CommunityActionResponse | null {
  if (!isRecord(payload)) return null;
  const nestedData = isRecord(payload.data) ? payload.data : null;

  const community =
    extractCommunityRecord(payload) ??
    (nestedData ? extractCommunityRecord(nestedData) : null);
  const feedPost =
    normalizeCommunityPost(payload.feedPost) ??
    normalizeCommunityPost(payload.post) ??
    (nestedData
      ? (
        normalizeCommunityPost(nestedData.feedPost) ??
        normalizeCommunityPost(nestedData.post)
      )
      : null);
  const extractedRanking =
    extractCommunityRanking(payload.ranking) ??
    (nestedData && isRecord(nestedData.ranking)
      ? extractCommunityRanking(nestedData.ranking)
      : null) ??
    (nestedData ? extractCommunityRanking(nestedData) : null) ??
    (isRecord(payload.ranking)
      ? extractCommunityRanking(payload.ranking)
      : null);
  const ranking = extractedRanking
    && isCurrentCommunityRatingCalculationVersion(extractedRanking.calculationVersion)
    ? extractedRanking
    : null;

  return {
    ok: Boolean(payload.ok ?? nestedData?.ok ?? community),
    membershipStatus: (() => {
      const raw = toTrimmedString(
        payload.membershipStatus
        ?? payload.status
        ?? nestedData?.membershipStatus
        ?? nestedData?.status,
      )?.toUpperCase();
      if (raw === "ACTIVE" || raw === "PENDING") return raw;
      return null;
    })(),
    message: pickString(payload, ["message"]) ?? (nestedData ? pickString(nestedData, ["message"]) : null),
    community,
    feedPost,
    ranking,
  };
}

function buildBaseUrl() {
  return getServ2Origin() || "";
}

function trimTrailingSlashes(value: string | null | undefined) {
  return String(value || "").trim().replace(/\/+$/, "");
}

function buildCommunityMutationBaseUrls() {
  return resolveLkApiBaseUrlCandidates(SERV2, SERV2_FALLBACK)
    .map((value) => trimTrailingSlashes(value))
    .filter(Boolean);
}

function shouldRetryCommunityMutation(result: ApiResult<unknown>) {
  if (!result.error) return false;
  if (result.status == null) return true;
  return result.status === 404 || result.status === 405 || result.status >= 500;
}

async function requestCommunityMutation<T>(
  path: string,
  options: RequestOptions,
): Promise<ApiResult<T>> {
  const baseUrls = buildCommunityMutationBaseUrls();
  if (baseUrls.length === 0) {
    return request<T>(path, options);
  }

  let lastResult: ApiResult<T> | null = null;
  for (let index = 0; index < baseUrls.length; index += 1) {
    const result = await request<T>(path, {
      ...options,
      baseUrl: baseUrls[index],
    });
    lastResult = result;

    if (!shouldRetryCommunityMutation(result) || index === baseUrls.length - 1) {
      return result;
    }
  }

  return lastResult ?? request<T>(path, options);
}

function buildMemberPayload(member: CommunityActorPayload) {
  return {
    id: member.id?.trim() || null,
    phone: member.phone?.trim() || null,
    name: member.name.trim(),
    avatar: member.avatar?.trim() || null,
    role: member.role ?? "MEMBER",
    levelScore: member.levelScore,
    levelLabel: member.levelLabel.trim(),
  };
}

function errorResult<T>(status: ApiStatus, message: string, data: T | null = null): ApiResult<T> {
  return {
    data,
    error: { status, message },
    status,
  };
}

const DEV_COMMUNITIES_CACHE_TTL_MS = 30_000;
const DEV_COMMUNITY_FEED_CACHE_TTL_MS = 15_000;
const DEV_COMMUNITY_THREAD_CACHE_TTL_MS = 10_000;
const DEV_COMMUNITY_CHAT_CACHE_TTL_MS = 5_000;
const DEV_COMMUNITY_RANKING_CACHE_TTL_MS = 30_000;

function appendForceFreshCacheBuster(query: URLSearchParams) {
  query.set("_ts", String(Date.now()));
}

function buildCommunityGetOptions(ttlMs: number): Pick<
  RequestOptions,
  "baseUrl" | "retries" | "cache" | "cacheTtlMs" | "dedupe"
> {
  return {
    baseUrl: buildBaseUrl(),
    retries: 1,
    ...(IS_DEV_RELEASE_CHANNEL
      ? {
          cacheTtlMs: ttlMs,
          dedupe: true,
        }
      : {
          cache: "no-store" as RequestCache,
        }),
  };
}

function buildCommunityReadGetOptions(ttlMs: number): Pick<
  RequestOptions,
  "baseUrl" | "retries" | "cacheTtlMs" | "dedupe"
> {
  return {
    baseUrl: buildBaseUrl(),
    retries: 1,
    ...(IS_DEV_RELEASE_CHANNEL
      ? {
          cacheTtlMs: ttlMs,
          dedupe: true,
        }
      : {}),
  };
}

function buildForceFreshCommunityGetOptions(): Pick<RequestOptions, "baseUrl" | "retries" | "cache"> {
  return {
    baseUrl: buildBaseUrl(),
    retries: 1,
    cache: "no-store",
  };
}

export async function apiFetchCommunities(params: {
  phone?: string | null;
  clientId?: string | null;
  forceFresh?: boolean;
  view?: "summary";
}) {
  const query = new URLSearchParams();
  const phone = normalizePhone(params.phone);
  const clientId = params.clientId?.trim() || null;
  if (phone) query.set("phone", phone);
  if (clientId) query.set("clientId", clientId);
  query.set("view", "summary");
  if (params.forceFresh) {
    appendForceFreshCacheBuster(query);
  }

  const response = await request<unknown>(`/lk/communities?${query.toString()}`, {
    method: "GET",
    ...(params.forceFresh
      ? buildForceFreshCommunityGetOptions()
      : buildCommunityReadGetOptions(DEV_COMMUNITIES_CACHE_TTL_MS)),
  });

  if (response.error) {
    return {
      data: { communities: [], connections: [] } satisfies CommunityListResponse,
      error: response.error,
      status: response.status,
    };
  }

  return {
    data: extractCommunityListResponse(response.data),
    error: null,
    status: response.status,
  };
}

export async function apiFetchCommunity(
  communityId: string,
  params: {
    phone?: string | null;
    clientId?: string | null;
    forceFresh?: boolean;
  },
) {
  const normalizedCommunityId = communityId.trim();
  if (!normalizedCommunityId) {
    return errorResult<CommunityRecord>(400, "Не указан communityId", null);
  }

  const query = new URLSearchParams();
  const phone = normalizePhone(params.phone);
  const clientId = params.clientId?.trim() || null;
  if (phone) query.set("phone", phone);
  if (clientId) query.set("clientId", clientId);
  if (params.forceFresh) {
    appendForceFreshCacheBuster(query);
  }

  const response = await request<unknown>(
    `/lk/communities/${encodeURIComponent(normalizedCommunityId)}?${query.toString()}`,
    {
      method: "GET",
      ...(params.forceFresh
        ? buildForceFreshCommunityGetOptions()
        : buildCommunityReadGetOptions(DEV_COMMUNITIES_CACHE_TTL_MS)),
    },
  );

  if (response.error) {
    return errorResult<CommunityRecord>(response.status, response.error.message, null);
  }

  const parsed = extractCommunityRecord(response.data);
  if (!parsed) {
    return errorResult<CommunityRecord>(response.status, "Не удалось разобрать сообщество", null);
  }

  return {
    data: parsed,
    error: null,
    status: response.status,
  };
}

export async function apiCreateCommunity(payload: CreateCommunityPayload) {
  const name = payload.name.trim();
  if (!name) {
    return errorResult<CommunityActionResponse>(400, "Не указано название сообщества", null);
  }

  const response = await requestCommunityMutation<unknown>("/lk/communities", {
    method: "POST",
    retries: 1,
    body: JSON.stringify({
      name,
      logo: payload.logo?.trim() || null,
      logoUrl: payload.logoUrl?.trim() || null,
      logoThumbUrl: payload.logoThumbUrl?.trim() || null,
      visibility: payload.visibility,
      description: payload.description.trim(),
      city: payload.city.trim(),
      focusTags: payload.focusTags,
      minimumLevel: payload.minimumLevel.trim(),
      joinRule: payload.joinRule,
      rules: payload.rules.trim(),
      creator: buildMemberPayload(payload.creator),
    }),
  });

  if (response.error) {
    return errorResult<CommunityActionResponse>(response.status, response.error.message, null);
  }

  const parsed = normalizeActionResponse(response.data);
  if (!parsed) {
    return errorResult<CommunityActionResponse>(response.status, "Не удалось разобрать созданное сообщество", null);
  }

  return {
    data: parsed,
    error: null,
    status: response.status,
  };
}

export async function apiUpdateCommunity(communityId: string, payload: UpdateCommunityPayload) {
  const normalizedCommunityId = communityId.trim();
  const name = payload.name.trim();
  if (!normalizedCommunityId) {
    return errorResult<CommunityActionResponse>(400, "Не указан communityId", null);
  }

  if (!name) {
    return errorResult<CommunityActionResponse>(400, "Не указано название сообщества", null);
  }

  const response = await requestCommunityMutation<unknown>(`/lk/communities/${encodeURIComponent(normalizedCommunityId)}`, {
    method: "PATCH",
    retries: 1,
    body: JSON.stringify({
      name,
      logo: payload.logo?.trim() || null,
      logoUrl: payload.logoUrl?.trim() || null,
      logoThumbUrl: payload.logoThumbUrl?.trim() || null,
      visibility: payload.visibility,
      description: payload.description.trim(),
      city: payload.city.trim(),
      focusTags: payload.focusTags,
      minimumLevel: payload.minimumLevel.trim(),
      joinRule: payload.joinRule,
      rules: payload.rules.trim(),
      actor: buildMemberPayload(payload.actor),
    }),
  });

  if (response.error) {
    return errorResult<CommunityActionResponse>(response.status, response.error.message, null);
  }

  const parsed = normalizeActionResponse(response.data);
  if (!parsed) {
    return errorResult<CommunityActionResponse>(response.status, "Не удалось разобрать обновленное сообщество", null);
  }

  return {
    data: parsed,
    error: null,
    status: response.status,
  };
}

export async function apiUploadCommunityLogo(payload: {
  dataUrl: string;
  thumbDataUrl: string;
}) {
  const dataUrl = payload.dataUrl.trim();
  const thumbDataUrl = payload.thumbDataUrl.trim();
  if (!dataUrl || !thumbDataUrl) {
    return errorResult<CommunityLogoUploadResponse>(400, "Не удалось подготовить логотип", null);
  }

  const response = await requestCommunityMutation<unknown>("/lk/media/community-logo", {
    method: "POST",
    retries: 1,
    body: JSON.stringify({
      dataUrl,
      thumbDataUrl,
    }),
  });

  if (response.error) {
    return errorResult<CommunityLogoUploadResponse>(response.status, response.error.message, null);
  }

  const parsed = extractCommunityLogoUploadResponse(response.data);
  if (!parsed?.logoUrl || !parsed.logoThumbUrl) {
    return errorResult<CommunityLogoUploadResponse>(response.status, "Не удалось загрузить логотип", null);
  }

  return {
    data: parsed,
    error: null,
    status: response.status,
  };
}

export async function apiJoinCommunity(communityId: string, payload: JoinCommunityPayload) {
  return apiAddCommunityMember(communityId, payload);
}

export async function apiAddCommunityMember(communityId: string, payload: JoinCommunityPayload) {
  const normalizedCommunityId = communityId.trim();
  if (!normalizedCommunityId) {
    return errorResult<CommunityActionResponse>(400, "Не указан communityId", null);
  }

  const response = await requestCommunityMutation<unknown>(`/lk/communities/${encodeURIComponent(normalizedCommunityId)}/add-member`, {
    method: "POST",
    retries: 1,
    body: JSON.stringify({
      member: buildMemberPayload(payload.member),
    }),
  });

  if (response.error) {
    return errorResult<CommunityActionResponse>(response.status, response.error.message, null);
  }

  const parsed = normalizeActionResponse(response.data);
  if (!parsed) {
    return errorResult<CommunityActionResponse>(response.status, "Не удалось обработать вступление в сообщество", null);
  }

  return {
    data: parsed,
    error: null,
    status: response.status,
  };
}

export async function apiJoinCommunityByInvite(payload: JoinCommunityByInvitePayload) {
  const inviteCode = extractCommunityInviteCode(payload.inviteCode || payload.inviteLink || "") || null;
  const inviteLink = buildCommunityInviteLink(inviteCode) || payload.inviteLink?.trim() || null;
  if (!inviteCode && !inviteLink) {
    return errorResult<CommunityActionResponse>(400, "Не указан инвайт сообщества", null);
  }

  const response = await requestCommunityMutation<unknown>("/lk/communities/join-by-invite", {
    method: "POST",
    retries: 1,
    body: JSON.stringify({
      inviteCode,
      inviteLink,
      member: buildMemberPayload(payload.member),
    }),
  });

  if (response.error) {
    return errorResult<CommunityActionResponse>(response.status, response.error.message, null);
  }

  const parsed = normalizeActionResponse(response.data);
  if (!parsed) {
    return errorResult<CommunityActionResponse>(response.status, "Не удалось обработать приглашение в сообщество", null);
  }

  return {
    data: parsed,
    error: null,
    status: response.status,
  };
}

export async function apiManageCommunityMember(
  communityId: string,
  payload: ManageCommunityMemberPayload,
) {
  const normalizedCommunityId = communityId.trim();
  if (!normalizedCommunityId) {
    return errorResult<CommunityActionResponse>(400, "Не указан communityId", null);
  }

  const response = await requestCommunityMutation<unknown>(
    `/lk/communities/${encodeURIComponent(normalizedCommunityId)}/members/manage`,
    {
      method: "POST",
      retries: 1,
      body: JSON.stringify({
        action: payload.action,
        actor: buildMemberPayload(payload.actor),
        member: buildMemberPayload(payload.member),
      }),
    },
  );

  if (response.error) {
    return errorResult<CommunityActionResponse>(response.status, response.error.message, null);
  }

  const parsed = normalizeActionResponse(response.data);
  if (!parsed) {
    return errorResult<CommunityActionResponse>(response.status, "Не удалось обработать действие над участником", null);
  }

  return {
    data: parsed,
    error: null,
    status: response.status,
  };
}

export async function apiFetchCommunityFeed(
  communityId: string,
  params: {
    phone?: string | null;
    clientId?: string | null;
    limit?: number;
    beforeTs?: number | null;
    forceFresh?: boolean;
  },
) {
  const normalizedCommunityId = communityId.trim();
  if (!normalizedCommunityId) {
    return errorResult<CommunityFeedResponse>(400, "Не указан communityId", {
      communityId: null,
      posts: [],
      hasMore: false,
      nextBeforeTs: null,
      totalFetched: 0,
    });
  }

  const query = new URLSearchParams();
  const phone = normalizePhone(params.phone);
  const clientId = params.clientId?.trim() || null;
  if (phone) query.set("phone", phone);
  if (clientId) query.set("clientId", clientId);
  if (Number.isFinite(params.limit)) {
    query.set("limit", String(Math.max(1, Math.min(100, Math.floor(params.limit as number)))));
  }
  if (typeof params.beforeTs === "number" && Number.isFinite(params.beforeTs) && params.beforeTs > 0) {
    query.set("beforeTs", String(Math.trunc(params.beforeTs)));
  }
  if (params.forceFresh) {
    appendForceFreshCacheBuster(query);
  }

  const response = await request<unknown>(
    `/lk/communities/${encodeURIComponent(normalizedCommunityId)}/feed?${query.toString()}`,
    {
      method: "GET",
      ...(params.forceFresh
        ? buildForceFreshCommunityGetOptions()
        : buildCommunityReadGetOptions(DEV_COMMUNITY_FEED_CACHE_TTL_MS)),
    },
  );

  if (response.error) {
    return errorResult<CommunityFeedResponse>(response.status, response.error.message, {
      communityId: normalizedCommunityId,
      posts: [],
      hasMore: false,
      nextBeforeTs: null,
      totalFetched: 0,
    });
  }

  return {
    data: extractCommunityFeedResponse(response.data, params.limit),
    error: null,
    status: response.status,
  };
}

export async function apiCreateCommunityFeedPost(
  communityId: string,
  payload: CreateCommunityFeedPostPayload,
) {
  const normalizedCommunityId = communityId.trim();
  if (!normalizedCommunityId) {
    return errorResult<CommunityPost>(400, "Не указан communityId", null);
  }

  const response = await requestCommunityMutation<unknown>(
    `/lk/communities/${encodeURIComponent(normalizedCommunityId)}/feed`,
    {
      method: "POST",
      auth: true,
      retries: 1,
      body: JSON.stringify({
        member: buildMemberPayload(payload.member),
        kind: payload.kind,
        title: payload.title.trim(),
        body: payload.body.trim(),
        imageUrl: payload.imageUrl?.trim() || null,
        previewLabel: payload.previewLabel?.trim() || null,
        ctaLabel: payload.ctaLabel?.trim() || null,
        relatedGameId: payload.relatedGameId?.trim() || null,
        relatedTournamentId: payload.relatedTournamentId?.trim() || null,
        details: payload.details ?? null,
      }),
    },
  );

  if (response.error) {
    return errorResult<CommunityPost>(response.status, response.error.message, null);
  }

  const payloadRecord = isRecord(response.data) ? response.data : {};
  const nestedData = isRecord(payloadRecord.data) ? payloadRecord.data : null;
  const post =
    normalizeCommunityPost(payloadRecord.post) ??
    (nestedData ? normalizeCommunityPost(nestedData.post) : null) ??
    (nestedData ? normalizeCommunityPost(nestedData) : null) ??
    normalizeCommunityPost(response.data);

  if (!post) {
    return errorResult<CommunityPost>(response.status, "Не удалось разобрать пост сообщества", null);
  }

  return {
    data: post,
    error: null,
    status: response.status,
  };
}

export async function apiUpdateCommunityFeedPost(
  communityId: string,
  postId: string,
  payload: CreateCommunityFeedPostPayload,
) {
  const normalizedCommunityId = communityId.trim();
  const normalizedPostId = postId.trim();
  if (!normalizedCommunityId || !normalizedPostId) {
    return errorResult<CommunityPost>(400, "Не указан communityId или postId", null);
  }

  const response = await requestCommunityMutation<unknown>(
    `/lk/communities/${encodeURIComponent(normalizedCommunityId)}/feed/${encodeURIComponent(normalizedPostId)}`,
    {
      method: "PATCH",
      retries: 1,
      body: JSON.stringify({
        member: buildMemberPayload(payload.member),
        kind: payload.kind,
        title: payload.title.trim(),
        body: payload.body.trim(),
        imageUrl: payload.imageUrl?.trim() || null,
        previewLabel: payload.previewLabel?.trim() || null,
        ctaLabel: payload.ctaLabel?.trim() || null,
        relatedGameId: payload.relatedGameId?.trim() || null,
        relatedTournamentId: payload.relatedTournamentId?.trim() || null,
        details: payload.details ?? null,
      }),
    },
  );

  if (response.error) {
    return errorResult<CommunityPost>(response.status, response.error.message, null);
  }

  const payloadRecord = isRecord(response.data) ? response.data : {};
  const nestedData = isRecord(payloadRecord.data) ? payloadRecord.data : null;
  const post =
    normalizeCommunityPost(payloadRecord.post) ??
    (nestedData ? normalizeCommunityPost(nestedData.post) : null) ??
    (nestedData ? normalizeCommunityPost(nestedData) : null) ??
    normalizeCommunityPost(response.data);

  if (!post) {
    return errorResult<CommunityPost>(response.status, "Не удалось разобрать обновленный пост сообщества", null);
  }

  return {
    data: post,
    error: null,
    status: response.status,
  };
}

export async function apiArchiveCommunityFeedPost(
  communityId: string,
  postId: string,
  payload: ArchiveCommunityFeedPostPayload,
) {
  const normalizedCommunityId = communityId.trim();
  const normalizedPostId = postId.trim();
  if (!normalizedCommunityId || !normalizedPostId) {
    return errorResult<ArchiveCommunityFeedPostResponse>(400, "Не указан communityId или postId", null);
  }

  const response = await requestCommunityMutation<unknown>(
    `/lk/communities/${encodeURIComponent(normalizedCommunityId)}/feed/${encodeURIComponent(normalizedPostId)}/archive`,
    {
      method: "POST",
      retries: 1,
      body: JSON.stringify({
        member: buildMemberPayload(payload.member),
      }),
    },
  );

  if (response.error) {
    return errorResult<ArchiveCommunityFeedPostResponse>(response.status, response.error.message, null);
  }

  const payloadRecord = isRecord(response.data) ? response.data : {};
  return {
    data: {
      ok: Boolean(payloadRecord.ok ?? true),
      communityId: pickString(payloadRecord, ["communityId"]) ?? normalizedCommunityId,
      postId: pickString(payloadRecord, ["postId"]) ?? normalizedPostId,
      archived: payloadRecord.archived === false ? false : true,
    },
    error: null,
    status: response.status,
  };
}

export async function apiFetchCommunityPostThread(
  communityId: string,
  postId: string,
  params: {
    phone?: string | null;
    clientId?: string | null;
  },
) {
  const normalizedCommunityId = communityId.trim();
  const normalizedPostId = postId.trim();
  if (!normalizedCommunityId || !normalizedPostId) {
    return errorResult<CommunityPostThread>(400, "Не указан communityId или postId", null);
  }

  const query = new URLSearchParams();
  const phone = normalizePhone(params.phone);
  const clientId = params.clientId?.trim() || null;
  if (phone) query.set("phone", phone);
  if (clientId) query.set("clientId", clientId);
  const response = await request<unknown>(
    `/lk/communities/${encodeURIComponent(normalizedCommunityId)}/feed/${encodeURIComponent(normalizedPostId)}/thread?${query.toString()}`,
    {
      method: "GET",
      ...buildCommunityGetOptions(DEV_COMMUNITY_THREAD_CACHE_TTL_MS),
    },
  );

  if (response.error) {
    return errorResult<CommunityPostThread>(response.status, response.error.message, null);
  }

  const parsed = extractCommunityPostThread(response.data);
  if (!parsed) {
    return errorResult<CommunityPostThread>(response.status, "Не удалось разобрать обсуждение новости", null);
  }

  return {
    data: parsed,
    error: null,
    status: response.status,
  };
}

export async function apiCreateCommunityPostComment(
  communityId: string,
  postId: string,
  payload: CreateCommunityPostCommentPayload,
) {
  const normalizedCommunityId = communityId.trim();
  const normalizedPostId = postId.trim();
  const text = payload.text.trim();
  if (!normalizedCommunityId || !normalizedPostId) {
    return errorResult<CommunityPostComment>(400, "Не указан communityId или postId", null);
  }
  if (!text) {
    return errorResult<CommunityPostComment>(400, "Комментарий не может быть пустым", null);
  }

  const response = await requestCommunityMutation<unknown>(
    `/lk/communities/${encodeURIComponent(normalizedCommunityId)}/feed/${encodeURIComponent(normalizedPostId)}/comments`,
    {
      method: "POST",
      retries: 1,
      body: JSON.stringify({
        member: buildMemberPayload(payload.member),
        text,
      }),
    },
  );

  if (response.error) {
    return errorResult<CommunityPostComment>(response.status, response.error.message, null);
  }

  const payloadRecord = isRecord(response.data) ? response.data : {};
  const nestedData = isRecord(payloadRecord.data) ? payloadRecord.data : null;
  const comment =
    normalizeCommunityPostComment(payloadRecord.comment) ??
    (nestedData ? normalizeCommunityPostComment(nestedData.comment) : null) ??
    (nestedData ? normalizeCommunityPostComment(nestedData) : null) ??
    normalizeCommunityPostComment(response.data);

  if (!comment) {
    return errorResult<CommunityPostComment>(response.status, "Не удалось разобрать комментарий к новости", null);
  }

  return {
    data: comment,
    error: null,
    status: response.status,
  };
}

export async function apiSetCommunityPostReaction(
  communityId: string,
  postId: string,
  payload: SetCommunityPostReactionPayload,
) {
  const normalizedCommunityId = communityId.trim();
  const normalizedPostId = postId.trim();
  if (!normalizedCommunityId || !normalizedPostId) {
    return errorResult<{
      reaction: CommunityPostReaction | null;
      likesCount: number | null;
      dislikesCount: number | null;
    }>(400, "Не указан communityId или postId", null);
  }

  const response = await requestCommunityMutation<unknown>(
    `/lk/communities/${encodeURIComponent(normalizedCommunityId)}/feed/${encodeURIComponent(normalizedPostId)}/reaction`,
    {
      method: "POST",
      retries: 1,
      body: JSON.stringify({
        member: buildMemberPayload(payload.member),
        reaction: payload.reaction,
      }),
    },
  );

  if (response.error) {
    return errorResult<{
      reaction: CommunityPostReaction | null;
      likesCount: number | null;
      dislikesCount: number | null;
    }>(response.status, response.error.message, null);
  }

  const payloadRecord: Record<string, unknown> = isRecord(response.data) ? response.data : {};
  const nestedData = isRecord(payloadRecord.data) ? payloadRecord.data : null;
  return {
    data: {
      reaction: normalizePostReaction(payloadRecord.reaction ?? nestedData?.reaction ?? null),
      likesCount: pickNumber(payloadRecord, ["likesCount"]) ?? (nestedData ? pickNumber(nestedData, ["likesCount"]) : null),
      dislikesCount: pickNumber(payloadRecord, ["dislikesCount"]) ?? (nestedData ? pickNumber(nestedData, ["dislikesCount"]) : null),
    },
    error: null,
    status: response.status,
  };
}

export async function apiFetchCommunityChatMessages(
  communityId: string,
  params: {
    phone?: string | null;
    clientId?: string | null;
    limit?: number;
    beforeTs?: number | null;
  },
) {
  const normalizedCommunityId = communityId.trim();
  if (!normalizedCommunityId) {
    return errorResult<CommunityChatMessagesResponse>(400, "Не указан communityId", {
      communityId: null,
      messages: [],
      hasMore: false,
      nextBeforeTs: null,
      totalFetched: 0,
    });
  }

  const query = new URLSearchParams();
  const phone = normalizePhone(params.phone);
  const clientId = params.clientId?.trim() || null;
  if (phone) query.set("phone", phone);
  if (clientId) query.set("clientId", clientId);
  if (Number.isFinite(params.limit)) {
    query.set("limit", String(Math.max(1, Math.min(100, Math.floor(params.limit as number)))));
  }
  if (typeof params.beforeTs === "number" && Number.isFinite(params.beforeTs) && params.beforeTs > 0) {
    query.set("beforeTs", String(Math.trunc(params.beforeTs)));
  }
  const response = await request<unknown>(
    `/lk/communities/${encodeURIComponent(normalizedCommunityId)}/messages?${query.toString()}`,
    {
      method: "GET",
      ...buildCommunityGetOptions(DEV_COMMUNITY_CHAT_CACHE_TTL_MS),
    },
  );

  if (response.error) {
    return errorResult<CommunityChatMessagesResponse>(response.status, response.error.message, {
      communityId: normalizedCommunityId,
      messages: [],
      hasMore: false,
      nextBeforeTs: null,
      totalFetched: 0,
    });
  }

  return {
    data: extractCommunityChatMessagesResponse(response.data, params.limit),
    error: null,
    status: response.status,
  };
}

export async function apiCreateCommunityChatMessage(
  communityId: string,
  payload: CreateCommunityChatMessagePayload,
) {
  const normalizedCommunityId = communityId.trim();
  const text = payload.text.trim();
  if (!normalizedCommunityId) {
    return errorResult<CommunityChatMessage>(400, "Не указан communityId", null);
  }

  if (!text) {
    return errorResult<CommunityChatMessage>(400, "Не указан текст сообщения", null);
  }

  const response = await requestCommunityMutation<unknown>(
    `/lk/communities/${encodeURIComponent(normalizedCommunityId)}/messages`,
    {
      method: "POST",
      retries: 1,
      body: JSON.stringify({
        member: buildMemberPayload(payload.member),
        text,
      }),
    },
  );

  if (response.error) {
    return errorResult<CommunityChatMessage>(response.status, response.error.message, null);
  }

  const payloadRecord = isRecord(response.data) ? response.data : {};
  const nestedData = isRecord(payloadRecord.data) ? payloadRecord.data : null;
  const message =
    normalizeCommunityChatMessage(payloadRecord.message) ??
    (nestedData ? normalizeCommunityChatMessage(nestedData.message) : null) ??
    (nestedData ? normalizeCommunityChatMessage(nestedData) : null) ??
    normalizeCommunityChatMessage(response.data);

  if (!message) {
    return errorResult<CommunityChatMessage>(response.status, "Не удалось разобрать сообщение сообщества", null);
  }

  return {
    data: message,
    error: null,
    status: response.status,
  };
}

export async function apiFetchCommunityRanking(
  communityId: string,
  params: {
    phone?: string | null;
    clientId?: string | null;
    tab?: CommunityRatingTabInput | null;
    period?: CommunityRatingPeriod | null;
  },
) {
  const normalizedCommunityId = communityId.trim();
  if (!normalizedCommunityId) {
    return errorResult<CommunityRankingResponse>(400, "Не указан communityId", null);
  }

  const query = new URLSearchParams();
  const phone = normalizePhone(params.phone);
  const clientId = params.clientId?.trim() || null;
  const tab = normalizeRatingTab(params.tab ?? "overall");
  const period = normalizeRatingPeriod(params.period ?? "30d");
  if (phone) query.set("phone", phone);
  if (clientId) query.set("clientId", clientId);
  query.set("tab", toCommunityRatingTransportTab(tab));
  query.set("period", period);
  query.set("calculationVersion", COMMUNITY_RATING_CALCULATION_VERSION);
  const requestOptions = {
    method: "GET" as const,
    ...buildCommunityGetOptions(DEV_COMMUNITY_RANKING_CACHE_TTL_MS),
  };
  let response = await request<unknown>(
    `/lk/communities/${encodeURIComponent(normalizedCommunityId)}/rating?${query.toString()}`,
    requestOptions,
  );
  if (response.error && response.status === 404) {
    response = await request<unknown>(
      `/lk/communities/${encodeURIComponent(normalizedCommunityId)}/ranking?${query.toString()}`,
      requestOptions,
    );
  }

  if (response.error) {
    return errorResult<CommunityRankingResponse>(response.status, response.error.message, null);
  }

  let parsed = extractCommunityRanking(response.data);
  if (!parsed) {
    const fallbackResponse = await request<unknown>(
      `/lk/communities/${encodeURIComponent(normalizedCommunityId)}/ranking?${query.toString()}`,
      {
        method: "GET",
        ...buildCommunityGetOptions(DEV_COMMUNITY_RANKING_CACHE_TTL_MS),
      },
    );
    if (!fallbackResponse.error) {
      parsed = extractCommunityRanking(fallbackResponse.data);
      response = fallbackResponse;
    }
  }

  if (!parsed) {
    return errorResult<CommunityRankingResponse>(response.status, "Не удалось разобрать рейтинг сообщества", null);
  }
  if (!isCurrentCommunityRatingCalculationVersion(parsed.calculationVersion)) {
    return errorResult<CommunityRankingResponse>(409, "Рейтинг обновляется. Попробуйте ещё раз через минуту.", null);
  }

  return {
    data: parsed,
    error: null,
    status: response.status,
  };
}

export function communityErrorMessage(error: ApiError | null, fallback: string) {
  if (error?.status === 413) {
    return "Изображение слишком большое. Попробуй загрузить логотип поменьше.";
  }

  return error?.message || fallback;
}
