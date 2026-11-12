import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';
import vm from 'node:vm';
import { createHash } from 'node:crypto';
import { createDiagnostics } from '../diagnostics/runtime.mjs';
import { previewEmptyTariffFacts } from '../diagnostics/preview-empty-tariffs.mjs';
import { sanitizeEvent } from '../../src/utils/errorDiagnosticsCore.mjs';
import { extractSubscriptionPricePreviewSource } from '../lib/subscriptionPricePreviewSources.mjs';
import { scopeSubscriptionEvaluator, scopeSubscriptionUsage } from '../lib/subscriptionInstanceLimitSources.mjs';
import { composeSubscriptionPricePreviewArtifacts, composeSubscriptionJoinPricePreviewArtifacts, composeSubscriptionPreviewServerTimeArtifacts, PATH } from '../patch_nodered_subscription_price_preview.mjs';

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
