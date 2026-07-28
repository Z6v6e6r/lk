import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";

const rankingScreenSource = fs.readFileSync("src/components/cabinet/community-feed/CommunityRankingScreen.tsx", "utf8");
const communitiesSectionSource = fs.readFileSync("src/components/cabinet/CommunitiesSection.tsx", "utf8");
const ratingBreakdownSource = fs.readFileSync("src/components/levels-info/RatingBreakdownPage.tsx", "utf8");
const communityApiSource = fs.readFileSync("src/utils/communityApi.ts", "utf8");

test("community ranking screen exposes only all-time and last-month period controls", () => {
  assert.match(rankingScreenSource, /RATING_PERIOD_OPTIONS/);
  assert.match(rankingScreenSource, /id: "all", label: "Все время"/);
  assert.match(rankingScreenSource, /id: "30d", label: "Месяц"/);
  assert.match(rankingScreenSource, /activePeriod === option\.id/);
  assert.match(rankingScreenSource, /onChangePeriod\(option\.id\)/);
});

test("community ranking frontend requests and caches by period plus rating type", () => {
  assert.match(communitiesSectionSource, /const COMMUNITY_RATING_DEFAULT_PERIOD: CommunityRatingPeriod = "all"/);
  assert.match(communitiesSectionSource, /activeRankingPeriod/);
  assert.match(communitiesSectionSource, /period: activeRankingPeriod/);
  assert.match(communitiesSectionSource, /type CommunityRankingCacheKey = `\$\{CommunityRatingPeriod\}:\$\{CommunityRankingTypeId\}`/);
  assert.match(communitiesSectionSource, /buildCommunityRankingCacheKey\(activeRankingPeriod, activeRankingType\)/);
  assert.match(communitiesSectionSource, /activePeriod=\{activeRankingPeriod\}/);
  assert.match(communitiesSectionSource, /onChangePeriod=\{setActiveRankingPeriod\}/);
});

test("community ranking hides dynamics control and renders the latest change arrow on overall rows", () => {
  assert.doesNotMatch(rankingScreenSource, /\{ id: "dynamics", label: "Динамика" \}/);
  assert.match(rankingScreenSource, /activeType === "overall"/);
  assert.match(rankingScreenSource, /row\.lastRatingDelta/);
  assert.match(rankingScreenSource, /community-ranking-last-delta/);
  assert.match(rankingScreenSource, /Последнее изменение рейтинга/);
});

test("rating breakdown exposes games, tournaments, activity, and overall tabs", () => {
  assert.match(ratingBreakdownSource, /setActiveTab\("games"\)/);
  assert.match(ratingBreakdownSource, /setActiveTab\("tournaments"\)/);
  assert.match(ratingBreakdownSource, /setActiveTab\("activity"\)/);
  assert.match(ratingBreakdownSource, /setActiveTab\("overall"\)/);
  assert.match(ratingBreakdownSource, /Из чего складывается рейтинг турниров/);
  assert.match(ratingBreakdownSource, /Из чего складывается активность/);
});

test("rating UI rejects stale or versionless calculation payloads", () => {
  assert.match(communityApiSource, /calculationVersion: pickString\(payload, \["calculationVersion", "ratingVersion"\]\)/);
  assert.match(communityApiSource, /isCurrentCommunityRatingCalculationVersion\(parsed\.calculationVersion\)/);
  assert.match(communityApiSource, /query\.set\("calculationVersion", COMMUNITY_RATING_CALCULATION_VERSION\)/);
  assert.match(ratingBreakdownSource, /payload\.calculationVersion !== COMMUNITY_RATING_CALCULATION_VERSION/);
  assert.match(ratingBreakdownSource, /Рейтинг обновляется/);
});
