import {
  COMMUNITY_RATING_CALCULATION_VERSION,
  COMMUNITY_RATING_VISIT_SCOPE_BY_COMMUNITY_ID,
  type CommunityRatingPeriod,
  type CommunityRatingTabInput,
} from "./contract.ts";
import {
  COMMUNITY_RATING_COLLECTIONS,
  COMMUNITY_RATING_STORAGE_INDEXES,
  extractCommunityRatingFacts,
  resolveCommunityRatingVisitPostLinkId,
  resolveCommunityRatingTournamentPostLinkId,
  type CommunityRatingFact,
} from "./facts.ts";
import {
  buildCommunityRatingPersistenceBatch,
  getCommunityRatingBatchCollectionOrder,
  type CommunityRatingPersistenceBatch,
} from "./persistence.ts";

export const COMMUNITY_RATING_SOURCE_COLLECTIONS = {
  communities: "lk_communities",
  feed: "lk_community_feed",
  games: "lk_games",
  tournaments: "tournaments",
  visits: "lk_training_visits",
  ratingEvents: "rating_events",
  ratingState: "player_rating_state",
} as const;

export type CommunityRatingSourceCollectionName =
  (typeof COMMUNITY_RATING_SOURCE_COLLECTIONS)[keyof typeof COMMUNITY_RATING_SOURCE_COLLECTIONS];

export type CommunityRatingStorageCollectionName =
  (typeof COMMUNITY_RATING_COLLECTIONS)[keyof typeof COMMUNITY_RATING_COLLECTIONS];

export type CommunityRatingQuery = Record<string, unknown>;

export interface CommunityRatingFindCursor<TDocument> {
  toArray(): Promise<TDocument[]>;
}

export type CommunityRatingFindResult<TDocument> =
  | TDocument[]
  | CommunityRatingFindCursor<TDocument>;

export interface CommunityRatingReadableCollection<TDocument = Record<string, unknown>> {
  find(filter: CommunityRatingQuery): CommunityRatingFindResult<TDocument> | Promise<CommunityRatingFindResult<TDocument>>;
}

export interface CommunityRatingWritableCollection {
  bulkWrite(operations: readonly unknown[], options?: { ordered?: boolean }): Promise<unknown>;
  createIndex?(
    key: Record<string, 1 | -1>,
    options: { name: string; unique?: boolean },
  ): Promise<unknown>;
}

export interface CommunityRatingSourceCollections {
  [COMMUNITY_RATING_SOURCE_COLLECTIONS.communities]: CommunityRatingReadableCollection;
  [COMMUNITY_RATING_SOURCE_COLLECTIONS.feed]: CommunityRatingReadableCollection;
  [COMMUNITY_RATING_SOURCE_COLLECTIONS.games]: CommunityRatingReadableCollection;
  [COMMUNITY_RATING_SOURCE_COLLECTIONS.tournaments]: CommunityRatingReadableCollection;
  [COMMUNITY_RATING_SOURCE_COLLECTIONS.visits]: CommunityRatingReadableCollection;
  [COMMUNITY_RATING_SOURCE_COLLECTIONS.ratingEvents]: CommunityRatingReadableCollection;
  [COMMUNITY_RATING_SOURCE_COLLECTIONS.ratingState]: CommunityRatingReadableCollection;
}

export interface CommunityRatingStorageCollections {
  [COMMUNITY_RATING_COLLECTIONS.facts]: CommunityRatingWritableCollection;
  [COMMUNITY_RATING_COLLECTIONS.aggregates]: CommunityRatingWritableCollection;
  [COMMUNITY_RATING_COLLECTIONS.snapshots]: CommunityRatingWritableCollection;
}

export interface CommunityRatingRecalculationCollections {
  source: CommunityRatingSourceCollections;
  storage: CommunityRatingStorageCollections;
}

export interface CommunityRatingSourceData {
  community: Record<string, unknown>;
  feedPosts: Record<string, unknown>[];
  games: Record<string, unknown>[];
  tournaments: Record<string, unknown>[];
  visits: Record<string, unknown>[];
  ratingEvents: Record<string, unknown>[];
  ratingStates: Record<string, unknown>[];
}

export interface CommunityRatingRecalculationPlan {
  communityId: string;
  source: CommunityRatingSourceData;
  facts: CommunityRatingFact[];
  batch: CommunityRatingPersistenceBatch;
  summary: {
    feedPosts: number;
    games: number;
    tournaments: number;
    visits: number;
    ratingEvents: number;
    ratingStates: number;
    facts: number;
    calculationVersion: string;
  };
}

