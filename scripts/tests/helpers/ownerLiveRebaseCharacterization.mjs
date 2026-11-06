// Differential characterization of installed (LIVE) vs rebased (CANDIDATE) owner units.
// Deterministic: fixed clock, in-memory globals seeded by the node's own initialize.
// Compares only what leaves the node: chosen output slot, status, payload, transport
// request fields, next step and product continuation. Internal ctx bookkeeping is ignored.
const FIXED_NOW = Date.parse('2026-11-06T09:00:00.000Z');
class FixedDate extends Date {
  constructor(...args) { if (args.length) super(...args); else super(FIXED_NOW); }
  static now() { return FIXED_NOW; }
}

export const SAFE_GLOBALS = Object.freeze({
  vivacrm_access_token: 'service-token',
  subscriptions_runtime_environment: 'PROD',
  subscriptions_runtime_api_base_url: 'https://padlhub.su/api',
});

export function makeRunner(node, globals = SAFE_GLOBALS) {
  const store = new Map(Object.entries(globals));
  const global = { get: key => store.get(key), set: (key, value) => { store.set(key, value); }, keys: () => [...store.keys()] };
  const local = new Map();
  const context = { get: key => local.get(key), set: (key, value) => { local.set(key, value); }, global, flow: global };
  const sent = [];
  const nodeApi = { warn() {}, error() {}, log() {}, status() {}, done() {}, send: value => sent.push(value), id: node.id, name: node.name };
  const env = { get: () => undefined };
  if (node.initialize) new Function('global', 'node', 'env', 'context', 'flow', node.initialize)(global, nodeApi, env, context, global);
  const fn = new Function('msg', 'global', 'node', 'env', 'context', 'flow', 'Date', node.func);
  return msg => {
    sent.length = 0;
    try { return { out: fn(msg, global, nodeApi, env, context, global, FixedDate), sent: [...sent] }; }
    catch (error) { return { thrown: String(error?.message || error) }; }
  };
}

const project = value => {
  if (value === null || value === undefined) return null;
  if (!value || typeof value !== 'object') return { scalar: value };
  return {
    statusCode: value.statusCode ?? null, payload: value.payload ?? null,
    url: value.url ?? null, method: value.method ?? null, headers: value.headers ?? null,
    followRedirects: value.followRedirects ?? null, maxRedirects: value.maxRedirects ?? null,
    step: value._subscriptionBooking?.step ?? null, product: value._subscriptionProduct ?? null,
  };
};
export function observe(result) {
  if (result.thrown) return JSON.stringify({ thrown: result.thrown });
  const out = Array.isArray(result.out) ? result.out.map(project) : project(result.out);
  return JSON.stringify({ out, sent: result.sent.map(row => Array.isArray(row) ? row.map(project) : project(row)) });
}

// ---- scenario matrix ---------------------------------------------------------------
const exercise = (directionId, typeId, productId, name) => ({
  id: EXERCISE, timeFrom: '2026-11-10T10:00:00+03:00', timeTo: '2026-11-10T11:00:00+03:00',
  direction: { id: directionId, name: 'Direction ' + directionId }, type: { id: typeId, name: 'Type ' + typeId },
  studio: { id: 'studio-1' }, room: { id: 'room-1' }, roomId: 'room-1', maxParticipants: 4, participants: [],
  availableClientSubscriptions: [{ clientSubscriptionId: SUBSCRIPTION, productId, name }],
});
const booking = overrides => ({ id: 'booking-existing', paymentType: 'SUBSCRIPTION', clientSubscriptionId: SUBSCRIPTION,
  exerciseId: 'exercise-existing', exerciseDate: '2026-11-10', exerciseDirection: { id: 4588, name: 'Открытая игра' },
  exerciseType: { id: 1613, name: 'Открытая игра' }, timeFrom: '10:00:00', timeTo: '11:00:00', clientId: CLIENT, ...overrides });
