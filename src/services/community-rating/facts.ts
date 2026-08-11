import {
  calculatePlaceScore,
  calculateTournamentRawScore,
  getPlaceBonus,
} from "./calculations.ts";
import { COMMUNITY_RATING_CALCULATION_VERSION } from "./contract.ts";

export const COMMUNITY_RATING_COLLECTIONS = {
  facts: "community_rating_facts",
  aggregates: "community_rating_player_aggregates",
  snapshots: "community_rating_snapshots",
} as const;

export interface CommunityRatingStorageIndex {
  collection: (typeof COMMUNITY_RATING_COLLECTIONS)[keyof typeof COMMUNITY_RATING_COLLECTIONS];
  name: string;
  key: Record<string, 1 | -1>;
  unique?: boolean;
}

export const COMMUNITY_RATING_STORAGE_INDEXES: readonly CommunityRatingStorageIndex[] = [
  {
    collection: COMMUNITY_RATING_COLLECTIONS.facts,
    name: "uniq_rating_fact_event_player_version",
    key: {
      communityId: 1,
      eventType: 1,
      eventId: 1,
      playerKey: 1,
      calculationVersion: 1,
    },
    unique: true,
  },
  {
    collection: COMMUNITY_RATING_COLLECTIONS.facts,
    name: "rating_facts_by_community_time",
    key: {
      communityId: 1,
      occurredAtTs: -1,
      eventType: 1,
    },
  },
  {
    collection: COMMUNITY_RATING_COLLECTIONS.facts,
    name: "rating_facts_by_player_time",
    key: {
      communityId: 1,
      playerKey: 1,
      occurredAtTs: -1,
    },
  },
  {
    collection: COMMUNITY_RATING_COLLECTIONS.aggregates,
    name: "uniq_rating_aggregate_player_period_version",
    key: {
      communityId: 1,
      period: 1,
      playerKey: 1,
      calculationVersion: 1,
    },
    unique: true,
  },
  {
    collection: COMMUNITY_RATING_COLLECTIONS.aggregates,
    name: "rating_aggregates_by_overall_score",
    key: {
      communityId: 1,
      period: 1,
      overallScore: -1,
      playerName: 1,
    },
  },
  {
    collection: COMMUNITY_RATING_COLLECTIONS.snapshots,
    name: "uniq_rating_snapshot_tab_period_version",
    key: {
      communityId: 1,
      period: 1,
      tab: 1,
      calculationVersion: 1,
    },
    unique: true,
  },
  {
    collection: COMMUNITY_RATING_COLLECTIONS.snapshots,
    name: "rating_snapshots_by_update_time",
    key: {
      communityId: 1,
      updatedAtTs: -1,
    },
  },
] as const;

export type CommunityRatingFactEventType = "game" | "tournament" | "visit";

export interface CommunityRatingGameFactMetrics {
  gamesPlayed: 1;
  gamesWon: 0 | 1;
  gamesLost: 0 | 1;
  setsWon: number;
  setsLost: number;
  gamesWonCount: number;
  gamesLostCount: number;
  gamesDiff: number;
  levelDelta: number;
}

export interface CommunityRatingTournamentFactMetrics {
  tournamentsPlayed: 1;
  participantsCount: number;
  place: number;
  placeScore: number;
  placeBonus: number;
  tournamentMatchesWon: number;
  tournamentPointsScored: number;
  tournamentPointsAgainst: number;
  tournamentPointsDiff: number;
  tournamentRawScore: number;
}

export interface CommunityRatingVisitFactMetrics {
  visitsAttended: 1;
}

interface CommunityRatingFactBase {
  id: string;
  communityId: string;
  sourcePostId: string | null;
  eventId: string;
  playerKey: string;
  playerId: string | null;
  playerPhone: string | null;
  playerName: string;
  playerAvatarUrl: string | null;
  currentLevel: number | null;
  ratingDelta: number;
  ratingEventIds: string[];
  lastRatingDelta: number | null;
  lastRatingChangedAt: string | null;
  lastRatingChangedAtTs: number | null;
  lastRatingEventId: string | null;
  occurredAt: string;
  occurredAtTs: number;
  calculationVersion: string;
  collectedAt: string;
}

export type CommunityRatingFact =
  | (CommunityRatingFactBase & {
    eventType: "game";
    metrics: CommunityRatingGameFactMetrics;
  })
  | (CommunityRatingFactBase & {
    eventType: "tournament";
    metrics: CommunityRatingTournamentFactMetrics;
  })
  | (CommunityRatingFactBase & {
    eventType: "visit";
    metrics: CommunityRatingVisitFactMetrics;
  });

interface RatingIdentity {
  id: string | null;
  phone: string | null;
  name: string;
}

interface RatingMember extends RatingIdentity {
  playerKey: string;
  avatarUrl: string | null;
  currentLevel: number | null;
  identityKeys: string[];
}

export interface CommunityRatingMemberSeed {
  playerKey: string;
  playerId: string | null;
  playerPhone: string | null;
  playerName: string;
  playerAvatarUrl: string | null;
  currentLevel: number | null;
}

interface RatingSetScore {
  left: number;
  right: number;
}

interface RatingTeams {
  left: RatingMember[];
  right: RatingMember[];
}

interface RatingSetWithTeams {
  score: RatingSetScore;
  teams: RatingTeams;
}

interface TournamentStanding {
  id: string | null;
  phone: string | null;
  name: string;
  place: number;
  wins: number;
  pointsFor: number;
  pointsAgainst: number;
  pointDiff: number;
}

