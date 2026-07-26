#!/usr/bin/env node

import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import { fileURLToPath } from 'node:url';
import { verifyWorkspace } from './verify_nodered_source_origin.mjs';

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = fs.realpathSync(path.resolve(SCRIPT_DIR, '..'));
export const TOURNAMENT_PREPARE_SOURCE_PATH = path.join(
  SCRIPT_DIR,
  'nodered_games_nodes/fn_tournament_prepare.js',
);
export const TOURNAMENT_PREPARE_A_SOURCE_PATH = path.join(
  SCRIPT_DIR,
  'nodered_games_nodes/fn_tournament_prepare_hardening_a.js',
);
export const TOURNAMENT_ACK_SOURCE_PATH = path.join(
  SCRIPT_DIR,
  'nodered_games_nodes/fn_tournament_save_ack.js',
);
export const TOURNAMENT_ERROR_SOURCE_PATH = path.join(
  SCRIPT_DIR,
  'nodered_games_nodes/fn_tournament_save_error.js',
);

export const TOURNAMENT_PREPARE_CONTRACT = Object.freeze({
  wholeFlowSha256: '6d66ef25bdb2a03a031e8be6471fd9333ff960ed980e14e7011e95c76e006a90',
  hardeningAFlowSha256: '5b82c79c229a5f5ae51d7650c4ded4ae6ffe9f860ad051a6f3f5d62cfefe0cd1',
  combinedFlowSha256: 'd9f84e4fd6b087752dc810b9fc247e3d532cc6580c19a4a822f2111ddebeca4c',
  nodeCount: 4614,
  postimageNodeCount: 4617,
  httpRouteCount: 203,
  tab: {
    id: 'f9575c8726e29196',
    type: 'tab',
    label: 'LK Tournaments',
    disabled: false,
  },
  route: {
    id: '8cab773c2cea526d',
    nodeSha256: '0ee89863d8dada754a767e5ba92595620748095861a18d54637d82a97d71a4d5',
    type: 'http in',
    z: 'f9575c8726e29196',
    name: 'LK americano (save)',
    method: 'post',
    url: '/lk/tournaments/americano',
    wires: [['4f0f1ce8189a9e8c', '662c4669cc17d82a']],
  },
  target: {
    id: '4f0f1ce8189a9e8c',
    nodeSha256: '79575aa6149032f5a8dbb94408a3e3f9121a12965ce606c30bd9633eaea03ba3',
    funcSha256: '0b9a8c577a4fb0afb6f05888c7367b5806d2917e0ffd9d39edea191b8ce27688',
    hardeningASourceSha256: '3dc83ec10d4faa69e901795e95982f0ebe94098f6b26fa6b92b2ce7560a22225',
    sourceSha256: '464c89cad0a6eef7483efbb8ff12c76e5777a324858b92cb428ad668f8e4b84f',
    hardeningANodeSha256: '13fa95ee62ffc65398ea023ae44cb154b2bddfdebe2472677cb3109e519253c2',
    postimageNodeSha256: 'a9dc252d2aac8e1997c54cf0c475ce2e944537ff7a493ca7862f88f420a077ed',
    type: 'function',
    z: 'f9575c8726e29196',
    name: 'Prepare tournament doc',
    outputs: 1,
    wires: [['f476ee4e8d98c43b', 'c76ac8d5319455b4', 'bf7e8b4a95f35228']],
    hardeningAOutputs: 2,
    hardeningAWires: [
      ['f476ee4e8d98c43b', 'c76ac8d5319455b4', 'bf7e8b4a95f35228'],
      ['c76ac8d5319455b4'],
    ],
    postimageOutputs: 2,
    postimageWires: [
      ['f476ee4e8d98c43b', 'bf7e8b4a95f35228'],
      ['c76ac8d5319455b4'],
    ],
  },
  graphNodes: [
    {
      id: '662c4669cc17d82a',
      nodeSha256: '111c3f00f185a8e32c23a53abf2903c3eaa905ef2fc7174930ebab529285fa53',
      type: 'debug',
      name: 'Americano save payload',
      active: true,
      postimageActive: false,
      postimageNodeSha256: 'c9bf3e08b8c38a90fc47bb01517b967942390a9139acb5461d100238cdd572b4',
      wires: [],
    },
    {
      id: 'f476ee4e8d98c43b',
      nodeSha256: '1203447322c10b283c1e4d8fcd23ab9385701dc850f4e4d39601a003b4ad5db2',
      funcSha256: '72e3721ade4f5d012f4f4f9f6589425467dcda49fec90e802eee2251e92426c2',
      type: 'function',
      name: 'Upsert tournament -> mongodb4 args',
      outputs: 1,
      wires: [['2d3808fb969990d4']],
    },
    {
      id: 'c76ac8d5319455b4',
      nodeSha256: 'f0010f90832e9602000df4168874bc6aa6be42f5609c9dc92b8b83b0c6db923b',
      type: 'http response',
      name: '',
      statusCode: '200',
      postimageStatusCode: '',
      postimageNodeSha256: 'c21521c45bdc38ec41c3653503fb0d249429cb382f5f2f36566bde747a23f51d',
      wires: [],
    },
    {
      id: 'bf7e8b4a95f35228',
      nodeSha256: '53709a942cc68ba319f552f62c4739acea6719bde946a3ff9160b13ac9d95907',
      type: 'debug',
      name: 'Americano save payload',
      active: true,
      postimageActive: false,
      postimageNodeSha256: '1f63ff59a8a39a3c03a747a17c697a900eb14996ac261f27f356913bf3e37d12',
      wires: [],
    },
    {
      id: '2d3808fb969990d4',
      nodeSha256: '77050624f5e45b4219bb853cd2f7b6155326a12427b409df8769826cb82229e3',
      type: 'mongodb4',
      name: 'Upsert tournament',
      clientNode: '4e820638cc39c730',
      mode: 'collection',
      collection: 'tournaments',
      operation: 'updateOne',
      output: 'toArray',
      maxTimeMS: '0',
      handleDocId: false,
      postimageWires: [['745f991e11130b08']],
      postimageNodeSha256: '65821b73c0aad425ecc980cb2cc4d329f587fcc69421dc5dd214b66cb4318215',
      wires: [[]],
    },
  ],
  newNodes: [
    {
      id: '745f991e11130b08',
      nodeSha256: '8cf84e44a0abe519a78936af5cbfabf111b46c1ee8c0c9956ba7daf9b4ee7da1',
      funcSha256: '3099494d8ed9f3e4aa40473e23c3abc4bf5d00002370da046b023881acae2afc',
      sourcePath: 'ack',
      type: 'function',
      z: 'f9575c8726e29196',
      name: 'Build tournament save acknowledgement',
      outputs: 1,
      timeout: '',
      noerr: 0,
      initialize: '',
      finalize: '',
      libs: [],
      x: 1210,
      y: 1340,
      wires: [['c76ac8d5319455b4']],
    },
    {
      id: 'f9a12e4068858809',
      nodeSha256: 'f4d55887a7ba47174b4e26c4d27c5fad74c95b5132676ec3f5f0b85f905e9413',
      type: 'catch',
      z: 'f9575c8726e29196',
      name: 'Catch tournament save persistence failure',
      scope: ['2d3808fb969990d4'],
      uncaught: false,
      x: 970,
      y: 1420,
      wires: [['fae579ef6d10446d']],
    },
    {
      id: 'fae579ef6d10446d',
      nodeSha256: '7af1c999508c6f06227bce9602e82245c7a9e30dec2275d1b5babf3d02397d62',
      funcSha256: 'c55c9bb81bb4b41bc3a6ad3300d9821985e015220d06dac24512cc165e8412be',
      sourcePath: 'error',
      type: 'function',
      z: 'f9575c8726e29196',
      name: 'Build tournament save persistence error',
      outputs: 1,
      timeout: '',
      noerr: 0,
      initialize: '',
      finalize: '',
      libs: [],
      x: 1240,
      y: 1420,
      wires: [['c76ac8d5319455b4']],
    },
  ],
  reachableNodeIds: [
    '2d3808fb969990d4',
    '4f0f1ce8189a9e8c',
    '662c4669cc17d82a',
    '745f991e11130b08',
    '8cab773c2cea526d',
    'bf7e8b4a95f35228',
    'c76ac8d5319455b4',
    'f476ee4e8d98c43b',
    'f9a12e4068858809',
    'fae579ef6d10446d',
  ],
  wireReachableNodeIds: [
    '2d3808fb969990d4',
    '4f0f1ce8189a9e8c',
    '662c4669cc17d82a',
    '745f991e11130b08',
    '8cab773c2cea526d',
    'bf7e8b4a95f35228',
    'c76ac8d5319455b4',
    'f476ee4e8d98c43b',
  ],
});

