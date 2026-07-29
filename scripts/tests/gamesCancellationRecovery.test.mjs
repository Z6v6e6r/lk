import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import test from 'node:test';
import {
  CANCELLATION_CONTRACT,
  CANCELLATION_SOURCE_PATHS,
  synchronizeCancellation,
} from '../patch_live_games_cancellation.mjs';

function sha256(value) {
  return crypto.createHash('sha256').update(value).digest('hex');
}

function sha256Json(value) {
  return sha256(Buffer.from(JSON.stringify(value), 'utf8'));
}

function fixture() {
  const contract = structuredClone(CANCELLATION_CONTRACT);
  const tab = { ...contract.tab, info: '' };
  const buildRoute = (routeContract) => ({
    id: routeContract.id,
    type: routeContract.type,
    z: routeContract.z,
    name: routeContract.name,
    method: routeContract.method,
    url: routeContract.url,
    upload: false,
    swaggerDoc: '',
    wires: structuredClone(routeContract.wires),
  });
  const route = buildRoute(contract.route);
  const leaveRoute = buildRoute(contract.leaveRoute);
  const targets = contract.targets.map((target, index) => ({
    id: target.id,
    type: 'function',
    z: contract.tab.id,
    name: `Target ${target.key}`,
    func: `return msg; // preimage-${target.key}`,
    outputs: index === 2 ? 4 : 3,
    wires: [[]],
  }));
  const response = {
    id: 'dfaa7a139e9538c8',
    type: 'http response',
    z: contract.tab.id,
    name: '',
    wires: [],
  };
  const debug = {
    id: 'ba322f367a4d4fcd',
    type: 'debug',
    z: contract.tab.id,
    name: 'cleanup debug',
    active: false,
    wires: [],
  };
  const leaveResponse = {
    id: '35f7c89069fc393a',
    type: 'http response',
    z: contract.tab.id,
    name: '',
    wires: [],
  };
  const leaveDebug = {
    id: 'cf731009d4167f78',
    type: 'debug',
    z: contract.tab.id,
    name: 'leave debug',
    active: false,
    wires: [],
  };
  const leaveRequest = {
    id: '52af61191cdbe9ef',
    type: 'http request',
    z: contract.tab.id,
    name: 'leave request',
    wires: [[]],
  };
  const flow = [
    tab,
    route,
    leaveRoute,
    ...targets,
    response,
    debug,
    leaveResponse,
    leaveDebug,
    leaveRequest,
  ];
  contract.wholeFlowSha256 = 'fixture-source';
  contract.nodeCount = flow.length;
  contract.candidateNodeCount = flow.length + contract.addedNodeIds.length;
  contract.httpRouteCount = 2;
  contract.route.nodeSha256 = sha256Json(route);
  contract.leaveRoute.nodeSha256 = sha256Json(leaveRoute);
  contract.targets.forEach((target) => {
    const node = flow.find((candidate) => candidate.id === target.id);
    target.nodeSha256 = sha256Json(node);
    target.funcSha256 = sha256(node.func);
    target.sourceSha256 = sha256(
      fs.readFileSync(CANCELLATION_SOURCE_PATHS[target.key], 'utf8'),
    );
  });
  contract.addedSourceSha256 = {
    authPrepare: sha256(
      fs.readFileSync(CANCELLATION_SOURCE_PATHS.authPrepare, 'utf8'),
    ),
    authResolve: sha256(
      fs.readFileSync(CANCELLATION_SOURCE_PATHS.authResolve, 'utf8'),
    ),
    leaveAuthorize: sha256(
      fs.readFileSync(CANCELLATION_SOURCE_PATHS.leaveAuthorize, 'utf8'),
    ),
  };
  return { contract, flow };
}

test('guarded cancellation patch changes only the two cancellation graphs', () => {
  const built = fixture();
  const result = synchronizeCancellation(
    structuredClone(built.flow),
    built.contract.wholeFlowSha256,
    built.contract,
  );

  assert.equal(result.changedNodes.length, 15);
  assert.deepEqual(
    result.changedNodes.map((change) => [change.id, change.changedFields]),
    [
      [built.contract.route.id, ['wires']],
      [built.contract.leaveRoute.id, ['wires']],
      ...built.contract.targets.map((target) => [
        target.id,
        target.allowedFields || ['func'],
      ]),
      ...built.contract.addedNodeIds.map((id) => [id, ['added']]),
    ],
  );
  const route = result.candidate.find((node) => node.id === built.contract.route.id);
  assert.deepEqual(route.wires, [[built.contract.addedNodeIds[0]]]);
  const leaveRoute = result.candidate.find((node) => node.id === built.contract.leaveRoute.id);
  assert.deepEqual(leaveRoute.wires, [[built.contract.addedNodeIds[3]]]);
  assert.equal(result.invariants.httpRouteCount, 2);
});

test('guarded cancellation patch rejects route drift before generating a candidate', () => {
  const built = fixture();
  built.flow.find((node) => node.id === built.contract.route.id).url = '/lk/games/wrong';

  assert.throws(
    () => synchronizeCancellation(
      built.flow,
      built.contract.wholeFlowSha256,
      built.contract,
    ),
    /route preimage mismatch/,
  );
});

test('tracked cancellation router contains the HAR End User contract and no generic Admin booking route', () => {
  const source = fs.readFileSync(CANCELLATION_SOURCE_PATHS.router, 'utf8');
  assert.match(source, /END_USER_API/);
  assert.match(source, /scope: "end_user"/);
  assert.match(source, /endUserPayload: \{\}/);
  assert.match(source, /adminRefundMethod: "SERVICE"/);
  assert.doesNotMatch(source, /ADMIN_API\}\$\{`?\/bookings/);
  assert.doesNotMatch(source, /path: `\/bookings\/\$\{encodedId\}`,[\s\S]{0,120}scope: "admin"/);
  const leaveSource = fs.readFileSync(CANCELLATION_SOURCE_PATHS.leaveRouter, 'utf8');
  assert.match(leaveSource, /cancelExercise: false/);
  assert.match(leaveSource, /cancel_booking_verified_cancelled/);
  assert.doesNotMatch(leaveSource, /api\/v1\/bookings/);
  assert.doesNotMatch(leaveSource, /path: `\/bookings\//);
});
