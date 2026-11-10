import assert from "node:assert/strict";
import fs from "node:fs";
import { createRequire } from "node:module";
import test from "node:test";
import ts from "typescript";
import { renderToStaticMarkup } from "react-dom/server";
import {
  getAppliedGroupSchedulePromoPreview,
  isGroupSchedulePromoPreviewApplicable,
  isGroupSchedulePromoProduct,
  normalizeGroupSchedulePromoCode,
} from "../../src/utils/groupSchedulePromo.ts";
import { isTrialGroupTraining, trialGroupCheckoutOperationId } from "../../src/utils/trialGroupTraining.ts";

const require = createRequire(import.meta.url);
const parse = path => ts.createSourceFile(path, fs.readFileSync(path, "utf8"),
  ts.ScriptTarget.Latest, true, path.endsWith("tsx") ? ts.ScriptKind.TSX : ts.ScriptKind.TS);
const api = parse("src/utils/tournamentSignupApi.ts");
const page = parse("src/components/group-schedule/GroupSchedulePage.tsx");
function find(source, predicate) {
  let result;
  function visit(node) {
    if (!result && predicate(node)) result = node;
    if (!result) ts.forEachChild(node, visit);
  }
  visit(source);
  assert.ok(result, "production node must exist");
  return result;
}
function evaluate(expression, dependencies = {}) {
  const code = ts.transpileModule(`const subject = ${expression};`, {
    compilerOptions: { target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.ReactJSX, module: ts.ModuleKind.CommonJS },
  }).outputText;
  return new Function("require", "exports", ...Object.keys(dependencies), code + "\nreturn subject;")(
    require, {}, ...Object.values(dependencies));
}
function callback(name, dependencies) {
  const node = find(page, node => ts.isVariableDeclaration(node) && node.name.getText(page) === name);
  return evaluate(node.initializer.arguments[0].getText(page), dependencies);
}
const product = (source = "one-time", id = "fixture-product") => ({
  id, source, name: "Пробная тренировка", type: "SERVICE", cost: 150000, raw: {},
});
const profile = { id: "fixture-actor", phone: "fixture-phone" };
const training = { id: "fixture-exercise", directionId: 4971, raw: {} };
const checkout = (overrides = {}) => ({
  profile, exercise: { id: training.id }, studioId: "fixture-studio",
  clientSubscriptions: [], purchasedProducts: [], oneTimes: [product()], subscriptions: [], ...overrides,
});
const getErrorMessage = (error, fallback) => error?.message || fallback;

function checkoutReader(name, failed) {
  const calls = [];
  const exercise = { id: training.id, availableClientSubscriptions: [product("client-subscription", "owned-pack")],
    availableClientOneTimes: [product("client-one-time", "owned-visit")] };
  const dependencies = {
    TENANT_KEY: "fixture",
    LK1_MONEY_DISCOUNT_CHECKOUT_ENABLED: false,
    request: async (url, options) => {
      calls.push({ url, options });
      if (failed.some(kind => url.includes(`/products/${kind}?`))) {
        return { data: null, error: { status: 503, message: "fixture failure" }, status: 503 };
      }
      const data = url.endsWith("/profile") ? profile : url.includes("/exercises/") ? exercise
        : failed.includes("empty") ? [] : [product()];
      return { data, error: null, status: 200 };
    },
    isRecord: value => Boolean(value && typeof value === "object"),
    pickNestedRecord: () => null,
    pickString: () => null,
    resolveTournamentCustomPricing: () => null,
    pickFirstArray: (value, keys) => value[keys[0]] || [],
    normalizeVivaProducts: (items, source) => items.map(item => ({ ...item, source })),
    filterClientSubscriptionsForExercise: items => items,
    extractItems: value => value,
    resolveSubscriptionCategoryDailyLimitCategoryFromEvent: () => "group_training",
    resolveClientSubscriptionProductNames: async items => items,
  };
  const node = find(api, node => ts.isFunctionDeclaration(node) && node.name?.text === name);
  return { read: evaluate(node.getText(api).replace(/^export /, ""), dependencies), calls };
}