function fail(message) {
  throw new Error(message);
}

function sha256(value) {
  return crypto.createHash('sha256').update(value).digest('hex');
}

function sha256Json(value) {
  return sha256(Buffer.from(JSON.stringify(value), 'utf8'));
}

function exactNode(flow, id, description) {
  const matches = flow.filter((node) => node?.id === id);
  if (matches.length !== 1) fail(`${description} ${id} must exist exactly once`);
  return matches[0];
}

function assertFields(node, contract, fields, description) {
  for (const field of fields) {
    if (!isDeepStrictEqual(node?.[field], contract[field])) {
      fail(`${description} ${contract.id} contract mismatch for ${field}`);
    }
  }
  if (sha256Json(node) !== contract.nodeSha256) {
    fail(`${description} ${contract.id} node preimage mismatch`);
  }
  if (contract.funcSha256 && sha256(String(node.func ?? '')) !== contract.funcSha256) {
    fail(`${description} ${contract.id} function preimage mismatch`);
  }
}

function snapshotInvariants(flow) {
  const ids = flow.map((node) => node.id);
  if (new Set(ids).size !== ids.length) fail('Flow contains duplicate node IDs');
  const wires = flow.map((node) => ({
    id: node.id,
    wires: Object.hasOwn(node, 'wires') ? node.wires : null,
  }));
  const links = flow.map((node) => ({
    id: node.id,
    links: Object.hasOwn(node, 'links') ? node.links : null,
  }));
  const routes = flow
    .filter((node) => node.type === 'http in')
    .map((node) => ({
      id: node.id,
      z: node.z ?? '',
      method: node.method ?? '',
      url: node.url ?? '',
      name: node.name ?? '',
      wires: node.wires ?? null,
    }));
  return {
    ids,
    wires,
    links,
    routes,
    hashes: {
      idsSha256: sha256Json(ids),
      wiresSha256: sha256Json(wires),
      linksSha256: sha256Json(links),
      httpRoutesSha256: sha256Json(routes),
    },
  };
}

