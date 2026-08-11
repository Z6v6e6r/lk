import test from "node:test";
import assert from "node:assert/strict";
import {
  buildCommunityRatingPersistenceBatch,
  getCommunityRatingBatchCollectionOrder,
  COMMUNITY_RATING_CALCULATION_VERSION,
  COMMUNITY_RATING_COLLECTIONS,
  type CommunityRatingFact,
} from "../../src/services/community-rating/index.ts";

const NOW_TS = Date.parse("2026-05-29T12:00:00.000Z");
const UPDATED_AT = "2026-05-29T12:00:00.000Z";

function gameFact(options: {
  id: string;
  eventId: string;
  playerKey: string;
  playerId: string;
  playerName: string;
  occurredAt: string;
  levelDelta?: number;
}): CommunityRatingFact {
  const occurredAtTs = Date.parse(options.occurredAt);
  return {
    id: options.id,
    communityId: "community-1",
    sourcePostId: `post-${options.eventId}`,
    eventType: "game",
    eventId: options.eventId,
    playerKey: options.playerKey,
    playerId: options.playerId,
    playerPhone: null,
    playerName: options.playerName,
    playerAvatarUrl: null,
    currentLevel: 4,
    ratingDelta: options.levelDelta ?? 0.01,
    ratingEventIds: [],
    lastRatingDelta: options.levelDelta ?? 0.01,
    lastRatingChangedAt: options.occurredAt,
    lastRatingChangedAtTs: occurredAtTs,
    lastRatingEventId: `rating-${options.eventId}`,
    occurredAt: options.occurredAt,
    occurredAtTs,
    calculationVersion: COMMUNITY_RATING_CALCULATION_VERSION,
    collectedAt: UPDATED_AT,
    metrics: {
      gamesPlayed: 1,
      gamesWon: 1,
      gamesLost: 0,
      setsWon: 2,
      setsLost: 1,
      gamesWonCount: 12,
      gamesLostCount: 8,
      gamesDiff: 4,
      levelDelta: options.levelDelta ?? 0.01,
    },
  };
}

test("community rating batch collection order is write-safe", () => {
  assert.deepEqual(getCommunityRatingBatchCollectionOrder(), [
    COMMUNITY_RATING_COLLECTIONS.facts,
    COMMUNITY_RATING_COLLECTIONS.aggregates,
    COMMUNITY_RATING_COLLECTIONS.snapshots,
  ]);
});

