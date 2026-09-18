// PRO trainings (owner decision 2026-09-18) must leave the subscription contour on both
// sides: the atomic booking gateway refuses a subscription booking of any product and the
// advisory price preview quotes nothing. These cases drive the reviewed hook text itself,
// so a guard that drifts out of the composed body fails here instead of in production.
import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";
import vm from "node:vm";
import { hubGatewaySource, proTrainingExclusionSource } from "../lib/eventPaymentSources.mjs";
import { isProTrainingExercise } from "../lib/proTrainingExclusion.mjs";

const read = relative => fs.readFileSync(new URL(relative, import.meta.url), "utf8");
const hooks = read("../nodered_lk1_hub_nodes/gateway_hooks.js");
const previewRouter = read("../nodered_subscription_price_preview_nodes/router.js");
const previewPatch = read("../patch_nodered_subscription_price_preview.mjs");

/** The reviewed fragments of gateway_hooks.js, exactly as patch_live_lk1_hub.mjs splits them. */
function hookSections(source) {
  const parts = source.split(/^\/\/ HUB_([A-Z]+)\s*$/m);
  const result = {};
  for (let i = 1; i < parts.length; i += 2) result[parts[i]] = parts[i + 1].trim();
  return result;
}

const exercise = (overrides = {}) => ({
  id: "exercise-1",
  direction: { id: 5507, name: "Тренировка ПРО уровень C/C+" },
  studio: { id: "00000000-0000-4000-8000-000000000002" },
  room: { id: "00000000-0000-4000-8000-000000000003" },
  ...overrides,
});

test("the server rule matches the owner-named PRO directions and nothing else", () => {
  for (const directionId of [5502, 5503, 5504, 5505, 5506, 5507]) {
    assert.equal(isProTrainingExercise(exercise({ direction: { id: directionId } })), true, `direction ${directionId}`);
  }
  assert.equal(isProTrainingExercise(exercise()), true, "the name token is the fallback");
  assert.equal(isProTrainingExercise({ direction: { id: 847, name: "Игра+Тренер ПРО уровень D+" } }), true);
  for (const name of ["Первая пробная тренировка", "Пробная групповая тренировка", "Пробное Динамо",
    "Аренда со скидкой - Профсоюзная", "Просто аренда корта", "Падел групповая тренировка",
    "Игра в манеже на Профсоюзной"]) {
    assert.equal(isProTrainingExercise({ direction: { id: 9999, name } }), false, `${name} must not be PRO`);
  }
  assert.equal(isProTrainingExercise(null), false);
  assert.equal(isProTrainingExercise({}), false);
});

/**
 * Runs the reviewed HUB_EXERCISE fragment with intercepting stubs: every helper the
 * fragment calls resolves through the proxy, so only the real control flow under test
 * decides the outcome.
 */
function runExerciseHook(options = {}) {
  const calls = { findOwnedSubscriptions: 0, finishError: [] };
  const stubs = new Proxy({
    ctx: { caller: "http", tenantKey: "iSkq6G", clientSubscriptionId: "sub-1", managedAction: "BOOK_GROUP_TRAINING" },
    msg: {},
    isProTrainingExercise,
    resolveCategory: () => options.category ?? "group_training",
    findOwnedSubscriptions: () => { calls.findOwnedSubscriptions += 1; return options.selectedOwned ?? []; },
    lk1Config: () => options.rule ?? { matched: false },
    lk1ReadPlanRules: () => options.planRules ?? null,
    lk1QuoteOwned: () => options.quoteOwned ?? [],
    lk1Quote: () => ({ code: "LK1_EVENT_TARIFF_UNVERIFIED" }),
    managedActionForTarget: () => "BOOK_GROUP_TRAINING",
    finishError: (ctx, status, message, body) => { calls.finishError.push({ status, message, body }); return { finished: true }; },
    lk1Stop: (ctx, code) => ({ stopped: code }),
    prepareUserGet: (ctx, step) => ({ prepared: step }),
    emit: index => ({ emitted: index }),
    global: { get: () => null },
    LK1_PRODUCT_POLICY_GLOBAL: "subscriptions_lk1_product_policy",
    OUTPUT_FINAL: 4,
    OUTPUT_MANAGED_POLICY: 6,
  }, {
    has: () => true,
    get: (target, key) => (key in target ? target[key] : globalThis[key]),
  });
  const section = hookSections(hooks).EXERCISE;
  assert.ok(section && section.includes("PRO_TRAINING_SUBSCRIPTION_UNAVAILABLE"), "the PRO guard must live in HUB_EXERCISE");
  const factory = new Function("stubs", `with (stubs) { return (ctx, exercise, msg) => {\n${section}\n}; }`);
  return { result: factory(stubs)(stubs.ctx, options.exercise ?? exercise(), stubs.msg), calls };
}