test("partial and total tariff failures remain visible without dropping owned visits or successful sources", async () => {
  for (const name of ["apiFetchTournamentVivaCheckout", "apiFetchTournamentVivaPublicCheckout"]) {
    for (const failed of [["one-times"], ["subscriptions"], ["one-times", "subscriptions"], ["empty"]]) {
      const { read, calls } = checkoutReader(name, failed);
      const result = await read(training.id);
      assert.equal(result.error, null);
      assert.equal(result.data.oneTimes.length, failed.includes("one-times") || failed.includes("empty") ? 0 : 1);
      assert.equal(result.data.subscriptions.length, failed.includes("subscriptions") || failed.includes("empty") ? 0 : 1);
      assert.deepEqual(result.data.tariffErrors, [
        ...(failed.includes("one-times") ? ["Не удалось загрузить тарифы разовых посещений."] : []),
        ...(failed.includes("subscriptions") ? ["Не удалось загрузить тарифы абонементов."] : []),
      ]);
      if (name === "apiFetchTournamentVivaCheckout") {
        assert.deepEqual(result.data.purchasedProducts.map(item => item.source), ["client-subscription", "client-one-time"]);
      }
      assert.ok(calls.every(call => call.options.method === "GET"));
    }
  }
});

function promoHarness(preview) {
  const state = { applied: null, loading: false, error: null, input: "", request: { current: 0 } };
  const calls = [];
  const apply = callback("applyPromoCode", {
    promoInput: " fixture-promo ", subscriptionUsageShadowEnabled: false,
    subscriptionUsageShadowReject: () => assert.fail("unexpected shadow call"),
    normalizeGroupSchedulePromoCode, isGroupSchedulePromoProduct, isGroupSchedulePromoPreviewApplicable,
    promoRequestIdRef: state.request, getErrorMessage,
    setPromoError: value => { state.error = value; },
    setAppliedPromo: value => { state.applied = value; },
    setPromoLoading: value => { state.loading = value; },
    setPromoInput: value => { state.input = value; },
    apiPreviewTournamentVivaTransaction: async params => { calls.push(params); return preview(params); },
  });
  return { state, calls, apply };
}
const preview = amount => ({ data: { sumMinor: 150000, discountMinor: 150000 - amount,
  toPayMinor: amount }, error: null, status: 200 });

test("promo uses the exact purchasable service and accepts a full provider discount", async () => {
  const harness = promoHarness(() => preview(0));
  await harness.apply(training, checkout({ subscriptions: [product("subscription")],
    purchasedProducts: [product("client-one-time")] }));
  assert.equal(harness.calls.length, 1);
  assert.equal(harness.calls[0].promoCode, "FIXTURE-PROMO");
  assert.equal(harness.calls[0].product.source, "one-time");
  assert.equal(harness.state.loading, false);
  assert.equal(harness.state.applied.exerciseId, training.id);
  assert.equal(harness.state.applied.clientId, profile.id);
  assert.equal(harness.state.applied.previewsByProductId["fixture-product"].toPayMinor, 0);
});

test("rejected preview settles loading and leaves ordinary booking available", async () => {
  for (const run of [() => Promise.reject(new Error("offline")), () => ({ data: null, error: { message: "Неверный код" } })]) {
    const harness = promoHarness(run);
    await harness.apply(training, checkout());
    assert.equal(harness.state.loading, false);
    assert.equal(harness.state.applied, null);
    assert.ok(harness.state.error);
  }
});

test("stale preview cannot restore a promo after checkout or account invalidation", async () => {
  let resolve;
  const harness = promoHarness(() => new Promise(done => { resolve = done; }));
  const pending = harness.apply(training, checkout());
  harness.state.request.current++;
  harness.state.applied = null;
  harness.state.loading = false;
  resolve(preview(0));
  await pending;
  assert.equal(harness.state.applied, null);
  const reset = find(page, node => ts.isCallExpression(node) && node.expression.getText(page) === "useEffect"
    && node.arguments[0]?.getText(page).includes('setPromoInput("")'));
  for (const name of ["checkout", "phone", "selectedId", "isRestoringSession"]) {
    assert.ok(reset.arguments[1].getText(page).includes(name), `invalidation must observe ${name}`);
  }
});