test("builds idempotent bulk operations for facts, aggregates, and snapshots", () => {
  const facts = [
    gameFact({
      id: "fact-1",
      eventId: "game-1",
      playerKey: "id:p1",
      playerId: "p1",
      playerName: "Анна",
      occurredAt: "2026-05-25T12:00:00.000Z",
    }),
    gameFact({
      id: "fact-1",
      eventId: "game-1",
      playerKey: "id:p1",
      playerId: "p1",
      playerName: "Анна",
      occurredAt: "2026-05-25T12:00:00.000Z",
      levelDelta: 0.02,
    }),
    gameFact({
      id: "foreign-fact",
      eventId: "game-foreign",
      playerKey: "id:external",
      playerId: "external",
      playerName: "Не это сообщество",
      occurredAt: "2026-05-25T12:00:00.000Z",
    }),
  ];
  facts[2] = {
    ...facts[2],
    communityId: "another-community",
  };

  const batch = buildCommunityRatingPersistenceBatch({
    communityId: "community-1",
    facts,
    periods: ["30d", "all"],
    tabs: ["overall", "games"],
    nowTs: NOW_TS,
    updatedAt: UPDATED_AT,
  });

  assert.equal(batch.ordered, true);
  assert.equal(batch.summary.factDeletes, 1);
  assert.equal(batch.summary.factsUpserts, 1);
  assert.equal(batch.summary.aggregateDeletes, 2);
  assert.equal(batch.summary.aggregateUpserts, 2);
  assert.equal(batch.summary.snapshotUpserts, 4);

  assert.deepEqual(batch.operations.community_rating_facts[0], {
    deleteMany: {
      filter: {
        communityId: "community-1",
        calculationVersion: COMMUNITY_RATING_CALCULATION_VERSION,
      },
    },
  });

  const factOperation = batch.operations.community_rating_facts[1];
  assert.ok("replaceOne" in factOperation);
  assert.deepEqual(factOperation?.replaceOne.filter, {
    communityId: "community-1",
    eventType: "game",
    eventId: "game-1",
    playerKey: "id:p1",
    calculationVersion: COMMUNITY_RATING_CALCULATION_VERSION,
  });
  assert.equal(factOperation?.replaceOne.replacement.metrics.levelDelta, 0.02);
  assert.equal(factOperation?.replaceOne.upsert, true);

  const aggregateDelete = batch.operations.community_rating_player_aggregates[0];
  assert.deepEqual(aggregateDelete, {
    deleteMany: {
      filter: {
        communityId: "community-1",
        period: "30d",
        calculationVersion: COMMUNITY_RATING_CALCULATION_VERSION,
      },
    },
  });

  const aggregateUpsert = batch.operations.community_rating_player_aggregates[1];
  assert.ok("replaceOne" in aggregateUpsert);
  assert.deepEqual(aggregateUpsert.replaceOne.filter, {
    communityId: "community-1",
    period: "30d",
    playerKey: "id:p1",
    calculationVersion: COMMUNITY_RATING_CALCULATION_VERSION,
  });
  assert.equal(aggregateUpsert.replaceOne.replacement.gamesPlayed, 1);
  assert.equal(aggregateUpsert.replaceOne.replacement.levelDelta, 0.02);
  assert.equal(aggregateUpsert.replaceOne.replacement.lastRatingDelta, 0.02);
  assert.equal(aggregateUpsert.replaceOne.replacement.lastRatingChangedAt, "2026-05-25T12:00:00.000Z");

  const snapshotOperation = batch.operations.community_rating_snapshots[0];
  assert.deepEqual(snapshotOperation?.replaceOne.filter, {
    communityId: "community-1",
    period: "30d",
    tab: "overall",
    calculationVersion: COMMUNITY_RATING_CALCULATION_VERSION,
  });
  assert.equal(snapshotOperation?.replaceOne.replacement.rows.length, 1);
  assert.equal(snapshotOperation?.replaceOne.replacement.rows[0]?.rank, 1);
  assert.equal(snapshotOperation?.replaceOne.replacement.rows[0]?.lastRatingDelta, 0.02);
});

test("empty recalculation still deletes stale aggregates and writes empty snapshots", () => {
  const batch = buildCommunityRatingPersistenceBatch({
    communityId: "community-1",
    facts: [],
    periods: ["30d"],
    tabs: ["overall"],
    nowTs: NOW_TS,
    updatedAt: UPDATED_AT,
  });

  assert.equal(batch.summary.factDeletes, 1);
  assert.equal(batch.summary.factsUpserts, 0);
  assert.equal(batch.summary.aggregateDeletes, 1);
  assert.equal(batch.summary.aggregateUpserts, 0);
  assert.equal(batch.summary.snapshotUpserts, 1);
  assert.deepEqual(batch.operations.community_rating_player_aggregates[0], {
    deleteMany: {
      filter: {
        communityId: "community-1",
        period: "30d",
        calculationVersion: COMMUNITY_RATING_CALCULATION_VERSION,
      },
    },
  });
  assert.deepEqual(batch.operations.community_rating_facts[0], {
    deleteMany: {
      filter: {
        communityId: "community-1",
        calculationVersion: COMMUNITY_RATING_CALCULATION_VERSION,
      },
    },
  });
  assert.equal(batch.operations.community_rating_snapshots[0]?.replaceOne.replacement.rows.length, 0);
});

test("persists member-only rating rows without creating synthetic facts", () => {
  const batch = buildCommunityRatingPersistenceBatch({
    communityId: "community-1",
    facts: [],
    members: [{
      playerKey: "id:p-base",
      playerId: "p-base",
      playerPhone: null,
      playerName: "Новый участник",
      playerAvatarUrl: null,
      currentLevel: 4.25,
    }],
    periods: ["30d", "all"],
    tabs: ["overall"],
    nowTs: NOW_TS,
    updatedAt: UPDATED_AT,
  });

  assert.equal(batch.summary.factsUpserts, 0);
  assert.equal(batch.summary.aggregateUpserts, 2);
  assert.equal(batch.summary.snapshotUpserts, 2);
  assert.equal(batch.operations.community_rating_facts.length, 1);
  assert.equal(batch.operations.community_rating_snapshots[0]?.replaceOne.replacement.rows[0]?.playerId, "p-base");
  assert.equal(batch.operations.community_rating_snapshots[0]?.replaceOne.replacement.rows[0]?.totalEventsPlayed, 0);
});