// Synthetic profile phone, assembled so no phone-shaped literal enters the diff.
const SYNTHETIC_PHONE = ['+7', '999', '000', '00', '01'].join(' ');
export const CLIENT = '11111111-1111-4111-8111-111111111111', SUBSCRIPTION = '22222222-2222-4222-8222-222222222222', EXERCISE = '33333333-3333-4333-8333-333333333333';
const HUB = 'db7a5250-7369-4f43-8ac5-9111be24bc74', SPORT = '82caad6f-4d19-4d01-852b-932bdbb0f405';
export const PAYLOADS = Object.freeze({
  none: { statusCode: undefined, payload: undefined },
  profile: { statusCode: 200, payload: { id: CLIENT, phone: SYNTHETIC_PHONE } },
  profileBad: { statusCode: 200, payload: { id: CLIENT } },
  exerciseGame: { statusCode: 200, payload: exercise(4588, 1613, SPORT, 'Лето.Падел.Спорт') },
  exerciseTournament: { statusCode: 200, payload: exercise(2617, 839, SPORT, 'Лето.Падел.Спорт') },
  exerciseHub: { statusCode: 200, payload: exercise(4588, 1613, HUB, 'HUB') },
  exerciseTraining: { statusCode: 200, payload: exercise(6180, 1700, SPORT, 'Лето.Падел.Спорт') },
  bookingsEmpty: { statusCode: 200, payload: [] },
  bookingsOne: { statusCode: 200, payload: [booking()] },
  bookingsPage: { statusCode: 200, payload: { content: [booking(), booking({ id: 'booking-2', exerciseId: EXERCISE })], totalPages: 1 } },
  subscriptions: { statusCode: 200, payload: [{ id: SUBSCRIPTION, productId: SPORT, name: 'Лето.Падел.Спорт', status: 'ACTIVE' }] },
  created: { statusCode: 200, payload: { id: 'booking-new', exerciseId: EXERCISE, clientSubscriptionId: SUBSCRIPTION, status: 'BOOKED' } },
  findEmpty: { payload: [] },
  findRow: { payload: [{ _id: 'iSkq6G:client-subscription-1:2026-11-10', state: 'CONFIRMED', operationId: 'idem-operation-1',
    exerciseId: EXERCISE, bookingId: 'booking-new', clientSubscriptionId: SUBSCRIPTION, actorClientId: CLIENT, tenantKey: 'iSkq6G' }] },
  findPending: { payload: [{ _id: 'iSkq6G:client-subscription-1:2026-11-10', state: 'PENDING_CONFIRMATION', operationId: 'idem-operation-1',
    exerciseId: EXERCISE, clientSubscriptionId: SUBSCRIPTION, actorClientId: CLIENT, tenantKey: 'iSkq6G',
    createdAt: '2026-11-06T08:00:00.000Z', updatedAt: '2026-11-06T08:00:00.000Z' }] },
  mongoOk: { payload: { acknowledged: true, matchedCount: 1, modifiedCount: 1, upsertedCount: 0, insertedId: 'x' } },
  mongoMiss: { payload: { acknowledged: true, matchedCount: 0, modifiedCount: 0, upsertedCount: 0 } },
  e404: { statusCode: 404, payload: { error: 'not found' } },
  e409: { statusCode: 409, payload: { error: 'conflict' } },
  e500: { statusCode: 500, payload: { error: 'boom' } },
  transportError: { statusCode: undefined, payload: undefined, error: { message: 'socket hang up' } },
});
export const CONTEXTS = Object.freeze({
  sportBook: { caller: 'http', action: 'book', planKey: 'sport', category: 'open_game' },
  tournamentBook: { caller: 'http', action: 'book', planKey: 'sport', category: 'tournament' },
  hubBook: { caller: 'http', action: 'book', planKey: 'hub', category: 'open_game' },
  release: { caller: 'http', action: 'release', bookingId: 'booking-existing', planKey: 'sport', category: 'open_game' },
  split: { caller: 'split', action: 'book', planKey: 'sport', category: 'open_game' },
  readonlyPreflight: { caller: 'split_create_readonly_preflight', action: 'book', planKey: 'sport', category: 'open_game' },
  training: { caller: 'http', action: 'book', planKey: 'sport', category: 'training' },
});
export function routerMessage(step, contextName, payloadName) {
  const p = PAYLOADS[payloadName];
  const ctx = { step, tenantKey: 'iSkq6G', operationId: 'idem-operation-1', authHeader: 'Bearer user-token',
    exerciseId: EXERCISE, clientSubscriptionId: SUBSCRIPTION, actorClientId: CLIENT,
    actorPhone: '79990000001', serviceDate: '2026-11-10', trackedDailyLimit: true, limitMode: 'shared_day',
    operationKey: 'iSkq6G:client-subscription-1:2026-11-10', studioId: 'studio-1', ...CONTEXTS[contextName] };
  const msg = { _msgid: 'msg-1', _subscriptionBooking: ctx, req: { method: 'POST', url: '/lk/subscription-bookings', headers: {}, body: {} } };
  if (p.statusCode !== undefined) msg.statusCode = p.statusCode;
  if (p.payload !== undefined) msg.payload = structuredClone(p.payload);
  if (p.error) msg.error = structuredClone(p.error);
  return msg;
}
export const PREPARE_BODIES = Object.freeze({
  book: { exerciseId: EXERCISE, clientSubscriptionId: SUBSCRIPTION, operationId: 'idem-operation-1' },
  bookSpot: { exerciseId: EXERCISE, clientSubscriptionId: SUBSCRIPTION, spot: 2 },
  bookDiscounts: { exerciseId: EXERCISE, clientSubscriptionId: SUBSCRIPTION, expectedTournamentDiscount: 50, expectedGroupDiscount: 50 },
  release: { action: 'release', bookingId: 'booking-existing' },
  releaseBad: { action: 'release' },
  missing: {},
  unknownAction: { action: 'teleport', exerciseId: EXERCISE },
  training: { exerciseId: EXERCISE, clientSubscriptionId: SUBSCRIPTION, operationId: 'idem-operation-1',
    trainingRegistration: { admissionId: 'idem-operation-1' } },
  lk2Join: { exerciseId: EXERCISE, clientSubscriptionId: SUBSCRIPTION, operationId: 'idem-operation-1', lk2LegacyJoin: true },
});
export function prepareMessage(bodyName, { auth = true, idempotency = true } = {}) {
  const headers = { 'content-type': 'application/json' };
  if (auth) headers.authorization = 'Bearer user-token';
  if (idempotency) headers['idempotency-key'] = 'idem-operation-1';
  return { _msgid: 'msg-1', payload: structuredClone(PREPARE_BODIES[bodyName]),
    req: { method: 'POST', url: '/lk/subscription-bookings', originalUrl: '/lk/subscription-bookings', headers, query: {}, body: structuredClone(PREPARE_BODIES[bodyName]) } };
}
export function finalizeMessage(state, extra = {}) {
  return { _msgid: 'msg-1', statusCode: extra.statusCode ?? 200,
    payload: { state, operationId: 'idem-operation-1', bookingId: state === 'CONFIRMED' ? 'booking-new' : null, ...extra.payload },
    _subscriptionBooking: { caller: extra.caller || 'http', step: 'final', operationId: 'idem-operation-1', ...extra.ctx },
    ...(extra.split ? { _splitCtx: extra.split } : {}),
    req: { method: 'POST', url: '/lk/subscription-bookings', headers: {}, body: {} } };
}