function elements(node, type) {
  if (Array.isArray(node)) return node.flatMap(child => elements(child, type));
  if (!node || typeof node !== "object") return [];
  return [...(node.type === type ? [node] : []), ...elements(node.props?.children, type)];
}
function paymentOptions(overrides = {}) {
  const current = overrides.checkout || checkout();
  const expression = find(page, node => ts.isJsxExpression(node) && node.expression
    && /^!subscriptionUsageShadowEnabled\s*&& !registrationLoading\s*&& !isRegistered\s*&& !trialBookingBlocked/.test(node.expression.getText(page)));
  const owned = find(page, node => ts.isVariableDeclaration(node) && node.name.getText(page) === "ownedOneTimes");
  return evaluate(expression.expression.getText(page), {
    subscriptionUsageShadowEnabled: false, registrationLoading: false, isRegistered: false,
    trialBookingBlocked: false, checkout: current, selectedTraining: training,
    ownedOneTimes: evaluate(owned.initializer.getText(page), { checkout: current }),
    ownedSubscriptions: [], purchasableProducts: current.oneTimes, discountPending: false, discountError: null,
    actionLoading: false, promoLoading: false, appliedPromo: null, currentDiscountQuotes: [],
    patriotsTournamentSelected: false, shouldShowSubscriptionPurchaseLink: false,
    shouldShowGroupSchedulePromoSection: true, isGroupSchedulePromoExpanded: true,
    groupSchedulePromoSectionId: "fixture-promo-section", GROUP_SCHEDULE_PROMO_TRIGGER_TEXT: "Есть промокод",
    promoInput: "", promoError: null, getAppliedGroupSchedulePromoPreview,
    matchGroupScheduleSubscriptionDiscount: () => null,
    formatProductPrice: () => "1500 ₽", formatProductVisits: () => "",
    formatMoneyMinor: amount => `${amount / 100} ₽`,
    completeRegistration: () => {}, setGroupSchedulePromoExpanded: () => {},
    ...overrides,
  });
}

test("owned one-time visit has a working action, original source and no inferred zero price", () => {
  const visit = product("client-one-time", "owned-visit");
  visit.cost = null;
  const current = checkout({ oneTimes: [], purchasedProducts: [visit] });
  const calls = [];
  const tree = paymentOptions({ checkout: current, completeRegistration: (...args) => calls.push(args) });
  const html = renderToStaticMarkup(tree);
  assert.match(html, /Использовать разовое посещение/);
  assert.doesNotMatch(html, /Нет доступных способов записи|0 ₽/);
  const button = elements(tree, "button").find(item => renderToStaticMarkup(item).includes("Использовать"));
  button.props.onClick();
  assert.deepEqual(calls[0], [training, current, visit]);
});

test("successful promo exposes an explicit booking action while subscription quotes are still loading", () => {
  for (const amount of [0, 50000]) {
    const calls = [];
    const appliedPromo = { code: "FIXTURE-PROMO", exerciseId: training.id, clientId: profile.id,
      previewsByProductId: { "fixture-product": preview(amount).data } };
    const tree = paymentOptions({ appliedPromo, discountPending: true, completeRegistration: (...args) => calls.push(args) });
    const label = amount === 0 ? "Записаться бесплатно" : "Записаться за 500 ₽";
    const button = elements(tree, "button").find(item => renderToStaticMarkup(item).includes(label));
    assert.ok(button);
    assert.equal(button.props.disabled, false);
    button.props.onClick();
    assert.equal(calls[0][2].source, "one-time");
    assert.equal(calls[0][3], "FIXTURE-PROMO");
  }
});

test("trial eligibility blocks all booking actions, including owned visits and promo", () => {
  assert.equal(paymentOptions({ trialBookingBlocked: true }), false);
});

