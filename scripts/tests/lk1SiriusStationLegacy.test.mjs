// Sirius («Сочи», 233c1405-…) keeps the pre-rollout subscription behaviour for the
// «Лето.Падел.Дружба» product the club sells: the plan rule for that product charges
// 50 % for a tournament, while rule 7 of the rollout contract keeps the club legacy
// (owner decision 2026-09-18). The exclusion is a station x product pair in its own
// reviewed global, and the resolver is the single place that applies it — the booking
// gateway and the price preview both reach it, so the preview cannot advertise a
// discount the write path refuses to charge.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';
import { hubGatewaySource } from '../lib/eventPaymentSources.mjs';
import {
  LK1_HUB_PRODUCT_ID,
  LK1_PLAN_RULES_GLOBAL,
  LK1_STATION_EXCLUSIONS_GLOBAL,
  resolveLk1Rule,
} from '../lib/lk1PlanRules.mjs';
import { LK1_PLAN_RULES_DESIRED } from '../lib/lk1PlanRulesTransition.mjs';
import { buildGatewayInitialize } from '../patch_live_lk1_plan_rules.mjs';
import {
  LK1_SIRIUS_FRIENDSHIP_PRODUCT_ID,
  LK1_SIRIUS_STATION_ID,
  LK1_STATION_EXCLUSIONS_DESIRED,
  buildStationExclusionsTransition,
} from '../lib/lk1StationExclusionsTransition.mjs';

const read = relative => fs.readFileSync(new URL(relative, import.meta.url), 'utf8');
const PREFIX = 'LK1_SIRIUS_';
const STATION_KEY = LK1_STATION_EXCLUSIONS_GLOBAL;
const RA = 'b91e14d1-fe6e-4d0b-be39-3e45ad86b759';
const ACADEMY = '9eb8a7a4-c195-492a-95e4-3fb82899ac10';
const ENERGY_5 = 'dfa72adf-233b-4285-8d69-e5eab4234fbe';
const OTHER_STATION = '6a7a9edc-6869-40ad-a5a1-8a1cdfb746a1';
const FIELDS = { maxActiveBookings: 4, freeGameMinutesPerDay: 60,
  gameOverageDiscountPercent: 30, groupTrainingDiscountPercent: 50, tournamentDiscountPercent: 50 };
const hubPolicy = () => ({ productId: LK1_HUB_PRODUCT_ID, ...FIELDS });

// Node-RED function bodies cannot import: the release composition prepends this
// module to the gateway body, so the suite evaluates the committed module source
// with the same host helpers and a per-key global store.
const moduleSource = read('../lib/lk1PlanRules.mjs').replace(/^export /gm, '');
const bind = (host = {}) => new Function(
  'normalizeId', 'collectExactProductIds', 'collectSubscriptionPurchaseDateEvidence',
  'isValidDateKey', 'lk1ReadBoundPolicy', 'global',
  `${moduleSource}\nreturn { resolveLk1Rule, normalizeStationExclusions };`,
)(
  host.normalizeId || ((value) => (typeof value === 'string' ? value.trim().toLowerCase() : null)),
  host.collectExactProductIds || (() => []),
  host.collectSubscriptionPurchaseDateEvidence || (() => ({ dates: ['2026-09-05'], invalid: false })),
  host.isValidDateKey || ((value) => /^\d{4}-\d{2}-\d{2}$/.test(value)),
  host.lk1ReadBoundPolicy || (() => hubPolicy()),
  host.global || { get: () => undefined },
);
const dateFrom = (dates, invalid = false) => ({
  collectSubscriptionPurchaseDateEvidence: () => ({ dates, invalid }),
});
// The released runtime store: the rollout rules and the station exclusions live in
// two separate globals, so a stub must answer per key.
const store = (values = {}) => ({ get: (key) => values[key] });
const released = host => bind({
  global: store({ [LK1_PLAN_RULES_GLOBAL]: LK1_PLAN_RULES_DESIRED, [STATION_KEY]: LK1_STATION_EXCLUSIONS_DESIRED }),
  ...host,
});
const owned = (productId, purchaseDate) => [{ productId, purchaseDate }];

