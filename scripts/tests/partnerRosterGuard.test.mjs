import assert from 'node:assert/strict';
import fs from 'node:fs';
import crypto from 'node:crypto';
import test from 'node:test';
import { buildGuard, contract, ids } from '../patch_partner_roster_guard.mjs';
const sources = Object.fromEntries(['preflight', 'authorize', 'ack', 'wrapper'].map((name) => [name, fs.readFileSync(`scripts/nodered_partner_roster_nodes/fn_${name}.js`, 'utf8')]));
const run = (name, msg) => new Function('msg', sources[name])(msg);
const game = () => ({ _id: 'document-a', id: 'game-a', tenantKey: 'tenant-a', updatedAt: 'version-a', participants: [], payments: [] });
const request = (body = {}) => ({ req: { params: { gameId: 'game-a' } }, payload: { expectedUpdatedAt: 'version-a', participants: [], ...body } });
const authorize = (doc, body) => { const msg = request(body); run('preflight', msg); msg.payload = [doc]; return run('authorize', msg); };
const digest = (value) => crypto.createHash('sha256').update(typeof value === 'string' ? value : JSON.stringify(value)).digest('hex');

test('non-roster PATCH preserves the existing path without a database read', () => {
  const msg = { payload: { chatUrl: 'https://example.test/chat' } };
  assert.deepEqual(run('preflight', msg), [msg, null]);
  assert.equal(msg._partnerRosterPatch, undefined);
});

test('both roster fields use a bounded authoritative game read', () => {
  for (const field of ['participants', 'waitlist']) {
    const msg = request(); msg.payload = { [field]: [], expectedUpdatedAt: 'version-a' };
    const outputs = run('preflight', msg);
    assert.equal(outputs[0], null);
    assert.deepEqual(msg.payload, [{ id: 'game-a', archived: { $ne: true } }, { limit: 2 }]);
  }
});

test('stored Partner participant or external payment rejects stale body with no Partner data', () => {
  for (const doc of [
    { ...game(), participants: [{ source: 'PARTNER_API', membershipId: 'member-a' }] },
    { ...game(), payments: [{ settlementSource: 'EXTERNAL_PARTNER', status: 'PAID', membershipId: 'member-a' }] },
  ]) {
    const outputs = authorize(doc);
    assert.equal(outputs[0], null);
    assert.equal(outputs[1].statusCode, 403);
    assert.equal(outputs[1].payload.code, 'GAME_PARTNER_ROSTER_COMMAND_REQUIRED');
    assert.equal(outputs[1]._partnerRosterPatch, undefined);
  }
});

test('unknown, duplicate, failed or stale preflight cannot enter the write path', () => {
  for (const rows of [[], [game(), game()], [{ ...game(), id: 'other-game' }], [{ ...game(), updatedAt: 'version-b' }]]) {
    const msg = request(); run('preflight', msg); msg.payload = rows;
    assert.equal(run('authorize', msg)[0], null);
  }
  const msg = request(); run('preflight', msg); msg.error = { message: 'storage failure' };
  assert.equal(run('authorize', msg)[1].statusCode, 503);
});

test('ordinary roster write requires and captures exact source version and roster', () => {
  const outputs = authorize(game());
  assert.equal(outputs[1], null);
  assert.deepEqual(outputs[0].payload.participants, []);
  assert.deepEqual(outputs[0]._partnerRosterPatch.preimage.participants, { exists: true, value: [] });
  assert.equal(authorize(game(), { expectedUpdatedAt: null })[1].statusCode, 409);
  const msg = request(); delete msg.payload.expectedUpdatedAt; run('preflight', msg); msg.payload = [game()];
  assert.equal(run('authorize', msg)[1].statusCode, 428);
});

test('wrapper sends no HTTP success or autojoin until exact preimage write is acknowledged', () => {
  const msg = authorize(game())[0];
  const legacy = 'return [{ ...msg, query: { id: "game-a" }, payload: { $set: { participants: [] } } }, { ...msg, statusCode: 200, payload: { id: "game-a" } }, null, { ...msg, payload: { id: "game-a" }, _gameAutojoinPatch: { patch: { participants: [] } } }];';
  const outputs = new Function('msg', sources.wrapper.replace('__LIVE_SOURCE__', legacy))(msg);
  assert.deepEqual(outputs.slice(0, 4), [null, null, null, null]);
  const query = outputs[4].payload[0];
  assert.deepEqual(query._id, { $eq: 'document-a' });
  assert.deepEqual(query.tenantKey, { $eq: 'tenant-a' });
  assert.deepEqual(query.participants, { $eq: [] });
  assert.deepEqual(query.payments, { $eq: [] });
  assert.deepEqual(query.waitlist, { $exists: false });
  assert.deepEqual(outputs[4].payload[1].$inc, { revision: 1 });
  assert.deepEqual(query.updatedAt, { $eq: 'version-a' });
  assert.deepEqual(query.revision, { $exists: false });
  // A Partner insertion between preflight and write invalidates this predicate.
  assert.notDeepEqual(query.participants.$eq, [{ source: 'PARTNER_API' }]);
  const ctx = outputs[4]._partnerRosterPatch;
  assert.equal(run('ack', { ...outputs[4], payload: { acknowledged: true, matchedCount: 0 } })[2], null);
  const acknowledged = run('ack', { _partnerRosterPatch: ctx, payload: { acknowledged: true, matchedCount: 1 } });
  assert.equal(acknowledged[0].statusCode, 200);
  assert.deepEqual(acknowledged[2]._gameAutojoinPatch.patch, { participants: [] });
});