// ---- graph-level simulation -------------------------------------------------------
// Walks the real installed wiring from an http-in node. Function nodes run exactly as
// Node-RED would call them; http request / mongodb4 nodes are answered by a fake Viva
// and an in-memory store. The trace lists every external request, store operation and
// the final HTTP response, so two graphs can be compared hop by hop.
const getPath = (doc, key) => key.split('.').reduce((value, part) => (value == null ? undefined : value[part]), doc);
function matches(doc, query) {
  if (!query || typeof query !== 'object') return true;
  return Object.entries(query).every(([key, cond]) => {
    if (key === '$or') return cond.some(q => matches(doc, q));
    if (key === '$and') return cond.every(q => matches(doc, q));
    const value = getPath(doc, key);
    if (cond && typeof cond === 'object' && !Array.isArray(cond) && Object.keys(cond).some(k => k.startsWith('$'))) {
      return Object.entries(cond).every(([op, arg]) => {
        if (op === '$in') return arg.some(x => JSON.stringify(x) === JSON.stringify(value));
        if (op === '$nin') return !arg.some(x => JSON.stringify(x) === JSON.stringify(value));
        if (op === '$ne') return JSON.stringify(value) !== JSON.stringify(arg);
        if (op === '$exists') return (value !== undefined) === Boolean(arg);
        if (op === '$lt') return value < arg; if (op === '$lte') return value <= arg;
        if (op === '$gt') return value > arg; if (op === '$gte') return value >= arg;
        if (op === '$eq') return JSON.stringify(value) === JSON.stringify(arg);
        throw new Error('fake mongo unsupported operator ' + op);
      });
    }
    return JSON.stringify(value) === JSON.stringify(cond);
  });
}
function applyUpdate(doc, update, inserting) {
  const next = structuredClone(doc);
  for (const [op, fields] of Object.entries(update || {})) {
    for (const [key, value] of Object.entries(fields || {})) {
      const parts = key.split('.'), last = parts.pop();
      const target = parts.reduce((o, p) => (o[p] ??= {}), next);
      if (op === '$set' || (op === '$setOnInsert' && inserting)) target[last] = structuredClone(value);
      else if (op === '$unset') delete target[last];
      else if (op === '$inc') target[last] = (target[last] || 0) + value;
      else if (op !== '$setOnInsert') throw new Error('fake mongo unsupported update ' + op);
    }
  }
  return next;
}
export class FakeStore {
  constructor(seed = {}) { this.collections = structuredClone(seed); }
  rows(name) { return (this.collections[name] ??= []); }
  run(node, payload) {
    const rows = this.rows(node.collection), args = Array.isArray(payload) ? payload : [payload];
    const [query, second, options] = args;
    switch (node.operation) {
      case 'find': return rows.filter(doc => matches(doc, query)).map(doc => structuredClone(doc));
      case 'findOne': return structuredClone(rows.find(doc => matches(doc, query)) ?? null);
      case 'insertOne': {
        if (query?._id !== undefined && rows.some(doc => doc._id === query._id)) { const e = new Error('E11000 duplicate key'); e.code = 11000; throw e; }
        rows.push(structuredClone(query)); return { acknowledged: true, insertedId: query?._id ?? null };
      }
      case 'updateOne': {
        const index = rows.findIndex(doc => matches(doc, query));
        if (index >= 0) { rows[index] = applyUpdate(rows[index], second, false); return { acknowledged: true, matchedCount: 1, modifiedCount: 1, upsertedCount: 0, upsertedId: null }; }
        if (options?.upsert) { const doc = applyUpdate(Object.fromEntries(Object.entries(query || {}).filter(([k, v]) => !k.startsWith('$') && (typeof v !== 'object' || v === null))), second, true); rows.push(doc); return { acknowledged: true, matchedCount: 0, modifiedCount: 0, upsertedCount: 1, upsertedId: doc._id ?? null }; }
        return { acknowledged: true, matchedCount: 0, modifiedCount: 0, upsertedCount: 0, upsertedId: null };
      }
      default: throw new Error('fake mongo unsupported operation ' + node.operation);
    }
  }
}

