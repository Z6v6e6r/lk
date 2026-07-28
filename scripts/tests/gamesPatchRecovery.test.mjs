import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import test from 'node:test';
import { GAMES_PATCH_CONTRACT, PATCH_SOURCE_PATH } from '../patch_live_games_patch.mjs';

const LIVE_PATCH_SHA256 = 'cd19171a18ec18a553418d5b1725bab50ee1df2788e5160143430aaeb758c8ad';
const PATCH_CANDIDATE_SHA256 = '7d007ab69297b7ab4314bf23a21cb6fbebcdc6f149e0bfd9d931f0329718261c';

class FixedDate extends Date {
  constructor(...args) { super(...(args.length ? args : ['2026-07-27T10:00:00.000Z'])); }
  static now() { return Date.parse('2026-07-27T10:00:00.000Z'); }
}

function source() { return fs.readFileSync(PATCH_SOURCE_PATH, 'utf8'); }
function run(payload, gameId = 'game-42') {
  const msg = { req: { params: { gameId } }, payload };
  return new Function('msg', 'Date', source())(msg, FixedDate);
}

test('tracked patch source is a pinned candidate after the exact verified live function', () => {
  assert.equal(crypto.createHash('sha256').update(source()).digest('hex'), PATCH_CANDIDATE_SHA256);
  assert.equal(GAMES_PATCH_CONTRACT.target.preimageSha256, LIVE_PATCH_SHA256);
  assert.equal(GAMES_PATCH_CONTRACT.target.sourceSha256, PATCH_CANDIDATE_SHA256);
});

test('both PATCH routes remain the only verified production inputs', () => {
  assert.deepEqual(GAMES_PATCH_CONTRACT.routes.map((route) => [route.method ?? 'patch', route.url]), [
    ['patch', '/lk/games/:gameId'],
    ['patch', '/lk/games/records/:gameId'],
  ]);
  assert.deepEqual(GAMES_PATCH_CONTRACT.target.wires, [
    ['b2a10027fc45966c'], ['e17f8a411d4dfa91'], ['3b822085d5f18e97'], ['5fc5eaeab97f3f88'],
  ]);
});

test('ordinary participant patch preserves the four-output Mongo, HTTP, debug, and autojoin contract', () => {
  const outputs = run({
    participants: [{ id: 'p1', name: 'Player', phone: '8 (960) 000-00-01' }],
    metadata: { allRelatedPhones: ['+7 960 000 00 02'] },
  });
  assert.equal(outputs.length, 4);
  assert.equal(outputs[0].query.id, 'game-42');
  assert.deepEqual(outputs[0].payload.$set.participantPhones, ['79600000001']);
  assert.deepEqual(outputs[0].payload.$set.allRelatedPhones, ['79600000002', '79600000001']);
  assert.equal(outputs[1].statusCode, 200);
  assert.equal(outputs[1].payload.id, 'game-42');
  assert.deepEqual(outputs[1].payload.participants, outputs[0].payload.$set.participants);
  assert.equal(outputs[2], outputs[1]);
  const { id, ...responsePatch } = outputs[1].payload;
  assert.equal(id, 'game-42');
  assert.deepEqual(outputs[3]._gameAutojoinPatch.patch, responsePatch);
});

test('organizer PATCH writes fields atomically but returns the public organizer patch without dotted Mongo keys', () => {
  const outputs = run({ organizer: { clientId: 'o1', firstName: 'Org', lastName: 'Player', phone: '8 960 000 00 03' } });
  const setDoc = outputs[0].payload.$set;
  assert.equal(setDoc['organizer.id'], 'o1');
  assert.equal(setDoc['organizer.phoneNorm'], '79600000003');
  assert.equal(Object.hasOwn(outputs[1].payload, 'organizer.id'), false);
  assert.deepEqual(outputs[1].payload.organizer, { id: 'o1', name: 'Org Player', phone: '79600000003', phoneNorm: '79600000003' });
});

test('missing game ID and empty patch fail through the established HTTP/debug outputs', () => {
  const missing = run({ status: 'OPEN' }, '  ');
  assert.equal(missing[0], null);
  assert.equal(missing[1].statusCode, 400);
  assert.equal(missing[1].payload.error, 'gameId is required');
  assert.equal(missing[2], missing[1]);
  const empty = run({});
  assert.equal(empty[0], null);
  assert.equal(empty[1].statusCode, 400);
  assert.equal(empty[1].payload.error, 'Empty patch');
});