export interface ExtractCommunityRatingFactsParams {
  community: {
    id?: string | null;
    members?: unknown[] | null;
  };
  feedPosts?: unknown[] | null;
  games?: unknown[] | null;
  tournaments?: unknown[] | null;
  visits?: unknown[] | null;
  ratingEvents?: unknown[] | null;
  ratingStates?: unknown[] | null;
  collectedAt?: string | null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

function toTrimmedString(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function pickString(source: Record<string, unknown> | null | undefined, keys: string[]): string {
  if (!source) return "";
  for (const key of keys) {
    const value = toTrimmedString(source[key]);
    if (value) return value;
  }
  return "";
}

function pickNestedRecord(
  source: Record<string, unknown> | null | undefined,
  keys: string[],
): Record<string, unknown> | null {
  if (!source) return null;
  for (const key of keys) {
    const value = source[key];
    if (isRecord(value)) return value;
  }
  return null;
}

function uniqueStrings(values: Array<string | null | undefined>): string[] {
  return Array.from(new Set(values.filter((value): value is string => Boolean(value))));
}

function isMongoObjectIdLike(value: string): boolean {
  return /^[0-9a-f]{24}$/i.test(value);
}

export function resolveCommunityRatingTournamentPostLinkId(post: Record<string, unknown>): string {
  const direct = pickString(post, ["relatedTournamentId", "tournamentId"]);
  if (direct) return direct;

  const details = pickNestedRecord(post, ["details"]);
  const nestedDetails = pickNestedRecord(details, ["details"]);
  const publicTournament = pickNestedRecord(details, ["publicTournament"]);
  const sourceTournamentSnapshot = pickNestedRecord(details, ["sourceTournamentSnapshot", "sourceTournament"]);

  const stableNestedCandidate = pickString(details, ["relatedTournamentId"])
    || pickString(nestedDetails, ["relatedTournamentId"])
    || pickString(publicTournament, ["exerciseId", "sourceTournamentId", "tournamentId", "id"])
    || pickString(sourceTournamentSnapshot, ["exerciseId", "sourceTournamentId", "tournamentId", "id"]);
  if (stableNestedCandidate) return stableNestedCandidate;

  const legacyCandidate = pickString(details, ["tournamentId"])
    || pickString(nestedDetails, ["tournamentId"]);
  if (!legacyCandidate || isMongoObjectIdLike(legacyCandidate)) return "";
  return legacyCandidate;
}

export function collectCommunityRatingTournamentRecordIds(tournament: Record<string, unknown>): string[] {
  const details = pickNestedRecord(tournament, ["details"]);
  const publicTournament = pickNestedRecord(tournament, ["publicTournament"]);
  const sourceTournamentSnapshot = pickNestedRecord(tournament, ["sourceTournamentSnapshot", "sourceTournament"]);

  return uniqueStrings([
    pickString(tournament, ["tournamentId", "id", "exerciseId", "sourceTournamentId"]),
    pickString(details, ["tournamentId", "id", "exerciseId", "sourceTournamentId"]),
    pickString(publicTournament, ["tournamentId", "id", "exerciseId", "sourceTournamentId"]),
    pickString(sourceTournamentSnapshot, ["tournamentId", "id", "exerciseId", "sourceTournamentId"]),
  ]);
}

export function resolveCommunityRatingVisitPostLinkId(post: Record<string, unknown>): string {
  const direct = pickString(post, [
    "relatedVisitId",
    "visitId",
    "trainingVisitId",
    "attendanceId",
    "relatedBookingId",
    "bookingId",
    "relatedExerciseId",
    "exerciseId",
    "groupExerciseId",
    "trainingId",
  ]);
  if (direct) return direct;

  const details = pickNestedRecord(post, ["details"]);
  const nestedDetails = pickNestedRecord(details, ["details"]);
  const publicTraining = pickNestedRecord(details, ["publicTraining", "training", "exercise"]);
  const sourceTrainingSnapshot = pickNestedRecord(details, ["sourceTrainingSnapshot", "sourceExercise"]);

  return pickString(details, [
    "relatedVisitId",
    "visitId",
    "trainingVisitId",
    "attendanceId",
    "relatedBookingId",
    "bookingId",
    "relatedExerciseId",
    "exerciseId",
    "groupExerciseId",
    "trainingId",
  ])
    || pickString(nestedDetails, [
      "relatedVisitId",
      "visitId",
      "trainingVisitId",
      "attendanceId",
      "relatedBookingId",
      "bookingId",
      "relatedExerciseId",
      "exerciseId",
      "groupExerciseId",
      "trainingId",
    ])
    || pickString(publicTraining, ["visitId", "bookingId", "exerciseId", "groupExerciseId", "trainingId", "id"])
    || pickString(sourceTrainingSnapshot, ["visitId", "bookingId", "exerciseId", "groupExerciseId", "trainingId", "id"]);
}

export function collectCommunityRatingVisitRecordIds(visit: Record<string, unknown>): string[] {
  const booking = pickNestedRecord(visit, ["booking"]);
  const exercise = pickNestedRecord(visit, ["exercise"]);
  const details = pickNestedRecord(visit, ["details"]);
  const client = pickNestedRecord(visit, ["client", "user", "member", "player", "participant"]);

  return uniqueStrings([
    pickString(visit, [
      "visitId",
      "id",
      "trainingVisitId",
      "attendanceId",
      "bookingId",
      "exerciseId",
      "groupExerciseId",
      "trainingId",
      "sourceExerciseId",
      "relatedExerciseId",
    ]),
    pickString(booking, ["visitId", "id", "bookingId", "exerciseId", "groupExerciseId", "trainingId"]),
    pickString(exercise, ["visitId", "id", "exerciseId", "groupExerciseId", "trainingId"]),
    pickString(details, ["visitId", "id", "bookingId", "exerciseId", "groupExerciseId", "trainingId"]),
    pickString(client, ["visitId", "bookingId"]),
  ]);
}

function toFiniteNumber(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && value.trim()) {
    const parsed = Number(value.trim().replace(",", "."));
    if (Number.isFinite(parsed)) return parsed;
  }
  return null;
}

function pickNumber(source: Record<string, unknown> | null | undefined, keys: string[]): number | null {
  if (!source) return null;
  for (const key of keys) {
    const value = toFiniteNumber(source[key]);
    if (value != null) return value;
  }
  return null;
}

function toArray(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

function normalizePhone(value: unknown): string | null {
  const digits = String(value ?? "").replace(/\D/g, "");
  if (!digits) return null;
  if (digits.length === 10) return `7${digits}`;
  if (digits.length === 11 && digits.startsWith("8")) return `7${digits.slice(1)}`;
  return digits;
}

function parseTs(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  const raw = toTrimmedString(value);
  if (!raw) return null;
  const parsed = Date.parse(raw);
  return Number.isFinite(parsed) ? parsed : null;
}

function toLowerString(value: unknown): string {
  return toTrimmedString(value).toLowerCase();
}

function isTruthyFlag(value: unknown): boolean {
  return (
    value === true
    || value === 1
    || value === "1"
    || toLowerString(value) === "true"
  );
}

function toIso(ts: number): string {
  return new Date(ts).toISOString();
}

function roundTo(value: number, digits = 3): number {
  if (!Number.isFinite(value)) return 0;
  const factor = 10 ** digits;
  return Math.round(value * factor) / factor;
}

function getIdentityKeys(identity: Partial<RatingIdentity>): string[] {
  const keys: string[] = [];
  const id = toTrimmedString(identity.id);
  const phone = normalizePhone(identity.phone);
  const name = toTrimmedString(identity.name).toLowerCase();
  if (id) keys.push(`id:${id}`);
  if (phone) keys.push(`phone:${phone}`);
  if (name) keys.push(`name:${name}`);
  return keys;
}

function buildRatingMember(value: unknown, fallbackIndex: number): RatingMember | null {
  if (!isRecord(value)) return null;
  const id = pickString(value, ["id", "clientId", "userId", "uuid", "playerId"]) || null;
  const phone = normalizePhone(value.phone ?? value.phoneNorm ?? value.phoneNumber ?? value.mobile);
  const name = pickString(value, ["name", "playerName", "displayName", "fullName", "title"])
    || phone
    || id
    || `Игрок ${fallbackIndex + 1}`;
  const currentLevel = pickNumber(value, ["currentLevel", "levelScore", "ratingNumeric", "levelNumeric"]);
  const identityKeys = getIdentityKeys({ id, phone, name });
  const playerKey = identityKeys[0] ?? `name:${name.trim().toLowerCase()}`;

  return {
    id,
    phone,
    name,
    playerKey,
    avatarUrl: pickString(value, ["avatarUrl", "avatar", "photo", "imageUrl"]) || null,
    currentLevel,
    identityKeys,
  };
}

function dedupeMembers<T extends RatingMember>(members: T[]): T[] {
  const seen = new Set<string>();
  const result: T[] = [];
  members.forEach((member) => {
    if (seen.has(member.playerKey)) return;
    seen.add(member.playerKey);
    result.push(member);
  });
  return result;
}

function buildMemberIndex(members: RatingMember[]): Map<string, RatingMember> {
  const index = new Map<string, RatingMember>();
  members.forEach((member) => {
    member.identityKeys.forEach((key) => {
      index.set(key, member);
    });
  });
  return index;
}

interface RatingLedgerImpact {
  delta: number;
  eventIds: string[];
  lastRatingDelta: number | null;
  lastRatingChangedAt: string | null;
  lastRatingChangedAtTs: number | null;
  lastRatingEventId: string | null;
}

type RatingLedgerImpactIndex = Map<string, Map<string, RatingLedgerImpact>>;

function buildRatingStateIndex(rows: unknown[]): Map<string, number> {
  const result = new Map<string, number>();
  rows.forEach((row) => {
    if (!isRecord(row)) return;
    const ratingNumeric = toFiniteNumber(row.ratingNumeric ?? row.levelNumeric ?? row.currentLevel);
    if (ratingNumeric == null) return;
    const identityKeys = getIdentityKeys({
      id: pickString(row, ["clientId", "id", "playerId"]) || null,
      phone: normalizePhone(row.phoneNorm ?? row.phone),
      name: pickString(row, ["name", "playerName"]) || undefined,
    });
    toArray(isRecord(row.identityAliases) ? row.identityAliases.clientIds : [])
      .map((value) => toTrimmedString(value))
      .filter(Boolean)
      .forEach((value) => identityKeys.push(`id:${value}`));
    toArray(isRecord(row.identityAliases) ? row.identityAliases.phoneNorms : [])
      .map((value) => normalizePhone(value))
      .filter((value): value is string => Boolean(value))
      .forEach((value) => identityKeys.push(`phone:${value}`));
    uniqueStrings(identityKeys).forEach((key) => result.set(key, ratingNumeric));
  });
  return result;
}

function hydrateMemberLevelsFromState(members: RatingMember[], stateIndex: Map<string, number>): RatingMember[] {
  return members.map((member) => {
    const canonicalLevel = member.identityKeys
      .map((key) => stateIndex.get(key))
      .find((value) => value != null);
    return canonicalLevel == null ? member : { ...member, currentLevel: canonicalLevel };
  });
}

export function extractCommunityRatingMemberSeeds(params: Pick<
  ExtractCommunityRatingFactsParams,
  "community" | "ratingStates"
>): CommunityRatingMemberSeed[] {
  const stateIndex = buildRatingStateIndex(toArray(params.ratingStates));
  return dedupeMembers(hydrateMemberLevelsFromState(toArray(params.community.members)
    .map((member, index) => buildRatingMember(member, index))
    .filter((member): member is RatingMember => member !== null), stateIndex))
    .map((member) => ({
      playerKey: member.playerKey,
      playerId: member.id,
      playerPhone: member.phone,
      playerName: member.name,
      playerAvatarUrl: member.avatarUrl,
      currentLevel: member.currentLevel,
    }));
}

function buildRatingLedgerImpactIndex(rows: unknown[]): RatingLedgerImpactIndex {
  const result: RatingLedgerImpactIndex = new Map();
  rows.forEach((row) => {
    if (!isRecord(row)) return;
    const source = isRecord(row.source) ? row.source : null;
    const player = isRecord(row.player) ? row.player : null;
    const change = isRecord(row.change) ? row.change : null;
    const domain = pickString(source, ["domain"]).toUpperCase();
    const sourceId = pickString(source, ["sourceId", "gameId", "tournamentId"]);
    const eventId = pickString(row, ["id", "_id"]);
    const delta = toFiniteNumber(change?.delta);
    if (!domain || !sourceId || !eventId || delta == null || !player) return;
    const eventTs = parseTs(row.occurredAt) ?? parseTs(row.createdAt) ?? 0;
    const eventAt = eventTs > 0 ? toIso(eventTs) : null;
    const sourceKey = `${domain}:${sourceId}`;
    const byIdentity = result.get(sourceKey) ?? new Map<string, RatingLedgerImpact>();
    const identityKeys = getIdentityKeys({
      id: pickString(player, ["clientId", "id", "playerId"]) || null,
      phone: normalizePhone(player.phoneNorm ?? player.phone),
      name: pickString(player, ["name", "playerName"]) || undefined,
    });
    identityKeys.forEach((identityKey) => {
      const current = byIdentity.get(identityKey) ?? {
        delta: 0,
        eventIds: [],
        lastRatingDelta: null,
        lastRatingChangedAt: null,
        lastRatingChangedAtTs: null,
        lastRatingEventId: null,
      };
      current.delta = roundTo(current.delta + delta);
      current.eventIds = uniqueStrings([...current.eventIds, eventId]);
      const currentTs = current.lastRatingChangedAtTs ?? 0;
      const isNewer = eventTs > currentTs;
      const isSameTimeButLaterId = eventTs === currentTs
        && (current.lastRatingEventId == null || eventId.localeCompare(current.lastRatingEventId) > 0);
      if (delta !== 0 && (isNewer || isSameTimeButLaterId)) {
        current.lastRatingDelta = roundTo(delta);
        current.lastRatingChangedAt = eventAt;
        current.lastRatingChangedAtTs = eventTs > 0 ? eventTs : null;
        current.lastRatingEventId = eventId;
      }
      byIdentity.set(identityKey, current);
    });
    result.set(sourceKey, byIdentity);
  });
  return result;
}

function resolveLedgerImpact(
  index: RatingLedgerImpactIndex,
  domain: "GAME_RESULT" | "TOURNAMENT",
  sourceId: string,
  member: RatingMember,
): RatingLedgerImpact | null {
  const byIdentity = index.get(`${domain}:${sourceId}`);
  if (!byIdentity) return null;
  const impacts = member.identityKeys
    .map((key) => byIdentity.get(key))
    .filter((impact): impact is RatingLedgerImpact => Boolean(impact));
  if (impacts.length === 0) return null;
  const latestImpact = impacts.reduce<RatingLedgerImpact | null>((latest, impact) => {
    if (impact.lastRatingDelta == null) return latest;
    if (!latest) return impact;
    const impactTs = impact.lastRatingChangedAtTs ?? 0;
    const latestTs = latest.lastRatingChangedAtTs ?? 0;
    if (impactTs !== latestTs) return impactTs > latestTs ? impact : latest;
    return String(impact.lastRatingEventId || "").localeCompare(String(latest.lastRatingEventId || "")) > 0
      ? impact
      : latest;
  }, null);
  return {
    delta: roundTo(impacts[0].delta),
    eventIds: uniqueStrings(impacts.flatMap((impact) => impact.eventIds)),
    lastRatingDelta: latestImpact?.lastRatingDelta ?? null,
    lastRatingChangedAt: latestImpact?.lastRatingChangedAt ?? null,
    lastRatingChangedAtTs: latestImpact?.lastRatingChangedAtTs ?? null,
    lastRatingEventId: latestImpact?.lastRatingEventId ?? null,
  };
}

function resolveMember(memberByKey: Map<string, RatingMember>, value: Partial<RatingIdentity>): RatingMember | null {
  for (const key of getIdentityKeys(value)) {
    const member = memberByKey.get(key);
    if (member) return member;
  }
  return null;
}

function resolvePostTimestamp(post: Record<string, unknown>): number {
  return (
    parseTs(post.createdTs)
    ?? parseTs(post.publishedAt)
    ?? parseTs(post.createdAt)
    ?? parseTs(post.updatedAt)
    ?? 0
  );
}

function resolveGameMatchResult(game: Record<string, unknown>): Record<string, unknown> | null {
  const metadata = isRecord(game.metadata) ? game.metadata : null;
  return metadata && isRecord(metadata.matchResult) ? metadata.matchResult : null;
}

function isConfirmedGame(game: Record<string, unknown>): boolean {
  const matchResult = resolveGameMatchResult(game);
  if (!matchResult) return false;
  const status = pickString(matchResult, ["status"]).toUpperCase();
  const gameStatus = pickString(game, ["status", "resultStatus"]).toUpperCase();
  const excludedStatuses = new Set([
    "DISPUTED",
    "CORRECTION_PENDING",
    "NO_RESULT_EXPIRED",
    "PENDING_REVIEW",
  ]);
  if (excludedStatuses.has(status) || excludedStatuses.has(gameStatus)) return false;
  return status === "CONFIRMED" || (!status && Boolean(matchResult.confirmedAt || matchResult.confirmedBy));
}

function resolveGameTimestamp(game: Record<string, unknown>, fallbackTs: number): number {
  const booking = isRecord(game.booking) ? game.booking : null;
  return (
    parseTs(booking?.timeToIso)
    ?? parseTs(booking?.timeFromIso)
    ?? parseTs(game.updatedAt)
    ?? parseTs(game.createdAt)
    ?? fallbackTs
  );
}

function resolveVisitTimestamp(visit: Record<string, unknown>, fallbackTs: number): number {
  const booking = isRecord(visit.booking) ? visit.booking : null;
  const exercise = isRecord(visit.exercise) ? visit.exercise : null;
  const details = isRecord(visit.details) ? visit.details : null;
  return (
    parseTs(visit.visitedAt)
    ?? parseTs(visit.attendedAt)
    ?? parseTs(visit.checkedInAt)
    ?? parseTs(visit.completedAt)
    ?? parseTs(visit.timeToIso)
    ?? parseTs(visit.timeFromIso)
    ?? parseTs(visit.scheduledAt)
    ?? parseTs(visit.startAt)
    ?? parseTs(booking?.timeToIso)
    ?? parseTs(booking?.timeFromIso)
    ?? parseTs(exercise?.timeToIso)
    ?? parseTs(exercise?.timeFromIso)
    ?? parseTs(details?.timeToIso)
    ?? parseTs(details?.timeFromIso)
    ?? parseTs(visit.updatedAt)
    ?? parseTs(visit.createdAt)
    ?? fallbackTs
  );
}

function hasExcludedVisitStatus(value: unknown): boolean {
  const status = toLowerString(value);
  return Boolean(
    status.includes("cancel")
    || status.includes("отмен")
    || status.includes("refund")
    || status.includes("declin")
    || status.includes("no_show")
    || status.includes("noshow")
    || status.includes("waitlist")
    || status.includes("waiting")
    || status.includes("pending")
    || status.includes("unpaid")
    || status.includes("failed"),
  );
}

function isVisitAttendanceExcluded(value: Record<string, unknown>): boolean {
  return [
    value.status,
    value.state,
    value.registrationStatus,
    value.bookingStatus,
    value.paymentStatus,
    value.sourceStatus,
    value.rawStatus,
  ].some((status) => hasExcludedVisitStatus(status));
}

function isPositiveVisitFlag(value: unknown): boolean {
  return isTruthyFlag(value);
}

function isVisitAttendanceIncluded(value: Record<string, unknown>, occurredAtTs: number, collectedAtTs: number): boolean {
  if (occurredAtTs <= 0 || occurredAtTs > collectedAtTs) return false;

  const statusValues = [
    value.status,
    value.state,
    value.registrationStatus,
    value.bookingStatus,
    value.paymentStatus,
    value.sourceStatus,
    value.rawStatus,
  ];
  if (isVisitAttendanceExcluded(value)) return false;

  if ([
    value.visitConfirmed,
    value.visited,
    value.attended,
    value.checkedIn,
    value.checkIn,
    value.present,
    value.completed,
  ].some((flag) => isPositiveVisitFlag(flag))) {
    return true;
  }

  if (value.visitConfirmed === false || toLowerString(value.visitConfirmed) === "false") return false;

  const normalizedStatuses = statusValues.map((status) => toLowerString(status)).filter(Boolean);
  return normalizedStatuses.some((status) => (
    status.includes("attend")
    || status.includes("visit")
    || status.includes("complete")
    || status.includes("checked")
  ));
}

function resolveVisitPlayerPool(
  visit: Record<string, unknown>,
  occurredAtTs: number,
  collectedAtTs: number,
  rootVisitConfirmed: boolean,
): RatingMember[] {
  const rawItems = [
    ...toArray(visit.participants),
    ...toArray(visit.attendees),
    ...toArray(visit.clients),
    ...toArray(visit.bookings),
    ...toArray(visit.visits),
    ...toArray(visit.members),
    ...toArray(visit.customers),
  ];

  const nestedCandidates = [
    visit.client,
    visit.user,
    visit.member,
    visit.player,
    visit.participant,
  ];
  nestedCandidates.forEach((candidate) => {
    if (isRecord(candidate)) rawItems.push(candidate);
  });

  if (
    pickString(visit, ["id", "clientId", "userId", "uuid", "playerId"])
    || normalizePhone(visit.phone ?? visit.phoneNorm ?? visit.phoneNumber ?? visit.mobile)
    || pickString(visit, ["name", "playerName", "displayName", "fullName", "title"])
  ) {
    rawItems.push(visit);
  }

  const members = rawItems
    .map((item, index) => {
      if (!isRecord(item)) return null;
      if (!isVisitAttendanceIncluded(item, occurredAtTs, collectedAtTs)) {
        if (!rootVisitConfirmed || isVisitAttendanceExcluded(item)) return null;
      }
      return buildRatingMember(item, index);
    })
    .filter((item): item is RatingMember => item !== null);
  return dedupeMembers(members);
}

function resolveGameSets(game: Record<string, unknown>): RatingSetScore[] {
  const matchResult = resolveGameMatchResult(game);
  return toArray(matchResult?.sets)
    .map((item) => {
      if (!isRecord(item)) return null;
      const left = toFiniteNumber(item.left ?? item.scoreA ?? item.teamA);
      const right = toFiniteNumber(item.right ?? item.scoreB ?? item.teamB);
      if (left == null || right == null) return null;
      return {
        left: Math.max(0, Math.floor(left)),
        right: Math.max(0, Math.floor(right)),
      };
    })
    .filter((item): item is RatingSetScore => item !== null);
}

function resolveGamePlayerPool(game: Record<string, unknown>): RatingMember[] {
  const metadata = isRecord(game.metadata) ? game.metadata : null;
  const matchResult = resolveGameMatchResult(game);
  const participants = [
    ...toArray(game.participants),
    ...toArray(game.playerPool),
    ...toArray(metadata?.playerPool),
    ...toArray(game.waitlist),
    ...toArray(metadata?.waitlist),
    ...toArray(matchResult?.playerPool),
    ...toArray(matchResult?.waitlist),
  ]
    .map((item, index) => buildRatingMember(item, index))
    .filter((item): item is RatingMember => item !== null);

  if (participants.length > 0) return dedupeMembers(participants);
  const organizer = buildRatingMember(game.organizer, 0);
  return organizer ? [organizer] : [];
}

function buildFallbackSlotMember(raw: string): RatingMember {
  const id = raw;
  const phone = normalizePhone(raw);
  const name = raw;
  const identityKeys = getIdentityKeys({ id, phone, name });
  return {
    id,
    phone,
    name,
    playerKey: identityKeys[0] ?? `name:${raw.toLowerCase()}`,
    avatarUrl: null,
    currentLevel: null,
    identityKeys,
  };
}

function resolveGameSlotsMembers(game: Record<string, unknown>, rawSlots: unknown[]): RatingMember[] {
  const participants = resolveGamePlayerPool(game);
  const participantByKey = buildMemberIndex(participants);

  const resolveSlot = (slot: unknown, index: number): RatingMember | null => {
    if (typeof slot === "string") {
      const raw = slot.trim();
      if (!raw) return null;
      return (
        participantByKey.get(`id:${raw}`)
        ?? participantByKey.get(`phone:${normalizePhone(raw) ?? ""}`)
        ?? participantByKey.get(`name:${raw.toLowerCase()}`)
        ?? buildFallbackSlotMember(raw)
      );
    }

    const slotMember = buildRatingMember(slot, index);
    if (!slotMember) return null;
    for (const key of slotMember.identityKeys) {
      const participant = participantByKey.get(key);
      if (participant) return participant;
    }
    return slotMember;
  };

  return rawSlots
    .map((slot, index) => resolveSlot(slot, index))
    .filter((player): player is RatingMember => player !== null);
}

function resolveGameTeamSlots(game: Record<string, unknown>, rawSlots: unknown[]): RatingTeams {
  const participants = resolveGamePlayerPool(game);
  const slotPlayers = resolveGameSlotsMembers(game, rawSlots);

  if (slotPlayers.length === 2) {
    return { left: [slotPlayers[0]], right: [slotPlayers[1]] };
  }
  if (slotPlayers.length >= 3) {
    return {
      left: dedupeMembers(slotPlayers.slice(0, 2)),
      right: dedupeMembers(slotPlayers.slice(2, 4)),
    };
  }
  if (participants.length === 2) {
    return { left: [participants[0]], right: [participants[1]] };
  }

  const middle = Math.ceil(participants.length / 2);
  return {
    left: dedupeMembers(participants.slice(0, middle)),
    right: dedupeMembers(participants.slice(middle, 4)),
  };
}

function resolveGameTeams(game: Record<string, unknown>): RatingTeams {
  const metadata = isRecord(game.metadata) ? game.metadata : null;
  return resolveGameTeamSlots(game, toArray(metadata?.teamSlots).slice(0, 4));
}

function normalizePairingSlots(value: unknown): { left: unknown[]; right: unknown[] } | null {
  if (!isRecord(value)) return null;
  const left = toArray(value.left ?? value.teamA ?? value.a ?? value.team1 ?? value.first);
  const right = toArray(value.right ?? value.teamB ?? value.b ?? value.team2 ?? value.second);
  if (left.length > 0 || right.length > 0) {
    return { left, right };
  }

  const slots = toArray(value.teamSlots ?? value.slots ?? value.players ?? value.pairing);
  if (slots.length > 0) {
    return { left: slots.slice(0, 2), right: slots.slice(2, 4) };
  }
  return null;
}

function resolvePairingRawSlots(pairing: unknown): { left: unknown[]; right: unknown[] } | null {
  if (Array.isArray(pairing)) {
    if (Array.isArray(pairing[0]) || Array.isArray(pairing[1])) {
      return {
        left: toArray(pairing[0]),
        right: toArray(pairing[1]),
      };
    }
    return {
      left: pairing.slice(0, 2),
      right: pairing.slice(2, 4),
    };
  }

  const normalized = normalizePairingSlots(pairing);
  if (!normalized) return null;
  return {
    left: normalized.left,
    right: normalized.right,
  };
}

function resolveGamePairingTeams(game: Record<string, unknown>, pairing: unknown): RatingTeams | null {
  const raw = resolvePairingRawSlots(pairing);
  if (!raw) return null;
  const teams = resolveGameTeamSlots(game, [...raw.left, ...raw.right]);
  const left = resolveGameSlotsMembers(game, raw.left);
  const right = resolveGameSlotsMembers(game, raw.right);
  const resolved = {
    left: left.length > 0 ? left : teams.left,
    right: right.length > 0 ? right : teams.right,
  };
  return resolved.left.length > 0 || resolved.right.length > 0 ? resolved : null;
}

function resolveGameSetTeams(game: Record<string, unknown>, sets: RatingSetScore[]): RatingSetWithTeams[] {
  const matchResult = resolveGameMatchResult(game);
  const setPairings = toArray(matchResult?.setPairings);
  const fallbackTeams = resolveGameTeams(game);
  let lastKnownTeams: RatingTeams | null = null;

  return sets.map((score, index) => {
    const pairingTeams = resolveGamePairingTeams(game, setPairings[index]);
    if (pairingTeams) {
      lastKnownTeams = pairingTeams;
    }
    return {
      score,
      teams: pairingTeams ?? lastKnownTeams ?? fallbackTeams,
    };
  });
}

function buildRatingImpactMap(game: Record<string, unknown>): Map<string, number> {
  const matchResult = resolveGameMatchResult(game);
  const impactByKey = new Map<string, number>();
  toArray(matchResult?.ratingImpact).forEach((item) => {
    if (!isRecord(item)) return;
    const delta = toFiniteNumber(item.delta);
    if (delta == null) return;
    const keys = getIdentityKeys({
      id: pickString(item, ["id", "clientId", "playerId", "userId"]) || null,
      phone: normalizePhone(item.phoneNorm ?? item.phone ?? item.phoneNumber),
      name: pickString(item, ["name", "playerName"]) || undefined,
    });
    keys.forEach((key) => {
      impactByKey.set(key, roundTo((impactByKey.get(key) ?? 0) + delta));
    });
  });
  return impactByKey;
}

function resolveMemberLevelDelta(member: RatingMember, impactByKey: Map<string, number>): number {
  const matchedValues = new Set<number>();
  member.identityKeys.forEach((key) => {
    const value = impactByKey.get(key);
    if (value != null) matchedValues.add(value);
  });
  return roundTo(Array.from(matchedValues).reduce((sum, value) => sum + value, 0));
}

export function buildCommunityRatingFactId(input: {
  communityId: string;
  eventType: CommunityRatingFactEventType;
  eventId: string;
  playerKey: string;
  calculationVersion?: string;
}): string {
  return [
    input.communityId,
    input.eventType,
    input.eventId,
    input.playerKey,
    input.calculationVersion ?? COMMUNITY_RATING_CALCULATION_VERSION,
  ].map((part) => encodeURIComponent(part)).join(":");
}

function createBaseFact(input: {
  communityId: string;
  sourcePostId: string | null;
  eventType: CommunityRatingFactEventType;
  eventId: string;
  member: RatingMember;
  ratingImpact?: RatingLedgerImpact | null;
  occurredAtTs: number;
  collectedAt: string;
}): Omit<CommunityRatingFactBase, "eventType" | "metrics"> {
  const occurredAt = toIso(input.occurredAtTs);
  const lastRatingDelta = input.ratingImpact?.lastRatingDelta ?? null;
  const lastRatingChangedAtTs = lastRatingDelta == null
    ? null
    : (input.ratingImpact?.lastRatingChangedAtTs ?? input.occurredAtTs);
  return {
    id: buildCommunityRatingFactId({
      communityId: input.communityId,
      eventType: input.eventType,
      eventId: input.eventId,
      playerKey: input.member.playerKey,
    }),
    communityId: input.communityId,
    sourcePostId: input.sourcePostId,
    eventId: input.eventId,
    playerKey: input.member.playerKey,
    playerId: input.member.id,
    playerPhone: input.member.phone,
    playerName: input.member.name,
    playerAvatarUrl: input.member.avatarUrl,
    currentLevel: input.member.currentLevel,
    ratingDelta: input.ratingImpact?.delta ?? 0,
    ratingEventIds: input.ratingImpact?.eventIds ?? [],
    lastRatingDelta,
    lastRatingChangedAt: lastRatingChangedAtTs == null ? null : toIso(lastRatingChangedAtTs),
    lastRatingChangedAtTs,
    lastRatingEventId: input.ratingImpact?.lastRatingEventId ?? null,
    occurredAt,
    occurredAtTs: input.occurredAtTs,
    calculationVersion: COMMUNITY_RATING_CALCULATION_VERSION,
    collectedAt: input.collectedAt,
  };
}

function extractGameFacts(input: {
  communityId: string;
  post: Record<string, unknown>;
  game: Record<string, unknown>;
  memberByKey: Map<string, RatingMember>;
  ratingLedger: RatingLedgerImpactIndex;
  collectedAt: string;
}): CommunityRatingFact[] {
  if (!isConfirmedGame(input.game)) return [];
  const sets = resolveGameSets(input.game);
  if (sets.length === 0) return [];

  const eventId = pickString(input.game, ["id", "gameId"]) || pickString(input.post, ["relatedGameId", "gameId"]);
  if (!eventId) return [];

  const impactByKey = buildRatingImpactMap(input.game);
  const occurredAtTs = resolveGameTimestamp(input.game, resolvePostTimestamp(input.post));
  if (occurredAtTs <= 0) return [];

  const sourcePostId = pickString(input.post, ["id", "postId"]) || null;
  const statsByPlayerKey = new Map<string, {
    member: RatingMember;
    setsWon: number;
    setsLost: number;
    gamesWonCount: number;
    gamesLostCount: number;
  }>();

  const addSetStats = (player: RatingMember, scoreFor: number, scoreAgainst: number): void => {
    const member = resolveMember(input.memberByKey, player);
    if (!member) return;
    const stats = statsByPlayerKey.get(member.playerKey) ?? {
      member,
      setsWon: 0,
      setsLost: 0,
      gamesWonCount: 0,
      gamesLostCount: 0,
    };
    stats.setsWon += scoreFor > scoreAgainst ? 1 : 0;
    stats.setsLost += scoreAgainst > scoreFor ? 1 : 0;
    stats.gamesWonCount += scoreFor;
    stats.gamesLostCount += scoreAgainst;
    statsByPlayerKey.set(member.playerKey, stats);
  };

  resolveGameSetTeams(input.game, sets).forEach(({ score, teams }) => {
    const leftMembers = dedupeMembers(teams.left);
    const rightMembers = dedupeMembers(teams.right);
    leftMembers.forEach((player) => addSetStats(player, score.left, score.right));
    rightMembers.forEach((player) => addSetStats(player, score.right, score.left));
  });

  if (statsByPlayerKey.size === 0) return [];

  return Array.from(statsByPlayerKey.values()).map((stats): CommunityRatingFact => {
    const gameWon = stats.setsWon > stats.setsLost
      || (stats.setsWon === stats.setsLost && stats.gamesWonCount > stats.gamesLostCount);
    const gameLost = stats.setsLost > stats.setsWon
      || (stats.setsWon === stats.setsLost && stats.gamesLostCount > stats.gamesWonCount);

    const ledgerImpact = resolveLedgerImpact(input.ratingLedger, "GAME_RESULT", eventId, stats.member);
    const legacyLevelDelta = resolveMemberLevelDelta(stats.member, impactByKey);
    return {
      ...createBaseFact({
        communityId: input.communityId,
        sourcePostId,
        eventType: "game",
        eventId,
        member: stats.member,
        ratingImpact: ledgerImpact ?? {
          delta: legacyLevelDelta,
          eventIds: [],
          lastRatingDelta: null,
          lastRatingChangedAt: null,
          lastRatingChangedAtTs: null,
          lastRatingEventId: null,
        },
        occurredAtTs,
        collectedAt: input.collectedAt,
      }),
      eventType: "game",
      metrics: {
        gamesPlayed: 1,
        gamesWon: gameWon ? 1 : 0,
        gamesLost: gameLost ? 1 : 0,
        setsWon: stats.setsWon,
        setsLost: stats.setsLost,
        gamesWonCount: stats.gamesWonCount,
        gamesLostCount: stats.gamesLostCount,
        gamesDiff: stats.gamesWonCount - stats.gamesLostCount,
        levelDelta: ledgerImpact?.delta ?? legacyLevelDelta,
      },
    };
  });
}

function resolveTournamentRows(tournament: Record<string, unknown>): TournamentStanding[] {
  const standings = toArray(tournament.standings);
  if (standings.length > 0) {
    return standings
      .map((item, index) => {
        if (!isRecord(item)) return null;
        const pointsFor = pickNumber(item, ["pointsFor", "points", "totalPoints", "tournamentPoints"]) ?? 0;
        const pointsAgainst = pickNumber(item, ["pointsAgainst"]) ?? 0;
        return {
          id: pickString(item, ["id", "playerId", "clientId", "userId"]) || null,
          phone: normalizePhone(item.phone ?? item.phoneNorm ?? item.phoneNumber),
          name: pickString(item, ["name", "playerName", "player", "title"]) || `Участник ${index + 1}`,
          place: Math.max(1, Math.floor(pickNumber(item, ["rank", "place", "position"]) ?? (index + 1))),
          wins: pickNumber(item, ["wins", "matchesWon"]) ?? 0,
          pointsFor,
          pointsAgainst,
          pointDiff: pickNumber(item, ["pointDiff", "pointsDiff", "delta", "deltaTotal"]) ?? (pointsFor - pointsAgainst),
        };
      })
      .filter((item): item is TournamentStanding => item !== null);
  }

  if (!isRecord(tournament.totals)) return [];

  return Object.entries(tournament.totals)
    .map(([key, value], index) => {
      if (!isRecord(value)) return null;
      const pointsFor = pickNumber(value, ["pointsFor", "points", "totalPoints", "tournamentPoints"]) ?? 0;
      const pointsAgainst = pickNumber(value, ["pointsAgainst"]) ?? 0;
      return {
        id: pickString(value, ["id", "playerId", "clientId", "userId"]) || key || null,
        phone: normalizePhone(value.phone ?? value.phoneNorm ?? value.phoneNumber),
        name: pickString(value, ["name", "playerName", "player", "title"]) || key || `Участник ${index + 1}`,
        place: Math.max(1, Math.floor(pickNumber(value, ["rank", "place", "position"]) ?? (index + 1))),
        wins: pickNumber(value, ["wins", "matchesWon"]) ?? 0,
        pointsFor,
        pointsAgainst,
        pointDiff: pickNumber(value, ["pointDiff", "pointsDiff", "delta", "deltaTotal"]) ?? (pointsFor - pointsAgainst),
      };
    })
    .filter((item): item is TournamentStanding => item !== null)
    .sort((left, right) => {
      if (left.place !== right.place) return left.place - right.place;
      return left.name.localeCompare(right.name, "ru");
    });
}

function resolveTournamentParticipantsCount(tournament: Record<string, unknown>, rows: TournamentStanding[]): number {
  const summary = isRecord(tournament.summary) ? tournament.summary : null;
  const params = isRecord(tournament.params) ? tournament.params : null;
  const candidates = [
    toArray(tournament.participants).length,
    pickNumber(summary, ["participantsCount", "joinedCount"]),
    pickNumber(params, ["participantsCount", "joinedCount"]),
    rows.length,
  ].filter((value): value is number => value != null && value > 0);

  return candidates.length > 0 ? Math.max(...candidates.map((value) => Math.floor(value))) : 0;
}

function isTournamentFinalized(tournament: Record<string, unknown>): boolean {
  const params = isRecord(tournament.params) ? tournament.params : null;
  const summary = isRecord(tournament.summary) ? tournament.summary : null;
  const statuses = [
    tournament.status,
    tournament.state,
    tournament.tournamentStatus,
    params?.status,
    params?.state,
    params?.tournamentStatus,
    summary?.status,
    summary?.state,
    summary?.tournamentStatus,
  ]
    .map((value) => toLowerString(value))
    .filter(Boolean);

  if (statuses.some((status) => (
    status === "completed"
    || status === "finished"
    || status === "closed"
    || status === "done"
    || status === "завершен"
    || status === "завершён"
  ))) {
    return true;
  }

  const finishMarkers = [
    params?.finishedAt,
    params?.completedAt,
    params?.manualFinishedAt,
    summary?.finishedAt,
    summary?.completedAt,
  ];
  if (finishMarkers.some((value) => toTrimmedString(value))) {
    return true;
  }

  const flags = [
    params?.finished,
    params?.isFinished,
    params?.tournamentFinished,
    params?.manualFinish,
    summary?.finished,
    summary?.isFinished,
    summary?.tournamentFinished,
    summary?.manualFinish,
  ];
  return flags.some((value) => isTruthyFlag(value));
}

function resolveTournamentTimestamp(tournament: Record<string, unknown>, fallbackTs: number): number {
  const params = isRecord(tournament.params) ? tournament.params : null;
  const summary = isRecord(tournament.summary) ? tournament.summary : null;
  return (
    parseTs(params?.finishedAt)
    ?? parseTs(params?.completedAt)
    ?? parseTs(params?.manualFinishedAt)
    ?? parseTs(summary?.finishedAt)
    ?? parseTs(summary?.completedAt)
    ?? parseTs(tournament.updatedAt)
    ?? parseTs(tournament.createdAt)
    ?? fallbackTs
  );
}

function extractTournamentFacts(input: {
  communityId: string;
  post: Record<string, unknown>;
  tournament: Record<string, unknown>;
  memberByKey: Map<string, RatingMember>;
  ratingLedger: RatingLedgerImpactIndex;
  collectedAt: string;
}): CommunityRatingFact[] {
  if (!isTournamentFinalized(input.tournament)) return [];
  const eventId = pickString(input.tournament, ["tournamentId", "id"])
    || resolveCommunityRatingTournamentPostLinkId(input.post);
  if (!eventId) return [];

  const rows = resolveTournamentRows(input.tournament);
  const participantsCount = resolveTournamentParticipantsCount(input.tournament, rows);
  if (rows.length === 0 || participantsCount <= 0) return [];

  const occurredAtTs = resolveTournamentTimestamp(input.tournament, resolvePostTimestamp(input.post));
  if (occurredAtTs <= 0) return [];

  const sourcePostId = pickString(input.post, ["id", "postId"]) || null;

  return rows
    .map((standing): CommunityRatingFact | null => {
      const member = resolveMember(input.memberByKey, standing);
      if (!member) return null;
      const placeScore = calculatePlaceScore(standing.place, participantsCount);
      const placeBonus = getPlaceBonus(standing.place);
      const tournamentRawScore = calculateTournamentRawScore({
        participantsCount,
        place: standing.place,
        tournamentMatchesWon: standing.wins,
        tournamentPointsScored: standing.pointsFor,
        tournamentPointsDiff: standing.pointDiff,
      });
      const ledgerImpact = resolveLedgerImpact(input.ratingLedger, "TOURNAMENT", eventId, member);

      return {
        ...createBaseFact({
          communityId: input.communityId,
          sourcePostId,
          eventType: "tournament",
          eventId,
          member,
          ratingImpact: ledgerImpact,
          occurredAtTs,
          collectedAt: input.collectedAt,
        }),
        eventType: "tournament",
        metrics: {
          tournamentsPlayed: 1,
          participantsCount,
          place: standing.place,
          placeScore,
          placeBonus,
          tournamentMatchesWon: standing.wins,
          tournamentPointsScored: standing.pointsFor,
          tournamentPointsAgainst: standing.pointsAgainst,
          tournamentPointsDiff: standing.pointDiff,
          tournamentRawScore,
        },
      };
    })
    .filter((fact): fact is CommunityRatingFact => fact !== null);
}

function extractVisitFacts(input: {
  communityId: string;
  post: Record<string, unknown> | null;
  visit: Record<string, unknown>;
  memberByKey: Map<string, RatingMember>;
  collectedAt: string;
}): CommunityRatingFact[] {
  const collectedAtTs = parseTs(input.collectedAt) ?? Date.now();
  const fallbackTs = input.post ? resolvePostTimestamp(input.post) : 0;
  const occurredAtTs = resolveVisitTimestamp(input.visit, fallbackTs);
  if (occurredAtTs <= 0) return [];
  if (occurredAtTs > collectedAtTs || isVisitAttendanceExcluded(input.visit)) return [];
  const rootVisitConfirmed = isVisitAttendanceIncluded(input.visit, occurredAtTs, collectedAtTs);

  const eventId = collectCommunityRatingVisitRecordIds(input.visit)[0]
    || (input.post ? resolveCommunityRatingVisitPostLinkId(input.post) : "");
  if (!eventId) return [];

  const sourcePostId = input.post ? (pickString(input.post, ["id", "postId"]) || null) : null;
  const visitors = resolveVisitPlayerPool(input.visit, occurredAtTs, collectedAtTs, rootVisitConfirmed);
  if (visitors.length === 0) return [];

  const factByPlayerKey = new Map<string, CommunityRatingFact>();
  visitors.forEach((visitor) => {
    const member = resolveMember(input.memberByKey, visitor);
    if (!member || factByPlayerKey.has(member.playerKey)) return;
    factByPlayerKey.set(member.playerKey, {
      ...createBaseFact({
        communityId: input.communityId,
        sourcePostId,
        eventType: "visit",
        eventId,
        member,
        occurredAtTs,
        collectedAt: input.collectedAt,
      }),
      eventType: "visit",
      metrics: {
        visitsAttended: 1,
      },
    });
  });

  return Array.from(factByPlayerKey.values());
}

export function extractCommunityRatingFacts(params: ExtractCommunityRatingFactsParams): CommunityRatingFact[] {
  const communityId = toTrimmedString(params.community.id);
  if (!communityId) return [];

  const ratingLedger = buildRatingLedgerImpactIndex(toArray(params.ratingEvents));
  const members = extractCommunityRatingMemberSeeds(params).map((member) => ({
    id: member.playerId,
    phone: member.playerPhone,
    name: member.playerName,
    playerKey: member.playerKey,
    avatarUrl: member.playerAvatarUrl,
    currentLevel: member.currentLevel,
    identityKeys: getIdentityKeys({
      id: member.playerId,
      phone: member.playerPhone,
      name: member.playerName,
    }),
  }));
  const memberByKey = buildMemberIndex(members);
  const collectedAt = params.collectedAt || new Date().toISOString();

  const gameById = new Map<string, Record<string, unknown>>();
  toArray(params.games).forEach((game) => {
    if (!isRecord(game)) return;
    const id = pickString(game, ["id", "gameId"]);
    if (id) gameById.set(id, game);
  });

  const tournamentById = new Map<string, Record<string, unknown>>();
  toArray(params.tournaments).forEach((tournament) => {
    if (!isRecord(tournament)) return;
    collectCommunityRatingTournamentRecordIds(tournament).forEach((id) => {
      tournamentById.set(id, tournament);
    });
  });

  const visitById = new Map<string, Record<string, unknown>>();
  const directVisitFacts: CommunityRatingFact[] = [];
  toArray(params.visits).forEach((visit) => {
    if (!isRecord(visit)) return;
    collectCommunityRatingVisitRecordIds(visit).forEach((id) => {
      visitById.set(id, visit);
    });
    directVisitFacts.push(...extractVisitFacts({
      communityId,
      post: null,
      visit,
      memberByKey,
      collectedAt,
    }));
  });

  const feedFacts = toArray(params.feedPosts).flatMap((post) => {
    if (!isRecord(post) || post.archived === true) return [];
    const kind = pickString(post, ["kind", "type"]).toUpperCase();

    if (kind === "GAME") {
      const gameId = pickString(post, ["relatedGameId", "gameId"]);
      const game = gameId ? gameById.get(gameId) : null;
      return game
        ? extractGameFacts({ communityId, post, game, memberByKey, ratingLedger, collectedAt })
        : [];
    }

    if (kind === "TOURNAMENT") {
      const tournamentId = resolveCommunityRatingTournamentPostLinkId(post);
      const tournament = tournamentId ? tournamentById.get(tournamentId) : null;
      return tournament
        ? extractTournamentFacts({ communityId, post, tournament, memberByKey, ratingLedger, collectedAt })
        : [];
    }

    if (
      kind === "VISIT"
      || kind === "TRAINING"
      || kind === "GROUP_TRAINING"
      || kind === "ATTENDANCE"
      || kind === "EXERCISE"
    ) {
      const visitId = resolveCommunityRatingVisitPostLinkId(post);
      const visit = visitId ? visitById.get(visitId) : null;
      return extractVisitFacts({
        communityId,
        post,
        visit: visit ?? post,
        memberByKey,
        collectedAt,
      });
    }

    return [];
  });

  const factById = new Map<string, CommunityRatingFact>();
  [...directVisitFacts, ...feedFacts].forEach((fact) => {
    factById.set(fact.id, fact);
  });
  return Array.from(factById.values());
}
