import { isKidsAcademyTraining, isPadelKidsProduct, needsPadelKidsIdentity, PADEL_KIDS_PRODUCT_ID, resolvePadelKidsVisits } from "../../src/utils/kidsTrainingSubscriptions.ts";
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
    needsPadelKidsIdentity, resolvePadelKidsVisits,
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
    compositeInput: null, compositePlan: null, orderStatus: { kind: "NONE", allowNewPayment: true },
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

test("booking callback forwards the promo unchanged and cannot bypass trial eligibility or an unknown order", async () => {
  for (const [blocked, allowsPayment] of [[false, true], [true, true], [false, false]]) {
    const calls = [];
    const complete = callback("completeRegistration", {
      subscriptionUsageShadowEnabled: false, selectedId: training.id,
      orderAllowsNewPaymentRef: { current: allowsPayment },
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
    assert.equal(calls.length, blocked || !allowsPayment ? 0 : 1);
    if (calls.length) assert.equal(calls[0].promoCode, "FIXTURE-PROMO");
  }
});

test("actual trial transaction preserves the promo and owned visit source through the guarded single-shot route", async () => {
  const node = find(api, node => ts.isFunctionDeclaration(node) && node.name?.text === "apiCreateTournamentVivaTransaction");
  for (const source of ["one-time", "client-one-time"]) {
    const calls = [];
    const create = evaluate(node.getText(api).replace(/^export /, ""), {
      isSpanishTrainingExercise: () => false, isKidsAcademyTraining, isTrialGroupTraining, TRIAL_GROUP_CHECKOUT_ENABLED: true,
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

// Use the actual checkout normalizer/filter, rather than the identity stub above.
// The provider remains responsible for populating availableClientSubscriptions.
function subscriptionCheckoutReader(availableClientSubscriptions, exerciseOverrides = {}) {
  const calls = [];
  const exercise = {
    id: "fixture-new-exercise", type: { id: 847 }, direction: { id: 2680 },
    availableClientSubscriptions, ...exerciseOverrides,
  };
  const declarations = [
    "isRecord", "pickString", "pickNumber", "pickNestedRecord", "pickFirstArray", "extractItems",
    "normalizeCost", "normalizeVivaProduct", "normalizeVivaProducts", "collectComparableIds",
    "collectExerciseTypeIds", "isClientSubscriptionActive", "filterClientSubscriptionsForExercise",
    "apiFetchTournamentVivaCheckout",
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
    needsPadelKidsIdentity, resolvePadelKidsVisits,
    resolveSubscriptionCategoryDailyLimitCategoryFromEvent: () => "group_training",
    resolveClientSubscriptionProductNames: async items => items.map(item => ({
      ...item, name: item.raw.product?.name || item.name,
    })),
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
  const evidence = { subscriptionId: visit.id, product: { id: family.id } };
  const adultVisit = { ...visit, id: "adult-instance", raw: { productId: adult.id } };
  assert.equal(needsPadelKidsIdentity([visit]), true);
  assert.equal(needsPadelKidsIdentity([adultVisit]), false);
  const recovered = resolvePadelKidsVisits([visit, adultVisit], [evidence]);
  assert.deepEqual(recovered.map(row => row.id), [visit.id]);
  assert.equal(recovered[0].raw.visitsLeft, 5);
  assert.equal(isPadelKidsProduct(recovered[0]), true);
  assert.deepEqual(resolvePadelKidsVisits([visit], [evidence, evidence]), []);
  assert.deepEqual(resolvePadelKidsVisits([adultVisit], [{ ...evidence, subscriptionId: adultVisit.id }]), []);
});

test("kids training transaction rejects stale adult discounts and keeps the original promo and kids visit", async () => {
  const node = find(api, item => ts.isFunctionDeclaration(item) && item.name?.text === "apiCreateTournamentVivaTransaction");
  const writes = [];
  const create = evaluate(node.getText(api).replace(/^export /, ""), {
    isKidsAcademyTraining, isPadelKidsProduct, isChildTournamentExercise,
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
