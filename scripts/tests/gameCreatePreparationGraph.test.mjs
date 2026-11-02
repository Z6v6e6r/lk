import test from 'node:test';
import assert from 'node:assert/strict';
import {
  composeGameCreatePreparation,
  gameCreatePreparationIds as ids,
} from '../patch_nodered_game_create_preparation.mjs';
import { validateReviewedFlowContract } from '../nodered_reviewed_flow_deploy/runtime_contract.mjs';
const original = [
  { id: 'oldtab', type: 'tab', label: 'Existing owners' },
  {
    id: 'training',
    type: 'function',
    z: 'oldtab',
    func: 'return msg;',
    outputs: 8,
    wires: [[], [], [], [], [], [], [], []],
  },
  {
    id: 'self',
    type: 'function',
    z: 'oldtab',
    func: 'return msg;',
    outputs: 7,
    wires: [[], [], [], [], [], [], []],
  },
  {
    id: 'join',
    type: 'http in',
    z: 'oldtab',
    url: '/lk/integrations/v2/booked-operation-admissions',
    method: 'post',
    wires: [['training']],
  },
];
const bytes = () => Buffer.from(JSON.stringify(original));
test('additive exact graph leaves all old owner bytes/wires intact and permits only GET observation topology', () => {
  const r = composeGameCreatePreparation(bytes(), 'synthetic-create-preparation');
  assert.deepEqual(r.candidate.slice(0, original.length), original);
  const added = r.candidate.slice(original.length);
  assert.equal(added.length, 8);
  assert.ok(added.every((n) => !['mongodb4', 'mongodb out', 'debug', 'inject'].includes(n.type)));
  const router = added.find((n) => n.id === ids.router);
  assert.equal(router.outputs, 2);
  assert.deepEqual(router.wires, [[ids.http], [ids.sanitize]]);
  assert.deepEqual(added.find((n) => n.id === ids.catch).scope, [ids.http]);
  assert.deepEqual(added.find((n) => n.id === ids.sanitize).wires, [[ids.response]]);
  validateReviewedFlowContract({
    liveBytes: bytes(),
    candidateBytes: r.candidateBytes,
    contract: r.contract,
  });
  for (const id of [ids.verify, ids.router, ids.sanitize]) {
    const candidate = structuredClone(r.candidate);
    candidate.find((n) => n.id === id).func += '\n// drift';
    assert.throws(() =>
      validateReviewedFlowContract({
        liveBytes: bytes(),
        candidateBytes: Buffer.from(JSON.stringify(candidate)),
        contract: r.contract,
      }),
    );
  }
  const changed = structuredClone(r.candidate);
  changed.find((n) => n.id === 'training').outputs = 5;
  assert.throws(() =>
    validateReviewedFlowContract({
      liveBytes: bytes(),
      candidateBytes: Buffer.from(JSON.stringify(changed)),
      contract: r.contract,
    }),
  );
});
test('route/ID collisions and malformed source graphs cannot produce a partial candidate', () => {
  const first = composeGameCreatePreparation(bytes(), 'synthetic-create-preparation');
  assert.throws(
    () => composeGameCreatePreparation(first.candidateBytes, 'synthetic-create-preparation'),
    /COLLISION/,
  );
  for (const flow of [
    [...original, original[0]],
    [
      ...original,
      { id: 'collision', type: 'http in', url: '/lk/integrations/v1/game-create-preparations' },
    ],
    {},
  ])
    assert.throws(() =>
      composeGameCreatePreparation(
        Buffer.from(JSON.stringify(flow)),
        'synthetic-create-preparation',
      ),
    );
});

test('pre-existing dangling edges cannot become active owner bypasses', () => {
  for (const edge of [
    { wires: [[ids.router]] },
    { links: [ids.router] },
    { scope: [ids.http] },
    { z: ids.tab },
  ]) {
    const flow = [...original, { id: 'foreign', type: 'function', ...edge }];
    assert.throws(
      () =>
        composeGameCreatePreparation(
          Buffer.from(JSON.stringify(flow)),
          'synthetic-create-preparation',
        ),
      /FOREIGN_EDGE/,
    );
  }
});
