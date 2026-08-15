import assert from "node:assert/strict";
import test from "node:test";
import {
  buildCommunityRatingPostcheckReport,
  extractActiveCommunityIds,
} from "../lib/communityRatingPostcheck.mjs";

const COMMUNITY_RATING_PERIODS = ["all", "30d"];
const COMMUNITY_RATING_TABS = ["overall", "dynamics", "games", "tournaments"];
const COMMUNITY_RATING_OVERALL_WEIGHTS = {
  games: 0.2,
  tournaments: 0.6,
  activity: 0.2,
};

const rowSnapshot = ({
  communityId,
  period,
  tab,
  gamesNormalized = 0,
  tournamentNormalized = 0,
  activityScore = 0,
  lastRatingDelta = 0.11,
  lastRatingChangedAt = "2026-08-15T00:00:00.000Z",
  itemOverrides = {},
}) => {
  const overallScore = 0.2 * gamesNormalized + 0.6 * tournamentNormalized + 0.2 * activityScore;
  return {
    communityId,
    period,
    tab,
    items: [{
      gamesNormalized,
      tournamentNormalized,
      activityScore,
      overallScore,
      lastRatingDelta,
      lastRatingChangedAt,
      ...itemOverrides,
    }],
  };
};

const communityRows = (values) => values.map((value) => ({ id: value }));

test("postcheck report treats orphan snapshots as non-blocking and reports safe aggregates", () => {
  const activeRows = communityRows(["active-a", "active-b", "active-c"]);
  const activeSnapshots = activeRows.flatMap((row) => COMMUNITY_RATING_PERIODS.flatMap((period) => (
    COMMUNITY_RATING_TABS.map((tab) => rowSnapshot({
      communityId: row.id,
      period,
      tab,
      gamesNormalized: 40,
      tournamentNormalized: 60,
      activityScore: 20,
    }))
  )));
  const orphanSnapshots = [0, 1, 2].flatMap((index) => COMMUNITY_RATING_PERIODS.flatMap((period) => (
    COMMUNITY_RATING_TABS.map((tab) => rowSnapshot({
      communityId: ` orphan-${index} `,
      period,
      tab,
      gamesNormalized: 10,
      tournamentNormalized: 20,
      activityScore: 30,
      itemOverrides: {
        overallScore: 123,
      },
    }))
  )));
  delete orphanSnapshots[0].items[0].lastRatingChangedAt;
  const report = buildCommunityRatingPostcheckReport({
    activeCommunityRows: activeRows,
    snapshotRows: [...activeSnapshots, ...orphanSnapshots],
    periods: COMMUNITY_RATING_PERIODS,
    tabs: COMMUNITY_RATING_TABS,
    overallWeights: COMMUNITY_RATING_OVERALL_WEIGHTS,
    calculationVersion: "community-rating-v1.x-test",
  });

  assert.equal(report.ok, true);
  assert.equal(report.activeCommunities, 3);
  assert.equal(report.expectedSnapshots, 24);
  assert.equal(report.activeSnapshots, 24);
  assert.equal(report.orphanSnapshots, 24);
  assert.equal(report.orphanSnapshotCommunities, 3);
  assert.equal(report.snapshotsMissingCommunityId, 0);
  assert.equal(Object.hasOwn(report, "activeCommunityIds"), false);
  assert.equal(Object.hasOwn(report, "orphanCommunityIds"), false);
});

test("extractActiveCommunityIds supports id/communityId fallback, trims, deduplicates and ignores archived rows", () => {
  const ids = extractActiveCommunityIds([
    { id: " A ", archived: false },
    { communityId: "B", archived: false },
    { id: "A", archived: false },
    { communityId: " C ", archived: false },
    { communityId: "c", archived: true },
    { id: "   ", archived: false },
    { communityId: null, archived: false },
  ]);

  assert.deepEqual(ids, ["A", "B", "C"]);
});

test("postcheck report fails closed when active snapshot is missing canonical communityId", () => {
  const report = buildCommunityRatingPostcheckReport({
    activeCommunityRows: communityRows(["active-a"]),
    snapshotRows: [{
      period: "all",
      tab: "overall",
      items: [rowSnapshot({
        communityId: "active-a",
        period: "all",
        tab: "overall",
        gamesNormalized: 10,
        tournamentNormalized: 10,
        activityScore: 10,
      }).items[0]],
    }],
    periods: ["all"],
    tabs: ["overall"],
    overallWeights: COMMUNITY_RATING_OVERALL_WEIGHTS,
    calculationVersion: "community-rating-v1.x-test",
  });
  assert.equal(report.ok, false);
  assert.equal(report.snapshotsMissingCommunityId, 1);
  assert.equal(report.activeSnapshots, 0);
});

