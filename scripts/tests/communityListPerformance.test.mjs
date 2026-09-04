import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import test from 'node:test';
import {
  synchronizeCommunityListPerformance,
} from '../patch_live_community_list_performance.mjs';

const tail = fs.readFileSync(
  'scripts/nodered_community_list_nodes/fn_list_prepare_tail.js',
  'utf8',
);
const sha256 = (value) => crypto.createHash('sha256').update(value).digest('hex');
const sha256Json = (value) => sha256(JSON.stringify(value));

function makeFixture() {
  const oldFunc = `const helper = true;\nconst listMode = 'FULL';\nreturn [msg, null, msg];\n`;
  const flow = [
    { id: 'tab', type: 'tab', label: 'LK Communities', disabled: false },
    {
      id: 'route', type: 'http in', z: 'tab', name: 'LK communities list', method: 'get',
      url: '/lk/communities', wires: [['prepare']],
    },
    {
      id: 'prepare', type: 'function', z: 'tab', name: 'Prepare communities list query', outputs: 3,
      func: oldFunc, wires: [['mongo'], ['response'], ['debug']],
    },
    {
      id: 'mongo', type: 'mongodb4', z: 'tab', name: 'Find communities', clientNode: 'client',
      mode: 'collection', collection: 'lk_communities', operation: 'find', output: 'toArray',
      maxTimeMS: '0', handleDocId: false, wires: [['response']],
    },
    {
      id: 'response', type: 'function', z: 'tab', name: 'Build communities list response', outputs: 2,
      func: 'return [msg, msg];', wires: [['http'], ['debug']],
    },
    { id: 'http', type: 'http response', z: 'tab', wires: [] },
    { id: 'debug', type: 'debug', z: 'tab', name: 'communities list debug', wires: [] },
  ];
  const byId = (id) => flow.find((node) => node.id === id);
  const sourceSha = sha256('fixture-flow');
  const contract = {
    wholeFlowSha256: sourceSha,
    nodeCount: flow.length,
    httpRouteCount: 1,
    tab: { ...byId('tab'), nodeSha256: sha256Json(byId('tab')) },
    route: { ...byId('route'), nodeSha256: sha256Json(byId('route')) },
    prepare: {
      ...Object.fromEntries(Object.entries(byId('prepare')).filter(([key]) => key !== 'func')),
      nodeSha256: sha256Json(byId('prepare')),
      preimageSha256: sha256(oldFunc),
      sourceSha256: sha256(tail),
    },
    mongo: { ...byId('mongo'), nodeSha256: sha256Json(byId('mongo')) },
    response: { ...byId('response'), nodeSha256: sha256Json(byId('response')) },
  };
  return { flow, contract, sourceSha, oldFunc };
}

test('patches only the approved prepare function and preserves topology', () => {
  const fixture = makeFixture();
  const before = structuredClone(fixture.flow);
  const result = synchronizeCommunityListPerformance(
    fixture.flow,
    tail,
    fixture.sourceSha,
    fixture.contract,
  );

  assert.deepEqual(result.changedNodes, [{ id: 'prepare', changedFields: ['func'] }]);
  assert.equal(result.invariants.nodeCount, before.length);
  assert.equal(result.invariants.httpRouteCount, 1);
  assert.equal(fixture.flow.find((node) => node.id === 'route').url, '/lk/communities');
  assert.equal(fixture.flow.find((node) => node.id === 'mongo').collection, 'lk_communities');
  assert.equal(fixture.flow.find((node) => node.id === 'response').func, 'return [msg, msg];');
  assert.equal(
    fixture.flow.find((node) => node.id === 'prepare').func,
    `const helper = true;\n${tail}`,
  );
});

