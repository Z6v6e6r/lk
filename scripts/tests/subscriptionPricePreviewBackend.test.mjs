import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';
import vm from 'node:vm';
import ts from 'typescript';
import { createHash } from 'node:crypto';
import ts from 'typescript';
import { createDiagnostics } from '../diagnostics/runtime.mjs';
import { previewEmptyTariffFacts } from '../diagnostics/preview-empty-tariffs.mjs';
import { sanitizeEvent } from '../../src/utils/errorDiagnosticsCore.mjs';
import { extractSubscriptionPricePreviewSource } from '../lib/subscriptionPricePreviewSources.mjs';
import { scopeSubscriptionEvaluator, scopeSubscriptionUsage } from '../lib/subscriptionInstanceLimitSources.mjs';
import { composeSubscriptionPricePreviewArtifacts, composeSubscriptionJoinPricePreviewArtifacts, composeSubscriptionPreviewServerTimeArtifacts, PATH } from '../patch_nodered_subscription_price_preview.mjs';
import { composePreviewBookingsRelease, ORIGINAL_BOOKINGS_GUARD } from '../prepare_preview_bookings_release.mjs';

const bookingsRouterSource = fs.readFileSync(new URL('../nodered_subscription_price_preview_nodes/router.js', import.meta.url), 'utf8');
const bookingsStart = "if (ctx.step === 'activeBookings' || ctx.step === 'historyBookings') {";
const bookingsEnd = "  if (ctx.step === 'activeBookings') {";
const originalBookingsGuard = `${bookingsStart}
  if (!ok() || !canonical.hasCompleteBookingList(msg.payload) || rows().some(row => !canonical.isObj(row)
    || !canonical.bookingId(row) || (canonical.bookingClientId(row) && canonical.normalizeId(canonical.bookingClientId(row)) !== canonical.normalizeId(ctx.actorClientId)))) return stop('PRICE_PREVIEW_BOOKINGS_INCOMPLETE');
`;
const bookingsBaselineSource = bookingsRouterSource.slice(0, bookingsRouterSource.indexOf(bookingsStart))
  + originalBookingsGuard + bookingsRouterSource.slice(bookingsRouterSource.indexOf(bookingsEnd));
const bookingsHelperRoots = ['isObj', 'extractItems', 'hasCompleteBookingList', 'bookingId', 'bookingClientId',
  'normalizeId', 'mergeBookings', 'isInactiveBooking'];
const bookingsHelpers = extractSubscriptionPricePreviewSource({
  source: fs.readFileSync(new URL('../nodered_subscription_booking_nodes/fn_subscription_booking_router.js', import.meta.url), 'utf8'),
  roots: bookingsHelperRoots,
}).source;
const bookingsCanonical = new Function(`${bookingsHelpers}; return {${bookingsHelperRoots.join(',')}};`)();
const executeBookings = new Function('msg', 'canonical', 'global', 'node', bookingsRouterSource);
const executeBookingsBaseline = new Function('msg', 'canonical', 'global', 'node', bookingsBaselineSource);
const finalizeBookings = new Function('msg', 'global', fs.readFileSync(new URL('../nodered_subscription_price_preview_nodes/final.js', import.meta.url), 'utf8'));
function bookingsDiagnostic(payload, { step = 'activeBookings', baseline = false, statusCode = 200, error, elapsed = 0,
  observer, observerMode = 'shared', loggerThrows = false, canonical = bookingsCanonical } = {}) {
  const events = [], info = [];
  const diagnostics = observerMode === 'shared' ? createDiagnostics({ sink: event => events.push(event) })
    : observerMode === 'throws' ? { observe() { throw Error('fixture-sensitive'); } } : observer;
  const globals = { get: () => diagnostics, set() { assert.fail('Diagnostics must not write globals'); } };
  const ctx = { step, startedAt: Date.now() - elapsed, actorClientId: 'fixture-owner', tenantKey: 'fixture',
    auth: 'fixture-sensitive', activePayload: [], ruleProductIds: [] };
  const msg = { payload, statusCode, error, _subscriptionPricePreview: ctx,
    req: { path: PATH, method: 'POST' }, headers: { authorization: 'fixture-sensitive' } };
  const output = (baseline ? executeBookingsBaseline : executeBookings)(msg, canonical, globals, {
    log(text) { if (loggerThrows) throw Error('fixture-sensitive'); info.push(JSON.parse(text)); },
    send() { assert.fail('No new request may be sent'); },
  });
  const port = output.findIndex(Boolean);
  assert([0, 2, 4].includes(port));
  if (port === 4) finalizeBookings(msg, globals);
  return { msg, ctx, port, events, info };
}
const incompleteBookingsEvent = result => [...result.events, ...result.info].filter(e => e.firstFailure);
const ownedBooking = extra => ({ id: 'fixture-booking', clientId: 'fixture-owner', ...extra });

test('booking diagnostics identify the first failed predicate in both stages without changing the 503 response', () => {
  const cases = [
    [[], 502, 'upstream_status'], [[null], 401, 'upstream_status'],
    [null, 200, 'list_incomplete_or_unrecognized'], ['fixture-sensitive', 200, 'list_incomplete_or_unrecognized'],
    [{}, 200, 'list_incomplete_or_unrecognized'],
    [{ content: [null], totalElements: 2 }, 200, 'list_incomplete_or_unrecognized'],
    [{ items: [], totalCount: 1 }, 200, 'list_incomplete_or_unrecognized'],
    [{ content: [], last: false }, 200, 'list_incomplete_or_unrecognized'],
    [{ records: [], hasNext: true }, 200, 'list_incomplete_or_unrecognized'],
    [{ bookings: [], number: 0, totalPages: 2 }, 200, 'list_incomplete_or_unrecognized'],
    [{ data: { content: [], totalElements: 1 } }, 200, 'list_incomplete_or_unrecognized'],
    [[null], 200, 'row_not_object'], [[[]], 200, 'row_not_object'],
    [['fixture-sensitive'], 200, 'row_not_object'],
    [[{ clientId: 'fixture-other' }], 200, 'row_id_missing'],
    [[ownedBooking({ id: ' ' })], 200, 'row_id_missing'],
    [[ownedBooking({ clientId: 'fixture-other' })], 200, 'row_owner_mismatch'],
    [[ownedBooking(), ownedBooking({ clientId: 'fixture-other' }), null], 200, 'row_owner_mismatch'],
  ];
  for (const step of ['activeBookings', 'historyBookings']) for (const observerMode of ['shared', 'missing', 'throws']) {
    for (const [payload, statusCode, firstFailure] of cases) {
      const result = bookingsDiagnostic(payload, { step, statusCode, observerMode });
      assert.equal(result.port, 4);
      assert.equal(result.msg.statusCode, 503);
      assert.deepEqual(result.msg.payload, { error: { code: 'PRICE_PREVIEW_BOOKINGS_INCOMPLETE' } });
      const [event] = incompleteBookingsEvent(result);
      assert.equal(incompleteBookingsEvent(result).length, 1);
      assert.equal(event.stage, 'preview_router');
      assert.equal(event.operationStage, step);
      assert.equal(event.firstFailure, firstFailure);
      assert.equal(event.upstreamStatus, statusCode);
      if (observerMode === 'shared') { assert.equal(event.eventKind, 'audit'); assert.deepEqual(result.info, []); }
      else {
        assert.deepEqual(event, { event: 'subscription_price_preview_bookings_refused',
          code: 'PRICE_PREVIEW_BOOKINGS_INCOMPLETE', stage: 'preview_router', operationStage: step, firstFailure, upstreamStatus: statusCode });
      }
      const serialized = JSON.stringify([...result.events, ...result.info]);
      for (const secret of ['fixture-sensitive', 'fixture-owner', 'fixture-other', 'fixture-booking']) assert(!serialized.includes(secret));
    }
  }
});

test('booking guard outcomes, helper calls and successful read transitions equal the original predicates', () => {
  const cases = [[], [ownedBooking()], [{ id: 'fixture-booking' }],
    [ownedBooking({ clientId: ' FIXTURE-OWNER ' })], [{ bookingId: 'fixture-booking', client: { id: 'fixture-owner' } }],
    { data: { content: [ownedBooking()], totalElements: 1, last: true } },
    { content: [], totalElements: 0 }, { payload: { items: [] } }, { result: { records: [] } },
    new Array(1000).fill(ownedBooking()), null, [null], [{ clientId: 'fixture-other' }],
    [ownedBooking({ clientId: 'fixture-other' })], { content: [], hasNext: true }];
  for (const step of ['activeBookings', 'historyBookings']) for (const statusCode of [200, 204, 299, 300, 401, 503]) {
    for (const payload of cases) {
      const execute = baseline => {
        const calls = [];
        const canonical = Object.fromEntries(Object.entries(bookingsCanonical).map(([key, fn]) => [key, (...args) => {
          calls.push(key); return fn(...args);
        }]));
        const result = bookingsDiagnostic(payload, { step, statusCode, baseline, canonical });
        // Observed time is unrelated to guard parity, and naturally differs between executions.
        delete result.ctx.activeObservedAt;
        return { port: result.port, ctx: { ...result.ctx, startedAt: 0 }, payload: result.msg.payload,
          status: result.msg.statusCode, method: result.msg.method, url: result.msg.url, calls };
      };
      assert.deepEqual(execute(false), execute(true));
    }
  }
  for (const step of ['activeBookings', 'historyBookings']) {
    const result = bookingsDiagnostic([], { step });
    assert.equal(result.port, step === 'activeBookings' ? 0 : 2);
    assert.equal(result.ctx.step, step === 'activeBookings' ? 'historyBookings' : 'operations');
    assert.deepEqual(incompleteBookingsEvent(result), []);
  }
});

test('booking diagnostics keep transport/timeout guards ahead of list inspection and tolerate failed sinks', () => {
  const payload = new Proxy({}, { get() { assert.fail('Body must not be inspected after an earlier guard'); } });
  for (const step of ['activeBookings', 'historyBookings']) {
    for (const observerMode of ['missing', 'throws']) {
      const status = bookingsDiagnostic(payload, { step, statusCode: 503, observerMode, loggerThrows: true });
      assert.equal(status.msg.payload.error.code, 'PRICE_PREVIEW_BOOKINGS_INCOMPLETE');
      for (const [options, code] of [[{ error: {} }, 'PRICE_PREVIEW_READ_FAILED'], [{ elapsed: 30000 }, 'PRICE_PREVIEW_TIMEOUT']]) {
        const result = bookingsDiagnostic(payload, { step, observerMode, ...options });
        assert.equal(result.msg.payload.error.code, code);
        assert.deepEqual(incompleteBookingsEvent(result), []);
      }
    }
  }
});

test('booking diagnostic status is bounded, missing stays unknown and no accessor/coercion is repeated', () => {
  for (const observerMode of ['shared', 'missing']) for (const [statusCode, expected] of [
    [100, 100], [599, 599], ['401', 401], [null, undefined], [0, undefined],
    [99, undefined], [600, undefined], [200.5, undefined], [Infinity, undefined], ['fixture-sensitive', undefined],
  ]) {
    const event = incompleteBookingsEvent(bookingsDiagnostic(null, { statusCode, observerMode }))[0];
    assert.equal(event.upstreamStatus, expected);
  }
  let conversions = 0;
  const statusCode = { valueOf() { conversions++; return 503; } };
  assert.equal(incompleteBookingsEvent(bookingsDiagnostic([], { statusCode }))[0].upstreamStatus, undefined);
  assert.equal(conversions, 2, 'Only the original ok() may coerce status');
  // Exercise the actual router directly to preserve the accessor descriptor.
  let reads = 0;
  const info = [];
  const msg = { payload: [], _subscriptionPricePreview: { step: 'activeBookings', startedAt: Date.now() },
    get statusCode() { reads++; return 503; } };
  executeBookings(msg, bookingsCanonical, { get: () => null }, { log: text => info.push(JSON.parse(text)) });
  assert.equal(reads, 2);
  assert.equal(info[0].upstreamStatus, undefined);
  const absentInfo = [];
  const absent = { payload: [], _subscriptionPricePreview: { step: 'historyBookings', startedAt: Date.now() } };
  const missingGlobals = { get: () => null };
  const output = executeBookings(absent, bookingsCanonical, missingGlobals, { log: text => absentInfo.push(JSON.parse(text)) });
  assert.equal(output[4], absent);
  assert.equal(absentInfo[0].firstFailure, 'upstream_status');
  assert.equal(absentInfo[0].operationStage, 'historyBookings');
  assert(!Object.hasOwn(absentInfo[0], 'upstreamStatus'));
  finalizeBookings(absent, missingGlobals);
  assert.equal(absent.statusCode, 503);
  assert.deepEqual(absent.payload, { error: { code: 'PRICE_PREVIEW_BOOKINGS_INCOMPLETE' } });
});

test('firstFailure and booking stages remain finite enums through sanitizer and generated schema', () => {
  const base = { schemaVersion: 1, diagnosticEventId: uuid(81), requestId: uuid(82), eventKind: 'audit',
    source: 'node_red', stage: 'preview_router', code: 'PRICE_PREVIEW_BOOKINGS_INCOMPLETE' };
  for (const value of ['fixture-sensitive', 123, {}, [], null, 'row_owner_mismatch\r\nfixture-sensitive']) {
    const safe = sanitizeEvent({ ...base, firstFailure: value, operationStage: value,
      upstreamStatus: value, payload: value, url: value, clientId: value, bookingId: value });
    assert.equal(safe.firstFailure, 'UNKNOWN');
    assert.equal(safe.operationStage, 'UNKNOWN');
    assert.equal(safe.upstreamStatus, typeof value === 'number' ? value : undefined);
    for (const key of ['payload', 'url', 'clientId', 'bookingId']) assert(!Object.hasOwn(safe, key));
    assert(!JSON.stringify(safe).includes('fixture-sensitive'));
  }
  for (const operationStage of ['activeBookings', 'historyBookings']) {
    const safe = sanitizeEvent({ ...base, operationStage, firstFailure: 'row_owner_mismatch', upstreamStatus: 200 });
    assert.equal(safe.operationStage, operationStage);
    assert.equal(safe.firstFailure, 'row_owner_mismatch');
  }
  assert.equal(sanitizeEvent({ ...base, get firstFailure() { throw Error('fixture-sensitive'); } }), null);
});

test('bookings activation changes only func and bypasses a silently filtering scoped observer', () => {
  const original = [
    { id: 'fixture-tab', type: 'tab' },
    { id: 'lk_subscription_price_preview_20260908_router', type: 'function', z: 'fixture-tab',
      func: bookingsBaselineSource, initialize: '/* existing diagnostic initialization */',
      finalize: '/* existing diagnostic disposal */', libs: [{ var: 'existing', module: 'crypto' }], outputs: 6,
      wires: Array.from({ length: 6 }, () => []) },
    { id: 'fixture-unrelated', type: 'function', z: 'fixture-tab', func: 'return msg;', wires: [[]] },
  ];
  const liveBytes = Buffer.from(JSON.stringify(original));
  const sha = value => createHash('sha256').update(value).digest('hex');
  const options = { release: 'a'.repeat(40), expectedSourceSha256: sha(liveBytes), expectedRouterSha256: sha(bookingsBaselineSource) };
  const packet = composePreviewBookingsRelease(liveBytes, options);
  const candidate = JSON.parse(packet.candidateBytes);
  assert.deepEqual(candidate.map(n => n.id), original.map(n => n.id));
  const changed = candidate[1];
  assert.deepEqual({ ...changed, func: original[1].func }, original[1]);
  assert.deepEqual(candidate[0], original[0]); assert.deepEqual(candidate[2], original[2]);
  assert.equal(packet.report.changedNodeCount, 1);
  assert.deepEqual(packet.report.changedFields, ['func']);
  assert.equal(packet.report.originalRecoveredExactly, true);
  const execute = new Function('msg', 'canonical', 'global', 'node', changed.func);
  for (const step of ['activeBookings', 'historyBookings']) {
    const info = [];
    const msg = { payload: [ownedBooking({ clientId: 'fixture-other' })], statusCode: 200,
      _subscriptionPricePreview: { step, startedAt: Date.now(), actorClientId: 'fixture-owner' } };
    const output = execute(msg, bookingsCanonical, { get: () => ({ observe() {} }) }, { log: text => info.push(JSON.parse(text)) });
    assert.equal(output[4], msg);
    assert.equal(msg._subscriptionPricePreview.error, 'PRICE_PREVIEW_BOOKINGS_INCOMPLETE');
    assert.deepEqual(info, [{ event: 'subscription_price_preview_bookings_refused',
      code: 'PRICE_PREVIEW_BOOKINGS_INCOMPLETE', stage: 'preview_router', operationStage: step,
      firstFailure: 'row_owner_mismatch', upstreamStatus: 200 }]);
  }
  assert.throws(() => composePreviewBookingsRelease(liveBytes, {}), /EXACT_IDENTITY/);
  assert.throws(() => composePreviewBookingsRelease(liveBytes, { ...options, expectedSourceSha256: 'b'.repeat(64) }), /FLOW_DRIFT/);
  assert.throws(() => composePreviewBookingsRelease(liveBytes, { ...options, expectedRouterSha256: 'b'.repeat(64) }), /ROUTER_DRIFT/);
  for (const mutate of [
    flow => { flow[1].d = true; },
    flow => { flow[0].disabled = true; },
    flow => { flow[1].func = flow[1].func.replace(ORIGINAL_BOOKINGS_GUARD, ORIGINAL_BOOKINGS_GUARD.replace('!ok()', 'false')); },
    flow => { flow[1].func += '\nconst lkBookingsDiagnostic = () => {};'; },
  ]) {
    const modified = structuredClone(original); mutate(modified);
    const bytes = Buffer.from(JSON.stringify(modified));
    assert.throws(() => composePreviewBookingsRelease(bytes, { ...options,
      expectedSourceSha256: sha(bytes), expectedRouterSha256: sha(modified[1].func) }), /ROUTER_DRIFT|GUARD_DRIFT/);
  }
});