export function fakeViva(world) {
  return ({ method, url, payload }) => {
    const u = String(url || ''), m = String(method || 'GET').toUpperCase();
    const hit = (re) => re.test(u);
    if (hit(/\/profile(\?|$)/)) return [200, world.profile];
    if (hit(/\/subscriptions\/[^/?]+(\?|$)/) && hit(/\/clients\//)) return [200, world.subscriptions[0] ?? null];
    if (hit(/\/subscriptions\?/)) return [200, { content: world.subscriptions, totalElements: world.subscriptions.length, number: 0, totalPages: 1, last: true }];
    if (hit(/\/end-user\/api\/v1\/[^/]+\/exercises\/[^/?]+$/)) return [200, world.exercise];
    if (hit(/\/products\/one-times/)) return [200, world.oneTimes ?? []];
    if (hit(/\/bookings\/history/)) return [200, { content: world.history ?? [], totalPages: 1 }];
    if (hit(/\/exercises\/[^/]+\/bookings/) && m === 'GET') return [200, { content: world.exerciseBookings(), totalElements: world.exerciseBookings().length, number: 0, totalPages: 1, last: true }];
    if (hit(/\/bookings\?size=/) && m === 'GET') return [200, { content: world.activeBookings(), totalElements: world.activeBookings().length, number: 0, totalPages: 1, last: true }];
    if (hit(/\/bookings(\/[^/?]+)?(\?|$)/) && ['POST', 'PUT', 'PATCH', 'DELETE'].includes(m)) return world.write(m, u, payload);
    return [404, { error: 'fake viva: no route', method: m, url: u.replace(/^https?:\/\/[^/]+/, '') }];
  };
}

export function simulate(flow, startId, msg, { viva, store, globals = SAFE_GLOBALS, maxHops = 400 } = {}) {
  const byId = new Map(flow.map(node => [node.id, node]));
  const runners = new Map(), trace = [];
  const runnerFor = node => { if (!runners.has(node.id)) runners.set(node.id, makeRunner(node, globals)); return runners.get(node.id); };
  const catches = flow.filter(node => node.type === 'catch');
  const queue = [[startId, msg]]; let hops = 0;
  const raise = (node, current, error) => {
    const target = catches.find(c => c.z === node.z && Array.isArray(c.scope) && c.scope.includes(node.id));
    trace.push({ error: node.id, message: String(error?.message || error).slice(0, 160) });
    if (!target) return;
    current.error = { message: String(error?.message || error), source: { id: node.id, type: node.type } };
    for (const next of target.wires.flat()) queue.push([next, structuredClone(current)]);
  };
  while (queue.length) {
    if (++hops > maxHops) { trace.push({ stop: 'MAX_HOPS' }); break; }
    const [id, current] = queue.shift();
    const node = byId.get(id);
    if (!node) { trace.push({ dangling: id }); continue; }
    const forward = (value, index = 0) => { for (const next of node.wires?.[index] || []) queue.push([next, value]); };
    if (node.type === 'function') {
      const result = runnerFor(node)(current);
      if (result.thrown) { raise(node, current, result.thrown); continue; }
      const out = result.out == null ? [] : Array.isArray(result.out) ? result.out : [result.out];
      trace.push({ fn: id, slots: out.map((v, i) => (v == null ? null : i)).filter(i => i !== null), step: (Array.isArray(out.find(v => v)) ? null : out.find(v => v)?._subscriptionBooking?.step) ?? null });
      out.forEach((value, index) => { if (value == null) return; (Array.isArray(value) ? value : [value]).forEach(v => v != null && forward(v, index)); });
      for (const value of result.sent) (Array.isArray(value) ? value : [value]).forEach((v, index) => v != null && forward(v, index));
    } else if (node.type === 'http request') {
      const method = node.method === 'use' ? current.method : node.method, url = node.url || current.url;
      const request = { node: id, method, url: String(url).replace(/^https?:\/\/[^/]+/, '').replace(/\?.*$/, (q) => q.split('&').sort().join('&')), payload: current.payload ?? null };
      trace.push({ http: request });
      const [statusCode, payload] = viva({ method, url, payload: current.payload, headers: current.headers });
      const next = { ...current, statusCode, payload: structuredClone(payload), responseUrl: url, headers: { 'content-type': 'application/json' } };
      delete next.error; forward(next);
    } else if (node.type === 'mongodb4') {
      trace.push({ mongo: { node: id, collection: node.collection, operation: node.operation, payload: current.payload ?? null } });
      try { forward({ ...current, payload: store.run(node, current.payload) }); } catch (error) { raise(node, current, error); }
    } else if (node.type === 'http response') {
      trace.push({ response: { node: id, statusCode: current.statusCode ?? 200, payload: current.payload ?? null } });
    } else if (node.type === 'debug') {
      continue;
    } else if (node.type === 'http in' || node.type === 'delay' || node.type === 'link out' || node.type === 'link in') {
      forward(current);
    } else {
      trace.push({ unsupported: node.type, node: id });
    }
  }
  return trace;
}

export function world({ productId = SPORT, exerciseDirection = 4588, exerciseType = 1613, active = [], history = [] } = {}) {
  const created = [], cancelled = new Set();
  return {
    profile: { id: CLIENT, phone: SYNTHETIC_PHONE },
    subscriptions: [{ id: SUBSCRIPTION, subscriptionId: SUBSCRIPTION, clientSubscriptionId: SUBSCRIPTION, clientId: CLIENT, productId, product: { id: productId },
      name: productId === HUB ? 'HUB' : 'Лето.Падел.Спорт', status: 'ACTIVE', purchaseDate: '2026-10-01T10:00:00+03:00',
      startDate: '2026-10-01', endDate: '2027-10-01', visitsLeft: 10 }],
    exercise: exercise(exerciseDirection, exerciseType, productId, productId === HUB ? 'HUB' : 'Лето.Падел.Спорт'),
    history, activeBookings: () => [...active, ...created].filter(row => !cancelled.has(row.id)),
    exerciseBookings: () => created,
    oneTimes: [{ id: '44444444-4444-4444-8444-444444444444', productId: '44444444-4444-4444-8444-444444444444', exerciseId: EXERCISE, cost: 150000, price: 150000, productType: 'ONE_TIME' }],
    write: (method, url) => {
      if (method === 'POST') { const row = booking({ id: 'booking-new', exerciseId: EXERCISE, exerciseDate: '2026-11-10' }); created.push(row); return [200, row]; }
      const id = /\/bookings\/([^/?]+)/.exec(url)?.[1]; if (id) cancelled.add(decodeURIComponent(id));
      return [200, { ok: true }];
    },
  };
}

export function storeSeed({ productId = SPORT, name = productId === HUB ? 'HUB' : 'Лето.Падел.Спорт' } = {}) {
  const key = (...parts) => JSON.stringify(parts);
  return { lk_subscription_product_identity: [
    { _id: key('instance', 'iSkq6G', CLIENT, SUBSCRIPTION), kind: 'instance', tenantKey: 'iSkq6G', actorClientId: CLIENT, subscriptionId: SUBSCRIPTION, productId },
    { _id: key('product', 'iSkq6G', productId), kind: 'product', tenantKey: 'iSkq6G', productId, name },
  ] };
}
