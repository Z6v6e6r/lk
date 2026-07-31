import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import packageJson from "../../package.json" with { type: "json" };

const gamesPageSource = fs.readFileSync("src/components/games/GamesPage.tsx", "utf8");
const submitPrepareSource = fs.readFileSync("scripts/nodered_result_nodes/fn_result_submit_prepare.js", "utf8");
const submitBuildQuerySource = fs.readFileSync("scripts/nodered_result_nodes/fn_result_submit_build_query.js", "utf8");
const sessionOpenSource = fs.readFileSync("scripts/nodered_result_nodes/fn_result_session_open_prepare_session_query.js", "utf8");
const stateBuildQuerySource = fs.readFileSync("scripts/nodered_result_nodes/fn_result_state_build_query.js", "utf8");
const confirmPrepareRatingsQuerySource = fs.readFileSync(
  "scripts/nodered_result_nodes/fn_result_confirm_prepare_ratings_query.js",
  "utf8",
);
const confirmCalculateRatingSource = fs.readFileSync(
  "scripts/nodered_result_nodes/fn_result_confirm_calculate_rating.js",
  "utf8",
);
const resultFlowPatchSource = fs.readFileSync(
  "scripts/patch_nodered_results_flow.mjs",
  "utf8",
);

test("result submit prepare no longer reconstructs pairings from metadata teamSlots", () => {
  assert.doesNotMatch(submitPrepareSource, /\bmetadataTeamSlots\b/);
  assert.doesNotMatch(submitPrepareSource, /metadata\.teamSlots/);
  assert.doesNotMatch(submitPrepareSource, /playerPool/);
});

test("result hot paths do not rely on allRelatedPhones helpers", () => {
  assert.doesNotMatch(submitBuildQuerySource, /\ballRelatedPhones\b/);
  assert.doesNotMatch(sessionOpenSource, /\ballRelatedPhones\b/);
  assert.doesNotMatch(stateBuildQuerySource, /\ballRelatedPhones\b/);
});

test("result submit writes the aggregate without a player rating lookup", () => {
  assert.match(resultFlowPatchSource, /submitFindResults\.wires\s*=\s*\[\[submitBuildInsert\.id\]\]/);
  assert.doesNotMatch(resultFlowPatchSource, /const submitFindRatings\s*=\s*ensureNode/);
  assert.doesNotMatch(resultFlowPatchSource, /const submitPrepareRatings\s*=\s*ensureNode/);
});

test("v2 confirm skips synchronous rating while the legacy path remains compatible", () => {
  assert.match(confirmPrepareRatingsQuerySource, /ratingFacts\?\.effectiveSetPairings/);
  assert.match(confirmPrepareRatingsQuerySource, /resultModelVersion \|\| 1\) < 2/);
  assert.match(confirmCalculateRatingSource, /player_rating_state_at_confirm/);
  assert.match(confirmCalculateRatingSource, /pairings\.find/);
  assert.doesNotMatch(confirmCalculateRatingSource, /member\?\.ratingNumeric/);
  assert.match(resultFlowPatchSource, /collection:\s*'player_rating_state'/);
  assert.match(resultFlowPatchSource, /name:\s*'Calculate result rating from live state'/);
});

test("result flow patch remains available without a broad repository sync command", () => {
  assert.equal(String(packageJson.scripts["nodered:modular:sync-games-source"] || ""), "");
  assert.match(resultFlowPatchSource, /ratingLedgerEventFormatter\.wires/);
});

test("frontend result submit still builds explicit per-set pairing payload without phone lookups", () => {
  assert.match(gamesPageSource, /function buildMatchResultSubmitSetPairingsPayload\(/);
  assert.match(
    gamesPageSource,
    /const setPairings = buildMatchResultSubmitSetPairingsPayload\([\s\S]*detailsMatchResultSetPairings,[\s\S]*completedSets\.length,[\s\S]*detailsTeamSlots,[\s\S]*\);/,
  );
  assert.match(
    gamesPageSource,
    /resultSession:\s*\{[\s\S]*rosterSnapshot:\s*isRecordObject\(detailsMatchResultSession\?\.rosterSnapshot\)/,
  );
  assert.doesNotMatch(gamesPageSource, /phoneLookup/);
});

test("frontend result confirm path does not call onboarding level save API or client-side viva retry handler", () => {
  assert.doesNotMatch(gamesPageSource, /\bapiSaveOnboardingLevel\(/);
  assert.doesNotMatch(gamesPageSource, /handleRetryMatchResultVivaSync/);
});

test("frontend freezes starting lineup after the first completed set and keeps next-set lineup as a separate block", () => {
  assert.match(
    gamesPageSource,
    /const isEditableStartPairing = canEditMatchResult\s*&& index === 0\s*&& detailsCompletedMatchResultSets\.length === 0;/,
  );
  assert.match(
    gamesPageSource,
    /const isUpcomingSetPairingBlock = canEditMatchResult\s*&& index > 0\s*&& index === detailsCompletedMatchResultSets\.length;/,
  );
  assert.match(
    gamesPageSource,
    /\|\| \(isUpcomingSetPairingBlock && Boolean\(setPairingSlotsForDisplay\?\.some\(Boolean\)\)\)/,
  );
});

test("quick pairing changes seed missing earlier set pairings before saving the next set layout", () => {
  assert.match(
    gamesPageSource,
    /const nextSetPairings = buildNextSetPairingsForTeamSlots\(nextSlots,\s*\{\s*basePairings: previousSetPairings,\s*\}\);/,
  );
});
