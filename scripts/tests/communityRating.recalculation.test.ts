import test from "node:test";
import assert from "node:assert/strict";
import {
  COMMUNITY_RATING_COLLECTIONS,
  COMMUNITY_RATING_SOURCE_COLLECTIONS,
  collectCommunityRatingSourceData,
  recalculateCommunityRating,
  type CommunityRatingQuery,
  type CommunityRatingReadableCollection,
  type CommunityRatingRecalculationCollections,
  type CommunityRatingWritableCollection,
} from "../../src/services/community-rating/index.ts";

const NOW_TS = Date.parse("2026-05-29T12:00:00.000Z");
const UPDATED_AT = "2026-05-29T12:00:00.000Z";

class FakeReadableCollection implements CommunityRatingReadableCollection {
  readonly filters: CommunityRatingQuery[] = [];
  private readonly rows: Record<string, unknown>[];

  constructor(rows: Record<string, unknown>[]) {
    this.rows = rows;
  }

  find(filter: CommunityRatingQuery) {
    this.filters.push(filter);
    return {
      toArray: async () => this.rows,
    };
  }
}

class FakeWritableCollection implements CommunityRatingWritableCollection {
  readonly bulkWrites: Array<{ operations: readonly unknown[]; options?: { ordered?: boolean } }> = [];
  readonly indexes: Array<{ key: Record<string, 1 | -1>; options: { name: string; unique?: boolean } }> = [];

  async bulkWrite(operations: readonly unknown[], options?: { ordered?: boolean }) {
    this.bulkWrites.push({ operations, options });
    return { ok: 1, n: operations.length };
  }

  async createIndex(key: Record<string, 1 | -1>, options: { name: string; unique?: boolean }) {
    this.indexes.push({ key, options });
    return options.name;
  }
}

function buildCollections(): {
  collections: CommunityRatingRecalculationCollections;
  source: Record<string, FakeReadableCollection>;
  storage: Record<string, FakeWritableCollection>;
} {
  const source = {
    [COMMUNITY_RATING_SOURCE_COLLECTIONS.communities]: new FakeReadableCollection([{
      id: "community-1",
      members: [
        { id: "p1", name: "Анна", levelScore: 4.1 },
        { id: "p2", name: "Борис", levelScore: 3.9 },
      ],
    }]),
    [COMMUNITY_RATING_SOURCE_COLLECTIONS.feed]: new FakeReadableCollection([
      {
        id: "post-game-1",
        communityId: "community-1",
        kind: "GAME",
        relatedGameId: "game-1",
        createdAt: "2026-05-28T12:00:00.000Z",
      },
      {
        id: "post-tournament-1",
        communityId: "community-1",
        kind: "TOURNAMENT",
        relatedTournamentId: "tournament-1",
        createdAt: "2026-05-28T13:00:00.000Z",
      },
    ]),
    [COMMUNITY_RATING_SOURCE_COLLECTIONS.games]: new FakeReadableCollection([{
      id: "game-1",
      participants: [
        { id: "p1", name: "Анна", levelScore: 4.1 },
        { id: "p2", name: "Борис", levelScore: 3.9 },
      ],
      metadata: {
        teamSlots: ["p1", "p2"],
        matchResult: {
          status: "CONFIRMED",
          sets: [{ left: 6, right: 4 }, { left: 6, right: 3 }],
          ratingImpact: [
            { id: "p1", delta: 0.03 },
            { id: "p2", delta: -0.03 },
          ],
        },
      },
      updatedAt: "2026-05-28T12:30:00.000Z",
    }]),
    [COMMUNITY_RATING_SOURCE_COLLECTIONS.tournaments]: new FakeReadableCollection([{
      tournamentId: "tournament-1",
      summary: {
        finishedAt: "2026-05-28T14:00:00.000Z",
      },
      standings: [
        { id: "p1", name: "Анна", place: 1, wins: 3, pointsFor: 24, pointsAgainst: 15 },
        { id: "p2", name: "Борис", place: 2, wins: 2, pointsFor: 20, pointsAgainst: 18 },
      ],
      updatedAt: "2026-05-28T14:00:00.000Z",
    }]),
    [COMMUNITY_RATING_SOURCE_COLLECTIONS.visits]: new FakeReadableCollection([{
      id: "visit-1",
      visitConfirmed: true,
      timeToIso: "2026-05-28T15:00:00.000Z",
      client: {
        id: "p1",
        name: "Анна",
        levelScore: 4.1,
      },
    }]),
    [COMMUNITY_RATING_SOURCE_COLLECTIONS.ratingEvents]: new FakeReadableCollection([
      {
        id: "rating-game-p1",
        source: { domain: "GAME_RESULT", sourceId: "game-1" },
        player: { clientId: "p1", name: "Анна" },
        change: { delta: 0.03 },
      },
      {
        id: "rating-tournament-p1",
        source: { domain: "TOURNAMENT", sourceId: "tournament-1" },
        player: { clientId: "p1", name: "Анна" },
        change: { delta: 0.08 },
      },
    ]),
    [COMMUNITY_RATING_SOURCE_COLLECTIONS.ratingState]: new FakeReadableCollection([
      { clientId: "p1", ratingNumeric: 4.21 },
      { clientId: "p2", ratingNumeric: 3.82 },
    ]),
  };
  const storage = {
    [COMMUNITY_RATING_COLLECTIONS.facts]: new FakeWritableCollection(),
    [COMMUNITY_RATING_COLLECTIONS.aggregates]: new FakeWritableCollection(),
    [COMMUNITY_RATING_COLLECTIONS.snapshots]: new FakeWritableCollection(),
  };

  return {
    source,
    storage,
    collections: { source, storage },
  };
}