const legacyGuardBefore = "    if (!plan || !canonical.PLAN_CATEGORIES[plan]?.includes('open_game')) return stop('PRICE_PREVIEW_LEGACY_PLAN_UNRESOLVED');";
const legacyGuardAfter = `    if (!plan || !canonical.PLAN_CATEGORIES[plan]?.includes('open_game')) {
      lkLegacyPlanDiagnostic(plan, configured, name);
      return stop('PRICE_PREVIEW_LEGACY_PLAN_UNRESOLVED');
    }`;
const legacyHelperStart = bookingsRouterSource.indexOf('// Only called after the existing legacy guard');
const legacyHelperEnd = bookingsRouterSource.indexOf('// Event identity is checked again', legacyHelperStart);
assert(legacyHelperStart >= 0 && legacyHelperEnd > legacyHelperStart);
assert.equal(bookingsRouterSource.split(legacyGuardAfter).length, 2);
const legacyBaseline = (bookingsRouterSource.slice(0, legacyHelperStart)
  + bookingsRouterSource.slice(legacyHelperEnd)).replace(legacyGuardAfter, legacyGuardBefore);
const legacyRoots = ['isObj', 'normalizeId', 'identityOwned', 'collectSubscriptionPurchaseDateEvidence',
  'resolvePlanKey', 'compatibilityPlanKey', 'PLAN_CATEGORIES', 'resolveLimitMode',
  'isSubscriptionBooking', 'isInactiveBooking', 'eventDate', 'bookingSubscriptionId', 'resolveCategory',
  'normalizePurchaseDateMoscow', 'collectExactProductIds', 'LK1_OVERLAY_HUB_PRODUCT_ID', 'managedExternalEventTypeId'];
const legacySources = ['../nodered_subscription_booking_nodes/fn_subscription_booking_router.js',
  '../nodered_subscription_product_nodes/gateway.js', '../nodered_lk1_hub_nodes/gateway.js']
  .map(path => fs.readFileSync(new URL(path, import.meta.url), 'utf8'));
