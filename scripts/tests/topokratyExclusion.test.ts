// The Topokraty exclusion (owner decision 2026-09-25, incident of the same day): directions
// 6180 «Топократы игра» / 6233 «Топократы тренировка» stay outside every non-club subscription,
// because Viva refuses a carried «РА»/«Академия»/«Дружба» on those directions with
// 400 BAD_REQUEST. The club product «Дружба Топократы» keeps its own rule.
//
// Both sides of the contour are pinned here: the widget rule, the server rule and the two
// composed bodies that carry them (the booking gateway and the advisory price preview).
import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";
import {
  TOPOKRATY_CLUB_PRODUCT_IDS,
  TOPOKRATY_DIRECTION_IDS,
  isTopokratyClubPack,
  isTopokratyExercise,
  isTopokratyName,
  isTopokratySubscriptionExcluded,
} from "../../src/utils/topokratyExclusion.ts";
import {
  EXERCISE_CATEGORY_GROUP_TRAINING,
  EXERCISE_CATEGORY_GROUP_TRAINING_DIRECTION_IDS,
  EXERCISE_CATEGORY_OPEN_GAME,
  EXERCISE_CATEGORY_OPEN_GAME_DIRECTION_IDS,
  resolveExerciseCategoryFromValue,
} from "../../src/utils/exerciseCategory.ts";

const groupSchedulePageSource = fs.readFileSync("src/components/group-schedule/GroupSchedulePage.tsx", "utf8");
const serverSource = fs.readFileSync("scripts/lib/topokratyExclusion.mjs", "utf8");
const gatewayGuardSource = fs.readFileSync("scripts/nodered_lk1_hub_nodes/gateway_hooks.js", "utf8");
const previewRouterSource = fs.readFileSync("scripts/nodered_subscription_price_preview_nodes/router.js", "utf8");
const compositionSource = fs.readFileSync("scripts/lib/eventPaymentSources.mjs", "utf8");
const previewCompositionSource = fs.readFileSync("scripts/patch_nodered_subscription_price_preview.mjs", "utf8");

const summary = (overrides: Record<string, unknown> = {}) => ({
  id: "exercise-1",
  title: "Топократы тренировка",
  typeId: 2349,
  typeName: "Падел групповая тренировка",
  directionId: 6233,
  directionName: "Топократы тренировка",
  raw: {},
  ...overrides,
});

test("the Topokraty direction ids and the club product are the owner-named ones", () => {
  assert.deepEqual([...TOPOKRATY_DIRECTION_IDS], [6180, 6233]);
  assert.deepEqual([...TOPOKRATY_CLUB_PRODUCT_IDS], ["14692232-12be-4218-9fa1-2d5b79b62035"]);
  for (const directionId of TOPOKRATY_DIRECTION_IDS) {
    assert.equal(isTopokratyExercise(summary({ directionId, directionName: null, title: null })), true,
      `direction ${directionId} must be excluded from general subscriptions`);
  }
});

test("the Topokraty marker matches the catalogue names and needs a standalone token", () => {
  assert.equal(isTopokratyExercise(summary({ directionId: null })), true);
  assert.equal(isTopokratyExercise({ direction: { id: 6233, name: "Топократы тренировка" } }), true);
  assert.equal(isTopokratyExercise({ directionName: "Топократы игра" }), true);
  assert.equal(isTopokratyExercise({ title: "топократы тренировка + игра" }), true);
  assert.equal(isTopokratyName("Дружба Топократы"), true);
  assert.equal(isTopokratyExercise({ directionName: "Топократика" }), false);
  assert.equal(isTopokratyExercise({ directionName: "Групповая тренировка" }), false);
  assert.equal(isTopokratyExercise({ directionName: "Игра+Тренер ПРО уровень C" }), false);
});

