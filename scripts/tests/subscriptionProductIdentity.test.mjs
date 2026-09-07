import ts from 'typescript';
import * as lifecycle from '../../src/components/games/splitSubscriptionAvailability.ts';
import { buildSubscriptionProductNginxCandidate, readSubscriptionProductLocation, sha256 } from '../nginx/patch_subscription_booking_proxy.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { randomUUID } from 'node:crypto';
import { composeSubscriptionProductIdentityArtifacts, GATEWAY_ID, PRODUCT_PATH, id } from '../patch_live_subscription_product_identity.mjs';
const dir = new URL('../nodered_subscription_product_nodes/', import.meta.url);
const source = name => fs.readFileSync(new URL(name + '.js', dir), 'utf8');
const execute = (name, msg, globals = {}) => new Function('msg', 'global', source(name))(msg, { get: key => globals[key] });
const actor = '00000000-0000-4000-8000-000000000001';
const sub = '00000000-0000-4000-8000-000000000002';
const sub2 = '00000000-0000-4000-8000-000000000003';
const product = '00000000-0000-4000-8000-000000000004';
const tenant = 'iSkq6G';
const auth = ['Bearer', 'fixture-user'].join(' ');
const key = (kind, ...parts) => JSON.stringify([kind, tenant, ...parts]);
const clone = v => structuredClone(v);
const request = (overrides = {}) => ({ _msgid: randomUUID(), _subscriptionProduct: {
  caller: 'name', step: 'start', tenantKey: tenant, subscriptionId: sub, authHeader: auth,
  requestId: randomUUID(), startedAt: Date.now(), ...overrides,
} });
function matches(row, query) {
  return Object.entries(query).every(([k, v]) => k === '$or' ? v.some(q => matches(row, q))
    : v && typeof v === 'object' ? ('$lte' in v ? row?.[k] <= v.$lte : '$exists' in v ? (row?.[k] !== undefined) === v.$exists : false)
    : row?.[k] === v);
}
function harness(options = {}) {
  const db = options.db || new Map(), calls = [], writes = [];
  const settings = { name: 'Fixture annual', owned: [sub, sub2], actor, ...options };
  function mongo(msg, output) {
    if (output === 1) return [...db.values()].filter(r => matches(r, msg.payload)).map(clone);
    const [query, change, opts] = clone(msg.payload); writes.push({ query, change, opts });
    assert.deepEqual(opts.writeConcern, { w: 'majority', j: true });
    if (settings.failWrite?.(query, change)) throw Object.assign(new Error('fixture'), { code: 1 });
    let row = [...db.values()].find(r => matches(r, query));
    const before = JSON.stringify(row);
    if (!row && opts.upsert) {
      if (db.has(query._id)) throw Object.assign(new Error('duplicate'), { code: 11000 });
      row = { _id: query._id, ...clone(change.$setOnInsert || {}), ...clone(change.$set || {}) };
      db.set(row._id, row);
      return { acknowledged: true, matchedCount: 0, modifiedCount: 0, upsertedCount: 1, upsertedId: row._id };
    }
    if (row) Object.assign(row, clone(change.$set || {}));
    return { acknowledged: true, matchedCount: row ? 1 : 0, modifiedCount: row && before !== JSON.stringify(row) ? 1 : 0, upsertedCount: 0, upsertedId: null };
  }
  async function run(msg) {
    for (let turns = 0; turns < 200; turns++) {
      const out = execute('router', msg, { vivacrm_access_token: settings.token === false ? null : 'fixture-service' });
      const index = out.findIndex(Boolean); assert.notEqual(index, -1); msg = out[index];
      if (index === 3) return msg;
      if (index === 4) { await new Promise(resolve => setTimeout(resolve, 1)); continue; }
      if (index === 0) {
        assert.equal(msg.method, 'GET'); assert.equal(msg.followRedirects, false);
        const url = new URL(msg.url); assert.equal(url.origin, 'https://api.vivacrm.ru');
        calls.push(url.pathname); msg.statusCode = 200;
        if (url.pathname.endsWith('/profile')) msg.payload = { id: settings.actor };
        else if (url.pathname.includes('/end-user/')) msg.payload = { content: settings.owned.map(subscriptionId => ({ subscriptionId, purchaseDate: '2026-09-05T06:40:00', status: 'ACTIVE', visitsLeft: 300, ...settings.ownedFields })), totalElements: settings.owned.length, ...settings.pagination };
        else {
          await new Promise(resolve => setTimeout(resolve, settings.adminDelay || 0));
          msg.payload = settings.detail || { subscriptionId: msg._subscriptionProduct.subscriptionId, product: { id: product, name: settings.name }, status: 'ACTIVE', visitsLeft: 300 };
          msg.statusCode = settings.adminStatus || 200;
        }
      } else {
        try { msg.payload = mongo(msg, index); delete msg.error; }
        catch (e) { msg.payload = null; msg.error = { code: e.code }; }
      }
    }
    throw new Error('unbounded state machine');
  }
  return { run, db, calls, writes, settings, adminCalls: () => calls.filter(p => !p.includes('/end-user/')).length };
}
test('miss saves minimal metadata; next login and restarted resolver make zero ADMIN reads', async () => {
  const h = harness(); let r = await h.run(request()); assert.equal(r.statusCode, 200); assert.equal(h.adminCalls(), 1);
  assert.equal(r.payload.sertName, 'Fixture annual'); assert.equal(r.headers, undefined);
  const instance = h.db.get(key('instance', actor, sub)); assert.deepEqual(Object.keys(instance).sort(), ['_id', 'actorClientId', 'kind', 'productId', 'subscriptionId', 'tenantKey']);
  const h2 = harness({ db: h.db }); r = await h2.run(request()); assert.equal(r.statusCode, 200); assert.equal(h2.adminCalls(), 0); assert.equal(h2.calls.length, 2);
  assert.ok([...h.db.values()].every(row => !('status' in row) && !('visitsLeft' in row) && !('purchaseDate' in row)));
});
test('new instance renames one catalog entry; all older instances read the new name', async () => {
  const h = harness(); await h.run(request()); h.settings.name = 'Renamed annual'; await h.run(request({ subscriptionId: sub2 }));
  const count = h.adminCalls(); const r = await h.run(request()); assert.equal(r.payload.sertName, 'Renamed annual'); assert.equal(h.adminCalls(), count);
  assert.equal([...h.db.values()].filter(r => r.kind === 'product').length, 1);
});
test('manual refresh changes catalog only, requires known product, and remains inaccessible from HTTP', async () => {
  const h = harness(); await h.run(request()); const before = clone(h.db.get(key('instance', actor, sub))); h.settings.name = 'Manual rename';
  const refresh = execute('refresh', { _msgid: randomUUID(), payload: product }); const r = await h.run(refresh);
  assert.equal(r.statusCode, 200); assert.deepEqual(h.db.get(key('instance', actor, sub)), before);
  assert.equal((await h.run(request())).payload.sertName, 'Manual rename');
  assert.equal(execute('refresh', { req: {}, payload: product }), null);
  assert.equal((await h.run(request({ caller: 'refresh', productId: randomUUID() }))).statusCode, 404);
});
test('cache does not authorize a former or different owner; phone and forged booking context are ignored', async () => {
  const h = harness(); await h.run(request()); h.settings.owned = [];
  assert.equal((await h.run(request())).statusCode, 403); assert.equal(h.adminCalls(), 1);
  const m = execute('entry', { _msgid: randomUUID(), req: { headers: { authorization: auth }, query: { subId: sub, phone: 'ignored', productId: product } }, _subscriptionBooking: { actorClientId: actor }, _subscriptionProduct: { caller: 'refresh' } });
  assert.equal(m._subscriptionProduct.caller, 'name'); assert.equal(m._subscriptionBooking, undefined); assert.equal(m._subscriptionProduct.productId, undefined);
  assert.equal((await h.run(request({ authHeader: '' }))).statusCode, 401);
  assert.equal((await h.run(request({ tenantKey: 'foreign' }))).payload.code, 'SUBSCRIPTION_PRODUCT_CONTEXT_INVALID');
});
test('incomplete ownership list, malformed provider identity and unresolved storage all fail closed', async () => {
  const cases = [
    { pagination: { totalElements: 999 } }, { pagination: { number: 1 } },
    { detail: { subscriptionId: sub2, product: { id: product, name: 'wrong instance' } } },
    { detail: { subscriptionId: sub, product: { id: '', name: 'missing product' } } },
    { failWrite: (_q, c) => c.$set?.kind === 'product' },
    { token: false }, { adminStatus: 500 },
  ];
  for (const options of cases) {
    const h = harness(options); const r = await h.run(request()); assert.equal(r.statusCode, 503);
    assert.equal(h.db.has(key('instance', actor, sub)), false);
    assert.ok([...h.db.values()].filter(r => r.kind === 'lock').every(r => r.owner === null));
  }
});
test('read-only CREATE preflight never calls ADMIN or writes cache, on either hit or miss', async () => {
  const h = harness();
  const input = () => ({ ...request({ caller: 'booking', actorClientId: actor }),
    _subscriptionBooking: { caller: 'split_create_readonly_preflight' } });
  const cold = await h.run(input()); assert.equal(cold.payload.code, 'SUBSCRIPTION_PRODUCT_NOT_READY');
  assert.equal(h.adminCalls(), 0); assert.equal(h.writes.length, 0);
  await h.run(request()); const writes = h.writes.length, reads = h.adminCalls();
  assert.equal((await h.run(input())).statusCode, 200);
  assert.equal(h.adminCalls(), reads); assert.equal(h.writes.length, writes);
});
test('same-instance cross-host misses are coalesced by persistent lease', async () => {
  const db = new Map(); const a = harness({ db, adminDelay: 5 }), b = harness({ db, adminDelay: 5 });
  const results = await Promise.all([a.run(request()), b.run(request())]);
  assert.deepEqual(results.map(r => r.statusCode), [200, 200]); assert.equal(a.adminCalls() + b.adminCalls(), 1);
});
test('older observation cannot overwrite a newer name across different instances', async () => {
  const db = new Map(); const slow = harness({ db, name: 'Old', adminDelay: 30 }), fast = harness({ db, name: 'New' });
  const first = slow.run(request()); await new Promise(resolve => setTimeout(resolve, 5));
  await fast.run(request({ subscriptionId: sub2 })); assert.equal((await first).payload.sertName, 'New');
});
test('refresh cannot remap an instance to another product; failed refresh retains catalog', async () => {
  const h = harness(); await h.run(request()); const before = clone(h.db.get(key('product', product)));
  h.settings.detail = { subscriptionId: sub, product: { id: randomUUID(), name: 'wrong' } };
  const r = await h.run(request({ caller: 'refresh', productId: product }));
  assert.equal(r.statusCode, 503); assert.deepEqual(h.db.get(key('product', product)), before);
  assert.equal(h.db.get(key('instance', actor, sub)).productId, product);
  assert.equal(h.db.get(key('instance', actor, sub)).invalid, true);
  assert.equal((await h.run(request())).statusCode, 503);
});
test('booking finish binds identity to server continuation and HTTP exposes name only', async () => {
  const h = harness(); const m = request({ caller: 'booking', actorClientId: actor });
  m._subscriptionBooking = { step: 'lk1_product_identity', actorClientId: actor, clientSubscriptionId: sub, tenantKey: tenant };
  const completed = await h.run(m); const forged = clone(completed);
  const r = execute('finish', completed); assert.equal(r[0]._subscriptionBooking.lk1ProductIdentity.productId, product);
  assert.equal(r[0]._subscriptionProduct, undefined);
  const name = execute('finish', await h.run(request())); assert.deepEqual(name[1].payload, { sertName: 'Fixture annual' });
  forged._subscriptionBooking.actorClientId = randomUUID(); assert.equal(execute('finish', forged), null);
});
test('policy projection uses verified product and fresh dates; conflicts fail closed and cannot enable entitlement', () => {
  const helpers = `const LK1_OVERLAY_HUB_PRODUCT_ID='db7a5250-7369-4f43-8ac5-9111be24bc74';const isObj=v=>v&&typeof v==='object'&&!Array.isArray(v);const normalizeId=v=>typeof v==='string'?v.toLowerCase():null;const normalizePurchaseDateMoscow=v=>typeof v==='string'&&/^\\d{4}-\\d{2}-\\d{2}/.test(v)?v.slice(0,10):null;const collectExactProductIds=v=>[v.productId,v.product?.id].filter(Boolean);`;
  const project = new Function('ctx', 'rows', helpers + source('gateway') + '; return identityOwned(ctx, rows);');
  const ctx = { actorClientId: actor, clientSubscriptionId: sub, tenantKey: tenant, lk1ProductIdentity: { actorClientId: actor, subscriptionId: sub, tenantKey: tenant, productId: product, name: 'Current', purchaseDate: '2026-09-05T06:40:00' } };
  const row = { subscriptionId: sub, visitsLeft: 7, status: 'REFUNDED' };
  assert.deepEqual(project(ctx, [row])[0], { ...row, productId: product, name: 'Current', product: { id: product, name: 'Current' }, purchaseDate: ctx.lk1ProductIdentity.purchaseDate });
  assert.deepEqual(project(ctx, []), []);
  for (const bad of [{ ...row, productId: randomUUID() }, { ...row, purchaseDate: '2026-08-25' }]) assert.deepEqual(project(ctx, [bad]), []);
  assert.deepEqual(project({ ...ctx, actorClientId: randomUUID() }, [row]), []);
});
const fixture = process.env.SUBSCRIPTION_PRODUCT_FLOW_FIXTURE;
test('retained exact flow composes atomically; source/wire/route drift rejected; manual refresh has no timer', { skip: !fixture }, () => {
  const bytes = fs.readFileSync(fixture), before = JSON.parse(bytes); const packet = composeSubscriptionProductIdentityArtifacts(bytes, 'fixture-product-identity');
  assert.equal(packet.contract.allowedChanges.length, 1); const gateway = packet.candidate.find(n => n.id === GATEWAY_ID);
  assert.equal(gateway.outputs, 8); assert.doesNotMatch(gateway.func, /get_sub_name|phone=/); new Function('msg', 'global', 'node', 'env', gateway.func);
  for (const n of packet.candidate.filter(n => n.type === 'function' && n.id.startsWith('lk_subscription_product_'))) new Function('msg', 'global', n.func);
  const inject = packet.candidate.find(n => n.id === id('inject')); assert.equal(inject.once, false); assert.equal(inject.repeat, ''); assert.equal(inject.crontab, '');
  for (const mutate of [ f => { f.find(n => n.id === GATEWAY_ID).func += ' '; }, f => { f.find(n => n.id === GATEWAY_ID).wires[0] = []; }, f => { f.push({ id: 'fixture-collision', type: 'http in', url: PRODUCT_PATH }); } ]) {
    const f = clone(before); mutate(f); assert.throws(() => composeSubscriptionProductIdentityArtifacts(Buffer.from(JSON.stringify(f)), 'fixture-drift'));
  }
});

