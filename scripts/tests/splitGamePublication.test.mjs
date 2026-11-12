import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { normalizePublicationIntent, publicationPlan, publishConfirmedOperation, renderPublication } from '../lib/splitGamePublication.mjs';
import { composeSplitPublicationSources, buildSplitPublicationCandidate } from '../patch_split_game_publication.mjs';

const contract = fs.readFileSync(new URL('../nodered_game_publication_nodes/contract.js', import.meta.url), 'utf8');
const intent = () => ({ version: 1, settings: { isPrivate: true, ratingGame: false, minRating: null, maxRating: null },
  gameTitle: 'Fixture game', participantComment: 'Bring a racket', joinPrice: null,
  studioName: 'Fixture studio', roomName: 'Fixture court', gameFormat: 'doubles' });
function operation() {
  const c = { timeFrom: '2030-11-12T18:00:00+03:00', timeTo: '2030-11-12T19:00:00+03:00', maxClientsCount: 4, roomId: 'fixture-room', trainers: [], requirements: [] };
  const i = normalizePublicationIntent(intent());
  return { _id: 'fixture-operation-key', operationId: 'fixture-operation', tenantKey: 'fixture-tenant', actorClientId: 'fixture-actor',
    clientSubscriptionId: 'fixture-subscription', state: 'CONFIRMED', category: 'open_game',
    exerciseId: 'fixture-exercise', bookingId: 'fixture-booking', upstreamBookingId: 'fixture-booking', confirmedAt: '2030-11-12T10:00:00Z',
    lk1: { createPayload: c, target: { category: 'GAME', eventId: 'fixture-exercise', roomId: c.roomId, stationId: 'fixture-station', durationMinutes: 60, startsAt: c.timeFrom },
      decision: { benefit: { finalPriceMinor: 0 }, subscriptionVisitCount: 1 }, publication: { version: 1, state: 'PENDING', intent: i,
        intentJson: JSON.stringify(i), actorClientId: 'fixture-actor', actorPhone: '79990000000', tenantKey: 'fixture-tenant',
        operationId: 'fixture-operation', createPayloadJson: JSON.stringify(c) } } };
}
const get = (o, k) => k.split('.').reduce((v, p) => v?.[p], o);
function match(doc, query) { return Object.entries(query).every(([k, v]) => k === '$or'
  ? v.some(q => match(doc, q)) : Array.isArray(get(doc, k)) ? get(doc, k).includes(v) : get(doc, k) === v); }
function set(doc, k, v) { const path = k.split('.'); let o = doc; for (const p of path.slice(0, -1)) o = o[p] ??= {}; o[path.at(-1)] = structuredClone(v); }
class Memory {
  constructor(rows = []) { this.rows = structuredClone(rows); this.updates = 0; this.loseAck = false; }
  find(q) { return { limit: n => ({ toArray: async () => structuredClone(this.rows.filter(x => match(x, q)).slice(0, n)) }) }; }
  async findOne(q) { return structuredClone(this.rows.find(x => match(x, q)) ?? null); }
  async updateOne(q, change, options) {
    this.updates++; let row = this.rows.find(x => match(x, q));
    if (!row && options?.upsert) { row = structuredClone(change.$setOnInsert); this.rows.push(row); }
    if (!row) return { acknowledged: true, matchedCount: 0 };
    for (const [k, v] of Object.entries(change.$set || {})) set(row, k, v);
    if (this.loseAck) { this.loseAck = false; throw new Error('fixture lost acknowledgement'); }
    return { acknowledged: true, matchedCount: 1 };
  }
}
const harness = (o = operation()) => ({ operation: o, operations: new Memory([o]), games: new Memory(), apply: true });