test(`${PREFIX}the Sirius friendship pair keeps the pre-rollout verdict`, () => {
  const result = released().resolveLk1Rule({ owned: owned(LK1_SIRIUS_FRIENDSHIP_PRODUCT_ID, '2026-09-05'),
    stationId: LK1_SIRIUS_STATION_ID });
  assert.equal(result.matched, true);
  assert.equal(result.legacy, true);
  assert.equal(result.stationLegacy, true);
  assert.equal(result.code, undefined);
  assert.equal(result.rule, undefined, 'a legacy verdict must not carry a rule');
  assert.equal(result.source, 'PLAN');
  assert.equal(result.planKey, 'friendship');
  assert.equal(result.stationId, LK1_SIRIUS_STATION_ID);
  assert.equal(result.productId, LK1_SIRIUS_FRIENDSHIP_PRODUCT_ID);
  // The sale date never gates an excluded pair: the exclusion is the whole verdict,
  // so an instance without a usable date is still legacy instead of a 202-confirmation.
  for (const host of [dateFrom([]), dateFrom(['2026-09-05'], true)]) {
    const unresolved = released(host).resolveLk1Rule({ owned: owned(LK1_SIRIUS_FRIENDSHIP_PRODUCT_ID, '2026-09-05'),
      stationId: LK1_SIRIUS_STATION_ID });
    assert.equal(unresolved.legacy, true);
    assert.equal(unresolved.code, undefined);
  }
});

test(`${PREFIX}the exclusion never reaches another station or another product`, () => {
  const otherStation = released().resolveLk1Rule({ owned: owned(LK1_SIRIUS_FRIENDSHIP_PRODUCT_ID, '2026-09-05'),
    stationId: OTHER_STATION });
  assert.equal(otherStation.legacy, false, 'the same product stays enforced outside the excluded station');
  assert.equal(otherStation.rule.tournamentDiscountPercent, 50);
  const otherProduct = released().resolveLk1Rule({ owned: owned(RA, '2026-09-05'), stationId: LK1_SIRIUS_STATION_ID });
  assert.equal(otherProduct.legacy, false, 'another product keeps its rule at the excluded station');
  assert.equal(otherProduct.rule.productId, RA);
  // A product the rules do not name is untouched: no rule, no exclusion, no error.
  const unknown = released().resolveLk1Rule({ owned: owned(ENERGY_5, '2026-09-05'), stationId: LK1_SIRIUS_STATION_ID });
  assert.equal(unknown.matched, false);
  assert.equal(unknown.stationLegacy, undefined);
  // The annual HUB is not part of the shipped exclusion, whatever the station is.
  const hub = released().resolveLk1Rule({ owned: owned(LK1_HUB_PRODUCT_ID, '2026-08-15'), stationId: LK1_SIRIUS_STATION_ID });
  assert.equal(hub.legacy, false);
  assert.equal(hub.source, 'HUB');
});

test(`${PREFIX}a missing or malformed station cannot decide the contour`, () => {
  for (const stationId of [undefined, null, '', '   ', 'not-a-uuid', 42, {}]) {
    const result = released().resolveLk1Rule({ owned: owned(LK1_SIRIUS_FRIENDSHIP_PRODUCT_ID, '2026-09-05'), stationId });
    assert.equal(result.legacy, false, String(stationId));
    assert.equal(result.rule.tournamentDiscountPercent, 50, String(stationId));
  }
  // The target station may arrive in a different case; the pair is matched normalized.
  const upper = released().resolveLk1Rule({ owned: owned(LK1_SIRIUS_FRIENDSHIP_PRODUCT_ID, '2026-09-05'),
    stationId: LK1_SIRIUS_STATION_ID.toUpperCase() });
  assert.equal(upper.legacy, true);
  // A station UUID without the product version/variant nibbles still matches: the
  // station pattern is deliberately wider than the product pattern.
  const oddStation = '233c1405-1eac-00de-00c6-1cf7e24c9276';
  const odd = released({ global: store({ [LK1_PLAN_RULES_GLOBAL]: LK1_PLAN_RULES_DESIRED,
    [STATION_KEY]: { formatVersion: 1, exclusions: [{ stationId: oddStation, productIds: [LK1_SIRIUS_FRIENDSHIP_PRODUCT_ID] }] } }) })
    .resolveLk1Rule({ owned: owned(LK1_SIRIUS_FRIENDSHIP_PRODUCT_ID, '2026-09-05'), stationId: oddStation });
  assert.equal(odd.legacy, true);
  assert.equal(odd.stationId, oddStation);
});

