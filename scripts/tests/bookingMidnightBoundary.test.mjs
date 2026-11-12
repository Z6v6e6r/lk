import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';
import ts from 'typescript';
import { createHash } from 'node:crypto';
import { composePreviewCrossDayRelease } from '../prepare_preview_cross_day_release.mjs';
import { patchSources } from '../patch_live_subscription_create_preflight.mjs';
import { extractSubscriptionPricePreviewSource } from '../lib/subscriptionPricePreviewSources.mjs';

const read = name => fs.readFileSync(new URL('../' + name, import.meta.url), 'utf8');
const routerSource = read('nodered_games_nodes/fn_split_router.js');
const prepareSource = read('nodered_games_nodes/fn_split_create_prepare.js');
const extract = (source, roots) => {
  const text = extractSubscriptionPricePreviewSource({ source, roots }).source;
  return new Function(text + ';return {' + roots.join(',') + '};')();
};
const { splitCreateEndDate, splitCreateDurationMinutes, extractConflictExerciseId } = extract(routerSource,
  ['splitCreateEndDate', 'splitCreateDurationMinutes', 'extractConflictExerciseId']);
const client = ts.transpileModule(read('../src/utils/bookingEndTime.ts').replace('export ', ''),
  { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText;
const endIso = new Function(client + ';return moscowBookingEndIso;')();
const dates = [['2099-09-21', '2099-09-22'], ['2099-09-30', '2099-10-01'],
  ['2099-12-31', '2100-01-01'], ['2104-02-28', '2104-02-29'], ['2104-02-29', '2104-03-01']];
const clocks = [['23:00', 60], ['22:30', 90], ['22:00', 120]];
const globals = { get: () => undefined, set() { assert.fail('No global writes in fixture'); } };
const env = { get: () => undefined };

test('legacy CREATE and client projection agree on midnight date, duration and service day', () => {
  const prepareHelper = extract(prepareSource, ['splitCreateEndDate']).splitCreateEndDate;
  for (const [date, nextDate] of dates) for (const [clock, duration] of clocks) for (const seconds of ['', ':00']) {
    const ctx = { date, fromTime: clock + seconds, toTime: '00:00' + seconds };
    assert.equal(splitCreateEndDate(ctx), nextDate);
    assert.equal(prepareHelper(ctx), nextDate);
    assert.equal(splitCreateDurationMinutes(ctx), duration);
    assert.equal(endIso(date, ctx.fromTime, ctx.toTime), nextDate + 'T00:00:00+03:00');
    assert.equal(ctx.date, date);
  }
  for (const [fromTime, toTime] of [['10:00', '11:30'], ['23:00', '00:00:01'], ['00:00', '00:00'], ['bad', '00:00']]) {
    assert.equal(splitCreateEndDate({ date: dates[0][0], fromTime, toTime }), dates[0][0]);
  }
  assert.equal(splitCreateDurationMinutes({ fromTime: '22:00', toTime: '00:00:01' }), null);
  assert.equal(splitCreateDurationMinutes({ fromTime: '23:00', toTime: '00:30' }), null);
  assert.equal(splitCreateDurationMinutes({ fromTime: '00:00', toTime: '00:00' }), null);
  assert.equal(endIso('2099-09-21', '10:00', '11:30'), '2099-09-21T11:30:00+03:00');
});

test('public split preparation carries a positive midnight interval before any provider write', () => {
  for (const [date, nextDate] of dates) for (const [fromTime, durationMinutes] of clocks) for (const seconds of ['', ':00']) {
    const msg = { req: { headers: {} }, payload: { date, fromTime: fromTime + seconds, toTime: '00:00' + seconds,
      roomId: 'synthetic-court', studioId: 'synthetic-studio', clientPhone: ['7', '999', '000', '00', '01'].join(''), paymentMode: 'one_time' } };
    const out = new Function('msg', 'global', 'env', prepareSource)(msg, globals, env);
    assert.equal(out[0].method, 'GET');
    assert.match(out[0].url, /split-payment-promo\?/);
    const ctx = out[0]._splitCtx;
    assert.equal(ctx.date, date);
    assert.equal(ctx.durationMinutes, durationMinutes);
    assert.equal(ctx.timeTo, nextDate + 'T00:00:00+03:00');
    assert.equal((Date.parse(ctx.timeTo) - Date.parse(ctx.timeFrom)) / 60000, durationMinutes);
  }
});

test('price stays on the original service date; sole CREATE has the next-day end and unchanged amounts', () => {
  for (const [date, nextDate] of dates) for (const [fromTime, durationMinutes] of clocks) {
    const ctx = { step: 'ordinary_price_subservices', action: 'create', paymentMode: 'one_time', token: 'synthetic-token',
      studioId: 'synthetic-studio', roomId: 'synthetic-court', verifiedStudioId: 'synthetic-studio', verifiedRoomId: 'synthetic-court',
      masterServiceId: 'synthetic-master', subServiceIds: ['synthetic-subservice'], userAuthHeader: 'Bearer synthetic-user',
      date, fromTime, toTime: '00:00', durationMinutes, shareCount: 4, maxClientsCount: 4 };
    const run = msg => new Function('msg', 'global', 'env', routerSource)(msg, globals, env);
    const request = run({ statusCode: 200, payload: [{ id: 'synthetic-subservice' }], _splitCtx: ctx })[0];
    assert.equal(request.method, 'GET');
    const query = new URL(request.url).searchParams;
    assert.equal(query.get('fromDate'), date);
    assert.equal(query.get('fromTime'), fromTime);
    assert.equal(query.get('toTime'), '00:00');
    assert.equal(query.has('toDate'), false);
    const create = run({ ...request, statusCode: 200, payload: { 'synthetic-subservice': { price: 8000 } } })[0];
    assert.equal(create.method, 'POST');
    assert.equal(create.url, 'https://api.vivacrm.ru/api/v1/exercises');
    assert.equal(create.payload.timeFrom, `${date}T${fromTime}+03:00`);
    assert.equal(create.payload.timeTo, `${nextDate}T00:00+03:00`);
    assert.equal((Date.parse(create.payload.timeTo) - Date.parse(create.payload.timeFrom)) / 60000, durationMinutes);
    assert.equal(create._splitCtx.totalAmount, 8000);
    assert.equal(create._splitCtx.shareAmount, 2000);
    assert.equal(create._splitCtx.date, date);
  }
});

test('conflict adoption requires the exact next-day interval and room; same-day midnight is refused', () => {
  for (const seconds of ['', ':00']) {
    const ctx = { date: '2099-12-31', fromTime: '22:00' + seconds, toTime: '00:00' + seconds, roomId: 'synthetic-court' };
    const exact = { conflictingExerciseId: 'synthetic-exercise', roomId: ctx.roomId,
      timeFrom: '2099-12-31T22:00:00+03:00', timeTo: '2100-01-01T00:00:00+03:00' };
    assert.equal(extractConflictExerciseId({ conflicts: [exact] }, ctx), 'synthetic-exercise');
    for (const change of [{ timeTo: '2099-12-31T00:00:00+03:00' }, { timeTo: '2100-01-01T00:00:01+03:00' },
      { roomId: 'other-court' }, { timeFrom: '2099-12-31T23:00:00+03:00' }]) {
      assert.equal(extractConflictExerciseId({ conflicts: [{ ...exact, ...change }] }, ctx), null);
    }
  }
});

test('prospective preflight and finalize retain exact binding at midnight without authorizing writes', () => {
  const ctx = { action: 'create', date: '2099-12-31', fromTime: '22:00', toTime: '00:00', roomId: 'synthetic-court',
    studioId: 'synthetic-studio', clientSubscriptionId: 'synthetic-subscription', operationId: 'synthetic-operation' };
  const start = read('nodered_subscription_create_preflight_nodes/split_start.js');
  const msg = { _splitCtx: ctx, req: { headers: { 'idempotency-key': ctx.operationId } } };
  const preflight = new Function('ctx', 'msg', 'splitCreateEndDate', 'resolveBookingPaymentType', 'toStr', 'toNumber',
    'SPLIT_DIRECTION_ID', 'SPLIT_EXERCISE_TYPE_ID', 'startSubscriptionBookingGateway', 'fail', start)(ctx, msg, splitCreateEndDate,
    () => 'SUBSCRIPTION', x => x, x => Number(x) || null, 4588, 1613,
    () => [null, null, null, { ...msg, _subscriptionBooking: { operationId: ctx.operationId, clientSubscriptionId: ctx.clientSubscriptionId } }],
    () => assert.fail('Unexpected preflight failure'))[3];
  const target = preflight._subscriptionBooking.prospectiveTarget;
  assert.equal(target.timeTo, '2100-01-01T00:00+03:00');
  assert.equal((Date.parse(target.timeTo) - Date.parse(target.timeFrom)) / 60000, 120);
  const finalize = read('nodered_subscription_create_preflight_nodes/finalize.js');
  const run = m => new Function('ctx', 'msg', 'payload', 'splitCreateEndDate', finalize)(m._subscriptionBooking, m, m.payload, splitCreateEndDate);
  const passed = { ...preflight, statusCode: 200, payload: { state: 'CREATE_PREFLIGHT_PASSED' } };
  const done = run(structuredClone(passed));
  assert.equal(done[0]._splitCtx.subscriptionCreatePreflightDone, true);
  assert.equal(done[0]._splitCtx.date, '2099-12-31');
  for (const mutate of [m => m._splitCtx.toTime = '00:30', m => m._splitCtx.date = '2100-01-01',
    m => m._subscriptionBooking.prospectiveTarget.timeTo = '2099-12-31T00:00+03:00',
    m => m._splitCtx.roomId = 'other-court', m => m._subscriptionBooking.operationId = 'other-operation']) {
    const candidate = structuredClone(passed); mutate(candidate);
    const refused = run(candidate);
    assert.equal(refused[0], null);
    assert.equal(refused[1].statusCode, 409);
    assert.equal(refused[1]._splitCtx.subscriptionCreatePreflightDone, undefined);
  }
});

// Evaluate the actual client functions with inert dependencies and no network.
const apiSource = ts.createSourceFile('apiClient.ts', read('../src/utils/apiClient.ts'), ts.ScriptTarget.ES2022, true);
function clientFunction(name, dependencies) {
  const statement = apiSource.statements.find(s => ts.isFunctionDeclaration(s) && s.name?.text === name);
  assert.ok(statement);
  const js = ts.transpileModule(statement.getText(apiSource).replace('export ', ''),
    { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText;
  return new Function(...Object.keys(dependencies), js + ';return ' + name + ';')(...Object.values(dependencies));
}
const params = { date: '2099-12-31', fromTime: '22:00', toTime: '00:00', studioId: 'synthetic-studio', roomId: 'synthetic-court',
  masterServiceId: 'synthetic-master', subServiceIds: ['synthetic-subservice'], clientId: 'synthetic-client', promoCode: 'SYNTHETIC' };
test('client promo, one-time filter and pay use a positive next-day interval without changing price parameters', async () => {
  const calls = [], prices = [];
  const request = async (url, options) => {
    calls.push({ url, options });
    return { status: 503, data: null, error: { message: 'synthetic refusal; no real request' } };
  };
  const deps = { moscowBookingEndIso: endIso, API_BASE: 'https://provider.invalid', TENANT_KEY: 'synthetic-tenant',
    SUCCESS_URL: 'https://return.invalid', ENABLE_MASTER_SERVICE_AUTO_DISCOVERY: false,
    masterServiceStudioPreferredSubServiceCache: new Map(), masterServiceStudioSubServicesCache: new Map(),
    bootstrapMasterService: async () => {}, uniqueIds: x => [...new Set(x)], request,
    apiFetchMasterServicePrice: async p => { prices.push(p); return { data: 8000, error: null }; } };
  const promo = await clientFunction('apiFetchMasterServicePromoDiscounts', deps)(params);
  assert.equal(promo.status, 503);
  const paid = await clientFunction('apiPayMasterService', deps)(params);
  assert.equal(paid.status, 503);
  assert.equal(prices.length, 1);
  assert.deepEqual([prices[0].date, prices[0].fromTime, prices[0].toTime], ['2099-12-31', '22:00', '00:00']);
  for (const call of calls.filter(c => new URL(c.url).pathname.endsWith('/promo/discounts'))) {
    assert.equal(new URL(call.url).searchParams.get('timeFrom'), '2099-12-31T22:00:00');
    assert.equal(new URL(call.url).searchParams.get('timeTo'), '2100-01-01T00:00:00');
  }
  const filter = calls.find(c => c.url.includes('/one-times/filter?'));
  assert.equal(new URL(filter.url).searchParams.get('exerciseEndDateTime'), '2100-01-01T00:00:00+03:00');
  const pay = calls.find(c => c.url.endsWith('/pay'));
  const body = JSON.parse(pay.options.body);
  assert.equal(body.timeFrom, '2099-12-31T22:00:00+03:00');
  assert.equal(body.timeTo, '2100-01-01T00:00:00+03:00');
  assert.equal(body.paymentMethod, 'WIDGET');
  assert.equal(Object.hasOwn(body, 'amount'), false);
  assert.equal(calls.filter(c => c.options.method === 'POST').length, 1);
});

const original350 = process.env.LK_MIDNIGHT_ORIGINAL350_SOURCE;
test('historical diagnostic-only PR350 composer preserves its original immutable function hash', {
  skip: !original350 && 'Requires original private PR350 source; never copied into Git',
}, () => {
  const packet = composePreviewCrossDayRelease(fs.readFileSync(original350), '20e8190ee862678a2c3f18f372b36375f8594346');
  const flow = JSON.parse(packet.candidateBytes);
  const router = flow.find(n => n.id === 'lk_subscription_price_preview_20260908_router');
  assert.equal(createHash('sha256').update(router.func).digest('hex'),
    '04bb2a51b9bd2ef1f171f7b92aa48a8a131288817f2b666e983e7d288bbf5fe5');
});

test('historical preflight composer carries a single midnight helper into both split and finalize', () => {
  const sources = { split: routerSource,
    gateway: read('nodered_subscription_booking_nodes/fn_subscription_booking_router.js'),
    finalize: read('nodered_subscription_booking_nodes/fn_subscription_booking_finalize.js') };
  // Also cover the original uncomposed generation which had no closing helper.
  for (const input of [sources, { ...sources, split: routerSource.replace(
    extractSubscriptionPricePreviewSource({ source: routerSource, roots: ['splitCreateEndDate'] }).source, '')
      .replace('timeTo: `${splitCreateEndDate(ctx)}T${ctx.toTime}+03:00`,', 'timeTo: `${ctx.date}T${ctx.toTime}+03:00`,')
      .replace('const targetEnd = `${splitCreateEndDate(ctx)}T${ctx.toTime}${ctx.toTime.length === 5 ? ":00" : ""}+03:00`;',
        'const targetEnd = `${ctx.date}T${ctx.toTime}:00+03:00`;') }]) {
    const patched = patchSources(input);
    const ctx = { action: 'create', step: 'ordinary_exact_price', paymentMode: 'one_time',
      date: '2099-12-31', fromTime: '22:00', toTime: '00:00', durationMinutes: 120,
      roomId: 'synthetic-court', studioId: 'synthetic-studio', verifiedRoomId: 'synthetic-court',
      verifiedStudioId: 'synthetic-studio', token: 'synthetic-token', subServiceIds: ['synthetic-subservice'] };
    const create = new Function('msg', 'global', 'env', patched.split)(
      { _splitCtx: ctx, statusCode: 200, payload: { 'synthetic-subservice': { price: 8000 } } }, globals, env)[0];
    assert.equal(create.method, 'POST');
    assert.equal(create.url, 'https://api.vivacrm.ru/api/v1/exercises');
    assert.equal(create.payload.timeTo, '2100-01-01T00:00+03:00');
    assert.equal((Date.parse(create.payload.timeTo) - Date.parse(create.payload.timeFrom)) / 60000, 120);
    const conflict = extract(patched.split, ['extractConflictExerciseId']).extractConflictExerciseId;
    const exact = { conflictingExerciseId: 'synthetic-exercise', roomId: ctx.roomId,
      timeFrom: '2099-12-31T22:00:00+03:00', timeTo: '2100-01-01T00:00:00+03:00' };
    assert.equal(conflict({ conflicts: [exact] }, ctx), 'synthetic-exercise');
    assert.equal(conflict({ conflicts: [{ ...exact, timeTo: '2099-12-31T00:00:00+03:00' }] }, ctx), null);
    for (const key of ['split', 'finalize']) {
      assert.equal(patched[key].split('const splitCreateEndDate =').length - 1, 1);
      const helper = extract(patched[key], ['splitCreateEndDate']).splitCreateEndDate;
      assert.equal(helper({ date: '2099-12-31', fromTime: '22:00', toTime: '00:00' }), '2100-01-01');
      new Function('msg', 'global', 'env', 'node', patched[key]);
    }
  }
});

test('preflight composer rejects unknown or duplicate closing endpoint anchors', () => {
  const sources = { split: routerSource,
    gateway: read('nodered_subscription_booking_nodes/fn_subscription_booking_router.js'),
    finalize: read('nodered_subscription_booking_nodes/fn_subscription_booking_finalize.js') };
  const post = 'timeTo: `${splitCreateEndDate(ctx)}T${ctx.toTime}+03:00`,';
  const conflict = 'const targetEnd = `${splitCreateEndDate(ctx)}T${ctx.toTime}${ctx.toTime.length === 5 ? ":00" : ""}+03:00`;';
  for (const split of [routerSource.replace(post, 'timeTo: unknownClosingEndpoint,'),
    routerSource + '\n// ' + post, routerSource.replace(conflict, 'const targetEnd = unknownClosingEndpoint;'),
    routerSource + '\n// timeTo: `${ctx.date}T${ctx.toTime}+03:00`,',
    routerSource + '\n// const targetEnd = `${ctx.date}T${ctx.toTime}:00+03:00`;']) {
    assert.throws(() => patchSources({ ...sources, split }), /closing endpoint anchor drift/);
  }
});