test('write errors, unacknowledged results, and CAS conflicts never fan out to autojoin', () => {
  for (const payload of [undefined, {}, { acknowledged: false, matchedCount: 1 }, { acknowledged: true, matchedCount: 0 }]) {
    const out = run('ack', { payload, _partnerRosterPatch: { response: { payload: { id: 'game-a' }, statusCode: 200 }, autojoin: { payload: {}, patch: {} } } });
    assert.equal(out[2], null);
    assert.notEqual(out[0].statusCode, 200);
  }
  assert.equal(run('ack', { error: {}, _partnerRosterPatch: {} })[0].statusCode, 503);
});

function fixture() {
  const target = { id: contract.target, type: 'function', z: contract.tab, outputs: 4, func: 'return [msg, null, null, null];', wires: [['b2a10027fc45966c'], [contract.http], [contract.debug], [contract.autojoin]] };
  const read = { id: contract.read, type: 'mongodb4', collection: 'lk_games', operation: 'find', clientNode: 'existing-client', wires: [] };
  const write = { ...read, id: contract.write, operation: 'updateOne' };
  const flow = [target, read, write, ...contract.routes.map((id, index) => ({ id, type: 'http in', z: contract.tab, method: 'patch', url: index ? '/lk/games/records/:gameId' : '/lk/games/:gameId', wires: [[contract.target]] })), ...['b2a10027fc45966c', contract.http, contract.debug, contract.autojoin].map((id) => ({ id, type: 'debug', wires: [] })), { id: 'foreign', type: 'function', func: 'return msg;', wires: [] }];
  return { flow, expected: { ...contract, targetFunctionSha: digest(target.func), readSha: digest(read), writeSha: digest(write) } };
}

test('candidate changes only both PATCH aliases and target, preserving all unrelated nodes and config references', () => {
  const { flow, expected } = fixture();
  const candidate = buildGuard(flow, sources, expected);
  assert.equal(candidate.length, flow.length + 6);
  for (const id of contract.routes) assert.deepEqual(candidate.find((n) => n.id === id).wires, [[ids.preflight]]);
  assert.equal(candidate.find((n) => n.id === ids.write).clientNode, 'existing-client');
  assert.deepEqual(candidate.find((n) => n.id === 'foreign'), flow.find((n) => n.id === 'foreign'));
  assert.deepEqual(candidate.find((n) => n.id === ids.catch).scope, [ids.read, ids.write]);
});

test('candidate rejects changed live source, routes, Mongo configuration and existing guard IDs', () => {
  for (const mutate of [
    (flow) => { flow[0].func = 'different'; },
    (flow) => { flow[1].clientNode = 'wrong'; },
    (flow) => { flow.find((n) => n.id === contract.routes[0]).wires = [['foreign']]; },
    (flow) => { flow.push({ id: ids.preflight }); },
  ]) {
    const { flow, expected } = fixture(); mutate(flow);
    assert.throws(() => buildGuard(flow, sources, expected));
  }
});


test('waitlist predicate and incremented revision reject a concurrent same-timestamp roster write', () => {
  const doc = { ...game(), revision: 3, waitlist: [{ id: 'waiting-a' }] };
  const msg = authorize(doc)[0];
  const legacy = 'return [{ ...msg, query: { id: "game-a" }, payload: { $set: { waitlist: [] } } }, { ...msg, statusCode: 200, payload: { id: "game-a" } }, null, null];';
  const out = new Function('msg', sources.wrapper.replace('__LIVE_SOURCE__', legacy))(msg);
  assert.deepEqual(out[4].payload[0].waitlist, { $eq: [{ id: 'waiting-a' }] });
  assert.deepEqual(out[4].payload[0].revision, { $eq: 3 });
  assert.equal(out[4]._partnerRosterPatch.response.payload.revision, 4);
});


test('existing null tenant remains distinct from an absent tenant in the CAS predicate', () => {
  const msg = authorize({ ...game(), tenantKey: null })[0];
  const legacy = 'return [{ ...msg, query: { id: "game-a" }, payload: { $set: { participants: [] } } }, { ...msg, statusCode: 200, payload: {} }, null, null];';
  const out = new Function('msg', sources.wrapper.replace('__LIVE_SOURCE__', legacy))(msg);
  assert.deepEqual(out[4].payload[0].tenantKey, { $eq: null, $exists: true });
});