test(`${PREFIX}an absent exclusion global excludes nothing, an unreadable one fails closed`, () => {
  const absent = bind({ global: store({ [LK1_PLAN_RULES_GLOBAL]: LK1_PLAN_RULES_DESIRED }) })
    .resolveLk1Rule({ owned: owned(LK1_SIRIUS_FRIENDSHIP_PRODUCT_ID, '2026-09-05'), stationId: LK1_SIRIUS_STATION_ID });
  assert.equal(absent.legacy, false, 'the exclusion is opt-in: no global means the rule applies');
  const unreadable = { get: (key) => {
    if (key === STATION_KEY) throw new Error('global store unavailable');
    return LK1_PLAN_RULES_DESIRED;
  } };
  const failed = bind({ global: unreadable })
    .resolveLk1Rule({ owned: owned(LK1_SIRIUS_FRIENDSHIP_PRODUCT_ID, '2026-09-05'), stationId: LK1_SIRIUS_STATION_ID });
  assert.equal(failed.matched, true);
  assert.equal(failed.code, 'LK1_STATION_EXCLUSIONS_INVALID');
  assert.equal(failed.legacy, undefined);
});

test(`${PREFIX}an unreadable exclusion set never refuses the annual HUB`, () => {
  // The exclusion may only downgrade a pair the rules already cover; the shipped payload
  // names no HUB pair, so a foreign or unreadable set must not block the annual product.
  const cases = [
    ['throwing store', { get: (key) => {
      if (key === STATION_KEY) throw new Error('global store unavailable');
      return LK1_PLAN_RULES_DESIRED;
    } }, 'LK1_STATION_EXCLUSIONS_INVALID'],
    ['wrong exclusions type', store({ [LK1_PLAN_RULES_GLOBAL]: LK1_PLAN_RULES_DESIRED,
      [STATION_KEY]: { formatVersion: 1, exclusions: 'nope' } }), 'LK1_STATION_EXCLUSIONS_INVALID'],
    ['foreign formatVersion', store({ [LK1_PLAN_RULES_GLOBAL]: LK1_PLAN_RULES_DESIRED,
      [STATION_KEY]: { formatVersion: 2, exclusions: [] } }), 'LK1_STATION_EXCLUSIONS_INVALID'],
    ['malformed station id', store({ [LK1_PLAN_RULES_GLOBAL]: LK1_PLAN_RULES_DESIRED,
      [STATION_KEY]: { formatVersion: 1, exclusions: [{ stationId: 'not-a-uuid', productIds: [RA] }] } }),
      'LK1_STATION_EXCLUSIONS_INVALID'],
    ['absent global', store({ [LK1_PLAN_RULES_GLOBAL]: LK1_PLAN_RULES_DESIRED }), undefined],
  ];
  for (const [label, stored, planCode] of cases) {
    const hub = bind({ global: stored }).resolveLk1Rule({ owned: owned(LK1_HUB_PRODUCT_ID, '2026-08-15'),
      stationId: LK1_SIRIUS_STATION_ID });
    assert.equal(hub.matched, true, label);
    assert.equal(hub.legacy, false, `${label}: the annual HUB keeps its rule`);
    assert.equal(hub.rule.productId, LK1_HUB_PRODUCT_ID, label);
    assert.equal(hub.code, undefined, label);
    // The same store still decides a plan product: fail-closed on an unreadable set,
    // and the ordinary rule when the exclusion global is simply absent.
    const plan = bind({ global: stored }).resolveLk1Rule({ owned: owned(LK1_SIRIUS_FRIENDSHIP_PRODUCT_ID, '2026-09-05'),
      stationId: LK1_SIRIUS_STATION_ID });
    assert.equal(plan.code, planCode, label);
    if (planCode === undefined) assert.equal(plan.legacy, false, label);
  }
});

