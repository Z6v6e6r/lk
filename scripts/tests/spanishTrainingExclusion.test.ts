import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";
import ts from "typescript";
import { isSpanishTrainingExercise } from "../../src/utils/spanishTrainingExclusion.ts";
import { isSpanishTrainingExercise as serverRule } from "../lib/spanishTrainingExclusion.mjs";
import { hubGatewaySource, spanishTrainingExclusionSource } from "../lib/eventPaymentSources.mjs";

const name = "ИНДИВИДУАЛЬНАЯ/СПЛИТ ТРЕНИРОВКА ИСПАНСКИЙ ТРЕНЕР 🇪🇸";
const read = (path: string) => fs.readFileSync(path, "utf8");
const page = ts.createSourceFile("page.tsx", read("src/components/group-schedule/GroupSchedulePage.tsx"), ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
function declaration(source: ts.SourceFile, name: string): ts.Node {
  let found: ts.Node | undefined;
  function visit(node: ts.Node) {
    if ((ts.isVariableDeclaration(node) || ts.isFunctionDeclaration(node)) && node.name?.getText(source) === name) found = node;
    ts.forEachChild(node, visit);
  }
  visit(source);
  assert.ok(found, name);
  return found;
}
function expression(name: string, dependencies: Record<string, unknown>) {
  const node = declaration(page, name) as ts.VariableDeclaration;
  const code = ts.transpileModule(`return ${node.initializer!.getText(page)};`, { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText;
  return new Function(...Object.keys(dependencies), code)(...Object.values(dependencies));
}

test("client/server match only the requested category across Viva and summary labels", () => {
  const matches = [{ direction: { name } }, { exerciseDirection: { title: name } }, { directionName: name },
    { type: { name } }, { exerciseType: { name } }, { typeName: name }, { title: name }, { name: name.toLowerCase() },
    { directionName: "  Индивидуальная / сплит тренировка — Испанский тренер  " }];
  const ordinary = [null, {}, { title: "Групповая тренировка Испанский тренер 🇪🇸" },
    { title: "Индивидуальная/сплит тренировка" }, { title: "Тренировка ПРО" },
    { title: "Игра+Тренер ПРО" }, { title: "Топократы тренировка" }, { title: "Индивидуальная/сплит тренировка Российский тренер" }];
  for (const value of matches) { assert.equal(isSpanishTrainingExercise(value), true); assert.equal(serverRule(value), true); }
  for (const value of ordinary) { assert.equal(isSpanishTrainingExercise(value), false); assert.equal(serverRule(value), false); }
});

test("screen keeps one-time tariffs and hides all subscriptions, cached quotes and the free link", () => {
  const checkout = { oneTimes: [{ id: "one-time", cost: 900000 }], subscriptions: [{ id: "new-plan" }], clientSubscriptions: [{ id: "owned-plan" }] };
  const deps = { checkout, spanishTrainingSelected: true, proTrainingSelected: false, topokratyExcluded: false,
    discountResolvedFor: "same", discountContextKey: "same", discountQuotes: [{ amountMinor: 450000 }],
    discountPending: false, currentDiscountQuotes: [], selectedTraining: { directionId: 1 }, subscriptionOffer: { owner: "actor", show: true }, phone: "actor",
    getGroupScheduleOwnedSubscriptions: () => { throw new Error("must not offer owned plans or Energy"); },
    hasGroupTrainingSubscriptionEvidence: () => false };
  assert.deepEqual(expression("purchasableProducts", deps), checkout.oneTimes);
  assert.deepEqual(expression("ownedSubscriptions", deps), []);
  assert.deepEqual(expression("currentDiscountQuotes", deps), []);
  assert.equal(expression("shouldShowSubscriptionPurchaseLink", deps), false);
  assert.equal(expression("shouldShowSubscriptionPurchaseLink", { ...deps, spanishTrainingSelected: false }), true);
});

test("fresh booking hook rejects before any ownership, legacy, Energy or payment work", () => {
  const hook = read("scripts/nodered_lk1_hub_nodes/gateway_hooks.js").split("// HUB_EXERCISE\n")[1].split("// HUB_RECHECK")[0];
  for (const plan of ["Дружба 2.0", "РА", "Академия", "Спорт", "ХАБ", "Энергия 5", "Энергия 25", "legacy", "future-plan"]) {
    const ctx = { clientSubscriptionId: plan };
    const run = new Function("ctx", "exercise", "isSpanishTrainingExercise", "finishError", hook);
    const result = run(ctx, { direction: { name } }, serverRule, (_ctx: unknown, status: number, _message: string, details: unknown) => ({ status, details }));
    assert.deepEqual(result, { status: 409, details: { code: "SPANISH_TRAINING_SUBSCRIPTION_UNAVAILABLE" } });
  }
});

test("quote recheck refuses even legacy rules and embeds the predicate once", () => {
  const source = ts.createSourceFile("gateway.js", read("scripts/nodered_lk1_hub_nodes/gateway.js"), ts.ScriptTarget.Latest, true, ts.ScriptKind.JS);
  const node = declaration(source, "lk1Quote") as ts.VariableDeclaration;
  const quote = new Function("isSpanishTrainingExercise", `return ${node.initializer!.getText(source)};`)(serverRule);
  assert.deepEqual(quote({}, { directionName: name }, []), { code: "SPANISH_TRAINING_SUBSCRIPTION_UNAVAILABLE" });
  const embedded = hubGatewaySource();
  assert.equal(embedded.split("function isSpanishTrainingExercise(").length, 2);
  new Function(embedded);
  new Function(`${spanishTrainingExclusionSource()}\nreturn isSpanishTrainingExercise;`);
});

test("preview returns no quotes before reading subscriptions, tariffs or allowance", () => {
  const router = read("scripts/nodered_subscription_price_preview_nodes/router.js");
  const branch = router.slice(router.indexOf("if (ctx.step === 'groupExercise') {"), router.indexOf("if (ctx.step === 'game') {"));
  const ctx = { step: "groupExercise", exerciseId: "exercise", quotes: [{ amountMinor: 0 }] };
  const exercise = { id: "exercise", direction: { name }, timeFrom: "2099-11-14T12:00:00+03:00", studioId: "studio" };
  const canonical = { unwrapRecord: (x: unknown) => x, eventStartsAt: () => exercise.timeFrom,
    eventDurationMinutes: () => 60, resolveCategory: () => "group_training", exerciseRoomId: () => "room",
    managedExternalEventTypeId: () => 605, isSpanishTrainingExercise: serverRule };
  const result = new Function("ctx", "msg", "canonical", "ok", "eventRoute", "out", branch)(ctx, { payload: exercise }, canonical, () => true, { category: "group_training" }, (index: number) => index);
  assert.equal(result, 4);
  assert.deepEqual(ctx.quotes, []);
});

test("checkout refuses owned/purchased/forged subscription discounts before a network write", async () => {
  const source = ts.createSourceFile("api.ts", read("src/utils/tournamentSignupApi.ts"), ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  const code = ts.transpileModule(declaration(source, "apiCreateTournamentVivaTransaction").getText(source).replace(/^export /, ""), { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText;
  const create = new Function("isSpanishTrainingExercise", `${code}; return apiCreateTournamentVivaTransaction;`)(isSpanishTrainingExercise);
  for (const source of ["subscription", "client-subscription"]) {
    const result = await create({ exercise: { direction: { name } }, product: { source, name: "Энергия 25" } });
    assert.equal(result.status, 409);
  }
  assert.equal((await create({ tournament: { title: name }, product: { source: "one-time", lk1MoneyDiscountCandidate: true } })).status, 409);
});