function reachableIds(flow, start, includeScopedCatch = true) {
  const byId = new Map(flow.map((node) => [node.id, node]));
  const catchNodes = flow.filter((node) => node.type === 'catch');
  const visited = new Set();
  const pending = [start];
  while (pending.length) {
    const id = pending.shift();
    if (visited.has(id)) continue;
    visited.add(id);
    const node = byId.get(id);
    if (!node) fail(`Reachable graph references missing node ${id}`);
    for (const output of node.wires ?? []) {
      for (const next of output ?? []) pending.push(next);
    }
    if (includeScopedCatch) {
      for (const catchNode of catchNodes) {
        if (Array.isArray(catchNode.scope) && catchNode.scope.includes(id)) {
          pending.push(catchNode.id);
        }
      }
    }
  }
  return [...visited].sort();
}

export function synchronizeTournamentPrepare(
  flow,
  prepareSource,
  sourceSha256,
  contract = TOURNAMENT_PREPARE_CONTRACT,
  cohortSources = {
    hardeningA: fs.readFileSync(TOURNAMENT_PREPARE_A_SOURCE_PATH, 'utf8'),
    ack: fs.readFileSync(TOURNAMENT_ACK_SOURCE_PATH, 'utf8'),
    error: fs.readFileSync(TOURNAMENT_ERROR_SOURCE_PATH, 'utf8'),
  },
) {
  if (sourceSha256 !== contract.wholeFlowSha256) fail('Flow preimage SHA mismatch');
  if (flow.length !== contract.nodeCount) fail('Flow node count mismatch');
  const tab = exactNode(flow, contract.tab.id, 'Tournament prepare tab');
  for (const field of ['id', 'type', 'label', 'disabled']) {
    if (!isDeepStrictEqual(tab[field], contract.tab[field])) {
      fail(`Tournament prepare tab contract mismatch for ${field}`);
    }
  }

  const before = structuredClone(flow);
  const beforeInvariants = snapshotInvariants(before);
  if (beforeInvariants.routes.length !== contract.httpRouteCount) fail('HTTP route count mismatch');

  assertFields(
    exactNode(flow, contract.route.id, 'Tournament prepare route'),
    contract.route,
    ['id', 'type', 'z', 'name', 'method', 'url', 'wires'],
    'Tournament prepare route',
  );
  const target = exactNode(flow, contract.target.id, 'Tournament prepare target');
  assertFields(
    target,
    contract.target,
    ['id', 'type', 'z', 'name', 'outputs', 'wires'],
    'Tournament prepare target',
  );
  for (const item of contract.graphNodes) {
    const node = exactNode(flow, item.id, 'Tournament prepare graph node');
    const fields = ['id', 'type', 'name', 'wires'];
    if (item.type === 'function') fields.push('outputs');
    if (item.type === 'debug') fields.push('active');
    if (item.type === 'http response') fields.push('statusCode');
    if (item.type === 'mongodb4') {
      fields.push(
        'clientNode', 'mode', 'collection', 'operation',
        'output', 'maxTimeMS', 'handleDocId',
      );
    }
    assertFields(node, item, fields, 'Tournament prepare graph node');
  }
  if (
    typeof prepareSource !== 'string'
    || sha256(prepareSource) !== contract.target.sourceSha256
  ) {
    fail('Tournament prepare tracked source contract mismatch');
  }
  if (
    typeof cohortSources.hardeningA !== 'string'
    || sha256(cohortSources.hardeningA) !== contract.target.hardeningASourceSha256
  ) {
    fail('Tournament prepare hardening A source contract mismatch');
  }
  const ackContract = contract.newNodes.find((item) => item.sourcePath === 'ack');
  const errorContract = contract.newNodes.find((item) => item.sourcePath === 'error');
  if (
    !ackContract
    || typeof cohortSources.ack !== 'string'
    || sha256(cohortSources.ack) !== ackContract.funcSha256
  ) {
    fail('Tournament acknowledgement source contract mismatch');
  }
  if (
    !errorContract
    || typeof cohortSources.error !== 'string'
    || sha256(cohortSources.error) !== errorContract.funcSha256
  ) {
    fail('Tournament persistence error source contract mismatch');
  }
  for (const item of contract.newNodes) {
    if (flow.some((node) => node.id === item.id)) {
      fail(`Tournament hardening node ID collision for ${item.id}`);
    }
  }

  target.func = cohortSources.hardeningA;
  target.outputs = contract.target.hardeningAOutputs;
  target.wires = structuredClone(contract.target.hardeningAWires);

  const debugNodes = contract.graphNodes.filter((item) => item.type === 'debug');
  for (const item of debugNodes) {
    exactNode(flow, item.id, 'Tournament prepare debug').active = item.postimageActive;
  }
  const responseContract = contract.graphNodes.find((item) => item.type === 'http response');
  if (!responseContract) fail('Tournament prepare response contract missing');
  const responseNode = exactNode(flow, responseContract.id, 'Tournament prepare response');
  responseNode.statusCode = responseContract.postimageStatusCode;

  if (sha256Json(target) !== contract.target.hardeningANodeSha256) {
    fail('Tournament prepare hardening A target mismatch');
  }
  for (const item of [...debugNodes, responseContract]) {
    if (sha256Json(exactNode(flow, item.id, 'Tournament prepare approved postimage'))
      !== item.postimageNodeSha256) {
      fail(`Tournament prepare approved postimage mismatch for ${item.id}`);
    }
  }
  const hardeningABytes = Buffer.from(`${JSON.stringify(flow, null, 2)}\n`, 'utf8');
  if (sha256(hardeningABytes) !== contract.hardeningAFlowSha256) {
    fail('Tournament prepare hardening A intermediate flow mismatch');
  }

  target.func = prepareSource;
  target.outputs = contract.target.postimageOutputs;
  target.wires = structuredClone(contract.target.postimageWires);
  if (sha256Json(target) !== contract.target.postimageNodeSha256) {
    fail('Tournament prepare combined target postimage mismatch');
  }

  const mongoContract = contract.graphNodes.find((item) => item.type === 'mongodb4');
  if (!mongoContract) fail('Tournament prepare Mongo contract missing');
  const mongoNode = exactNode(flow, mongoContract.id, 'Tournament prepare Mongo');
  mongoNode.wires = structuredClone(mongoContract.postimageWires);
  if (sha256Json(mongoNode) !== mongoContract.postimageNodeSha256) {
    fail('Tournament prepare Mongo postimage mismatch');
  }

  const makeNewNode = (item) => {
    if (item.type === 'catch') {
      return {
        id: item.id,
        type: item.type,
        z: item.z,
        name: item.name,
        scope: structuredClone(item.scope),
        uncaught: item.uncaught,
        x: item.x,
        y: item.y,
        wires: structuredClone(item.wires),
      };
    }
    const func = item.sourcePath === 'ack' ? cohortSources.ack : cohortSources.error;
    return {
      id: item.id,
      type: item.type,
      z: item.z,
      name: item.name,
      func,
      outputs: item.outputs,
      timeout: item.timeout,
      noerr: item.noerr,
      initialize: item.initialize,
      finalize: item.finalize,
      libs: structuredClone(item.libs),
      x: item.x,
      y: item.y,
      wires: structuredClone(item.wires),
    };
  };
  for (const item of contract.newNodes) {
    const node = makeNewNode(item);
    if (sha256Json(node) !== item.nodeSha256) {
      fail(`Tournament hardening new node postimage mismatch for ${item.id}`);
    }
    flow.push(node);
  }
  if (flow.length !== contract.postimageNodeCount) fail('Candidate node count mismatch');
  if (!isDeepStrictEqual(
    reachableIds(flow, contract.route.id),
    contract.reachableNodeIds,
  )) {
    fail('Tournament prepare reachable graph mismatch');
  }
  if (!isDeepStrictEqual(
    reachableIds(flow, contract.route.id, false),
    contract.wireReachableNodeIds,
  )) {
    fail('Tournament prepare wire-reachable graph mismatch');
  }

  const beforeById = new Map(before.map((node) => [node.id, node]));
  const changedNodes = flow.flatMap((node) => {
    const previous = beforeById.get(node.id);
    if (!previous) return [{ id: node.id, changedFields: ['$added'] }];
    if (isDeepStrictEqual(node, previous)) return [];
    const changedFields = [...new Set([...Object.keys(previous), ...Object.keys(node)])]
      .filter((field) => !isDeepStrictEqual(previous[field], node[field]))
      .sort();
    return [{ id: node.id, changedFields }];
  });
  const expectedChanges = [
    { id: contract.target.id, changedFields: ['func', 'outputs', 'wires'] },
    ...debugNodes.map((item) => ({ id: item.id, changedFields: ['active'] })),
    { id: responseContract.id, changedFields: ['statusCode'] },
    { id: mongoContract.id, changedFields: ['wires'] },
    ...contract.newNodes.map((item) => ({ id: item.id, changedFields: ['$added'] })),
  ].sort((left, right) => left.id.localeCompare(right.id));
  if (!isDeepStrictEqual(
    [...changedNodes].sort((left, right) => left.id.localeCompare(right.id)),
    expectedChanges,
  )) {
    fail('Candidate changed nodes or fields outside tournament prepare hardening');
  }

  const afterInvariants = snapshotInvariants(flow);
  const approvedWireIds = new Set([contract.target.id, mongoContract.id]);
  const existingOnly = (items) => items.filter((item) => beforeById.has(item.id));
  const withoutApprovedWires = (items) => existingOnly(items)
    .filter((item) => !approvedWireIds.has(item.id));
  if (
    !isDeepStrictEqual(
      beforeInvariants.ids,
      afterInvariants.ids.filter((id) => beforeById.has(id)),
    )
    || !isDeepStrictEqual(
      withoutApprovedWires(beforeInvariants.wires),
      withoutApprovedWires(afterInvariants.wires),
    )
    || !isDeepStrictEqual(beforeInvariants.links, existingOnly(afterInvariants.links))
    || !isDeepStrictEqual(beforeInvariants.routes, afterInvariants.routes)
  ) {
    fail('Candidate changed flow topology');
  }
  const combinedBytes = Buffer.from(`${JSON.stringify(flow, null, 2)}\n`, 'utf8');
  if (sha256(combinedBytes) !== contract.combinedFlowSha256) {
    fail('Tournament prepare combined flow postimage mismatch');
  }
  return {
    candidate: flow,
    changedNodes,
    invariants: {
      nodeCount: flow.length,
      httpRouteCount: afterInvariants.routes.length,
      reachableNodeCount: contract.reachableNodeIds.length,
      wireReachableNodeCount: contract.wireReachableNodeIds.length,
      catchSupportNodeCount:
        contract.reachableNodeIds.length - contract.wireReachableNodeIds.length,
      ...afterInvariants.hashes,
    },
  };
}

