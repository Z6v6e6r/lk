import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { GROUP_UPGRADE_TARGETS as targets, hash, patchGroupEventPaymentBody,
  composeGroupEventPaymentUpgrade as compose, writeGroupUpgradeArtifacts } from '../prepare_group_event_payment_upgrade.mjs';
import { validateReviewedFlowContract } from '../nodered_reviewed_flow_deploy/runtime_contract.mjs';

const canonical = t => fs.readFileSync(new URL('../../' + t.file, import.meta.url), 'utf8');
function previous(t) {
  let body = canonical(t);
  for (const delta of [...t.deltas].reverse()) {
    assert.equal(body.split(delta.after).length, 2);
    body = body.replace(delta.after, () => delta.before);
  }
  return body;
}
function fixture() {
  const rows = targets.map(t => {
    let func = previous(t);
    if (t.id === targets[0].id) func = func.replace('const lk1Checkout = (ctx) => {',
      '// installed rejoin expansion must survive\nconst fixtureRejoin = true;\nconst lk1Checkout = (ctx) => {');
    func = '// installed gateway/preview helper prefix\n' + func + '\n// installed suffix preserved\n';
    return { id: t.id, type: 'function', z: 'fixture-tab', func, outputs: 1, wires: [[]],
      initialize: '/* installed initializer */', libs: [], name: 'fixture', custom: 'keep' };
  });
  rows.push({ id: 'fixture-tab', type: 'tab', label: 'fixture' });
  const pins = targets.map((t,i) => ({ ...t, beforeSha256: hash(rows[i].func),
    afterSha256: hash(patchGroupEventPaymentBody(rows[i].func, t)) }));
  return { rows, pins, bytes: Buffer.from(JSON.stringify(rows)) };
}

test('delta exactly recreates merged canonical group-payment behavior', () => {
  for (const t of targets) assert.equal(patchGroupEventPaymentBody(previous(t), t), canonical(t));
});

test('assembled wrappers, installed rejoin helpers and all non-body fields survive', () => {
  const { rows, pins, bytes } = fixture();
  const before = structuredClone(rows);
  const { candidate, candidateBytes, contract } = compose(bytes, 'group-payment-fixture', pins);
  assert.deepEqual(rows, before);
  assert.equal(candidate.length, rows.length);
  for (let i = 0; i < targets.length; i++) {
    const { func, ...rest } = candidate[i]; const { func: old, ...oldRest } = rows[i];
    assert.deepEqual(rest, oldRest);
    assert.ok(func.startsWith('// installed gateway/preview helper prefix\n'));
    assert.ok(func.endsWith('// installed suffix preserved\n'));
    assert.equal(old.includes('fixtureRejoin'), func.includes('fixtureRejoin'));
    assert.equal(hash(func), pins[i].afterSha256);
  }
  assert.deepEqual(candidate.at(-1), rows.at(-1));
  validateReviewedFlowContract({ liveBytes: bytes, candidateBytes, contract });
  for (const mutate of [f => f[0].initialize = 'changed', f => f[1].wires = [['fixture-tab']],
    f => f.at(-1).label = 'changed', f => f.push({id:'extra',type:'tab'})]) {
    const modified = structuredClone(candidate); mutate(modified);
    assert.throws(() => validateReviewedFlowContract({liveBytes:bytes,
      candidateBytes:Buffer.from(JSON.stringify(modified)),contract}));
  }
});

test('release pins reject synthetic input; drift, duplicate anchors and repeat upgrade fail closed', () => {
  const { rows, pins, bytes } = fixture();
  assert.throws(() => compose(bytes, 'group-payment-fixture'), /Preimage drift/);
  for (const mutate of [f => f[0].func += '\n// drift', f => f.push({...f[0]}),
    f => f[0].disabled = true, f => f[0].outputs = 2, f => f.splice(0,1)]) {
    const f = structuredClone(rows); mutate(f);
    assert.throws(() => compose(Buffer.from(JSON.stringify(f)), 'group-payment-fixture', pins));
  }
  for (const t of targets) {
    assert.throws(() => patchGroupEventPaymentBody(previous(t).replace(t.deltas[0].before, ''), t), /anchor drift/);
    assert.throws(() => patchGroupEventPaymentBody(previous(t) + t.deltas[0].before, t), /anchor drift/);
    assert.throws(() => patchGroupEventPaymentBody(canonical(t), t), /anchor drift/);
  }
  assert.throws(() => compose(bytes, 'group-payment-fixture', pins.map(t => ({...t,afterSha256:'0'.repeat(64)}))), /Postimage drift/);
});

test('CLI output rejects repository destination before reading private data', () => {
  const root = new URL('../../', import.meta.url).pathname.replace(/\/$/,'');
  assert.throws(() => writeGroupUpgradeArtifacts('/nonexistent-source', root + '/forbidden-upgrade-output', 'group-payment-fixture'), /outside Git/);
});