test(`${PREFIX}the exclusion shape is frozen and rejects drift`, () => {
  const accepted = bind({}).normalizeStationExclusions;
  assert.deepEqual([...accepted(LK1_STATION_EXCLUSIONS_DESIRED).exclusions.keys()], [LK1_SIRIUS_STATION_ID]);
  for (const value of [undefined, null, '', 'null']) {
    assert.deepEqual([...accepted(value).exclusions.keys()], []);
  }
  assert.deepEqual([...accepted(JSON.stringify(LK1_STATION_EXCLUSIONS_DESIRED)).exclusions.keys()], [LK1_SIRIUS_STATION_ID]);
  const malformed = [
    'not json', 42, [], {},
    { formatVersion: 2, exclusions: [] },
    { formatVersion: 1 },
    { formatVersion: '1', exclusions: [] },
    { formatVersion: 1, exclusions: {}, extra: true },
    { formatVersion: 1, exclusions: [], extra: true },
    { formatVersion: 1, exclusions: [{ stationId: 'not-a-uuid', productIds: [LK1_SIRIUS_FRIENDSHIP_PRODUCT_ID] }] },
    { formatVersion: 1, exclusions: [{ stationId: LK1_SIRIUS_STATION_ID, productIds: [] }] },
    { formatVersion: 1, exclusions: [{ stationId: LK1_SIRIUS_STATION_ID, productIds: 'not-a-list' }] },
    { formatVersion: 1, exclusions: [{ stationId: LK1_SIRIUS_STATION_ID, productIds: ['not-a-uuid'] }] },
    { formatVersion: 1, exclusions: [{ stationId: LK1_SIRIUS_STATION_ID, productIds: [RA, RA] }] },
    { formatVersion: 1, exclusions: [{ stationId: LK1_SIRIUS_STATION_ID, productIds: [RA], extra: 1 }] },
    { formatVersion: 1, exclusions: [
      { stationId: LK1_SIRIUS_STATION_ID, productIds: [RA] },
      { stationId: LK1_SIRIUS_STATION_ID, productIds: [ACADEMY] },
    ] },
  ];
  for (const stored of malformed) {
    for (const value of [stored, typeof stored === 'string' ? stored : JSON.stringify(stored)]) {
      const result = bind({}).normalizeStationExclusions(value);
      assert.equal(result.ok, false, JSON.stringify(value));
      assert.equal(result.code, 'LK1_STATION_EXCLUSIONS_INVALID', JSON.stringify(value));
    }
  }
});

test(`${PREFIX}the shipped payload names exactly the Sirius friendship pair`, () => {
  assert.deepEqual(LK1_STATION_EXCLUSIONS_DESIRED, { formatVersion: 1, exclusions: [
    { stationId: LK1_SIRIUS_STATION_ID, productIds: [LK1_SIRIUS_FRIENDSHIP_PRODUCT_ID] },
  ] });
});

