import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { createGamePrivateProjection } from '../lib/gamePrivateProjection.mjs';
import { patchGamePrivateProjectionFlow, PREIMAGES, sha256 } from '../prepare_game_private_projection_candidate.mjs';
import { originalFunctions, candidateFunctions, fixture, getPublic, ids, phone, prepare, acknowledge, applyFixtureUpdate } from './helpers/gamePrivateProjectionFixture.mjs';

const projection = createGamePrivateProjection();
const clone = structuredClone;
const publicBody = game => { const view = getPublic(game); return { expectedUpdatedAt: view.updatedAt, participants: view.participants, waitlist: view.waitlist, metadata: view.metadata }; };

test('reconstructs the exact installed function preimages without customer fixtures', () => {
  for (const [id, source] of Object.entries(originalFunctions())) assert.equal(sha256(source), PREIMAGES[id]);
});
test('reproduces the actual privacy GET -> organizer echo -> authority 409', () => {
  const game = fixture(), view = getPublic(game);
  assert.equal(view.organizer.phone, undefined);
  const result = prepare(game, { ...publicBody(game), organizer: { ...view.organizer, phone: null } }, originalFunctions());
  assert.equal(result.write, null);
  assert.equal(result.response.payload.code, 'ORGANIZER_COMMAND_REQUIRED');
});
test('new ordinary PATCH retains canonical private identities, indexes, payment URL and snapshot organizer', () => {
  const game = fixture(), before = clone(game), body = publicBody(game);
  body.participants.push({ id: ids.actor, name: 'Actor fixture', phone: phone(4), status: 'CONFIRMED' });
  body.metadata.bookingIds.push('confirmed-actor-booking');
  body.metadata.splitPayment.payments.push({ role: 'PARTICIPANT', status: 'PAID', clientId: ids.actor, bookingId: 'confirmed-actor-booking', phone: phone(4), amount: 0, amountMinor: 0 });
  const { write } = prepare(game, body);
  assert.ok(write);
  assert.deepEqual(game, before, 'preimage must not be mutated while preparing');
  assert.equal(write.payload.$set['organizer.id'], undefined);
  assert.equal(write.payload.$set['organizer.phone'], undefined);
  assert.equal(write.payload.$set.participants.find(r => r.id === ids.player).phone, phone(2));
  assert.equal(write.payload.$set.waitlist[0].phone, phone(3));
  assert.deepEqual(write.payload.$set.metadata.bookingIds, ['existing-booking', 'confirmed-actor-booking']);
  assert.equal(write.payload.$set.metadata.splitPayment.payments[0].phone, phone(2));
  assert.equal(write.payload.$set.metadata.splitPayment.payments[0].paymentUrl, before.metadata.splitPayment.payments[0].paymentUrl);
  assert.equal(write.payload.$set.metadata.splitPayment.payments[1].clientId, ids.actor);
  assert.equal(write.payload.$set.resultRosterSnapshot.organizer.clientId, ids.organizer);
  assert.equal(write.payload.$set.resultRosterSnapshot.organizer.phoneNorm, phone(1));
  for (const n of [1, 2, 3, 4, 5]) assert.ok(write.payload.$set.allRelatedPhones.includes(phone(n)));
  assert.deepEqual(write.payload.$set.invitedPhones, [phone(5)]);
  assert.deepEqual(write.payload.$set.metadata.allRelatedPhones, write.payload.$set.allRelatedPhones);
  assert.equal(write.query.updatedAt, before.updatedAt);
  assert.deepEqual(write.query.organizer, before.organizer);
  assert.deepEqual(write.query.membershipMutation, { $exists: false });
  const [reply, followup] = acknowledge(write);
  assert.equal(reply.statusCode, 200);
  for (const n of [1, 2, 3, 4, 5]) assert.ok(!JSON.stringify(reply.payload).includes(phone(n)));
  assert.equal(followup._gameAutojoinPatch.patch.metadata.splitPayment.payments[0].phone, phone(2));
  assert.deepEqual(reply.payload, getPublic({ ...write._organizerPatchResponse, updatedAt: write._organizerPatchResponse.updatedAt }));
});
test('promotion across waitlist/participants keeps canonical phone without restoring a removed member', () => {
  const game = fixture(), body = publicBody(game);
  body.participants = [body.participants[0], { ...body.waitlist[0], status: 'CONFIRMED' }];
  body.waitlist = [];
  body.metadata.splitPayment.payments = [];
  const { write } = prepare(game, body);
  assert.ok(write);
  assert.equal(write.payload.$set.participants.find(r => r.id === ids.waiting).phone, phone(3));
  assert.equal(write.payload.$set.participants.some(r => r.id === ids.player), false);
  assert.equal(write.payload.$set.allRelatedPhones.includes(phone(2)), false);
  assert.deepEqual(write.payload.$set.waitlist, []);
});
test('reordered payment entries restore by booking and actor rather than array position', () => {
  const canonical = [{ clientId: ids.player, bookingId: 'one', phone: phone(2) }, { clientId: ids.waiting, bookingId: 'two', phone: phone(3) }];
  const result = projection.restore(projection.project([...canonical].reverse()), canonical);
  assert.equal(result[0].phone, phone(3)); assert.equal(result[1].phone, phone(2));
  assert.throws(() => projection.restore([{ clientId: ids.waiting, bookingId: 'one' }], canonical), /PRIVATE_BINDING_UNKNOWN/);
  assert.deepEqual(projection.restore([{ clientId: ids.player, bookingId: 'new' }], canonical), [{ clientId: ids.player, bookingId: 'new' }]);
});
test('duplicate stable identities and indistinguishable phone-only identities refuse without write', () => {
  const game = fixture(); game.participants.push({ ...game.participants[1], phone: phone(8) });
  const result = prepare(game, publicBody(game));
  assert.equal(result.write, null); assert.equal(result.response.payload.code, 'GAME_PATCH_PRIVATE_BINDING_UNKNOWN');
  assert.throws(() => projection.restoreRoster([{ name: 'Same fixture' }], [{ name: 'Same fixture', phone: phone(1) }, { name: 'Same fixture', phone: phone(2) }]), /PRIVATE_BINDING_UNKNOWN/);
});
test('unmodified phone-only legacy row uses exact public projection, never name-only or position fallback', () => {
  const canonical = [{ name: 'Legacy fixture', phone: phone(2), status: 'CONFIRMED' }];
  assert.equal(projection.restoreRoster(projection.project(canonical), canonical)[0].phone, phone(2));
  assert.throws(() => projection.restoreRoster([{ name: 'Renamed fixture' }], canonical), /PRIVATE_BINDING_UNKNOWN/);
});
test('the projector agrees with public GET for UUID spans, nested phone fields and URLs', () => {
  const game = fixture(); game.metadata.url = 'https://fixture.invalid/?phone=' + phone(1);
  game.metadata.uuid = '00000000-0000-4000-8000-000000000099';
  assert.deepEqual(projection.project(game), getPublic(game));
  assert.equal(projection.project(game).metadata.uuid, game.metadata.uuid);
  assert.equal(projection.restore(projection.project(game.metadata), game.metadata).url, game.metadata.url);
  assert.equal(projection.restore({ ...projection.project(game.metadata), url: 'https://fixture.invalid/changed' }, game.metadata).url, 'https://fixture.invalid/changed');
});
for (const change of [
  (g, b) => { b.organizer = { ...g.organizer, id: ids.actor }; },
  (g, b) => { b.organizer = { ...g.organizer, phone: phone(9), phoneNorm: phone(9) }; },
  (_g, b) => { b.metadata.organizerId = ids.actor; },
  (_g, b) => { b.metadata.organizerPhone = phone(9); },
  (_g, b) => { b.metadata.organizerPhoneNorm = phone(9); },
  (g) => { g.membershipMutation = { operationKey: 'other' }; },
]) test('organizer takeover/fence remains refused', () => {
  const game = fixture(), body = publicBody(game); change(game, body);
  const result = prepare(game, body); assert.equal(result.write, null); assert.equal(result.response.payload.code, 'ORGANIZER_COMMAND_REQUIRED');
});
for (const expectedUpdatedAt of ['old-version', null, 1, {}, undefined]) test(`explicit stale version ${String(expectedUpdatedAt)} cannot overwrite a foreign join`, () => {
  const game = fixture(), body = { ...publicBody(game), expectedUpdatedAt };
  const result = prepare(game, body); assert.equal(result.write, null); assert.equal(result.response.payload.code, 'GAME_PATCH_VERSION_CONFLICT');
});
test('legacy callers without explicit version retain their existing server CAS contract', () => {
  const game = fixture(), body = publicBody(game); delete body.expectedUpdatedAt;
  assert.ok(prepare(game, body).write);
});
test('canonical roster bridge feature flag still rejects legacy roster writes', () => {
  const game = fixture(), result = prepare(game, publicBody(game), candidateFunctions(), true);
  assert.equal(result.write, null); assert.equal(result.response.statusCode, 403);
});
for (const result of [{ acknowledged: true, matchedCount: 0 }, { acknowledged: false, matchedCount: 1 }, {}]) test('failed/unacknowledged CAS never releases success or autojoin', () => {
  const game = fixture(), { write } = prepare(game, publicBody(game));
  const [reply, followup] = acknowledge(write, result); assert.equal(reply.statusCode, 409); assert.equal(followup, null);
});
test('candidate edits only the three pinned function bodies and refuses drift/missing/duplicate nodes', () => {
  const flow = [...Object.entries(originalFunctions()).map(([id, func]) => ({ id, func, type: 'function', wires: [], name: 'fixture' })), { id: 'foreign', type: 'inject', repeat: 'never', wires: [] }];
  const after = patchGamePrivateProjectionFlow(flow); assert.equal(after.length, flow.length); assert.deepEqual(after.at(-1), flow.at(-1));
  for (let i = 0; i < 3; i++) assert.deepEqual({ ...after[i], func: flow[i].func }, flow[i]);
  for (const broken of [flow.slice(1), [...flow, flow[0]], flow.map((n, i) => i === 0 ? { ...n, func: n.func + '\n' } : n)]) assert.throws(() => patchGamePrivateProjectionFlow(broken));
});
test('composed fixture has no external business calls and leaves canonical organizer unchanged after the write', () => {
  const game = fixture(), organizer = clone(game.organizer), { write } = prepare(game, publicBody(game));
  applyFixtureUpdate(game, write); assert.deepEqual(game.organizer, organizer);
  for (const source of Object.values(candidateFunctions())) assert.doesNotMatch(source, /fetch\(|https?:\/\/api\.vivacrm|http request/);
  assert.ok(fs.readFileSync('scripts/nodered_games_nodes/fn_patch.js', 'utf8').includes(createGamePrivateProjection.toString()));
});

test('partial participants PATCH preserves omitted waitlist, payment contacts, booking context and canonical metadata indexes', () => {
  const game = fixture();
  game.metadata.splitPayment.payments.push({ clientId: 'paid-only-fixture', bookingId: 'paid-only-booking', status: 'PAID', phone: phone(8) });
  const view = getPublic(game);
  const { write } = prepare(game, { expectedUpdatedAt: game.updatedAt, participants: view.participants });
  assert.ok(write);
  assert.equal(write.payload.$set.waitlist, undefined);
  assert.deepEqual(write.payload.$set.waitlistPhones, [phone(3)]);
  assert.equal(write.payload.$set.resultRosterSnapshot.waitlist[0].phoneNorm, phone(3));
  assert.ok(write.payload.$set.allRelatedPhones.includes(phone(8)));
  assert.ok(write.payload.$set.allRelatedPhones.includes(phone(3)));
  assert.equal(write.payload.$set.resultRosterSnapshot.bookingContext.exerciseId, game.booking.exerciseId);
  assert.equal(write.payload.$set.metadata, undefined);
  assert.deepEqual(write.payload.$set['metadata.allRelatedPhones'], write.payload.$set.allRelatedPhones);
});
for (const alias of ['clientId', 'playerId', 'userId', 'uuid']) test(`canonical ${alias} matches frontend id without losing a private phone`, () => {
  const stored = [{ [alias]: ids.player, name: 'Alias fixture', phone: phone(2) }, { id: ids.waiting, name: 'Other fixture', phone: phone(3) }];
  const restored = projection.restoreRoster([{ id: ids.player, name: 'Alias fixture' }, { id: ids.waiting, name: 'Other fixture' }], stored);
  assert.equal(restored[0].phone, phone(2)); assert.equal(restored[1].phone, phone(3));
});
test('conflicting actor aliases and duplicate canonical IDs cannot be resolved through different names', () => {
  assert.throws(() => projection.restoreRoster([{ id: ids.player, clientId: ids.waiting }], [{ id: ids.player, phone: phone(2) }]), /PRIVATE_BINDING_UNKNOWN/);
  assert.throws(() => projection.restoreRoster([{ id: ids.player, name: 'Second fixture' }], [{ id: ids.player, name: 'First fixture', phone: phone(2) }, { id: ids.player, name: 'Second fixture', phone: phone(3) }]), /PRIVATE_BINDING_UNKNOWN/);
  assert.throws(() => projection.restoreRoster([{ id: ids.player }], [{ id: ids.player, clientId: ids.waiting, phone: phone(2) }]), /PRIVATE_BINDING_UNKNOWN/);
});
test('explicit invite clear updates both private indexes without changing unrelated metadata', () => {
  const game = fixture(); game.metadata.invitedPhones = [phone(5)];
  const { write } = prepare(game, { expectedUpdatedAt: game.updatedAt, participants: getPublic(game).participants, invitedPhones: [] });
  assert.ok(write); assert.deepEqual(write.payload.$set.invitedPhones, []); assert.deepEqual(write.payload.$set['metadata.invitedPhones'], []);
  assert.equal(write.payload.$set.allRelatedPhones.includes(phone(5)), false);
  assert.equal(write.payload.$set['metadata.bookingIds'], undefined);
});

for (const key of ['phoneNorm', 'phoneNumber', 'mobile']) for (const partial of [false, true]) test(`legacy ${key} identity survives ${partial ? 'partial' : 'full'} public roster PATCH and private indexes`, () => {
  const game = fixture();
  for (const row of [...game.participants, ...game.waitlist]) { row[key] = row.phone; delete row.phone; }
  const projected = getPublic(game);
  const { write } = prepare(game, { participants: projected.participants, ...(!partial ? { waitlist: projected.waitlist } : {}) });
  assert.ok(write);
  const set = write.payload.$set;
  assert.ok(set.participantPhones.includes(phone(2)));
  assert.ok(set.waitlistPhones.includes(phone(3)));
  assert.ok(set.allRelatedPhones.includes(phone(3)));
  if (!partial) assert.equal(set.waitlist[0].phone, phone(3));
  assert.equal(set.resultRosterSnapshot.waitlist[0].phoneNorm, phone(3));
});