test("postcheck report fails when active snapshot key is missing", () => {
  const report = buildCommunityRatingPostcheckReport({
    activeCommunityRows: communityRows(["active-a"]),
    snapshotRows: [
      rowSnapshot({ communityId: "active-a", period: "all", tab: "overall" }),
      rowSnapshot({ communityId: "active-a", period: "all", tab: "dynamics" }),
      rowSnapshot({ communityId: "active-a", period: "all", tab: "games" }),
    ],
    periods: ["all"],
    tabs: ["overall", "dynamics", "games", "tournaments"],
    overallWeights: COMMUNITY_RATING_OVERALL_WEIGHTS,
    calculationVersion: "community-rating-v1.x-test",
  });

  assert.equal(report.ok, false);
  assert.equal(report.activeSnapshots, 3);
  assert.equal(report.expectedSnapshots, 4);
  assert.equal(report.uniqueSnapshotKeys, 3);
});

test("postcheck report fails when active snapshot key is duplicated", () => {
  const activeRows = communityRows(["active-a", "active-b"]);
  const snapshotRows = [
    rowSnapshot({ communityId: "active-a", period: "all", tab: "overall", gamesNormalized: 1, tournamentNormalized: 1, activityScore: 1 }),
    rowSnapshot({ communityId: "active-a", period: "all", tab: "overall", gamesNormalized: 1, tournamentNormalized: 1, activityScore: 1 }),
    rowSnapshot({ communityId: "active-a", period: "all", tab: "games", gamesNormalized: 1, tournamentNormalized: 1, activityScore: 1 }),
    rowSnapshot({ communityId: "active-b", period: "all", tab: "games", gamesNormalized: 1, tournamentNormalized: 1, activityScore: 1 }),
  ];
  const report = buildCommunityRatingPostcheckReport({
    activeCommunityRows: activeRows,
    snapshotRows,
    periods: ["all"],
    tabs: ["overall", "games"],
    overallWeights: COMMUNITY_RATING_OVERALL_WEIGHTS,
    calculationVersion: "community-rating-v1.x-test",
  });
  assert.equal(report.ok, false);
  assert.equal(report.activeSnapshots, 4);
  assert.equal(report.uniqueSnapshotKeys, 3);
  assert.equal(report.expectedSnapshots, 4);
});

test("postcheck report tracks snapshots without communityId as fail-closed", () => {
  const report = buildCommunityRatingPostcheckReport({
    activeCommunityRows: communityRows(["active-a"]),
    snapshotRows: [rowSnapshot({ communityId: "   ", period: "all", tab: "overall" })],
    periods: ["all"],
    tabs: ["overall", "dynamics"],
    overallWeights: COMMUNITY_RATING_OVERALL_WEIGHTS,
    calculationVersion: "community-rating-v1.x-test",
  });
  assert.equal(report.ok, false);
  assert.equal(report.snapshotsMissingCommunityId, 1);
  assert.equal(report.activeSnapshots, 0);
});

test("postcheck report keeps formula and last-change validations active-only", () => {
  const report = buildCommunityRatingPostcheckReport({
    activeCommunityRows: communityRows(["active-a"]),
    snapshotRows: (() => {
      const first = rowSnapshot({
        communityId: "active-a",
        period: "all",
        tab: "overall",
        gamesNormalized: 10,
        tournamentNormalized: 30,
        activityScore: 20,
      });
      const second = rowSnapshot({
        communityId: "active-a",
        period: "all",
        tab: "overall",
        gamesNormalized: 1,
        tournamentNormalized: 2,
        activityScore: 3,
        itemOverrides: {
          overallScore: -100,
          lastRatingDelta: 0.2,
        },
      });
      delete first.items[0].lastRatingChangedAt;
      return [first, second];
    })(),
    periods: ["all"],
    tabs: ["overall"],
    overallWeights: COMMUNITY_RATING_OVERALL_WEIGHTS,
    calculationVersion: "community-rating-v1.x-test",
  });
  assert.equal(report.ok, false);
  assert.equal(report.itemsMissingLastChangeFields, 1);
  assert.equal(report.overallFormulaMismatches, 1);
  assert.equal(report.overallRowsWithLastRatingChange > 0, true);
});

test("postcheck report preserves three-digit overall formula rounding", () => {
  const report = buildCommunityRatingPostcheckReport({
    activeCommunityRows: communityRows(["active-a"]),
    snapshotRows: [rowSnapshot({
      communityId: "active-a",
      period: "all",
      tab: "overall",
      gamesNormalized: 1.00245,
      tournamentNormalized: 1,
      activityScore: 1,
      itemOverrides: { overallScore: 0.99925 },
    })],
    periods: ["all"],
    tabs: ["overall"],
    overallWeights: COMMUNITY_RATING_OVERALL_WEIGHTS,
    calculationVersion: "community-rating-v1.x-test",
  });

  assert.equal(report.ok, true);
  assert.equal(report.overallFormulaMismatches, 0);
});