const legacyDeclarations = new Map();
for (const root of legacyRoots) {
  let extracted;
  for (const source of legacySources) {
    try { extracted = extractSubscriptionPricePreviewSource({ source, roots: [root] }); break; }
    catch { /* The composed helper may belong to another node source. */ }
  }
  assert(extracted, `Missing source-bound legacy helper ${root}`);
  const parsed = ts.createSourceFile('helpers.js', extracted.source, ts.ScriptTarget.ES2022, true, ts.ScriptKind.JS);
  for (const statement of parsed.statements) {
    if (ts.isFunctionDeclaration(statement)) legacyDeclarations.set(statement.name.text, statement.getText(parsed));
    else for (const d of statement.declarationList.declarations) legacyDeclarations.set(d.name.text, `const ${d.getText(parsed)};`);
  }
}
const legacyAvailability = ts.transpileModule(fs.readFileSync(new URL('../../src/components/games/splitSubscriptionAvailability.ts', import.meta.url), 'utf8'), {
  compilerOptions: { target: ts.ScriptTarget.ES2020, module: ts.ModuleKind.CommonJS },
}).outputText;
assert.doesNotMatch(legacyAvailability, /\brequire\s*\(/);
const legacyHelpers = [...legacyDeclarations.values()].join('\n')
  + `\nconst preflightAvailability = (() => { const exports = {}; ${legacyAvailability}\nreturn exports; })();`;
const legacyRuleSource = fs.readFileSync(new URL('../lib/lk1PlanRules.mjs', import.meta.url), 'utf8').replace(/^export /gm, '');
const legacyExecute = new Function('msg', 'canonical', 'global', 'node', 'canonicalUsage', 'Date', bookingsRouterSource);
const legacyExecuteBaseline = new Function('msg', 'canonical', 'global', 'node', 'canonicalUsage', 'Date', legacyBaseline);
const legacyFinalize = new Function('msg', 'global', 'Date', fs.readFileSync(new URL('../nodered_subscription_price_preview_nodes/final.js', import.meta.url), 'utf8'));
const legacyUuid = n => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const legacyProduct = legacyUuid(101), legacySub = legacyUuid(102), legacyActor = legacyUuid(103), legacyStation = legacyUuid(104);
const legacyNow = Date.parse('2026-11-12T14:36:00Z');
class LegacyDate extends Date {
  constructor(...args) { super(...(args.length ? args : [legacyNow])); }
  static now() { return legacyNow; }
}
const legacyRule = { productId: legacyProduct, planKey: 'friendship', enforceFrom: '2026-09-01',
  maxActiveBookings: 8, freeGameMinutesPerDay: 60, gameOverageDiscountPercent: 30,
  groupTrainingDiscountPercent: 50, tournamentDiscountPercent: 50 };
function legacyDiagnostic({ baseline = false, configured, planRules, stationExclusions, name = 'fixture-sensitive',
  live: extraLive, ctx: extraCtx, msg: extraMsg, loggerThrows = false, observerMode = 'missing',
  loggerMissing = false, categoryGetterThrows = false, configuredDescriptor, ctxDescriptor } = {}) {
  const info = [], calls = [];
  const globals = { get(key) {
    if (key === 'lkDiagnostics') {
      if (observerMode === 'throws') throw Error('fixture-sensitive');
      if (observerMode === 'scoped') return { observe() {} }; // Existing scoped observers can ignore the code.
    }
    return undefined;
  }, set() { assert.fail('No global writes'); } };
  const raw = new Function('global', `${legacyHelpers}\n${legacyRuleSource}
    return {${legacyRoots.join(',')}, preflightAvailability, resolveLk1Rule};`)(globals);
  const canonical = { ...raw, lk1PlanRulesGlobal: () => planRules,
    lk1ReadStationExclusions: () => stationExclusions, isProTrainingDiscountRule: () => false };
  if (configured !== undefined) canonical.resolveLk1Rule = () => configured;
  for (const [key, value] of Object.entries(canonical)) if (typeof value === 'function') {
    canonical[key] = (...args) => { calls.push(key); return value(...args); };
  }
  if (categoryGetterThrows) canonical.PLAN_CATEGORIES = new Proxy({}, { get() { throw Error('fixture-sensitive'); } });
  const live = { subscriptionId: legacySub, clientSubscriptionId: legacySub, id: legacySub,
    clientId: legacyActor, productId: legacyProduct, status: 'ACTIVE', activationDate: '2026-01-01',
    expirationDate: '2099-12-31', variant: 'BY_VISITS', visitsLeft: 100,
    hasStudioLimitation: false, hasTypeLimitation: true, availableTypes: [{ id: 1613 }],
    hasDirectionLimitation: false, purchaseDate: '2026-10-01', ...extraLive };
  const ctx = { step: 'next', startedAt: legacyNow, pending: [legacySub], requestedIds: [legacySub],
    quotes: [], instanceErrors: {}, subscriptions: { [legacySub]: live },
    metadata: { [legacySub]: { productId: legacyProduct } }, catalog: { [legacyProduct]: name },
    tenantKey: 'fixture-sensitive', actorClientId: legacyActor, existingGame: false,
    target: { stationId: legacyStation, roomId: legacyUuid(105), startsAt: '2099-01-01T12:00:00+03:00', durationMinutes: 60 },
    bookings: [], basePriceMinor: 10000, operations: [], ruleProductIds: [legacyProduct], ...extraCtx };
  if (ctx.existingGame && ctx.exercise?.availableClientSubscriptions) ctx.exercise = { ...ctx.exercise,
    availableClientSubscriptions: ctx.exercise.availableClientSubscriptions.map(row => ({ ...live, ...row })) };
  if (ctxDescriptor) Object.defineProperty(ctx, ctxDescriptor.key, ctxDescriptor.descriptor);
  if (configuredDescriptor) Object.defineProperty(configured, configuredDescriptor.key, configuredDescriptor.descriptor);
  const msg = { _subscriptionPricePreview: ctx, ...extraMsg };
  const node = { send() { assert.fail('No new request may be sent'); } };
  if (!loggerMissing) node.log = text => { if (loggerThrows) throw Error('fixture-sensitive'); info.push(JSON.parse(text)); };
  const usage = message => { calls.push('canonicalUsage'); message._managedSubscriptionPolicyInput = {}; };
  const result = (baseline ? legacyExecuteBaseline : legacyExecute)(msg, canonical, globals, node, usage, LegacyDate);
  const port = result.findIndex(Boolean);
  if (port === 4) legacyFinalize(msg, globals, LegacyDate);
  return { msg, ctx, port, calls, info };
}

test('legacy diagnostics distinguish missing/excluded plans and actual shared rule dispositions', () => {
  const rules = { formatVersion: 1, rules: [legacyRule] };
  const scenarios = [
    [{}, 'NO_PLAN', 'NO_MATCH'],
    [{ name: 'kotelniki friendship' }, 'OPEN_GAME_EXCLUDED', 'NO_MATCH'],
    [{ planRules: rules, live: { purchaseDate: '2026-08-01' } }, 'NO_PLAN', 'SALE_BEFORE_CUTOFF'],
    [{ planRules: rules, stationExclusions: { formatVersion: 1,
      exclusions: [{ stationId: legacyStation, productIds: [legacyProduct] }] } }, 'NO_PLAN', 'STATION_EXCLUDED'],
  ];
  for (const [options, verdict, disposition] of scenarios) for (const observerMode of ['missing', 'scoped', 'throws']) {
    const result = legacyDiagnostic({ ...options, observerMode });
    assert.equal(result.port, 4);
    assert.equal(result.msg.statusCode, 503);
    assert.deepEqual(result.msg.payload, { error: { code: 'PRICE_PREVIEW_LEGACY_PLAN_UNRESOLVED' } });
    assert.equal(result.info.length, 1);
    const [event] = result.info;
    assert.equal(event.event, 'subscription_price_preview_legacy_plan_refused');
    assert.equal(event.previewLegacyPlanVerdict, verdict);
    assert.equal(event.previewLegacyRuleDisposition, disposition);
    assert.equal(event.previewLegacyResolverEvidence, verdict === 'NO_PLAN' ? 'NO_RECOGNIZED_MARKER' : 'UNKNOWN');
    assert.equal(event.previewTargetKind, 'NEW_GAME');
    assert.equal(event.previewLegacyOrigin, 'UNKNOWN');
    assert.equal(event.previewLegacyRequestedCountBucket, 'ONE');
    assert.equal(event.previewLegacyPartialQuotesDiscarded, false);
    assert.equal(event.previewLegacyBoundNamePresent, true);
    assert.equal(event.previewLegacyFactsFailed, false);
    assert(!JSON.stringify(event).includes('fixture-sensitive'));
    assert(!/\d{4}-\d{2}-\d{2}|[a-f0-9]{8}-[a-f0-9-]{27}/i.test(JSON.stringify(event)));
  }
});

test('legacy diagnostic preserves all guard results, helper call order, quote batches and evaluator transitions', () => {
  const scenarios = [{}, { name: 'kotelniki friendship' },
    ...['friendship', 'friendshiptwohours', 'networkfriendship', 'piter friendship', 'sport', 'academy', 'ra'].map(name => ({ name })),
    { live: { isFrozen: true } }, { live: { visitsLeft: 0 } }, { live: { visitsLeft: 1 }, ctx: { target: {
      stationId: legacyStation, roomId: legacyUuid(105), startsAt: '2099-01-01T12:00:00+03:00', durationMinutes: 120 } } },
    { live: { availableTypes: {} } }, { live: { availableTypes: [{ id: 9999 }] } },
    { live: { productId: legacyUuid(110) } }, { msg: { error: {} } }, { ctx: { startedAt: legacyNow - 29000 } },
    { ctx: { instanceErrors: { [legacySub]: 'SUBSCRIPTION_PRODUCT_CURRENT_STATE_UNAVAILABLE' } } },
    { ctx: { quotes: [{ status: 'AVAILABLE' }] } },
    { ctx: { eventCategory: 'GROUP_TRAINING' } }, { ctx: { eventCategory: 'TOURNAMENT' } },
    { planRules: { formatVersion: 1, rules: [legacyRule] } },
    { planRules: { malformed: true } },
    { configured: { matched: true, code: 'SUBSCRIPTION_PURCHASE_DATE_UNRESOLVED' } },
    { configured: { matched: true, code: 'LK1_STATION_EXCLUSIONS_INVALID' } },
    { name: 'friendship', ctx: { bookings: [{ paymentType: 'SUBSCRIPTION', exerciseDate: '2099-01-01T12:00:00+03:00' }] } },
    { ctx: { existingGame: true, exercise: { availableClientSubscriptions: [] } } },
    { ctx: { existingGame: true, exercise: { availableClientSubscriptions: [{ id: legacySub }] } } },
  ];
  for (const options of scenarios) {
    const current = legacyDiagnostic(options), baseline = legacyDiagnostic({ ...options, baseline: true });
    assert.deepEqual({ ...current, info: [] }, baseline);
    if (current.ctx.error !== 'PRICE_PREVIEW_LEGACY_PLAN_UNRESOLVED') assert.deepEqual(current.info, []);
    assert.equal(current.calls.filter(c => c === 'resolvePlanKey').length,
      baseline.calls.filter(c => c === 'resolvePlanKey').length);
  }
  const batch = legacyDiagnostic({ ctx: { requestedIds: [legacySub, legacyUuid(111)], quotes: [{ status: 'AVAILABLE' }] } });
  assert.equal(batch.info[0].previewLegacyRequestedCountBucket, 'MULTIPLE');
  assert.equal(batch.info[0].previewLegacyPartialQuotesDiscarded, true);
  assert.equal(batch.msg.payload.quotes, undefined);
});

test('legacy optional facts and unavailable/throwing sinks cannot change the refusal or invoke accessors', () => {
  for (const options of [{ loggerThrows: true }, { loggerMissing: true },
    { configured: { matched: false }, configuredDescriptor: { key: 'legacy', descriptor: {
      get() { assert.fail('Diagnostic accessor executed'); } } } },
    { configured: { matched: true, legacy: true, source: 'PLAN', purchaseDate: 'invalid', enforceFrom: '2026-09-01' } },
    { configured: { matched: true, legacy: true, stationLegacy: true }, configuredDescriptor: { key: 'purchaseDate', descriptor: {
      get() { assert.fail('Unneeded diagnostic date accessor executed'); } } } },
    { ctxDescriptor: { key: 'requestedIds', descriptor: { get() { assert.fail('Diagnostic request accessor executed'); } } } },
  ]) {
    const result = legacyDiagnostic(options);
    assert.equal(result.msg.statusCode, 503);
    assert.deepEqual(result.msg.payload, { error: { code: 'PRICE_PREVIEW_LEGACY_PLAN_UNRESOLVED' } });
    assert(result.info.length <= 1);
    assert(!JSON.stringify(result.info).includes('fixture-sensitive'));
  }
  const missing = legacyDiagnostic({ name: '' });
  assert.equal(missing.ctx.error, 'PRICE_PREVIEW_PRODUCT_IDENTITY_UNRESOLVED');
  assert.deepEqual(missing.info, []);
  const existing = legacyDiagnostic({ ctx: { existingGame: true, exercise: { availableClientSubscriptions: [{ id: legacySub }] } } });
  assert.equal(existing.info[0].previewTargetKind, 'EXISTING_GAME');
  for (const field of ['requestedIds', 'quotes']) {
    const array = new Proxy([], { getOwnPropertyDescriptor(target, key) {
      if (key === 'length') return { configurable: false, enumerable: false, writable: true,
        value: { valueOf() { assert.fail('Diagnostic length coercion executed'); } } };
      return Reflect.getOwnPropertyDescriptor(target, key);
    } });
    const result = legacyDiagnostic({ ctx: { [field]: array } });
    assert.equal(result.msg.statusCode, 503);
    assert.equal(result.info[0].previewLegacyFactsFailed, false);
    if (field === 'requestedIds') assert.equal(result.info[0].previewLegacyRequestedCountBucket, 'UNKNOWN');
    else assert.equal(result.info[0].previewLegacyPartialQuotesDiscarded, undefined);
  }
});

test('legacy facts are allowlisted consistently by sanitizer and schema; spoofed values remain unknown', () => {
  const schema = JSON.parse(fs.readFileSync(new URL('../../docs/diagnostics/schema.v1.json', import.meta.url), 'utf8'));
  const event = legacyDiagnostic().info[0];
  const input = { ...event, diagnosticEventId: legacyUuid(120), requestId: legacyUuid(121),
    source: 'node_red', eventKind: 'audit', routeTemplate: PATH, method: 'POST',
    productId: 'fixture-sensitive', name: 'fixture-sensitive', body: 'fixture-sensitive' };
  const output = sanitizeEvent(input);
  for (const key of Object.keys(event).filter(key => key.startsWith('preview'))) {
    assert.equal(output[key], event[key]);
    if (schema.properties[key].enum) assert(schema.properties[key].enum.includes(output[key]));
    else assert.equal(typeof output[key], schema.properties[key].type);
  }
  assert(!JSON.stringify(output).includes('fixture-sensitive'));
  for (const key of ['previewLegacyPlanVerdict', 'previewLegacyRuleDisposition', 'previewLegacyResolverEvidence',
    'previewLegacyRequestedCountBucket', 'previewLegacyOrigin', 'previewTargetKind']) {
    assert.equal(sanitizeEvent({ ...input, [key]: 'fixture-sensitive' })[key], 'UNKNOWN');
  }
  for (const key of ['previewLegacyPartialQuotesDiscarded', 'previewLegacyBoundNamePresent', 'previewLegacyFactsFailed']) {
    assert.equal(sanitizeEvent({ ...input, [key]: 'fixture-sensitive' })[key], undefined);
  }
});

const fixturePath = process.env.LK_PRICE_PREVIEW_FLOW_FIXTURE;
const legacyOriginal = fixturePath ? JSON.parse(fs.readFileSync(fixturePath)) : null;
const original = legacyOriginal ? structuredClone(legacyOriginal) : null;
if (original) {
  const gateway = original.find(row=>row.id==='lk_subscription_booking_router_20260804');
  gateway.func = scopeSubscriptionUsage(gateway.func);
  const evaluator = original.find(row=>row.id==='lk_subscription_managed_policy_20260820');
  evaluator.func = scopeSubscriptionEvaluator(evaluator.func);
}
const packet = original ? composeSubscriptionPricePreviewArtifacts(Buffer.from(JSON.stringify(original)), 'preview-fixture') : null;
const nodes = packet?.candidate.filter(row => row.id.startsWith('lk_subscription_price_preview_20260908_')) || [];
const liveTest = (name, fn) => test(name, { skip: !original && 'Requires private exact canonical flow fixture; never copied into Git' }, fn);
const uuid = n => `00000000-0000-4000-8000-${String(n).padStart(12,'0')}`;
const actor = uuid(1), sub = uuid(2), room = uuid(3), studio = uuid(4), master = uuid(5), service = uuid(6);
const product = 'db7a5250-7369-4f43-8ac5-9111be24bc74';
const rule = {productId:product,maxActiveBookings:4,freeGameMinutesPerDay:60,gameOverageDiscountPercent:30,groupTrainingDiscountPercent:50,tournamentDiscountPercent:50};
const gameId = 'pay_' + uuid(70), exerciseId = uuid(71);
const target = {targetKind:'NEW_GAME',slotId:'slot:fixture',stationId:studio,roomId:room,masterServiceId:master,subServiceIds:[service],startsAt:'2099-09-21T07:00:00+03:00',durationMinutes:90,shareCount:4};
const subscription = (id=sub,extra={}) => ({subscriptionId:id, product:{id:product,name:'Падел.Дружба.ХАБ — годовая'},
  purchaseDate:'2026-09-05T06:40:26',activationDate:'2026-09-07T12:22:12',expirationDate:'2100-09-07',status:'ACTIVE',
  variant:'BY_VISITS',visitsLeft:100,hasStudioLimitation:false,hasTypeLimitation:true,availableTypes:[{id:1613}],hasDirectionLimitation:false,...extra});
const booking = (id=uuid(9), extra={}) => ({id,clientSubscriptionId:sub,client:{id:actor},paymentType:'SUBSCRIPTION',
  timeFrom:'2099-09-21T04:00:00+03:00',timeTo:'2099-09-21T05:00:00+03:00',exerciseId:uuid(10),exerciseDate:'2099-09-21T04:00:00+03:00',exerciseDateTo:'2099-09-21T05:00:00+03:00',
  exerciseType:{id:1613},exerciseDirection:{id:4588},...extra});
const key = (kind,...args)=>JSON.stringify([kind,'iSkq6G',...args]);
function harness(options={}) {
  const globals = {subscriptions_lk1_product_policy:rule,vivacrm_access_token:'fixture-admin',vivacrm_token_expires_at:Date.now()+60000,...options.globals};
  const subscriptions = options.subscriptions || [subscription()];
  const instances = subscriptions.map(row=>({_id:key('instance',actor,row.subscriptionId),kind:'instance',tenantKey:'iSkq6G',actorClientId:actor,subscriptionId:row.subscriptionId,productId:product}));
  const catalog = [{_id:key('product',product),kind:'product',tenantKey:'iSkq6G',productId:product,name:'Падел.Дружба.ХАБ — годовая'}];
  const calls=[];
  let msg={req:{headers:{authorization:'Bearer fixture-user'}},payload:{target:options.join ? {targetKind:'EXISTING_GAME',gameId,startsAt:target.startsAt,durationMinutes:90,...options.target} : {...target,...options.target},subscriptionIds:options.ids||subscriptions.map(row=>row.subscriptionId),...options.body}};
  const node = name=>nodes.find(row=>row.id.endsWith('_'+name));
  let current=node('entry');
  for(let i=0;i<100;i++) {
    if(current.type==='http response') return {response:structuredClone(msg),calls};
    if(current.type==='function') {
      const result = vm.compileFunction(current.func, ['msg','global','env','node'], {parsingContext:vm.createContext({})})(msg,
        {get:key=>globals[key],set(){assert.fail('No global writes allowed');}}, {get(){return undefined;}}, {warn(){assert.fail('No raw debug allowed');}});
      const outputs=Array.isArray(result)?result:[result]; const port=outputs.findIndex(Boolean);
      assert.ok(port>=0,'Every fixture request must terminate'); msg=outputs[port];
      current=nodes.find(row=>row.id===current.wires[port][0]); assert.ok(current); continue;
    }
    if(current.type==='http request') {
      assert.equal(current.method,'use'); assert.equal(msg.method,'GET');
      const url=new URL(msg.url); assert.equal(url.origin,'https://api.vivacrm.ru');
      calls.push({kind:'GET',path:url.pathname,query:url.search});
      let payload;
      if(url.pathname.endsWith('/profile')) payload={id:actor};
      else if(url.pathname.includes('/exercises/')) payload=options.exercise || {id:exerciseId,studioId:studio,roomId:room,timeFrom:target.startsAt,timeTo:'2099-09-21T08:30:00+03:00',typeId:1613,directionId:4588,availableClientSubscriptions:subscriptions};
      else if(url.pathname.endsWith('/subscriptions')) payload={content:subscriptions,totalElements:subscriptions.length};
      else if(url.pathname.endsWith('/bookings/history')) payload=options.history||[];
      else if(url.pathname.endsWith('/bookings')) payload=options.active||[];
      else if(url.pathname.includes('/rooms/')) payload={id:room};
      else if(url.pathname.endsWith('/studios')) payload=[{id:studio}];
      else if(url.pathname.endsWith('/subServices')) payload=[{id:service}];
      else if(url.pathname.endsWith('/price')) {
        assert.equal(url.searchParams.get('fromTime'),'07:00:00');
        assert.equal(url.searchParams.get('toTime'), options.target?.durationMinutes===120?'09:00:00':options.target?.durationMinutes===60?'08:00:00':'08:30:00');
        payload={ [service]: {calculation:{fixture:{basePrice:{valueFrom:12000},impacts:[]}}} };
      } else assert.fail('Unexpected provider read');
      msg.payload=payload;msg.statusCode=200;
      if(options.mutateHttp) options.mutateHttp(msg,url);
    } else if(current.type==='mongodb4') {
      assert.equal(current.operation,'find'); calls.push({kind:'find',collection:current.collection,query:structuredClone(msg.payload)});
      if(current.collection==='lk_games') {
        assert.deepEqual(structuredClone(msg.payload),{id:gameId});
        msg.payload=options.games || [{id:gameId,booking:{studioId:studio,roomId:room,masterServiceId:master,subServiceIds:[service],date:'2099-09-21',timeFrom:'07:00',timeTo:'08:30',durationMinutes:90,vivaExerciseId:exerciseId},metadata:{splitPayment:{shareCount:4}}}];
      } else if(current.collection==='lk_subscription_daily_booking_ops') {
        assert.equal(msg.payload.actorClientId,actor); assert.equal(msg.payload['lk1.rule.productId'],product);
        msg.payload=options.operations||[];
      } else msg.payload=msg._subscriptionPricePreview.step==='catalog'?catalog:(options.instances||instances);
      if(options.mutateMongo) options.mutateMongo(msg,current);
    } else assert.fail('Write-capable or unknown node reached');
    current=nodes.find(row=>row.id===current.wires[0][0]);
  }
  assert.fail('State machine did not terminate');
}
test('preview source never calls CREATE or a product cache miss resolver',()=>{
  const router=fs.readFileSync(new URL('../nodered_subscription_price_preview_nodes/router.js',import.meta.url),'utf8');
  assert.doesNotMatch(router,/\/split\/create|\/seliger|insertOne|updateOne|global\.set/);
});

function exerciseDiagnostic(payload, overrides = {}, observer, logger) {
  const booking = fs.readFileSync(new URL('../nodered_subscription_booking_nodes/fn_subscription_booking_router.js', import.meta.url), 'utf8');
  const roots = ['unwrapRecord', 'resolveCategory', 'eventStartsAt', 'eventDurationMinutes', 'exerciseRoomId'];
  const helpers = extractSubscriptionPricePreviewSource({ source: booking, roots }).source;
  const canonical = new Function(`${helpers}; return {${roots.join(',')}};`)();
  const ctx = { step: 'exercise', startedAt: Date.now(), tenantKey: 'fixture', exerciseId,
    auth: 'fixture-sensitive', target: { startsAt: target.startsAt, durationMinutes: 90, stationId: studio, roomId: room } };
  const events = [];
  const diagnostics = observer === undefined ? createDiagnostics({ sink: event => events.push(event) }) : observer;
  const globals = { get: () => diagnostics };
  const msg = { payload, statusCode: 200, _msgid: 'fixture-sensitive', _subscriptionPricePreview: ctx,
    headers: { 'content-type': 'application/json; fixture-sensitive' }, ...overrides };
  const source = name => fs.readFileSync(new URL(`../nodered_subscription_price_preview_nodes/${name}.js`, import.meta.url), 'utf8');
  const outputs = new Function('msg', 'canonical', 'global', 'node', source('router'))(msg, canonical, globals, logger);
  if (outputs[4]) new Function('msg', 'global', source('final'))(msg, globals);
  return { msg, outputs, events, ctx };
}
const previewExercise = () => ({ id: exerciseId, studioId: studio, roomId: room,
  timeFrom: target.startsAt, timeTo: '2099-09-21T08:30:00+03:00', typeId: 1613, directionId: 4588,
  availableClientSubscriptions: [], privateProviderField: 'fixture-sensitive' });

// Fixed-clock local groupExercise reads only; no provider/database graph runs.
const futureClock = Date.parse('2099-09-21T04:00:00Z');
function targetTimeDiagnostic(changes = {}, options = {}) {
  class Clock extends Date { static now() { return options.now ?? futureClock; } }
  const booking = fs.readFileSync(new URL('../nodered_subscription_booking_nodes/fn_subscription_booking_router.js', import.meta.url), 'utf8');
  const roots = ['isObj', 'unwrapRecord', 'resolveCategory', 'eventStartsAt', 'eventDurationMinutes', 'exerciseRoomId', 'managedExternalEventTypeId'];
  const helpers = extractSubscriptionPricePreviewSource({ source: booking, roots }).source;
  const canonical = new Function(`${helpers}; return {${roots.join(',')}};`)();
  Object.assign(canonical, { identityMoneyOwned() {}, isSpanishTrainingExercise: () => false, isProTrainingExercise: () => false });
  const payload = { id: exerciseId, studioId: studio, roomId: room, typeId: 605, directionId: 1,
    timeFrom: new Date(futureClock - 1).toISOString(), durationMinutes: 60, ...changes };
  const info = [], observed = [];
  const observer = options.observer === 'shared' ? createDiagnostics({ sink: e => observed.push(e) }) : options.observer;
  const globals = { get: () => observer };
  const msg = { payload: options.payload === undefined ? payload : options.payload, statusCode: options.status ?? 200,
    _msgid: 'fixture-sensitive', _subscriptionPricePreview: { step: 'groupExercise', tenantKey: 'fixture',
      eventCategory: options.category ?? 'GROUP_TRAINING', exerciseId, target: {},
      startedAt: options.entered ?? futureClock - 100, ...options.context } };
  const source = name => fs.readFileSync(new URL(`../nodered_subscription_price_preview_nodes/${name}.js`, import.meta.url), 'utf8');
  const args = ['msg', 'canonical', 'global', 'node', 'Date'];
  const router = options.foreignRealm ? vm.compileFunction(source('router'), args, { parsingContext: vm.createContext({}) })
    : new Function(...args, source('router'));
  const outputs = router(msg, canonical, globals,
    { log: options.log ?? (text => info.push(JSON.parse(text))) }, Clock);
  const ctx = msg._subscriptionPricePreview;
  if (outputs[4]) new Function('msg', 'global', 'Date', source('final'))(msg, globals, Clock);
  return { msg, ctx, outputs, info, observed };
}
const timeEvent = result => result.info.find(event => event.event === 'subscription_price_preview_target_not_future');
test('target_not_future distinguishes an already started event from crossing during this request', () => {
  for (const observer of [undefined, { observe() {} }, { observe() { throw Error('fixture-sensitive'); } }, 'shared']) {
    for (const [delta, enteredDelta, relation] of [
      [-101, -100, 'PAST_AT_ENTRY'], [-100, -100, 'NOW_AT_ENTRY'], [-1, -100, 'CROSSED_DURING_REQUEST'], [0, -100, 'CROSSED_DURING_REQUEST'],
    ]) {
      const result = targetTimeDiagnostic({ timeFrom: new Date(futureClock + delta).toISOString() }, { observer, entered: futureClock + enteredDelta });
      assert.equal(result.msg.statusCode, 503);
      assert.deepEqual(result.msg.payload, { error: { code: 'GROUP_DISCOUNT_TARGET_UNRESOLVED', details: { reason: 'target_not_future', upstreamStatus: 200 } } });
      assert.equal(result.outputs[0], null);
      assert.equal(result.info.length, 1, 'One info event, even with a code-filtered observer');
      const event = timeEvent(result);
      assert.deepEqual(event, { event: 'subscription_price_preview_target_not_future', schemaVersion: 1, code: 'TARGET_NOT_FUTURE',
        step: 'groupExercise', reason: 'target_not_future', startRelation: relation, startAlias: 'TIME_FROM', startFormat: 'ISO_OFFSET',
        elapsedBucket: 'LT1S', factsFailed: false, explicitOffsetValid: true, aliasConflict: false });
    }
  }
});
test('target_not_future preserves future and other refusal paths without extra diagnostics', () => {
  const future = targetTimeDiagnostic({ timeFrom: new Date(futureClock + 1).toISOString() });
  assert.equal(future.ctx.step, 'subscriptions'); assert.equal(future.info.length, 0);
  for (const [changes, options, code, reason] of [
    [{}, { status: 502 }, 'GROUP_DISCOUNT_TARGET_UNRESOLVED', 'target_upstream_error'],
    [{ id: uuid(99) }, {}, 'GROUP_DISCOUNT_TARGET_UNRESOLVED', 'target_identity'],
    [{ typeId: 1613 }, {}, 'GROUP_DISCOUNT_TARGET_UNRESOLVED', 'target_category'],
    [{ timeFrom: 'fixture-sensitive' }, {}, 'GROUP_DISCOUNT_TARGET_UNRESOLVED', 'target_start_invalid'],
    [{}, { entered: futureClock - 28001 }, 'PRICE_PREVIEW_TIMEOUT', undefined],
  ]) {
    const result = targetTimeDiagnostic(changes, options); assert.equal(result.info.length, 0);
    assert.equal(result.msg.payload.error.code, code); assert.equal(result.msg.payload.error.details?.reason, reason);
  }
  const cancelledPast = targetTimeDiagnostic({ isCancelled: true, roomId: null, durationMinutes: 0 });
  assert.equal(cancelledPast.msg.payload.error.details.reason, 'target_not_future', 'Original predicate order');
  const tournament = targetTimeDiagnostic({ typeId: 839 }, { category: 'TOURNAMENT' });
  assert.equal(tournament.msg.payload.error.code, 'TOURNAMENT_DISCOUNT_TARGET_UNRESOLVED');
});
test('target_not_future exposes only coarse delay and unknown clock metadata', () => {
  for (const [age, bucket] of [[0, 'LT1S'], [999, 'LT1S'], [1000, 'LT5S'], [4999, 'LT5S'],
    [5000, 'LT15S'], [14999, 'LT15S'], [15000, 'LE28S'], [28000, 'LE28S']]) {
    assert.equal(timeEvent(targetTimeDiagnostic({}, { entered: futureClock - age })).elapsedBucket, bucket);
  }
  for (const entered of [NaN, 'fixture-sensitive', futureClock + 1]) {
    const event = timeEvent(targetTimeDiagnostic({}, { entered }));
    assert.equal(event.startRelation, 'UNKNOWN'); assert.equal(event.elapsedBucket, 'UNKNOWN');
  }
});
test('target_not_future identifies time aliases and suspicious shapes without reinterpreting the target', () => {
  for (const [changes, alias, format, valid, conflict] of [
    [{ timeFrom: '2099-09-21T06:59:59+03:00' }, 'TIME_FROM', 'ISO_OFFSET', true, false],
    [{ timeFrom: '2099-09-20T23:59:59-0400' }, 'TIME_FROM', 'ISO_OFFSET', true, false],
    [{ timeFrom: '2099-09-20T01:00:00' }, 'TIME_FROM', 'ISO_OFFSETLESS', false, false],
    [{ timeFrom: '2099-09-20' }, 'TIME_FROM', 'DATE_ONLY', false, false],
    [{ timeFrom: '2099-02-30T06:59:59+03:00' }, 'TIME_FROM', 'ISO_OFFSET', false, false],
    [{ startsAt: new Date(futureClock + 1000).toISOString() }, 'TIME_FROM', 'ISO_OFFSET', true, true],
    [{ timeFrom: 'fixture-sensitive', startsAt: new Date(futureClock - 1).toISOString() }, 'STARTS_AT', 'ISO_OFFSET', true, false],
    [{ timeFrom: undefined, startAt: new Date(futureClock - 1).toISOString() }, 'START_AT', 'ISO_OFFSET', true, false],
    [{ timeFrom: undefined, fromTime: new Date(futureClock - 1).toISOString() }, 'FROM_TIME', 'ISO_OFFSET', true, false],
  ]) {
    const result = targetTimeDiagnostic(changes), event = timeEvent(result);
    assert.equal(event.startAlias, alias); assert.equal(event.startFormat, format);
    assert.equal(event.explicitOffsetValid, valid); assert.equal(event.aliasConflict, conflict); assert.equal(event.factsFailed, false);
    assert.equal(result.msg.payload.error.details.reason, 'target_not_future');
    const serialized = JSON.stringify(result.info);
    for (const value of [exerciseId, room, studio, 'fixture-sensitive', changes.timeFrom, changes.startsAt]) {
      if (typeof value === 'string' && value) assert(!serialized.includes(value));
    }
    assert(!/https?:|Bearer|requestId|correlationId|exerciseId|startsAt|\d{4}-\d{2}-\d{2}|[a-f0-9]{8}-[a-f0-9-]{27}/i.test(serialized));
  }
});
test('target_not_future diagnostic failures and unsafe aliases cannot change the refusal', () => {
  for (const fromTime of [Symbol('fixture-sensitive'), 1n, 'fixture-sensitive'.repeat(30),
    { toString() { assert.fail('Diagnostic must not coerce objects'); } }]) {
    const result = targetTimeDiagnostic({ fromTime });
    assert.equal(timeEvent(result).factsFailed, true); assert.equal(timeEvent(result).startAlias, 'UNKNOWN');
    assert.equal(result.msg.statusCode, 503);
  }
  assert.equal(targetTimeDiagnostic({}, { log() { throw Error('fixture-sensitive'); } }).msg.statusCode, 503);
  // Owning parser reads its aliases once; the diagnostic must not read a getter again.
  const source = fs.readFileSync(new URL('../nodered_subscription_price_preview_nodes/router.js', import.meta.url), 'utf8');
  const begin = source.indexOf('    // A dedicated info event');
  const end = source.indexOf('    lkDiagnostic({ code: "TARGET_NOT_FUTURE"', begin);
  let reads = 0; const logs = [];
  const exercise = { timeFrom: new Date(futureClock - 1).toISOString(), get fromTime() { reads++; throw Error('fixture-sensitive'); } };
  new Function('exercise', 'ctx', 'start', 'node', source.slice(begin, end))(exercise, { startedAt: futureClock - 100 }, futureClock - 1, { log: s => logs.push(JSON.parse(s)) });
  assert.equal(reads, 0); assert.equal(logs[0].factsFailed, true);
});
test('target_not_future accepts plain provider and context objects from outside the function VM', () => {
  const result = targetTimeDiagnostic({}, { foreignRealm: true });
  assert.equal(result.msg.statusCode, 503);
  assert.equal(timeEvent(result).factsFailed, false);
  assert.equal(timeEvent(result).startRelation, 'CROSSED_DURING_REQUEST');
  assert.equal(timeEvent(result).startAlias, 'TIME_FROM');
});

test('exercise diagnostics identify the first failed guard without changing the 503 contract', () => {
  for (const [payload, overrides, reason] of [
    [previewExercise(), { statusCode: 503 }, 'target_upstream_error'],
    [null, {}, 'target_missing'], ['<html>fixture-sensitive</html>', {}, 'target_missing'],
    [42, {}, 'target_missing'], [[], {}, 'target_missing'],
    [{ ...previewExercise(), id: uuid(99) }, {}, 'target_identity'],
    [{ ...previewExercise(), typeId: 839, directionId: 2617 }, {}, 'target_category'],
    [{ ...previewExercise(), studioId: uuid(99) }, {}, 'target_studio'],
    [{ ...previewExercise(), roomId: uuid(99) }, {}, 'target_room'],
    [{ ...previewExercise(), durationMinutes: 60 }, {}, 'target_duration'],
    [{ ...previewExercise(), timeFrom: '2099-09-21T06:00:00+03:00', durationMinutes: 90 }, {}, 'target_start_invalid'],
    [{ ...previewExercise(), isCancelled: true }, {}, 'target_cancelled'],
    [{ ...previewExercise(), isCanceled: true }, {}, 'target_cancelled'],
    [{ ...previewExercise(), status: 'finished' }, {}, 'target_lifecycle'],
    [{ ...previewExercise(), availableClientSubscriptions: null }, {}, 'PRICE_PREVIEW_SUBSCRIPTION_SCHEMA_INVALID'],
    [{ ...previewExercise(), id: uuid(99), isCancelled: true }, { statusCode: 502 }, 'target_upstream_error'],
    [{ ...previewExercise(), id: uuid(99), isCancelled: true }, {}, 'target_identity'],
  ]) {
    const { msg, events } = exerciseDiagnostic(payload, overrides);
    assert.equal(msg.statusCode, 503);
    assert.deepEqual(msg.payload, { error: { code: 'PRICE_PREVIEW_GAME_UNRESOLVED' } });
    const event = events.find(e => e.stage === 'preview_router' && e.code === 'PRICE_PREVIEW_GAME_UNRESOLVED');
    assert.ok(event);
    assert.equal(event.reason, reason);
    assert.equal(event.upstreamStatus, overrides.statusCode ?? 200);
    assert.equal(event.operationStage, 'exercise');
    assert.equal(event.contentTypeClass, 'json');
    assert(!JSON.stringify(events).includes('fixture-sensitive'));
    assert(!JSON.stringify(events).includes(exerciseId));
    assert(!JSON.stringify(events).includes(studio));
    assert(!JSON.stringify(events).includes(room));
  }
});
test('exercise diagnostic metadata is enum-only and invalid statuses remain unknown', () => {
  for (const [payload, responseKind, contentType, contentTypeClass] of [
    [null, 'null', undefined, 'missing'], [undefined, 'missing', '', 'missing'],
    ['fixture-sensitive', 'text', 'Text/HTML; private=fixture-sensitive', 'html'],
    [true, 'boolean', 'text/plain', 'text'], [7, 'number', 'application/problem+json', 'json'],
    [[], 'array', 'fixture-sensitive', 'other'],
  ]) {
    const { events } = exerciseDiagnostic(payload, { statusCode: 'fixture-sensitive', headers: { 'content-type': contentType } });
    const event = events.find(e => e.code === 'PRICE_PREVIEW_GAME_UNRESOLVED');
    assert.equal(event.upstreamStatus, undefined);
    assert.equal(event.responseKind, responseKind);
    assert.equal(event.contentTypeClass, contentTypeClass);
    assert(!JSON.stringify(events).includes('fixture-sensitive'));
  }
});
test('exercise diagnostics keep valid empty subscription arrays and wrapped records usable', () => {
  for (const payload of [previewExercise(), { data: previewExercise() }]) {
    const { msg, ctx, outputs, events } = exerciseDiagnostic(payload);
    assert.equal(outputs[0], msg);
    assert.equal(ctx.step, 'subscriptions');
    assert.equal(msg.method, 'GET');
    assert(!events.some(e => e.code === 'PRICE_PREVIEW_GAME_UNRESOLVED'));
  }
});
test('missing or throwing observers cannot change exercise guard verdicts', () => {
  for (const observer of [null, { observe() { throw Error('sink'); } }]) {
    const failed = exerciseDiagnostic({ ...previewExercise(), roomId: uuid(99) }, {}, observer);
    assert.equal(failed.msg.statusCode, 503);
    assert.deepEqual(failed.msg.payload, { error: { code: 'PRICE_PREVIEW_GAME_UNRESOLVED' } });
    assert.equal(exerciseDiagnostic(previewExercise(), {}, observer).ctx.step, 'subscriptions');
  }
  const headers = { get 'content-type'() { throw Error('header'); } };
  assert.equal(exerciseDiagnostic(null, { headers }).msg.statusCode, 503);
});
test('installed flows without the shared observer emit one safe info diagnostic and keep the legacy warning separate', () => {
  for (const observer of [null, { observe() { throw Error('sink'); } }]) {
    const info = [];
    const logger = { log: text => info.push(JSON.parse(text)), warn() { assert.fail('No second refusal warning'); } };
    const { msg } = exerciseDiagnostic({ ...previewExercise(), roomId: uuid(99) }, {}, observer, logger);
    assert.equal(msg.statusCode, 503);
    assert.deepEqual(msg.payload, { error: { code: 'PRICE_PREVIEW_GAME_UNRESOLVED' } });
    assert.deepEqual(info, [{ event: 'subscription_price_preview_exercise_refused',
      code: 'PRICE_PREVIEW_GAME_UNRESOLVED', step: 'exercise', reason: 'target_room',
      upstreamStatus: 200, responseKind: 'object', contentTypeClass: 'json' }]);
    assert(!JSON.stringify(info).includes('fixture-sensitive'));
    assert(!JSON.stringify(info).includes(exerciseId));
    assert(!JSON.stringify(info).includes(room));
    exerciseDiagnostic(previewExercise(), {}, observer, logger);
    assert.equal(info.length, 1);
  }
  const info = [];
  exerciseDiagnostic(null, {}, undefined, { log: value => info.push(value) });
  assert.deepEqual(info, [], 'A configured observer needs no duplicate info event');
  const failed = exerciseDiagnostic(null, {}, null, { log() { throw Error('log'); } });
  assert.equal(failed.msg.statusCode, 503);
});
test('exercise diagnostics do not mask explicit read errors or the overall timeout', () => {
  const failed = exerciseDiagnostic(previewExercise(), { error: { code: 'ETIMEDOUT' } });
  assert.equal(failed.msg.payload.error.code, 'PRICE_PREVIEW_READ_FAILED');
  const timeout = exerciseDiagnostic(previewExercise(), {
    _subscriptionPricePreview: { step: 'exercise', startedAt: Date.now() - 29000 },
  });
  assert.equal(timeout.msg.payload.error.code, 'PRICE_PREVIEW_TIMEOUT');
  assert(!failed.events.some(e => e.code === 'PRICE_PREVIEW_GAME_UNRESOLVED'));
  assert(!timeout.events.some(e => e.code === 'PRICE_PREVIEW_GAME_UNRESOLVED'));
});

const durationFactKeys = ['previewCanonicalDuration', 'previewExplicitDuration', 'previewEndpointDuration',
  'previewExplicitMatchesEndpoints', 'previewEndpointOffsetPairValid', 'previewEndpointStartMatch', 'previewDurationFactsFailed'];
const durationFacts = event => Object.fromEntries(durationFactKeys.filter(key => Object.hasOwn(event, key)).map(key => [key, event[key]]));
test('target_duration separates null, explicit conflict and provider endpoint mismatch in observer and fallback', () => {
  const expected = (canonical, explicit, endpoint, extra = {}) => ({ previewCanonicalDuration: canonical,
    previewExplicitDuration: explicit, previewEndpointDuration: endpoint,
    previewEndpointOffsetPairValid: false, previewEndpointStartMatch: true, previewDurationFactsFailed: false, ...extra });
  for (const [changes, facts] of [
    [{ timeTo: undefined }, expected('NULL', 'ABSENT', 'NULL')],
    [{ duration: 'PT1H30M', timeTo: undefined }, expected('NULL', 'INVALID', 'NULL')],
    [{ durationMinutes: 60 }, expected('DIFFERENT', 'VALID', 'MATCH_TARGET',
      { previewExplicitMatchesEndpoints: false, previewEndpointOffsetPairValid: true })],
    [{ duration: '60', timeTo: '2099-09-21T08:00:00+03:00' }, expected('DIFFERENT', 'VALID', 'DIFFERENT',
      { previewExplicitMatchesEndpoints: true, previewEndpointOffsetPairValid: true })],
    [{ timeTo: '2099-09-21T08:00:00+03:00' }, expected('DIFFERENT', 'ABSENT', 'DIFFERENT',
      { previewEndpointOffsetPairValid: true })],
    [{ durationMinutes: 60, timeTo: undefined }, expected('DIFFERENT', 'VALID', 'NULL')],
    [{ duration: true }, expected('DIFFERENT', 'VALID', 'MATCH_TARGET',
      { previewExplicitMatchesEndpoints: false, previewEndpointOffsetPairValid: true })],
    [{ durationMinutes: null, duration: 60 }, expected('DIFFERENT', 'VALID', 'MATCH_TARGET',
      { previewExplicitMatchesEndpoints: false, previewEndpointOffsetPairValid: true })],
    [{ durationMinutes: 60, timeFrom: '2099-09-21T04:00:00Z', timeTo: '2099-09-21T05:30:00Z' },
      expected('DIFFERENT', 'VALID', 'MATCH_TARGET', { previewExplicitMatchesEndpoints: false, previewEndpointOffsetPairValid: true })],
  ]) {
    for (const observer of [undefined, null, { observe() { throw Error('fixture-sensitive'); } }]) {
      const info = [];
      const result = exerciseDiagnostic({ ...previewExercise(), ...changes }, {}, observer, { log: text => info.push(JSON.parse(text)) });
      const events = observer === undefined ? result.events : info;
      const event = events.find(event => event.reason === 'target_duration');
      assert.deepEqual(durationFacts(event), facts);
      assert.equal(result.msg.statusCode, 503);
      assert.deepEqual(result.msg.payload, { error: { code: 'PRICE_PREVIEW_GAME_UNRESOLVED' } });
      assert.equal(result.outputs[0], null, 'Refusal cannot schedule another provider read');
      assert.equal(events.filter(event => event.reason === 'target_duration').length, 1);
      assert(!JSON.stringify(events).includes('fixture-sensitive'));
      assert(!JSON.stringify(events).includes(exerciseId));
      assert(!JSON.stringify(events).includes(target.startsAt));
    }
  }
});
test('duration evidence does not label permissive clock fallback or normalized calendar as a valid offset pair', () => {
  for (const changes of [
    { timeFrom: '07:00', timeTo: '08:00' },
    { timeFrom: '2099-09-21T07:00:00', timeTo: '2099-09-21T08:00:00' },
    { timeFrom: '2099-02-30T07:00:00+03:00', timeTo: '2099-02-30T08:00:00+03:00' },
    { timeFrom: '2099-09-21T07:00:00+03:00', timeTo: '2099-09-21T07:00:00+03:00' },
    { timeFrom: '2099-09-21T23:00:00+03:00', timeTo: '2099-09-21T00:00:00+03:00' },
  ]) {
    const result = exerciseDiagnostic({ ...previewExercise(), ...changes });
    const event = result.events.find(event => event.reason === 'target_duration');
    assert.equal(event.previewEndpointOffsetPairValid, false);
    assert.equal(result.msg.statusCode, 503);
  }
  for (const [timeFrom, timeTo] of [
    ['2099-09-21T23:00:00+03:00', '2099-09-22T00:30:00+03:00'],
    ['2099-09-21T22:30:00+03:00', '2099-09-22T00:00:00+03:00'],
    ['2099-09-21T07:00:00.250+03:00', '2099-09-21T08:30:00.250+03:00'],
  ]) {
    const result = exerciseDiagnostic({ ...previewExercise(), durationMinutes: 60, timeFrom, timeTo });
    const event = result.events.find(event => event.reason === 'target_duration');
    assert.equal(event.previewEndpointDuration, 'MATCH_TARGET');
    assert.equal(event.previewEndpointOffsetPairValid, true);
    assert.equal(event.previewExplicitMatchesEndpoints, false);
  }
});
test('duration diagnostics reject unsafe fields without executing getters or custom coercion', () => {
  for (const unsafe of [
    payload => Object.defineProperty(payload, 'endsAt', { get() { return assert.fail('Must not call diagnostic getter'); } }),
    payload => ({ ...payload, endsAt: { valueOf() { assert.fail('Must not coerce object'); }, toString() { assert.fail('Must not stringify object'); } } }),
    payload => ({ ...payload, endsAt: 'fixture-sensitive'.repeat(30) }),
    payload => ({ ...payload, endsAt: Symbol('fixture-sensitive') }),
    payload => ({ ...payload, endsAt: 1n }),
    payload => Object.assign(Object.create({ endsAt: 'fixture-sensitive' }), payload),
  ]) {
    const info = [];
    const result = exerciseDiagnostic(unsafe({ ...previewExercise(), durationMinutes: 60 }), {}, null,
      { log: text => info.push(JSON.parse(text)) });
    assert.equal(result.msg.statusCode, 503);
    assert.deepEqual(durationFacts(info[0]), { previewCanonicalDuration: 'DIFFERENT', previewDurationFactsFailed: true });
    assert(!JSON.stringify(info).includes('fixture-sensitive'));
  }
  const result = exerciseDiagnostic({ ...previewExercise(), durationMinutes: 60 }, {}, null, { log() { throw Error('sink'); } });
  assert.equal(result.msg.statusCode, 503);
});
test('duration evidence is absent from successful previews and other first failures; canonical guard reads once', () => {
  for (const payload of [previewExercise(), { ...previewExercise(), studioId: uuid(99), durationMinutes: 60 },
    { ...previewExercise(), isCancelled: true }]) {
    const result = exerciseDiagnostic(payload);
    assert(result.events.every(event => durationFactKeys.every(key => !Object.hasOwn(event, key))));
  }
  let reads = 0;
  const payload = previewExercise();
  Object.defineProperty(payload, 'durationMinutes', { get() { reads++; return 60; } });
  const result = exerciseDiagnostic(payload);
  assert.equal(reads, 1, 'Only the original canonical call may read a provider accessor');
  const event = result.events.find(event => event.reason === 'target_duration');
  assert.equal(event.previewCanonicalDuration, 'DIFFERENT');
  assert.equal(event.previewDurationFactsFailed, true);
  assert.equal(result.msg.statusCode, 503);
});

test('duration diagnostic allowlist drops arbitrary strings, numbers, objects and raw values', () => {
  const base = { schemaVersion: 1, diagnosticEventId: uuid(81), requestId: uuid(82), eventKind: 'stage',
    source: 'node_red', stage: 'preview_router', code: 'PRICE_PREVIEW_GAME_UNRESOLVED', reason: 'target_duration' };
  for (const value of ['fixture-sensitive', 90, { token: 'fixture-sensitive' }, null]) {
    const input = { ...base, ...Object.fromEntries(durationFactKeys.map(key => [key, value])),
      durationMinutes: 90, timeFrom: target.startsAt, exerciseId, providerRecord: previewExercise() };
    const safe = sanitizeEvent(input);
    assert(!JSON.stringify(safe).includes('fixture-sensitive'));
    assert(!JSON.stringify(safe).includes(exerciseId));
    assert(!Object.hasOwn(safe, 'durationMinutes'));
    assert(!Object.hasOwn(safe, 'timeFrom'));
    assert(!Object.hasOwn(safe, 'providerRecord'));
    for (const key of durationFactKeys.slice(0, 3)) assert.equal(safe[key], 'UNKNOWN');
    for (const key of durationFactKeys.slice(3)) assert(!Object.hasOwn(safe, key));
  }
});

// Run the actual router and final with the booking graph's list helpers, without
// a private production flow or any provider/database access.
function tariffDiagnostic(payload, overrides = {}, options = {}) {
  const source = name => fs.readFileSync(new URL(`../nodered_subscription_price_preview_nodes/${name}.js`, import.meta.url), 'utf8');
  const bookingSource = fs.readFileSync(new URL('../nodered_subscription_booking_nodes/fn_subscription_booking_router.js', import.meta.url), 'utf8');
  const roots = ['extractItems', 'hasCompleteBookingList', 'isObj', 'resolveCategory', 'eventStartsAt'];
  const helpers = extractSubscriptionPricePreviewSource({ source: bookingSource, roots }).source;
  const canonical = new Function(`${helpers}; return {${roots.join(',')}};`)();
  canonical.identityMoneyOwned = () => assert.fail('Tariff diagnostics must not reach ownership evaluation');
  const url = `https://api.vivacrm.ru/end-user/api/v2/fixture/products/one-times?exerciseId=${exerciseId}`;
  const ctx = { step: 'groupTariff', exerciseId, tenantKey: 'fixture', eventCategory: 'GROUP_TRAINING', requestedIds: [],
    exercise: { id: exerciseId, typeId: 605, timeFrom: target.startsAt }, target: { startsAt: target.startsAt }, ...options.ctx };
  const diagnosticEvents = [];
  const observer = Object.hasOwn(options, 'observer') ? options.observer : createDiagnostics({ sink: event => diagnosticEvents.push(event) });
  const global = { get: () => observer };
  const msg = { _msgid: 'fixture-correlation', _subscriptionPricePreview: ctx, payload, statusCode: 200,
    req: { path: '/lk/subscriptions/game-price-preview', method: 'POST' },
    method: 'GET', url, responseUrl: url, ...overrides };
  const outputs = new Function('msg', 'canonical', 'global', source('router'))(msg, canonical, global);
  assert.equal(outputs[4], msg);
  const warnings = [];
  new Function('msg', 'node', 'global', source('final'))(msg, { warn: text => warnings.push(JSON.parse(text)) }, global);
  return { msg, ctx, warnings, diagnosticEvents };
}

test('ambiguous tariff diagnostics preserve response and emit allowlisted fields without entity IDs', () => {
  for (const [payload, count, reason] of [[[], 0, 'empty_tariff_list'], [[{}, {}], 2, 'multiple_tariffs'],
    [[null], 1, 'invalid_tariff_record'], [['fixture-sensitive'], 1, 'invalid_tariff_record'],
    [{ content: [null], totalElements: 1 }, 1, 'invalid_tariff_record']]) {
    const { msg, ctx, warnings, diagnosticEvents } = tariffDiagnostic(payload);
    assert.equal(msg.statusCode, 503);
    assert.deepEqual(msg.payload, { error: { code: 'LK1_EVENT_TARIFF_AMBIGUOUS',
      details: { exerciseId, tariffCount: count, reason, stage: 'tariff_shape', observed: {} } } });
    assert.equal(ctx.basePriceMinor, undefined);
    assert.deepEqual(warnings, []);
    const event = diagnosticEvents.find(event => event.code === 'LK1_EVENT_TARIFF_AMBIGUOUS');
    assert.equal(event.tariffCount, count); assert.equal(event.reason, reason);
    assert(!JSON.stringify(diagnosticEvents).includes(exerciseId));
    assert.ok(!JSON.stringify([msg.payload, warnings]).includes('fixture-sensitive'));
  }
  const refused = tariffDiagnostic([{ id: 'fixture-product', type: 'INVALID', cost: 12345 }]);
  const event = refused.diagnosticEvents.find(event => event.code === 'LK1_EVENT_TARIFF_UNVERIFIED');
  assert.equal(event.reason, 'product_type'); assert.equal(event.tariffCount, 1);
  assert(!JSON.stringify(refused.diagnosticEvents).includes(exerciseId));
});

test('other tariff refusals retain their verdict and distinguish unknown count from zero', () => {
  for (const [payload, overrides, code, count, reason] of [
    [[], { statusCode: 502 }, 'LK1_EVENT_TARIFF_UNAVAILABLE', null, 'upstream_error'],
    [{ content: [{}], totalElements: 2 }, {}, 'LK1_EVENT_TARIFF_UNAVAILABLE', null, 'incomplete_tariff_list'],
    [[{}], { responseUrl: 'https://other.invalid' }, 'LK1_EVENT_TARIFF_UNVERIFIED', 1, 'request_url'],
    [[{}], {}, 'LK1_EVENT_TARIFF_UNVERIFIED', 1, 'product_identity'],
    [[{ id: 'fixture-product', type: 'SERVICE', cost: -1 }], {}, 'LK1_EVENT_TARIFF_UNVERIFIED', 1, 'product_amount'],
  ]) {
    const { msg, warnings, diagnosticEvents } = tariffDiagnostic(payload, overrides);
    assert.equal(msg.statusCode, 503);
    assert.equal(msg.payload.error.code, code);
    assert.equal(msg.payload.error.details.exerciseId, exerciseId);
    assert.equal(msg.payload.error.details.tariffCount, count);
    assert.equal(msg.payload.error.details.reason, reason);
    assert.deepEqual(warnings, []);
    const event = diagnosticEvents.find(event => event.code === code);
    assert.equal(event.tariffCount ?? null, count);
    assert.equal(event.reason, reason);
  }
  const accepted = tariffDiagnostic([{ id: 'fixture-product', type: 'SERVICE', cost: 12345 }]);
  assert.equal(accepted.msg.statusCode, 200);
  assert.equal(accepted.ctx.basePriceMinor, 12345);
  assert.deepEqual(accepted.msg.payload.quotes, []);
  assert.ok(Number.isSafeInteger(accepted.msg.payload.serverTimeMs));
  assert.deepEqual(accepted.warnings, []);
});

const emptyTariffEvent = result => result.diagnosticEvents.find(e => e.stage === 'preview_router' && e.reason === 'empty_tariff_list');
test('empty tariff diagnostics describe complete reply shapes and preserve the exact refusal', () => {
  for (const [payload, shape, count, shadowed, alternate] of [
    [[], 'ROOT_ARRAY', 1, false, false],
    [{ content: [] }, 'DIRECT_ARRAY', 1, false, false],
    [{ data: { items: [], totalElements: 0 } }, 'NESTED_ARRAY', 1, false, false],
    [{ result: { payload: { records: [] } } }, 'NESTED_ARRAY', 1, false, false],
    [{ content: [], data: { content: [{ privateValue: 'fixture-sensitive' }] } }, 'DIRECT_ARRAY', 2, true, false],
    [{ content: [], products: [{ privateValue: 'fixture-sensitive' }] }, 'DIRECT_ARRAY', 1, false, true],
  ]) {
    const result = tariffDiagnostic(payload);
    const event = emptyTariffEvent(result);
    assert.ok(event);
    assert.equal(event.upstreamStatus, 200);
    assert.equal(event.responseKind, Array.isArray(payload) ? 'array' : 'object');
    assert.equal(event.tariffListShape, shape);
    assert.equal(event.tariffRecognizedArrayCount, count);
    assert.equal(event.tariffShadowedNonemptyArray, shadowed);
    assert.equal(event.tariffAlternateNonemptyArray, alternate);
    assert.equal(event.tariffCompleteListGuardPassed, true);
    assert.equal(event.tariffExtractedEmpty, true);
    assert.equal(event.tariffShapeScanTruncated, false);
    assert.equal(event.tariffShapeScanFailed, false);
    for (const key of ['tariffRequestScopeMatch', 'tariffTenantScopeMatch', 'tariffExerciseScopeMatch',
      'tariffMethodMatch', 'tariffResponseUrlPresent', 'tariffResponseScopeMatch', 'tariffEventIdentityMatch',
      'tariffEventCategoryMatch', 'tariffEventStartMatch']) assert.equal(event[key], true, key);
    assert.deepEqual(result.msg.payload, { error: { code: 'LK1_EVENT_TARIFF_AMBIGUOUS', details: {
      exerciseId, tariffCount: 0, reason: 'empty_tariff_list', stage: 'tariff_shape', observed: {},
    } } });
    assert.equal(result.msg.statusCode, 503);
    assert.equal(result.ctx.basePriceMinor, undefined);
    const serialized = JSON.stringify(result.diagnosticEvents);
    for (const privateValue of ['fixture-sensitive', exerciseId, 'api.vivacrm.ru', 'exerciseId=', 'fixture-correlation']) {
      assert(!serialized.includes(privateValue), privateValue);
    }
    assert(!JSON.stringify(result.msg.payload).includes('correlationHash'));
  }
});
test('empty tariff evidence keeps missing response provenance and binding evidence unknown', () => {
  const result = tariffDiagnostic([], { responseUrl: undefined, statusCode: '204' }, { ctx: { exercise: undefined, target: undefined } });
  const event = emptyTariffEvent(result);
  assert.equal(result.msg.statusCode, 503);
  assert.equal(event.tariffResponseUrlPresent, false);
  for (const key of ['tariffResponseScopeMatch', 'tariffEventIdentityMatch', 'tariffEventCategoryMatch', 'tariffEventStartMatch', 'upstreamStatus']) {
    assert.equal(event[key], undefined, key);
  }
  const mismatched = emptyTariffEvent(tariffDiagnostic([], {}, { ctx: {
    exercise: { id: uuid(99), typeId: 1613, timeFrom: '2099-09-22T07:00:00+03:00' },
  } }));
  assert.equal(mismatched.tariffEventIdentityMatch, false);
  assert.equal(mismatched.tariffEventCategoryMatch, false);
  assert.equal(mismatched.tariffEventStartMatch, false);
});
test('empty tariff observation is absent for preceding guards, other refusals and accepted tariffs', () => {
  for (const [payload, patch, code] of [
    [[], { statusCode: 401 }, 'LK1_EVENT_TARIFF_UNAVAILABLE'],
    [{ content: [], hasNext: true }, {}, 'LK1_EVENT_TARIFF_UNAVAILABLE'],
    [{ products: [] }, {}, 'LK1_EVENT_TARIFF_UNAVAILABLE'],
    [[], { responseUrl: 'https://other.invalid' }, 'LK1_EVENT_TARIFF_UNVERIFIED'],
    [[], { method: 'POST' }, 'LK1_EVENT_TARIFF_UNVERIFIED'],
    [[], { error: { code: 'ETIMEDOUT' } }, 'PRICE_PREVIEW_READ_FAILED'],
    [[{}, {}], {}, 'LK1_EVENT_TARIFF_AMBIGUOUS'],
    [[null], {}, 'LK1_EVENT_TARIFF_AMBIGUOUS'],
    [[{ id: 'fixture-product', type: 'SERVICE', cost: 12345 }], {}, undefined],
  ]) {
    const result = tariffDiagnostic(payload, patch);
    assert.equal(result.msg.payload.error?.code, code);
    assert.equal(emptyTariffEvent(result), undefined);
    assert(!result.diagnosticEvents.some(e => e.tariffExtractedEmpty !== undefined));
  }
});
test('empty tariff correlation hashes are server-owned and join stages of one request only', () => {
  const a = tariffDiagnostic([], { _msgid: 'fixture-sensitive',
    _lkDiagnosticContext: { requestId: uuid(90) } });
  const b = tariffDiagnostic([], { _msgid: 'fixture-sensitive' });
  const event = emptyTariffEvent(a);
  assert.match(event.correlationHash, /^c1:[a-f0-9]{64}$/);
  assert.notEqual(event.requestId, uuid(90));
  assert.equal(event.correlationHash, 'c1:' + createHash('sha256').update(`lk-preview-request-v1\0${event.requestId}`).digest('hex'));
  assert.notEqual(event.correlationHash, emptyTariffEvent(b).correlationHash);
  assert.ok(a.diagnosticEvents.length >= 3);
  assert(a.diagnosticEvents.every(e => e.correlationHash === event.correlationHash));
  const observer = createDiagnostics();
  const safe = observer.clientEnvelope({ event: 'client_error', payload: { ...event, correlationHash: event.correlationHash } });
  assert.equal(safe.payload.correlationHash, undefined, 'Client intake cannot claim a server correlation hash');
  assert.equal(sanitizeEvent({ ...event, correlationHash: 'fixture-sensitive' }).correlationHash, undefined);
  const hostile = sanitizeEvent({ ...event, tariffListShape: 'fixture-sensitive',
    tariffShadowedNonemptyArray: 'fixture-sensitive', tariffRecognizedArrayCount: 'fixture-sensitive' });
  assert.equal(hostile.tariffListShape, 'UNKNOWN');
  assert.equal(hostile.tariffShadowedNonemptyArray, undefined);
  assert.equal(hostile.tariffRecognizedArrayCount, undefined);
});
test('bounded shape inspection never reads rows/getters or claims absence after truncation', () => {
  const fields = { code: 'PREVIEW_EMPTY_TARIFF_OBSERVED', reason: 'empty_tariff_list' };
  const msg = payload => ({ payload, _subscriptionPricePreview: { step: 'groupTariff' } });
  let touched = 0;
  const payload = { content: [], data: {} };
  Object.defineProperty(payload.data, 'items', { get() { touched++; throw Error('fixture-sensitive'); } });
  const row = {};
  Object.defineProperty(row, 'privateValue', { get() { touched++; throw Error('fixture-sensitive'); } });
  payload.products = [row];
  const safe = previewEmptyTariffFacts(msg(payload), 'preview_router', fields);
  assert.equal(touched, 0);
  assert.equal(safe.tariffAlternateNonemptyArray, true);
  const cyclic = { content: [] }; cyclic.data = cyclic;
  assert.equal(previewEmptyTariffFacts(msg(cyclic), 'preview_router', fields).tariffShapeScanFailed, false);
  let deep = { products: [row] };
  for (let i = 0; i < 20; i++) deep = { data: deep };
  const truncated = previewEmptyTariffFacts(msg({ content: [], data: deep }), 'preview_router', fields);
  assert.equal(truncated.tariffShapeScanTruncated, true);
  assert.equal(truncated.tariffAlternateNonemptyArray, undefined);
  assert.equal(truncated.tariffShadowedNonemptyArray, undefined);
  const failed = previewEmptyTariffFacts(msg(new Proxy({}, { getOwnPropertyDescriptor() { throw Error('fixture-sensitive'); } })), 'preview_router', fields);
  assert.equal(failed.tariffShapeScanFailed, true);
  assert.equal(failed.tariffShadowedNonemptyArray, undefined);
  assert(!JSON.stringify(failed).includes('fixture-sensitive'));
});
test('observer absence, inspection failure and synchronous/asynchronous sink failure preserve fail-closed response', async () => {
  const expected = tariffDiagnostic([], {}, { observer: null }).msg.payload;
  const options = [{ observer: null }, { observer: { observe() { throw Error('fixture-sensitive'); } } },
    { observer: createDiagnostics({ sink() { throw Error('fixture-sensitive'); } }) },
    { observer: createDiagnostics({ sink() { return Promise.reject(Error('fixture-sensitive')); } }) }];
  for (const option of options) {
    const result = tariffDiagnostic([], {}, option);
    assert.deepEqual(result.msg.payload, expected);
    assert.equal(result.msg.statusCode, 503);
    assert.equal(result.ctx.basePriceMinor, undefined);
  }
  await new Promise(resolve => setImmediate(resolve));
});

test('successful preview publishes its own response clock without changing quotes or errors', () => {
  const source = fs.readFileSync(new URL('../nodered_subscription_price_preview_nodes/final.js', import.meta.url), 'utf8');
  const serverTimeMs = 1893456000000;
  const finish = vm.compileFunction(source, ['msg', 'node'], {
    parsingContext: vm.createContext({ Date: class extends Date { static now() { return serverTimeMs; } } }),
  });
  const quote = { subscriptionId: 'fixture-subscription', evaluatedAt: serverTimeMs - 1, expiresAt: serverTimeMs + 29999 };
  const response = finish({ _subscriptionPricePreview: { done: true, quotes: [quote] } }, { warn() {} });
  assert.deepEqual(structuredClone(response.payload), { quotes: [quote], serverTimeMs });
  assert.equal(response.headers['Cache-Control'], 'no-store');
  const refused = finish({ _subscriptionPricePreview: { done: true, error: 'PRICE_PREVIEW_TIMEOUT', statusCode: 503 } }, { warn() {} });
  assert.deepEqual(structuredClone(refused.payload), { error: { code: 'PRICE_PREVIEW_TIMEOUT' } });
});

test('server-clock upgrade changes only the exact installed final function', () => {
  const oldSource = fs.readFileSync(new URL('./fixtures/subscriptionPreviewLegacyFinal.txt', import.meta.url), 'utf8');
  const source = oldSource.replace(': { quotes: ctx.quotes || [] };',
    ': { quotes: ctx.quotes || [], serverTimeMs: Date.now() };');
  const final = { id: 'lk_subscription_price_preview_20260908_final', type: 'function', func: oldSource,
    wires: [['fixture-response']], initialize: '', finalize: '' };
  const flow = [final, { id: 'fixture-response', type: 'http response', wires: [] },
    { id: 'fixture-unrelated', type: 'function', func: 'return msg;', wires: [] }];
  const liveBytes = Buffer.from(JSON.stringify(flow));
  const packet = composeSubscriptionPreviewServerTimeArtifacts(liveBytes, 'preview-server-time-test');
  assert.deepEqual(packet.candidate, [{ ...final, func: source }, ...flow.slice(1)]);
  assert.equal(final.func, oldSource);
  assert.equal(liveBytes.toString(), JSON.stringify(flow));
  for (const invalid of [[], [null], [final, final], [{ ...final, type: 'http response' }],
    [{ ...final, func: oldSource + '\n' }], packet.candidate]) {
    assert.throws(() => composeSubscriptionPreviewServerTimeArtifacts(Buffer.from(JSON.stringify(invalid)), 'negative-test'), /Invalid|drift/);
  }
});
liveTest('90 minute preview uses actual state machine, exact tariff DTO and canonical evaluator',()=>{
  const {response,calls}=harness(); assert.equal(response.statusCode,200);const q=response.payload.quotes[0];
  assert.deepEqual([q.amountMinor,q.freeMinutes,q.paidMinutes],[70000,60,30]);
  assert.equal(calls.filter(c=>c.path?.endsWith('/subscriptions')).length,1);
  assert.equal(calls.filter(c=>c.path?.endsWith('/profile')).length,1);
});
liveTest('60 and120 minute preview keeps canonical free/paid allocation',()=>{
  for(const [duration,amount,paid] of [[60,0,0],[120,105000,60]]) {
    const {response}=harness({target:{durationMinutes:duration}}); assert.equal(response.statusCode,200);
    assert.deepEqual([response.payload.quotes[0].amountMinor,response.payload.quotes[0].paidMinutes],[amount,paid]);
  }
});
liveTest('daily free allowance exhausted yields paid quote; history does not inflate active count',()=>{
  const {response}=harness({history:[booking(),booking(uuid(11),{isCancelled:true})]});assert.equal(response.statusCode,200);
  assert.equal(response.payload.quotes[0].amountMinor,210000);
});
liveTest('active booking limit and zero visits cannot advertise a free place',()=>{
  const busy=harness({active:[1,2,3,4].map(n=>booking(uuid(20+n),{exerciseDate:'2099-09-22'}))}).response;
  assert.equal(busy.statusCode,200);assert.equal(busy.payload.quotes[0].status,'LIMIT_USED');
  const empty=harness({subscriptions:[subscription(sub,{visitsLeft:0})]}).response;
  assert.equal(empty.payload.quotes[0].status,'LIMIT_USED');
});
liveTest('all instances return exactly one result and legacy price remains free',()=>{
  const {response}=harness({subscriptions:[subscription(),subscription(uuid(12),{purchaseDate:'2026-08-29T10:00:00'})]});
  assert.equal(response.statusCode,200);assert.equal(response.payload.quotes.length,2);
  assert.deepEqual(response.payload.quotes.map(q=>q.amountMinor),[70000,0]);
});
liveTest('durable minutes and covered Viva booking are counted once',()=>{
  const b=booking();const op={clientSubscriptionId:sub,tenantKey:'iSkq6G',actorClientId:actor,serviceDate:'2099-09-21',state:'CONFIRMED',bookingId:b.id,
    lk1:{rule,decision:{gameMinutes:{localDate:'2099-09-21',freeMinutes:30}}}};
  const {response}=harness({history:[b],operations:[op]});assert.equal(response.statusCode,200);
  assert.deepEqual([response.payload.quotes[0].freeMinutes,response.payload.quotes[0].amountMinor],[30,140000]);
});
liveTest('policy OFF/mismatch, cache miss, foreign ownership and incomplete pages fail the whole batch',()=>{
  const variants=[{globals:{subscriptions_lk1_product_policy:null}},
    {globals:{subscriptions_lk1_product_policy:{...rule,freeGameMinutesPerDay:120}}},{instances:[]},
    {subscriptions:[subscription(sub,{clientId:uuid(88)})]},
    {mutateHttp(msg,url){if(url.pathname.endsWith('/bookings'))msg.payload={content:[],totalElements:2,last:false};}},
    {mutateHttp(msg,url){if(url.pathname.endsWith('/subscriptions'))msg.payload={content:[subscription()],totalElements:2};}},
    {mutateMongo(msg,node){if(node.collection==='lk_subscription_daily_booking_ops')msg.error={message:'fixture failure'};}}];
  for(const options of variants){const {response}=harness(options);assert.ok(response.statusCode>=400);assert.equal(response.payload.quotes,undefined);}
});
liveTest('invalid client price/actor/duplicate IDs stop before any provider call',()=>{
  for(const options of [{body:{actorClientId:uuid(99)}},{target:{basePriceMinor:0}},{ids:[sub,sub]},{ids:[]}]) {
    const {response,calls}=harness(options);assert.equal(response.statusCode,400);assert.equal(calls.length,0);
  }
});
liveTest('graph cannot reach an existing node or a business write; evaluator byte identity preserved',()=>{
  assert.equal(packet.contract.allowedChanges.length,0);
  const ids=new Set(nodes.map(n=>n.id));
  for(const n of nodes){for(const id of (n.wires||[]).flat()) assert.ok(ids.has(id));
    if(n.type==='mongodb4')assert.equal(n.operation,'find');if(n.type==='http request')assert.equal(n.method,'use');}
  assert.equal(nodes.find(n=>n.id.endsWith('_evaluate')).func, original.find(n=>n.id==='lk_subscription_managed_policy_20260820').func);
  assert.ok(nodes.some(n=>n.type==='http in'&&n.url===PATH&&n.method==='post'));
});

liveTest('changed canonical helper or usage cannot become new public executable code',()=>{
  for(const id of ['lk_subscription_booking_router_20260804','8f7bd5b482fe9763','lk_subscription_managed_policy_20260820']) {
    const altered=structuredClone(original);altered.find(row=>row.id===id).func+='\n// drift';
    assert.throws(()=>composeSubscriptionPricePreviewArtifacts(Buffer.from(JSON.stringify(altered)),'fixture-drift'),/canonical/);
  }
});

liveTest('HAB cohort must have one valid purchase date; cutoff preserves legacy behavior',()=>{
  for(const change of [{purchaseDate:undefined},{purchaseDate:'invalid'},{purchaseDate:'2026-09-05',purchaseAt:'2026-08-31'}]) {
    const {response}=harness({subscriptions:[subscription(sub,change)]});assert.equal(response.statusCode,503);assert.equal(response.payload.quotes,undefined);
  }
  for(const [date,amount] of [['2026-08-31',0],['2026-09-01',70000]]) {
    assert.equal(harness({subscriptions:[subscription(sub,{purchaseDate:date})]}).response.payload.quotes[0].amountMinor,amount);
  }
});
liveTest('malformed persisted product ID cannot be resolved by a legacy name',()=>{
  const {response}=harness({mutateMongo(msg){if(msg._subscriptionPricePreview.step==='metadata')msg.payload[0].productId='-'.repeat(36);}});
  assert.equal(response.statusCode,503);assert.equal(response.payload.quotes,undefined);
});

liveTest('one visit remains a HAB 90/120 minute candidate while legacy cannot use two visits',()=>{
  for(const durationMinutes of [90,120]) for(const status of ['ACTIVE','NEW']) {
    const lifecycle=status==='NEW'?{status,activationDate:null,expirationDate:null}: {status};
    const current=harness({target:{durationMinutes},subscriptions:[subscription(sub,{...lifecycle,visitsLeft:1})]}).response;
    assert.equal(current.statusCode,200);
    assert.equal(current.payload.quotes[0].status,'AVAILABLE');
    assert.equal(current.payload.quotes[0].paidMinutes,durationMinutes-60);
    assert.ok(current.payload.quotes[0].amountMinor>0);
    const legacy=harness({target:{durationMinutes},subscriptions:[subscription(sub,{...lifecycle,visitsLeft:1,purchaseDate:'2026-08-29T10:00:00'})]}).response;
    assert.equal(legacy.statusCode,200);
    assert.notEqual(legacy.payload.quotes[0].status,'AVAILABLE');
    assert.equal(legacy.payload.quotes[0].amountMinor,null);
  }
});


test('tariff query runs in a Function sandbox without Node global URLSearchParams',()=>{
  const source=fs.readFileSync(new URL('../nodered_subscription_price_preview_nodes/router.js',import.meta.url),'utf8');
  const context=vm.createContext({});
  assert.equal(vm.runInContext('typeof URLSearchParams',context),'undefined');
  const run=vm.compileFunction(source,['msg','pricing'],{parsingContext:context});
  const msg={statusCode:200,payload:[{id:service}],_subscriptionPricePreview:{
    tenantKey:'fixture',auth:'Bearer fixture-user',step:'subservices',startedAt:Date.now(),target}};
  const outputs=run(msg,{extractList:value=>value});
  assert.equal(outputs[0],msg);
  const url=new URL(msg.url);
  assert.equal(msg.method,'GET');
  assert.equal(url.origin,'https://api.vivacrm.ru');
  assert.equal(url.searchParams.get('studioId'),studio);
  assert.equal(url.searchParams.get('roomId'),room);
  assert.equal(url.searchParams.get('subServiceIds'),service);
  assert.equal(url.searchParams.get('fromDate'),'2099-09-21');
  assert.equal(url.searchParams.get('fromTime'),'07:00:00');
  assert.equal(url.searchParams.get('toTime'),'08:30:00');
});

liveTest('three instances isolate active bookings and free-minute ledger in the complete preview route',()=>{
  const second=uuid(12),third=uuid(13);
  const active=[1,2,3,4].map(n=>booking(uuid(40+n),{exerciseDate:'2099-09-22'}));
  const operations=[{tenantKey:'iSkq6G',actorClientId:actor,clientSubscriptionId:sub,serviceDate:'2099-09-21',state:'CONFIRMED',lk1:{rule,decision:{gameMinutes:{localDate:'2099-09-21',freeMinutes:60}}}}];
  const {response,calls}=harness({subscriptions:[subscription(),subscription(second),subscription(third)],active,operations,target:{durationMinutes:60}});
  assert.equal(response.statusCode,200);
  const [a,b,c]=response.payload.quotes;
  assert.equal(a.reasonCode,'ACTIVE_SERVICES_LIMIT_REACHED');
  assert.equal(a.status,'LIMIT_USED');
  for(const q of [b,c]) assert.deepEqual([q.status,q.amountMinor,q.freeMinutes],['AVAILABLE',0,60]);
  assert.deepEqual([b.subscriptionId,c.subscriptionId],[second,third]);
  assert.equal(calls.filter(call=>call.collection==='lk_subscription_daily_booking_ops').length,1);
  assert.equal(calls.filter(call=>call.path?.endsWith('/bookings')).length,1);
});

liveTest('preview refuses missing or conflicting subscription membership in active and history reads',()=>{
  for(const extra of [{clientSubscriptionId:null},{subscriptionId:uuid(12)},{subscription:{id:uuid(12)}},{clientSubscription:{uuid:uuid(12)}}]) {
    for(const list of ['active','history']) {
      const {response}=harness({[list]:[booking(uuid(77),extra)]});
      assert.ok(response.statusCode>=400);
      assert.equal(response.payload.quotes,undefined);
    }
  }
});

liveTest('fresh preview install rejects the old actor-wide CREATE runtime',()=>{
  assert.throws(()=>composeSubscriptionPricePreviewArtifacts(Buffer.from(JSON.stringify(legacyOriginal)),'fixture-old-runtime'),/canonical/);
});

liveTest('selected-instance unresolved provider date/category refuses preview',()=>{
  for(const extra of [{exerciseDate:null,timeFrom:null},{exerciseType:null,exerciseDirection:null}]){
    for(const list of ['active','history']){
      const {response}=harness({[list]:[booking(uuid(78),extra)]});
      assert.ok(response.statusCode>=400);
      assert.equal(response.payload.quotes,undefined);
    }
  }
});

liveTest('existing game joins use canonical game, exercise and the same instance-scoped quote',()=>{
  const {response,calls}=harness({join:true,subscriptions:[subscription(),subscription(uuid(12),{purchaseDate:'2026-08-29T10:00:00'})]});
  assert.equal(response.statusCode,200);
  assert.deepEqual(response.payload.quotes.map(q=>q.amountMinor),[70000,0]);
  assert.equal(response.payload.quotes[0].selectionKey,JSON.stringify(['EXISTING_GAME',gameId,target.startsAt,90]));
  assert.equal(calls.filter(c=>c.collection==='lk_games').length,1);
  assert.equal(calls.filter(c=>c.path?.includes('/exercises/')).length,1);
  assert.ok(calls.every(c=>['GET','find'].includes(c.kind)));
});
liveTest('join spent allowance, active limits and last visit stay specific to the purchased instance',()=>{
  const ids=[sub,uuid(12)];
  const rows=ids.map(id=>subscription(id,{visitsLeft:1}));
  const busy=harness({join:true,subscriptions:rows,active:[1,2,3,4].map(n=>booking(uuid(20+n),{exerciseDate:'2099-09-22'}))}).response;
  assert.equal(busy.statusCode,200); assert.deepEqual(busy.payload.quotes.map(q=>q.status),['LIMIT_USED','AVAILABLE']);
  const used=harness({join:true,subscriptions:rows,history:[booking()]}).response;
  assert.equal(used.statusCode,200); assert.deepEqual(used.payload.quotes.map(q=>q.amountMinor),[210000,70000]);
});
liveTest('join rejects missing game, conflicting target and untrusted price before a quote',()=>{
  for(const options of [{games:[]},{target:{durationMinutes:60}},{target:{startsAt:'2099-09-21T07:30:00+03:00'}},
    {target:{amountMinor:0}},{target:{stationId:studio}},{games:[{id:gameId,booking:{}}]}]) {
    const {response}=harness({join:true,...options});assert.notEqual(response.statusCode,200);assert.equal(response.payload.quotes,undefined);
  }
});
liveTest('join requires current exercise subscription availability, not just owned catalog',()=>{
  const result=harness({join:true,mutateHttp(msg,url){if(url.pathname.includes('/exercises/'))msg.payload.availableClientSubscriptions=[];}}).response;
  assert.equal(result.statusCode,200);assert.equal(result.payload.quotes[0].status,'UNAVAILABLE');
  for(const change of [{id:uuid(99)},{studioId:uuid(99)},{roomId:uuid(99)},{typeId:123,directionId:123},{isCancelled:true},{availableClientSubscriptions:null}]) {
    const {response}=harness({join:true,mutateHttp(msg,url){if(url.pathname.includes('/exercises/'))Object.assign(msg.payload,change);}});
    assert.notEqual(response.statusCode,200);assert.equal(response.payload.quotes,undefined);
  }
});
liveTest('join provider or metadata failures have no price and no write-capable path',()=>{
  for(const options of [{instances:[]},{mutateHttp(msg,url){if(url.pathname.includes('/exercises/'))msg.statusCode=503;}},
    {mutateMongo(msg,node){if(node.collection==='lk_games')msg.error={message:'fixture-read-error'};}}]) {
    const {response,calls}=harness({join:true,...options});assert.notEqual(response.statusCode,200);assert.equal(response.payload.quotes,undefined);
    assert.ok(calls.every(c=>['GET','find'].includes(c.kind)));
  }
});

liveTest('join canonical game corruption never produces a price',()=>{
  for (const change of [game=>game.status='CANCELLED',game=>game.metadata.splitPayment.enabled=false,
    game=>game.booking.timeTo='09:00',game=>game.booking.durationMinutes=60,
    game=>game.booking.exerciseId=uuid(99),game=>game.booking.masterServiceId=null]) {
    const {response}=harness({join:true,mutateMongo(msg,node){if(node.collection==='lk_games')change(msg.payload[0]);}});
    assert.notEqual(response.statusCode,200);assert.equal(response.payload.quotes,undefined);
  }
  const duplicate=harness({join:true,mutateMongo(msg,node){if(node.collection==='lk_games')msg.payload.push({...msg.payload[0]});}}).response;
  assert.notEqual(duplicate.statusCode,200);
});
liveTest('join server pricing preserves singles share and known unavailable rows',()=>{
  const singles=harness({join:true,mutateMongo(msg,node){if(node.collection==='lk_games')msg.payload[0].metadata.splitPayment.shareCount=2;}}).response;
  assert.equal(singles.statusCode,200); assert.equal(singles.payload.quotes[0].amountMinor,140000);
  for (const [extra,status] of [[{visitsLeft:0},'LIMIT_USED'],[{visitsLeft:1,purchaseDate:'2026-08-29T10:00:00'},'UNAVAILABLE'],
    [{expirationDate:'2026-09-07'},'UNAVAILABLE'],[{isFrozen:true},'UNAVAILABLE']]) {
    const result=harness({join:true,subscriptions:[subscription(sub,extra)]}).response;
    assert.equal(result.statusCode,200);assert.equal(result.payload.quotes[0].status,status);
  }
});

const installedFixture = process.env.LK_JOIN_PREVIEW_INSTALLED_FLOW_FIXTURE;
test('existing preview upgrade preserves every unrelated node and fails on source drift', {skip:!installedFixture && 'Requires private installed preview fixture'},()=>{
  const bytes=fs.readFileSync(installedFixture), before=JSON.parse(bytes);
  const packet=composeSubscriptionJoinPricePreviewArtifacts(bytes,'join-upgrade-test');
  const changed=['lk_subscription_price_preview_20260908_entry','lk_subscription_price_preview_20260908_router','lk_subscription_price_preview_20260908_catch'];
  for(const row of before) if(!changed.includes(row.id)) assert.deepEqual(packet.candidate.find(n=>n.id===row.id),row);
  assert.equal(packet.candidate.length,before.length+1);
  const added=packet.candidate.at(-1);assert.equal(added.collection,'lk_games');assert.equal(added.operation,'find');
  before.find(n=>n.id===changed[0]).func+='\n// drift';
  assert.throws(()=>composeSubscriptionJoinPricePreviewArtifacts(Buffer.from(JSON.stringify(before)),'join-upgrade-test'),/preimage drift/);
});
liveTest('join 60 and 120 minute calculations retain canonical minute allocation',()=>{
  for(const [duration,end,amount,free,paid] of [[60,'08:00',0,60,0],[120,'09:00',105000,60,60]]) {
    const result=harness({join:true,target:{durationMinutes:duration},mutateMongo(msg,node){if(node.collection==='lk_games')Object.assign(msg.payload[0].booking,{timeTo:end,durationMinutes:duration});},
      mutateHttp(msg,url){if(url.pathname.includes('/exercises/'))msg.payload.timeTo=`2099-09-21T${end}:00+03:00`;}}).response;
    assert.equal(result.statusCode,200);assert.deepEqual([result.payload.quotes[0].amountMinor,result.payload.quotes[0].freeMinutes,result.payload.quotes[0].paidMinutes],[amount,free,paid]);
  }
});

// Guard-local fixtures execute source bodies with the real pricing list extractor.
// No private flow, provider/DB calls, HTTP server or installed observer is required.
const crossDaySource = name => fs.readFileSync(new URL(`../nodered_subscription_price_preview_nodes/${name}.js`, import.meta.url), 'utf8');
const crossDayNow = Date.parse('2099-09-20T09:00:00Z');
const crossDayClock = class extends Date {
  constructor(...args) { super(...(args.length ? args : [crossDayNow])); }
  static now() { return crossDayNow; }
};
const crossDayContext = vm.createContext({ Date: crossDayClock });
const crossDayEntry = vm.compileFunction(crossDaySource('entry'), ['msg', 'global'], { parsingContext: crossDayContext });
const crossDayRouter = vm.compileFunction(crossDaySource('router'), ['msg', 'canonical', 'pricing', 'global'], { parsingContext: crossDayContext });
const crossDayFinal = vm.compileFunction(crossDaySource('final'), ['msg', 'global'], { parsingContext: crossDayContext });
const crossDayHelpers = extractSubscriptionPricePreviewSource({
  source: fs.readFileSync(new URL('../nodered_games_nodes/fn_split_router.js', import.meta.url), 'utf8'),
  roots: ['extractList'],
}).source;
const crossDayPricing = new Function(`${crossDayHelpers}; return {extractList};`)();
function crossDayFixture(options = {}) {
  const events = [];
  const observer = createDiagnostics({ sink: event => { events.push(event); if (options.throwSink) throw Error('synthetic sink failure'); } });
  const globals = { get() {
    if (options.observer === 'getterThrows') throw Error('synthetic getter failure');
    if (options.observer === 'absent') return undefined;
    if (options.observer === 'throws') return { observe() { throw Error('synthetic observer failure'); } };
    return observer;
  } };
  const chosen = { ...target, startsAt: '2099-09-21T23:00:00+03:00', ...options.target };
  const selected = options.existing ? { targetKind: 'EXISTING_GAME', gameId,
    startsAt: chosen.startsAt, durationMinutes: chosen.durationMinutes } : chosen;
  const msg = { _msgid: 'synthetic-message-correlation', req: { path: '/lk/subscriptions/game-price-preview', method: 'POST',
    headers: { authorization: 'Bearer synthetic-auth-only' } }, payload: { target: selected, subscriptionIds: [sub] } };
  crossDayEntry(msg, globals);
  const ctx = msg._subscriptionPricePreview;
  if (ctx.done) return { msg, ctx, events };
  // The fixture begins at the response to subservices. For EXISTING_GAME the
  // preceding game/exercise checks are mocked as confirmed, not performed here.
  if (options.existing) Object.assign(ctx.target, { subServiceIds: chosen.subServiceIds });
  ctx.step = 'subservices';
  if (Object.hasOwn(options, 'elapsed')) ctx.startedAt = crossDayNow - options.elapsed;
  options.mutateContext?.(ctx);
  msg.payload = options.payload ?? chosen.subServiceIds.map(id => ({ id }));
  msg.statusCode = options.upstreamStatus ?? 200;
  if (options.transportError) msg.error = { message: 'synthetic transport failure' };
  const ports = crossDayRouter(msg, {}, crossDayPricing, globals);
  const output = ports.findIndex(Boolean);
  if (output === 4) crossDayFinal(msg, globals);
  observer.dispose();
  return { msg, ctx, events, output };
}
const crossDayEvent = events => events.find(event => event.code === 'PRICE_PREVIEW_CROSS_DAY_UNRESOLVED' && event.stage === 'preview_router');
const crossDayFields = event => Object.fromEntries(Object.entries(event).filter(([key]) => key.startsWith('preview')));

test('closing midnight is inclusive for all accepted durations; any overrun still refuses', () => {
  for (const minutes of [60, 90, 120]) for (const delta of [-1, 0, 1]) {
    const start = new Date(Date.parse('2099-09-22T00:00:00Z') - minutes * 60000 + delta);
    const startsAt = start.toISOString().slice(0, 23) + '+03:00';
    const { msg, events, output } = crossDayFixture({ target: { startsAt, durationMinutes: minutes } });
    const event = crossDayEvent(events);
    if (delta <= 0) {
      assert.equal(output, 0); assert.equal(msg.method, 'GET'); assert.match(msg.url, /\/price\?/);
      assert.equal(event, undefined);
    } else {
      assert.equal(output, 4); assert.equal(msg.statusCode, 503);
      assert.deepEqual(structuredClone(msg.payload), { error: { code: 'PRICE_PREVIEW_CROSS_DAY_UNRESOLVED' } });
      assert.equal(msg.url, undefined); assert.equal(msg._subscriptionPricePreview, undefined);
      assert.equal(event.operationStage, 'subservices'); assert.equal(event.previewDayRelation, 'NEXT_DAY');
      assert.equal(event.previewEndAtMidnight, false); assert.equal(event.previewDuration, `MINUTES_${minutes}`);
      assert.equal(event.previewOffsetValid, true); assert.equal(event.previewSubservicesMatched, true);
      assert.equal(event.previewSubservices2xx, true); assert.equal(event.previewSelectedSubserviceCount, 1);
      assert.equal(event.previewSubserviceSetSize, 1);
      const final = events.find(event => event.code === 'PRICE_PREVIEW_CROSS_DAY_UNRESOLVED' && event.stage === 'preview_final');
      assert.equal(event.requestId, final.requestId, 'Reuse the server observer correlation, not the message/business ID');
    }
  }
  for (const startsAt of ['2099-09-21T02:30:00+03:00', '2099-09-22T00:30:00+03:00']) {
    const result = crossDayFixture({ target: { startsAt, durationMinutes: 60 } });
    assert.equal(result.output, 0); assert.equal(crossDayEvent(result.events), undefined);
  }
  for (const startsAt of ['2099-09-30T23:00:00+03:00', '2099-12-31T23:00:00+03:00']) {
    const result = crossDayFixture({ target: { startsAt } });
    assert.equal(crossDayEvent(result.events).previewDayRelation, 'NEXT_DAY');
  }
});

test('closing midnight keeps start-day price contract across calendar boundaries and target kinds', () => {
  for (const [date, endDate] of [['2099-09-21', '2099-09-22'], ['2099-09-30', '2099-10-01'],
    ['2099-12-31', '2100-01-01'], ['2104-02-28', '2104-02-29'], ['2104-02-29', '2104-03-01']]) {
    for (const [time, durationMinutes] of [['23:00', 60], ['22:30', 90], ['22:00', 120]]) {
      for (const existing of [false, true]) {
        const result = crossDayFixture({ existing, target: { startsAt: `${date}T${time}:00+03:00`, durationMinutes } });
        assert.equal(result.output, 0);
        assert.equal(result.msg.method, 'GET');
        const url = new URL(result.msg.url);
        assert.equal(url.searchParams.get('fromDate'), date);
        assert.equal(url.searchParams.get('fromTime'), time + ':00');
        assert.equal(url.searchParams.get('toTime'), '00:00:00');
        assert.equal(url.searchParams.has('toDate'), false);
        assert.equal(result.ctx.target.startsAt.slice(0, 10), date);
        assert.equal(crossDayEvent(result.events), undefined);
        assert.equal(new Date(Date.parse(result.ctx.target.startsAt) + (durationMinutes + 180) * 60000).toISOString().slice(0, 10), endDate);
      }
    }
  }
});

test('cross-day diagnostics describe target provenance and bounded elapsed/cardinality only', () => {
  for (const existing of [false, true]) {
    const event = crossDayEvent(crossDayFixture({ existing }).events);
    assert.equal(event.previewTargetKind, existing ? 'EXISTING_GAME' : 'NEW_GAME');
    assert.equal(event.previewTargetSource, existing ? 'SERVER_CONFIRMED' : 'CLIENT_INPUT');
  }
  for (const [elapsed, expected] of [[0, 'LT1S'], [999, 'LT1S'], [1000, 'LT5S'], [4999, 'LT5S'],
    [5000, 'LT15S'], [14999, 'LT15S'], [15000, 'LE28S'], [28000, 'LE28S'], [-1, 'UNKNOWN'], [NaN, 'UNKNOWN']]) {
    assert.equal(crossDayEvent(crossDayFixture({ elapsed }).events).previewElapsedBucket, expected);
  }
  const ids = Array.from({ length: 20 }, (_, index) => uuid(index + 100));
  const result = crossDayFixture({ target: { subServiceIds: ids }, payload: [...ids, ...Array.from({ length: 80 }, (_, index) => uuid(index + 200))].map(id => ({ id })) });
  const event = crossDayEvent(result.events);
  assert.equal(event.previewSelectedSubserviceCount, 20); assert.equal(event.previewSubserviceSetSize, 21);
  const unknown = crossDayFixture({ mutateContext(ctx) { ctx.target.targetKind = 'synthetic-untrusted'; } });
  assert.equal(crossDayEvent(unknown.events).previewTargetKind, 'UNKNOWN');
  assert.equal(crossDayEvent(unknown.events).previewTargetSource, 'UNKNOWN');
});

test('other refusal guards and invalid entry data never emit cross-day diagnostics', () => {
  for (const [options, code] of [
    [{ payload: [] }, 'SPLIT_EXACT_PRICE_SUBSERVICE_MISMATCH'],
    [{ payload: { unexpected: true } }, 'SPLIT_EXACT_PRICE_SUBSERVICE_MISMATCH'],
    [{ payload: [{ id: uuid(99) }] }, 'SPLIT_EXACT_PRICE_SUBSERVICE_MISMATCH'],
    [{ upstreamStatus: 401 }, 'SPLIT_EXACT_PRICE_SUBSERVICE_MISMATCH'],
    [{ upstreamStatus: 503 }, 'SPLIT_EXACT_PRICE_SUBSERVICE_MISMATCH'],
    [{ transportError: true }, 'PRICE_PREVIEW_READ_FAILED'],
    [{ elapsed: 28001 }, 'PRICE_PREVIEW_TIMEOUT'],
  ]) {
    const result = crossDayFixture(options);
    assert.equal(result.msg.statusCode, 503); assert.equal(result.msg.payload.error.code, code);
    assert.equal(crossDayEvent(result.events), undefined);
  }
  for (const patch of [{ startsAt: '2099-09-21T23:00:00Z' }, { startsAt: '2099-09-21T23:00:00+02:00' },
    { startsAt: '2099-09-31T23:00:00+03:00' }, { startsAt: undefined },
    { durationMinutes: '90' }, { durationMinutes: undefined }, { durationMinutes: NaN },
    { durationMinutes: 180 }, { subServiceIds: [service, service] }]) {
    const result = crossDayFixture({ target: patch });
    assert.equal(result.ctx.statusCode, 400); assert.equal(result.ctx.error, 'PRICE_PREVIEW_REQUEST_INVALID');
    assert.equal(crossDayEvent(result.events), undefined);
  }
});

test('absent, failing and malformed observers or diagnostic derivation cannot change the 503 response', () => {
  const baseline = crossDayFixture().msg;
  for (const observer of ['absent', 'getterThrows', 'throws']) {
    assert.deepEqual(structuredClone(crossDayFixture({ observer }).msg), structuredClone(baseline));
  }
  assert.deepEqual(structuredClone(crossDayFixture({ throwSink: true }).msg), structuredClone(baseline));
  const broken = crossDayFixture({ mutateContext(ctx) {
    Object.defineProperty(ctx.target, 'targetKind', { get() { throw Error('synthetic derivation failure'); } });
  } });
  assert.deepEqual(structuredClone(broken.msg), structuredClone(baseline));
  assert.equal(crossDayEvent(broken.events), undefined);
});

test('cross-day events never include dates, clock times, identifiers, auth, query or provider strings', () => {
  const privateText = [['synthetic-private-person', 'example.invalid'].join('@'),
    ['Bearer', 'synthetic-private-token'].join(' '), ['+7', '999', '000', '00', '00'].join(''), '?private=query'].join(' ');
  const result = crossDayFixture({ payload: { content: [{ subServices: [{ id: service, name: privateText, raw: { body: privateText } }] }] } });
  const event = crossDayEvent(result.events);
  assert.equal(event.previewSubserviceSetSize, 1);
  const serialized = JSON.stringify(result.events);
  for (const value of [privateText, target.startsAt, '2099-09-21', '23:00:00', service, sub, studio,
    room, master, 'synthetic-message-correlation', 'synthetic-auth-only']) assert(!serialized.includes(value));
  assert.deepEqual(Object.keys(crossDayFields(event)).sort(), [
    'previewTargetKind', 'previewTargetSource', 'previewDuration', 'previewDayRelation', 'previewOffsetValid',
    'previewEndAtMidnight', 'previewSelectedSubserviceCount', 'previewSubserviceSetSize',
    'previewSubservicesMatched', 'previewSubservices2xx', 'previewElapsedBucket',
  ].sort());
});

test('scoped deployment observer filters before budget and cannot inherit raw message context', async () => {
  const { createPreviewCrossDayObserver } = await import('../diagnostics/preview-cross-day-observer.mjs');
  const events = [];
  const observer = createPreviewCrossDayObserver({ sourceHash: 'a'.repeat(64), release: 'b'.repeat(40), detailLimit: 1, sink: e => events.push(e) });
  const msg = { _subscriptionPricePreview: { step: 'subservices' },
    get payload() { throw Error('must not read payload'); }, get req() { throw Error('must not read headers'); },
    get _lkDiagnosticContext() { throw Error('must not inherit correlation'); } };
  for (let i = 0; i < 1000; i++) observer.observe(msg, 'preview_router', { code: 'STAGE_ENTER' });
  assert.equal(observer.snapshot().observed, 0);
  observer.observe(msg, 'preview_router', { code: 'PRICE_PREVIEW_CROSS_DAY_UNRESOLVED', previewDuration: 'MINUTES_90',
    serverRequestId: uuid(99), body: 'synthetic-private', previewEndAtMidnight: false });
  assert.equal(events.length, 1); assert.equal(events[0].previewDuration, 'MINUTES_90');
  assert.equal(events[0].serverRequestId, undefined); assert.equal(events[0].entityRef, undefined);
  assert(!JSON.stringify(events).includes('synthetic-private')); assert(!JSON.stringify(events).includes(uuid(99)));
  observer.dispose();
});

test('flow-contained observer initializes once per VM, survives failures and is fully disposed', async () => {
  const { previewCrossDayLifecycle, composePreviewCrossDayRelease } = await import('../prepare_preview_cross_day_release.mjs');
  const crypto = await import('node:crypto'); const perf = await import('node:perf_hooks');
  const lifecycle = previewCrossDayLifecycle('b'.repeat(40));
  const logs = []; const sandbox = vm.createContext({ preview350Crypto: crypto, preview350Performance: perf,
    node: { warn: line => logs.push(line) }, Buffer, setTimeout, clearTimeout });
  const initialize = new vm.Script(lifecycle.initialize), finalize = new vm.Script(lifecycle.finalize);
  initialize.runInContext(sandbox);
  const first = sandbox.__lkPreview350Observer;
  assert.equal(first.owner, 'preview-cross-day-v1');
  assert.equal(sandbox.require, undefined); assert.equal(sandbox.process, undefined);
  const marker = JSON.parse(logs[0].slice(logs[0].indexOf('{')));
  assert.deepEqual(marker, lifecycle.marker);
  const fields = { code: 'PRICE_PREVIEW_CROSS_DAY_UNRESOLVED', previewDuration: 'MINUTES_90', previewEndAtMidnight: true };
  first.observe({ _subscriptionPricePreview: { step: 'subservices' } }, 'preview_router', fields);
  assert.equal(JSON.parse(logs[1].slice(logs[1].indexOf('{'))).previewEndAtMidnight, true);
  initialize.runInContext(sandbox);
  assert.notEqual(sandbox.__lkPreview350Observer, first);
  finalize.runInContext(sandbox); assert.equal(sandbox.__lkPreview350Observer, undefined);
  finalize.runInContext(sandbox);
  const foreign = { owner: 'foreign' }; sandbox.__lkPreview350Observer = foreign;
  initialize.runInContext(sandbox); assert.equal(sandbox.__lkPreview350Observer, foreign);
  finalize.runInContext(sandbox); assert.equal(sandbox.__lkPreview350Observer, foreign);
  delete sandbox.__lkPreview350Observer; sandbox.preview350Crypto = {};
  initialize.runInContext(sandbox); assert.equal(sandbox.__lkPreview350Observer, undefined);
  assert.equal(JSON.parse(logs.at(-1).slice(logs.at(-1).indexOf('{'))).event, 'preview_cross_day_observer_unavailable');
  assert.throws(() => composePreviewCrossDayRelease(Buffer.from('[]'), 'b'.repeat(40)), /FLOW_DRIFT/);
});

// Preserve the pre-diagnostics boolean guards, including evaluation order and UUID/ID grammars.
function validationGuardFingerprint(source) {
  const sf = ts.createSourceFile('entry.js', source, ts.ScriptTarget.Latest, true, ts.ScriptKind.JS);
  function normalize(n) {
    if (ts.isParenthesizedExpression(n)) return normalize(n.expression);
    if (ts.isCallExpression(n) && n.expression.getText(sf) === 'invalid') return normalize(n.arguments[0]);
    if (ts.isBinaryExpression(n) && [ts.SyntaxKind.BarBarToken, ts.SyntaxKind.AmpersandAmpersandToken].includes(n.operatorToken.kind)) {
      const op = n.operatorToken.kind;
      const flatten = x => Array.isArray(x) && x[0] === op ? x.slice(1) : [x];
      return [op, ...flatten(normalize(n.left)), ...flatten(normalize(n.right))];
    }
    const children = [];
    ts.forEachChild(n, child => { children.push(normalize(child)); });
    return children.length ? [n.kind, ...children] : [n.kind, n.getText(sf)];
  }
  const guards = [], dependencies = {};
  function walk(n) {
    if (ts.isIfStatement(n) && ts.isReturnStatement(n.thenStatement)
      && n.thenStatement.expression && ts.isCallExpression(n.thenStatement.expression) && n.thenStatement.expression.expression.getText(sf) === 'bad') guards.push(normalize(n.expression));
    if (ts.isVariableDeclaration(n) && ['uuid', 'existing', 'allowedTarget', 'eventCategory'].includes(n.name.getText(sf))) dependencies[n.name.getText(sf)] = normalize(n.initializer);
    ts.forEachChild(n, walk);
  }
  walk(sf);
  assert.equal(guards.length, 4);
  return createHash('sha256').update(JSON.stringify({ guards, dependencies })).digest('hex');
}
const validationEntry = fs.readFileSync(new URL('../nodered_subscription_price_preview_nodes/entry.js', import.meta.url), 'utf8');
const validationFinal = fs.readFileSync(new URL('../nodered_subscription_price_preview_nodes/final.js', import.meta.url), 'utf8');
const validationUuid = n => `${String(n).padStart(8, '0')}-0000-4000-8000-${String(n).padStart(12, '0')}`;
const validationBody = () => ({target: {targetKind:'NEW_GAME', slotId:'slot:fixture', stationId:validationUuid(1),
  roomId:validationUuid(2), masterServiceId:validationUuid(3), subServiceIds:[validationUuid(4)],
  startsAt:'2099-09-21T07:00:00+03:00', durationMinutes:90, shareCount:4}, subscriptionIds:[validationUuid(5)]});
const validationEventBody = kind => ({target:{targetKind:kind,exerciseId:validationUuid(6)}});
function validationExecute(body, {mode='shared', authorization='Bearer fixture', finalContext} = {}) {
  const events=[];
  const observer = mode === 'shared' ? createDiagnostics({sink:e=>events.push(e)})
    : mode === 'throwing' ? {observe(){throw Error('SYNTHETIC_PRIVATE');}}
    : mode === 'sink_throwing' ? createDiagnostics({sink(){throw Error('SYNTHETIC_PRIVATE');}}) : undefined;
  const globals={get(){if(mode==='get_throwing')throw Error('SYNTHETIC_PRIVATE');return observer;}};
  const msg={payload:structuredClone(body),req:{path:PATH,method:'POST',headers:{authorization},
    query:{private:'SYNTHETIC_PRIVATE'},body:{private:'SYNTHETIC_PRIVATE'}}};
  const entry = new Function('msg','global',validationEntry)(msg,globals);
  const ctx=entry._subscriptionPricePreview;
  if(finalContext)Object.assign(ctx,finalContext);
  if(ctx.done)new Function('msg','global',validationFinal)(msg,globals);
  return {msg,ctx,events,refusals:events.filter(e=>e.stage==='preview_final'&&e.httpStatus===400)};
}
test('input validation guard AST and grammar match the pre-diagnostics source',()=>{
  assert.equal(validationGuardFingerprint(validationEntry), '7b8649e3d39dbfdb26e49906fb31f1267b1169df23f5e2624d5f389a69bb1499');
});
test('request-invalid diagnostics cover each first failed predicate with only its field shape',()=>{
  const cases=[
    ['BODY_EXTRA_KEYS','OBJECT',b=>b.SYNTHETIC_PRIVATE=true],
    ['TARGET_SHAPE','MISSING',b=>delete b.target],
    ['TARGET_SHAPE','NULL',b=>b.target=null],
    ['TARGET_SHAPE','ARRAY',b=>b.target=[]],
    ['TARGET_SHAPE','NUMBER',b=>b.target=1],
    ['TARGET_EXTRA_KEYS','OBJECT',b=>b.target.SYNTHETIC_PRIVATE=true],
    ['TARGET_KIND','STRING',b=>b.target.targetKind='SYNTHETIC_PRIVATE'],
    ['SLOT_ID_SHAPE','STRING',b=>b.target.slotId='/SYNTHETIC_PRIVATE'],
    ['STATION_ID_SHAPE','STRING',b=>b.target.stationId='SYNTHETIC_PRIVATE'],
    ['ROOM_ID_SHAPE','NULL',b=>b.target.roomId=null],
    ['MASTER_ID_SHAPE','BOOLEAN',b=>b.target.masterServiceId=true],
    ['SERVICES_SHAPE','OBJECT',b=>b.target.subServiceIds={}],
    ['SERVICES_COUNT','ARRAY',b=>b.target.subServiceIds=[]],
    ['SERVICES_COUNT','ARRAY',b=>b.target.subServiceIds=Array.from({length:21},(_,i)=>validationUuid(i+10))],
    ['SERVICES_DUPLICATE','ARRAY',b=>b.target.subServiceIds.push(validationUuid(4))],
    ['SERVICE_ID_SHAPE','NUMBER',b=>b.target.subServiceIds=[validationUuid(4),123]],
    ['SHARE_ENUM','STRING',b=>b.target.shareCount='4'],
    ['START_FORMAT','STRING',b=>b.target.startsAt='2099-09-21T04:00:00Z'],
    ['START_PARSE','STRING',b=>b.target.startsAt='2099-99-21T07:00:00+03:00'],
    ['START_NOT_FUTURE','STRING',b=>b.target.startsAt='2000-01-01T07:00:00+03:00'],
    ['START_CALENDAR','STRING',b=>b.target.startsAt='2099-02-30T07:00:00+03:00'],
    ['DURATION_ENUM','STRING',b=>b.target.durationMinutes='90'],
    ['SUBSCRIPTIONS_SHAPE','MISSING',b=>delete b.subscriptionIds],
    ['SUBSCRIPTIONS_SHAPE','NULL',b=>b.subscriptionIds=null],
    ['SUBSCRIPTIONS_COUNT','ARRAY',b=>b.subscriptionIds=[]],
    ['SUBSCRIPTIONS_COUNT','ARRAY',b=>b.subscriptionIds=Array.from({length:21},(_,i)=>validationUuid(i+10))],
    ['SUBSCRIPTIONS_DUPLICATE','ARRAY',b=>b.subscriptionIds.push(validationUuid(5))],
    ['SUBSCRIPTION_ID_SHAPE','OBJECT',b=>b.subscriptionIds=[validationUuid(5),{}]],
  ];
  for(const [predicate,shape,mutate] of cases){
    const body=validationBody();mutate(body);
    const {msg,ctx,refusals}=validationExecute(body);
    assert.equal(ctx.firstFailedValidationPredicate,predicate);
    assert.equal(ctx.validationFieldShape,shape);
    assert.equal(refusals.length,1);
    const [event]=refusals;
    assert.equal(event.code,'PRICE_PREVIEW_REQUEST_INVALID');
    assert.equal(event.firstFailedValidationPredicate,predicate);
    assert.equal(event.validationFieldShape,shape);
    assert.equal(msg.statusCode,400);
    assert.deepEqual(msg.payload,{error:{code:'PRICE_PREVIEW_REQUEST_INVALID'}});
    assert.equal(ctx.auth,undefined);assert.equal(ctx.target,undefined);
    assert(!JSON.stringify(event).includes('SYNTHETIC_PRIVATE'));
    assert(!JSON.stringify(event).includes('2099-'));
    assert(!JSON.stringify(event).includes(validationUuid(1)));
    assert.deepEqual(sanitizeEvent(event),event);
  }
});
test('event and existing-game routes retain their own ID and optional-subscription guards',()=>{
  for(const kind of ['GROUP_TRAINING','TOURNAMENT']){
    const valid=validationExecute(validationEventBody(kind));
    assert.equal(valid.ctx.done,false);assert.equal(valid.ctx.firstFailedValidationPredicate,undefined);
    const body=validationEventBody(kind);body.target.exerciseId='SYNTHETIC_PRIVATE';body.subscriptionIds=[];
    assert.equal(validationExecute(body).ctx.firstFailedValidationPredicate,'EVENT_ID_SHAPE');
    body.target.exerciseId=validationUuid(6);
    assert.equal(validationExecute(body).ctx.firstFailedValidationPredicate,'SUBSCRIPTIONS_COUNT');
    body.subscriptionIds=[validationUuid(5),validationUuid(5)];
    assert.equal(validationExecute(body).ctx.firstFailedValidationPredicate,'SUBSCRIPTIONS_DUPLICATE');
  }
  const body={target:{targetKind:'EXISTING_GAME',gameId:'/SYNTHETIC_PRIVATE',startsAt:validationBody().target.startsAt,durationMinutes:90},subscriptionIds:[validationUuid(5)]};
  assert.equal(validationExecute(body).ctx.firstFailedValidationPredicate,'GAME_ID_SHAPE');
  body.target.gameId='game:fixture';assert.equal(validationExecute(body).ctx.done,false);
});
test('first failure and pre-auth ordering remain deterministic with several invalid fields',()=>{
  const body=validationBody();body.target.stationId=null;body.target.roomId=null;body.target.startsAt='bad';body.subscriptionIds=[];
  assert.equal(validationExecute(body).ctx.firstFailedValidationPredicate,'STATION_ID_SHAPE');
  body.extra=true;
  assert.equal(validationExecute(body,{authorization:''}).ctx.firstFailedValidationPredicate,'BODY_EXTRA_KEYS');
  delete body.extra;
  const auth=validationExecute(body,{authorization:''});
  assert.deepEqual(auth.msg.payload,{error:{code:'PRICE_PREVIEW_AUTH_REQUIRED'}});
  assert.equal(auth.refusals[0].firstFailedValidationPredicate,undefined);
  assert.equal(auth.refusals[0].validationFieldShape,undefined);
  assert.equal(validationExecute([{}],{authorization:''}).ctx.firstFailedValidationPredicate,'BODY_EXTRA_KEYS');
  assert.equal(validationExecute([]).ctx.error,'PRICE_PREVIEW_AUTH_REQUIRED');
});
test('first failed validation does not replay the clock or evaluate later guarded fields',()=>{
  const body=validationBody();body.target.durationMinutes='90';
  let clockReads=0;
  const start=Date.parse(body.target.startsAt);
  class MovingDate extends Date { static now(){return ++clockReads===1?start-1:start+1;} }
  const msg={payload:body,req:{headers:{authorization:'Bearer fixture'}}};
  new Function('msg','Date',validationEntry)(msg,MovingDate);
  assert.equal(clockReads,1);
  assert.equal(msg._subscriptionPricePreview.firstFailedValidationPredicate,'DURATION_ENUM');
  // The first missing station stops before later room/date fields can be read.
  const short=validationBody();short.target.stationId=null;
  Object.defineProperty(short.target,'roomId',{get(){return assert.fail('Later guard was evaluated');}});
  const early={payload:short,req:{headers:{authorization:'Bearer fixture'}}};
  new Function('msg',validationEntry)(early);
  assert.equal(early._subscriptionPricePreview.firstFailedValidationPredicate,'STATION_ID_SHAPE');
});
test('absent and failing observers cannot change validation or the refusal response',()=>{
  for(const mode of ['shared','missing','throwing','sink_throwing','get_throwing']){
    const body=validationBody();body.target.subServiceIds=[];
    const result=validationExecute(body,{mode});
    assert.equal(result.ctx.firstFailedValidationPredicate,'SERVICES_COUNT');
    assert.equal(result.msg.statusCode,400);
    assert.deepEqual(result.msg.payload,{error:{code:'PRICE_PREVIEW_REQUEST_INVALID'}});
    assert.equal(validationExecute(validationBody(),{mode}).ctx.done,false);
  }
});
test('validation diagnostic enums are rejected outside the exact server refusal and unknown values are bounded',()=>{
  const body=validationBody();body.target.roomId=null;
  const [base]=validationExecute(body).refusals;
  for(const patch of [{source:'browser'},{routeTemplate:'/lk/subscription-bookings'},{method:'GET'},
    {stage:'preview_entry'},{httpStatus:503},{code:'PRICE_PREVIEW_AUTH_REQUIRED'}]){
    const safe=sanitizeEvent({...base,...patch});
    assert.equal(safe.firstFailedValidationPredicate,undefined);assert.equal(safe.validationFieldShape,undefined);
  }
  const safe=sanitizeEvent({...base,firstFailedValidationPredicate:'SYNTHETIC_PRIVATE',validationFieldShape:'SYNTHETIC_PRIVATE'});
  assert.equal(safe.firstFailedValidationPredicate,'UNKNOWN');assert.equal(safe.validationFieldShape,'UNKNOWN');
  const old={...base};delete old.firstFailedValidationPredicate;delete old.validationFieldShape;
  assert.deepEqual(sanitizeEvent(old),old);
});

test('server names a proven date mismatch separately and keeps missing expiry generic', () => {
  for (const expirationDate of ['2099-11-15', undefined]) {
    const ctx = { step: 'next', startedAt: Date.now(), target: { startsAt: '2099-11-16T09:00:00+03:00', durationMinutes: 60 },
      pending: ['fixture-sub'], quotes: [], subscriptions: { 'fixture-sub': { status: 'ACTIVE', expirationDate, visitsLeft: 26 } },
      metadata: { 'fixture-sub': { productId: 'fixture-product' } }, catalog: { 'fixture-product': 'Fixture' } };
    const mocked = { isObj: bookingsCanonical.isObj, lk1LifecycleInstant: value => value ? Date.parse(value + 'T23:59:59.999+03:00') : null,
      preflightAvailability: { resolveSplitSubscriptionLifecycle: () => 'UNAVAILABLE' } };
    executeBookings({ _subscriptionPricePreview: ctx }, mocked, { get: () => null }, { log() {} });
    assert.equal(ctx.quotes[0].status, 'UNAVAILABLE'); assert.equal(ctx.quotes[0].amountMinor, null);
    assert.equal(ctx.quotes[0].reasonCode, expirationDate ? 'SUBSCRIPTION_DATE_NOT_COVERED' : 'SUBSCRIPTION_NOT_OWNED_OR_UNAVAILABLE');
  }
});