test('current product aliases cannot be hidden by a warm cache, including read-only preflight', async () => {
  const h = harness(); await h.run(request());
  const other = '00000000-0000-4000-8000-000000000099';
  for (const fields of [{ productId: other }, { subscriptionProductId: other }, { templateId: other },
    { product: { id: other } }, { template: { uuid: other } }, { subscription: { product: { id: other } } },
    { productId: product, product: { id: other } }, { productId: 1 }]) {
    h.settings.ownedFields = fields;
    const writes = h.writes.length, admin = h.adminCalls();
    const r = await h.run({ ...request({ caller: 'booking', actorClientId: actor }), _subscriptionBooking: { caller: 'split_create_readonly_preflight' } });
    assert.equal(r.statusCode, 503); assert.equal(r.payload.code, 'SUBSCRIPTION_PRODUCT_CURRENT_IDENTITY_CONFLICT');
    assert.equal(h.writes.length, writes); assert.equal(h.adminCalls(), admin);
  }
});
test('a lost lease cannot produce a success acknowledgement', () => {
  const msg = request({ step: 'released' }); msg.payload = { acknowledged: true, matchedCount: 0, modifiedCount: 0, upsertedCount: 0, upsertedId: null };
  const out = execute('router', msg); assert.equal(out[3].statusCode, 503);
  assert.equal(out[3].payload.code, 'SUBSCRIPTION_PRODUCT_LEASE_RELEASE_UNKNOWN');
});
test('HUB lifecycle keeps NEW first use and rejects refunded, hold, expired, unknown or empty fresh balance', () => {
  const helpers = `const LK1_OVERLAY_HUB_PRODUCT_ID='db7a5250-7369-4f43-8ac5-9111be24bc74';const isObj=v=>v&&typeof v==='object'&&!Array.isArray(v);const normalizeId=v=>typeof v==='string'?v.toLowerCase():null;const normalizePurchaseDateMoscow=v=>typeof v==='string'&&/^\\d{4}-\\d{2}-\\d{2}/.test(v)?v.slice(0,10):null;const collectExactProductIds=v=>[v.productId,v.subscriptionProductId,v.product?.id].filter(Boolean);const eventDate=e=>e.date;`;
  const project = new Function('ctx', 'rows', 'exercise', 'preflightAvailability', helpers + source('gateway') + '; return identityOwned(ctx, rows, exercise);');
  const owned = { subscriptionId: sub, purchaseDate: '2026-09-05', status: 'NEW', activationDate: null, visitsLeft: 1, variant: 'BY_VISITS' };
  const proof = { actorClientId: actor, subscriptionId: sub, tenantKey: tenant, productId: 'db7a5250-7369-4f43-8ac5-9111be24bc74', name: 'HUB', purchaseDate: owned.purchaseDate, subscription: owned };
  const ctx = { actorClientId: actor, clientSubscriptionId: sub, tenantKey: tenant, lk1ProductIdentity: proof };
  const row = { subscriptionId: sub, visitsLeft: 999, status: 'ACTIVE' };
  const run = current => project({ ...ctx, lk1ProductIdentity: { ...proof, subscription: current } }, [row], { date: '2026-09-21' }, lifecycle);
  assert.equal(run(owned).length, 1); assert.equal(run(owned)[0].visitsLeft, 1);
  const active = { ...owned, status: 'ACTIVE', activationDate: '2026-09-07', expirationDate: '2027-09-07' };
  assert.equal(run(active).length, 1);
  for (const value of ['REFUNDED', 'HOLD', 'EXPIRED', 'NO_VISITS', 'UNKNOWN']) assert.equal(run({ ...active, status: value }).length, 0);
  for (const value of [0, null, undefined, '1', NaN]) assert.equal(run({ ...active, visitsLeft: value }).length, 0);
  for (const current of [{ ...owned, activationDate: '2026-09-07' }, { ...active, expirationDate: '2026-09-01' }, { ...active, productId: product }, { ...active, holdUntil: '2026-10-01' }]) assert.equal(run(current).length, 0);
});
test('new nginx route uses existing SHA guard and backup; existing booking route is preserved', () => {
  const original = 'server {\n    location = /lk/subscription-bookings { return 401; }\n    location ^~ /lk/ {\n        alias /var/www/html/lk/;\n    }\n}\n';
  const built = buildSubscriptionProductNginxCandidate(original, sha256(original));
  assert.ok(built.candidate.includes('location = /lk/subscription-bookings { return 401; }'));
  const fragment = readSubscriptionProductLocation(); assert.ok(built.candidate.includes(fragment));
  assert.match(fragment, /GET, OPTIONS/); assert.match(fragment, /request_method != GET/); assert.match(fragment, /limit_req_status 429/);
  assert.equal(buildSubscriptionProductNginxCandidate(built.candidate, built.candidateSha).changed, false);
  assert.throws(() => buildSubscriptionProductNginxCandidate(original, 'wrong'));
  assert.throws(() => buildSubscriptionProductNginxCandidate(original.replace('    location ^~', '    location = /lk/subscriptions/product { return 404; }\n    location ^~'), sha256(original)));
});
test('frontend product lookup is authenticated, bounded, sequential and does not retry 401/403/429', async () => {
  const file = fs.readFileSync(new URL('../../src/utils/apiClient.ts', import.meta.url), 'utf8');
  const body = file.slice(file.indexOf('export async function apiFetchSubscriptioName('), file.indexOf('\nexport async function apiBuySubscroption('));
  const js = ts.transpileModule(body.replace('export ', ''), { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText;
  const run = async statuses => {
    const calls = []; const controller = new AbortController();
    const raw = async (path, options) => { calls.push({ path, options }); return { data: null, error: null, status: statuses.shift() }; };
    const lookup = new Function('resolveLkApiBaseUrlCandidates', 'SERV2', 'SERV2_FALLBACK', 'runWithAbortTimeout', 'rawRequest', 'getServ2Origin', 'isRequestTimeoutError', js + '; return apiFetchSubscriptioName;')(
      () => ['https://primary.invalid', 'https://reserve.invalid'], '', '', async (ms, fn) => { assert.equal(ms, 35000); return fn(controller.signal); }, raw, () => '', () => false);
    const result = await lookup(sub, 'ignored'); return { calls, result };
  };
  for (const status of [200, 401, 403, 404, 429]) { const r = await run([status, 200]); assert.equal(r.calls.length, 1); assert.equal(r.result.status, status); }
  const r = await run([503, 200]); assert.equal(r.calls.length, 2); assert.equal(r.calls[1].options.baseUrl, 'https://reserve.invalid');
  for (const call of r.calls) { assert.equal(call.options.auth, true); assert.equal(call.options.signal instanceof AbortSignal, true); assert.doesNotMatch(call.path, /phone=/); assert.equal(call.options.retries, undefined); }
});
test('connected deployed gateway: missing product ID is resolved; final fresh lifecycle stops provider writes', { skip: !fixture }, () => {
  const packet = composeSubscriptionProductIdentityArtifacts(fs.readFileSync(fixture), 'fixture-connected');
  const code = packet.candidate.find(n => n.id === GATEWAY_ID).func;
  const policy = { productId: 'db7a5250-7369-4f43-8ac5-9111be24bc74', maxActiveBookings: 4, freeGameMinutesPerDay: 60, gameOverageDiscountPercent: 30, groupTrainingDiscountPercent: 50, tournamentDiscountPercent: 50 };
  const globals = { get: k => k === 'subscriptions_lk1_product_policy' ? policy : k === 'vivacrm_access_token' ? 'fixture-service' : undefined };
  const invoke = msg => new Function('msg','global','node','env',code)(msg,globals,{warn(){},error(){}},{get(){}});
  const from = new Date(Date.now()+86400000).toISOString(), to = new Date(Date.parse(from)+90*60000).toISOString();
  const own = { subscriptionId: sub, status: 'NEW', activationDate: null, expirationDate: null, purchaseDate: '2026-09-05', visitsLeft: 1, variant: 'BY_VISITS' };
  const exercise = { id: 'fixture-exercise', timeFrom: from, timeTo: to, direction: {id:4588}, type:{id:1613}, studio:{id:'fixture-studio'}, roomId:'fixture-room', availableClientSubscriptions:[{subscriptionId:sub}] };
  const ctx = { caller:'split',step:'exercise',action:'book',tenantKey:tenant,actorClientId:actor,clientSubscriptionId:sub,authHeader:auth,exerciseId:exercise.id,operationId:'fixture-operation-0001',managedAction:'JOIN_GAME',
    lk1ProductIdentity:{ actorClientId:actor,subscriptionId:sub,tenantKey:tenant,productId:policy.productId,name:'HUB',purchaseDate:own.purchaseDate,subscription:own },
    lk1TariffProof:{source:'VIVA_EXISTING_TARIFF',amountMinor:150000,stationId:'fixture-studio',roomId:'fixture-room',durationMinutes:90,startsAt:from,observedAt:Date.now()} };
  const msg = { _msgid:randomUUID(),_subscriptionBooking:clone(ctx),statusCode:200,payload:exercise };
  const first = invoke(msg);
  assert.ok(first[1], JSON.stringify(first.filter(Boolean).map(v=>v.payload)));
  assert.equal(first[1]._subscriptionBooking.lk1.rule.productId, policy.productId);
  const confirmedContext = clone(first[1]._subscriptionBooking);
  confirmedContext.lk1.decision={subscriptionVisitCount:1}; confirmedContext.subscriptionVisitCount=1;
  for (const change of [{ status:'NEW',activationDate:null,expirationDate:null }, {status:'ACTIVE',activationDate:from.slice(0,10),expirationDate:'2099-01-01'},
    {status:'REFUNDED'},{status:'HOLD'},{status:'EXPIRED'},{visitsLeft:0},{productId:product}]) {
    const context=clone(confirmedContext); context.step='exercise_recheck';
    let out=invoke({_subscriptionBooking:context,statusCode:200,payload:clone(exercise)});
    assert.equal(out[0].method,'GET'); assert.match(out[0].url,/\/subscriptions\?/);
    const row={...own,...change};
    out=invoke({...out[0],statusCode:200,payload:{content:[row],totalElements:1}});
    const pass = change.status==='NEW'||change.status==='ACTIVE';
    if(pass) { assert.equal(out[0]?.method,'POST', JSON.stringify(out.filter(Boolean).map(v=>v.payload))); assert.match(out[0].url,/\/bookings/); }
    else { assert.equal(out[0],null); assert.equal(out[4]?.payload.state,'PENDING_CONFIRMATION'); }
  }
});
test('connected direct GT/tournament preserves NEW first use and rejects fresh unusable subscriptions', { skip: !fixture }, () => {
  const packet = composeSubscriptionProductIdentityArtifacts(fs.readFileSync(fixture), 'fixture-money');
  const code = packet.candidate.find(n => n.id === GATEWAY_ID).func;
  const policy = { productId: 'db7a5250-7369-4f43-8ac5-9111be24bc74', maxActiveBookings: 4, freeGameMinutesPerDay: 60, gameOverageDiscountPercent: 30, groupTrainingDiscountPercent: 50, tournamentDiscountPercent: 50 };
  const globals = { get: k => k === 'subscriptions_lk1_product_policy' ? policy : k === 'vivacrm_access_token' ? 'fixture-service' : undefined };
  const invoke = msg => new Function('msg','global','node','env',code)(msg,globals,{warn(){},error(){}},{get(){}});
  const from=new Date(Date.now()+86400000).toISOString(), to=new Date(Date.parse(from)+90*60000).toISOString();
  for (const typeId of [605,839]) for (const change of [{status:'NEW'}, {status:'REFUNDED'}, {status:'HOLD'}, {status:'NEW',visitsLeft:0}, {status:'NEW',activationDate:'2026-09-07'}]) {
    const own={subscriptionId:sub,status:'NEW',activationDate:null,expirationDate:null,purchaseDate:'2026-09-05',visitsLeft:1,variant:'BY_VISITS',...change};
    const exercise={id:'fixture-money-event',timeFrom:from,timeTo:to,type:{id:typeId},direction:{id:2617},studio:{id:'fixture-studio'},roomId:'fixture-room',availableClientSubscriptions:[{subscriptionId:sub}]};
    if(typeId===605)exercise.direction.id=999;
    const ctx={caller:'http',step:'lk1_money_owned_subscriptions',action:'book',tenantKey:tenant,actorClientId:actor,clientSubscriptionId:sub,authHeader:auth,exerciseId:exercise.id,operationId:'fixture-operation-money',managedAction:typeId===605?'BOOK_GROUP_TRAINING':'BOOK_TOURNAMENT',lk1MoneyExercise:exercise,lk1MoneyReturnStep:'exercise',
      lk1ProductIdentity:{actorClientId:actor,subscriptionId:sub,tenantKey:tenant,productId:policy.productId,name:'HUB',purchaseDate:own.purchaseDate,subscription:own},
      lk1TariffProof:{source:'VIVA_EXISTING_TARIFF',amountMinor:150000,stationId:'fixture-studio',roomId:'fixture-room',durationMinutes:90,startsAt:from,observedAt:Date.now()}};
    const out=invoke({_subscriptionBooking:ctx,statusCode:200,payload:{content:[own],totalElements:1}});
    if(change.status==='NEW'&&!('visitsLeft'in change)&&!change.activationDate)assert.ok(out[1],JSON.stringify(out.filter(Boolean).map(v=>v.payload)));
    else {assert.equal(out[0],null);assert.equal(out[1],null);assert.ok(out[4]);}
  }
});