test('fails closed on whole-flow, node, and approved-source drift', () => {
  const flowDrift = makeFixture();
  assert.throws(
    () => synchronizeCommunityListPerformance(
      flowDrift.flow,
      tail,
      '0'.repeat(64),
      flowDrift.contract,
    ),
    /Flow preimage SHA mismatch/,
  );

  const nodeDrift = makeFixture();
  nodeDrift.flow.find((node) => node.id === 'route').url = '/changed';
  assert.throws(
    () => synchronizeCommunityListPerformance(
      nodeDrift.flow,
      tail,
      nodeDrift.sourceSha,
      nodeDrift.contract,
    ),
    /contract mismatch|preimage mismatch/,
  );

  const sourceDrift = makeFixture();
  assert.throws(
    () => synchronizeCommunityListPerformance(
      sourceDrift.flow,
      `${tail}\n`,
      sourceDrift.sourceSha,
      sourceDrift.contract,
    ),
    /source contract mismatch/,
  );
});

function runPrepare(query) {
  const msg = { req: { query } };
  const execute = new Function(
    'msg',
    `const toStr = (value) => value == null || String(value).trim() === '' ? null : String(value).trim();\n`
      + `const normPhone = (value) => value == null ? null : String(value).replace(/\\D/g, '');\n`
      + tail,
  );
  const output = execute(msg);
  return { msg, output };
}

test('summary query narrows visible/member rows and omits legacy logo blobs', () => {
  const phoneDigits = ['7', '900', '000', '00', '00'].join('');
  const internationalPhone = `+${phoneDigits.slice(0, 1)} ${phoneDigits.slice(1, 4)} ${phoneDigits.slice(4, 7)}-${phoneDigits.slice(7, 9)}-${phoneDigits.slice(9)}`;
  const localPhone = `8 (${phoneDigits.slice(1, 4)}) ${phoneDigits.slice(4, 7)}-${phoneDigits.slice(7, 9)}-${phoneDigits.slice(9)}`;
  const { msg, output } = runPrepare({ view: 'summary', clientId: ' client-1 ', phone: internationalPhone });
  assert.equal(output[0], msg);
  assert.equal(msg._communityList.listMode, 'SUMMARY');
  assert.equal(msg._communityList.clientId, 'client-1');
  assert.equal(msg._communityList.phone, phoneDigits);
  assert.equal(msg.payload.archived.$ne, true);
  assert.equal(msg.payload.$or.length, 3);
  assert.deepEqual(msg.payload.$or[0], { visibility: { $not: /^\s*CLOSED\s*$/i } });
  assert.equal(msg.payload.$or[1].members.$elemMatch.$or.length, 28);
  assert.equal(msg.payload.$or[2].pendingMembers.$elemMatch.$or.length, 28);
  assert.equal(
    msg.payload.$or[1].members.$elemMatch.$or.some((filter) => filter.phone?.test?.(internationalPhone)),
    true,
  );
  assert.equal(
    msg.payload.$or[1].members.$elemMatch.$or.some((filter) => filter.phone?.test?.(localPhone)),
    true,
  );
  assert.equal(
    msg.payload.$or[1].members.$elemMatch.$or.some((filter) => filter.phone === Number(localPhone.replace(/\D/g, ''))),
    true,
  );
  assert.equal(Object.hasOwn(msg.projection, 'logo'), false);
  assert.equal(Object.hasOwn(msg.projection, 'logoLegacyDataUrl'), false);
  assert.deepEqual(msg.projection.members, msg.payload.$or[1].members);
  assert.deepEqual(msg.projection.pendingMembers, msg.payload.$or[2].pendingMembers);
});

test('anonymous summary and full mode preserve their intended access contracts', () => {
  const summary = runPrepare({ view: 'summary' }).msg;
  assert.equal(summary.payload.$or.length, 1);
  assert.equal(Object.hasOwn(summary.projection, 'members'), false);
  assert.equal(Object.hasOwn(summary.projection, 'pendingMembers'), false);

  const full = runPrepare({}).msg;
  assert.deepEqual(full.payload, { archived: { $ne: true } });
  assert.equal(Object.hasOwn(full, 'projection'), false);
});