test("only the club product unlocks the subscription path for a Topokraty event", () => {
  const club = { productId: "14692232-12be-4218-9fa1-2d5b79b62035" };
  const ra = { productId: "b91e14d1-fe6e-4d0b-be39-3e45ad86b759" };
  assert.equal(isTopokratyClubPack(club), true);
  assert.equal(isTopokratyClubPack({ raw: { productId: "14692232-12be-4218-9fa1-2d5b79b62035" } }), true);
  assert.equal(isTopokratyClubPack({ raw: { product: { id: "14692232-12be-4218-9fa1-2d5b79b62035" } } }), true);
  assert.equal(isTopokratyClubPack({ name: "Дружба Топократы" }), true);
  assert.equal(isTopokratyClubPack(ra), false);
  assert.equal(isTopokratyClubPack({ productId: "dfa72adf-233b-4285-8d69-e5eab4234fbe" }), false);
  assert.equal(isTopokratyClubPack({ name: "Лето.Падел.Дружба" }), false);
  // A row naming another product id never falls back to its name.
  assert.equal(isTopokratyClubPack({ productId: "b91e14d1-fe6e-4d0b-be39-3e45ad86b759", name: "Дружба Топократы" }), false);
  assert.equal(isTopokratySubscriptionExcluded(summary(), [ra]), true);
  assert.equal(isTopokratySubscriptionExcluded(summary(), [club]), false);
  assert.equal(isTopokratySubscriptionExcluded(summary(), [ra, club]), false);
  assert.equal(isTopokratySubscriptionExcluded(summary({ directionId: 5507, directionName: "Тренировка ПРО", title: null }), [ra]), false);
});

test("the widget classifies the club directions explicitly, not by the Viva name", () => {
  assert.deepEqual([...EXERCISE_CATEGORY_OPEN_GAME_DIRECTION_IDS], [4588, 6180]);
  assert.deepEqual([...EXERCISE_CATEGORY_GROUP_TRAINING_DIRECTION_IDS], [6233]);
  // A Viva rename that drops «игра»/«тренировка» from the label cannot move a club event out
  // of its category: the direction id decides before any name marker is consulted.
  assert.equal(resolveExerciseCategoryFromValue({ direction: { id: 6180, name: "Клубная встреча" } }),
    EXERCISE_CATEGORY_OPEN_GAME);
  assert.equal(resolveExerciseCategoryFromValue({ directionId: 6180, title: "Клубная встреча" }),
    EXERCISE_CATEGORY_OPEN_GAME);
  assert.equal(resolveExerciseCategoryFromValue({ direction: { id: 6233, name: "Клубная встреча" } }),
    EXERCISE_CATEGORY_GROUP_TRAINING);
  // Type 2349 is shared with «Атланты» (direction 6152): only the club direction ids may be
  // pinned, so the type alone never classifies.
  assert.equal(resolveExerciseCategoryFromValue({ type: { id: 2349 } }), null);
  assert.equal(resolveExerciseCategoryFromValue({ direction: { id: 6152, name: "Атланты" } }), null);
});