test(`${PREFIX}the transition writes the payload once and refuses a foreign prior`, () => {
  const transition = buildStationExclusionsTransition({
    expectedPrior: null,
    desired: LK1_STATION_EXCLUSIONS_DESIRED,
  });
  assert.deepEqual(transition.desired, LK1_STATION_EXCLUSIONS_DESIRED);
  assert.equal(transition.expectedPrior, null);
  for (const marker of [`const lk1StationExclusionsKey = "${STATION_KEY}";`,
    'global.set(lk1StationExclusionsKey, lk1DesiredStationExclusions);',
    'station exclusions prior mismatch; no overwrite',
    'station exclusions readback mismatch']) {
    assert.ok(transition.initialize.includes(marker), `initialize must carry: ${marker}`);
  }
  const values = new Map();
  const globalStore = { get: (key) => values.get(key), set: (key, value) => values.set(key, value) };
  new Function('global', transition.initialize)(globalStore);
  assert.deepEqual(values.get(STATION_KEY), LK1_STATION_EXCLUSIONS_DESIRED);
  // Idempotent: the same generation applied twice must not rewrite or throw.
  new Function('global', transition.initialize)(globalStore);
  // A different prior is never overwritten: the value, not the runner, decides.
  const foreign = new Map([[STATION_KEY, { formatVersion: 1, exclusions: [
    { stationId: OTHER_STATION, productIds: [RA] },
  ] }]]);
  assert.throws(() => new Function('global', transition.initialize)({
    get: (key) => foreign.get(key), set: (key, value) => foreign.set(key, value),
  }), /station exclusions prior mismatch; no overwrite/);
  assert.throws(() => buildStationExclusionsTransition({
    expectedPrior: null,
    desired: { formatVersion: 1, exclusions: [{ stationId: LK1_SIRIUS_STATION_ID, productIds: [RA, RA] }] },
  }), /shape mismatch/);
  assert.throws(() => buildStationExclusionsTransition({ expectedPrior: null }), /Explicit station-exclusions/);
});

// ---------------------------------------------------------------------------
// Call-site wiring: every contour decision in the shipped bodies has to receive
// the target station, and the two readers have to stay declared exactly once.
// ---------------------------------------------------------------------------

test(`${PREFIX}the booking gateway passes the target station to every contour decision`, () => {
  const gateway = read('../nodered_lk1_hub_nodes/gateway.js');
  assert.ok(gateway.includes('const lk1Config = (owned, stationId) => {'));
  assert.ok(gateway.includes('resolveLk1Rule({ owned, planRules: lk1ReadPlanRules(), stationId,'));
  assert.ok(gateway.includes('stationExclusions: lk1ReadStationExclusions() });'));
  assert.ok(gateway.includes('const configured = lk1Config(owned, exercise?.studio?.id || exercise?.studioId || null);'),
    'the quote resolves the station of the priced exercise');
  assert.ok(gateway.includes('const configured = lk1Config(selected, exercise?.studio?.id || exercise?.studioId || null);'),
    'the money-ownership step resolves the station of the priced exercise');
  assert.ok(gateway.includes('ctx.lk1.target?.stationId || ctx.studioId || null);'),
    'the checkout re-resolution reuses the station of the stored quote');
  // The ingress gate decides the managed branch before any quote exists: without the
  // station there, an excluded pair would still enter the managed path.
  const hooks = read('../nodered_lk1_hub_nodes/gateway_hooks.js');
  assert.ok(hooks.includes('const selectedRule = lk1Config(selectedOwned, exercise?.studio?.id || exercise?.studioId || null);'));
  assert.ok(hooks.includes('const productRule = lk1Config(ownedSubscriptions, exercise?.studio?.id || exercise?.studioId || null);'));
  // The release composition embeds the module once, so both readers exist once.
  const composed = hubGatewaySource();
  for (const declaration of ['const LK1_PLAN_RULES_GLOBAL =', 'const LK1_STATION_EXCLUSIONS_GLOBAL =',
    'function resolveLk1Rule(', 'function lk1ReadPlanRules(', 'function lk1ReadStationExclusions(']) {
    assert.equal(composed.split(declaration).length, 2, `${declaration} must be declared exactly once`);
  }
});