test("a PRO training is refused before any subscription decision, on the managed and the legacy path", () => {
  // A plan product that would quote the free first event of the day.
  const managed = runExerciseHook({ rule: { matched: true, rule: { productId: "plan" } }, selectedOwned: [{ id: "sub-1" }] });
  assert.deepEqual(managed.calls.finishError, [{
    status: 409,
    message: "На ПРО-тренировки подписки не действуют: доступна только оплата по полной цене",
    body: { code: "PRO_TRAINING_SUBSCRIPTION_UNAVAILABLE" },
  }]);
  assert.equal(managed.calls.findOwnedSubscriptions, 0, "no subscription decision may run before the refusal");

  // A legacy visit pack (Энергия 5) is refused by the same guard.
  const legacy = runExerciseHook({ rule: { matched: false }, selectedOwned: [{ id: "sub-1" }] });
  assert.equal(legacy.calls.finishError[0]?.body.code, "PRO_TRAINING_SUBSCRIPTION_UNAVAILABLE");
  assert.equal(legacy.calls.findOwnedSubscriptions, 0);

  // The same booking for a plain training keeps the previous path.
  const ordinary = runExerciseHook({ exercise: exercise({ direction: { id: 3108, name: "Первая пробная тренировка" } }) });
  assert.equal(ordinary.calls.findOwnedSubscriptions, 1, "an ordinary training still resolves the owned instance");
  assert.equal(ordinary.calls.finishError[0]?.body.code, "SUBSCRIPTION_NOT_OWNED_OR_UNAVAILABLE");

  // An open game or a tournament that merely carries «ПРО» in its title keeps its own
  // contour: the guard is scoped to the group-training category.
  const tournament = runExerciseHook({ category: "tournament",
    exercise: exercise({ direction: { id: 2617, name: "Американо ПРО" } }) });
  assert.equal(tournament.calls.findOwnedSubscriptions, 1, "a tournament stays out of the PRO rule");
  assert.equal(tournament.calls.finishError[0]?.body.code, "SUBSCRIPTION_NOT_OWNED_OR_UNAVAILABLE");
});

test("the price preview answers a PRO group training with an empty quote list", () => {
  assert.match(previewRouter, /if \(typeof canonical\.isProTrainingExercise === 'function'\s*&& eventRoute\.category === 'group_training' && canonical\.isProTrainingExercise\(exercise\)\) \{\s*ctx\.quotes = \[\]; ctx\.done = true; ctx\.statusCode = 200; return out\(4\);\s*\}/);
  // The helper is embedded from the one reviewed module, so the preview carries it even
  // when the installed booking body of that generation predates the exclusion.
  assert.match(previewPatch, /const proTraining = proTrainingEmbedding\(declared\);/);
  assert.match(previewPatch, /eventPaymentSources\.proTrainingExclusionSource\(\)/);
  assert.match(previewPatch, /\$\{proTraining\.injected\}/);
  assert.match(previewPatch, /const PREVIEW_INJECTED_EXPORTS = Object\.freeze\(\[[^\]]*'isProTrainingExercise'\]\)/);
  assert.match(previewPatch, /const PREVIEW_INJECTED_FUNCTIONS = Object\.freeze\(\[[^\]]*'isProTrainingExercise'\]\)/);
});

test("the booking body embeds the reviewed exclusion module exactly once", () => {
  const gateway = hubGatewaySource();
  assert.equal(gateway.split("const PRO_TRAINING_DIRECTION_IDS =").length, 2,
    "the module must be embedded once and not redeclared by the gateway");
  assert.equal(gateway.split("function isProTrainingExercise(").length, 2);
  assert.equal(gateway.split("PRO_TRAINING_SUBSCRIPTION_UNAVAILABLE").length, 1,
    "the refusal code belongs to the hook, not to the embedded module");
  assert.match(proTrainingExclusionSource(), /PRO_TRAINING_DIRECTION_IDS = Object\.freeze\(\[5502, 5503, 5504, 5505, 5506, 5507\]\)/);
  assert.match(proTrainingExclusionSource(), /function isProTrainingExercise\(value\) \{/);
  assert.doesNotMatch(proTrainingExclusionSource(), /^export /m);
  // The embedded module must stay inert until a hook calls it.
  assert.doesNotMatch(proTrainingExclusionSource(), /\bctx\b|\bmsg\b/);
});