test("the widget offers no subscription for an excluded Topokraty event", () => {
  assert.match(groupSchedulePageSource,
    /import \{ isTopokratyClubPack, isTopokratyExercise \} from "\.\.\/\.\.\/utils\/topokratyExclusion";/);
  assert.match(groupSchedulePageSource,
    /const topokratyTrainingSelected = useMemo\(\s*\(\) => Boolean\(selectedDetail && isTopokratyExercise\(selectedDetail\)\),/);
  assert.match(groupSchedulePageSource, /const topokratyExcluded = topokratyTrainingSelected && !topokratyClubOwned;/);
  assert.match(groupSchedulePageSource, /if \(topokratyExcluded\) \{/);
  assert.match(groupSchedulePageSource,
    /: proTrainingSelected \|\| topokratyExcluded \? checkout\.oneTimes : \[\.\.\.checkout\.oneTimes, \.\.\.checkout\.subscriptions\];/);
  assert.match(groupSchedulePageSource, /: topokratyExcluded \? \[\]/);
  assert.match(groupSchedulePageSource, /const shouldShowSubscriptionPurchaseLink = Boolean\(checkout && !proTrainingSelected && !topokratyExcluded/);
});

test("the server mirror keeps the same ids, the same token and the same club product", () => {
  assert.match(serverSource, /TOPOKRATY_DIRECTION_IDS = Object\.freeze\(\[6180, 6233\]\)/);
  assert.match(serverSource, /TOPOKRATY_CLUB_PRODUCT_IDS = Object\.freeze\(\["14692232-12be-4218-9fa1-2d5b79b62035"\]\)/);
  assert.match(serverSource, /TOPOKRATY_NAME_TOKEN = /);
  assert.match(gatewayGuardSource, /isTopokratyExercise\(exercise\)/);
  assert.match(gatewayGuardSource, /isTopokratyClubPack\(selectedOwned\[0\]\)/);
  assert.match(gatewayGuardSource, /TOPOKRATY_SUBSCRIPTION_UNAVAILABLE/);
  // The refusal covers the club game as well: direction 6180 resolves to `open_game`, so the
  // gate cannot be scoped to the group-training category alone.
  assert.match(gatewayGuardSource,
    /if \(\["group_training", "open_game"\]\.includes\(resolveCategory\(exercise\)\)/);
  assert.doesNotMatch(gatewayGuardSource,
    /if \(resolveCategory\(exercise\) === "group_training"\s*\n\s*&& isTopokratyExercise\(exercise\)/);
  assert.match(gatewayGuardSource, /На занятия Топократов общие подписки не действуют/);
  // The refusal precedes every subscription decision of the booking step.
  assert.ok(gatewayGuardSource.indexOf("TOPOKRATY_SUBSCRIPTION_UNAVAILABLE")
    < gatewayGuardSource.indexOf("const selectedRule = lk1Config(selectedOwned"),
  "the Topokraty refusal must precede the plan-rule resolution");
});

test("the advisory preview refuses to quote a Topokraty event for a non-club subscription", () => {
  // The refusal now lives in the reviewed preview source itself (widened from the 2026-09-26
  // training rule to the club game), so the shared router carries the condition on both the
  // event and the game route.
  assert.match(previewRouterSource,
    /if \(typeof isTopokratyExercise === 'function' && isTopokratyExercise\(exercise\)\) \{/);
  assert.match(previewRouterSource, /isTopokratyClubPack\(topokratyClubRow\)/);
  assert.match(previewRouterSource, /TOPOKRATY_SUBSCRIPTION_UNAVAILABLE/);
  // The generation only embeds the reviewed club module the router calls; it no longer adds a
  // second refusal of its own.
  const previewPatch = fs.readFileSync("scripts/patch_live_lk1_topokraty_rejection_reclaim_hotfix.mjs", "utf8");
  assert.match(previewPatch, /buildTopokratyReclaimPreviewDeltas/);
  assert.match(previewPatch, /TOPOKRATY_PREVIEW_GATE/);
  assert.match(previewPatch, /topokratyExclusionSource\(\)/);
  assert.doesNotMatch(previewPatch, /preview-refusal/,
    "the refusal belongs to the reviewed router, not to the generation delta");
});

test("both composed bodies embed the reviewed module exactly once", () => {
  assert.match(compositionSource, /topokratyExclusionSource/);
  assert.match(compositionSource, /planRulesSource\(\) \+ proTrainingExclusionSource\(\) \+ topokratyExclusionSource\(\)/);
  assert.match(compositionSource, /Gateway must not redeclare the embedded Topokraty exclusion symbols/);
  assert.match(previewCompositionSource, /PREVIEW_CANONICAL_SOURCE_SHA256/);
  assert.ok(!previewCompositionSource.includes("topokratyEmbedding"),
    "the shared preview composition must not carry this generation's rule");
});