function isWithin(parent, candidate) {
  const relative = path.relative(parent, candidate);
  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
}

function publicationPaths(outputArg, reportArg, workspace) {
  if (!path.isAbsolute(outputArg) || !path.isAbsolute(reportArg)) {
    fail('Output and report paths must be absolute');
  }
  if (path.resolve(outputArg) === path.resolve(reportArg)) fail('Output and report must be distinct');
  const directory = path.dirname(path.resolve(outputArg));
  if (path.dirname(path.resolve(reportArg)) !== directory) {
    fail('Output and report must share one new publication directory');
  }
  const parentArg = path.dirname(directory);
  if (fs.existsSync(directory) || fs.lstatSync(parentArg).isSymbolicLink()) {
    fail('Publication directory must not already exist or use a symlink parent');
  }
  const parent = fs.realpathSync(parentArg);
  const canonicalDirectory = path.join(parent, path.basename(directory));
  const output = path.join(canonicalDirectory, path.basename(outputArg));
  const report = path.join(canonicalDirectory, path.basename(reportArg));
  if (canonicalDirectory !== directory || output !== outputArg || report !== reportArg) {
    fail('Output and report paths must be canonical');
  }
  if (isWithin(REPO_ROOT, directory)) fail('Publication directory must be outside the repository');
  if (isWithin(path.join(workspace, 'input'), directory)) {
    fail('Publication directory must not alias the verified input');
  }
  const stagePrefix = `.${path.basename(directory)}.tournament-prepare-stage-`;
  if (fs.readdirSync(parent).some((name) => name.startsWith(stagePrefix))) {
    fail('Partial tournament prepare publication exists');
  }
  return { directory, parent, output, report, stagePrefix };
}