export interface BuildCommunityRatingRecalculationPlanParams {
  communityId: string;
  source: CommunityRatingSourceData;
  periods?: Array<CommunityRatingPeriod | string> | null;
  tabs?: Array<CommunityRatingTabInput | string> | null;
  nowTs?: number;
  updatedAt?: string | null;
  calculationVersion?: string | null;
}

export interface RecalculateCommunityRatingParams {
  collections: CommunityRatingRecalculationCollections;
  communityId: string;
  periods?: Array<CommunityRatingPeriod | string> | null;
  tabs?: Array<CommunityRatingTabInput | string> | null;
  nowTs?: number;
  updatedAt?: string | null;
  calculationVersion?: string | null;
  dryRun?: boolean;
  ensureIndexes?: boolean;
}

export interface CommunityRatingApplyResult {
  collectionResults: Partial<Record<CommunityRatingStorageCollectionName, unknown>>;
}

export interface CommunityRatingRecalculationResult extends CommunityRatingRecalculationPlan {
  applied: boolean;
  applyResult: CommunityRatingApplyResult | null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

function toStringOrNull(value: unknown): string | null {
  if (value === null || value === undefined) return null;
  const normalized = String(value).trim();
  return normalized ? normalized : null;
}

function pickString(source: Record<string, unknown>, keys: string[]): string | null {
  for (const key of keys) {
    const value = toStringOrNull(source[key]);
    if (value) return value;
  }
  return null;
}

function unique(items: Array<string | null>): string[] {
  return Array.from(new Set(items.filter((item): item is string => Boolean(item))));
}

function hasToArray<TDocument>(value: unknown): value is CommunityRatingFindCursor<TDocument> {
  return isRecord(value) && typeof value.toArray === "function";
}

async function findAll<TDocument extends Record<string, unknown>>(
  collection: CommunityRatingReadableCollection<TDocument>,
  filter: CommunityRatingQuery,
): Promise<TDocument[]> {
  const result = await collection.find(filter);
  if (Array.isArray(result)) return result;
  if (hasToArray<TDocument>(result)) return result.toArray();
  return [];
}

function getPostKind(post: Record<string, unknown>): string {
  return (pickString(post, ["kind", "type"]) ?? "").toUpperCase();
}

function getLinkedGameIds(feedPosts: Record<string, unknown>[]): string[] {
  return unique(feedPosts
    .filter((post) => getPostKind(post) === "GAME")
    .map((post) => pickString(post, ["relatedGameId", "gameId"])));
}

function getLinkedTournamentIds(feedPosts: Record<string, unknown>[]): string[] {
  return unique(feedPosts
    .filter((post) => getPostKind(post) === "TOURNAMENT")
    .map((post) => resolveCommunityRatingTournamentPostLinkId(post)));
}

function isVisitPostKind(post: Record<string, unknown>): boolean {
  const kind = getPostKind(post);
  return (
    kind === "VISIT"
    || kind === "TRAINING"
    || kind === "GROUP_TRAINING"
    || kind === "ATTENDANCE"
    || kind === "EXERCISE"
  );
}

function getLinkedVisitIds(feedPosts: Record<string, unknown>[]): string[] {
  return unique(feedPosts
    .filter((post) => isVisitPostKind(post))
    .map((post) => resolveCommunityRatingVisitPostLinkId(post)));
}

function normalizePhone(value: unknown): string | null {
  const digits = String(value ?? "").replace(/\D/g, "");
  if (!digits) return null;
  if (digits.length === 10) return `7${digits}`;
  if (digits.length === 11 && digits.startsWith("8")) return `7${digits.slice(1)}`;
  return digits;
}

function collectCommunityMemberIdentityValues(community: Record<string, unknown>): { ids: string[]; phones: string[] } {
  const members = Array.isArray(community.members) ? community.members : [];
  const ids: string[] = [];
  const phones: string[] = [];
  members.forEach((member) => {
    if (!isRecord(member)) return;
    const id = pickString(member, ["id", "clientId", "userId", "uuid", "playerId"]);
    const phone = normalizePhone(member.phone ?? member.phoneNorm ?? member.phoneNumber ?? member.mobile);
    if (id) ids.push(id);
    if (phone) phones.push(phone);
  });
  return {
    ids: unique(ids),
    phones: unique(phones),
  };
}

function idOrFilter(ids: string[], fields: string[]): CommunityRatingQuery {
  if (ids.length === 0) return { id: "__none__" };
  return {
    $or: fields.map((field) => ({
      [field]: { $in: ids },
    })),
  };
}

function buildVisitFilter(input: {
  communityId: string;
  visitIds: string[];
  memberIds: string[];
  memberPhones: string[];
  studioIds: readonly string[];
}): CommunityRatingQuery {
  const explicitClauses: CommunityRatingQuery[] = [
    { communityId: input.communityId },
    { relatedCommunityId: input.communityId },
  ];

  if (input.visitIds.length > 0) {
    explicitClauses.push(...[
      "id",
      "visitId",
      "trainingVisitId",
      "attendanceId",
      "bookingId",
      "exerciseId",
      "groupExerciseId",
      "trainingId",
      "sourceExerciseId",
      "relatedExerciseId",
    ].map((field) => ({
      [field]: { $in: input.visitIds },
    })));
  }

  const identityClauses: CommunityRatingQuery[] = [];
  if (input.memberIds.length > 0) {
    identityClauses.push(...[
      "clientId",
      "userId",
      "playerId",
      "memberId",
      "client.id",
      "user.id",
      "member.id",
      "participant.id",
      "participants.id",
      "attendees.id",
      "clients.id",
      "bookings.clientId",
      "bookings.client.id",
    ].map((field) => ({
      [field]: { $in: input.memberIds },
    })));
  }

  if (input.memberPhones.length > 0) {
    identityClauses.push(...[
      "phone",
      "phoneNorm",
      "phoneNumber",
      "mobile",
      "client.phone",
      "client.phoneNorm",
      "user.phone",
      "member.phone",
      "participant.phone",
      "participants.phone",
      "participants.phoneNorm",
      "attendees.phone",
      "attendees.phoneNorm",
      "clients.phone",
      "clients.phoneNorm",
      "bookings.phone",
      "bookings.phoneNorm",
      "bookings.client.phone",
      "bookings.client.phoneNorm",
    ].map((field) => ({
      [field]: { $in: input.memberPhones },
    })));
  }

  const clauses = [...explicitClauses];
  if (input.studioIds.length > 0 && identityClauses.length > 0) {
    clauses.push({
      $and: [
        {
          $or: [
            { studioId: { $in: input.studioIds } },
            { stationId: { $in: input.studioIds } },
            { "exercise.studioId": { $in: input.studioIds } },
            { "exercise.stationId": { $in: input.studioIds } },
          ],
        },
        { $or: identityClauses },
      ],
    });
  }

  return {
    archived: { $ne: true },
    $or: clauses,
  };
}

export async function collectCommunityRatingSourceData(
  collections: CommunityRatingSourceCollections,
  communityId: string,
): Promise<CommunityRatingSourceData | null> {
  const normalizedCommunityId = communityId.trim();
  if (!normalizedCommunityId) return null;

  const communities = await findAll(collections.lk_communities, {
    id: normalizedCommunityId,
    archived: { $ne: true },
  });
  const community = communities[0] ?? null;
  if (!community) return null;

  const feedPosts = await findAll(collections.lk_community_feed, {
    communityId: normalizedCommunityId,
    archived: { $ne: true },
    kind: { $in: ["GAME", "TOURNAMENT", "VISIT", "TRAINING", "GROUP_TRAINING", "ATTENDANCE", "EXERCISE"] },
  });
  const gameIds = getLinkedGameIds(feedPosts);
  const tournamentIds = getLinkedTournamentIds(feedPosts);
  const visitIds = getLinkedVisitIds(feedPosts);
  const memberIdentity = collectCommunityMemberIdentityValues(community);

  const games = await findAll(collections.lk_games, {
    ...idOrFilter(gameIds, ["id", "gameId"]),
    archived: { $ne: true },
  });
  const tournaments = await findAll(collections.tournaments, {
    ...idOrFilter(tournamentIds, ["tournamentId", "id", "exerciseId", "sourceTournamentId"]),
    archived: { $ne: true },
  });
  const visits = await findAll(collections.lk_training_visits, buildVisitFilter({
    communityId: normalizedCommunityId,
    visitIds,
    memberIds: memberIdentity.ids,
    memberPhones: memberIdentity.phones,
    studioIds: COMMUNITY_RATING_VISIT_SCOPE_BY_COMMUNITY_ID[normalizedCommunityId] ?? [],
  }));
  const ratingStates = await findAll(collections.player_rating_state, {
    $or: [
      ...(memberIdentity.ids.length > 0 ? [
        { clientId: { $in: memberIdentity.ids } },
        { "identityAliases.clientIds": { $in: memberIdentity.ids } },
      ] : []),
      ...(memberIdentity.phones.length > 0 ? [
        { phoneNorm: { $in: memberIdentity.phones } },
        { "identityAliases.phoneNorms": { $in: memberIdentity.phones } },
      ] : []),
      ...((memberIdentity.ids.length === 0 && memberIdentity.phones.length === 0)
        ? [{ playerKey: "__none__" }]
        : []),
    ],
  });
  const ratingEvents = await findAll(collections.rating_events, {
    $or: [
      ...(gameIds.length > 0 ? [
        { "source.domain": "GAME_RESULT", "source.sourceId": { $in: gameIds } },
      ] : []),
      ...(tournamentIds.length > 0 ? [
        { "source.domain": "TOURNAMENT", "source.sourceId": { $in: tournamentIds } },
      ] : []),
      ...((gameIds.length === 0 && tournamentIds.length === 0)
        ? [{ _id: "__none__" }]
        : []),
    ],
  });

  return {
    community,
    feedPosts,
    games,
    tournaments,
    visits,
    ratingEvents,
    ratingStates,
  };
}

export function buildCommunityRatingRecalculationPlan(
  params: BuildCommunityRatingRecalculationPlanParams,
): CommunityRatingRecalculationPlan {
  const communityId = params.communityId.trim();
  const calculationVersion = params.calculationVersion || COMMUNITY_RATING_CALCULATION_VERSION;
  const updatedAt = params.updatedAt || new Date(params.nowTs ?? Date.now()).toISOString();
  const facts = extractCommunityRatingFacts({
    community: params.source.community,
    feedPosts: params.source.feedPosts,
    games: params.source.games,
    tournaments: params.source.tournaments,
    visits: params.source.visits,
    ratingEvents: params.source.ratingEvents,
    ratingStates: params.source.ratingStates,
    collectedAt: updatedAt,
  }).filter((fact) => fact.calculationVersion === calculationVersion);
  const batch = buildCommunityRatingPersistenceBatch({
    communityId,
    facts,
    periods: params.periods,
    tabs: params.tabs,
    nowTs: params.nowTs,
    updatedAt,
    calculationVersion,
  });

  return {
    communityId,
    source: params.source,
    facts,
    batch,
    summary: {
      feedPosts: params.source.feedPosts.length,
      games: params.source.games.length,
      tournaments: params.source.tournaments.length,
      visits: params.source.visits.length,
      ratingEvents: params.source.ratingEvents.length,
      ratingStates: params.source.ratingStates.length,
      facts: facts.length,
      calculationVersion,
    },
  };
}

export async function ensureCommunityRatingStorageIndexes(
  storageCollections: CommunityRatingStorageCollections,
): Promise<void> {
  for (const index of COMMUNITY_RATING_STORAGE_INDEXES) {
    const collection = storageCollections[index.collection];
    if (!collection.createIndex) continue;
    const options: { name: string; unique?: boolean } = {
      name: index.name,
    };
    if (index.unique === true) {
      options.unique = true;
    }
    await collection.createIndex(index.key, options);
  }
}

export async function applyCommunityRatingPersistenceBatch(
  batch: CommunityRatingPersistenceBatch,
  storageCollections: CommunityRatingStorageCollections,
): Promise<CommunityRatingApplyResult> {
  const collectionResults: Partial<Record<CommunityRatingStorageCollectionName, unknown>> = {};

  for (const collectionName of getCommunityRatingBatchCollectionOrder()) {
    const operations = batch.operations[collectionName];
    if (operations.length === 0) {
      collectionResults[collectionName] = null;
      continue;
    }
    collectionResults[collectionName] = await storageCollections[collectionName].bulkWrite(operations, {
      ordered: batch.ordered,
    });
  }

  return { collectionResults };
}

export async function recalculateCommunityRating(
  params: RecalculateCommunityRatingParams,
): Promise<CommunityRatingRecalculationResult | null> {
  const source = await collectCommunityRatingSourceData(params.collections.source, params.communityId);
  if (!source) return null;

  const plan = buildCommunityRatingRecalculationPlan({
    communityId: params.communityId,
    source,
    periods: params.periods,
    tabs: params.tabs,
    nowTs: params.nowTs,
    updatedAt: params.updatedAt,
    calculationVersion: params.calculationVersion,
  });

  if (params.dryRun) {
    return {
      ...plan,
      applied: false,
      applyResult: null,
    };
  }

  if (params.ensureIndexes !== false) {
    await ensureCommunityRatingStorageIndexes(params.collections.storage);
  }

  const applyResult = await applyCommunityRatingPersistenceBatch(plan.batch, params.collections.storage);
  return {
    ...plan,
    applied: true,
    applyResult,
  };
}