test('confirmed booking publishes canonical private game without any HTTP/provider adapter', async () => {
  const h = harness(), result = await publishConfirmedOperation(h);
  assert.equal(result.state, 'PUBLISHED'); assert.equal(h.games.rows.length, 1);
  const g = h.games.rows[0]; assert.equal(g.booking.exerciseId, h.operation.exerciseId);
  assert.deepEqual(g.booking.bookingIds, [h.operation.bookingId]); assert.equal(g.settings.isPrivate, true);
  assert.equal(g.metadata.gameTitle, 'Fixture game'); assert.equal(g.organizer.id, h.operation.actorClientId);
  assert.equal(g.payment.paid, true); assert.ok(g.resultRosterSnapshot);
});
test('disconnect/restart and two workers converge on one insert and one stable game id', async () => {
  const h = harness(); const results = await Promise.all([publishConfirmedOperation(h), publishConfirmedOperation(h)]);
  assert.equal(h.games.rows.length, 1); assert.equal(results[0].gameId, results[1].gameId);
  await publishConfirmedOperation({ ...h, operation: structuredClone(h.operations.rows[0]) });
  assert.equal(h.games.rows.length, 1);
});
test('lost game write acknowledgement is recovered by exact readback', async () => {
  const h = harness(); h.games.loseAck = true;
  assert.equal((await publishConfirmedOperation(h)).state, 'PUBLISHED'); assert.equal(h.games.rows.length, 1);
});
test('lost operation ack retries publication only, never inserts another game', async () => {
  const h = harness(); h.operations.loseAck = true;
  await assert.rejects(publishConfirmedOperation(h));
  assert.equal(h.games.rows.length, 1);
  assert.equal((await publishConfirmedOperation({ ...h, operation: h.operations.rows[0] })).state, 'PUBLISHED');
  assert.equal(h.games.rows.length, 1);
});
test('unrelated/no-intent operations and dry-run do not write', async () => {
  const h = harness(); delete h.operation.lk1.publication;
  assert.equal((await publishConfirmedOperation(h)).state, 'IGNORED');
  const d = harness(); assert.equal((await publishConfirmedOperation({ ...d, apply: false })).state, 'DRY_RUN');
  assert.equal(d.games.updates + d.operations.updates, 0);
});
test('paid checkout, join/training, mismatched actor/tenant/target/intent fail closed', () => {
  for (const change of [o => o.lk1.decision.benefit.finalPriceMinor = 100, o => o.category = 'group_training',
    o => o.actorClientId = 'other', o => o.tenantKey = 'other', o => o.lk1.target.roomId = 'other',
    o => o.lk1.publication.intent.gameTitle = 'changed', o => o.lk1.checkout = {}, o => o.state = 'RELEASED']) {
    const o = operation(); change(o); assert.throws(() => publicationPlan(o), /PUBLICATION_/);
  }
});
test('forged identity/payment/roster/community fields cannot enter the snapshot', () => {
  for (const key of ['organizer', 'paid', 'resultRosterSnapshot', 'participants', 'communityIds', 'gameId', 'tenantKey'])
    assert.equal(normalizePublicationIntent({ ...intent(), [key]: 'forged' }), null);
});
test('an existing conflicting game is never overwritten', async () => {
  const h = harness(); const plan = publicationPlan(h.operation);
  h.games.rows.push({ ...renderPublication(plan), organizer: { id: 'someone-else' } });
  await assert.rejects(publishConfirmedOperation(h), /PUBLICATION_EXISTING_GAME_CONFLICT/);
  assert.equal(h.games.rows[0].organizer.id, 'someone-else'); assert.equal(h.operations.updates, 0);
});
test('a copied marker cannot attest changed privacy, payment, metadata or roster authority', async () => {
  for (const mutate of [g => g.settings.isPrivate = false, g => g.payment.paid = false,
    g => g.status = 'CANCELLED', g => g.metadata.gameTitle = 'changed',
    g => g.resultRosterSnapshot.allowedClientIds.push('someone-else'),
    g => g.participants.push({ id: 'someone-else', status: 'CONFIRMED' })]) {
    const h = harness(), game = renderPublication(publicationPlan(h.operation)); mutate(game); h.games.rows.push(game);
    await assert.rejects(publishConfirmedOperation(h), /PUBLICATION_EXISTING_GAME_CONFLICT/);
    assert.equal(h.operations.rows[0].lk1.publication.state, 'PENDING');
  }
});
test('published receipt remains unchanged across legitimate later game edits', async () => {
  const h = harness(); await publishConfirmedOperation(h);
  const receipt = structuredClone(h.operations.rows[0].lk1.publication);
  h.games.rows[0].settings.isPrivate = false;
  await publishConfirmedOperation({ ...h, operation: h.operations.rows[0] });
  assert.deepEqual(h.operations.rows[0].lk1.publication, receipt);
  assert.equal(h.games.rows[0].settings.isPrivate, false);
});
test('failed readback and changed durable operation never claim PUBLISHED', async () => {
  const h = harness(); h.games.findOne = async () => null;
  await assert.rejects(publishConfirmedOperation(h), /PUBLICATION_READBACK_FAILED/);
  assert.equal(h.operations.rows[0].lk1.publication.state, 'PENDING');
  const c = harness(); c.operations.rows[0].state = 'RELEASED';
  await assert.rejects(publishConfirmedOperation(c), /PUBLICATION_OPERATION_CHANGED/);
  assert.equal(c.games.rows.length, 0);
});
test('Node-RED snapshot binds only verified create context and replay must preserve intent', () => {
  const functions = new Function('Buffer', contract + '\nreturn { splitPublicationSnapshot, splitPublicationReplayMatches };')(Buffer);
  const o = operation(), ctx = { caller: 'split', managedAction: 'CREATE_GAME', lk1BeforeCreate: true,
    actorClientId: o.actorClientId, actorPhone: '79990000000', tenantKey: o.tenantKey, operationId: o.operationId,
    lk1CreatePayload: o.lk1.createPayload, lk1: o.lk1 };
  const split = { action: 'create', publicationEnabled: true, publicationIntent: intent() };
  const stored = functions.splitPublicationSnapshot(ctx, split); assert.ok(stored);
  assert.equal(functions.splitPublicationReplayMatches(stored, ctx, split), true);
  assert.equal(functions.splitPublicationReplayMatches(stored, ctx, { ...split, publicationIntent: { ...intent(), gameTitle: 'other' } }), false);
  for (const caller of ['http', 'split_create_readonly_preflight', 'training']) assert.equal(functions.splitPublicationSnapshot({ ...ctx, caller }, split), null);
  assert.equal(functions.splitPublicationSnapshot({ ...ctx, managedAction: 'JOIN_GAME' }, split), null);
  assert.equal(functions.splitPublicationSnapshot(ctx, { ...split, publicationEnabled: false }), null);
  assert.equal(functions.splitPublicationReplayMatches(stored, ctx, { ...split, publicationEnabled: false }), true);
});
test('source-driven adapter preserves Node-RED wiring and rejects missing/changed generation', () => {
  const read = file => fs.readFileSync(new URL('../' + file, import.meta.url), 'utf8');
  const hooks = read('nodered_lk1_hub_nodes/gateway_hooks.js');
  const history = hooks.split('// HUB_HISTORY')[1].split('// HUB_CONFIRMATION')[0];
  const exercise = hooks.split('// HUB_EXERCISE')[1].split('// HUB_RECHECK')[0];
  const preaccept = hooks.split('// HUB_PREACCEPT')[1].split('// HUB_BOOKING')[0];
  const sources = { prepare: read('nodered_games_nodes/fn_split_create_prepare.js'),
    gateway: read('nodered_lk1_hub_nodes/gateway.js') + '\n' + exercise + '\n' + history + '\n' + preaccept,
    finalize: read('nodered_lk1_hub_nodes/finalize.js'), router: read('nodered_games_nodes/fn_split_router.js') };
  const composed = composeSplitPublicationSources(sources);
  for (const s of Object.values(composed)) new Function('msg', 'node', 'global', 'env', s);
  assert.ok(composed.gateway.indexOf('ctx.lk1.publication = publication') > composed.gateway.indexOf('ctx.lk1.decision = JSON.parse(JSON.stringify(decision));'));
  assert.ok(composed.gateway.indexOf('ctx.lk1.publication = publication') < composed.gateway.indexOf('ctx.step = "operation_insert"'));
  assert.ok(composed.gateway.includes('GAME_PUBLICATION_INTENT_CHANGED'));
  assert.throws(() => composeSplitPublicationSources(composed), /generation/);
  assert.throws(() => composeSplitPublicationSources({ ...sources, prepare: '' }), /drift/);
  assert.throws(() => buildSplitPublicationCandidate([], {}), /preimage/);
  // Execute the real decision/insert step, starting before any decision is attached
  // to ctx.lk1. Capturing at quote creation would silently miss this publication.
  const begin = composed.gateway.indexOf('if (ctx.step === "lk1_policy_decision") {');
  const end = composed.gateway.indexOf('\nconst paymentRoute =', begin);
  const step = composed.gateway.slice(begin, end);
  const o = operation();
  const ctx = { step: 'lk1_policy_decision', caller: 'split', managedAction: 'CREATE_GAME', lk1BeforeCreate: true,
    operationKey: o._id, operationId: o.operationId, tenantKey: o.tenantKey, actorClientId: o.actorClientId,
    actorPhone: '79990000000', clientSubscriptionId: o.clientSubscriptionId, exerciseId: 'preflight:fixture',
    category: 'open_game', serviceDate: '2030-11-12', lk1CreatePayload: o.lk1.createPayload,
    lk1: { target: o.lk1.target, createPayload: o.lk1.createPayload } };
  const msg = { req: { destroyed: true }, _splitCtx: { action: 'create', publicationEnabled: true, publicationIntent: intent() },
    _managedSubscriptionPolicyDecision: { eligible: true, benefit: { finalPriceMinor: 0 }, subscriptionVisitCount: 1 } };
  const execute = new Function('msg', 'ctx', 'isObj', 'emit', 'OUTPUT_MONGO_INSERT', 'PREPARED_LEASE_MS', 'lk1Stop',
    contract + '\n' + step);
  execute(msg, ctx, value => !!value && typeof value === 'object', () => msg, 2, 60000, () => { throw new Error('unexpected refusal'); });
  assert.equal(msg.payload[0].state, 'PREPARED');
  assert.equal(msg.payload[0].lk1.publication.state, 'PENDING');
  assert.equal(msg.payload[0].lk1.publication.actorClientId, o.actorClientId);
  assert.equal(msg.payload[0].lk1.publication.intent.settings.isPrivate, true);
});
