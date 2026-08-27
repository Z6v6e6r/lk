import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import test from 'node:test';
import {
  GAMES_PATCH_CONTRACT,
  PATCH_SOURCE_PATH,
  synchronizeGamesPatch,
} from '../patch_live_games_patch.mjs';

const LIVE_FLOW_SHA256 = '0d25df4289a38978ac925f46689eaa30b6fc38efb5de00061ba86266f613a24e';
const LIVE_PATCH_SHA256 = '4fb7d6ca9961e854cefb22f0752f9c1f921e1b6cbacfea3ce16e8b8681538931';
const PATCH_CANDIDATE_SHA256 = '9c6aaf4578c69fa30daa2326506900a5ee0a265f2299f1f0e3ab20b11e01a130';

class FixedDate extends Date {
  constructor(...args) { super(...(args.length ? args : ['2026-07-27T10:00:00.000Z'])); }
  static now() { return Date.parse('2026-07-27T10:00:00.000Z'); }
}

function source() { return fs.readFileSync(PATCH_SOURCE_PATH, 'utf8'); }
const sha256 = (value) => crypto.createHash('sha256').update(value).digest('hex');
const sha256Json = (value) => sha256(Buffer.from(JSON.stringify(value), 'utf8'));

function syntheticFlowContract() {
  const flow = [
    { id: 'tab', type: 'tab', label: 'LK Games', disabled: false },
    { id: 'route-a', type: 'http in', z: 'tab', name: 'route a', method: 'patch', url: '/a', wires: [['target']] },
    { id: 'route-b', type: 'http in', z: 'tab', name: 'route b', method: 'patch', url: '/b', wires: [['target']] },
    { id: 'target', type: 'function', z: 'tab', name: 'target', outputs: 1, func: 'return msg;\n', wires: [['terminal']] },
    { id: 'terminal', type: 'debug', z: 'tab', name: 'terminal', wires: [] },
  ];
  const byId = new Map(flow.map((node) => [node.id, node]));
  const candidateSource = 'msg.membershipId = "membership-1";\nreturn msg;\n';
  const contract = {
    wholeFlowSha256: sha256(Buffer.from(JSON.stringify(flow))),
    nodeCount: flow.length,
    httpRouteCount: 2,
    tabId: 'tab',
    routes: ['route-a', 'route-b'].map((id) => {
      const node = byId.get(id);
      return { id, name: node.name, url: node.url, nodeSha256: sha256Json(node) };
    }),
    target: {
      id: 'target',
      name: 'target',
      outputs: 1,
      wires: [['terminal']],
      preimageSha256: sha256(byId.get('target').func),
      sourceSha256: sha256(candidateSource),
      nodeSha256: sha256Json(byId.get('target')),
    },
    graphNodes: [{ id: 'terminal', nodeSha256: sha256Json(byId.get('terminal')) }],
  };
  return { flow, contract, candidateSource };
}

function run(payload, gameId = 'game-42') {
  const msg = { req: { params: { gameId } }, payload };
  return new Function('msg', 'Date', source())(msg, FixedDate);
}

test('tracked patch source is a pinned candidate after the exact verified live function', () => {
  assert.equal(crypto.createHash('sha256').update(source()).digest('hex'), PATCH_CANDIDATE_SHA256);
  assert.equal(GAMES_PATCH_CONTRACT.wholeFlowSha256, LIVE_FLOW_SHA256);
  assert.equal(GAMES_PATCH_CONTRACT.nodeCount, 4762);
  assert.equal(GAMES_PATCH_CONTRACT.httpRouteCount, 215);
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

test('guarded synchronization changes only the exact target function', () => {
  const { flow, contract, candidateSource } = syntheticFlowContract();
  const result = synchronizeGamesPatch(flow, candidateSource, contract.wholeFlowSha256, contract);
  assert.deepEqual(result.changedNodes, [{ id: 'target', changedFields: ['func'] }]);
  assert.equal(result.reachableNodeCount, 4);
  assert.equal(result.candidate.find((node) => node.id === 'target').func, candidateSource);
  assert.deepEqual(
    result.candidate.map((node) => ({ id: node.id, wires: node.wires ?? null })),
    flow.map((node) => ({ id: node.id, wires: node.wires ?? null })),
  );
});

test('guarded synchronization fails closed on target or route drift', () => {
  const { flow, contract, candidateSource } = syntheticFlowContract();
  const targetDrift = structuredClone(flow);
  targetDrift.find((node) => node.id === 'target').func = 'return null;\n';
  assert.throws(
    () => synchronizeGamesPatch(targetDrift, candidateSource, contract.wholeFlowSha256, contract),
    /PATCH target preimage mismatch/,
  );

  const routeDrift = structuredClone(flow);
  routeDrift.find((node) => node.id === 'route-a').wires = [['terminal']];
  assert.throws(
    () => synchronizeGamesPatch(routeDrift, candidateSource, contract.wholeFlowSha256, contract),
    /PATCH route route-a contract mismatch/,
  );
});

test('ordinary non-roster patch preserves the four-output Mongo, HTTP, debug, and autojoin contract', () => {
  const outputs = run({
    chatUrl: 'https://example.test/chat/game-42',
    metadata: { source: 'admin' },
  });
  assert.equal(outputs.length, 4);
  assert.equal(outputs[0].query.id, 'game-42');
  assert.equal(outputs[0].payload.$set.chatUrl, 'https://example.test/chat/game-42');
  assert.deepEqual(outputs[0].payload.$set.metadata, { source: 'admin' });
  assert.equal(outputs[1].statusCode, 200);
  assert.equal(outputs[1].payload.id, 'game-42');
  assert.equal(outputs[1].payload.chatUrl, 'https://example.test/chat/game-42');
  assert.equal(outputs[2], outputs[1]);
  const { id, ...responsePatch } = outputs[1].payload;
  assert.equal(id, 'game-42');
  assert.deepEqual(outputs[3]._gameAutojoinPatch.patch, responsePatch);
});

test('generic PATCH cannot write participants or waitlist', () => {
  for (const payload of [{ participants: [] }, { waitlist: [] }]) {
    const outputs = run(payload);
    assert.equal(outputs[0], null);
    assert.equal(outputs[1].statusCode, 403);
    assert.equal(outputs[1].payload.code, 'GAME_ROSTER_COMMAND_REQUIRED');
    assert.equal(outputs[2], outputs[1]);
    assert.equal(outputs[3], null);
  }
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
