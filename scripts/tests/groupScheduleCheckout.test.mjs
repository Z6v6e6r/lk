import { isKidsAcademyTraining, isPadelKidsProduct, needsPadelKidsIdentity, PADEL_KIDS_PRODUCT_ID, withPadelKidsIdentity } from "../../src/utils/kidsTrainingSubscriptions.ts";
import { isChildTournamentExercise } from "../../src/utils/tournamentSubscriptionDiscount.ts";
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
import { getGroupScheduleOwnedSubscriptions } from "../../src/utils/groupScheduleOwnedPacks.ts";
import { hasGroupTrainingSubscriptionEvidence } from "../../src/utils/groupScheduleSubscriptionOffer.ts";
import { resolveSubscriptionUsageDisplay } from "../../src/utils/subscriptionValidity.ts";
import { getTournamentBookingLevelDenial, preserveTournamentLevelDenial } from "../../src/utils/tournamentSignupAvailability.ts";

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
function callback(name, dependencies, source = page) {
  const node = find(source, node => ts.isVariableDeclaration(node) && node.name.getText(source) === name);
  return evaluate(node.initializer.arguments[0].getText(source), dependencies);
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

function checkoutReader(name, failed, extraExercise = {}, sellable = [product()]) {
  const calls = [];
  const exercise = { id: training.id, availableClientSubscriptions: [product("client-subscription", "owned-pack")],
    availableClientOneTimes: [product("client-one-time", "owned-visit")], ...extraExercise };
  const dependencies = {
    TENANT_KEY: "fixture",
    LK1_MONEY_DISCOUNT_CHECKOUT_ENABLED: false,
    request: async (url, options) => {
      calls.push({ url, options });
      if (failed.some(kind => url.includes(`/products/${kind}?`))) {
        return { data: null, error: { status: 503, message: "fixture failure" }, status: 503 };
      }
      const data = url.endsWith("/profile") ? profile : url.includes("/exercises/") ? exercise
        : failed.includes("empty") ? [] : url.includes("/products/subscriptions?") ? sellable : [product()];
      return { data, error: null, status: 200 };
    },
    isRecord: value => Boolean(value && typeof value === "object"),
    pickNestedRecord: () => null,
    pickString: () => null,
    resolveTournamentCustomPricing: () => null, isChildTournamentExercise, isKidsAcademyTraining, isPadelKidsProduct,
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

test("child tournament checkout preserves the paid tariff and omits subscription offers", async () => {
  for (const name of ["apiFetchTournamentVivaCheckout", "apiFetchTournamentVivaPublicCheckout"]) {
    const { read, calls } = checkoutReader(name, ["subscriptions"], { direction: { id: 7108 } });
    const result = await read(training.id);
    assert.equal(result.error, null);
    assert.equal(result.data.oneTimes.length, 1);
    assert.equal(result.data.oneTimes[0].cost, 150000);
    assert.deepEqual(result.data.clientSubscriptions, []);
    assert.deepEqual(result.data.subscriptions, []);
    assert.deepEqual(result.data.tariffErrors, []);
    assert.equal(calls.some(call => call.url.includes("/products/subscriptions?")), false);
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
      checkLevel: async () => true, registrationRequestIdRef: { current: 1 },
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
      isSpanishTrainingExercise: () => false, isKidsAcademyTraining, isTrialGroupTraining, TRIAL_GROUP_CHECKOUT_ENABLED: true,
      resolveSubscriptionCategoryDailyLimitCategoryFromEvent: () => "group_training",
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


test("tournament checkout uses only the durable CUP route, carries promo, and never falls back after unknown", async () => {
  const node = find(api, node => ts.isFunctionDeclaration(node) && node.name?.text === "apiCreateTournamentVivaTransaction");
  const cases = [
    ...["one-time", "client-one-time", "subscription"].map(source => ({ source, exercise: {} })),
    ...["one-time", "client-one-time"].map(source => ({
      source, exercise: { direction: { id: 7108 } }, checkoutContext: "tournament",
    })),
  ];
  for (const { source, exercise, checkoutContext } of cases) {
    const calls = [];
    const create = evaluate(node.getText(api).replace(/^export /, ""), {
      isSpanishTrainingExercise: () => false, isTrialGroupTraining: () => false, TRIAL_GROUP_CHECKOUT_ENABLED: true,
      isChildTournamentExercise, isKidsAcademyTraining, tournamentCheckoutRetryKeys: new Map(),
      resolveSubscriptionCategoryDailyLimitCategoryFromEvent: () => checkoutContext ? null : "tournament",
      createVivaPaymentWatcher: () => { throw Error("unbound payment watcher forbidden"); },
      buildTournamentPaymentReturnUrls: () => ({ successUrl: "https://padlhub.ru/ok", failUrl: "https://padlhub.ru/fail" }),
      buildTournamentVivaTransactionPayload: () => ({}), PHAB_API_BASE: "https://cup.example/api",
      pickString: (row, keys) => keys.map(key => row?.[key]).find(Boolean),
      request: async (url, options) => {
        calls.push({ url, options });
        return { data: { state: "PENDING_CONFIRMATION" }, error: null, status: 202 };
      },
    });
    const params = { checkoutContext, exerciseId: "tournament", clientId: "actor", exercise, product: product(source), promoCode: "PROMO" };
    await create(params); await create(params);
    assert.equal(calls.length, 2);
    for (const call of calls) {
      assert.equal(call.url, "https://cup.example/api/tournaments/tournament/checkout");
      assert.equal(call.options.retries, 0);
      assert.equal(call.options.headers["Idempotency-Key"], "tournament:tournament:actor");
      assert.deepEqual(JSON.parse(call.options.body), { productId: params.product.id, source, promoCode: "PROMO",
        successUrl: "https://padlhub.ru/ok", failUrl: "https://padlhub.ru/fail" });
    }
  }
});

test("the tournament page uses CUP even for unclassified or training-shaped source data", async () => {
  const tournamentPage = parse("src/components/tournament-signup/TournamentSignupPage.tsx");
  const checkoutCall = find(tournamentPage, node => ts.isCallExpression(node)
    && node.expression.getText(tournamentPage) === "apiCreateTournamentVivaTransaction");
  const context = find(tournamentPage, node => ts.isPropertyAssignment(node)
    && node.parent === checkoutCall.arguments[0] && node.name.getText(tournamentPage) === "checkoutContext");
  assert.equal(context.initializer.text, "tournament");

  const entry = find(api, node => ts.isFunctionDeclaration(node) && node.name?.text === "apiCreateTournamentVivaTransaction");
  const calls = [];
  const paused = { data: null, error: { status: 503, raw: { code: "TOURNAMENT_NEW_OPERATIONS_PAUSED" } }, status: 503 };
  let salesPaused = true;
  const ownerAttempts = [];
  const create = evaluate(`(${entry.getText(api).replace(/^export /, "")})`, {
    isSpanishTrainingExercise: () => false, isKidsAcademyTraining, isChildTournamentExercise,
    isTrialGroupTraining: isTrialGroupTraining, TRIAL_GROUP_CHECKOUT_ENABLED: true,
    resolveSubscriptionCategoryDailyLimitCategoryFromEvent: () => "group_training",
    createVivaPaymentWatcher: () => assert.fail("unexpected direct Viva payment watcher"),
    buildTournamentPaymentReturnUrls: () => ({ successUrl: null, failUrl: null }),
    buildTournamentVivaTransactionPayload: () => ({}), PHAB_API_BASE: "https://cup.example/api",
    tournamentCheckoutRetryKeys: new Map(), pickString: (row, keys) => row?.[keys[0]],
    request: async (url, options) => {
      assert.equal(options.method, "POST");
      assert.equal(options.retries, 0);
      calls.push([url, options.headers?.["Idempotency-Key"]]);
      if (salesPaused) return paused;
      ownerAttempts.push(url);
      return { data: { state: "PENDING_CONFIRMATION" }, error: null, status: 202 };
    },
  });
  for (const source of ["one-time", "client-one-time", "subscription"]) {
    for (const exercise of [{}, training]) {
      const result = await create({ checkoutContext: context.initializer.text, exerciseId: "cup-event",
        clientId: "actor", exercise, product: product(source) });
      assert.deepEqual(result, paused);
    }
  }
  assert.deepEqual(calls, Array.from({ length: 6 },
    () => ["https://cup.example/api/tournaments/cup-event/checkout", "tournament:cup-event:actor"]));

  salesPaused = false;
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(calls.length, 6);
  assert.deepEqual(ownerAttempts, [], "lifting the pause does not create a checkout");
  await create({ checkoutContext: "tournament", exerciseId: "cup-event", clientId: "actor", exercise: training, product: product() });
  assert.equal(calls.length, 7);
  assert.deepEqual(ownerAttempts, [calls[6][0]], "a new explicit checkout sends one POST after the pause");
});

test("LK1 tournament booking checks an ambiguous 202 with reads and clears the notice only on verified booking", async () => {
  const source = parse("src/components/tournament-signup/TournamentSignupPage.tsx");
  const pending = { data: null, error: { raw: { details: { code: "LK1_ALLOWANCE_BINDING_INVALID" } } }, status: 202 };
  const tournamentId = "fixture-tournament";
  const exerciseId = training.id;
  const currentCheckout = checkout();
  const token = () => "fixture-session";
  const requestId = { current: 1 };
  const noOp = () => {};
  let notice;
  let confirmed = false;
  const calls = [];
  const deps = {
    selectedId: tournamentId, selectedExerciseId: exerciseId, actionLoading: false, subscriptionUsageShadowEnabled: false,
    checkout: currentCheckout, isRestoringSession: false, checkoutRequestIdRef: requestId,
    detailRequestIdRef: { current: 0 },
    readAuthToken: token, tournamentPaymentSessionIdentity: value => value,
    checkLevel: async () => true, detail: null, selectedTournament: null, normalizePhone: value => value,
    setError: noOp, setActionLoading: noOp, setConfirmingSubscriptionProductKey: noOp, setCheckout: noOp,
    setSubscriptionConfirmationNotice: value => { notice = value; },
    getTournamentBookingLevelDenial,
    isTournamentCapacityError: () => false, items: [],
    setLoadingDetail: noOp, setRegistrationResolvedFor: noOp, setRegistrationSessionIdentity: noOp,
    setDetail: noOp, setRegistration: noOp, publicRosterDetailAbortRef: { current: null },
    apiFetchTournamentSignupDetail: async () => {
      calls.push("GET detail");
      return { data: { exerciseId } };
    },
    apiFetchTournamentMyRegistration: async () => {
      calls.push("GET CUP registration");
      return { data: { status: "NONE" } };
    },
    apiFetchTournamentVivaMyRegistration: async () => {
      calls.push("GET Viva registration");
      return { data: confirmed ? { status: "REGISTERED", bookingId: "fixture-booking" } : { status: "NONE" } };
    },
    loadPublicRoster: async () => { calls.push("GET roster"); },
    preserveTournamentLevelDenial,
    mergeTournamentPendingPayment: async (_token, _exercise, registration) => registration,
    apiReconcileTournamentOwner: () => assert.fail("read-only status check attempted a mutation"),
    apiCreateTournamentVivaTransaction: async () => { calls.push("POST booking"); return pending; },
  };
  const loadDetail = callback("loadDetail", { ...deps, isAuthenticated: true }, source);
  const book = callback("completeVivaRegistration", { ...deps, isAuthenticated: true, loadDetail }, source);
  await book(currentCheckout, product("client-subscription"));
  const reads = ["GET detail", "GET CUP registration", "GET Viva registration", "GET roster"];
  assert.deepEqual(calls, ["POST booking", ...reads]);
  assert.equal(notice, "Подтверждение записи или доплаты от Viva пока не получено.");

  await loadDetail(tournamentId, { checkOnly: true });
  assert.ok(notice);
  confirmed = true;
  await loadDetail(tournamentId, { checkOnly: true });
  assert.equal(notice, null);
  assert.deepEqual(calls, ["POST booking", ...reads, ...reads, ...reads]);

  const confirmation = find(source, node => ts.isJsxElement(node) && node.children.some(child =>
    ts.isJsxText(child) && child.getText(source).trim() === "Запись подтверждена."));
  const renderConfirmation = (registration, registrationSessionIdentity = token()) =>
    renderToStaticMarkup(evaluate(`(${confirmation.parent.parent.getText(source)})`, {
      loadingDetail: false, subscriptionConfirmationNotice: notice, isAuthenticated: true,
      selectedId: tournamentId, selectedExerciseId: exerciseId, registrationResolvedFor: `${tournamentId}:${exerciseId}`,
      registrationSessionIdentity, tournamentPaymentSessionIdentity: value => value, readAuthToken: token, registration,
    }));
  assert.equal(renderConfirmation({ status: "REGISTERED", bookingId: null }), "");
  assert.equal(renderConfirmation({ status: "REGISTERED", bookingId: "fixture-booking" }, "previous-session"), "");
  assert.match(renderConfirmation({ status: "REGISTERED", bookingId: "fixture-booking" }), /Запись подтверждена\./u);

  const submit = [];
  function visit(node) {
    if (ts.isCallExpression(node) && node.expression.getText(source) === "completeVivaRegistration") submit.push(node);
    ts.forEachChild(node, visit);
  }
  visit(source);
  assert.ok(submit.length > 0);
  assert.ok(submit.every(call => {
    // The void expression and arrow are children of the JSX click attribute.
    const attribute = call.parent.parent.parent.parent;
    return ts.isJsxAttribute(attribute) && attribute.name.getText(source) === "onClick";
  }), "neither OAuth completion nor passive reload can submit a booking");
});

test("only a durable CUP refusal rotates the key for a new explicit action", async () => {
  const names = ["tournamentCheckoutRetryKeys", "tournamentCheckoutRefusalMessages"];
  const declarations = names.map(name =>
    find(api, node => ts.isVariableDeclaration(node) && node.name.getText(api) === name).getText(api));
  const entry = find(api, node => ts.isFunctionDeclaration(node) && node.name?.text === "apiCreateTournamentVivaTransaction");
  const remember = find(api, node => ts.isFunctionDeclaration(node) && node.name?.text === "rememberTournamentCheckoutSuccessor");
  const calls = [];
  const operationId = "tournament-owner:11111111-1111-4111-8111-111111111111";
  const responses = [
    { data: null, error: { message: "lost" }, status: null },
    { data: { state: "REJECTED", code: "LEVEL_NOT_ALLOWED", operationId }, error: null, status: 201 },
    { data: { state: "PENDING_CONFIRMATION" }, error: null, status: 202 },
    { data: null, error: { message: "lost" }, status: null },
  ];
  const saved = new Map();
  const load = () => evaluate(`(() => { const ${declarations.join("; const ")}; ${remember.getText(api)}; ${entry.getText(api).replace(/^export /, "")}; return apiCreateTournamentVivaTransaction; })()`, {
    isSpanishTrainingExercise: () => false, isTrialGroupTraining: () => false, TRIAL_GROUP_CHECKOUT_ENABLED: true,
    isChildTournamentExercise, isKidsAcademyTraining, resolveSubscriptionCategoryDailyLimitCategoryFromEvent: () => "tournament",
    createVivaPaymentWatcher: () => { throw Error("unbound payment watcher forbidden"); },
    buildTournamentPaymentReturnUrls: () => ({ successUrl: null, failUrl: null }),
    buildTournamentVivaTransactionPayload: () => ({}), PHAB_API_BASE: "https://cup.example/api",
    globalThis: { sessionStorage: { getItem: key => saved.get(key), setItem: (key, value) => saved.set(key, value) } },
    pickString: (row, keys) => keys.map(key => row?.[key]).find(Boolean),
    request: async (url, options) => {
      assert.match(url, /\/tournaments\/tournament\/checkout$/);
      calls.push(options.headers["Idempotency-Key"]);
      return responses.shift();
    },
  });
  const create = load();
  const params = { exerciseId: "tournament", clientId: "actor", exercise: {}, product: product() };
  await create(params);
  const refusal = await create(params);
  assert.equal(refusal.status, 403);
  assert.match(refusal.error.message, /уровень/);
  assert.equal(calls.length, 2);
  await create(params);
  await load()(params);
  assert.deepEqual(calls, ["tournament:tournament:actor", "tournament:tournament:actor",
    `tournament-retry:${operationId}`, `tournament-retry:${operationId}`]);
});
// Use the actual checkout normalizer/filter, rather than the identity stub above.
// The provider remains responsible for populating availableClientSubscriptions.
function subscriptionCheckoutReader(availableClientSubscriptions, exerciseOverrides = {}, productLookup = {}) {
  const calls = [];
  const exercise = {
    id: "fixture-new-exercise", type: { id: 847 }, direction: { id: 2680 },
    availableClientSubscriptions, ...exerciseOverrides,
  };
  const declarations = [
    "isRecord", "pickString", "pickNumber", "pickNestedRecord", "pickFirstArray", "extractItems",
    "normalizeCost", "normalizeVivaProduct", "normalizeVivaProducts", "collectComparableIds",
    "collectExerciseTypeIds", "isClientSubscriptionActive", "filterClientSubscriptionsForExercise",
    "pickSubscriptionLookupId", "resolveClientSubscriptionProductNames", "apiFetchTournamentVivaCheckout",
  ].map(name => find(api, node => ts.isFunctionDeclaration(node) && node.name?.text === name)
    .getText(api).replace(/^export /, "")).join("\n");
  const read = evaluate(`(() => { ${declarations}; return apiFetchTournamentVivaCheckout; })()`, {
    TENANT_KEY: "fixture", LK1_MONEY_DISCOUNT_CHECKOUT_ENABLED: false,
    // Freeze eligibility at the incident date so expiry tests never depend on today's clock.
    Date: class extends Date { static now() { return Date.parse("2026-11-17T12:25:00Z"); } },
    request: async (url, options) => {
      calls.push({ url, options });
      const data = url.endsWith("/profile") ? profile : url.includes("/exercises/") ? exercise : [];
      return { data, error: null, status: 200 };
    },
    resolveTournamentCustomPricing: () => null, isChildTournamentExercise, isKidsAcademyTraining, isPadelKidsProduct,
    needsPadelKidsIdentity, withPadelKidsIdentity,
    resolveSubscriptionCategoryDailyLimitCategoryFromEvent: () => "group_training",
    apiFetchSubscriptioName: async id => {
      const data = productLookup[id] ?? { sertName: availableClientSubscriptions.find(item =>
        item.subscriptionId === id)?.product?.name || "" };
      return { data, error: null, status: 200 };
    },
  });
  return { read: () => read(exercise.id), calls, exercise };
}

// De-identified provider shape: active RA, 19/30 visits and booking history.
// All instance, booking and exercise identifiers are synthetic.
function ownedRa(overrides = {}) {
  return {
    subscriptionId: "fixture-owned-ra",
    product: { id: "b91e14d1-fe6e-4d0b-be39-3e45ad86b759", name: "РА" },
    status: "ACTIVE", visitsTotal: 30, visitsLeft: 19,
    purchaseDate: "2026-11-13T08:15:00", activationDate: "2026-11-13T08:17:00",
    expirationDate: "2026-12-13", availableDays: [],
    hasTypeLimitation: true, availableTypes: [{ id: 847, name: "Игра+Тренер" }],
    hasDirectionLimitation: true, availableDirections: [{ id: 2680, name: "Игра+Тренер уровень D+" }],
    activationBooking: { id: "fixture-activation-booking", exerciseId: "fixture-past-exercise" },
    bookings: [{ id: "fixture-past-booking", exerciseId: "fixture-past-exercise" },
      { id: "fixture-reserved-booking", exerciseId: "fixture-another-exercise" }],
    ...overrides,
  };
}

async function checkoutSubscriptions(rows, exerciseOverrides = {}) {
  const harness = subscriptionCheckoutReader(rows, exerciseOverrides);
  const result = await harness.read();
  assert.equal(result.error, null);
  assert.ok(harness.calls.every(call => call.options.method === "GET"), "reading options must not write or charge");
  assert.deepEqual(result.data.purchasedProducts, result.data.clientSubscriptions);
  return result.data.clientSubscriptions;
}

test("active RA with activation and booking history remains selectable for a new exercise", async () => {
  const raw = ownedRa();
  const before = structuredClone(raw);
  const subscriptions = await checkoutSubscriptions([raw]);
  assert.deepEqual(subscriptions.map(item => item.id), [raw.subscriptionId]);
  assert.equal(subscriptions[0].source, "client-subscription");
  assert.equal(subscriptions[0].name, "РА");
  assert.equal(subscriptions[0].raw.visitsLeft, 19);
  assert.deepEqual(raw, before, "history and subscription identity must not be changed");
});

test("booking provenance does not become a type or direction restriction, including nested history", async () => {
  const raw = ownedRa({
    activationBooking: { typeId: 605 }, bookings: [{ directionId: 3685 }],
    subscription: { bookings: [{ exerciseId: "fixture-other-exercise" }] },
  });
  assert.equal((await checkoutSubscriptions([raw])).length, 1);
});

test("explicit exercise restrictions still apply and history cannot satisfy or override them", async () => {
  for (const key of ["exerciseId", "vivaExerciseId", "availableExerciseIds", "exerciseIds", "sourceExerciseId"]) {
    const ids = value => key.endsWith("Ids") ? [value] : value;
    for (const nested of [false, true]) {
      const restriction = value => nested ? { subscription: { [key]: ids(value) } } : { [key]: ids(value) };
      assert.equal((await checkoutSubscriptions([ownedRa(restriction("fixture-new-exercise"))])).length, 1, key);
      assert.equal((await checkoutSubscriptions([ownedRa({
        ...restriction("fixture-excluded-exercise"),
        activationBooking: { exerciseId: "fixture-new-exercise" },
        bookings: [{ exerciseId: "fixture-new-exercise" }],
      })])).length, 0, key);
    }
  }
});

test("type and direction restrictions cannot be widened by matching historical bookings", async () => {
  for (const key of ["exerciseTypeId", "exerciseTypeIds", "typeId", "typeIds", "vivaExerciseTypeId",
    "directionId", "directionIds", "vivaDirectionId"]) {
    const matching = key.toLowerCase().includes("direction") ? 2680 : 847;
    const restriction = value => ({ [key]: key.endsWith("Ids") ? [value] : value });
    assert.equal((await checkoutSubscriptions([ownedRa({ ...restriction(matching) })])).length, 1, key);
    assert.equal((await checkoutSubscriptions([ownedRa({
      ...restriction(9999), activationBooking: restriction(matching), bookings: [restriction(matching)],
    })])).length, 0, key);
  }
  assert.equal((await checkoutSubscriptions([ownedRa({ typeId: 9999 })], {
    bookings: [{ typeId: 9999 }], activationBooking: { typeId: 9999 },
  })).length, 0, "event booking history must not widen the event's own type either");
});

test("expired, cancelled, blocked, archived and exhausted subscriptions remain excluded", async () => {
  for (const overrides of [
    ...["EXPIRED", "CANCELLED", "BLOCKED", "ARCHIVED"].map(status => ({ status })),
    { expirationDate: "2026-11-13" }, { visitsLeft: 0 },
  ]) {
    assert.equal((await checkoutSubscriptions([ownedRa(overrides)])).length, 0, JSON.stringify(overrides));
  }
  assert.equal((await checkoutSubscriptions([ownedRa({ activationBooking: null, bookings: [] })])).length, 1);
});

test("empty provider availability never manufactures an owned subscription from event history", async () => {
  assert.deepEqual(await checkoutSubscriptions([], { bookings: [{ subscription: ownedRa() }] }), []);
});

test("unrelated primitive arrays do not become exercise ids or override explicit eligibility", async () => {
  const unrelated = { availableDays: ["MONDAY", "TUESDAY"], tags: ["fixture-new-exercise", 847] };
  assert.equal((await checkoutSubscriptions([ownedRa(unrelated)])).length, 1);
  assert.equal((await checkoutSubscriptions([ownedRa({ ...unrelated,
    availableExerciseIds: ["fixture-excluded-exercise"],
  })])).length, 0);
  assert.equal((await checkoutSubscriptions([ownedRa({ typeId: 9999 })], {
    availableClientOneTimes: [{ typeId: 9999 }],
  })).length, 0);
});

test("retained RA renders an owned booking button and passes the same instance to registration", async () => {
  const clientSubscriptions = await checkoutSubscriptions([ownedRa()]);
  const current = checkout({ clientSubscriptions, purchasedProducts: clientSubscriptions });
  const ownedSubscriptions = getGroupScheduleOwnedSubscriptions(clientSubscriptions, []);
  const calls = [];
  const tree = paymentOptions({
    checkout: current, ownedSubscriptions, proTrainingSelected: false,
    resolveSubscriptionUsageDisplay,
    shouldShowSubscriptionPurchaseLink: !hasGroupTrainingSubscriptionEvidence(clientSubscriptions, []),
    completeRegistration: (...args) => calls.push(args),
  });
  const html = renderToStaticMarkup(tree);
  assert.match(html, /Ваши абонементы/);
  assert.doesNotMatch(html, /Приобрести подписку РА/);
  const button = elements(tree, "button").find(item => renderToStaticMarkup(item).includes("РА"));
  assert.ok(button);
  assert.equal(button.props.disabled, false);
  button.props.onClick();
  assert.deepEqual(calls[0], [training, current, clientSubscriptions[0]]);
  assert.equal(calls[0][2].id, "fixture-owned-ra");
  assert.equal(calls[0][2].source, "client-subscription");
  // Managed prices must still use their existing path; pending checks must not expose a free visit.
  assert.deepEqual(getGroupScheduleOwnedSubscriptions(clientSubscriptions, null), []);
  assert.deepEqual(getGroupScheduleOwnedSubscriptions(clientSubscriptions, [{
    subscriptionId: "fixture-owned-ra", discountPercent: 50,
  }]), []);
});

test("kids training keeps the one-time price and only the exact Padel Kids plan", async () => {
  const family = { id: PADEL_KIDS_PRODUCT_ID, name: "Падел.Дети", cost: 1980000 };
  const adult = { id: "adult-product", name: "Падел.Дети", cost: 500000 };
  for (const directionId of [2468, 2975, 3163]) {
    assert.equal(isKidsAcademyTraining({ exerciseDirection: { directionId: String(directionId) } }), true);
    const { read } = checkoutReader("apiFetchTournamentVivaPublicCheckout", [], { directionId }, [family, adult]);
    const result = await read(training.id);
    assert.deepEqual(result.data.subscriptions.map(row => row.id), [family.id]);
    assert.equal(result.data.oneTimes[0].cost, 150000);
  }
  const partial = checkoutReader("apiFetchTournamentVivaPublicCheckout", [], {}, [family, adult]);
  const withSummary = await partial.read(training.id, { tournament: { directionId: 2975 } });
  assert.deepEqual(withSummary.data.subscriptions.map(row => row.id), [family.id]);
  assert.equal(isKidsAcademyTraining({ directionId: 7108 }), false);
  assert.equal(isKidsAcademyTraining({ directionId: 2975.5 }), false);
  assert.equal(isKidsAcademyTraining({ title: "Детская тренировка" }), false);
  const visit = { id: "kids-instance", source: "client-subscription", raw: { visitsLeft: 5 } };
  const adultVisit = { ...visit, id: "adult-instance", raw: { productId: adult.id } };
  assert.equal(needsPadelKidsIdentity(visit), true);
  assert.equal(needsPadelKidsIdentity(adultVisit), false);
  const recovered = withPadelKidsIdentity(visit, family.id);
  assert.equal(recovered.id, visit.id);
  assert.equal(recovered.raw.visitsLeft, 5);
  assert.equal(isPadelKidsProduct(recovered), true);
  assert.equal(withPadelKidsIdentity(adultVisit, family.id), adultVisit);
  assert.equal(withPadelKidsIdentity(visit, adult.id), visit);
});

test("eligible new Padel Kids visits missing a catalogue ID are shown only after exact gateway identification", async () => {
  const kids = { subscriptionId: "fixture-kids-visit", status: "NEW", visitsLeft: 30,
    activationDate: null, expirationDate: null, availableDirections: [{ id: 2468 }] };
  const adult = { ...kids, subscriptionId: "fixture-adult-visit" };
  const unresolved = { ...kids, subscriptionId: "fixture-unknown-visit" };
  const exhausted = { ...kids, subscriptionId: "fixture-exhausted-visit", visitsLeft: 0 };
  const known = { ...kids, subscriptionId: "fixture-explicit-adult", productId: "other-product" };
  const lookup = {
    [kids.subscriptionId]: { sertName: "Падел.Дети", productId: PADEL_KIDS_PRODUCT_ID.toUpperCase() },
    [adult.subscriptionId]: { sertName: "Падел.Дети", productId: "other-product" },
    [unresolved.subscriptionId]: { sertName: { name: "Падел.Дети" } },
    [exhausted.subscriptionId]: { sertName: "Падел.Дети", productId: PADEL_KIDS_PRODUCT_ID },
    [known.subscriptionId]: { sertName: "Падел.Дети", productId: PADEL_KIDS_PRODUCT_ID },
  };
  const { read } = subscriptionCheckoutReader([kids, adult, unresolved, exhausted, known], {
    direction: { id: 2468 }, type: { id: 605 },
  }, lookup);
  const result = await read();
  assert.deepEqual(result.data.clientSubscriptions.map(row => [row.id, row.name, row.raw.visitsLeft]),
    [[kids.subscriptionId, "Падел.Дети", 30]]);
  assert.equal(isPadelKidsProduct(result.data.clientSubscriptions[0]), true);
  assert.deepEqual(result.data.purchasedProducts, result.data.clientSubscriptions);
});

test("kids training transaction rejects stale adult discounts and keeps the original promo and kids visit", async () => {
  const node = find(api, item => ts.isFunctionDeclaration(item) && item.name?.text === "apiCreateTournamentVivaTransaction");
  const writes = [];
  const create = evaluate(node.getText(api).replace(/^export /, ""), {
    isKidsAcademyTraining, isPadelKidsProduct, isChildTournamentExercise,
    resolveSubscriptionCategoryDailyLimitCategoryFromEvent: () => "group_training",
    isSpanishTrainingExercise: () => false, TRIAL_GROUP_CHECKOUT_ENABLED: false,
    API_BASE: "https://fixture.invalid", TENANT_KEY: "fixture",
    createVivaPaymentWatcher: async () => ({ close() {} }),
    buildTournamentPaymentReturnUrls: () => ({ successUrl: null, failUrl: null }),
    buildTournamentVivaTransactionPayload: params => ({
      exerciseId: params.exerciseId, productId: params.product.id, source: params.product.source, promoCode: params.promoCode,
    }),
    readVivaFailureCode: () => null, pickString: () => null,
    request: async (_url, options) => {
      writes.push(JSON.parse(options.body));
      return { data: null, error: { message: "fixture refusal" }, status: 409 };
    },
    apiCreateTournamentVivaBookingFromSubscription: async params => {
      writes.push({ visit: params.product.id });
      return { data: { bookingId: "not-written" }, error: null, status: 200 };
    },
  });
  const params = { exerciseId: training.id, exercise: { directionId: 2975 }, promoCode: "FIXTURE-PROMO" };
  const adult = product("client-subscription", "fixture-adult");
  for (const rejected of [adult, { ...adult, source: "subscription" },
    ...[100, 50].map(discountPercent => ({ ...adult, groupDiscountQuote: { discountPercent } }))]) {
    assert.equal((await create({ ...params, product: rejected })).status, 409);
  }
  assert.deepEqual(writes, []);
  await create({ ...params, product: { ...product(), cost: 300000 } });
  await create({ ...params, promoCode: null, product: { ...adult, id: "fixture-kids-visit", raw: { productId: PADEL_KIDS_PRODUCT_ID } } });
  assert.deepEqual(writes, [
    { exerciseId: training.id, productId: product().id, source: "one-time", promoCode: "FIXTURE-PROMO" },
    { visit: "fixture-kids-visit" },
  ]);
});