function writePrivate(filePath, value) {
  const descriptor = fs.openSync(
    filePath,
    fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_WRONLY,
    0o600,
  );
  try {
    fs.writeFileSync(descriptor, value);
    fs.fsyncSync(descriptor);
  } finally {
    fs.closeSync(descriptor);
  }
}

export function readVerifiedTournamentPrepareBytes(verified) {
  const bytes = fs.readFileSync(verified.sourcePath);
  if (sha256(bytes) !== verified.sourceSha256) {
    fail('Verified Node-RED source changed after verification');
  }
  return bytes;
}

export function publishTournamentPrepareCandidate({
  workspace,
  output,
  report,
  contract = TOURNAMENT_PREPARE_CONTRACT,
}) {
  const verified = verifyWorkspace(workspace, { quiet: true });
  const sourceBytes = readVerifiedTournamentPrepareBytes(verified);
  const paths = publicationPaths(output, report, verified.workspace);
  const prepareSource = fs.readFileSync(TOURNAMENT_PREPARE_SOURCE_PATH, 'utf8');
  const result = synchronizeTournamentPrepare(
    structuredClone(verified.source),
    prepareSource,
    verified.sourceSha256,
    contract,
  );
  const candidateBytes = result.changedNodes.length === 0
    ? sourceBytes
    : Buffer.from(`${JSON.stringify(result.candidate, null, 2)}\n`, 'utf8');
  const candidateSha256 = sha256(candidateBytes);
  const redactedReport = {
    formatVersion: 1,
    ok: true,
    sourceSha256: verified.sourceSha256,
    candidateSha256,
    changedNodeCount: result.changedNodes.length,
    changedNodes: result.changedNodes,
    invariants: result.invariants,
  };
  const stage = path.join(
    paths.parent,
    `${paths.stagePrefix}${process.pid}-${crypto.randomUUID()}`,
  );
  fs.mkdirSync(stage, { mode: 0o700 });
  try {
    writePrivate(path.join(stage, path.basename(paths.output)), candidateBytes);
    writePrivate(
      path.join(stage, path.basename(paths.report)),
      Buffer.from(`${JSON.stringify(redactedReport, null, 2)}\n`),
    );
    fs.renameSync(stage, paths.directory);
  } catch (error) {
    fs.rmSync(stage, { recursive: true, force: true });
    throw error;
  }
  console.log(`sourceSha256=${verified.sourceSha256}`);
  console.log(`candidateSha256=${candidateSha256}`);
  console.log(`nodeCount=${result.invariants.nodeCount}`);
  console.log(`httpRouteCount=${result.invariants.httpRouteCount}`);
  console.log(`reachableNodeCount=${result.invariants.reachableNodeCount}`);
  console.log(`changedNodeCount=${result.changedNodes.length}`);
  return redactedReport;
}