test("collects community rating source data from published game and tournament posts", async () => {
  const { source } = buildCollections();
  const result = await collectCommunityRatingSourceData(source, "community-1");

  assert.equal(result?.feedPosts.length, 2);
  assert.equal(result?.games.length, 1);
  assert.equal(result?.tournaments.length, 1);
  assert.equal(result?.visits.length, 1);
  assert.deepEqual(source.lk_community_feed.filters[0], {
    communityId: "community-1",
    archived: { $ne: true },
    kind: { $in: ["GAME", "TOURNAMENT", "VISIT", "TRAINING", "GROUP_TRAINING", "ATTENDANCE", "EXERCISE"] },
  });
  assert.deepEqual(source.lk_games.filters[0], {
    $or: [
      { id: { $in: ["game-1"] } },
      { gameId: { $in: ["game-1"] } },
    ],
    archived: { $ne: true },
  });
  assert.deepEqual(source.tournaments.filters[0], {
    $or: [
      { tournamentId: { $in: ["tournament-1"] } },
      { id: { $in: ["tournament-1"] } },
      { exerciseId: { $in: ["tournament-1"] } },
      { sourceTournamentId: { $in: ["tournament-1"] } },
    ],
    archived: { $ne: true },
  });
  assert.equal(source.lk_training_visits.filters[0]?.archived?.$ne, true);
  assert.ok(Array.isArray(source.lk_training_visits.filters[0]?.$or));
});

