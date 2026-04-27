import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ChangeEvent,
  type CSSProperties,
  type FormEvent,
  type TouchEvent as ReactTouchEvent,
  type UIEvent as ReactUIEvent,
  type WheelEvent as ReactWheelEvent,
} from "react";
import { Modal } from "../UI/Modal";
import { CommunityVerifiedBadge } from "../UI/CommunityVerifiedBadge";
import {
  apiCreateSupportDialogEvent,
  apiFetchExercisesByDate,
  apiFetchExercisesByVisibleDate,
  apiFetchPadelGameRecord,
  apiFetchTournamentParticipants,
  apiUpdatePadelGameRecord,
  type Exercise,
  type ExerciseBooking,
  type PadelGamePlayer,
  type PadelGameRecord,
  type UserProfileType,
} from "../../utils/apiClient";
import {
  apiAddCommunityMember,
  apiCreateCommunityChatMessage,
  apiCreateCommunity,
  apiCreateCommunityFeedPost,
  apiCreateCommunityPostComment,
  apiFetchCommunity,
  apiFetchCommunities,
  apiFetchCommunityChatMessages,
  apiFetchCommunityFeed,
  apiFetchCommunityPostThread,
  apiJoinCommunityByInvite,
  apiManageCommunityMember,
  apiSetCommunityPostReaction,
  apiUploadCommunityLogo,
  apiUpdateCommunity,
  apiUpdateCommunityFeedPost,
  buildCommunityInviteLink,
  buildCommunityLogoCandidates,
  communityErrorMessage,
  isVisibleCommunityPostKind,
  type CommunityActionResponse,
  type CommunityChatMessage,
  type CommunityConnection,
  type CommunityJoinRule,
  type CommunityMember,
  type CommunityMemberAction,
  type CommunityPost,
  type CommunityPostComment,
  type CommunityPostKind,
  type CommunityPostReaction,
  type CommunityPostThread,
  type CommunityRecord,
  type CommunityRole,
  type CommunityVisibility,
} from "../../utils/communityApi";
import type { OpenGamesOptions } from "../../types/gamesOverlay";
import {
  CUSTOM_FIELD_IDS,
  formatScoreDisplay,
  getCustomFieldValue,
  getLetterGrade,
  parseNumericLevel,
} from "../../utils/customFields";
import { getGameCommunityAutopublishState } from "../../utils/gameCommunityAutopublish";
import { CommunityScreen } from "./community-feed/CommunityScreen";
import { CommunityChatScreen } from "./community-feed/CommunityChatScreen";
import { CommunityFab } from "./community-feed/CommunityFab";
import { CommunityRankingScreen } from "./community-feed/CommunityRankingScreen";
import type { CommunitySecondaryNavItemId } from "./community-feed/CommunitySecondaryNav";
import { CommunityTableScreen } from "./community-feed/CommunityTableScreen";
import { buildFeedEntries } from "./community-feed/feedAdapter";
import type {
  CommunityBottomNavItemId,
  FeedEntry,
  FeedFabAction,
  Game,
  News,
  NewsComment,
  NewsReaction,
  NewsThreadData,
} from "./community-feed/feedTypes";

interface CommunityFormState {
  name: string;
  visibility: CommunityVisibility;
  description: string;
  city: string;
  focusTags: string;
  minimumLevel: string;
  joinRule: CommunityJoinRule;
  rules: string;
  logoUrl: string | null;
  logoThumbUrl: string | null;
}

interface FeedFormState {
  kind: Exclude<CommunityPostKind, "SYSTEM">;
  title: string;
  body: string;
  imageUrl: string | null;
  previewLabel: string;
  relatedGameId: string;
  relatedTournamentId: string;
}

interface FeedTournamentOption {
  tournament: Exercise;
  participants: ExerciseBooking[];
  relation: "trainer" | "participant";
}

interface FeedImageEditorState {
  source: string | null;
  zoom: number;
  focalX: number;
  focalY: number;
}

interface FeedImageDragState {
  touchX: number;
  touchY: number;
  focalX: number;
  focalY: number;
}

interface FeedImagePinchState {
  distance: number;
  zoom: number;
}

interface CommunitiesSectionProps {
  profile: UserProfileType;
  createdGames: PadelGameRecord[];
  onOpenGames: (options?: OpenGamesOptions) => void;
  onOpenTournaments: () => void;
  onOpenHome?: () => void;
  onOpenProfile?: () => void;
  initialInviteCode?: string | null;
  initialInviteLink?: string | null;
  inviteEntryCabinetUrl?: string | null;
}

type CommunityDetailTab = "FEED" | "CHAT" | "RANKING" | "TABLE" | "SETTINGS";
type CommunityLevelFilter = "D" | "D+" | "C" | "C+" | "B" | "B+" | "A";
type CommunityRankingPeriodId = "month" | "quarter" | "year" | "all";

interface CommunityGraphNodeLayout {
  community: CommunityRecord;
  x: number;
  y: number;
  size: number;
  isBase: boolean;
  anchorId: string | null;
}

interface CommunityGraphEdgeLayout {
  id: string;
  x1: number;
  y1: number;
  x2: number;
  y2: number;
  stroke: string;
  strokeWidth: number;
  opacity: number;
}

interface CommunityLogoFallbackState {
  signature: string;
  index: number;
}

interface CommunityStoryMetrics {
  latestActivityTs: number | null;
}

const LEVEL_OPTIONS: CommunityLevelFilter[] = ["D", "D+", "C", "C+", "B", "B+", "A"];
const COMMUNITY_ORDER_STORAGE_KEY_PREFIX = "padlhub.communities.order.v1";
const COMMUNITY_LAST_SEEN_STORAGE_KEY_PREFIX = "padlhub.communities.last-seen.v1";
const COMMUNITY_CHAT_LAST_READ_STORAGE_KEY_PREFIX = "padlhub.communities.chat-last-read.v1";
const COMMUNITY_FEED_PAGE_SIZE = 10;
const COMMUNITY_FEED_AUTOPUBLISH_REFRESH_WINDOW_MS = 1000 * 60 * 10;
const COMMUNITY_CHAT_PAGE_SIZE = 15;
const COMMUNITY_RANKING_FEED_PAGE_SIZE = 60;
const COMMUNITY_SUPPORT_CHANNEL = "WEB";
const COMMUNITY_SUPPORT_CONNECTOR = "WEB_LK";
const COMMUNITY_LOGO_MAX_DIMENSION = 640;
const COMMUNITY_LOGO_MAX_BYTES = 220 * 1024;
const COMMUNITY_LOGO_INITIAL_QUALITY = 0.86;
const COMMUNITY_LOGO_MIN_QUALITY = 0.5;
const COMMUNITY_LOGO_QUALITY_STEP = 0.08;
const COMMUNITY_GRAPH_MIN_ZOOM = 0.52;
const COMMUNITY_GRAPH_MAX_ZOOM = 1.65;
const COMMUNITY_GRAPH_DEFAULT_ZOOM = 0.88;
const COMMUNITY_GRAPH_ZOOM_STEP = 0.12;
const COMMUNITY_GRAPH_BASE_NODE_SCALE = 1.5;
const COMMUNITY_GRAPH_BASE_SPACING_MULTIPLIER = 2;
const COMMUNITY_GRAPH_BASE_CLEARANCE_TO_PERCENT = 0.28;
const COMMUNITY_TOURNAMENT_DIRECTION_ID = 2617;
const COMMUNITY_TOURNAMENT_LOOKAHEAD_DAYS = 14;
const COMMUNITY_TOURNAMENT_RECENT_GRACE_MS = 1000 * 60 * 60 * 6;
const COMMUNITY_GRAPH_CREATE_NODE = {
  left: 16,
  top: 16,
  size: 74,
} as const;
const COMMUNITY_GRAPH_SAFE_PADDING = {
  top: 52,
  right: 26,
  bottom: 54,
  left: 24,
} as const;
const EMPTY_FORM: CommunityFormState = {
  name: "",
  visibility: "OPEN",
  description: "",
  city: "Москва",
  focusTags: "",
  minimumLevel: "C",
  joinRule: "INSTANT",
  rules: "",
  logoUrl: null,
  logoThumbUrl: null,
};

const EMPTY_FEED_FORM: FeedFormState = {
  kind: "PHOTO",
  title: "",
  body: "",
  imageUrl: null,
  previewLabel: "",
  relatedGameId: "",
  relatedTournamentId: "",
};

const EMPTY_FEED_IMAGE_EDITOR: FeedImageEditorState = {
  source: null,
  zoom: 1,
  focalX: 50,
  focalY: 50,
};
const COMMUNITY_NEWS_IMAGE_FRAME = {
  width: 319,
  height: 160,
} as const;
const COMMUNITY_NEWS_EDITOR_PREVIEW = {
  width: 319,
  height: 160,
} as const;

function buildCommunityFormStateFromRecord(community: CommunityRecord): CommunityFormState {
  return {
    name: community.name,
    visibility: community.visibility,
    description: community.description,
    city: community.city,
    focusTags: community.focusTags.join(", "),
    minimumLevel: community.minimumLevel,
    joinRule: community.visibility === "CLOSED" ? "INVITE_ONLY" : community.joinRule,
    rules: community.rules,
    logoUrl: community.logoUrl,
    logoThumbUrl: community.logoThumbUrl ?? community.logoUrl,
  };
}

function getCommunityFormLogoPreview(formState: CommunityFormState) {
  return formState.logoThumbUrl || formState.logoUrl;
}

function parseCommunityFocusTags(value: string) {
  return value
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean)
    .slice(0, 6);
}

function getCommunityOrderStorageKey(profileId: string) {
  const normalizedProfileId = profileId.trim() || "guest";
  return `${COMMUNITY_ORDER_STORAGE_KEY_PREFIX}:${normalizedProfileId}`;
}

function getCommunityLastSeenStorageKey(profileId: string) {
  const normalizedProfileId = profileId.trim() || "guest";
  return `${COMMUNITY_LAST_SEEN_STORAGE_KEY_PREFIX}:${normalizedProfileId}`;
}

function getCommunityChatLastReadStorageKey(profileId: string) {
  const normalizedProfileId = profileId.trim() || "guest";
  return `${COMMUNITY_CHAT_LAST_READ_STORAGE_KEY_PREFIX}:${normalizedProfileId}`;
}

function loadCommunityOrderIds(profileId: string) {
  if (typeof window === "undefined") return [];

  try {
    const raw = window.localStorage.getItem(getCommunityOrderStorageKey(profileId));
    if (!raw) return [];

    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];

    return Array.from(new Set(
      parsed
        .map((value) => (typeof value === "string" ? value.trim() : ""))
        .filter(Boolean),
    ));
  } catch {
    return [];
  }
}

function loadPositiveNumberMap(storageKey: string) {
  if (typeof window === "undefined") return {} as Record<string, number>;

  try {
    const raw = window.localStorage.getItem(storageKey);
    if (!raw) return {};

    const parsed = JSON.parse(raw) as unknown;
    if (!isRecord(parsed)) return {};

    return Object.entries(parsed).reduce<Record<string, number>>((result, [communityId, value]) => {
      if (typeof communityId !== "string" || !communityId.trim()) return result;
      if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) return result;
      result[communityId] = value;
      return result;
    }, {});
  } catch {
    return {};
  }
}

function loadCommunityLastSeenById(profileId: string) {
  return loadPositiveNumberMap(getCommunityLastSeenStorageKey(profileId));
}

function loadCommunityChatLastReadById(profileId: string) {
  return loadPositiveNumberMap(getCommunityChatLastReadStorageKey(profileId));
}

function areStringListsEqual(left: string[], right: string[]) {
  if (left.length !== right.length) return false;
  return left.every((value, index) => value === right[index]);
}

function sortCommunitiesByPreference(communities: CommunityRecord[], preferredIds: string[]) {
  const orderIndex = new Map(preferredIds.map((id, index) => [id, index]));

  return [...communities].sort((left, right) => {
    const leftOrder = orderIndex.get(left.id);
    const rightOrder = orderIndex.get(right.id);
    const leftHasOrder = typeof leftOrder === "number";
    const rightHasOrder = typeof rightOrder === "number";

    if (leftHasOrder && rightHasOrder) {
      return (leftOrder ?? 0) - (rightOrder ?? 0);
    }

    if (leftHasOrder) return -1;
    if (rightHasOrder) return 1;

    const leftTs = Date.parse(left.updatedAt ?? left.createdAt);
    const rightTs = Date.parse(right.updatedAt ?? right.createdAt);
    const leftSafeTs = Number.isFinite(leftTs) ? leftTs : 0;
    const rightSafeTs = Number.isFinite(rightTs) ? rightTs : 0;
    if (leftSafeTs !== rightSafeTs) {
      return rightSafeTs - leftSafeTs;
    }

    return left.name.localeCompare(right.name, "ru");
  });
}

function syncCommunityOrderIds(currentOrderIds: string[], communities: CommunityRecord[]) {
  const knownIds = new Set(communities.map((community) => community.id));
  const nextOrderIds = currentOrderIds.filter((communityId) => knownIds.has(communityId));

  communities.forEach((community) => {
    if (!nextOrderIds.includes(community.id)) {
      nextOrderIds.push(community.id);
    }
  });

  return nextOrderIds;
}

function getCommunityRoleLabel(role: CommunityRole) {
  if (role === "OWNER") return "владелец";
  if (role === "ADMIN") return "админ";
  if (role === "MODERATOR") return "модератор";
  return "участник";
}

function getCommunityJoinRuleLabel(joinRule: CommunityJoinRule) {
  if (joinRule === "INSTANT") return "Сразу";
  if (joinRule === "MODERATED") return "После модерации";
  return "Только по приглашению";
}

function getCommunityRolePriority(role: CommunityRole) {
  if (role === "OWNER") return 0;
  if (role === "ADMIN") return 1;
  if (role === "MODERATOR") return 2;
  return 3;
}

function canCreateTournamentFeedPost(role: CommunityRole | null | undefined) {
  return role === "OWNER" || role === "ADMIN" || role === "MODERATOR";
}

function getCommunityGraphWeight(community: Pick<CommunityRecord, "memberCount" | "members">) {
  return Math.max(community.memberCount, community.members.length, 1);
}

function getCommunityGraphConnectionId(left: string, right: string) {
  return left < right ? `${left}::${right}` : `${right}::${left}`;
}

function isPadlHubBaseCommunity(community: Pick<CommunityRecord, "name">) {
  const normalized = String(community.name || "")
    .toLowerCase()
    .replace(/[\s_.-]+/g, "");
  return normalized.includes("падлхаб")
    || normalized.includes("padlhub")
    || normalized.includes("padelhub");
}

function pickBaseCommunities(communities: CommunityRecord[]) {
  const sortByWeight = (left: CommunityRecord, right: CommunityRecord) => {
    const weightDiff = getCommunityGraphWeight(right) - getCommunityGraphWeight(left);
    if (weightDiff !== 0) return weightDiff;
    return left.name.localeCompare(right.name, "ru");
  };

  const explicit = communities.filter(isPadlHubBaseCommunity).sort(sortByWeight);
  if (explicit.length > 0) {
    return explicit;
  }

  const fallbackCount = communities.length <= 3
    ? communities.length
    : Math.min(3, Math.max(1, Math.ceil(communities.length / 4)));

  return [...communities].sort(sortByWeight).slice(0, fallbackCount);
}

function canManageCommunityMember(
  managerRole: CommunityRole | null | undefined,
  member: CommunityMember,
  profileId: string,
  profilePhone: string | null,
) {
  const isCurrentUser =
    (member.id && member.id === profileId)
    || Boolean(profilePhone && member.phone && member.phone === profilePhone);

  if (!managerRole || isCurrentUser || member.role === "OWNER") {
    return false;
  }

  if (managerRole === "OWNER") {
    return true;
  }

  return managerRole === "ADMIN" && member.role === "MEMBER";
}

