import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";
import {
  PRO_TRAINING_DIRECTION_IDS,
  isProTraining,
  isProTrainingName,
} from "../../src/utils/proTrainingExclusion.ts";

const groupSchedulePageSource = fs.readFileSync("src/components/group-schedule/GroupSchedulePage.tsx", "utf8");
const findGamePageSource = fs.readFileSync("src/components/games/FindGamePage.tsx", "utf8");

const summary = (overrides: Record<string, unknown> = {}) => ({
  id: "exercise-1",
  title: "Тренировка ПРО уровень C/C+",
  typeId: 605,
  typeName: "Падел групповая тренировка",
  directionId: 5507,
  directionName: "Тренировка ПРО уровень C/C+",
  raw: {},
  ...overrides,
});

test("the PRO direction ids are the four owner-named directions plus their levels", () => {
  assert.deepEqual([...PRO_TRAINING_DIRECTION_IDS], [5502, 5503, 5504, 5505, 5506, 5507]);
  for (const directionId of PRO_TRAINING_DIRECTION_IDS) {
    assert.equal(isProTraining(summary({ directionId, directionName: null, title: null })), true,
      `direction ${directionId} must be PRO`);
  }
});

test("the PRO marker matches the real direction names of the catalogue", () => {
  assert.equal(isProTraining(summary({ directionId: null, raw: {} })), true);
  assert.equal(isProTraining({ direction: { id: 5506, name: "Тренировка ПРО уровень D+" } }), true);
  assert.equal(isProTraining({ directionName: "Игра+Тренер ПРО уровень D+" }), true);
  assert.equal(isProTraining({ direction: { name: "Игра+Тренер ПРО уровень C/C+" } }), true);
  assert.equal(isProTraining({ title: "тренировка про уровень d" }), true);
});

test("ordinary trainings whose name merely starts with «про» are never PRO", () => {
  const ordinary = [
    "Первая пробная тренировка",
    "Пробная групповая тренировка",
    "Пробное Динамо",
    "Аренда со скидкой - Профсоюзная",
    "Игра в манеже на Профсоюзной",
    "Просто аренда корта",
    "Тренировка уровень D+",
    "Игра+Тренер уровень D",
  ];
  for (const directionName of ordinary) {
    assert.equal(isProTrainingName(directionName), false, `${directionName} must not be PRO`);
    assert.equal(isProTraining({ directionName, directionId: 9999 }), false, `${directionName} must not be PRO`);
  }
  assert.equal(isProTrainingName("Профессиональная тренировка"), false);
  assert.equal(isProTrainingName(""), false);
  assert.equal(isProTrainingName(null), false);
});

test("a record without a resolvable direction is not PRO", () => {
  assert.equal(isProTraining(null), false);
  assert.equal(isProTraining(undefined), false);
  assert.equal(isProTraining("Тренировка ПРО уровень D"), false);
  assert.equal(isProTraining([]), false);
  assert.equal(isProTraining({}), false);
  assert.equal(isProTraining({ directionId: "5507" }), true, "a numeric string id stays usable");
});

test("the group schedule screen offers no subscription path for PRO trainings", () => {
  assert.match(groupSchedulePageSource, /import \{ isProTraining \} from "\.\.\/\.\.\/utils\/proTrainingExclusion";/);
  assert.match(groupSchedulePageSource, /const proTrainingSelected = useMemo\(\s*\(\) => Boolean\(selectedDetail && isProTraining\(selectedDetail\)\),/);
  // No quote is requested, so no discount row and no subscription booking product can render.
  assert.match(groupSchedulePageSource, /if \(proTrainingSelected\) \{\s*setDiscountResolvedFor\(resolvedFor\);\s*return;\s*\}/);
  assert.match(groupSchedulePageSource, /: proTrainingSelected \? checkout\.oneTimes : \[\.\.\.checkout\.oneTimes, \.\.\.checkout\.subscriptions\];/);
  assert.match(groupSchedulePageSource, /const ownedSubscriptions = checkout && !proTrainingSelected/);
  assert.match(groupSchedulePageSource, /const shouldShowSubscriptionPurchaseLink = Boolean\(checkout && !proTrainingSelected/);
  assert.match(groupSchedulePageSource, /subscriptionUsageShadowEnabled && !proTrainingSelected/);
  assert.match(groupSchedulePageSource, /ПРО-тренировка оплачивается по полной цене/);
  // Promo codes stay available: the promo section is not part of the PRO exclusion.
  assert.match(groupSchedulePageSource, /const shouldShowGroupSchedulePromoSection = Boolean\(checkout && checkout\.oneTimes\.some\(isGroupSchedulePromoProduct\)\);/);
});

test("the find-game trainer card does not promise plans for a PRO training", () => {
  assert.match(findGamePageSource, /import \{ isProTraining \} from "\.\.\/\.\.\/utils\/proTrainingExclusion";/);
  assert.match(findGamePageSource, /if \(isProTraining\(training\)\) return priceValueLabel \|\| GAME_PLUS_TRAINER_DEFAULT_PRICE_VALUE_LABEL;/);
});

test("the server mirror of the rule keeps the same ids and the same token", () => {
  const serverSource = fs.readFileSync("scripts/lib/proTrainingExclusion.mjs", "utf8");
  assert.match(serverSource, /PRO_TRAINING_DIRECTION_IDS = Object\.freeze\(\[5502, 5503, 5504, 5505, 5506, 5507\]\)/);
  assert.match(serverSource, /PRO_TRAINING_NAME_TOKEN = \/\(\^\|\[\^a-zа-яё0-9\]\)про\(\[\^a-zа-яё0-9\]\|\$\)\/i/);
});