test("collects tournament source data from stable nested tournament details and skips legacy mongo ids", async () => {
  const source = {
    [COMMUNITY_RATING_SOURCE_COLLECTIONS.communities]: new FakeReadableCollection([{
      id: "community-1",
      members: [{ id: "p1", name: "Анна", levelScore: 4.1 }],
    }]),
    [COMMUNITY_RATING_SOURCE_COLLECTIONS.feed]: new FakeReadableCollection([
      {
        id: "post-tournament-stable",
        communityId: "community-1",
        kind: "TOURNAMENT",
        details: {
          tournamentId: "69ebc77e919db56dbec04d71",
          publicTournament: {
            exerciseId: "tournament-stable",
          },
        },
        createdAt: "2026-05-28T13:00:00.000Z",
      },
      {
        id: "post-tournament-legacy",
        communityId: "community-1",
        kind: "TOURNAMENT",
        details: {
          tournamentId: "69ebc77e919db56dbec04d72",
        },
        createdAt: "2026-05-28T13:05:00.000Z",
      },
    ]),
    [COMMUNITY_RATING_SOURCE_COLLECTIONS.games]: new FakeReadableCollection([]),
    [COMMUNITY_RATING_SOURCE_COLLECTIONS.tournaments]: new FakeReadableCollection([{
      tournamentId: "tournament-stable",
      standings: [],
    }]),
    [COMMUNITY_RATING_SOURCE_COLLECTIONS.visits]: new FakeReadableCollection([]),
    [COMMUNITY_RATING_SOURCE_COLLECTIONS.ratingEvents]: new FakeReadableCollection([]),
    [COMMUNITY_RATING_SOURCE_COLLECTIONS.ratingState]: new FakeReadableCollection([]),
  };

  const result = await collectCommunityRatingSourceData(source, "community-1");

  assert.equal(result?.feedPosts.length, 2);
  assert.equal(result?.tournaments.length, 1);
  assert.equal(result?.visits.length, 0);
  assert.deepEqual(source.tournaments.filters[0], {
    $or: [
      { tournamentId: { $in: ["tournament-stable"] } },
      { id: { $in: ["tournament-stable"] } },
      { exerciseId: { $in: ["tournament-stable"] } },
      { sourceTournamentId: { $in: ["tournament-stable"] } },
    ],
    archived: { $ne: true },
  });
});

test("recalculates community rating and writes facts, aggregates, and snapshots in order", async () => {
  const { collections, storage } = buildCollections();
  const result = await recalculateCommunityRating({
    collections,
    communityId: "community-1",
    periods: ["30d"],
    tabs: ["overall", "games"],
    nowTs: NOW_TS,
    updatedAt: UPDATED_AT,
  });

  assert.ok(result);
  assert.equal(result.applied, true);
  assert.equal(result.summary.feedPosts, 2);
  assert.equal(result.summary.games, 1);
  assert.equal(result.summary.tournaments, 1);
  assert.equal(result.summary.visits, 1);
  assert.equal(result.summary.facts, 5);
  assert.equal(result.batch.summary.factsUpserts, 5);
  assert.equal(result.batch.summary.aggregateDeletes, 1);
  assert.equal(result.batch.summary.aggregateUpserts, 2);
  assert.equal(result.batch.summary.snapshotUpserts, 2);

  assert.equal(storage.community_rating_facts.bulkWrites.length, 1);
  assert.equal(storage.community_rating_player_aggregates.bulkWrites.length, 1);
  assert.equal(storage.community_rating_snapshots.bulkWrites.length, 1);
  assert.equal(storage.community_rating_facts.bulkWrites[0]?.operations.length, 6);
  assert.equal(storage.community_rating_player_aggregates.bulkWrites[0]?.operations.length, 3);
  assert.equal(storage.community_rating_snapshots.bulkWrites[0]?.operations.length, 2);
  assert.equal(storage.community_rating_facts.bulkWrites[0]?.options?.ordered, true);
  assert.ok(storage.community_rating_snapshots.indexes.some((item) => item.options.name === "uniq_rating_snapshot_tab_period_version"));
});

test("dry run builds recalculation batch without storage writes or indexes", async () => {
  const { collections, storage } = buildCollections();
  const result = await recalculateCommunityRating({
    collections,
    communityId: "community-1",
    periods: ["30d"],
    tabs: ["overall"],
    nowTs: NOW_TS,
    updatedAt: UPDATED_AT,
    dryRun: true,
  });

  assert.ok(result);
  assert.equal(result.applied, false);
  assert.equal(result.batch.summary.snapshotUpserts, 1);
  assert.equal(storage.community_rating_facts.bulkWrites.length, 0);
  assert.equal(storage.community_rating_facts.indexes.length, 0);
});