test(`${PREFIX}the money mandate and the preview resolve the same station`, () => {
  const product = read('../nodered_subscription_product_nodes/gateway.js');
  assert.ok(product.includes('const identityMoneyOwned = (ctx, rows, exercise) => {'));
  assert.ok(product.includes('const configured = lk1Config(projected, exercise?.studio?.id || exercise?.studioId || null);'),
    'the money mandate resolves the station of the readback exercise');
  assert.ok(product.includes("&& resolveCategory(exercise) === 'group_training') return identityMoneyOwned(ctx, rows, exercise);"));
  const router = read('../nodered_subscription_price_preview_nodes/router.js');
  assert.ok(router.includes('const previewRule = (owned, stationId) => {'));
  assert.ok(router.includes('return canonical.resolveLk1Rule({ owned, stationId,'));
  assert.ok(router.includes('...(stationExclusions === undefined ? {} : { stationExclusions }) });'));
  assert.ok(router.includes('canonical.lk1Config(owned, stationId)'));
  assert.ok(router.includes('ctx.target.stationId),\n      ctx.target.stationId')
    || router.includes("productId: row.productId.toLowerCase() }],\n      ctx.target.stationId)" ),
    'the metadata step prices the instance for the target station');
  assert.ok(router.includes('const configured = previewRule(owned, ctx.target.stationId);'));
  const composition = read('../patch_nodered_subscription_price_preview.mjs');
  assert.ok(composition.includes("'lk1ReadStationExclusions'"),
    'the preview canonical closure has to publish the station-exclusions reader');
});

test(`${PREFIX}the generation activates the exclusion global next to the plan rules`, () => {
  // The reviewed gateway `initialize` is the live HUB writer plus both generated writers;
  // this drives the composition with a synthetic HUB writer so the station writer is
  // proved without the private live snapshot.
  const liveInitialize = [
    'const lk1PolicyKey = "subscriptions_lk1_product_policy";',
    'global.set(lk1PolicyKey, lk1DesiredPolicy);',
    '"HUB policy prior mismatch; no overwrite"',
    '"HUB policy readback mismatch"',
    '',
  ].join('\n');
  const initialize = buildGatewayInitialize(liveInitialize);
  for (const marker of ['const lk1PlanRulesKey = "subscriptions_lk1_plan_rules";',
    'global.set(lk1PlanRulesKey, lk1DesiredPlanRules);',
    'const lk1StationExclusionsKey = "subscriptions_lk1_station_exclusions";',
    'global.set(lk1StationExclusionsKey, lk1DesiredStationExclusions);',
    'station exclusions prior mismatch; no overwrite',
    'station exclusions readback mismatch',
    JSON.stringify(LK1_STATION_EXCLUSIONS_DESIRED)]) {
    assert.ok(initialize.includes(marker), `initialize must carry: ${marker}`);
  }
  for (const anchor of ['const lk1PolicyKey = "subscriptions_lk1_product_policy";',
    'global.set(lk1PolicyKey, lk1DesiredPolicy);']) {
    assert.ok(initialize.includes(anchor), `the HUB writer must stay untouched: ${anchor}`);
  }
  // A second run is refused: the generation is applied once, against a fresh live body.
  assert.throws(() => buildGatewayInitialize(initialize), /already patched/);
});

test(`${PREFIX}the gateway and the preview agree on the Sirius verdict`, () => {
  // Both paths call the same resolver with the same two inputs; this asserts the
  // shared verdict the parity claim rests on, for the released payload.
  const shared = { planRules: LK1_PLAN_RULES_DESIRED, stationExclusions: LK1_STATION_EXCLUSIONS_DESIRED };
  for (const [label, ownedRows] of [
    ['write path', owned(LK1_SIRIUS_FRIENDSHIP_PRODUCT_ID, '2026-09-05')],
    ['preview path', [{ ...owned(LK1_SIRIUS_FRIENDSHIP_PRODUCT_ID, '2026-09-05')[0], lk1ProductIdentity: {
      productId: LK1_SIRIUS_FRIENDSHIP_PRODUCT_ID, subscription: { productId: LK1_SIRIUS_FRIENDSHIP_PRODUCT_ID } } }]],
  ]) {
    const direct = resolveLk1Rule({ owned: ownedRows, stationId: LK1_SIRIUS_STATION_ID, ...shared });
    const bound = bind({}).resolveLk1Rule({ owned: ownedRows, stationId: LK1_SIRIUS_STATION_ID, ...shared });
    assert.equal(direct.legacy, true, label);
    assert.deepEqual(bound, direct, label);
  }
});