function clamp(min: number, value: number, max: number) {
  return Math.min(max, Math.max(min, value));
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function getTouchDistance(
  touchA: Pick<ReactTouchEvent<HTMLDivElement>["touches"][number], "clientX" | "clientY">,
  touchB: Pick<ReactTouchEvent<HTMLDivElement>["touches"][number], "clientX" | "clientY">,
) {
  return Math.hypot(touchA.clientX - touchB.clientX, touchA.clientY - touchB.clientY);
}

function normalizePhone(value: string | null | undefined) {
  const digits = String(value || "").replace(/\D/g, "");
  if (!digits) return null;
  if (digits.length === 10) return `7${digits}`;
  if (digits.length === 11 && digits.startsWith("8")) return `7${digits.slice(1)}`;
  return digits;
}

function dedupeGamePlayers(players: PadelGamePlayer[]) {
  const byIdentity = new Map<string, PadelGamePlayer>();

  players.forEach((player, index) => {
    const normalizedPhone = normalizePhone(player.phone);
    const normalizedId = (player.id || "").trim();
    const normalizedName = player.name.trim().toLowerCase();
    const key = normalizedPhone || normalizedId || normalizedName || `player-${index}`;
    byIdentity.set(key, player);
  });

  return Array.from(byIdentity.values());
}

function removeGamePlayer(
  players: PadelGamePlayer[],
  currentUserPhone: string | null,
  currentUserId: string | null,
) {
  return players.filter((player) => {
    const samePhone = Boolean(currentUserPhone && player.phone && normalizePhone(player.phone) === currentUserPhone);
    const sameId = Boolean(currentUserId && player.id && player.id === currentUserId);
    return !samePhone && !sameId;
  });
}

function resolveGameMaxPlayers(game: PadelGameRecord) {
  const inviteMaxPlayers = game.invite?.maxPlayers;
  if (typeof inviteMaxPlayers === "number" && Number.isFinite(inviteMaxPlayers) && inviteMaxPlayers > 0) {
    return Math.floor(inviteMaxPlayers);
  }

  const metadata = game.metadata;
  if (isRecord(metadata) && typeof metadata.maxPlayers === "number" && Number.isFinite(metadata.maxPlayers) && metadata.maxPlayers > 0) {
    return Math.floor(metadata.maxPlayers);
  }

  return 4;
}

function resolveGameWaitlistEnabled(game: PadelGameRecord) {
  if (typeof game.invite?.waitlistEnabled === "boolean") {
    return game.invite.waitlistEnabled;
  }

  const metadata = game.metadata;
  if (isRecord(metadata) && typeof metadata.waitlistEnabled === "boolean") {
    return metadata.waitlistEnabled;
  }

  return true;
}

function isCurrentUserInGameRecord(
  game: PadelGameRecord,
  currentUserId: string | null,
  currentUserPhone: string | null,
) {
  const isSamePlayer = (player: PadelGamePlayer) => {
    const samePhone = Boolean(currentUserPhone && player.phone && normalizePhone(player.phone) === currentUserPhone);
    const sameId = Boolean(currentUserId && player.id && player.id === currentUserId);
    return samePhone || sameId;
  };

  return (game.participants ?? []).some(isSamePlayer) || (game.waitlist ?? []).some(isSamePlayer);
}

function mergeGameRecord(current: PadelGameRecord | undefined, incoming: PadelGameRecord) {
  if (!current) return incoming;

  return {
    ...current,
    ...incoming,
    organizer: incoming.organizer ?? current.organizer ?? null,
    booking: incoming.booking ?? current.booking ?? null,
    payment: incoming.payment ?? current.payment ?? null,
    settings: incoming.settings ?? current.settings ?? null,
    metadata: incoming.metadata ?? current.metadata ?? null,
    invite: incoming.invite ?? current.invite ?? null,
    participants: incoming.participants ?? current.participants ?? [],
    waitlist: incoming.waitlist ?? current.waitlist ?? [],
  };
}

function formatCommunityDate(value: string) {
  const parsed = Date.parse(value);
  if (!Number.isFinite(parsed)) return "Недавно";
  return new Date(parsed).toLocaleDateString("ru-RU", {
    day: "2-digit",
    month: "short",
  });
}

function getInitials(name: string) {
  return name
    .split(" ")
    .filter(Boolean)
    .slice(0, 2)
    .map((part) => part[0] ?? "")
    .join("")
    .toUpperCase();
}

function getCommunityPostActivityTs(post: Pick<CommunityPost, "createdTs" | "publishedAt">) {
  if (typeof post.createdTs === "number" && Number.isFinite(post.createdTs) && post.createdTs > 0) {
    return post.createdTs;
  }

  const parsed = Date.parse(String(post.publishedAt || "").trim());
  return Number.isFinite(parsed) ? parsed : null;
}

function getCommunityVisibleFeedActivityTs(community: CommunityRecord) {
  if (
    typeof community.lastVisibleFeedActivityTs === "number"
    && Number.isFinite(community.lastVisibleFeedActivityTs)
    && community.lastVisibleFeedActivityTs > 0
  ) {
    return community.lastVisibleFeedActivityTs;
  }

  const parsed = Date.parse(String(community.lastVisibleFeedActivityAt || "").trim());
  return Number.isFinite(parsed) ? parsed : null;
}

function getCommunityStoryMetrics(community: CommunityRecord, posts: CommunityPost[]): CommunityStoryMetrics {
  const latestLoadedVisiblePostTs = posts.reduce<number | null>((latest, post) => {
    if (!isVisibleCommunityPostKind(post.kind)) return latest;
    const postTs = getCommunityPostActivityTs(post);
    if (postTs === null) return latest;
    if (latest === null) return postTs;
    return Math.max(latest, postTs);
  }, null);
  const latestActivityTs = [getCommunityVisibleFeedActivityTs(community), latestLoadedVisiblePostTs]
    .reduce<number | null>((latest, value) => {
      if (value === null) return latest;
      if (latest === null) return value;
      return Math.max(latest, value);
    }, null);

  return {
    latestActivityTs,
  };
}

function CommunityStoryRing({ isHighlighted }: { isHighlighted: boolean }) {
  return (
    <span
      className={`community-story-ring${isHighlighted ? " is-highlighted" : ""}`}
      aria-hidden="true"
    />
  );
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

function extractInviteCode(value: string) {
  const raw = value.trim();
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

function getNodePalette(seed: string) {
  let hash = 0;
  for (let index = 0; index < seed.length; index += 1) {
    hash = (hash << 5) - hash + seed.charCodeAt(index);
    hash |= 0;
  }
  const hue = Math.abs(hash) % 360;
  return {
    start: `hsla(${hue}, 70%, 54%, 0.95)`,
    end: `hsla(${(hue + 38) % 360}, 78%, 48%, 0.92)`,
    glow: `hsla(${hue}, 75%, 55%, 0.22)`,
  };
}

function getLevelScoreFromProfile(profile: UserProfileType) {
  const numeric = parseNumericLevel(getCustomFieldValue(profile, CUSTOM_FIELD_IDS.lkPadelLevelNumeric));
  if (numeric !== null) {
    return clamp(1.5, numeric, 6);
  }

  const labelRaw = getCustomFieldValue(profile, CUSTOM_FIELD_IDS.lkPadelLevel) ?? "C";
  const matchedIndex = LEVEL_OPTIONS.findIndex((item) => item === labelRaw.trim().toUpperCase());
  if (matchedIndex >= 0) {
    return matchedIndex + 1.5;
  }
  return 3.2;
}

function buildCommunityActor(profile: UserProfileType, role: CommunityRole = "MEMBER") {
  const name = `${profile.firstName || ""} ${profile.lastName || ""}`.trim() || "Игрок";
  const levelScore = getLevelScoreFromProfile(profile);

  return {
    id: profile.id || null,
    phone: profile.phone || null,
    name,
    avatar: profile.photo,
    role,
    levelScore,
    levelLabel: getLetterGrade(levelScore),
  };
}

function identityKey(id: string | null, phone: string | null, name: string) {
  if (id) return `id:${id}`;
  if (phone) return `phone:${phone}`;
  return `name:${name.toLowerCase()}`;
}

function isCommunityMember(
  community: CommunityRecord,
  profileId: string,
  profilePhone: string | null,
) {
  return community.members.some((member) => {
    const byId = Boolean(profileId && member.id && member.id === profileId);
    const byPhone = Boolean(profilePhone && member.phone && member.phone === profilePhone);
    return byId || byPhone;
  });
}

function isCommunityAccessible(
  community: CommunityRecord,
  profileId: string,
  profilePhone: string | null,
) {
  if (community.visibility === "OPEN") return true;
  return isCommunityMember(community, profileId, profilePhone);
}

function findCommunityMember(
  community: CommunityRecord,
  profileId: string,
  profilePhone: string | null,
) {
  return community.members.find((member) => {
    const byId = Boolean(profileId && member.id && member.id === profileId);
    const byPhone = Boolean(profilePhone && member.phone && member.phone === profilePhone);
    return byId || byPhone;
  }) ?? null;
}

function buildConnectionsFromMembers(communities: CommunityRecord[]): CommunityConnection[] {
  const connections: CommunityConnection[] = [];
  for (let leftIndex = 0; leftIndex < communities.length; leftIndex += 1) {
    const left = communities[leftIndex];
    if (!left) continue;

    const leftKeys = new Set(
      left.members.map((member) => identityKey(member.id, member.phone, member.name)),
    );

    for (let rightIndex = leftIndex + 1; rightIndex < communities.length; rightIndex += 1) {
      const right = communities[rightIndex];
      if (!right) continue;

      const overlap = right.members.reduce((count, member) => {
        const key = identityKey(member.id, member.phone, member.name);
        return count + (leftKeys.has(key) ? 1 : 0);
      }, 0);

      if (overlap > 0) {
        connections.push({
          left: left.id,
          right: right.id,
          overlap,
        });
      }
    }
  }
  return connections;
}

function normalizeRankingLevelLabel(value: string | null | undefined, levelScore: number) {
  if (Number.isFinite(levelScore)) {
    return getLetterGrade(clamp(1, levelScore, 6));
  }
  const normalized = String(value || "").trim().toUpperCase();
  return LEVEL_OPTIONS.includes(normalized as CommunityLevelFilter)
    ? normalized
    : getLetterGrade(levelScore);
}

interface CommunityRankingStatsRow {
  rank: number;
  id: string | null;
  phone: string | null;
  name: string;
  avatar: string | null;
  role: CommunityRole;
  levelScore: number;
  levelLabel: string;
  matchesPlayed: number;
  matchesWon: number;
  matchesLost: number;
  setsWon: number;
  setsLost: number;
  gamesWon: number;
  gamesLost: number;
  ratingDeltaSum: number;
}

interface CommunityRankingData {
  rows: CommunityRankingStatsRow[];
  confirmedGamesCount: number;
}

function getIdentityKeys(value: { id?: string | null; phone?: string | null; name?: string | null }) {
  const keys: string[] = [];
  const normalizedId = (value.id || "").trim();
  const normalizedPhone = normalizePhone(value.phone);
  const normalizedName = (value.name || "").trim().toLowerCase();

  if (normalizedId) keys.push(`id:${normalizedId}`);
  if (normalizedPhone) keys.push(`phone:${normalizedPhone}`);
  if (normalizedName) keys.push(`name:${normalizedName}`);

  return keys;
}

function getPrimaryIdentityKey(value: { id?: string | null; phone?: string | null; name?: string | null }, fallback: string) {
  return getIdentityKeys(value)[0] ?? `fallback:${fallback}`;
}

function getCommunityRankingPeriodStart(period: CommunityRankingPeriodId, nowTs: number) {
  if (period === "all") return null;
  if (period === "month") return nowTs - (30 * 24 * 60 * 60 * 1000);
  if (period === "quarter") return nowTs - (90 * 24 * 60 * 60 * 1000);
  return nowTs - (365 * 24 * 60 * 60 * 1000);
}

function getCommunityGameMatchResult(game: PadelGameRecord | undefined) {
  const metadata = game?.metadata;
  if (!metadata || typeof metadata !== "object" || Array.isArray(metadata)) return null;

  const rawMatchResult = (metadata as Record<string, unknown>).matchResult;
  return rawMatchResult && typeof rawMatchResult === "object" && !Array.isArray(rawMatchResult)
    ? rawMatchResult as Record<string, unknown>
    : null;
}

function isConfirmedCommunityGameResult(game: PadelGameRecord | undefined) {
  const rawMatchResult = getCommunityGameMatchResult(game);
  if (!rawMatchResult) return false;

  const status = typeof rawMatchResult.status === "string"
    ? rawMatchResult.status.trim().toUpperCase()
    : "";

  return status === "CONFIRMED"
    || Boolean(rawMatchResult.confirmedAt || rawMatchResult.confirmedBy);
}

function getCommunityGameResultSets(game: PadelGameRecord | undefined) {
  const rawMatchResult = getCommunityGameMatchResult(game);
  const rawSets = Array.isArray(rawMatchResult?.sets) ? rawMatchResult.sets : [];

  return rawSets
    .map((item) => {
      if (!isRecord(item)) return null;
      const left = Number(item.left);
      const right = Number(item.right);
      if (!Number.isFinite(left) || !Number.isFinite(right)) return null;

      return {
        left: Math.max(0, Math.floor(left)),
        right: Math.max(0, Math.floor(right)),
      };
    })
    .filter((item): item is { left: number; right: number } => Boolean(item));
}

function getCommunityGamePlayedTimestamp(game: PadelGameRecord | undefined) {
  const bookingDate = game?.booking?.date?.trim();
  const timeTo = game?.booking?.timeTo?.trim();
  const timeFrom = game?.booking?.timeFrom?.trim();

  if (bookingDate && timeTo) {
    const parsed = Date.parse(`${bookingDate}T${timeTo}:00`);
    if (Number.isFinite(parsed)) return parsed;
  }

  if (bookingDate && timeFrom) {
    const parsed = Date.parse(`${bookingDate}T${timeFrom}:00`);
    if (Number.isFinite(parsed)) return parsed;
  }

  const updatedAtTs = Date.parse(game?.updatedAt || "");
  if (Number.isFinite(updatedAtTs)) return updatedAtTs;

  const createdAtTs = Date.parse(game?.createdAt || "");
  return Number.isFinite(createdAtTs) ? createdAtTs : null;
}

function getCommunityRankingParticipants(game: PadelGameRecord | undefined) {
  const participants = dedupeGamePlayers(
    (game?.participants ?? []).filter((player) => player.status !== "WAITLIST"),
  );

  if (participants.length > 0) {
    return participants;
  }

  if (game?.organizer?.name) {
    return [{
      id: game.organizer.id ?? null,
      name: game.organizer.name || "Организатор",
      phone: game.organizer.phone ?? null,
      photo: game.organizer.photo ?? null,
      rating: game.organizer.rating ?? null,
      ratingNumeric: game.organizer.ratingNumeric ?? null,
      status: "CONFIRMED" as const,
      source: "ORGANIZER" as const,
    }];
  }

  return [];
}

function resolveCommunityRankingTeams(game: PadelGameRecord | undefined) {
  const participants = getCommunityRankingParticipants(game);
  const participantByKey = new Map<string, PadelGamePlayer>();

  participants.forEach((player) => {
    getIdentityKeys({ id: player.id, phone: player.phone, name: player.name }).forEach((key) => {
      participantByKey.set(key, player);
    });
  });

  const metadata = game?.metadata;
  const rawTeamSlots = metadata && typeof metadata === "object" && !Array.isArray(metadata) && Array.isArray((metadata as Record<string, unknown>).teamSlots)
    ? (metadata as Record<string, unknown>).teamSlots as unknown[]
    : [];

  const resolveSlot = (value: unknown) => {
    if (typeof value === "string") {
      const direct = participantByKey.get(value.trim());
      if (direct) return direct;

      const byPhone = normalizePhone(value);
      if (byPhone) {
        const fromPhone = participantByKey.get(`phone:${byPhone}`);
        if (fromPhone) return fromPhone;
      }

      const byName = participantByKey.get(`name:${value.trim().toLowerCase()}`);
      if (byName) return byName;
      return null;
    }

    if (!isRecord(value)) return null;

    const candidateKeys = getIdentityKeys({
      id: typeof value.id === "string" ? value.id : null,
      phone: typeof value.phone === "string" ? value.phone : null,
      name: typeof value.name === "string" ? value.name : null,
    });

    for (const key of candidateKeys) {
      const matched = participantByKey.get(key);
      if (matched) return matched;
    }

    return null;
  };

  const slotPlayers = rawTeamSlots
    .slice(0, 4)
    .map(resolveSlot)
    .filter((player): player is PadelGamePlayer => Boolean(player));

  if (slotPlayers.length === 2) {
    return {
      left: dedupeGamePlayers([slotPlayers[0]]),
      right: dedupeGamePlayers([slotPlayers[1]]),
    };
  }

  if (slotPlayers.length >= 3) {
    return {
      left: dedupeGamePlayers(slotPlayers.slice(0, 2)),
      right: dedupeGamePlayers(slotPlayers.slice(2, 4)),
    };
  }

  if (participants.length === 2) {
    return {
      left: [participants[0]],
      right: [participants[1]],
    };
  }

  const middle = Math.ceil(participants.length / 2);
  return {
    left: dedupeGamePlayers(participants.slice(0, middle)),
    right: dedupeGamePlayers(participants.slice(middle, 4)),
  };
}

function getCommunityGameRatingDeltaEntries(game: PadelGameRecord | undefined) {
  const rawMatchResult = getCommunityGameMatchResult(game);
  const rawEntries = Array.isArray(rawMatchResult?.ratingImpact) ? rawMatchResult.ratingImpact : [];

  return rawEntries
    .map((item) => {
      if (!isRecord(item)) return null;
      const delta = typeof item.delta === "number" && Number.isFinite(item.delta)
        ? item.delta
        : null;
      if (delta == null) return null;

      return {
        id: typeof item.id === "string" ? item.id.trim() || null : null,
        phone: typeof item.phoneNorm === "string" ? item.phoneNorm : null,
        name: typeof item.name === "string" ? item.name.trim() || null : null,
        delta,
      };
    })
    .filter((item): item is { id: string | null; phone: string | null; name: string | null; delta: number } => Boolean(item));
}

function roundRankingDelta(value: number) {
  return Math.round(value * 1000) / 1000;
}

function buildCommunityRankingData(
  community: Pick<CommunityRecord, "members">,
  games: PadelGameRecord[],
  period: CommunityRankingPeriodId,
  nowTs: number,
): CommunityRankingData {
  const memberByKey = new Map<string, CommunityMember>();
  const statsByMemberKey = new Map<string, CommunityRankingStatsRow>();
  const periodStartTs = getCommunityRankingPeriodStart(period, nowTs);
  let confirmedGamesCount = 0;

  const ensureStatsRow = (member: CommunityMember) => {
    const primaryKey = getPrimaryIdentityKey(member, member.name);
    const existing = statsByMemberKey.get(primaryKey);
    if (existing) return existing;

    const nextRow: CommunityRankingStatsRow = {
      rank: 0,
      id: member.id,
      phone: member.phone,
      name: member.name,
      avatar: member.avatar,
      role: member.role,
      levelScore: member.levelScore,
      levelLabel: normalizeRankingLevelLabel(member.levelLabel, member.levelScore),
      matchesPlayed: 0,
      matchesWon: 0,
      matchesLost: 0,
      setsWon: 0,
      setsLost: 0,
      gamesWon: 0,
      gamesLost: 0,
      ratingDeltaSum: 0,
    };

    statsByMemberKey.set(primaryKey, nextRow);
    return nextRow;
  };

  const resolveCommunityMember = (value: { id?: string | null; phone?: string | null; name?: string | null }) => {
    const keys = getIdentityKeys(value);
    for (const key of keys) {
      const matched = memberByKey.get(key);
      if (matched) return matched;
    }
    return null;
  };

  community.members.forEach((member) => {
    getIdentityKeys(member).forEach((key) => {
      memberByKey.set(key, member);
    });
  });

  games.forEach((game) => {
    if (!isConfirmedCommunityGameResult(game)) return;

    const gameTs = getCommunityGamePlayedTimestamp(game);
    if (periodStartTs != null && (!gameTs || gameTs < periodStartTs)) {
      return;
    }

    const sets = getCommunityGameResultSets(game);
    if (sets.length === 0) return;

    const { left, right } = resolveCommunityRankingTeams(game);
    if (left.length === 0 || right.length === 0) return;

    const leftMembers = Array.from(new Set(
      left
        .map((player) => resolveCommunityMember(player))
        .filter((member): member is CommunityMember => Boolean(member)),
    ));
    const rightMembers = Array.from(new Set(
      right
        .map((player) => resolveCommunityMember(player))
        .filter((member): member is CommunityMember => Boolean(member)),
    ));

    if (leftMembers.length === 0 && rightMembers.length === 0) return;

    confirmedGamesCount += 1;

    const leftGamesWon = sets.reduce((total, setItem) => total + setItem.left, 0);
    const rightGamesWon = sets.reduce((total, setItem) => total + setItem.right, 0);
    const leftSetsWon = sets.reduce((total, setItem) => total + (setItem.left > setItem.right ? 1 : 0), 0);
    const rightSetsWon = sets.reduce((total, setItem) => total + (setItem.right > setItem.left ? 1 : 0), 0);
    const leftWonMatch = leftSetsWon > rightSetsWon || (leftSetsWon === rightSetsWon && leftGamesWon > rightGamesWon);
    const rightWonMatch = rightSetsWon > leftSetsWon || (leftSetsWon === rightSetsWon && rightGamesWon > leftGamesWon);

    leftMembers.forEach((member) => {
      const row = ensureStatsRow(member);
      row.matchesPlayed += 1;
      row.gamesWon += leftGamesWon;
      row.gamesLost += rightGamesWon;
      row.setsWon += leftSetsWon;
      row.setsLost += rightSetsWon;
      if (leftWonMatch) row.matchesWon += 1;
      if (rightWonMatch) row.matchesLost += 1;
    });

    rightMembers.forEach((member) => {
      const row = ensureStatsRow(member);
      row.matchesPlayed += 1;
      row.gamesWon += rightGamesWon;
      row.gamesLost += leftGamesWon;
      row.setsWon += rightSetsWon;
      row.setsLost += leftSetsWon;
      if (rightWonMatch) row.matchesWon += 1;
      if (leftWonMatch) row.matchesLost += 1;
    });

    getCommunityGameRatingDeltaEntries(game).forEach((entry) => {
      const member = resolveCommunityMember(entry);
      if (!member) return;
      const row = ensureStatsRow(member);
      row.ratingDeltaSum = roundRankingDelta(row.ratingDeltaSum + entry.delta);
    });
  });

  const rows = Array.from(statsByMemberKey.values())
    .filter((row) => row.matchesPlayed > 0)
    .sort((left, right) => {
      if (right.ratingDeltaSum !== left.ratingDeltaSum) return right.ratingDeltaSum - left.ratingDeltaSum;
      if (right.matchesWon !== left.matchesWon) return right.matchesWon - left.matchesWon;

      const leftSetDiff = left.setsWon - left.setsLost;
      const rightSetDiff = right.setsWon - right.setsLost;
      if (rightSetDiff !== leftSetDiff) return rightSetDiff - leftSetDiff;

      const leftGameDiff = left.gamesWon - left.gamesLost;
      const rightGameDiff = right.gamesWon - right.gamesLost;
      if (rightGameDiff !== leftGameDiff) return rightGameDiff - leftGameDiff;

      if (right.matchesPlayed !== left.matchesPlayed) return right.matchesPlayed - left.matchesPlayed;
      return left.name.localeCompare(right.name, "ru");
    })
    .map((row, index) => ({
      ...row,
      rank: index + 1,
      ratingDeltaSum: roundRankingDelta(row.ratingDeltaSum),
    }));

  return {
    rows,
    confirmedGamesCount,
  };
}

function upsertCommunity(
  communities: CommunityRecord[],
  nextCommunity: CommunityRecord,
  preferredIds: string[],
) {
  const filtered = communities.filter((community) => community.id !== nextCommunity.id);
  return sortCommunitiesByPreference([nextCommunity, ...filtered], preferredIds);
}

function prependPost(posts: CommunityPost[], nextPost: CommunityPost) {
  const visiblePosts = posts.filter((post) => isVisibleCommunityPostKind(post.kind));
  if (!isVisibleCommunityPostKind(nextPost.kind)) {
    return visiblePosts.sort((left, right) => right.createdTs - left.createdTs);
  }

  return [nextPost, ...visiblePosts.filter((post) => post.id !== nextPost.id)].sort(
    (left, right) => right.createdTs - left.createdTs,
  );
}

function mergeCommunityPosts(posts: CommunityPost[]) {
  const byId = new Map<string, CommunityPost>();
  posts.forEach((post) => {
    if (!post.id || !isVisibleCommunityPostKind(post.kind)) return;
    byId.set(post.id, post);
  });
  return Array.from(byId.values()).sort((left, right) => right.createdTs - left.createdTs);
}

function parseRecordTimestamp(value: string | null | undefined) {
  const parsed = Date.parse(String(value || "").trim());
  return Number.isFinite(parsed) ? parsed : null;
}

function withCommunityVisibleFeedActivity(
  community: CommunityRecord,
  activityTs: number,
  activityAt?: string | null,
) {
  if (!Number.isFinite(activityTs) || activityTs <= 0) {
    return community;
  }

  const currentTs = getCommunityVisibleFeedActivityTs(community);
  if (currentTs !== null && currentTs >= activityTs) {
    return community;
  }

  return {
    ...community,
    lastVisibleFeedActivityAt: (activityAt || "").trim() || new Date(activityTs).toISOString(),
    lastVisibleFeedActivityTs: activityTs,
  };
}

function getGameCommunityFeedActivityTs(game: PadelGameRecord) {
  return [
    parseRecordTimestamp(game.updatedAt),
    parseRecordTimestamp(game.createdAt),
  ].reduce<number | null>((latest, value) => {
    if (value === null) return latest;
    if (latest === null) return value;
    return Math.max(latest, value);
  }, null);
}

function hasCommunityGamePost(
  posts: CommunityPost[],
  gameId: string,
  expectedPostId: string | null,
) {
  return posts.some((post) => (
    (expectedPostId ? post.id === expectedPostId : false)
    || (post.kind === "GAME" && (post.relatedGameId?.trim() || "") === gameId)
  ));
}

function mapCommunityReactionToNewsReaction(reaction: CommunityPostReaction | null | undefined): NewsReaction {
  if (reaction === "LIKE") return "like";
  if (reaction === "DISLIKE") return "dislike";
  return null;
}

function mapNewsReactionToCommunityReaction(reaction: NewsReaction): CommunityPostReaction | null {
  if (reaction === "like") return "LIKE";
  if (reaction === "dislike") return "DISLIKE";
  return null;
}

function updateCommunityPostById(
  posts: CommunityPost[],
  postId: string,
  updater: (post: CommunityPost) => CommunityPost,
) {
  return posts.map((post) => (post.id === postId ? updater(post) : post));
}

function applyCommunityThreadToPost(post: CommunityPost, thread: CommunityPostThread): CommunityPost {
  return {
    ...post,
    likesCount: thread.likesCount,
    dislikesCount: thread.dislikesCount,
    commentsCount: thread.commentsCount,
    viewerReaction: thread.viewerReaction,
  };
}

function applyCommunityReactionToPost(post: CommunityPost, reaction: NewsReaction): CommunityPost {
  const previousReaction = mapCommunityReactionToNewsReaction(post.viewerReaction);
  return {
    ...post,
    likesCount: Math.max(
      0,
      (post.likesCount ?? 0)
        - (previousReaction === "like" ? 1 : 0)
        + (reaction === "like" ? 1 : 0),
    ),
    dislikesCount: Math.max(
      0,
      (post.dislikesCount ?? 0)
        - (previousReaction === "dislike" ? 1 : 0)
        + (reaction === "dislike" ? 1 : 0),
    ),
    viewerReaction: mapNewsReactionToCommunityReaction(reaction),
  };
}

function incrementCommunityPostComments(post: CommunityPost): CommunityPost {
  return {
    ...post,
    commentsCount: (post.commentsCount ?? 0) + 1,
  };
}

function getCommunityChatMessageStableKey(message: CommunityChatMessage) {
  return message.id || [
    message.communityId,
    message.createdTs,
    message.authorId ?? message.authorPhone ?? message.authorName,
    message.text,
  ].join(":");
}

function getCommunityChatMessageTimestamp(message: Pick<CommunityChatMessage, "createdAt" | "createdTs">) {
  if (Number.isFinite(message.createdTs) && message.createdTs > 0) {
    return message.createdTs;
  }

  const parsed = Date.parse(message.createdAt);
  return Number.isFinite(parsed) ? parsed : 0;
}

function mergeCommunityChatMessages(
  current: CommunityChatMessage[],
  incoming: CommunityChatMessage[],
) {
  const byId = new Map<string, CommunityChatMessage>();
  [...current, ...incoming].forEach((message) => {
    byId.set(getCommunityChatMessageStableKey(message), message);
  });
  return Array.from(byId.values()).sort(
    (left, right) => getCommunityChatMessageTimestamp(left) - getCommunityChatMessageTimestamp(right),
  );
}

function isChatNearBottom(node: HTMLDivElement, threshold = 72) {
  return node.scrollHeight - node.scrollTop - node.clientHeight <= threshold;
}

function buildGameBody(game: PadelGameRecord) {
  const date = game.booking?.date
    ? new Date(`${game.booking.date}T00:00:00`).toLocaleDateString("ru-RU", {
        day: "2-digit",
        month: "long",
      })
    : "ближайшая дата";
  const timeFrom = game.booking?.timeFrom ?? "—:—";
  const timeTo = game.booking?.timeTo ?? "—:—";
  const location = [game.booking?.studioName, game.booking?.roomName].filter(Boolean).join(", ");

  return [date, `${timeFrom} - ${timeTo}`, location].filter(Boolean).join(" • ");
}

function buildGamePreviewLabel(game: PadelGameRecord) {
  return [game.booking?.studioName, game.booking?.roomName].filter(Boolean).join(" • ") || "Матч сообщества";
}

function formatGameOption(game: PadelGameRecord) {
  const date = game.booking?.date
    ? new Date(`${game.booking.date}T00:00:00`).toLocaleDateString("ru-RU", {
        day: "2-digit",
        month: "short",
      })
    : "Без даты";
  const timeFrom = game.booking?.timeFrom ?? "—:—";
  const court = [game.booking?.studioName, game.booking?.roomName].filter(Boolean).join(", ");
  return [date, timeFrom, court].filter(Boolean).join(" • ");
}

function formatCommunityApiDate(value: Date) {
  const year = value.getFullYear();
  const month = String(value.getMonth() + 1).padStart(2, "0");
  const day = String(value.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

function addDays(value: Date, amount: number) {
  const next = new Date(value);
  next.setDate(next.getDate() + amount);
  return next;
}

function formatExerciseTime(value?: string | null) {
  return value ? value.slice(11, 16) : "—:—";
}

function isTournamentExercise(exercise: Exercise) {
  return exercise.direction?.id === COMMUNITY_TOURNAMENT_DIRECTION_ID
    || exercise.type?.id === COMMUNITY_TOURNAMENT_DIRECTION_ID;
}

function getExerciseTimestamp(value?: string | null) {
  if (!value) return Number.NaN;
  return new Date(value).getTime();
}

function isAvailableTournamentExercise(exercise: Exercise) {
  if (!isTournamentExercise(exercise)) return false;

  const currentDayKey = formatCommunityApiDate(new Date());
  const exerciseDayTs = getExerciseTimestamp(exercise.timeFrom || exercise.timeTo);
  if (Number.isFinite(exerciseDayTs) && formatCommunityApiDate(new Date(exerciseDayTs)) === currentDayKey) {
    return true;
  }

  const endTs = getExerciseTimestamp(exercise.timeTo || exercise.timeFrom);
  if (!Number.isFinite(endTs)) return true;
  return endTs >= Date.now() - COMMUNITY_TOURNAMENT_RECENT_GRACE_MS;
}

function extractTournamentBookings(data: unknown): ExerciseBooking[] {
  return Array.isArray(data)
    ? data
    : Array.isArray((data as { payload?: ExerciseBooking[] } | null | undefined)?.payload)
      ? (data as { payload: ExerciseBooking[] }).payload
      : Array.isArray((data as { content?: ExerciseBooking[] } | null | undefined)?.content)
        ? (data as { content: ExerciseBooking[] }).content
        : [];
}

function isSameTournamentBookingParticipant(
  booking: ExerciseBooking,
  currentUserId: string | null,
  currentUserPhone: string | null,
) {
  const bookingClientId = (booking.client?.id || "").trim() || null;
  const bookingPhone = normalizePhone(booking.client?.phone);
  return Boolean(
    !booking.isCancelled
    && (
      (currentUserId && bookingClientId && bookingClientId === currentUserId)
      || (currentUserPhone && bookingPhone && bookingPhone === currentUserPhone)
    )
  );
}

function isTournamentTrainer(exercise: Exercise, currentUserId: string | null) {
  if (!currentUserId) return false;
  return (exercise.trainers ?? []).some((trainer) => (trainer.id || "").trim() === currentUserId);
}

function buildTournamentTitle(exercise: Exercise) {
  return exercise.direction?.name || exercise.type?.name || "Турнир";
}

function buildTournamentPreviewLabel(option: FeedTournamentOption) {
  const location = [option.tournament.studio?.name, option.tournament.room?.name]
    .filter(Boolean)
    .join(" • ");
  return location || "Турнир сообщества";
}

function buildTournamentBody(option: FeedTournamentOption) {
  const tournament = option.tournament;
  const date = tournament.timeFrom
    ? new Date(tournament.timeFrom).toLocaleDateString("ru-RU", {
        day: "2-digit",
        month: "long",
      })
    : "ближайшая дата";
  const timeLabel = [formatExerciseTime(tournament.timeFrom), formatExerciseTime(tournament.timeTo)].join(" - ");
  const location = [tournament.studio?.name, tournament.room?.name].filter(Boolean).join(", ");
  const activeParticipants = option.participants.filter((participant) => !participant.isCancelled);
  const participantsCount = Math.max(activeParticipants.length, tournament.clientsCount || 0);
  const maxParticipants = tournament.maxClientsCount > 0 ? tournament.maxClientsCount : null;
  const participantsLabel = maxParticipants
    ? `${participantsCount}/${maxParticipants} участников`
    : `${participantsCount} участников`;

  return [date, timeLabel, location, participantsLabel].filter(Boolean).join(" • ");
}

function formatTournamentOption(option: FeedTournamentOption) {
  const tournament = option.tournament;
  const date = tournament.timeFrom
    ? new Date(tournament.timeFrom).toLocaleDateString("ru-RU", {
        day: "2-digit",
        month: "short",
      })
    : "Без даты";
  const location = [tournament.studio?.name, tournament.room?.name].filter(Boolean).join(", ");
  const relationLabel = option.relation === "trainer" ? "исполнитель" : "участник";

  return [
    date,
    formatExerciseTime(tournament.timeFrom),
    buildTournamentTitle(tournament),
    location,
    relationLabel,
  ].filter(Boolean).join(" • ");
}

function getGameTimestamp(game: PadelGameRecord, type: "start" | "end" = "start"): number {
  const date = game.booking?.date;
  const rawTime =
    type === "end"
      ? (game.booking?.timeTo ?? game.booking?.timeFrom)
      : (game.booking?.timeFrom ?? game.booking?.timeTo);

  if (rawTime) {
    const directParsed = new Date(rawTime).getTime();
    if (Number.isFinite(directParsed)) return directParsed;
  }

  if (!date || !rawTime) return Number.POSITIVE_INFINITY;

  const normalizedTime = /^\d{2}:\d{2}$/.test(rawTime) ? `${rawTime}:00` : rawTime;
  const parsed = new Date(`${date}T${normalizedTime}`).getTime();
  return Number.isFinite(parsed) ? parsed : Number.POSITIVE_INFINITY;
}

function isCancelledGameRecord(game: PadelGameRecord): boolean {
  return String(game.status || "").toUpperCase().includes("CANCEL");
}

function hasCompletedMatchResult(game: PadelGameRecord): boolean {
  const metadata = game.metadata;
  if (!metadata || typeof metadata !== "object" || Array.isArray(metadata)) return false;

  const matchResult = (metadata as Record<string, unknown>).matchResult;
  if (!matchResult || typeof matchResult !== "object" || Array.isArray(matchResult)) return false;

  const status = String((matchResult as Record<string, unknown>).status || "").trim().toUpperCase();
  if (status.includes("CONFIRM") || status.includes("COMPLET")) return true;
  return Boolean((matchResult as Record<string, unknown>).confirmedAt);
}

function isUpcomingGameRecord(game: PadelGameRecord): boolean {
  if (isCancelledGameRecord(game)) return false;

  const endTs = getGameTimestamp(game, "end");
  if (!Number.isFinite(endTs)) return !hasCompletedMatchResult(game);

  return endTs >= Date.now();
}

async function readFileAsDataUrl(file: File) {
  return new Promise<string>((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(typeof reader.result === "string" ? reader.result : "");
    reader.onerror = () => reject(new Error("Не удалось прочитать файл"));
    reader.readAsDataURL(file);
  });
}

function getDataUrlApproximateSize(dataUrl: string) {
  const commaIndex = dataUrl.indexOf(",");
  const base64Body = commaIndex >= 0 ? dataUrl.slice(commaIndex + 1) : dataUrl;
  const padding = base64Body.endsWith("==") ? 2 : base64Body.endsWith("=") ? 1 : 0;
  return Math.max(0, Math.floor((base64Body.length * 3) / 4) - padding);
}

async function loadImageElement(src: string) {
  return new Promise<HTMLImageElement>((resolve, reject) => {
    const image = new Image();
    image.onload = () => resolve(image);
    image.onerror = () => reject(new Error("Не удалось загрузить изображение"));
    image.src = src;
  });
}

function buildCoverImageStyle(
  naturalWidth: number,
  naturalHeight: number,
  frameWidth: number,
  frameHeight: number,
  zoom: number,
  focalX: number,
  focalY: number,
) {
  const safeZoom = Math.max(1, zoom);
  const baseScale = Math.max(frameWidth / naturalWidth, frameHeight / naturalHeight);
  const drawWidth = naturalWidth * baseScale * safeZoom;
  const drawHeight = naturalHeight * baseScale * safeZoom;
  const left = (frameWidth - drawWidth) * (focalX / 100);
  const top = (frameHeight - drawHeight) * (focalY / 100);

  return {
    width: drawWidth,
    height: drawHeight,
    left,
    top,
  };
}

async function optimizeCommunityLogo(file: File) {
  if (!file.type.startsWith("image/")) {
    throw new Error("Можно загрузить только изображение.");
  }

  const source = await readFileAsDataUrl(file);
  const image = await loadImageElement(source);
  const naturalWidth = image.naturalWidth || image.width;
  const naturalHeight = image.naturalHeight || image.height;

  if (!naturalWidth || !naturalHeight) {
    throw new Error("Не удалось подготовить изображение.");
  }

  const scale = Math.min(1, COMMUNITY_LOGO_MAX_DIMENSION / Math.max(naturalWidth, naturalHeight));
  const outputWidth = Math.max(1, Math.round(naturalWidth * scale));
  const outputHeight = Math.max(1, Math.round(naturalHeight * scale));

  const canvas = document.createElement("canvas");
  const renderVariant = (targetWidth: number, targetHeight: number, maxBytes: number) => {
    canvas.width = targetWidth;
    canvas.height = targetHeight;
    const ctx = canvas.getContext("2d");
    if (!ctx) {
      throw new Error("Не удалось подготовить изображение.");
    }

    ctx.fillStyle = "#ffffff";
    ctx.fillRect(0, 0, targetWidth, targetHeight);
    ctx.drawImage(image, 0, 0, targetWidth, targetHeight);

    let quality = COMMUNITY_LOGO_INITIAL_QUALITY;
    let result = canvas.toDataURL("image/jpeg", quality);

    while (getDataUrlApproximateSize(result) > maxBytes && quality > COMMUNITY_LOGO_MIN_QUALITY) {
      quality = Math.max(COMMUNITY_LOGO_MIN_QUALITY, Number((quality - COMMUNITY_LOGO_QUALITY_STEP).toFixed(2)));
      result = canvas.toDataURL("image/jpeg", quality);
    }

    if (getDataUrlApproximateSize(result) > maxBytes) {
      throw new Error("Логотип слишком тяжёлый. Выбери изображение поменьше.");
    }

    return result;
  };

  const originalDataUrl = renderVariant(outputWidth, outputHeight, COMMUNITY_LOGO_MAX_BYTES);
  const thumbScale = Math.min(1, 160 / Math.max(naturalWidth, naturalHeight));
  const thumbWidth = Math.max(1, Math.round(naturalWidth * thumbScale));
  const thumbHeight = Math.max(1, Math.round(naturalHeight * thumbScale));
  const thumbDataUrl = renderVariant(thumbWidth, thumbHeight, 48 * 1024);

  return {
    originalDataUrl,
    thumbDataUrl,
  };
}

async function renderFeedNewsImage(
  source: string,
  crop: FeedImageEditorState,
  frameWidth = COMMUNITY_NEWS_IMAGE_FRAME.width,
  frameHeight = COMMUNITY_NEWS_IMAGE_FRAME.height,
) {
  const image = await loadImageElement(source);
  const outputScale = 3;
  const outputWidth = frameWidth * outputScale;
  const outputHeight = frameHeight * outputScale;
  const canvas = document.createElement("canvas");
  canvas.width = outputWidth;
  canvas.height = outputHeight;
  const ctx = canvas.getContext("2d");
  if (!ctx) {
    throw new Error("Не удалось подготовить изображение");
  }

  const coverStyle = buildCoverImageStyle(
    image.naturalWidth || image.width,
    image.naturalHeight || image.height,
    outputWidth,
    outputHeight,
    crop.zoom,
    crop.focalX,
    crop.focalY,
  );

  ctx.drawImage(image, coverStyle.left, coverStyle.top, coverStyle.width, coverStyle.height);
  return canvas.toDataURL("image/jpeg", 0.92);
}

function isCoarsePointerDevice() {
  if (typeof window === "undefined" || typeof window.matchMedia !== "function") {
    return false;
  }

  return window.matchMedia("(pointer: coarse)").matches;
}

function navigateToInviteCabinet(urlValue: string | null | undefined) {
  if (typeof window === "undefined") return false;

  const target = (urlValue || "").trim();
  if (!target) return false;

  try {
    if (window.top && window.top !== window) {
      window.top.location.href = target;
      return true;
    }
  } catch {
    // Fallback to same-window navigation.
  }

  try {
    window.location.assign(target);
    return true;
  } catch {
    // Fallback to an anchor click below.
  }

  try {
    const anchor = document.createElement("a");
    anchor.href = target;
    anchor.target = "_self";
    anchor.rel = "noopener noreferrer";
    anchor.style.display = "none";
    document.body.appendChild(anchor);
    anchor.click();
    anchor.remove();
    return true;
  } catch {
    return false;
  }
}

export function CommunitiesSection({
  profile,
  createdGames,
  onOpenGames,
  onOpenTournaments,
  onOpenHome,
  onOpenProfile,
  initialInviteCode,
  initialInviteLink,
  inviteEntryCabinetUrl,
}: CommunitiesSectionProps) {
  const profileId = profile.id || "current-user";
  const profilePhone = normalizePhone(profile.phone);
  const currentMember = useMemo(() => buildCommunityActor(profile), [profile]);
  const redirectToInviteCabinet = useCallback(
    () => navigateToInviteCabinet(inviteEntryCabinetUrl),
    [inviteEntryCabinetUrl],
  );

  const [communities, setCommunities] = useState<CommunityRecord[]>([]);
  const [communityOrderIds, setCommunityOrderIds] = useState<string[]>(() => loadCommunityOrderIds(profile.id || "current-user"));
  const [communityLastSeenById, setCommunityLastSeenById] = useState<Record<string, number>>(() =>
    loadCommunityLastSeenById(profile.id || "current-user"),
  );
  const [communityChatLastReadById, setCommunityChatLastReadById] = useState<Record<string, number>>(() =>
    loadCommunityChatLastReadById(profile.id || "current-user"),
  );
  const [communityLogoFallbackById, setCommunityLogoFallbackById] = useState<Record<string, CommunityLogoFallbackState>>({});
  const [connections, setConnections] = useState<CommunityConnection[]>([]);
  const [communitiesError, setCommunitiesError] = useState<string | null>(null);

  const [isCreateOpen, setIsCreateOpen] = useState(false);
  const [isInviteOpen, setIsInviteOpen] = useState(false);
  const [selectedCommunityId, setSelectedCommunityId] = useState<string | null>(null);
  const [focusedCommunityId, setFocusedCommunityId] = useState<string | null>(null);

  const [inviteValue, setInviteValue] = useState("");
  const [inviteError, setInviteError] = useState<string | null>(null);
  const [inviteSubmitting, setInviteSubmitting] = useState(false);
  const initialInviteHandledRef = useRef<string | null>(null);

  const [accessMessage, setAccessMessage] = useState<string | null>(null);
  const [isCommunityActionsOpen, setIsCommunityActionsOpen] = useState(false);
  const [isCommunityLeaveConfirmOpen, setIsCommunityLeaveConfirmOpen] = useState(false);
  const [isCommunityReportOpen, setIsCommunityReportOpen] = useState(false);
  const [communityActionError, setCommunityActionError] = useState<string | null>(null);
  const [communityReportText, setCommunityReportText] = useState("");
  const [communityReportError, setCommunityReportError] = useState<string | null>(null);
  const [communityReportSubmitting, setCommunityReportSubmitting] = useState(false);
  const [communityLeaveSubmitting, setCommunityLeaveSubmitting] = useState(false);

  const [formState, setFormState] = useState<CommunityFormState>(EMPTY_FORM);
  const [formError, setFormError] = useState<string | null>(null);
  const [creatingCommunity, setCreatingCommunity] = useState(false);
  const [editFormState, setEditFormState] = useState<CommunityFormState>(EMPTY_FORM);
  const [editFormError, setEditFormError] = useState<string | null>(null);
  const [editingCommunity, setEditingCommunity] = useState(false);
  const [editSubmitting, setEditSubmitting] = useState(false);
  const [memberActionError, setMemberActionError] = useState<string | null>(null);
  const [managingMemberKey, setManagingMemberKey] = useState<string | null>(null);

  const [feedByCommunityId, setFeedByCommunityId] = useState<Record<string, CommunityPost[]>>({});
  const [feedNextBeforeTsByCommunityId, setFeedNextBeforeTsByCommunityId] = useState<Record<string, number | null>>({});
  const [feedHasMoreByCommunityId, setFeedHasMoreByCommunityId] = useState<Record<string, boolean>>({});
  const [feedGameRecordById, setFeedGameRecordById] = useState<Record<string, PadelGameRecord>>({});
  const [rankingGameIdsByCommunityId, setRankingGameIdsByCommunityId] = useState<Record<string, string[]>>({});
  const [rankingGameIdsLoadedByCommunityId, setRankingGameIdsLoadedByCommunityId] = useState<Record<string, boolean>>({});
  const [chatByCommunityId, setChatByCommunityId] = useState<Record<string, CommunityChatMessage[]>>({});
  const [chatNextBeforeTsByCommunityId, setChatNextBeforeTsByCommunityId] = useState<Record<string, number | null>>({});
  const [chatHasMoreByCommunityId, setChatHasMoreByCommunityId] = useState<Record<string, boolean>>({});
  const [chatLoadedByCommunityId, setChatLoadedByCommunityId] = useState<Record<string, boolean>>({});
  const [detailLoadedByCommunityId, setDetailLoadedByCommunityId] = useState<Record<string, boolean>>({});
  const [detailLoadingId, setDetailLoadingId] = useState<string | null>(null);
  const [feedLoadingMoreId, setFeedLoadingMoreId] = useState<string | null>(null);
  const [chatLoadingId, setChatLoadingId] = useState<string | null>(null);
  const [chatLoadingMoreId, setChatLoadingMoreId] = useState<string | null>(null);
  const [chatSendingId, setChatSendingId] = useState<string | null>(null);
  const [detailError, setDetailError] = useState<string | null>(null);
  const [rankingRefreshLoadingId, setRankingRefreshLoadingId] = useState<string | null>(null);
  const [rankingRefreshError, setRankingRefreshError] = useState<string | null>(null);
  const [joiningCommunityId, setJoiningCommunityId] = useState<string | null>(null);
  const [joiningGameId, setJoiningGameId] = useState<string | null>(null);
  const [activeCommunityTab, setActiveCommunityTab] = useState<CommunityDetailTab>("FEED");
  const [activeRankingPeriod, setActiveRankingPeriod] = useState<CommunityRankingPeriodId>("all");
  const [isFeedComposerOpen, setIsFeedComposerOpen] = useState(false);
  const [graphZoomOverride, setGraphZoomOverride] = useState<number | null>(null);
  const [graphViewport, setGraphViewport] = useState({ width: 0, height: 0 });
  const [chatDraft, setChatDraft] = useState("");
  const [chatError, setChatError] = useState<string | null>(null);

  const [feedFormState, setFeedFormState] = useState<FeedFormState>(EMPTY_FEED_FORM);
  const [feedTournamentOptions, setFeedTournamentOptions] = useState<FeedTournamentOption[]>([]);
  const [feedTournamentOptionsLoading, setFeedTournamentOptionsLoading] = useState(false);
  const [feedTournamentOptionsError, setFeedTournamentOptionsError] = useState<string | null>(null);
  const [feedImageEditor, setFeedImageEditor] = useState<FeedImageEditorState>(EMPTY_FEED_IMAGE_EDITOR);
  const [feedImageNaturalSize, setFeedImageNaturalSize] = useState<{ width: number; height: number } | null>(null);
  const [isMobileTouchEditor, setIsMobileTouchEditor] = useState(() => isCoarsePointerDevice());
  const [feedFormError, setFeedFormError] = useState<string | null>(null);
  const [feedSubmitting, setFeedSubmitting] = useState(false);
  const [editingFeedPostId, setEditingFeedPostId] = useState<string | null>(null);
  const [isFocusedCommunityHintOpen, setIsFocusedCommunityHintOpen] = useState(false);
  const [expandedGraphCommunityId, setExpandedGraphCommunityId] = useState<string | null>(null);
  const storiesScrollerRef = useRef<HTMLDivElement | null>(null);
  const graphViewportRef = useRef<HTMLDivElement | null>(null);
  const newsImagePreviewRef = useRef<HTMLDivElement | null>(null);
  const chatScrollRef = useRef<HTMLDivElement | null>(null);
  const pinchZoomRef = useRef<{ distance: number; zoom: number } | null>(null);
  const feedImageDragRef = useRef<FeedImageDragState | null>(null);
  const feedImagePinchRef = useRef<FeedImagePinchState | null>(null);
  const chatScrollActionRef = useRef<
    | { type: "bottom"; communityId: string; behavior: ScrollBehavior }
    | { type: "preserve"; communityId: string; previousScrollHeight: number; previousScrollTop: number }
    | null
  >(null);
  const communityOrderIdsRef = useRef<string[]>(communityOrderIds);
  const loadingCommunityDetailIdsRef = useRef<Set<string>>(new Set());
  const refreshingCommunityFeedIdsRef = useRef<Set<string>>(new Set());
  const attemptedAutopublishFeedRefreshKeysRef = useRef<Set<string>>(new Set());
  const pendingAutopublishFeedRefreshAttemptsRef = useRef<Record<string, number>>({});

  useEffect(() => {
    setCommunityOrderIds(loadCommunityOrderIds(profileId));
  }, [profileId]);

  useEffect(() => {
    setCommunityLastSeenById(loadCommunityLastSeenById(profileId));
  }, [profileId]);

  useEffect(() => {
    setCommunityChatLastReadById(loadCommunityChatLastReadById(profileId));
  }, [profileId]);

  useEffect(() => {
    communityOrderIdsRef.current = communityOrderIds;
  }, [communityOrderIds]);

  useEffect(() => {
    if (typeof window === "undefined") return;

    try {
      window.localStorage.setItem(
        getCommunityOrderStorageKey(profileId),
        JSON.stringify(communityOrderIds),
      );
    } catch {
      // Ignore local persistence errors in the client sandbox.
    }
  }, [communityOrderIds, profileId]);

  useEffect(() => {
    if (typeof window === "undefined") return;

    try {
      window.localStorage.setItem(
        getCommunityLastSeenStorageKey(profileId),
        JSON.stringify(communityLastSeenById),
      );
    } catch {
      // Ignore local persistence errors in the client sandbox.
    }
  }, [communityLastSeenById, profileId]);

  useEffect(() => {
    if (typeof window === "undefined") return;

    try {
      window.localStorage.setItem(
        getCommunityChatLastReadStorageKey(profileId),
        JSON.stringify(communityChatLastReadById),
      );
    } catch {
      // Ignore local persistence errors in the client sandbox.
    }
  }, [communityChatLastReadById, profileId]);

  useEffect(() => {
    const node = graphViewportRef.current;
    if (!node || typeof ResizeObserver === "undefined") return undefined;

    const observer = new ResizeObserver((entries) => {
      const entry = entries[0];
      if (!entry) return;
      setGraphViewport({
        width: entry.contentRect.width,
        height: entry.contentRect.height,
      });
    });

    observer.observe(node);
    return () => observer.disconnect();
  }, []);

  useEffect(() => {
    if (typeof window === "undefined" || typeof window.matchMedia !== "function") return undefined;

    const mediaQuery = window.matchMedia("(pointer: coarse)");
    const syncPointerMode = () => setIsMobileTouchEditor(mediaQuery.matches);
    syncPointerMode();

    if (typeof mediaQuery.addEventListener === "function") {
      mediaQuery.addEventListener("change", syncPointerMode);
      return () => mediaQuery.removeEventListener("change", syncPointerMode);
    }

    mediaQuery.addListener(syncPointerMode);
    return () => mediaQuery.removeListener(syncPointerMode);
  }, []);

  useEffect(() => {
    let cancelled = false;

    const loadCommunities = async () => {
      const response = await apiFetchCommunities({
        phone: profile.phone,
        clientId: profile.id,
        view: "summary",
      });

      if (cancelled) return;

      if (response.error) {
        setCommunities([]);
        setConnections([]);
        setCommunitiesError(
          communityErrorMessage(response.error, "Не удалось загрузить сообщества из базы"),
        );
        return;
      }

      const nextCommunities = response.data?.communities ?? [];
      const nextConnections = response.data?.connections?.length
        ? response.data.connections
        : buildConnectionsFromMembers(nextCommunities);

      setCommunities(sortCommunitiesByPreference(nextCommunities, communityOrderIdsRef.current));
      setConnections(nextConnections);
      setCommunitiesError(null);
    };

    void loadCommunities();

    return () => {
      cancelled = true;
    };
  }, [profile.id, profile.phone]);

  useEffect(() => {
    setCommunities((current) => sortCommunitiesByPreference(current, communityOrderIds));
  }, [communityOrderIds]);

  useEffect(() => {
    setCommunityOrderIds((current) => {
      const nextOrderIds = syncCommunityOrderIds(current, communities);
      return areStringListsEqual(current, nextOrderIds) ? current : nextOrderIds;
    });
  }, [communities]);

  const joinedCommunities = useMemo(() => (
    communities.filter((community) => isCommunityMember(community, profileId, profilePhone))
  ), [communities, profileId, profilePhone]);

  useEffect(() => {
    if (communities.length === 0) {
      setFocusedCommunityId(null);
      setSelectedCommunityId(null);
      setExpandedGraphCommunityId(null);
      return;
    }

    setFocusedCommunityId((current) => (
      current && communities.some((community) => community.id === current)
        ? current
        : communities[0]?.id ?? null
    ));

    setSelectedCommunityId((current) => (
      current && communities.some((community) => community.id === current)
        ? current
        : current
    ));
    setExpandedGraphCommunityId((current) => (
      current && communities.some((community) => community.id === current)
        ? current
        : null
    ));
  }, [communities]);

  useEffect(() => {
    const node = storiesScrollerRef.current;
    if (!node) return;
    node.scrollLeft = 0;
  }, [joinedCommunities]);

  useEffect(() => {
    setFeedFormState(EMPTY_FEED_FORM);
    setFeedTournamentOptions([]);
    setFeedTournamentOptionsLoading(false);
    setFeedTournamentOptionsError(null);
    setFeedFormError(null);
    setEditingFeedPostId(null);
    setChatDraft("");
    setChatError(null);
    setRankingRefreshError(null);
    setEditingCommunity(false);
    setEditFormError(null);
    setMemberActionError(null);
    setManagingMemberKey(null);
    setIsCommunityActionsOpen(false);
    setIsCommunityLeaveConfirmOpen(false);
    setIsCommunityReportOpen(false);
    setCommunityActionError(null);
    setCommunityReportText("");
    setCommunityReportError(null);
    setCommunityReportSubmitting(false);
    setCommunityLeaveSubmitting(false);
    setActiveCommunityTab("FEED");
    setActiveRankingPeriod("all");
    setIsFeedComposerOpen(false);
  }, [selectedCommunityId]);

  const selectedCommunity = communities.find((community) => community.id === selectedCommunityId) ?? null;
  const focusedCommunity = communities.find((community) => community.id === focusedCommunityId) ?? communities[0] ?? null;

  const effectiveConnections = connections.length > 0 ? connections : buildConnectionsFromMembers(communities);
  const selectedCommunityMember = selectedCommunity
    ? findCommunityMember(selectedCommunity, profileId, profilePhone)
    : null;
  const canManageSelectedCommunity = selectedCommunityMember?.role === "OWNER"
    || selectedCommunityMember?.role === "ADMIN";
  const canLeaveSelectedCommunity = Boolean(selectedCommunityMember);

  useEffect(() => {
    if (activeCommunityTab === "SETTINGS" && !canManageSelectedCommunity) {
      setActiveCommunityTab("FEED");
    }
  }, [activeCommunityTab, canManageSelectedCommunity]);

  useEffect(() => {
    if (!selectedCommunity) {
      setEditFormState(EMPTY_FORM);
      return;
    }
    setEditFormState(buildCommunityFormStateFromRecord(selectedCommunity));
  }, [selectedCommunityId, selectedCommunity]);

  useEffect(() => {
    setIsFocusedCommunityHintOpen(false);
  }, [focusedCommunityId]);

  useEffect(() => {
    if (activeCommunityTab !== "RANKING" || !selectedCommunity) {
      return;
    }

    if (!isCommunityAccessible(selectedCommunity, profileId, profilePhone)) {
      return;
    }

    if (rankingGameIdsLoadedByCommunityId[selectedCommunity.id]) {
      return;
    }

    let cancelled = false;

    const loadRankingGames = async () => {
      setRankingRefreshLoadingId(selectedCommunity.id);
      setRankingRefreshError(null);
      const collectedGameIds = new Set<string>();
      let beforeTs: number | undefined;
      let hasMore = true;
      let safetyCounter = 0;

      while (hasMore && safetyCounter < 40) {
        safetyCounter += 1;

        const response = await apiFetchCommunityFeed(selectedCommunity.id, {
          phone: profile.phone,
          clientId: profile.id,
          limit: COMMUNITY_RANKING_FEED_PAGE_SIZE,
          beforeTs,
        });

        if (cancelled) return;

        if (response.error) {
          setRankingRefreshError(
            communityErrorMessage(response.error, "Не удалось загрузить игры сообщества для рейтинга"),
          );
          setRankingRefreshLoadingId(null);
          return;
        }

        const posts = response.data?.posts ?? [];
        posts.forEach((post) => {
          if (post.kind !== "GAME") return;
          const gameId = post.relatedGameId?.trim() || "";
          if (!gameId) return;
          collectedGameIds.add(gameId);
        });

        const nextBeforeTs = response.data?.nextBeforeTs ?? null;
        hasMore = Boolean(response.data?.hasMore && nextBeforeTs && nextBeforeTs !== beforeTs);
        beforeTs = nextBeforeTs ?? undefined;
      }

      const createdGameIds = new Set(
        createdGames
          .map((game) => game.id?.trim() || "")
          .filter(Boolean),
      );
      const missingGameIds = Array.from(collectedGameIds).filter((gameId) => (
        !createdGameIds.has(gameId)
        && !feedGameRecordById[gameId]
      ));

      if (missingGameIds.length > 0) {
        const results = await Promise.all(
          missingGameIds.map(async (gameId) => ({
            gameId,
            response: await apiFetchPadelGameRecord(gameId),
          })),
        );

        if (cancelled) return;

        setFeedGameRecordById((current) => {
          const next = { ...current };

          results.forEach(({ gameId, response }) => {
            if (!response.data) return;
            next[gameId] = mergeGameRecord(current[gameId], response.data);
          });

          return next;
        });
      }

      if (cancelled) return;

      setRankingGameIdsByCommunityId((current) => ({
        ...current,
        [selectedCommunity.id]: Array.from(collectedGameIds),
      }));
      setRankingGameIdsLoadedByCommunityId((current) => ({
        ...current,
        [selectedCommunity.id]: true,
      }));
      setRankingRefreshLoadingId(null);
    };

    void loadRankingGames();

    return () => {
      cancelled = true;
    };
  }, [
    activeCommunityTab,
    createdGames,
    feedGameRecordById,
    profile.id,
    profile.phone,
    profileId,
    profilePhone,
    rankingGameIdsLoadedByCommunityId,
    selectedCommunity,
  ]);

  useEffect(() => {
    if (!selectedCommunityId) {
      setDetailError(null);
      return;
    }

    if (!selectedCommunity) {
      return;
    }

    if (!isCommunityAccessible(selectedCommunity, profileId, profilePhone)) {
      return;
    }

    const communityId = selectedCommunity.id;
    const shouldLoadMembers = !selectedCommunity.membersLoaded;

    if (loadingCommunityDetailIdsRef.current.has(communityId)) {
      return;
    }

    let cancelled = false;

    const loadDetails = async () => {
      loadingCommunityDetailIdsRef.current.add(communityId);
      setDetailLoadingId(communityId);
      setDetailError(null);

      try {
        // Keep one in-flight loader per community id. Replacing the summary record with
        // the full community record should not cancel the feed request for the same id.
        if (shouldLoadMembers) {
          const communityResponse = await apiFetchCommunity(communityId, {
            phone: profile.phone,
            clientId: profile.id,
            forceFresh: true,
          });

          if (cancelled) return;

          if (communityResponse.error || !communityResponse.data) {
            setDetailError(
              communityErrorMessage(
                communityResponse.error ?? { status: 500, message: "Не удалось загрузить сообщество" },
                "Не удалось загрузить сообщество",
              ),
            );
            return;
          }

          const fullCommunity = communityResponse.data;
          setCommunities((current) => upsertCommunity(current, fullCommunity, communityOrderIdsRef.current));
        }

        const feedResponse = await apiFetchCommunityFeed(communityId, {
          phone: profile.phone,
          clientId: profile.id,
          limit: COMMUNITY_FEED_PAGE_SIZE,
          forceFresh: true,
        });

        if (cancelled) return;

        if (feedResponse.error) {
          setDetailError(
            communityErrorMessage(
              feedResponse.error,
              "Не удалось загрузить ленту сообщества",
            ),
          );
          return;
        }

        const nextFeedPosts = mergeCommunityPosts(feedResponse.data?.posts ?? []);
        setFeedByCommunityId((current) => ({
          ...current,
          [communityId]: nextFeedPosts,
        }));
        setFeedNextBeforeTsByCommunityId((current) => ({
          ...current,
          [communityId]: feedResponse.data?.nextBeforeTs ?? null,
        }));
        setFeedHasMoreByCommunityId((current) => ({
          ...current,
          [communityId]: feedResponse.data?.hasMore ?? (nextFeedPosts.length >= COMMUNITY_FEED_PAGE_SIZE),
        }));
        setDetailLoadedByCommunityId((current) => ({
          ...current,
          [communityId]: true,
        }));
      } finally {
        loadingCommunityDetailIdsRef.current.delete(communityId);
        setDetailLoadingId((current) => (current === communityId ? null : current));
      }
    };

    void loadDetails();

    return () => {
      cancelled = true;
    };
  }, [profile.id, profile.phone, profileId, profilePhone, selectedCommunityId, Boolean(selectedCommunity)]);

  const refreshCommunityFeedPage = useCallback(async (
    communityId: string,
    options: { forceFresh?: boolean } = {},
  ) => {
    const community = communities.find((item) => item.id === communityId) ?? null;
    if (!community) return false;
    if (!isCommunityAccessible(community, profileId, profilePhone)) return false;
    if (refreshingCommunityFeedIdsRef.current.has(communityId)) return false;

    refreshingCommunityFeedIdsRef.current.add(communityId);

    try {
      const response = await apiFetchCommunityFeed(communityId, {
        phone: profile.phone,
        clientId: profile.id,
        limit: COMMUNITY_FEED_PAGE_SIZE,
        forceFresh: options.forceFresh,
      });

      if (response.error) {
        if (selectedCommunityId === communityId) {
          setDetailError(
            communityErrorMessage(
              response.error,
              "Не удалось обновить ленту сообщества",
            ),
          );
        }
        return false;
      }

      const nextFeedPosts = mergeCommunityPosts(response.data?.posts ?? []);
      setFeedByCommunityId((current) => ({
        ...current,
        [communityId]: nextFeedPosts,
      }));
      setFeedNextBeforeTsByCommunityId((current) => ({
        ...current,
        [communityId]: response.data?.nextBeforeTs ?? null,
      }));
      setFeedHasMoreByCommunityId((current) => ({
        ...current,
        [communityId]: response.data?.hasMore ?? (nextFeedPosts.length >= COMMUNITY_FEED_PAGE_SIZE),
      }));
      setDetailLoadedByCommunityId((current) => ({
        ...current,
        [communityId]: true,
      }));
      return true;
    } finally {
      refreshingCommunityFeedIdsRef.current.delete(communityId);
    }
  }, [
    communities,
    profile.id,
    profile.phone,
    profileId,
    profilePhone,
    selectedCommunityId,
  ]);

  useEffect(() => {
    const loadedCommunityIds = Object.entries(detailLoadedByCommunityId)
      .filter(([, isLoaded]) => isLoaded)
      .map(([communityId]) => communityId);

    if (loadedCommunityIds.length === 0) {
      return;
    }

    const loadedCommunityIdSet = new Set(loadedCommunityIds);
    const refreshTargets = new Set<string>();
    const nowTs = Date.now();

    createdGames.forEach((game) => {
      const gameId = game.id?.trim() || "";
      if (!gameId) return;
      if (game.settings?.isPrivate === true) return;
      if (String(game.status || "").trim().toUpperCase().includes("CANCEL")) return;

      const activityTs = getGameCommunityFeedActivityTs(game);
      if (activityTs === null || nowTs - activityTs > COMMUNITY_FEED_AUTOPUBLISH_REFRESH_WINDOW_MS) {
        return;
      }

      const autopublishState = getGameCommunityAutopublishState(game);
      if (autopublishState.selectedCommunityIds.length === 0) {
        return;
      }

      autopublishState.selectedCommunityIds.forEach((communityId) => {
        if (!loadedCommunityIdSet.has(communityId)) return;
        if (detailLoadingId === communityId || feedLoadingMoreId === communityId) return;

        const currentPosts = feedByCommunityId[communityId] ?? [];
        const expectedPostId = autopublishState.postsByCommunityId[communityId] ?? null;
        if (hasCommunityGamePost(currentPosts, gameId, expectedPostId)) {
          delete pendingAutopublishFeedRefreshAttemptsRef.current[`${communityId}:${gameId}`];
          return;
        }

        const pendingRefreshKey = `${communityId}:${gameId}`;
        if (!expectedPostId) {
          const attempts = pendingAutopublishFeedRefreshAttemptsRef.current[pendingRefreshKey] ?? 0;
          if (attempts >= 2) {
            return;
          }
          pendingAutopublishFeedRefreshAttemptsRef.current[pendingRefreshKey] = attempts + 1;
          refreshTargets.add(communityId);
          return;
        }

        delete pendingAutopublishFeedRefreshAttemptsRef.current[pendingRefreshKey];
        const refreshKey = `${communityId}:${gameId}:${expectedPostId ?? "pending"}:${activityTs}`;
        if (attemptedAutopublishFeedRefreshKeysRef.current.has(refreshKey)) {
          return;
        }

        attemptedAutopublishFeedRefreshKeysRef.current.add(refreshKey);
        refreshTargets.add(communityId);
      });
    });

    refreshTargets.forEach((communityId) => {
      void refreshCommunityFeedPage(communityId, { forceFresh: true });
    });
  }, [
    createdGames,
    detailLoadedByCommunityId,
    detailLoadingId,
    feedByCommunityId,
    feedLoadingMoreId,
    refreshCommunityFeedPage,
  ]);

  const loadCommunityChatMessages = useCallback(async (
    community: CommunityRecord,
    mode: "initial" | "refresh" | "older" = "initial",
  ) => {
    const communityId = community.id;
    if (!isCommunityAccessible(community, profileId, profilePhone)) {
      return;
    }

    if (chatLoadingId === communityId || chatLoadingMoreId === communityId) {
      return;
    }

    const beforeTs = mode === "older"
      ? (chatNextBeforeTsByCommunityId[communityId] ?? null)
      : null;

    if (mode === "older" && !beforeTs) {
      setChatHasMoreByCommunityId((current) => ({
        ...current,
        [communityId]: false,
      }));
      return;
    }

    if (mode === "initial") {
      setChatLoadingId(communityId);
      setChatError(null);
    } else if (mode === "older") {
      setChatLoadingMoreId(communityId);
      setChatError(null);
    }

    const existingMessages = chatByCommunityId[communityId] ?? [];
    const existingKeys = new Set(existingMessages.map((message) => getCommunityChatMessageStableKey(message)));
    const scrollNode = chatScrollRef.current;
    const shouldFollowBottom = mode !== "older" && (!scrollNode || isChatNearBottom(scrollNode));
    const previousScrollHeight = scrollNode?.scrollHeight ?? 0;
    const previousScrollTop = scrollNode?.scrollTop ?? 0;

    const response = await apiFetchCommunityChatMessages(communityId, {
      phone: profile.phone,
      clientId: profile.id,
      limit: COMMUNITY_CHAT_PAGE_SIZE,
      beforeTs: beforeTs ?? undefined,
    });

    if (response.error) {
      if (mode !== "refresh") {
        setChatError(
          communityErrorMessage(response.error, "Не удалось загрузить сообщения сообщества"),
        );
      }
      setChatLoadingId((current) => (current === communityId ? null : current));
      setChatLoadingMoreId((current) => (current === communityId ? null : current));
      return;
    }

    const nextChunk = response.data?.messages ?? [];
    const hasNewMessages = nextChunk.some((message) => !existingKeys.has(getCommunityChatMessageStableKey(message)));
    setChatByCommunityId((current) => ({
      ...current,
      [communityId]: mergeCommunityChatMessages(current[communityId] ?? [], nextChunk),
    }));
    setChatLoadedByCommunityId((current) => ({
      ...current,
      [communityId]: true,
    }));

    if (mode === "older") {
      setChatNextBeforeTsByCommunityId((current) => ({
        ...current,
        [communityId]: hasNewMessages ? (response.data?.nextBeforeTs ?? current[communityId] ?? null) : null,
      }));
      setChatHasMoreByCommunityId((current) => ({
        ...current,
        [communityId]: Boolean(
          hasNewMessages
          && response.data?.hasMore
          && response.data.nextBeforeTs
          && response.data.nextBeforeTs !== beforeTs
        ),
      }));
    } else {
      setChatNextBeforeTsByCommunityId((current) => ({
        ...current,
        [communityId]: response.data?.nextBeforeTs ?? current[communityId] ?? null,
      }));
      setChatHasMoreByCommunityId((current) => ({
        ...current,
        [communityId]: response.data?.hasMore ?? (nextChunk.length >= COMMUNITY_CHAT_PAGE_SIZE),
      }));
    }

    if (mode === "older" && hasNewMessages) {
      chatScrollActionRef.current = {
        type: "preserve",
        communityId,
        previousScrollHeight,
        previousScrollTop,
      };
    } else if ((mode === "initial" || mode === "refresh") && hasNewMessages && shouldFollowBottom) {
      chatScrollActionRef.current = {
        type: "bottom",
        communityId,
        behavior: mode === "initial" ? "auto" : "smooth",
      };
    }

    setChatLoadingId((current) => (current === communityId ? null : current));
    setChatLoadingMoreId((current) => (current === communityId ? null : current));
  }, [
    chatByCommunityId,
    chatLoadingId,
    chatLoadingMoreId,
    chatNextBeforeTsByCommunityId,
    profile.id,
    profile.phone,
    profileId,
    profilePhone,
  ]);

  useEffect(() => {
    if (activeCommunityTab !== "CHAT" || !selectedCommunity) {
      return;
    }

    if (!isCommunityAccessible(selectedCommunity, profileId, profilePhone)) {
      return;
    }

    if (!chatLoadedByCommunityId[selectedCommunity.id]) {
      void loadCommunityChatMessages(selectedCommunity, "initial");
    }

    const timer = window.setInterval(() => {
      if (document.hidden) return;
      void loadCommunityChatMessages(selectedCommunity, "refresh");
    }, 7000);

    return () => {
      window.clearInterval(timer);
    };
  }, [
    activeCommunityTab,
    chatLoadedByCommunityId,
    loadCommunityChatMessages,
    profileId,
    profilePhone,
    selectedCommunity,
  ]);

  useEffect(() => {
    if (activeCommunityTab === "CHAT" || !selectedCommunity) {
      return;
    }

    if (!isCommunityAccessible(selectedCommunity, profileId, profilePhone)) {
      return;
    }

    if (chatLoadedByCommunityId[selectedCommunity.id]) {
      return;
    }

    void loadCommunityChatMessages(selectedCommunity, "initial");
  }, [
    activeCommunityTab,
    chatLoadedByCommunityId,
    loadCommunityChatMessages,
    profileId,
    profilePhone,
    selectedCommunity,
  ]);

  const maxMembers = communities.reduce(
    (count, community) => Math.max(count, getCommunityGraphWeight(community)),
    1,
  );

  const graphLayout = useMemo(() => {
    const total = Math.max(communities.length, 1);
    const baseCommunities = pickBaseCommunities(communities);
    const baseIds = baseCommunities.map((community) => community.id);
    const baseIdSet = new Set(baseIds);
    const defaultConnectionIds = new Set<string>();
    const sizeFor = (community: CommunityRecord) => clamp(
      58,
      58 + (getCommunityGraphWeight(community) / maxMembers) * 26 - Math.max(0, total - 4) * 2,
      92,
    );
    const baseSizeFor = (community: CommunityRecord) => clamp(
      88,
      sizeFor(community) * COMMUNITY_GRAPH_BASE_NODE_SCALE,
      138,
    );
    const skeletonCenterX = total > 6 ? 56 : 54;
    const skeletonCenterY = total > 6 ? 45 : 47;
    const baseCount = Math.max(baseCommunities.length, 1);

    const baseNodes: CommunityGraphNodeLayout[] = baseCommunities.map((community, index) => {
      const angle = baseCount === 1
        ? -Math.PI / 2
        : (-Math.PI / 2) + ((Math.PI * 2) / baseCount) * index;
      const radiusX = (
        baseCount <= 1 ? 0 : baseCount === 2 ? 18 : baseCount === 3 ? 21 : 25
      ) * COMMUNITY_GRAPH_BASE_SPACING_MULTIPLIER;
      const radiusY = (
        baseCount <= 1 ? 0 : baseCount === 2 ? 13 : baseCount === 3 ? 16 : 18
      ) * COMMUNITY_GRAPH_BASE_SPACING_MULTIPLIER;

      return {
        community,
        x: clamp(10, skeletonCenterX + Math.cos(angle) * radiusX, 90),
        y: clamp(16, skeletonCenterY + Math.sin(angle) * radiusY, 78),
        size: baseSizeFor(community),
        isBase: true,
        anchorId: null,
      };
    });

    const pushAwayFromBaseNodes = (
      initialX: number,
      initialY: number,
      nodeSize: number,
      anchorId: string | null,
    ) => {
      let nextX = initialX;
      let nextY = initialY;

      for (let iteration = 0; iteration < 2; iteration += 1) {
        baseNodes.forEach((baseNode) => {
          const extraGap = baseNode.community.id === anchorId ? 16 : 22;
          const minDistance = ((baseNode.size + nodeSize) / 2 + extraGap)
            * COMMUNITY_GRAPH_BASE_CLEARANCE_TO_PERCENT;
          const dx = nextX - baseNode.x;
          const dy = nextY - baseNode.y;
          const distance = Math.hypot(dx, dy) || 0.001;

          if (distance < minDistance) {
            const push = minDistance - distance;
            nextX += (dx / distance) * push;
            nextY += (dy / distance) * push * 0.92;
          }
        });
      }

      return {
        x: clamp(8, nextX, 92),
        y: clamp(14, nextY, 84),
      };
    };

    const baseNodeById = new Map(baseNodes.map((node) => [node.community.id, node]));
    const baseCommunityOrderById = new Map(baseIds.map((id, index) => [id, index]));
    const maxBaseOverlap = effectiveConnections.reduce((max, connection) => {
      if (baseIdSet.has(connection.left) || baseIdSet.has(connection.right)) {
        return Math.max(max, connection.overlap);
      }
      return max;
    }, 1);

    const connectionsByCommunityId = new Map<string, Array<{
      connection: CommunityConnection;
      otherId: string;
      connectionId: string;
      isOtherBase: boolean;
    }>>();
    communities.forEach((community) => {
      connectionsByCommunityId.set(community.id, []);
    });

    effectiveConnections.forEach((connection) => {
      const connectionId = getCommunityGraphConnectionId(connection.left, connection.right);
      const leftList = connectionsByCommunityId.get(connection.left);
      const rightList = connectionsByCommunityId.get(connection.right);
      leftList?.push({
        connection,
        otherId: connection.right,
        connectionId,
        isOtherBase: baseIdSet.has(connection.right),
      });
      rightList?.push({
        connection,
        otherId: connection.left,
        connectionId,
        isOtherBase: baseIdSet.has(connection.left),
      });
    });

    connectionsByCommunityId.forEach((items) => {
      items.sort((left, right) => {
        if (right.connection.overlap !== left.connection.overlap) {
          return right.connection.overlap - left.connection.overlap;
        }
        return left.otherId.localeCompare(right.otherId, "ru");
      });
    });

    const secondaryCommunities = communities.filter((community) => !baseIdSet.has(community.id));
    const secondaryDescriptors = secondaryCommunities
      .map((community) => {
        const linked = connectionsByCommunityId.get(community.id) ?? [];
        const strongestBaseConnection = linked.find((item) => item.isOtherBase) ?? null;
        const strongestConnection = linked[0] ?? null;
        return {
          community,
          strongestBaseConnection,
          strongestConnection,
        };
      })
      .sort((left, right) => {
        const baseDiff = (right.strongestBaseConnection?.connection.overlap ?? -1)
          - (left.strongestBaseConnection?.connection.overlap ?? -1);
        if (baseDiff !== 0) return baseDiff;
        const overallDiff = (right.strongestConnection?.connection.overlap ?? -1)
          - (left.strongestConnection?.connection.overlap ?? -1);
        if (overallDiff !== 0) return overallDiff;
        const weightDiff = getCommunityGraphWeight(right.community) - getCommunityGraphWeight(left.community);
        if (weightDiff !== 0) return weightDiff;
        return left.community.name.localeCompare(right.community.name, "ru");
      });

    const secondaryMetaById = new Map<string, {
      anchorId: string | null;
      defaultConnectionId: string | null;
      anchorOverlap: number;
    }>();

    secondaryDescriptors.forEach((descriptor, index) => {
      let anchorId = descriptor.strongestBaseConnection?.otherId ?? null;
      if (!anchorId && descriptor.strongestConnection) {
        const peerId = descriptor.strongestConnection.otherId;
        anchorId = baseIdSet.has(peerId)
          ? peerId
          : secondaryMetaById.get(peerId)?.anchorId ?? null;
      }
      if (!anchorId) {
        anchorId = baseIds[index % Math.max(baseIds.length, 1)] ?? null;
      }

      secondaryMetaById.set(descriptor.community.id, {
        anchorId,
        defaultConnectionId: descriptor.strongestBaseConnection?.connectionId
          ?? descriptor.strongestConnection?.connectionId
          ?? null,
        anchorOverlap: descriptor.strongestBaseConnection?.connection.overlap ?? 0,
      });
    });

    const secondaryByAnchorId = new Map<string, typeof secondaryDescriptors>();
    secondaryDescriptors.forEach((descriptor) => {
      const anchorId = secondaryMetaById.get(descriptor.community.id)?.anchorId;
      if (!anchorId) return;
      const current = secondaryByAnchorId.get(anchorId) ?? [];
      current.push(descriptor);
      secondaryByAnchorId.set(anchorId, current);
      const defaultConnectionId = secondaryMetaById.get(descriptor.community.id)?.defaultConnectionId;
      if (defaultConnectionId) {
        defaultConnectionIds.add(defaultConnectionId);
      }
    });

    const secondaryNodes: CommunityGraphNodeLayout[] = [];

    secondaryByAnchorId.forEach((items, anchorId) => {
      const anchorNode = baseNodeById.get(anchorId);
      if (!anchorNode) return;

      const baseIndex = baseCommunityOrderById.get(anchorId) ?? 0;
      const outwardAngle = baseCount <= 1
        ? -Math.PI / 2
        : Math.atan2(anchorNode.y - skeletonCenterY, anchorNode.x - skeletonCenterX);
      const slotCount = baseCount <= 1 ? Math.max(items.length, 1) : Math.min(items.length, 5);
      const arcSpread = slotCount <= 1 ? 0 : clamp(0.9, 0.58 * (slotCount - 1), 2.4);

      items.forEach((descriptor, index) => {
        const meta = secondaryMetaById.get(descriptor.community.id);
        const overlapStrength = meta?.anchorOverlap ?? 0;
        const normalizedStrength = maxBaseOverlap > 0 ? overlapStrength / maxBaseOverlap : 0;
        const secondarySize = sizeFor(descriptor.community);
        const ringIndex = baseCount <= 1 ? Math.floor(index / 6) : Math.floor(index / slotCount);
        const slotIndex = baseCount <= 1 ? index % Math.max(items.length, 1) : index % slotCount;
        const angle = baseCount <= 1
          ? (-Math.PI / 2) + ((Math.PI * 2) / Math.max(items.length, 1)) * slotIndex
          : outwardAngle
              + (slotCount === 1 ? 0 : (-arcSpread / 2) + (arcSpread * slotIndex) / (slotCount - 1))
              + (ringIndex === 0 ? 0 : (ringIndex % 2 === 0 ? 0.12 : -0.12) * ringIndex);
        const minimumOrbitRadius = ((anchorNode.size + secondarySize) / 2 + 18)
          * COMMUNITY_GRAPH_BASE_CLEARANCE_TO_PERCENT;
        const orbitRadius = Math.max(
          minimumOrbitRadius,
          baseCount <= 1
            ? 22 + ringIndex * 10 + (1 - normalizedStrength) * 7
            : 18 + (1 - normalizedStrength) * 16 + ringIndex * 10,
        );
        const rawX = anchorNode.x + Math.cos(angle) * orbitRadius;
        const rawY = anchorNode.y + Math.sin(angle) * orbitRadius * 0.86;
        const adjusted = pushAwayFromBaseNodes(rawX, rawY, secondarySize, meta?.anchorId ?? null);

        secondaryNodes.push({
          community: descriptor.community,
          x: adjusted.x,
          y: adjusted.y,
          size: secondarySize,
          isBase: false,
          anchorId: meta?.anchorId ?? (baseIds[baseIndex] ?? null),
        });
      });
    });

    const positionedNodeIds = new Set([
      ...baseNodes.map((node) => node.community.id),
      ...secondaryNodes.map((node) => node.community.id),
    ]);
    const orphanNodes: CommunityGraphNodeLayout[] = communities
      .filter((community) => !positionedNodeIds.has(community.id))
      .map((community, index) => {
        const angle = (-Math.PI / 2) + ((Math.PI * 2) / Math.max(communities.length, 1)) * index;
        return {
          community,
          x: clamp(14, 50 + Math.cos(angle) * 33, 86),
          y: clamp(20, 50 + Math.sin(angle) * 26, 80),
          size: sizeFor(community),
          isBase: false,
          anchorId: null,
        };
      });

    return {
      nodes: [...baseNodes, ...secondaryNodes, ...orphanNodes],
      baseIdSet,
      defaultConnectionIds,
    };
  }, [communities, effectiveConnections, maxMembers]);

  const graphNodes = graphLayout.nodes;

  const nodePositionById = useMemo(
    () => new Map(graphNodes.map((node) => [node.community.id, node])),
    [graphNodes],
  );

  const graphEdges = useMemo<CommunityGraphEdgeLayout[]>(() => {
    const visibleConnectionIds = new Set(graphLayout.defaultConnectionIds);

    effectiveConnections.forEach((connection) => {
      if (graphLayout.baseIdSet.has(connection.left) && graphLayout.baseIdSet.has(connection.right)) {
        visibleConnectionIds.add(getCommunityGraphConnectionId(connection.left, connection.right));
      }
      if (
        expandedGraphCommunityId
        && (connection.left === expandedGraphCommunityId || connection.right === expandedGraphCommunityId)
      ) {
        visibleConnectionIds.add(getCommunityGraphConnectionId(connection.left, connection.right));
      }
    });

    return effectiveConnections
      .map((connection) => {
        const connectionId = getCommunityGraphConnectionId(connection.left, connection.right);
        if (!visibleConnectionIds.has(connectionId)) return null;

        const leftNode = nodePositionById.get(connection.left);
        const rightNode = nodePositionById.get(connection.right);
        if (!leftNode || !rightNode) return null;

        const isExpanded = Boolean(
          expandedGraphCommunityId
          && (connection.left === expandedGraphCommunityId || connection.right === expandedGraphCommunityId),
        );

        return {
          id: connectionId,
          x1: leftNode.x,
          y1: leftNode.y,
          x2: rightNode.x,
          y2: rightNode.y,
          stroke: isExpanded ? "rgba(106, 79, 214, 0.52)" : "rgba(69, 62, 88, 0.32)",
          strokeWidth: (isExpanded ? 1.9 : 1.15) + connection.overlap * (isExpanded ? 0.98 : 0.78),
          opacity: isExpanded
            ? clamp(0.34, 0.26 + connection.overlap * 0.14, 0.76)
            : clamp(0.18, 0.12 + connection.overlap * 0.09, 0.5),
        };
      })
      .filter((item): item is CommunityGraphEdgeLayout => item !== null);
  }, [effectiveConnections, expandedGraphCommunityId, graphLayout, nodePositionById]);

  const graphView = useMemo(() => {
    const width = graphViewport.width;
    const height = graphViewport.height;
    if (!width || !height) {
      const scale = clamp(
        COMMUNITY_GRAPH_MIN_ZOOM,
        graphZoomOverride ?? COMMUNITY_GRAPH_DEFAULT_ZOOM,
        COMMUNITY_GRAPH_MAX_ZOOM,
      );
      return {
        scale,
        offsetX: 0,
        offsetY: 0,
      };
    }

    const labelHeight = width <= 420 ? 34 : 38;
    const lockHeight = 24;
    const glowSpread = 12;
    const bounds = graphNodes.map(({ community, x, y, size }) => {
      const centerX = (x / 100) * width;
      const centerY = (y / 100) * height;
      const radius = size / 2 + glowSpread;
      return {
        minX: centerX - radius,
        maxX: centerX + radius,
        minY: centerY - radius - (community.visibility === "CLOSED" ? lockHeight : 0),
        maxY: centerY + radius + 9 + labelHeight,
      };
    });

    const createCenterX = COMMUNITY_GRAPH_CREATE_NODE.left + COMMUNITY_GRAPH_CREATE_NODE.size / 2;
    const createCenterY = COMMUNITY_GRAPH_CREATE_NODE.top + COMMUNITY_GRAPH_CREATE_NODE.size / 2;
    bounds.push({
      minX: createCenterX - COMMUNITY_GRAPH_CREATE_NODE.size / 2,
      maxX: createCenterX + COMMUNITY_GRAPH_CREATE_NODE.size / 2,
      minY: createCenterY - COMMUNITY_GRAPH_CREATE_NODE.size / 2,
      maxY: createCenterY + COMMUNITY_GRAPH_CREATE_NODE.size / 2,
    });

    const minX = Math.min(...bounds.map((item) => item.minX));
    const maxX = Math.max(...bounds.map((item) => item.maxX));
    const minY = Math.min(...bounds.map((item) => item.minY));
    const maxY = Math.max(...bounds.map((item) => item.maxY));

    const availableWidth = Math.max(
      120,
      width - COMMUNITY_GRAPH_SAFE_PADDING.left - COMMUNITY_GRAPH_SAFE_PADDING.right,
    );
    const availableHeight = Math.max(
      120,
      height - COMMUNITY_GRAPH_SAFE_PADDING.top - COMMUNITY_GRAPH_SAFE_PADDING.bottom,
    );
    const contentWidth = Math.max(1, maxX - minX);
    const contentHeight = Math.max(1, maxY - minY);

    const autoScale = clamp(
      COMMUNITY_GRAPH_MIN_ZOOM,
      Math.min(
        COMMUNITY_GRAPH_DEFAULT_ZOOM,
        Math.min(availableWidth / contentWidth, availableHeight / contentHeight) * 0.96,
      ),
      COMMUNITY_GRAPH_DEFAULT_ZOOM,
    );
    const scale = clamp(
      COMMUNITY_GRAPH_MIN_ZOOM,
      graphZoomOverride ?? autoScale,
      COMMUNITY_GRAPH_MAX_ZOOM,
    );
    const targetCenterX = COMMUNITY_GRAPH_SAFE_PADDING.left + availableWidth / 2;
    const targetCenterY = COMMUNITY_GRAPH_SAFE_PADDING.top + availableHeight / 2;
    const contentCenterX = (minX + maxX) / 2;
    const contentCenterY = (minY + maxY) / 2;

    return {
      scale,
      offsetX: targetCenterX / scale - contentCenterX,
      offsetY: targetCenterY / scale - contentCenterY,
    };
  }, [graphNodes, graphViewport.height, graphViewport.width, graphZoomOverride]);

  const currentFeed = selectedCommunity ? (feedByCommunityId[selectedCommunity.id] ?? []) : [];
  const currentFeedHasMore = selectedCommunity
    ? (feedHasMoreByCommunityId[selectedCommunity.id] ?? currentFeed.length >= COMMUNITY_FEED_PAGE_SIZE)
    : false;
  const currentFeedGameIds = useMemo(() => (
    Array.from(
      new Set(
        currentFeed
          .filter((post) => post.kind === "GAME")
          .map((post) => post.relatedGameId?.trim() || "")
          .filter(Boolean),
      ),
    )
  ), [currentFeed]);
  const currentRankingGameIds = selectedCommunity
    ? (rankingGameIdsByCommunityId[selectedCommunity.id] ?? currentFeedGameIds)
    : [];
  const upcomingCreatedGames = useMemo(
    () => createdGames.filter((game) => isUpcomingGameRecord(game) && game.settings?.isPrivate !== true),
    [createdGames],
  );

  useEffect(() => {
    if (feedFormState.kind !== "GAME" || !feedFormState.relatedGameId) {
      return;
    }

    const hasSelectedUpcomingGame = upcomingCreatedGames.some((game) => game.id === feedFormState.relatedGameId);
    if (hasSelectedUpcomingGame) {
      return;
    }

    setFeedFormState((current) => (
      current.kind === "GAME" && current.relatedGameId
        ? { ...current, relatedGameId: "" }
        : current
    ));
  }, [feedFormState.kind, feedFormState.relatedGameId, upcomingCreatedGames]);

  useEffect(() => {
    if (feedFormState.kind !== "TOURNAMENT" || !feedFormState.relatedTournamentId) {
      return;
    }

    const hasSelectedTournament = feedTournamentOptions.some(
      (option) => option.tournament.id === feedFormState.relatedTournamentId,
    );
    if (hasSelectedTournament || feedTournamentOptionsLoading) {
      return;
    }

    setFeedFormState((current) => (
      current.kind === "TOURNAMENT" && current.relatedTournamentId
        ? { ...current, relatedTournamentId: "" }
        : current
    ));
  }, [
    feedFormState.kind,
    feedFormState.relatedTournamentId,
    feedTournamentOptions,
    feedTournamentOptionsLoading,
  ]);

  useEffect(() => {
    if (!isFeedComposerOpen || feedFormState.kind !== "TOURNAMENT") {
      return;
    }

    let cancelled = false;

    const currentUserId = (selectedCommunityMember?.id ?? currentMember.id ?? "").trim() || null;
    const currentUserPhone = normalizePhone(
      selectedCommunityMember?.phone ?? currentMember.phone ?? profile.phone,
    );

    const loadFeedTournamentOptions = async () => {
      setFeedTournamentOptionsLoading(true);
      setFeedTournamentOptionsError(null);

      const today = new Date();
      const todayKey = formatCommunityApiDate(today);
      const dateKeys = Array.from(
        { length: COMMUNITY_TOURNAMENT_LOOKAHEAD_DAYS + 1 },
        (_, index) => formatCommunityApiDate(addDays(today, index)),
      );

      const exerciseResponses = await Promise.allSettled(
        dateKeys.map((date) => (
          date === todayKey
            ? apiFetchExercisesByVisibleDate(date, {
              includePast: true,
              includeAdjacentDays: true,
            })
            : apiFetchExercisesByDate(date, { includePast: date <= todayKey })
        )),
      );

      if (cancelled) return;

      const candidateById = new Map<string, Exercise>();
      exerciseResponses.forEach((result) => {
        if (result.status !== "fulfilled") return;
        (result.value.data ?? [])
          .filter((exercise) => isAvailableTournamentExercise(exercise))
          .forEach((exercise) => {
            candidateById.set(exercise.id, exercise);
          });
      });

      const candidates = Array.from(candidateById.values());
      if (candidates.length === 0) {
        setFeedTournamentOptions([]);
        setFeedTournamentOptionsLoading(false);
        if (!exerciseResponses.some((result) => result.status === "fulfilled")) {
          setFeedTournamentOptionsError("Не удалось загрузить список турниров.");
        }
        return;
      }

      const bookingResponses = await Promise.all(
        candidates.map(async (tournament) => {
          try {
            return {
              tournament,
              response: await apiFetchTournamentParticipants(String(tournament.id)),
              failed: false,
            };
          } catch {
            return {
              tournament,
              response: null,
              failed: true,
            };
          }
        }),
      );

      if (cancelled) return;

      const options = bookingResponses.reduce<FeedTournamentOption[]>((accumulator, result) => {
        const participants = extractTournamentBookings(result.response?.data).filter((item) => !item.isCancelled);
        const trainerMatch = isTournamentTrainer(result.tournament, currentUserId);
        const participantMatch = participants.some((participant) => (
          isSameTournamentBookingParticipant(participant, currentUserId, currentUserPhone)
        ));

        if (!trainerMatch && !participantMatch) {
          return accumulator;
        }

        accumulator.push({
          tournament: result.tournament,
          participants,
          relation: trainerMatch ? "trainer" : "participant",
        });
        return accumulator;
      }, []);

      options.sort((left, right) => {
        const leftTs = getExerciseTimestamp(left.tournament.timeFrom);
        const rightTs = getExerciseTimestamp(right.tournament.timeFrom);

        if (!Number.isFinite(leftTs) && !Number.isFinite(rightTs)) return 0;
        if (!Number.isFinite(leftTs)) return 1;
        if (!Number.isFinite(rightTs)) return -1;
        return leftTs - rightTs;
      });

      setFeedTournamentOptions(options);
      setFeedTournamentOptionsLoading(false);
      setFeedTournamentOptionsError(
        options.length === 0 && bookingResponses.every((result) => result.failed)
          ? "Не удалось проверить доступные турниры."
          : null,
      );
    };

    void loadFeedTournamentOptions();

    return () => {
      cancelled = true;
    };
  }, [
    currentMember.id,
    currentMember.phone,
    feedFormState.kind,
    isFeedComposerOpen,
    profile.phone,
    selectedCommunityMember?.id,
    selectedCommunityMember?.phone,
  ]);

  useEffect(() => {
    if (currentFeedGameIds.length === 0) {
      return;
    }

    let cancelled = false;

    const refreshFeedGameRecords = async () => {
      const results = await Promise.all(
        currentFeedGameIds.map(async (gameId) => ({
          gameId,
          response: await apiFetchPadelGameRecord(gameId),
        })),
      );

      if (cancelled) return;

      setFeedGameRecordById((current) => {
        const next = { ...current };

        results.forEach(({ gameId, response }) => {
          if (!response.data) return;
          next[gameId] = mergeGameRecord(current[gameId], response.data);
        });

        return next;
      });
    };

    void refreshFeedGameRecords();

    return () => {
      cancelled = true;
    };
  }, [currentFeedGameIds, selectedCommunity?.id]);

  const feedGameRecords = useMemo(() => {
    const gameById = new Map<string, PadelGameRecord>();

    createdGames.forEach((game) => {
      const gameId = game.id?.trim() || "";
      if (!gameId) return;
      gameById.set(gameId, game);
    });

    currentFeedGameIds.forEach((gameId) => {
      const cachedGame = feedGameRecordById[gameId];
      if (!cachedGame) return;
      gameById.set(gameId, mergeGameRecord(gameById.get(gameId), cachedGame));
    });

    return Array.from(gameById.values());
  }, [createdGames, currentFeedGameIds, feedGameRecordById]);
  const rankingGameRecords = useMemo(() => {
    const gameById = new Map<string, PadelGameRecord>();

    createdGames.forEach((game) => {
      const gameId = game.id?.trim() || "";
      if (!gameId || !currentRankingGameIds.includes(gameId)) return;
      gameById.set(gameId, game);
    });

    currentRankingGameIds.forEach((gameId) => {
      const cachedGame = feedGameRecordById[gameId];
      if (!cachedGame) return;
      gameById.set(gameId, mergeGameRecord(gameById.get(gameId), cachedGame));
    });

    return Array.from(gameById.values());
  }, [createdGames, currentRankingGameIds, feedGameRecordById]);

  const currentFeedEntries = selectedCommunity
    ? buildFeedEntries({
      community: selectedCommunity,
      posts: currentFeed,
      games: feedGameRecords,
      currentUser: {
        id: currentMember.id,
        phone: currentMember.phone,
      },
    })
    : [];
  const currentChatMessages = selectedCommunity ? (chatByCommunityId[selectedCommunity.id] ?? []) : [];
  const currentChatHasMore = selectedCommunity
    ? (chatHasMoreByCommunityId[selectedCommunity.id] ?? false)
    : false;
  const isCurrentFeedLoadingMore = selectedCommunity ? feedLoadingMoreId === selectedCommunity.id : false;
  const isCurrentChatLoading = selectedCommunity ? chatLoadingId === selectedCommunity.id : false;
  const isCurrentChatLoadingMore = selectedCommunity ? chatLoadingMoreId === selectedCommunity.id : false;
  const isCurrentChatSending = selectedCommunity ? chatSendingId === selectedCommunity.id : false;

  const mapCommunityCommentToNewsComment = useCallback((comment: CommunityPostComment): NewsComment => {
    const currentUserId = (selectedCommunityMember?.id ?? currentMember.id ?? "").trim() || null;
    const currentUserPhone = normalizePhone(selectedCommunityMember?.phone ?? currentMember.phone ?? profile.phone);
    const authorId = (comment.authorId || "").trim() || null;
    const authorPhone = normalizePhone(comment.authorPhone);

    return {
      id: comment.id,
      authorName: comment.authorName,
      text: comment.text,
      createdAt: comment.createdAt,
      isOwn: Boolean(
        (authorId && currentUserId && authorId === currentUserId)
        || (authorPhone && currentUserPhone && authorPhone === currentUserPhone),
      ),
    };
  }, [currentMember.id, currentMember.phone, profile.phone, selectedCommunityMember?.id, selectedCommunityMember?.phone]);

  const mapCommunityThreadToNewsThread = useCallback((thread: CommunityPostThread): NewsThreadData => ({
    likes: thread.likesCount,
    dislikes: thread.dislikesCount,
    commentsCount: thread.commentsCount,
    reaction: mapCommunityReactionToNewsReaction(thread.viewerReaction),
    comments: thread.comments.map(mapCommunityCommentToNewsComment),
  }), [mapCommunityCommentToNewsComment]);

  const syncSelectedCommunityPostThread = useCallback((postId: string, thread: CommunityPostThread) => {
    if (!selectedCommunity) return;

    setFeedByCommunityId((current) => ({
      ...current,
      [selectedCommunity.id]: updateCommunityPostById(
        current[selectedCommunity.id] ?? [],
        postId,
        (post) => applyCommunityThreadToPost(post, thread),
      ),
    }));
  }, [selectedCommunity]);

  const handleLoadNewsThread = useCallback(async (news: News) => {
    if (!selectedCommunity) {
      throw new Error("Сообщество не выбрано.");
    }

    const response = await apiFetchCommunityPostThread(selectedCommunity.id, news.id, {
      phone: profile.phone,
      clientId: profile.id,
    });

    if (response.error || !response.data) {
      throw new Error(
        communityErrorMessage(response.error, "Не удалось загрузить обсуждение новости."),
      );
    }

    syncSelectedCommunityPostThread(news.id, response.data);
    return mapCommunityThreadToNewsThread(response.data);
  }, [mapCommunityThreadToNewsThread, profile.id, profile.phone, selectedCommunity, syncSelectedCommunityPostThread]);

  const handlePersistNewsReaction = useCallback(async (news: News, reaction: NewsReaction) => {
    if (!selectedCommunity) {
      throw new Error("Сообщество не выбрано.");
    }

    const response = await apiSetCommunityPostReaction(selectedCommunity.id, news.id, {
      member: currentMember,
      reaction: mapNewsReactionToCommunityReaction(reaction),
    });

    if (response.error) {
      throw new Error(
        communityErrorMessage(response.error, "Не удалось сохранить реакцию новости."),
      );
    }

    setFeedByCommunityId((current) => ({
      ...current,
      [selectedCommunity.id]: updateCommunityPostById(
        current[selectedCommunity.id] ?? [],
        news.id,
        (post) => {
          const nextPost = applyCommunityReactionToPost(post, reaction);
          if (typeof response.data?.likesCount === "number") {
            nextPost.likesCount = response.data.likesCount;
          }
          if (typeof response.data?.dislikesCount === "number") {
            nextPost.dislikesCount = response.data.dislikesCount;
          }
          nextPost.viewerReaction = mapNewsReactionToCommunityReaction(reaction);
          return nextPost;
        },
      ),
    }));
  }, [currentMember, selectedCommunity]);

  const handlePersistNewsComment = useCallback(async (news: News, text: string) => {
    if (!selectedCommunity) {
      throw new Error("Сообщество не выбрано.");
    }

    const response = await apiCreateCommunityPostComment(selectedCommunity.id, news.id, {
      member: currentMember,
      text,
    });

    if (response.error || !response.data) {
      throw new Error(
        communityErrorMessage(response.error, "Не удалось отправить комментарий."),
      );
    }

    setFeedByCommunityId((current) => ({
      ...current,
      [selectedCommunity.id]: updateCommunityPostById(
        current[selectedCommunity.id] ?? [],
        news.id,
        incrementCommunityPostComments,
      ),
    }));

    return mapCommunityCommentToNewsComment(response.data);
  }, [currentMember, mapCommunityCommentToNewsComment, selectedCommunity]);

  useEffect(() => {
    if (!selectedCommunity) return;
    const pendingAction = chatScrollActionRef.current;
    if (!pendingAction || pendingAction.communityId !== selectedCommunity.id) return;

    const scrollNode = chatScrollRef.current;
    if (!scrollNode) return;

    if (pendingAction.type === "preserve") {
      const delta = scrollNode.scrollHeight - pendingAction.previousScrollHeight;
      scrollNode.scrollTop = pendingAction.previousScrollTop + Math.max(0, delta);
    } else {
      scrollNode.scrollTo({
        top: scrollNode.scrollHeight,
        behavior: pendingAction.behavior,
      });
    }

    chatScrollActionRef.current = null;
  }, [currentChatMessages.length, selectedCommunity]);

  const communityStoryMetricsById = useMemo(() => {
    return joinedCommunities.reduce<Record<string, CommunityStoryMetrics>>((result, community) => {
      result[community.id] = getCommunityStoryMetrics(
        community,
        feedByCommunityId[community.id] ?? [],
      );
      return result;
    }, {});
  }, [joinedCommunities, feedByCommunityId]);
  const communityUnreadStateById = useMemo(() => {
    return joinedCommunities.reduce<Record<string, boolean>>((result, community) => {
      const metrics = communityStoryMetricsById[community.id];
      const latestActivityTs = metrics?.latestActivityTs ?? null;
      const lastSeenTs = communityLastSeenById[community.id] ?? 0;
      result[community.id] = Boolean(latestActivityTs && latestActivityTs > lastSeenTs);
      return result;
    }, {});
  }, [joinedCommunities, communityLastSeenById, communityStoryMetricsById]);
  const communityChatUnreadCountById = useMemo(() => {
    return communities.reduce<Record<string, number>>((result, community) => {
      const messages = chatByCommunityId[community.id] ?? [];
      const lastReadTs = communityChatLastReadById[community.id] ?? 0;

      result[community.id] = messages.reduce((count, message) => {
        const messageTs = getCommunityChatMessageTimestamp(message);
        if (!messageTs || messageTs <= lastReadTs) {
          return count;
        }

        const authorId = (message.authorId || "").trim();
        const authorPhone = normalizePhone(message.authorPhone);
        const isMine =
          (authorId && authorId === profileId)
          || Boolean(authorPhone && authorPhone === profilePhone);

        return isMine ? count : count + 1;
      }, 0);

      return result;
    }, {});
  }, [chatByCommunityId, communities, communityChatLastReadById, profileId, profilePhone]);
  const currentChatUnreadCount = selectedCommunity
    ? (communityChatUnreadCountById[selectedCommunity.id] ?? 0)
    : 0;
  const currentChatUnreadBadgeCount = Math.min(9, currentChatUnreadCount);
  const currentRankingData = useMemo(() => {
    if (!selectedCommunity) {
      return { rows: [], confirmedGamesCount: 0 } satisfies CommunityRankingData;
    }

    return buildCommunityRankingData(selectedCommunity, rankingGameRecords, activeRankingPeriod, Date.now());
  }, [activeRankingPeriod, rankingGameRecords, selectedCommunity]);
  const currentRankingRows = currentRankingData.rows;
  const currentRankingGamesCount = currentRankingData.confirmedGamesCount;
  const currentPerformanceRow = currentRankingRows.find((member) =>
    member.id === profileId || (member.phone && normalizePhone(member.phone) === profilePhone),
  ) ?? null;
  const isCurrentRankingLoading = selectedCommunity
    ? rankingRefreshLoadingId === selectedCommunity.id
    : false;
  const manageableCommunities = useMemo(() => (
    communities.filter((community) => {
      const member = findCommunityMember(community, profileId, profilePhone);
      return member?.role === "OWNER" || member?.role === "ADMIN";
    })
  ), [communities, profileId, profilePhone]);
  const canChatInSelectedCommunity = selectedCommunity
    ? isCommunityMember(selectedCommunity, profileId, profilePhone)
    : false;

  const handleSelectCommunitySectionNav = useCallback((itemId: CommunitySecondaryNavItemId) => {
    if (itemId === "feed") {
      setActiveCommunityTab("FEED");
      return;
    }
    if (itemId === "chat") {
      setActiveCommunityTab("CHAT");
      return;
    }
    setActiveCommunityTab("RANKING");
  }, []);

  const handleSelectCommunityBottomNav = useCallback((itemId: CommunityBottomNavItemId) => {
    if (itemId === "feed") {
      setSelectedCommunityId(null);
      setActiveCommunityTab("FEED");
      onOpenHome?.();
      return;
    }
    if (itemId === "table") {
      setActiveCommunityTab("TABLE");
      return;
    }
    if (itemId === "chat") {
      setActiveCommunityTab("CHAT");
      return;
    }
    setSelectedCommunityId(null);
    setActiveCommunityTab("FEED");
    onOpenProfile?.();
  }, [onOpenHome, onOpenProfile]);

  const handleLoadMoreChat = useCallback(async () => {
    if (!selectedCommunity) return;
    if (!currentChatHasMore) return;
    if (chatLoadingId === selectedCommunity.id || chatLoadingMoreId === selectedCommunity.id) return;
    await loadCommunityChatMessages(selectedCommunity, "older");
  }, [
    chatLoadingId,
    chatLoadingMoreId,
    currentChatHasMore,
    loadCommunityChatMessages,
    selectedCommunity,
  ]);

  const handleCommunityChatScroll = useCallback((event: ReactUIEvent<HTMLDivElement>) => {
    if (event.currentTarget.scrollTop > 48) return;
    void handleLoadMoreChat();
  }, [handleLoadMoreChat]);

  const handleLoadMoreFeed = useCallback(async () => {
    if (!selectedCommunity) return;
    if (!isCommunityAccessible(selectedCommunity, profileId, profilePhone)) return;
    if (detailLoadingId === selectedCommunity.id || feedLoadingMoreId === selectedCommunity.id) return;
    if (!currentFeedHasMore) return;

    const previousCount = currentFeed.length;
    const currentNextBeforeTs = feedNextBeforeTsByCommunityId[selectedCommunity.id] ?? null;
    if (!currentNextBeforeTs) {
      setFeedHasMoreByCommunityId((current) => ({
        ...current,
        [selectedCommunity.id]: false,
      }));
      return;
    }

    setFeedLoadingMoreId(selectedCommunity.id);

    const response = await apiFetchCommunityFeed(selectedCommunity.id, {
      phone: profile.phone,
      clientId: profile.id,
      limit: COMMUNITY_FEED_PAGE_SIZE,
      beforeTs: currentNextBeforeTs,
    });

    if (response.error) {
      setDetailError(
        communityErrorMessage(response.error, "Не удалось подгрузить дополнительные события сообщества"),
      );
      setFeedLoadingMoreId(null);
      return;
    }

    const nextChunk = response.data?.posts ?? [];
    const nextPosts = mergeCommunityPosts([...currentFeed, ...nextChunk]);
    const appendedCount = nextPosts.length - previousCount;
    setFeedByCommunityId((current) => ({
      ...current,
      [selectedCommunity.id]: nextPosts,
    }));
    setFeedNextBeforeTsByCommunityId((current) => ({
      ...current,
      [selectedCommunity.id]: appendedCount > 0 ? (response.data?.nextBeforeTs ?? currentNextBeforeTs) : null,
    }));
    setFeedHasMoreByCommunityId((current) => ({
      ...current,
      [selectedCommunity.id]: Boolean(
        appendedCount > 0
        && response.data?.hasMore
        && response.data.nextBeforeTs
        && response.data.nextBeforeTs !== currentNextBeforeTs
      ),
    }));
    setFeedLoadingMoreId(null);
  }, [
    currentFeed,
    currentFeedHasMore,
    detailLoadingId,
    feedLoadingMoreId,
    feedNextBeforeTsByCommunityId,
    profile.id,
    profile.phone,
    profileId,
    profilePhone,
    selectedCommunity,
  ]);
  const settingsMembers = selectedCommunity
    ? [...selectedCommunity.members].sort((left, right) => {
      const roleDiff = getCommunityRolePriority(left.role) - getCommunityRolePriority(right.role);
      if (roleDiff !== 0) return roleDiff;
      if (right.levelScore !== left.levelScore) return right.levelScore - left.levelScore;
      return left.name.localeCompare(right.name, "ru");
    })
    : [];
  const communityDetailTabs = [
    { id: "FEED" as const, label: "Лента" },
    { id: "CHAT" as const, label: "Чат" },
    { id: "RANKING" as const, label: "Рейтинг" },
    ...(canManageSelectedCommunity ? [{ id: "SETTINGS" as const, label: "Настройки" }] : []),
  ];

  const applyActionResponse = (action: CommunityActionResponse | null) => {
    if (!action) return;

    const nextCommunity = action.community;
    if (nextCommunity) {
      setCommunities((current) => upsertCommunity(current, nextCommunity, communityOrderIdsRef.current));
    }

    const nextFeedPost = action.feedPost;
    if (nextFeedPost && isVisibleCommunityPostKind(nextFeedPost.kind)) {
      setFeedByCommunityId((current) => ({
        ...current,
        [nextFeedPost.communityId]: prependPost(current[nextFeedPost.communityId] ?? [], nextFeedPost),
      }));

      const nextPostTs = getCommunityPostActivityTs(nextFeedPost);
      if (nextPostTs !== null) {
        setCommunities((current) => current.map((community) => (
          community.id === nextFeedPost.communityId
            ? withCommunityVisibleFeedActivity(community, nextPostTs, nextFeedPost.publishedAt)
            : community
        )));
      }
    }

    if (nextCommunity) {
      setDetailLoadedByCommunityId((current) => ({
        ...current,
        [nextCommunity.id]: true,
      }));
    }
  };

  const getCommunityLogoSrc = useCallback((community: CommunityRecord) => {
    const candidates = buildCommunityLogoCandidates(community);
    const signature = candidates.join("|");
    const fallbackState = communityLogoFallbackById[community.id];
    const index = fallbackState?.signature === signature ? fallbackState.index : 0;
    return candidates[index] ?? null;
  }, [communityLogoFallbackById]);

  const handleCommunityLogoError = useCallback((community: CommunityRecord) => {
    const candidates = buildCommunityLogoCandidates(community);
    const signature = candidates.join("|");
    setCommunityLogoFallbackById((current) => {
      const fallbackState = current[community.id];
      const index = fallbackState?.signature === signature ? fallbackState.index : 0;
      const nextIndex = Math.min(index + 1, candidates.length);
      if (fallbackState?.signature === signature && fallbackState.index === nextIndex) {
        return current;
      }
      return {
        ...current,
        [community.id]: {
          signature,
          index: nextIndex,
        },
      };
    });
  }, []);

  const renderNodeFace = (community: CommunityRecord, isCompact = false) => {
    const palette = getNodePalette(community.name);
    const logoSrc = getCommunityLogoSrc(community);
    if (logoSrc) {
      return (
        <img
          src={logoSrc}
          alt={community.name}
          className="community-node-image"
          onError={() => handleCommunityLogoError(community)}
        />
      );
    }

    return (
      <div
        className={`community-node-fallback${isCompact ? " compact" : ""}`}
        style={{
          "--community-gradient-start": palette.start,
          "--community-gradient-end": palette.end,
        } as CSSProperties}
      >
        {getInitials(community.name)}
      </div>
    );
  };

  const markCommunityAsSeen = useCallback((communityId: string, seenTs = Date.now()) => {
    setCommunityLastSeenById((current) => {
      const nextSeenTs = Math.max(current[communityId] ?? 0, seenTs);
      if (current[communityId] === nextSeenTs) return current;
      return {
        ...current,
        [communityId]: nextSeenTs,
      };
    });
  }, []);

  const markCommunityChatAsRead = useCallback((communityId: string, readTs = Date.now()) => {
    setCommunityChatLastReadById((current) => {
      const nextReadTs = Math.max(current[communityId] ?? 0, readTs);
      if (current[communityId] === nextReadTs) return current;
      return {
        ...current,
        [communityId]: nextReadTs,
      };
    });
  }, []);

  useEffect(() => {
    if (!selectedCommunity) return;
    if (!isCommunityAccessible(selectedCommunity, profileId, profilePhone)) return;
    markCommunityAsSeen(selectedCommunity.id);
  }, [markCommunityAsSeen, profileId, profilePhone, selectedCommunity]);

  useEffect(() => {
    if (activeCommunityTab !== "CHAT" || !selectedCommunity) return;
    if (currentChatMessages.length === 0) return;

    const latestMessageTs = currentChatMessages.reduce(
      (maxTs, message) => Math.max(maxTs, getCommunityChatMessageTimestamp(message)),
      0,
    );

    if (latestMessageTs > 0) {
      markCommunityChatAsRead(selectedCommunity.id, latestMessageTs);
    }
  }, [activeCommunityTab, currentChatMessages, markCommunityChatAsRead, selectedCommunity]);

  const openCommunity = (community: CommunityRecord) => {
    setSelectedCommunityId(community.id);
    setFocusedCommunityId(community.id);
    setExpandedGraphCommunityId(community.id);
    setAccessMessage(null);
  };

  const handleCommunityNodeClick = (community: CommunityRecord) => {
    setFocusedCommunityId(community.id);
    setExpandedGraphCommunityId(community.id);
    setAccessMessage(null);
  };

  const handleFocusedCommunityInfoClick = (community: CommunityRecord) => {
    if (isCommunityAccessible(community, profileId, profilePhone)) {
      openCommunity(community);
      return;
    }

    setAccessMessage(`"${community.name}" закрыто. Вход только по ссылке-приглашению.`);
  };

  const handleCommunityStoryClick = (community: CommunityRecord) => {
    setFocusedCommunityId(community.id);
    if (isCommunityAccessible(community, profileId, profilePhone)) {
      openCommunity(community);
      return;
    }

    setSelectedCommunityId(null);
    setAccessMessage(`"${community.name}" закрыто. Вход только по ссылке-приглашению.`);
  };

  const handleCommunitiesHeaderClick = () => {
    const entryCommunity = joinedCommunities[0] ?? null;

    if (!entryCommunity) return;

    if (isCommunityAccessible(entryCommunity, profileId, profilePhone)) {
      openCommunity(entryCommunity);
      return;
    }

    setInviteError(null);
    setInviteValue("");
    setIsInviteOpen(true);
  };

  const handleMoveCommunity = (communityId: string, direction: -1 | 1) => {
    const currentIndex = communities.findIndex((community) => community.id === communityId);
    if (currentIndex < 0) return;

    const nextIndex = currentIndex + direction;
    if (nextIndex < 0 || nextIndex >= communities.length) return;

    const nextCommunities = [...communities];
    const [movedCommunity] = nextCommunities.splice(currentIndex, 1);
    if (!movedCommunity) return;
    nextCommunities.splice(nextIndex, 0, movedCommunity);

    setCommunities(nextCommunities);
    setCommunityOrderIds(nextCommunities.map((community) => community.id));
    setAccessMessage("Порядок кружков сообществ сохранен для этого профиля.");
  };

  const handleJoinOpenCommunity = useCallback(async (community: CommunityRecord) => {
    setJoiningCommunityId(community.id);
    setDetailError(null);
    setAccessMessage(null);

    const response = await apiAddCommunityMember(community.id, {
      member: currentMember,
    });

    setJoiningCommunityId(null);

    if (response.error) {
      setAccessMessage(
        communityErrorMessage(response.error, "Не удалось вступить в сообщество"),
      );
      return;
    }

    applyActionResponse(response.data);

    if (response.data?.community) {
      setFocusedCommunityId(response.data.community.id);
      if (response.data.membershipStatus === "ACTIVE" || response.data.community.visibility === "OPEN") {
        setSelectedCommunityId(response.data.community.id);
      }
    }

    if (redirectToInviteCabinet()) {
      return;
    }

    if (response.data?.message) {
      setAccessMessage(response.data.message);
    }
  }, [currentMember, redirectToInviteCabinet]);

  const handleInviteSubmit = async (event: FormEvent) => {
    event.preventDefault();
    const inviteCode = extractInviteCode(inviteValue);
    if (!inviteCode) {
      setInviteError("Вставь ссылку-приглашение или код сообщества.");
      return;
    }

    setInviteSubmitting(true);
    setInviteError(null);

    const response = await apiJoinCommunityByInvite({
      inviteCode,
      inviteLink: inviteValue,
      member: currentMember,
    });

    setInviteSubmitting(false);

    if (response.error) {
      setInviteError(
        communityErrorMessage(response.error, "Не удалось войти по приглашению"),
      );
      return;
    }

    applyActionResponse(response.data);

    const joinedCommunity = response.data?.community;
    if (joinedCommunity) {
      setFocusedCommunityId(joinedCommunity.id);
      setSelectedCommunityId(joinedCommunity.id);
    }

    setInviteValue("");
    setIsInviteOpen(false);
    if (redirectToInviteCabinet()) {
      return;
    }
    setAccessMessage(response.data?.message ?? null);
  };

  useEffect(() => {
    const inviteCode = extractInviteCode(initialInviteCode || initialInviteLink || "");
    const inviteLink = (initialInviteLink || "").trim() || buildCommunityInviteLink(inviteCode) || "";
    const dedupeKey = inviteCode ? `code:${inviteCode}` : "";

    if (!inviteCode || !inviteLink) return;
    if (inviteSubmitting) return;
    if (initialInviteHandledRef.current === dedupeKey) return;

    initialInviteHandledRef.current = dedupeKey;
    setIsInviteOpen(true);
    setInviteValue(inviteLink);
    setInviteError(null);
    setAccessMessage(null);
    setInviteSubmitting(true);

    void apiJoinCommunityByInvite({
      inviteCode,
      inviteLink,
      member: currentMember,
    }).then((response) => {
      setInviteSubmitting(false);

      if (response.error) {
        setInviteError(
          communityErrorMessage(response.error, "Не удалось войти в сообщество по ссылке"),
        );
        return;
      }

      applyActionResponse(response.data);

      const joinedCommunity = response.data?.community;
      if (joinedCommunity) {
        setFocusedCommunityId(joinedCommunity.id);
        setSelectedCommunityId(joinedCommunity.id);
      }

      setInviteValue("");
      setIsInviteOpen(false);
      if (redirectToInviteCabinet()) {
        return;
      }
      setAccessMessage(response.data?.message ?? "Вступление в сообщество сохранено.");
    }).catch((error: unknown) => {
      setInviteSubmitting(false);
      setInviteError(error instanceof Error ? error.message : "Не удалось войти в сообщество по ссылке");
    });
  }, [currentMember, initialInviteCode, initialInviteLink, inviteSubmitting, redirectToInviteCabinet]);

  const updateGraphZoom = (nextZoom: number) => {
    setGraphZoomOverride(clamp(COMMUNITY_GRAPH_MIN_ZOOM, nextZoom, COMMUNITY_GRAPH_MAX_ZOOM));
  };

  const handleGraphWheel = (event: ReactWheelEvent<HTMLDivElement>) => {
    if (!event.ctrlKey && !event.metaKey) return;
    event.preventDefault();
    updateGraphZoom(
      graphView.scale + (event.deltaY < 0 ? COMMUNITY_GRAPH_ZOOM_STEP : -COMMUNITY_GRAPH_ZOOM_STEP),
    );
  };

  const handleGraphTouchStart = (event: ReactTouchEvent<HTMLDivElement>) => {
    if (event.touches.length !== 2) {
      pinchZoomRef.current = null;
      return;
    }

    pinchZoomRef.current = {
      distance: getTouchDistance(event.touches[0], event.touches[1]),
      zoom: graphView.scale,
    };
  };

  const handleGraphTouchMove = (event: ReactTouchEvent<HTMLDivElement>) => {
    if (event.touches.length !== 2 || !pinchZoomRef.current) return;

    const nextDistance = getTouchDistance(event.touches[0], event.touches[1]);
    if (!Number.isFinite(nextDistance) || nextDistance <= 0) return;

    event.preventDefault();
    updateGraphZoom(pinchZoomRef.current.zoom * (nextDistance / pinchZoomRef.current.distance));
  };

  const handleGraphTouchEnd = (event: ReactTouchEvent<HTMLDivElement>) => {
    if (event.touches.length < 2) {
      pinchZoomRef.current = null;
    }
  };

  const handleCreateLogoChange = async (event: ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    if (!file) return;

    try {
      const optimizedLogo = await optimizeCommunityLogo(file);
      const uploadResponse = await apiUploadCommunityLogo({
        dataUrl: optimizedLogo.originalDataUrl,
        thumbDataUrl: optimizedLogo.thumbDataUrl,
      });
      if (uploadResponse.error || !uploadResponse.data) {
        throw new Error(communityErrorMessage(uploadResponse.error, "Не удалось загрузить логотип сообщества."));
      }
      setFormState((current) => ({
        ...current,
        logoUrl: uploadResponse.data?.logoUrl ?? null,
        logoThumbUrl: uploadResponse.data?.logoThumbUrl ?? uploadResponse.data?.logoUrl ?? null,
      }));
      setFormError(null);
    } catch (error) {
      setFormError(error instanceof Error ? error.message : "Не удалось загрузить логотип, попробуй другое изображение.");
    } finally {
      event.target.value = "";
    }
  };

  const handleEditLogoChange = async (event: ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    if (!file) return;

    try {
      const optimizedLogo = await optimizeCommunityLogo(file);
      const uploadResponse = await apiUploadCommunityLogo({
        dataUrl: optimizedLogo.originalDataUrl,
        thumbDataUrl: optimizedLogo.thumbDataUrl,
      });
      if (uploadResponse.error || !uploadResponse.data) {
        throw new Error(communityErrorMessage(uploadResponse.error, "Не удалось загрузить логотип сообщества."));
      }
      setEditFormState((current) => ({
        ...current,
        logoUrl: uploadResponse.data?.logoUrl ?? null,
        logoThumbUrl: uploadResponse.data?.logoThumbUrl ?? uploadResponse.data?.logoUrl ?? null,
      }));
      setEditFormError(null);
    } catch (error) {
      setEditFormError(error instanceof Error ? error.message : "Не удалось загрузить логотип, попробуй другое изображение.");
    } finally {
      event.target.value = "";
    }
  };

  const handleCreateCommunity = async (event: FormEvent) => {
    event.preventDefault();

    const name = formState.name.trim();
    const description = formState.description.trim();
    const city = formState.city.trim();
    const rules = formState.rules.trim();
    const focusTags = formState.focusTags
      .split(",")
      .map((item) => item.trim())
      .filter(Boolean)
      .slice(0, 6);

    if (!name || !description || !city) {
      setFormError("Заполни название, описание и город сообщества.");
      return;
    }

    setCreatingCommunity(true);
    setFormError(null);

    const response = await apiCreateCommunity({
      name,
      logoUrl: formState.logoUrl,
      logoThumbUrl: formState.logoThumbUrl,
      visibility: formState.visibility,
      description,
      city,
      focusTags,
      minimumLevel: formState.minimumLevel,
      joinRule: formState.visibility === "CLOSED" ? "INVITE_ONLY" : formState.joinRule,
      rules:
        rules ||
        "Уважайте расписание, подтверждайте участие заранее и отмечайте любые изменения в ленте сообщества.",
      creator: buildCommunityActor(profile, "OWNER"),
    });

    setCreatingCommunity(false);

    if (response.error) {
      setFormError(
        communityErrorMessage(response.error, "Не удалось создать сообщество"),
      );
      return;
    }

    applyActionResponse(response.data);

    if (response.data?.community) {
      setFocusedCommunityId(response.data.community.id);
      setSelectedCommunityId(response.data.community.id);
    }

    setIsCreateOpen(false);
    setFormState(EMPTY_FORM);
    setAccessMessage(response.data?.message ?? "Сообщество создано и сохранено в базе.");
  };

  const handleUpdateCommunity = async (event: FormEvent) => {
    event.preventDefault();
    if (!selectedCommunity) return;

    const name = editFormState.name.trim();
    const description = editFormState.description.trim();
    const city = editFormState.city.trim();
    const rules = editFormState.rules.trim();
    const focusTags = parseCommunityFocusTags(editFormState.focusTags);

    if (!name || !description || !city) {
      setEditFormError("Заполни название, описание и город сообщества.");
      return;
    }

    setEditSubmitting(true);
    setEditFormError(null);

    const response = await apiUpdateCommunity(selectedCommunity.id, {
      name,
      logoUrl: editFormState.logoUrl,
      logoThumbUrl: editFormState.logoThumbUrl,
      visibility: editFormState.visibility,
      description,
      city,
      focusTags,
      minimumLevel: editFormState.minimumLevel,
      joinRule: editFormState.visibility === "CLOSED" ? "INVITE_ONLY" : editFormState.joinRule,
      rules:
        rules
        || "Уважайте расписание, подтверждайте участие заранее и отмечайте любые изменения в ленте сообщества.",
      actor: {
        ...currentMember,
        role: selectedCommunityMember?.role ?? currentMember.role,
      },
    });

    setEditSubmitting(false);

    if (response.error) {
      setEditFormError(
        communityErrorMessage(response.error, "Не удалось сохранить настройки сообщества"),
      );
      return;
    }

    applyActionResponse(response.data);

    if (response.data?.community) {
      setEditFormState(buildCommunityFormStateFromRecord(response.data.community));
    }

    setEditingCommunity(false);
    setAccessMessage(response.data?.message ?? "Настройки сообщества обновлены.");
  };

  const handleManageCommunityMember = async (
    member: CommunityMember,
    action: CommunityMemberAction,
  ) => {
    if (!selectedCommunity) return;

    const requestKey = `${action}:${member.id ?? member.phone ?? member.name}`;
    setManagingMemberKey(requestKey);
    setMemberActionError(null);

    const response = await apiManageCommunityMember(selectedCommunity.id, {
      action,
      actor: {
        ...currentMember,
        role: selectedCommunityMember?.role ?? currentMember.role,
      },
      member: {
        id: member.id,
        phone: member.phone,
        name: member.name,
        avatar: member.avatar,
        role: member.role,
        levelScore: member.levelScore,
        levelLabel: member.levelLabel,
      },
    });

    setManagingMemberKey(null);

    if (response.error) {
      setMemberActionError(
        communityErrorMessage(
          response.error,
          action === "BAN"
            ? "Не удалось забанить участника"
            : "Не удалось удалить участника",
        ),
      );
      return;
    }

    applyActionResponse(response.data);
    if (response.data?.community) {
      setEditFormState(buildCommunityFormStateFromRecord(response.data.community));
    }
    const isCurrentUser =
      (member.id && member.id === profileId)
      || Boolean(profilePhone && member.phone && member.phone === profilePhone);
    const removedCurrentUser = action === "REMOVE" && (
      isCurrentUser
      || Boolean(response.data?.community && !isCommunityMember(response.data.community, profileId, profilePhone))
    );
    if (removedCurrentUser && redirectToInviteCabinet()) {
      return;
    }
    setAccessMessage(response.data?.message ?? null);
  };

  const handleOpenCommunityHeaderMenu = useCallback(() => {
    if (canManageSelectedCommunity) {
      setActiveCommunityTab("SETTINGS");
      return;
    }

    setCommunityActionError(null);
    setIsCommunityActionsOpen(true);
  }, [canManageSelectedCommunity]);

  const handleOpenCommunityReport = useCallback(() => {
    setCommunityActionError(null);
    setCommunityReportError(null);
    setCommunityReportText("");
    setIsCommunityActionsOpen(false);
    setIsCommunityReportOpen(true);
  }, []);

  const handleLeaveSelectedCommunity = useCallback(async () => {
    if (!selectedCommunity) return;

    if (!selectedCommunityMember) {
      setCommunityActionError("Покинуть можно только то сообщество, в котором вы уже состоите.");
      return;
    }

    setCommunityLeaveSubmitting(true);
    setCommunityActionError(null);

    const response = await apiManageCommunityMember(selectedCommunity.id, {
      action: "REMOVE",
      actor: {
        ...currentMember,
        role: selectedCommunityMember.role,
      },
      member: {
        id: selectedCommunityMember.id,
        phone: selectedCommunityMember.phone,
        name: selectedCommunityMember.name,
        avatar: selectedCommunityMember.avatar,
        role: selectedCommunityMember.role,
        levelScore: selectedCommunityMember.levelScore,
        levelLabel: selectedCommunityMember.levelLabel,
      },
    });

    setCommunityLeaveSubmitting(false);

    if (response.error) {
      setCommunityActionError(
        communityErrorMessage(response.error, "Не удалось покинуть сообщество."),
      );
      return;
    }

    applyActionResponse(response.data);
    if (response.data?.community) {
      setEditFormState(buildCommunityFormStateFromRecord(response.data.community));
    }

    setIsCommunityLeaveConfirmOpen(false);
    setIsCommunityActionsOpen(false);

    const removedCurrentUser = Boolean(
      response.data?.community && !isCommunityMember(response.data.community, profileId, profilePhone),
    );
    if (removedCurrentUser && redirectToInviteCabinet()) {
      return;
    }

    setSelectedCommunityId(null);
    setAccessMessage(response.data?.message ?? `Вы покинули сообщество «${selectedCommunity.name}».`);
  }, [
    applyActionResponse,
    currentMember,
    profileId,
    profilePhone,
    redirectToInviteCabinet,
    selectedCommunity,
    selectedCommunityMember,
  ]);

  const handleSubmitCommunityReport = useCallback(async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();

    if (!selectedCommunity) return;

    const text = communityReportText.trim();
    if (!text) {
      setCommunityReportError("Опишите, пожалуйста, причину жалобы.");
      return;
    }

    setCommunityReportSubmitting(true);
    setCommunityReportError(null);

    const reportMessage = [
      "Жалоба на сообщество",
      `Сообщество: ${selectedCommunity.name}`,
      `Community ID: ${selectedCommunity.id}`,
      `Роль отправителя: ${selectedCommunityMember?.role ?? "GUEST"}`,
      "",
      "Текст жалобы:",
      text,
    ].join("\n");

    const result = await apiCreateSupportDialogEvent({
      connector: COMMUNITY_SUPPORT_CONNECTOR,
      channel: COMMUNITY_SUPPORT_CHANNEL,
      direction: "INBOUND",
      authorType: "CLIENT",
      eventType: "COMMUNITY_REPORT",
      text: reportMessage,
      phone: profile.phone,
      primaryPhone: profile.phone,
      displayName: currentMember.name,
      clientName: currentMember.name,
      senderName: currentMember.name,
      userId: profile.id,
      clientId: profile.id,
      senderId: profile.id,
      channelUserId: profile.id,
      chatId: `lk:${profile.id || profile.phone || "guest"}`,
      externalThreadId: `lk:${profile.id || profile.phone || "guest"}:community-report:${selectedCommunity.id}`,
      authStatus: "AUTHORIZED",
      workflowState: "READY",
      metadata: {
        source: "lk_community_report",
        surface: "community_feed",
        communityId: selectedCommunity.id,
        communityName: selectedCommunity.name,
        reporterRole: selectedCommunityMember?.role ?? "GUEST",
      },
    });

    setCommunityReportSubmitting(false);

    if (result.error || !result.data) {
      setCommunityReportError(
        communityErrorMessage(result.error, "Не удалось отправить жалобу."),
      );
      return;
    }

    setIsCommunityReportOpen(false);
    setCommunityReportText("");
    setAccessMessage(`Жалоба на сообщество «${selectedCommunity.name}» отправлена.`);
  }, [
    communityReportText,
    currentMember.name,
    profile.id,
    profile.phone,
    selectedCommunity,
    selectedCommunityMember,
  ]);

  const handleFeedImageChange = async (event: ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    if (!file) return;

    try {
      const imageUrl = await readFileAsDataUrl(file);
      const image = await loadImageElement(imageUrl);
      setFeedImageNaturalSize({
        width: image.naturalWidth || image.width,
        height: image.naturalHeight || image.height,
      });
      setFeedImageEditor({
        source: imageUrl,
        zoom: 1,
        focalX: 50,
        focalY: 50,
      });
      setFeedFormState((current) => ({ ...current, imageUrl }));
    } catch {
      setFeedFormError("Не удалось загрузить изображение для поста.");
    }
  };

  const updateFeedImageFrame = useCallback((update: (current: FeedImageEditorState) => FeedImageEditorState) => {
    setFeedImageEditor((current) => {
      const next = update(current);
      return {
        ...next,
        zoom: clamp(1, next.zoom, 2.6),
        focalX: clamp(0, next.focalX, 100),
        focalY: clamp(0, next.focalY, 100),
      };
    });
  }, []);

  const handleFeedImageTouchStart = useCallback((event: ReactTouchEvent<HTMLDivElement>) => {
    if (!feedImageNaturalSize) return;

    if (event.touches.length === 1) {
      const touch = event.touches[0];
      feedImagePinchRef.current = null;
      feedImageDragRef.current = {
        touchX: touch.clientX,
        touchY: touch.clientY,
        focalX: feedImageEditor.focalX,
        focalY: feedImageEditor.focalY,
      };
      return;
    }

    if (event.touches.length === 2) {
      feedImageDragRef.current = null;
      feedImagePinchRef.current = {
        distance: getTouchDistance(event.touches[0], event.touches[1]),
        zoom: feedImageEditor.zoom,
      };
    }
  }, [feedImageEditor.focalX, feedImageEditor.focalY, feedImageEditor.zoom, feedImageNaturalSize]);

  const handleFeedImageTouchMove = useCallback((event: ReactTouchEvent<HTMLDivElement>) => {
    if (!feedImageNaturalSize) return;

    if (event.touches.length === 1 && feedImageDragRef.current) {
      const touch = event.touches[0];
      const deltaX = touch.clientX - feedImageDragRef.current.touchX;
      const deltaY = touch.clientY - feedImageDragRef.current.touchY;
      const cover = buildCoverImageStyle(
        feedImageNaturalSize.width,
        feedImageNaturalSize.height,
        COMMUNITY_NEWS_EDITOR_PREVIEW.width,
        COMMUNITY_NEWS_EDITOR_PREVIEW.height,
        feedImageEditor.zoom,
        feedImageDragRef.current.focalX,
        feedImageDragRef.current.focalY,
      );
      const movableWidth = COMMUNITY_NEWS_EDITOR_PREVIEW.width - cover.width;
      const movableHeight = COMMUNITY_NEWS_EDITOR_PREVIEW.height - cover.height;

      event.preventDefault();
      updateFeedImageFrame((current) => ({
        ...current,
        focalX: movableWidth === 0 ? current.focalX : ((cover.left + deltaX) / movableWidth) * 100,
        focalY: movableHeight === 0 ? current.focalY : ((cover.top + deltaY) / movableHeight) * 100,
      }));
      return;
    }

    if (event.touches.length === 2 && feedImagePinchRef.current) {
      const nextDistance = getTouchDistance(event.touches[0], event.touches[1]);
      if (!Number.isFinite(nextDistance) || nextDistance <= 0) return;

      event.preventDefault();
      updateFeedImageFrame((current) => ({
        ...current,
        zoom: feedImagePinchRef.current
          ? feedImagePinchRef.current.zoom * (nextDistance / feedImagePinchRef.current.distance)
          : current.zoom,
      }));
    }
  }, [feedImageEditor.zoom, feedImageNaturalSize, updateFeedImageFrame]);

  const handleFeedImageTouchEnd = useCallback((event: ReactTouchEvent<HTMLDivElement>) => {
    if (event.touches.length === 0) {
      feedImageDragRef.current = null;
      feedImagePinchRef.current = null;
      return;
    }

    if (event.touches.length === 1) {
      const touch = event.touches[0];
      feedImagePinchRef.current = null;
      feedImageDragRef.current = {
        touchX: touch.clientX,
        touchY: touch.clientY,
        focalX: feedImageEditor.focalX,
        focalY: feedImageEditor.focalY,
      };
    }
  }, [feedImageEditor.focalX, feedImageEditor.focalY]);

  const handleFeedKindChange = (kind: FeedFormState["kind"]) => {
    if (kind === "TOURNAMENT" && !canCreateTournamentPostInSelectedCommunity) {
      setFeedFormError("Посты типа «Турнир» доступны только модераторам и администраторам сообщества.");
      return;
    }

    setFeedFormError(null);
    setFeedFormState((current) => ({
      ...current,
      kind,
      relatedGameId: kind === "GAME" ? current.relatedGameId : "",
      relatedTournamentId: kind === "TOURNAMENT" ? current.relatedTournamentId : "",
    }));
  };

  const resetFeedComposer = () => {
    setFeedFormState(EMPTY_FEED_FORM);
    setFeedImageEditor(EMPTY_FEED_IMAGE_EDITOR);
    setFeedImageNaturalSize(null);
    setFeedTournamentOptionsError(null);
    setFeedFormError(null);
    setEditingFeedPostId(null);
  };

  const openFeedComposerForEdit = useCallback((post: CommunityPost) => {
    setFeedFormError(null);
    setFeedTournamentOptionsError(null);
    setEditingFeedPostId(post.id);
    setFeedFormState({
      kind: post.kind === "GAME" || post.kind === "TOURNAMENT" ? post.kind : "PHOTO",
      title: post.title,
      body: post.body,
      imageUrl: post.imageUrl,
      previewLabel: post.previewLabel ?? "",
      relatedGameId: post.relatedGameId ?? "",
      relatedTournamentId: post.relatedTournamentId ?? "",
    });
    setFeedImageEditor(EMPTY_FEED_IMAGE_EDITOR);
    setFeedImageNaturalSize(null);
    setIsFeedComposerOpen(true);
  }, []);

  const handleFeedGameChange = (gameId: string) => {
    const selectedGame = upcomingCreatedGames.find((game) => game.id === gameId);
    if (!selectedGame) {
      setFeedFormState((current) => ({ ...current, relatedGameId: gameId }));
      return;
    }

    setFeedFormState((current) => ({
      ...current,
      relatedGameId: gameId,
      title: "Приглашение в игру",
      body: buildGameBody(selectedGame),
      previewLabel: buildGamePreviewLabel(selectedGame),
    }));
  };

  const handleFeedTournamentChange = (tournamentId: string) => {
    const selectedTournamentOption = feedTournamentOptions.find(
      (option) => option.tournament.id === tournamentId,
    );
    if (!selectedTournamentOption) {
      setFeedFormState((current) => ({ ...current, relatedTournamentId: tournamentId }));
      return;
    }

    setFeedFormState((current) => ({
      ...current,
      relatedTournamentId: tournamentId,
      title: buildTournamentTitle(selectedTournamentOption.tournament),
      body: buildTournamentBody(selectedTournamentOption),
      previewLabel: buildTournamentPreviewLabel(selectedTournamentOption),
    }));
  };

  const handleCreateFeedPost = async (event: FormEvent) => {
    event.preventDefault();

    if (!selectedCommunity) return;
    if (!isCommunityMember(selectedCommunity, profileId, profilePhone)) {
      setFeedFormError("Публиковать посты могут только участники сообщества.");
      return;
    }
    if (feedFormState.kind === "TOURNAMENT" && !canCreateTournamentPostInSelectedCommunity) {
      setFeedFormError("Посты типа «Турнир» доступны только модераторам и администраторам сообщества.");
      return;
    }

    const title = feedFormState.title.trim();
    const body = feedFormState.body.trim();
    const previewLabel = feedFormState.previewLabel.trim();
    const selectedGame = upcomingCreatedGames.find((game) => game.id === feedFormState.relatedGameId) ?? null;
    const selectedTournamentOption = feedTournamentOptions.find(
      (option) => option.tournament.id === feedFormState.relatedTournamentId,
    ) ?? null;

    if (feedFormState.kind === "GAME" && !selectedGame) {
      setFeedFormError(
        upcomingCreatedGames.length === 0
          ? "У тебя пока нет предстоящих игр для публикации в ленте."
          : "Выбери предстоящую игру, которую нужно опубликовать в ленте.",
      );
      return;
    }

    if (feedFormState.kind === "TOURNAMENT" && !selectedTournamentOption) {
      setFeedFormError(
        feedTournamentOptionsLoading
          ? "Подождите, загружаем доступные турниры."
          : feedTournamentOptions.length === 0
            ? "Нет доступных турниров, где ты участник или исполнитель."
            : "Выбери турнир, который нужно опубликовать в ленте.",
      );
      return;
    }

    if (!title || !body) {
      setFeedFormError("Заполни заголовок и описание поста.");
      return;
    }

    setFeedSubmitting(true);
    setFeedFormError(null);

    let preparedImageUrl = feedFormState.imageUrl;
    if (feedFormState.kind === "PHOTO" && feedImageEditor.source) {
      try {
        preparedImageUrl = await renderFeedNewsImage(feedImageEditor.source, feedImageEditor);
      } catch {
        setFeedSubmitting(false);
        setFeedFormError("Не удалось подготовить фото для новости.");
        return;
      }
    }

    const payload = {
      member: {
        ...currentMember,
        role: selectedCommunityMember?.role ?? currentMember.role,
      },
      kind: feedFormState.kind,
      title,
      body,
      imageUrl: preparedImageUrl,
      previewLabel: previewLabel || null,
      ctaLabel:
        feedFormState.kind === "GAME"
          ? "Открыть игру"
          : feedFormState.kind === "TOURNAMENT"
            ? "Открыть турнир"
            : null,
      relatedGameId: selectedGame?.id ?? null,
      relatedTournamentId: selectedTournamentOption?.tournament.id ?? null,
    };

    const response = editingFeedPostId
      ? await apiUpdateCommunityFeedPost(selectedCommunity.id, editingFeedPostId, payload)
      : await apiCreateCommunityFeedPost(selectedCommunity.id, payload);

    setFeedSubmitting(false);

    if (response.error || !response.data) {
      setFeedFormError(
        communityErrorMessage(
          response.error,
          editingFeedPostId
            ? "Не удалось сохранить изменения новости"
            : "Не удалось опубликовать пост сообщества",
        ),
      );
      return;
    }

    const nextPost = response.data;
    setFeedByCommunityId((current) => ({
      ...current,
      [selectedCommunity.id]: editingFeedPostId
        ? updateCommunityPostById(current[selectedCommunity.id] ?? [], editingFeedPostId, () => nextPost)
        : prependPost(current[selectedCommunity.id] ?? [], nextPost),
    }));
    markCommunityAsSeen(selectedCommunity.id, Math.max(Date.now(), nextPost.createdTs ?? 0));
    setDetailLoadedByCommunityId((current) => ({
      ...current,
      [selectedCommunity.id]: true,
    }));
    resetFeedComposer();
    setIsFeedComposerOpen(false);
  };

  const handleSendChatMessage = async (event: FormEvent) => {
    event.preventDefault();

    if (!selectedCommunity) return;
    if (!canChatInSelectedCommunity) {
      setChatError("Писать в чат могут только участники сообщества.");
      return;
    }

    const text = chatDraft.trim();
    if (isCurrentChatSending) {
      return;
    }

    if (!text) {
      setChatError("Напиши сообщение для чата.");
      return;
    }

    setChatSendingId(selectedCommunity.id);
    setChatError(null);

    const response = await apiCreateCommunityChatMessage(selectedCommunity.id, {
      member: currentMember,
      text,
    });

    setChatSendingId((current) => (current === selectedCommunity.id ? null : current));

    if (response.error || !response.data) {
      setChatError(
        communityErrorMessage(response.error, "Не удалось отправить сообщение в чат сообщества"),
      );
      return;
    }

    const sentMessage = response.data;
    setChatByCommunityId((current) => ({
      ...current,
      [selectedCommunity.id]: mergeCommunityChatMessages(current[selectedCommunity.id] ?? [], [sentMessage]),
    }));
    setChatLoadedByCommunityId((current) => ({
      ...current,
      [selectedCommunity.id]: true,
    }));
    chatScrollActionRef.current = {
      type: "bottom",
      communityId: selectedCommunity.id,
      behavior: "smooth",
    };
    setChatDraft("");
    setChatError(null);
  };

  const canPostInSelectedCommunity = selectedCommunity
    ? isCommunityMember(selectedCommunity, profileId, profilePhone)
    : false;
  const canCreateTournamentPostInSelectedCommunity = canCreateTournamentFeedPost(selectedCommunityMember?.role);

  useEffect(() => {
    if (!canCreateTournamentPostInSelectedCommunity) {
      setFeedFormState((current) => (
        current.kind === "TOURNAMENT"
          ? { ...current, kind: "PHOTO", relatedTournamentId: "" }
          : current
      ));
    }
  }, [canCreateTournamentPostInSelectedCommunity]);

  const handlePlayCommunityGame = async (game: Game, entry: FeedEntry) => {
    const gameId = (entry.relatedGameId ?? game.id ?? "").trim();
    if (!gameId) {
      onOpenGames();
      return;
    }

    if (joiningGameId === gameId) {
      return;
    }

    const currentUserId = (currentMember.id || "").trim() || null;
    const currentUserPhone = normalizePhone(currentMember.phone ?? profile.phone);
    const currentUserName = currentMember.name.trim() || "Игрок";

    setJoiningGameId(gameId);
    setAccessMessage(null);

    const baseRecord =
      feedGameRecordById[gameId]
      ?? createdGames.find((record) => record.id === gameId)
      ?? null;
    const gameResponse = baseRecord ? { data: baseRecord, error: null } : await apiFetchPadelGameRecord(gameId);
    const gameRecord = gameResponse.data;

    if (!gameRecord) {
      setAccessMessage(
        communityErrorMessage(gameResponse.error, "Не удалось загрузить игру. Попробуйте еще раз."),
      );
      setJoiningGameId(null);
      return;
    }

    if (isCurrentUserInGameRecord(gameRecord, currentUserId, currentUserPhone)) {
      setJoiningGameId(null);
      onOpenGames({ gameId, openChat: false });
      return;
    }

    if (!currentUserId && !currentUserPhone) {
      setAccessMessage("Не удалось определить ваш профиль для присоединения к игре.");
      setJoiningGameId(null);
      return;
    }

    const currentLevelScore = getLevelScoreFromProfile(profile);
    const currentPlayer: PadelGamePlayer = {
      id: currentUserId,
      name: currentUserName,
      phone: currentUserPhone,
      photo: selectedCommunityMember?.avatar ?? currentMember.avatar ?? profile.photo ?? null,
      rating: currentMember.levelLabel || getLetterGrade(currentLevelScore),
      ratingNumeric: currentLevelScore,
      source: "INVITE_LINK",
      status: "CONFIRMED",
    };

    const maxPlayers = resolveGameMaxPlayers(gameRecord);
    const waitlistEnabled = resolveGameWaitlistEnabled(gameRecord);
    let nextParticipants = removeGamePlayer(
      dedupeGamePlayers(gameRecord.participants ?? []),
      currentUserPhone,
      currentUserId,
    );
    let nextWaitlist = removeGamePlayer(
      dedupeGamePlayers(gameRecord.waitlist ?? []),
      currentUserPhone,
      currentUserId,
    );

    let joinedToWaitlist = false;

    if (nextParticipants.length < maxPlayers) {
      nextParticipants = [
        ...nextParticipants,
        {
          ...currentPlayer,
          status: "CONFIRMED",
        },
      ];
    } else if (waitlistEnabled) {
      joinedToWaitlist = true;
      nextWaitlist = [
        ...nextWaitlist,
        {
          ...currentPlayer,
          status: "WAITLIST",
        },
      ];
    } else {
      setAccessMessage("Свободных мест нет. Игра заполнена.");
      setJoiningGameId(null);
      onOpenGames({ gameId, openChat: false });
      return;
    }

    const updateResponse = await apiUpdatePadelGameRecord(gameId, {
      participants: nextParticipants,
      waitlist: nextWaitlist,
    });

    if (updateResponse.error) {
      setAccessMessage(
        communityErrorMessage(updateResponse.error, "Не удалось присоединиться к игре."),
      );
      setJoiningGameId(null);
      return;
    }

    setFeedGameRecordById((current) => {
      const nextRecord = updateResponse.data
        ? mergeGameRecord(current[gameId], updateResponse.data)
        : mergeGameRecord(current[gameId], {
          ...gameRecord,
          participants: nextParticipants,
          waitlist: nextWaitlist,
        });

      return {
        ...current,
        [gameId]: nextRecord,
      };
    });

    setAccessMessage(
      joinedToWaitlist
        ? "Игра заполнена. Вы добавлены в лист ожидания."
        : "Вы присоединились к игре.",
    );
    setJoiningGameId(null);
    onOpenGames({ gameId, openChat: false });
  };

  const handleFeedFabAction = (action: FeedFabAction) => {
    setFeedFormError(null);

    if (action === "game") {
      onOpenGames();
      return;
    }

    if (action === "tournament") {
      onOpenTournaments();
      return;
    }

    resetFeedComposer();
    setFeedFormState({
      ...EMPTY_FEED_FORM,
      kind: "PHOTO",
    });
    setIsFeedComposerOpen(true);
  };

  const handleEditCommunityNews = useCallback((news: News) => {
    if (!selectedCommunity) return;

    const targetPost = (feedByCommunityId[selectedCommunity.id] ?? []).find((post) => post.id === news.id);
    if (!targetPost) {
      setAccessMessage("Не удалось найти исходную новость для редактирования.");
      return;
    }

    openFeedComposerForEdit(targetPost);
  }, [feedByCommunityId, openFeedComposerForEdit, selectedCommunity]);

  const handleInvitePlayers = async () => {
    if (!selectedCommunity) return;

    const inviteLink = selectedCommunity.inviteLink?.trim();
    if (!inviteLink) {
      setAccessMessage("Ссылка приглашения пока недоступна в этом сообществе.");
      return;
    }

    const shareText = `Присоединяйся к сообществу «${selectedCommunity.name}»\n${inviteLink}`;

    try {
      if (typeof navigator !== "undefined" && typeof navigator.share === "function") {
        await navigator.share({
          title: selectedCommunity.name,
          text: shareText,
          url: inviteLink,
        });
        return;
      }

      if (typeof navigator !== "undefined" && navigator.clipboard?.writeText) {
        await navigator.clipboard.writeText(shareText);
        setAccessMessage("Ссылка приглашения скопирована.");
        return;
      }
    } catch (error) {
      if (error instanceof DOMException && error.name === "AbortError") {
        return;
      }
    }

    setAccessMessage(inviteLink);
  };
  const showCommunityGraph = typeof window !== "undefined" && window.location.hash === "#community-graph";
  const showFocusedCommunityCard = typeof window !== "undefined" && window.location.hash === "#community-focus";

  return (
    <>
      <div className="section communities-section">
        <div className="section-header communities-header">
          <span className="section-title communities-title">Сообщества</span>
          <button
            className="communities-more-button"
            type="button"
            onClick={handleCommunitiesHeaderClick}
            disabled={joinedCommunities.length === 0}
            aria-label="Открыть раздел сообществ"
          >
            <span aria-hidden="true">•••</span>
          </button>
        </div>

        <div
          ref={storiesScrollerRef}
          className="communities-stories-scroller"
          role="list"
          aria-label="Лента сообществ"
        >
          {joinedCommunities.map((community) => {
            const accessible = isCommunityAccessible(community, profileId, profilePhone);
            const isCurrent = selectedCommunityId === community.id || focusedCommunityId === community.id;
            const hasFreshActivity = communityUnreadStateById[community.id] ?? false;

            return (
              <button
                key={community.id}
                type="button"
                role="listitem"
                className={`community-story-card${isCurrent ? " is-current" : ""}${accessible ? "" : " is-locked"}${hasFreshActivity ? " has-events" : ""}`}
                onClick={() => handleCommunityStoryClick(community)}
                aria-label={accessible
                  ? `Открыть сообщество ${community.name}`
                  : `Сообщество ${community.name} доступно по приглашению`}
              >
                <div className="community-story-avatar-shell">
                  <CommunityStoryRing isHighlighted={hasFreshActivity} />
                  <div className="community-story-avatar-frame">
                    <div className="community-story-avatar">
                      {renderNodeFace(community, true)}
                    </div>
                  </div>
                  {community.isVerified ? (
                    <CommunityVerifiedBadge size="md" className="community-story-verified-badge" />
                  ) : null}
                </div>
                <span className="community-story-name" title={community.name}>{community.name}</span>
              </button>
            );
          })}

          <button
            type="button"
            role="listitem"
            className="community-story-card community-story-card--create"
            onClick={() => {
              setFormError(null);
              setFormState(EMPTY_FORM);
              setIsCreateOpen(true);
            }}
          >
            <div className="community-story-avatar-shell">
              <span className="community-story-create-ring" aria-hidden="true" />
              <div className="community-story-avatar-frame community-story-avatar-frame--create">
                <div className="community-story-avatar community-story-avatar--create">
                  <span className="community-story-create-plus">+</span>
                </div>
              </div>
            </div>
            <span className="community-story-name">Создать сообщество</span>
          </button>
        </div>

        {showCommunityGraph && (
          <div className="communities-graph-wrap">
            <div className="communities-graph">
              <div className="communities-graph-toolbar" role="group" aria-label="Масштаб графа сообществ">
                <button
                  type="button"
                  className="communities-graph-zoom-btn"
                  onClick={() => updateGraphZoom(graphView.scale - COMMUNITY_GRAPH_ZOOM_STEP)}
                  aria-label="Уменьшить граф"
                >
                  -
                </button>
                <button
                  type="button"
                  className="communities-graph-zoom-value"
                  onClick={() => setGraphZoomOverride(null)}
                  aria-label="Сбросить масштаб графа"
                >
                  {Math.round(graphView.scale * 100)}%
                </button>
                <button
                  type="button"
                  className="communities-graph-zoom-btn"
                  onClick={() => updateGraphZoom(graphView.scale + COMMUNITY_GRAPH_ZOOM_STEP)}
                  aria-label="Увеличить граф"
                >
                  +
                </button>
              </div>

              <div className="communities-graph-hint">pinch или ctrl+wheel</div>

              <div
                className="communities-graph-stage"
                ref={graphViewportRef}
                onWheel={handleGraphWheel}
                onTouchStart={handleGraphTouchStart}
                onTouchMove={handleGraphTouchMove}
                onTouchEnd={handleGraphTouchEnd}
                onTouchCancel={handleGraphTouchEnd}
              >
                <div
                  className="communities-graph-canvas"
                  style={{ "--community-graph-scale": graphView.scale } as CSSProperties}
                >
                  <div
                    className="communities-graph-layout"
                    style={{
                      "--community-graph-offset-x": `${graphView.offsetX}px`,
                      "--community-graph-offset-y": `${graphView.offsetY}px`,
                    } as CSSProperties}
                  >
                    <svg className="communities-edges" viewBox="0 0 100 100" preserveAspectRatio="none" aria-hidden="true">
                      {graphEdges.map((edge) => (
                        <line
                          key={edge.id}
                          x1={edge.x1}
                          y1={edge.y1}
                          x2={edge.x2}
                          y2={edge.y2}
                          stroke={edge.stroke}
                          strokeWidth={edge.strokeWidth}
                          strokeOpacity={edge.opacity}
                          strokeLinecap="round"
                        />
                      ))}
                    </svg>

                    {graphNodes.map(({ community, x, y, size, isBase }) => {
                      const accessible = isCommunityAccessible(community, profileId, profilePhone);
                      const isFocused = focusedCommunityId === community.id;
                      const palette = getNodePalette(community.name);
                      return (
                        <button
                          key={community.id}
                          type="button"
                          className={`community-node${isBase ? " is-base" : " is-secondary"}${isFocused ? " is-focused" : ""}${accessible ? "" : " is-locked"}`}
                          style={{
                            left: `${x}%`,
                            top: `${y}%`,
                            width: `${size}px`,
                            height: `${size}px`,
                            "--community-glow": palette.glow,
                          } as CSSProperties}
                          onClick={() => handleCommunityNodeClick(community)}
                        >
                          {renderNodeFace(community)}
                          {community.isVerified ? (
                            <CommunityVerifiedBadge size="md" className="community-node-verified-badge" />
                          ) : null}
                          <span className="community-node-size">{community.memberCount}</span>
                          {community.visibility === "CLOSED" && !accessible && (
                            <span className="community-node-lock">Закрыто</span>
                          )}
                          <span className="community-node-name">{community.name}</span>
                        </button>
                      );
                    })}

                    <button
                      type="button"
                      className="community-node community-node-create"
                      style={{
                        left: `${COMMUNITY_GRAPH_CREATE_NODE.left}px`,
                        top: `${COMMUNITY_GRAPH_CREATE_NODE.top}px`,
                      }}
                      onClick={() => {
                        setFormError(null);
                        setFormState(EMPTY_FORM);
                        setIsCreateOpen(true);
                      }}
                    >
                      <span className="community-node-create-plus">+</span>
                      <span className="community-node-create-label">Создать</span>
                    </button>
                  </div>
                </div>
              </div>
            </div>
          </div>
        )}

        {communitiesError && (
          <div className="communities-load-error">{communitiesError}</div>
        )}

        {accessMessage && (
          <div className="communities-access-note">
            <span>{accessMessage}</span>
            <button
              className="section-link"
              type="button"
              onClick={() => {
                setInviteError(null);
                setInviteValue("");
                setIsInviteOpen(true);
              }}
            >
              Вставить приглашение
            </button>
          </div>
        )}

        {showFocusedCommunityCard && (focusedCommunity ? (
          <div className="communities-focus-card">
            <div className={`communities-focus-hint${isFocusedCommunityHintOpen ? " is-open" : ""}`}>
              <button
                type="button"
                className="communities-focus-hint-trigger"
                aria-label={`Подробности сообщества ${focusedCommunity.name}`}
                aria-expanded={isFocusedCommunityHintOpen}
                onClick={() => setIsFocusedCommunityHintOpen((current) => !current)}
              >
                ?
              </button>
              <div className="communities-focus-hint-popover" role="tooltip">
                <div className="communities-focus-hint-section">
                  <span className="communities-focus-hint-label">Описание</span>
                  <strong>{focusedCommunity.description}</strong>
                </div>
                {focusedCommunity.focusTags.length > 0 ? (
                  <div className="communities-focus-hint-section">
                    <span className="communities-focus-hint-label">Теги</span>
                    <div className="communities-focus-hint-tags">
                      {focusedCommunity.focusTags.map((tag) => (
                        <span key={`${focusedCommunity.id}-hint-${tag}`} className="communities-focus-hint-tag">
                          {tag}
                        </span>
                      ))}
                    </div>
                  </div>
                ) : null}
                <div className="communities-focus-hint-section">
                  <span className="communities-focus-hint-label">Формат входа</span>
                  <strong>{getCommunityJoinRuleLabel(focusedCommunity.joinRule)}</strong>
                </div>
                <div className="communities-focus-hint-section">
                  <span className="communities-focus-hint-label">Правила</span>
                  <strong>{focusedCommunity.rules}</strong>
                </div>
              </div>
            </div>

            <button
              type="button"
              className={`communities-focus-summary${
                isCommunityAccessible(focusedCommunity, profileId, profilePhone)
                  ? " is-clickable"
                  : ""
              }`}
              onClick={() => handleFocusedCommunityInfoClick(focusedCommunity)}
              aria-label={
                isCommunityAccessible(focusedCommunity, profileId, profilePhone)
                  ? `Открыть сообщество ${focusedCommunity.name}`
                  : `Сообщество ${focusedCommunity.name} доступно только по приглашению`
              }
            >
              <div className="communities-focus-head">
                <div className="communities-focus-logo">
                  {renderNodeFace(focusedCommunity, true)}
                  {focusedCommunity.isVerified ? (
                    <CommunityVerifiedBadge size="md" className="communities-focus-verified-badge" />
                  ) : null}
                </div>
                <div className="communities-focus-copy">
                  <div className="communities-focus-title-row">
                    <h3 className="communities-focus-title">{focusedCommunity.name}</h3>
                    <span className={`communities-type-pill communities-type-pill--${focusedCommunity.visibility.toLowerCase()}`}>
                      {focusedCommunity.visibility === "OPEN" ? "Открытое" : "Закрытое"}
                    </span>
                  </div>
                  <div className="communities-focus-meta">
                    {focusedCommunity.city} • {focusedCommunity.memberCount} участников • вход от {focusedCommunity.minimumLevel}
                  </div>
                </div>
              </div>
            </button>

            {(focusedCommunity.visibility === "OPEN" && !isCommunityMember(focusedCommunity, profileId, profilePhone))
            || !isCommunityAccessible(focusedCommunity, profileId, profilePhone) ? (
              <div className="communities-focus-actions">
                {focusedCommunity.visibility === "OPEN" && !isCommunityMember(focusedCommunity, profileId, profilePhone) ? (
                <button
                  className="section-cta"
                  type="button"
                  onClick={() => void handleJoinOpenCommunity(focusedCommunity)}
                  disabled={joiningCommunityId === focusedCommunity.id}
                >
                  {focusedCommunity.joinRule === "MODERATED"
                    ? "Отправить заявку"
                    : joiningCommunityId === focusedCommunity.id
                      ? "Подключаем..."
                      : "Вступить"}
                  </button>
                ) : (
                  <button
                    className="section-cta"
                    type="button"
                    onClick={() => {
                      setInviteError(null);
                      setInviteValue("");
                      setIsInviteOpen(true);
                    }}
                  >
                    Войти по ссылке
                  </button>
                )}
              </div>
            ) : null}
          </div>
        ) : (
          <div className="communities-focus-card communities-empty-card">
            <div className="communities-empty-copy">
              Пока нет ни одного сообщества в базе. Центральный серый круг создает новое сообщество, а закрытые сообщества можно будет открыть по инвайт-ссылке.
            </div>
          </div>
        ))}
      </div>

      <Modal isOpen={isCreateOpen} onClose={() => setIsCreateOpen(false)} title="Создать сообщество">
        <form className="community-form" onSubmit={(event) => void handleCreateCommunity(event)}>
          <div className="community-form-intro">
            При создании сообщество и рейтинг сразу сохраняются в базе, а лента стартует пустой.
          </div>

          {formError && <div className="community-form-error">{formError}</div>}

          <div className="community-form-logo-row">
            <div className="community-form-logo-preview">
              {getCommunityFormLogoPreview(formState)
                ? <img src={getCommunityFormLogoPreview(formState) ?? undefined} alt="Логотип сообщества" className="community-form-logo-image" />
                : <span>Лого</span>}
            </div>
            <div className="community-form-logo-copy">
              <label className="form-label" htmlFor="community-logo">Логотип сообщества</label>
              <input
                id="community-logo"
                className="img-form-input"
                type="file"
                accept="image/*"
                onChange={(event) => void handleCreateLogoChange(event)}
              />
              <label htmlFor="community-logo" className="section-link section-link--bold">Загрузить файл</label>
            </div>
          </div>

          <div className="form-group">
            <label className="form-label">Название</label>
            <input
              className="form-input"
              value={formState.name}
              onChange={(event) => setFormState((current) => ({ ...current, name: event.target.value }))}
              placeholder="Например, Weekend Mix"
            />
          </div>

          <div className="community-form-grid">
            <div className="form-group">
              <label className="form-label">Тип</label>
              <select
                className="form-input"
                value={formState.visibility}
                onChange={(event) => setFormState((current) => ({
                  ...current,
                  visibility: event.target.value as CommunityVisibility,
                  joinRule: event.target.value === "CLOSED" ? "INVITE_ONLY" : current.joinRule,
                }))}
              >
                <option value="OPEN">Открытое</option>
                <option value="CLOSED">Закрытое</option>
              </select>
            </div>

            <div className="form-group">
              <label className="form-label">Город</label>
              <input
                className="form-input"
                value={formState.city}
                onChange={(event) => setFormState((current) => ({ ...current, city: event.target.value }))}
              />
            </div>
          </div>

          <div className="community-form-grid">
            <div className="form-group">
              <label className="form-label">Минимальный уровень</label>
              <select
                className="form-input"
                value={formState.minimumLevel}
                onChange={(event) => setFormState((current) => ({ ...current, minimumLevel: event.target.value }))}
              >
                {LEVEL_OPTIONS.map((level) => (
                  <option key={level} value={level}>{level}</option>
                ))}
              </select>
            </div>

            <div className="form-group">
              <label className="form-label">Формат вступления</label>
              <select
                className="form-input"
                value={formState.visibility === "CLOSED" ? "INVITE_ONLY" : formState.joinRule}
                onChange={(event) => setFormState((current) => ({
                  ...current,
                  joinRule: event.target.value as CommunityJoinRule,
                }))}
                disabled={formState.visibility === "CLOSED"}
              >
                <option value="INSTANT">Сразу</option>
                <option value="MODERATED">После модерации</option>
                <option value="INVITE_ONLY">Только по приглашению</option>
              </select>
            </div>
          </div>

          <div className="form-group">
            <label className="form-label">Описание</label>
            <textarea
              className="form-input form-input-textarea"
              value={formState.description}
              onChange={(event) => setFormState((current) => ({ ...current, description: event.target.value }))}
              placeholder="Кто внутри, как часто играют и какой формат общения внутри сообщества."
            />
          </div>

          <div className="form-group">
            <label className="form-label">Фокус и теги</label>
            <input
              className="form-input"
              value={formState.focusTags}
              onChange={(event) => setFormState((current) => ({ ...current, focusTags: event.target.value }))}
              placeholder="Утро, миксы, спарринг, турнирная команда"
            />
          </div>

          <div className="form-group">
            <label className="form-label">Правила сообщества</label>
            <textarea
              className="form-input form-input-textarea"
              value={formState.rules}
              onChange={(event) => setFormState((current) => ({ ...current, rules: event.target.value }))}
              placeholder="Например: подтверждать участие не позднее чем за 6 часов."
            />
          </div>

          <div className="form-actions">
            <button type="button" className="btn-secondary" onClick={() => setIsCreateOpen(false)}>
              Отмена
            </button>
            <button type="submit" className="btn-primary" disabled={creatingCommunity}>
              {creatingCommunity ? "Создаем..." : "Создать"}
            </button>
          </div>
        </form>
      </Modal>

      <Modal isOpen={isInviteOpen} onClose={() => setIsInviteOpen(false)} title="Войти по приглашению">
        <form className="community-form" onSubmit={(event) => void handleInviteSubmit(event)}>
          <div className="community-form-intro">
            Для закрытых сообществ нужен инвайт. Вставь полную ссылку или только код приглашения.
          </div>

          {inviteError && <div className="community-form-error">{inviteError}</div>}

          <div className="form-group">
            <label className="form-label">Ссылка или код</label>
            <input
              className="form-input"
              value={inviteValue}
              onChange={(event) => setInviteValue(event.target.value)}
              placeholder="https://padlhub.ru/community_join?invite=..."
            />
          </div>

          <div className="form-actions">
            <button type="button" className="btn-secondary" onClick={() => setIsInviteOpen(false)}>
              Отмена
            </button>
            <button type="submit" className="btn-primary" disabled={inviteSubmitting}>
              {inviteSubmitting ? "Проверяем..." : "Войти"}
            </button>
          </div>
        </form>
      </Modal>

      <Modal
        isOpen={isCommunityActionsOpen}
        onClose={() => {
          setIsCommunityActionsOpen(false);
          setCommunityActionError(null);
        }}
        title={selectedCommunity ? `Действия: ${selectedCommunity.name}` : "Действия"}
      >
        <div className="community-actions-sheet">
          <div className="community-form-intro">
            Выберите действие для сообщества.
          </div>

          {communityActionError && <div className="community-form-error">{communityActionError}</div>}

          <button
            type="button"
            className="community-actions-sheet-button community-actions-sheet-button--danger"
            onClick={() => {
              setCommunityActionError(null);
              setIsCommunityActionsOpen(false);
              setIsCommunityLeaveConfirmOpen(true);
            }}
            disabled={!canLeaveSelectedCommunity}
          >
            Покинуть сообщество
          </button>

          {!canLeaveSelectedCommunity && (
            <div className="community-actions-sheet-note">
              Покинуть сообщество можно после вступления.
            </div>
          )}

          <button
            type="button"
            className="community-actions-sheet-button"
            onClick={handleOpenCommunityReport}
          >
            Пожаловаться
          </button>
        </div>
      </Modal>

      <Modal
        isOpen={isCommunityLeaveConfirmOpen}
        onClose={() => {
          if (communityLeaveSubmitting) return;
          setIsCommunityLeaveConfirmOpen(false);
          setCommunityActionError(null);
        }}
        title="Покинуть сообщество"
      >
        <div className="community-actions-confirm">
          <div className="community-form-intro">
            {selectedCommunity
              ? `Точно выйти из сообщества «${selectedCommunity.name}»?`
              : "Точно выйти из сообщества?"}
          </div>

          {communityActionError && <div className="community-form-error">{communityActionError}</div>}

          <div className="form-actions">
            <button
              type="button"
              className="btn-secondary"
              onClick={() => {
                setIsCommunityLeaveConfirmOpen(false);
                setCommunityActionError(null);
              }}
              disabled={communityLeaveSubmitting}
            >
              Отмена
            </button>
            <button
              type="button"
              className="btn-primary community-actions-confirm-button--danger"
              onClick={() => {
                void handleLeaveSelectedCommunity();
              }}
              disabled={communityLeaveSubmitting}
            >
              {communityLeaveSubmitting ? "Выходим..." : "Покинуть"}
            </button>
          </div>
        </div>
      </Modal>

      <Modal
        isOpen={isCommunityReportOpen}
        onClose={() => {
          if (communityReportSubmitting) return;
          setIsCommunityReportOpen(false);
          setCommunityReportError(null);
        }}
        title="Пожаловаться"
      >
        <form className="community-actions-report" onSubmit={(event) => void handleSubmitCommunityReport(event)}>
          <div className="community-form-intro">
            Опишите причину жалобы. Сообщение уйдёт в поддержку вместе с данными сообщества.
          </div>

          {communityReportError && <div className="community-form-error">{communityReportError}</div>}

          <div className="form-group">
            <label className="form-label" htmlFor="community-report-text">
              Текст жалобы
            </label>
            <textarea
              id="community-report-text"
              className="form-input form-input-textarea community-report-textarea"
              value={communityReportText}
              onChange={(event) => setCommunityReportText(event.target.value)}
              placeholder="Например: публикуют спам, оскорбления или вводят участников в заблуждение."
            />
          </div>

          <div className="form-actions">
            <button
              type="button"
              className="btn-secondary"
              onClick={() => {
                setIsCommunityReportOpen(false);
                setCommunityReportError(null);
              }}
              disabled={communityReportSubmitting}
            >
              Отмена
            </button>
            <button
              type="submit"
              className="btn-primary"
              disabled={communityReportSubmitting || !communityReportText.trim()}
            >
              {communityReportSubmitting ? "Отправляем..." : "Отправить"}
            </button>
          </div>
        </form>
      </Modal>

      <Modal
        isOpen={Boolean(selectedCommunity)}
        onClose={() => setSelectedCommunityId(null)}
        title={selectedCommunity?.name ?? "Сообщество"}
        variant="fullscreen"
        hideHeader={
          activeCommunityTab === "FEED"
          || activeCommunityTab === "CHAT"
          || activeCommunityTab === "RANKING"
        }
        bodyClassName={
          activeCommunityTab === "FEED"
          || activeCommunityTab === "CHAT"
          || activeCommunityTab === "RANKING"
            ? "modal-body--community-feed"
            : undefined
        }
      >
        {selectedCommunity && (
          <div className="community-detail">
            {activeCommunityTab !== "FEED" && activeCommunityTab !== "CHAT" && activeCommunityTab !== "RANKING" && (
              <>
                <div className="community-detail-head">
                  <div className="community-detail-logo">
                    {renderNodeFace(selectedCommunity)}
                    {selectedCommunity.isVerified ? (
                      <CommunityVerifiedBadge size="md" className="community-detail-verified-badge" />
                    ) : null}
                  </div>
                  <div className="community-detail-copy">
                    <div className="communities-focus-title-row">
                      <div className="community-detail-type">
                        <span className={`communities-type-pill communities-type-pill--${selectedCommunity.visibility.toLowerCase()}`}>
                          {selectedCommunity.visibility === "OPEN" ? "Открытое" : "Закрытое"}
                        </span>
                        <span className="community-detail-created">с {formatCommunityDate(selectedCommunity.createdAt)}</span>
                      </div>
                      <div className="community-detail-meta">
                        {selectedCommunity.city} • {selectedCommunity.memberCount} участников • вход от {selectedCommunity.minimumLevel}
                      </div>
                    </div>
                    <p className="communities-focus-description">{selectedCommunity.description}</p>
                  </div>
                </div>

                {!isCommunityMember(selectedCommunity, profileId, profilePhone) && selectedCommunity.visibility === "OPEN" && (
                  <button
                    className="section-cta"
                    type="button"
                    onClick={() => void handleJoinOpenCommunity(selectedCommunity)}
                    disabled={joiningCommunityId === selectedCommunity.id}
                    >
                      {selectedCommunity.joinRule === "MODERATED"
                        ? "Подать заявку в сообщество"
                        : joiningCommunityId === selectedCommunity.id
                          ? "Подключаем..."
                          : "Вступить в сообщество"}
                  </button>
                )}

                {detailError && (
                  <div className="community-form-error">{detailError}</div>
                )}

                <div className="community-detail-tabs" role="tablist" aria-label="Разделы сообщества">
                  {communityDetailTabs.map((tab) => (
                    <button
                      key={tab.id}
                      type="button"
                      role="tab"
                      aria-selected={activeCommunityTab === tab.id}
                      className={`community-detail-tab${activeCommunityTab === tab.id ? " is-active" : ""}${tab.id === "SETTINGS" ? " is-icon" : ""}`}
                      onClick={() => setActiveCommunityTab(tab.id)}
                    >
                      {tab.id === "SETTINGS" ? (
                        <>
                          <svg viewBox="0 0 24 24" aria-hidden="true" className="community-detail-tab-icon">
                            <path
                              d="M10.25 2.75h3.5l.55 2.28c.54.18 1.05.39 1.54.66l2.05-1.14 2.47 2.47-1.14 2.05c.27.49.48 1 .66 1.54l2.28.55v3.5l-2.28.55a7.7 7.7 0 0 1-.66 1.54l1.14 2.05-2.47 2.47-2.05-1.14c-.49.27-1 .48-1.54.66l-.55 2.28h-3.5l-.55-2.28a7.7 7.7 0 0 1-1.54-.66l-2.05 1.14-2.47-2.47 1.14-2.05a7.7 7.7 0 0 1-.66-1.54l-2.28-.55v-3.5l2.28-.55c.18-.54.39-1.05.66-1.54L3.44 7.02l2.47-2.47 2.05 1.14c.49-.27 1-.48 1.54-.66zM12 8.75A3.25 3.25 0 1 0 12 15.25A3.25 3.25 0 1 0 12 8.75z"
                              fill="currentColor"
                            />
                          </svg>
                          <span className="community-visually-hidden">{tab.label}</span>
                        </>
                      ) : (
                        tab.label
                      )}
                    </button>
                  ))}
                </div>
              </>
            )}

            {activeCommunityTab === "FEED" && (
              <>
                {detailError && (
                  <div className="community-form-error">{detailError}</div>
                )}

                {!isCommunityMember(selectedCommunity, profileId, profilePhone) && selectedCommunity.visibility === "OPEN" && (
                  <button
                    className="section-cta"
                    type="button"
                    onClick={() => void handleJoinOpenCommunity(selectedCommunity)}
                    disabled={joiningCommunityId === selectedCommunity.id}
                    >
                      {selectedCommunity.joinRule === "MODERATED"
                        ? "Подать заявку в сообщество"
                        : joiningCommunityId === selectedCommunity.id
                          ? "Подключаем..."
                          : "Вступить в сообщество"}
                  </button>
                )}

                <CommunityScreen
                  community={selectedCommunity}
                  entries={currentFeedEntries}
                  isLoading={detailLoadingId === selectedCommunity.id && currentFeed.length === 0}
                  hasMore={currentFeedHasMore}
                  isLoadingMore={isCurrentFeedLoadingMore}
                  canCreate={canPostInSelectedCommunity && !isFeedComposerOpen}
                  chatBadgeCount={currentChatUnreadBadgeCount}
                  onOpenGame={(game, entry) => {
                    void handlePlayCommunityGame(game, entry);
                  }}
                  onOpenGameChat={(game, entry) => {
                    const gameId = entry.relatedGameId ?? game.id;
                    if (gameId) {
                      onOpenGames({ gameId, openChat: true });
                      return;
                    }
                    onOpenGames();
                  }}
                  onOpenTournament={() => {
                    onOpenTournaments();
                  }}
                  onOpenNews={() => {}}
                  onLoadNewsThread={(news) => handleLoadNewsThread(news)}
                  onPersistNewsReaction={(news, reaction) => handlePersistNewsReaction(news, reaction)}
                  onPersistNewsComment={(news, text) => handlePersistNewsComment(news, text)}
                  onEditNews={(news) => handleEditCommunityNews(news)}
                  onOpenUser={(user) => {
                    setAccessMessage(`Профиль ${user.name} скоро появится.`);
                  }}
                  onAddFriend={(user) => {
                    setAccessMessage(`Добавление ${user.name} в друзья скоро появится.`);
                  }}
                  onMessageUser={(user) => {
                    setAccessMessage(`Личные сообщения для ${user.name} скоро появятся.`);
                  }}
                  onLoadMore={() => {
                    void handleLoadMoreFeed();
                  }}
                  onFabAction={handleFeedFabAction}
                  onInvitePlayers={() => {
                    void handleInvitePlayers();
                  }}
                  onOpenMenu={handleOpenCommunityHeaderMenu}
                  onClose={() => setSelectedCommunityId(null)}
                  onSelectSectionNav={handleSelectCommunitySectionNav}
                  onSelectBottomNav={handleSelectCommunityBottomNav}
                />
              </>
            )}

            {activeCommunityTab === "CHAT" && (
              <CommunityChatScreen
                community={selectedCommunity}
                messages={currentChatMessages}
                isLoading={isCurrentChatLoading && currentChatMessages.length === 0}
                hasMore={currentChatHasMore}
                isLoadingMore={isCurrentChatLoadingMore}
                isSending={isCurrentChatSending}
                error={chatError}
                draft={chatDraft}
                canSend={canChatInSelectedCommunity}
                unreadCount={currentChatUnreadCount}
                unreadBadgeCount={currentChatUnreadBadgeCount}
                currentUserId={profileId}
                currentUserPhone={profilePhone}
                scrollRef={chatScrollRef}
                onScroll={handleCommunityChatScroll}
                onDraftChange={(value) => {
                  setChatDraft(value);
                  if (chatError) setChatError(null);
                }}
                onSubmit={handleSendChatMessage}
                onOpenMenu={handleOpenCommunityHeaderMenu}
                onClose={() => setSelectedCommunityId(null)}
                onSelectSectionNav={handleSelectCommunitySectionNav}
                onSelectBottomNav={handleSelectCommunityBottomNav}
                navActionSlot={canPostInSelectedCommunity && !isFeedComposerOpen ? (
                  <CommunityFab
                    variant="nav"
                    onAddPost={() => handleFeedFabAction("news")}
                    onScheduleGame={() => handleFeedFabAction("game")}
                    onInvitePlayers={() => {
                      void handleInvitePlayers();
                    }}
                  />
                ) : null}
                joinActionLabel={
                  !canChatInSelectedCommunity && selectedCommunity.visibility === "OPEN"
                    ? (selectedCommunity.joinRule === "MODERATED"
                      ? "Подать заявку в сообщество"
                      : joiningCommunityId === selectedCommunity.id
                        ? "Подключаем..."
                        : "Вступить в сообщество")
                    : null
                }
                isJoinActionLoading={joiningCommunityId === selectedCommunity.id}
                onJoinAction={
                  !canChatInSelectedCommunity && selectedCommunity.visibility === "OPEN"
                    ? () => {
                      void handleJoinOpenCommunity(selectedCommunity);
                    }
                    : null
                }
              />
            )}

            {activeCommunityTab === "RANKING" && (
              <CommunityRankingScreen
                community={selectedCommunity}
                rows={currentRankingRows}
                currentUserRow={currentPerformanceRow}
                activePeriod={activeRankingPeriod}
                gamesCount={currentRankingGamesCount}
                chatBadgeCount={currentChatUnreadBadgeCount}
                isLoading={isCurrentRankingLoading}
                error={rankingRefreshError}
                currentUserId={profileId}
                currentUserPhone={profilePhone}
                onChangePeriod={setActiveRankingPeriod}
                onOpenMenu={handleOpenCommunityHeaderMenu}
                onClose={() => setSelectedCommunityId(null)}
                onSelectSectionNav={handleSelectCommunitySectionNav}
                onSelectBottomNav={handleSelectCommunityBottomNav}
                navActionSlot={canPostInSelectedCommunity && !isFeedComposerOpen ? (
                  <CommunityFab
                    variant="nav"
                    onAddPost={() => handleFeedFabAction("news")}
                    onScheduleGame={() => handleFeedFabAction("game")}
                    onInvitePlayers={() => {
                      void handleInvitePlayers();
                    }}
                  />
                ) : null}
              />
            )}

            {activeCommunityTab === "TABLE" && (
              <CommunityTableScreen
                community={selectedCommunity}
                members={settingsMembers}
                currentUserId={profileId}
                currentUserPhone={profilePhone}
                chatBadgeCount={currentChatUnreadBadgeCount}
                onOpenMenu={handleOpenCommunityHeaderMenu}
                onClose={() => setSelectedCommunityId(null)}
                onSelectBottomNav={handleSelectCommunityBottomNav}
                navActionSlot={canPostInSelectedCommunity && !isFeedComposerOpen ? (
                  <CommunityFab
                    variant="nav"
                    onAddPost={() => handleFeedFabAction("news")}
                    onScheduleGame={() => handleFeedFabAction("game")}
                    onInvitePlayers={() => {
                      void handleInvitePlayers();
                    }}
                  />
                ) : null}
              />
            )}

            {activeCommunityTab === "SETTINGS" && canManageSelectedCommunity && (
              <section className="community-detail-section">
                <div className="community-detail-section-head">
                  <h3 className="community-detail-section-title">Настройки сообщества</h3>
                  <span className="community-detail-section-caption">Доступно админу сообщества</span>
                </div>
                <div className="community-settings-head">
                  <div className="community-detail-section-caption">
                    Можно менять параметры сообщества и управлять участниками без выхода из карточки.
                  </div>
                  {!editingCommunity && (
                    <button
                      type="button"
                      className="section-link section-link--bold"
                      onClick={() => {
                        setEditFormState(buildCommunityFormStateFromRecord(selectedCommunity));
                        setEditFormError(null);
                        setEditingCommunity(true);
                      }}
                    >
                      Редактировать
                    </button>
                  )}
                </div>

                {editingCommunity ? (
                  <form className="community-form community-settings-form" onSubmit={(event) => void handleUpdateCommunity(event)}>
                    {editFormError && <div className="community-form-error">{editFormError}</div>}

                    <div className="community-form-logo-row">
                      <div className="community-form-logo-preview">
                        {getCommunityFormLogoPreview(editFormState)
                          ? <img src={getCommunityFormLogoPreview(editFormState) ?? undefined} alt="Логотип сообщества" className="community-form-logo-image" />
                          : <span>Лого</span>}
                      </div>
                      <div className="community-form-logo-copy">
                        <label className="form-label" htmlFor="community-edit-logo">Логотип сообщества</label>
                        <input
                          id="community-edit-logo"
                          className="img-form-input"
                          type="file"
                          accept="image/*"
                          onChange={(event) => void handleEditLogoChange(event)}
                        />
                        <label htmlFor="community-edit-logo" className="section-link section-link--bold">Загрузить файл</label>
                      </div>
                    </div>

                    <div className="form-group">
                      <label className="form-label">Название</label>
                      <input
                        className="form-input"
                        value={editFormState.name}
                        onChange={(event) => setEditFormState((current) => ({ ...current, name: event.target.value }))}
                      />
                    </div>

                    <div className="community-form-grid">
                      <div className="form-group">
                        <label className="form-label">Тип</label>
                        <select
                          className="form-input"
                          value={editFormState.visibility}
                          onChange={(event) => setEditFormState((current) => ({
                            ...current,
                            visibility: event.target.value as CommunityVisibility,
                            joinRule: event.target.value === "CLOSED" ? "INVITE_ONLY" : current.joinRule,
                          }))}
                        >
                          <option value="OPEN">Открытое</option>
                          <option value="CLOSED">Закрытое</option>
                        </select>
                      </div>

                      <div className="form-group">
                        <label className="form-label">Город</label>
                        <input
                          className="form-input"
                          value={editFormState.city}
                          onChange={(event) => setEditFormState((current) => ({ ...current, city: event.target.value }))}
                        />
                      </div>
                    </div>

                    <div className="community-form-grid">
                      <div className="form-group">
                        <label className="form-label">Минимальный уровень</label>
                        <select
                          className="form-input"
                          value={editFormState.minimumLevel}
                          onChange={(event) => setEditFormState((current) => ({ ...current, minimumLevel: event.target.value }))}
                        >
                          {LEVEL_OPTIONS.map((level) => (
                            <option key={level} value={level}>{level}</option>
                          ))}
                        </select>
                      </div>

                      <div className="form-group">
                        <label className="form-label">Формат вступления</label>
                        <select
                          className="form-input"
                          value={editFormState.visibility === "CLOSED" ? "INVITE_ONLY" : editFormState.joinRule}
                          onChange={(event) => setEditFormState((current) => ({
                            ...current,
                            joinRule: event.target.value as CommunityJoinRule,
                          }))}
                          disabled={editFormState.visibility === "CLOSED"}
                        >
                          <option value="INSTANT">Сразу</option>
                          <option value="MODERATED">После модерации</option>
                          <option value="INVITE_ONLY">Только по приглашению</option>
                        </select>
                      </div>
                    </div>

                    <div className="form-group">
                      <label className="form-label">Описание</label>
                      <textarea
                        className="form-input form-input-textarea"
                        value={editFormState.description}
                        onChange={(event) => setEditFormState((current) => ({ ...current, description: event.target.value }))}
                      />
                    </div>

                    <div className="form-group">
                      <label className="form-label">Фокус и теги</label>
                      <input
                        className="form-input"
                        value={editFormState.focusTags}
                        onChange={(event) => setEditFormState((current) => ({ ...current, focusTags: event.target.value }))}
                      />
                    </div>

                    <div className="form-group">
                      <label className="form-label">Правила сообщества</label>
                      <textarea
                        className="form-input form-input-textarea"
                        value={editFormState.rules}
                        onChange={(event) => setEditFormState((current) => ({ ...current, rules: event.target.value }))}
                      />
                    </div>

                    <div className="form-actions">
                      <button
                        type="button"
                        className="btn-secondary"
                        onClick={() => {
                          setEditFormState(buildCommunityFormStateFromRecord(selectedCommunity));
                          setEditFormError(null);
                          setEditingCommunity(false);
                        }}
                      >
                        Отмена
                      </button>
                      <button type="submit" className="btn-primary" disabled={editSubmitting}>
                        {editSubmitting ? "Сохраняем..." : "Сохранить"}
                      </button>
                    </div>
                  </form>
                ) : (
                  <div className="community-params">
                    <div className="community-param-row"><span>Твоя роль</span><strong>{selectedCommunityMember?.role === "OWNER" ? "Владелец" : "Администратор"}</strong></div>
                    <div className="community-param-row"><span>Город</span><strong>{selectedCommunity.city}</strong></div>
                    <div className="community-param-row"><span>Участников</span><strong>{selectedCommunity.memberCount}</strong></div>
                    <div className="community-param-row">
                      <span>Формат вступления</span>
                      <strong>
                        {selectedCommunity.joinRule === "INSTANT"
                          ? "Сразу"
                          : selectedCommunity.joinRule === "MODERATED"
                            ? "После модерации"
                            : "Только по приглашению"}
                      </strong>
                    </div>
                    <div className="community-param-row"><span>Минимальный уровень</span><strong>{selectedCommunity.minimumLevel}</strong></div>
                    <div className="community-param-row"><span>Правила</span><strong>{selectedCommunity.rules}</strong></div>
                    {selectedCommunity.focusTags.length > 0 && (
                      <div className="community-param-row"><span>Фокус</span><strong>{selectedCommunity.focusTags.join(", ")}</strong></div>
                    )}
                    {selectedCommunity.inviteLink && (
                      <div className="community-param-row"><span>Ссылка-приглашение</span><strong className="community-param-link">{selectedCommunity.inviteLink}</strong></div>
                    )}
                  </div>
                )}

                {manageableCommunities.length > 1 && (
                  <div className="community-sort-panel">
                    <div className="community-settings-members-head community-settings-members-head--sort">
                      <div>
                        <h4 className="community-detail-section-title">Порядок кружков</h4>
                        <div className="community-detail-section-caption">
                          Влияет на ленту сообществ под шапкой профиля.
                        </div>
                      </div>
                    </div>

                    <div className="community-sort-list">
                      {communities.map((community, index) => {
                        const isSelected = community.id === selectedCommunity.id;
                        return (
                          <div key={`sort-${community.id}`} className={`community-sort-row${isSelected ? " is-current" : ""}`}>
                            <div className="community-sort-main">
                              <div className="community-sort-preview">
                                {renderNodeFace(community, true)}
                                {community.isVerified ? (
                                  <CommunityVerifiedBadge size="sm" className="community-sort-verified-badge" />
                                ) : null}
                              </div>
                              <div className="community-sort-copy">
                                <div className="community-sort-name">{community.name}</div>
                                <div className="community-sort-meta">
                                  #{index + 1} • {community.memberCount} участников
                                </div>
                              </div>
                            </div>

                            <div className="community-sort-actions">
                              <button
                                type="button"
                                className="community-sort-action"
                                onClick={() => handleMoveCommunity(community.id, -1)}
                                disabled={index === 0}
                                aria-label={`Поднять ${community.name}`}
                              >
                                ↑
                              </button>
                              <button
                                type="button"
                                className="community-sort-action"
                                onClick={() => handleMoveCommunity(community.id, 1)}
                                disabled={index === communities.length - 1}
                                aria-label={`Опустить ${community.name}`}
                              >
                                ↓
                              </button>
                            </div>
                          </div>
                        );
                      })}
                    </div>
                  </div>
                )}

                <div className="community-settings-members-head">
                  <div>
                    <h4 className="community-detail-section-title">Участники</h4>
                    <div className="community-detail-section-caption">Удаление исключает из сообщества, бан запрещает повторное вступление.</div>
                  </div>
                  <span className="community-members-count">{settingsMembers.length}</span>
                </div>

                {memberActionError && <div className="community-form-error">{memberActionError}</div>}

                <div className="community-members-list">
                  {settingsMembers.map((member) => {
                    const memberKey = member.id ?? member.phone ?? member.name;
                    const canManageMember = canManageCommunityMember(
                      selectedCommunityMember?.role,
                      member,
                      profileId,
                      profilePhone,
                    );
                    const isCurrentUser =
                      (member.id && member.id === profileId)
                      || Boolean(profilePhone && member.phone && member.phone === profilePhone);
                    const pendingRemove = managingMemberKey === `REMOVE:${memberKey}`;
                    const pendingBan = managingMemberKey === `BAN:${memberKey}`;

                    return (
                      <div key={`${selectedCommunity.id}-${memberKey}`} className="community-member-row">
                        <div className="community-member-main">
                          <div className="community-member-avatar">
                            {member.avatar
                              ? <img src={member.avatar} alt={member.name} className="community-ranking-avatar-image" />
                              : getInitials(member.name)}
                          </div>
                          <div className="community-member-copy">
                            <div className="community-member-name-row">
                              <span className="community-member-name">{member.name}</span>
                              {isCurrentUser && <span className="community-ranking-you">Вы</span>}
                            </div>
                            <div className="community-member-meta">
                              {member.levelLabel} • {formatScoreDisplay(member.levelScore)} • {getCommunityRoleLabel(member.role)}
                            </div>
                          </div>
                        </div>

                        {canManageMember ? (
                          <div className="community-member-actions">
                            <button
                              type="button"
                              className="community-member-action"
                              onClick={() => void handleManageCommunityMember(member, "REMOVE")}
                              disabled={Boolean(managingMemberKey)}
                            >
                              {pendingRemove ? "Удаляем..." : "Удалить"}
                            </button>
                            <button
                              type="button"
                              className="community-member-action danger"
                              onClick={() => void handleManageCommunityMember(member, "BAN")}
                              disabled={Boolean(managingMemberKey)}
                            >
                              {pendingBan ? "Баним..." : "В бан"}
                            </button>
                          </div>
                        ) : (
                          <div className="community-member-role-tag">{member.role === "OWNER" ? "OWNER" : member.role}</div>
                        )}
                      </div>
                    );
                  })}
                </div>
              </section>
            )}

          </div>
        )}
      </Modal>

      <Modal
        isOpen={Boolean(selectedCommunity) && isFeedComposerOpen}
        onClose={() => {
          setIsFeedComposerOpen(false);
          resetFeedComposer();
        }}
        title={editingFeedPostId ? "Редактировать пост" : "Новый пост"}
      >
        {selectedCommunity && (
          <form className="community-composer" onSubmit={(event) => void handleCreateFeedPost(event)}>
            <div className="community-detail-section-head">
              <h3 className="community-detail-section-title">
                {editingFeedPostId ? "Редактирование публикации" : "Публикация в ленту"}
              </h3>
              <span className="community-detail-section-caption">
                {editingFeedPostId ? "Изменения сохранятся в текущей новости" : "Сразу уходит в базу"}
              </span>
            </div>

            {feedFormError && <div className="community-form-error">{feedFormError}</div>}

            <div className="community-form-grid">
              <div className="form-group">
                <label className="form-label">Тип поста</label>
                <select
                  className="form-input"
                  value={feedFormState.kind}
                  onChange={(event) => handleFeedKindChange(event.target.value as FeedFormState["kind"])}
                  disabled={Boolean(editingFeedPostId)}
                >
                  <option value="PHOTO">Новость</option>
                  <option value="GAME">Игра</option>
                  {canCreateTournamentPostInSelectedCommunity && (
                    <option value="TOURNAMENT">Турнир</option>
                  )}
                </select>
              </div>

              {feedFormState.kind === "GAME" && (
                <div className="form-group">
                  <label className="form-label">Игра</label>
                  <select
                    className="form-input"
                    value={feedFormState.relatedGameId}
                    onChange={(event) => handleFeedGameChange(event.target.value)}
                    disabled={upcomingCreatedGames.length === 0}
                  >
                    <option value="">
                      {upcomingCreatedGames.length === 0 ? "Нет предстоящих игр" : "Выбери игру"}
                    </option>
                    {upcomingCreatedGames.map((game) => (
                      <option key={game.id} value={game.id}>
                        {formatGameOption(game)}
                      </option>
                    ))}
                  </select>
                </div>
              )}

              {feedFormState.kind === "TOURNAMENT" && (
                <div className="form-group">
                  <label className="form-label">Турнир</label>
                  <select
                    className="form-input"
                    value={feedFormState.relatedTournamentId}
                    onChange={(event) => handleFeedTournamentChange(event.target.value)}
                    disabled={feedTournamentOptionsLoading || feedTournamentOptions.length === 0}
                  >
                    <option value="">
                      {feedTournamentOptionsLoading
                        ? "Загружаем доступные турниры"
                        : feedTournamentOptions.length === 0
                          ? "Нет доступных турниров"
                          : "Выбери турнир"}
                    </option>
                    {feedTournamentOptions.map((option) => (
                      <option key={option.tournament.id} value={option.tournament.id}>
                        {formatTournamentOption(option)}
                      </option>
                    ))}
                  </select>
                  {feedTournamentOptionsError && (
                    <div className="community-form-error">{feedTournamentOptionsError}</div>
                  )}
                  {!feedTournamentOptionsLoading
                    && !feedTournamentOptionsError
                    && feedTournamentOptions.length === 0 && (
                      <div className="community-loading-note">
                        Не нашли доступных турниров, где ты записан как участник или назначен исполнителем.
                      </div>
                  )}
                </div>
              )}
            </div>

            <div className="form-group">
              <label className="form-label">Заголовок</label>
              <input
                className="form-input"
                value={feedFormState.title}
                onChange={(event) => setFeedFormState((current) => ({ ...current, title: event.target.value }))}
                placeholder="Например, Собираем четверку на вечер"
              />
            </div>

            <div className="form-group">
              <label className="form-label">Описание</label>
              <textarea
                className="form-input form-input-textarea"
                value={feedFormState.body}
                onChange={(event) => setFeedFormState((current) => ({ ...current, body: event.target.value }))}
                placeholder="Что происходит, когда играем и что нужно участникам."
              />
            </div>

            <div className="community-form-grid">
              <div className="form-group">
                <label className="form-label">Подпись превью</label>
                <input
                  className="form-input"
                  value={feedFormState.previewLabel}
                  onChange={(event) => setFeedFormState((current) => ({ ...current, previewLabel: event.target.value }))}
                  placeholder="Например, Матч сообщества"
                />
              </div>

              <div className="form-group">
                <label className="form-label" htmlFor="community-post-image">Добавить фото</label>
                <input
                  id="community-post-image"
                  className="img-form-input"
                  type="file"
                  accept="image/*"
                  onChange={(event) => void handleFeedImageChange(event)}
                />
                <label
                  className={`community-feed-image-trigger${feedFormState.imageUrl ? " is-selected" : ""}`}
                  htmlFor="community-post-image"
                >
                  <span className="community-feed-image-trigger-icon" aria-hidden="true">
                    {feedFormState.imageUrl ? "✓" : "+"}
                  </span>
                  <span className="community-feed-image-trigger-copy">
                    <span className="community-feed-image-trigger-title">
                      {feedFormState.imageUrl ? "Фото выбрано" : "Добавить фото"}
                    </span>
                    <span className="community-feed-image-trigger-caption">
                      {feedFormState.imageUrl
                        ? "Нажми, чтобы заменить изображение для поста."
                        : "Нажми, чтобы выбрать изображение для поста."}
                    </span>
                  </span>
                </label>
              </div>
            </div>

            {feedFormState.kind === "PHOTO" && feedImageEditor.source && (
              <div className="community-news-image-editor">
                <div className="community-detail-section-head">
                  <h3 className="community-detail-section-title">Кадр новости</h3>
                  <span className="community-detail-section-caption">
                    Настрой видимую область под формат новой карточки новости
                  </span>
                </div>

                <div className="community-news-image-editor-layout">
                  <div
                    ref={newsImagePreviewRef}
                    className="community-news-image-preview"
                    style={{
                      width: `${COMMUNITY_NEWS_EDITOR_PREVIEW.width}px`,
                      height: `${COMMUNITY_NEWS_EDITOR_PREVIEW.height}px`,
                    }}
                    onTouchStart={isMobileTouchEditor ? handleFeedImageTouchStart : undefined}
                    onTouchMove={isMobileTouchEditor ? handleFeedImageTouchMove : undefined}
                    onTouchEnd={isMobileTouchEditor ? handleFeedImageTouchEnd : undefined}
                    onTouchCancel={isMobileTouchEditor ? handleFeedImageTouchEnd : undefined}
                  >
                    {feedImageNaturalSize && (
                      <img
                        src={feedImageEditor.source}
                        alt="Превью новости"
                        className="community-news-image-preview-media"
                        style={(() => {
                          const cover = buildCoverImageStyle(
                            feedImageNaturalSize.width,
                            feedImageNaturalSize.height,
                            COMMUNITY_NEWS_EDITOR_PREVIEW.width,
                            COMMUNITY_NEWS_EDITOR_PREVIEW.height,
                            feedImageEditor.zoom,
                            feedImageEditor.focalX,
                            feedImageEditor.focalY,
                          );
                          return {
                            width: `${cover.width}px`,
                            height: `${cover.height}px`,
                            left: `${cover.left}px`,
                            top: `${cover.top}px`,
                          };
                        })()}
                      />
                    )}
                  </div>

                  <div className="community-news-image-controls">
                    {isMobileTouchEditor ? (
                      <div className="community-news-image-touch-hint">
                        <span>Перетяни изображение одним пальцем, чтобы передвинуть кадр.</span>
                        <span>Растяни или сожми двумя пальцами, чтобы изменить масштаб.</span>
                      </div>
                    ) : (
                      <>
                        <label className="form-label" htmlFor="community-news-image-zoom">Масштаб</label>
                        <input
                          id="community-news-image-zoom"
                          type="range"
                          min="1"
                          max="2.6"
                          step="0.01"
                          value={feedImageEditor.zoom}
                          onChange={(event) => setFeedImageEditor((current) => ({
                            ...current,
                            zoom: Number.parseFloat(event.target.value) || 1,
                          }))}
                        />

                        <label className="form-label" htmlFor="community-news-image-x">Горизонталь</label>
                        <input
                          id="community-news-image-x"
                          type="range"
                          min="0"
                          max="100"
                          step="1"
                          value={feedImageEditor.focalX}
                          onChange={(event) => setFeedImageEditor((current) => ({
                            ...current,
                            focalX: Number.parseInt(event.target.value, 10) || 50,
                          }))}
                        />

                        <label className="form-label" htmlFor="community-news-image-y">Вертикаль</label>
                        <input
                          id="community-news-image-y"
                          type="range"
                          min="0"
                          max="100"
                          step="1"
                          value={feedImageEditor.focalY}
                          onChange={(event) => setFeedImageEditor((current) => ({
                            ...current,
                            focalY: Number.parseInt(event.target.value, 10) || 50,
                          }))}
                        />
                      </>
                    )}

                    <button
                      type="button"
                      className="btn-secondary"
                      onClick={() => setFeedImageEditor((current) => ({
                        ...current,
                        zoom: 1,
                        focalX: 50,
                        focalY: 50,
                      }))}
                    >
                      Сбросить кадр
                    </button>
                  </div>
                </div>
              </div>
            )}

            <div className="form-actions">
              <button
                type="button"
                className="btn-secondary"
                onClick={() => {
                  if (editingFeedPostId) {
                    setIsFeedComposerOpen(false);
                    resetFeedComposer();
                    return;
                  }

                  resetFeedComposer();
                }}
              >
                {editingFeedPostId ? "Отмена" : "Очистить"}
              </button>
              <button type="submit" className="btn-primary" disabled={feedSubmitting}>
                {feedSubmitting
                  ? editingFeedPostId
                    ? "Сохраняем..."
                    : "Публикуем..."
                  : editingFeedPostId
                    ? "Сохранить"
                    : "Опубликовать"}
              </button>
            </div>
          </form>
        )}
      </Modal>
    </>
  );
}