function parseArgs(argv) {
  const values = {};
  for (let index = 0; index < argv.length; index += 2) {
    const key = argv[index];
    const value = argv[index + 1];
    if (!key?.startsWith('--') || !value || value.startsWith('--')) {
      fail(`Invalid argument: ${key ?? ''}`);
    }
    if (Object.hasOwn(values, key)) fail(`Duplicate argument: ${key}`);
    values[key] = value;
  }
  const allowed = new Set(['--workspace', '--output', '--report']);
  for (const key of Object.keys(values)) if (!allowed.has(key)) fail(`Unknown argument: ${key}`);
  if (!values['--workspace'] || !values['--output'] || !values['--report']) {
    fail(
      'Usage: node scripts/patch_live_tournament_prepare.mjs '
      + '--workspace /absolute/external/workspace '
      + '--output /absolute/new-publication/candidate.json '
      + '--report /absolute/new-publication/report.json',
    );
  }
  return {
    workspace: values['--workspace'],
    output: values['--output'],
    report: values['--report'],
  };
}

const invokedPath = process.argv[1] ? fs.realpathSync(process.argv[1]) : '';
if (invokedPath === fileURLToPath(import.meta.url)) {
  try {
    publishTournamentPrepareCandidate(parseArgs(process.argv.slice(2)));
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