test("tariff error alert retries reads, and failed tariffs are not reported as an empty catalogue", () => {
  const current = checkout({ oneTimes: [], tariffErrors: ["Не удалось загрузить тарифы разовых посещений."] });
  assert.doesNotMatch(renderToStaticMarkup(paymentOptions({ checkout: current })), /Нет доступных способов записи/);
  const expression = find(page, node => ts.isJsxExpression(node) && node.expression
    && node.expression.getText(page).startsWith("!subscriptionUsageShadowEnabled && !registrationLoading")
    && node.expression.getText(page).includes("checkoutLoadError"));
  for (const checkoutLoadError of [null, "Не удалось получить способы записи."]) {
    const calls = [];
    const tree = evaluate(expression.expression.getText(page), {
      subscriptionUsageShadowEnabled: false, registrationLoading: false, checkoutLoadError,
      checkout: current, selectedTraining: training, actionLoading: false,
      loadRegistrationState: value => calls.push(value),
    });
    assert.match(renderToStaticMarkup(tree), /role="alert"/);
    elements(tree, "button")[0].props.onClick();
    assert.deepEqual(calls, [training]);
  }
});

test("booking callback forwards the promo unchanged and cannot bypass trial eligibility", async () => {
  for (const blocked of [false, true]) {
    const calls = [];
    const complete = callback("completeRegistration", {
      subscriptionUsageShadowEnabled: false, selectedId: training.id,
      TRIAL_GROUP_CHECKOUT_ENABLED: true, isTrialGroupTraining: () => true,
      trialBookingBlocked: blocked, trialEligibilityKey: `${profile.id}:${training.id}`,
      currentTrialEligibility: { message: "fixture denial" },
      setDetailError: () => {}, setActionLoading: () => {}, setActionMessage: () => {},
      buildPaymentReturnUrls: () => ({ successUrl: "fixture-success", failUrl: "fixture-fail" }),
      getErrorMessage,
      apiCreateTournamentVivaTransaction: async params => {
        calls.push(params);
        return { data: null, error: { message: "fixture stop" } };
      },
    });
    await complete(training, checkout(), product(), "FIXTURE-PROMO");
    assert.equal(calls.length, blocked ? 0 : 1);
    if (!blocked) assert.equal(calls[0].promoCode, "FIXTURE-PROMO");
  }
});

test("actual trial transaction preserves the promo and owned visit source through the guarded single-shot route", async () => {
  const node = find(api, node => ts.isFunctionDeclaration(node) && node.name?.text === "apiCreateTournamentVivaTransaction");
  for (const source of ["one-time", "client-one-time"]) {
    const calls = [];
    const create = evaluate(node.getText(api).replace(/^export /, ""), {
      isSpanishTrainingExercise: () => false, isTrialGroupTraining, TRIAL_GROUP_CHECKOUT_ENABLED: true,
      createVivaPaymentWatcher: async () => ({ close() {} }),
      buildTournamentPaymentReturnUrls: () => ({ successUrl: null, failUrl: null }),
      buildTournamentVivaTransactionPayload: () => ({}),
      trialGroupCheckoutOperationId, getServ2Origin: () => "https://fixture.invalid",
      readVivaFailureCode: () => null,
      pickString: () => null,
      request: async (url, options) => {
        calls.push({ url, options });
        return { data: null, error: { message: "fixture unavailable" }, status: 503 };
      },
    });
    const params = { exerciseId: training.id, clientId: profile.id, product: product(source),
      exercise: { id: training.id, directionId: 4971 }, promoCode: source === "one-time" ? "FIXTURE-PROMO" : null };
    await create(params);
    await create(params);
    assert.equal(calls.length, 2, "one POST per deliberate attempt; no fallback or automatic retry");
    assert.equal(calls[0].url, calls[1].url, "retry retains the same guarded operation");
    assert.match(calls[0].url, /^\/lk\/trial-group-bookings\?operationId=/);
    assert.equal(calls[0].options.retries, 0);
    assert.deepEqual(JSON.parse(calls[0].options.body), {
      exerciseId: training.id, productId: params.product.id, source, promoCode: params.promoCode,
    });
  }
});
