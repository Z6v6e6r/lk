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

export const TOURNAMENT_PREPARE_CONTRACT = Object.freeze({
  wholeFlowSha256: '6d66ef25bdb2a03a031e8be6471fd9333ff960ed980e14e7011e95c76e006a90',
  nodeCount: 4614,
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
    sourceSha256: '3dc83ec10d4faa69e901795e95982f0ebe94098f6b26fa6b92b2ce7560a22225',
    postimageNodeSha256: '13fa95ee62ffc65398ea023ae44cb154b2bddfdebe2472677cb3109e519253c2',
    type: 'function',
    z: 'f9575c8726e29196',
    name: 'Prepare tournament doc',
    outputs: 1,
    wires: [['f476ee4e8d98c43b', 'c76ac8d5319455b4', 'bf7e8b4a95f35228']],
    postimageOutputs: 2,
    postimageWires: [
      ['f476ee4e8d98c43b', 'c76ac8d5319455b4', 'bf7e8b4a95f35228'],
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
      wires: [[]],
    },
  ],
  reachableNodeIds: [
    '2d3808fb969990d4',
    '4f0f1ce8189a9e8c',
    '662c4669cc17d82a',
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

function reachableIds(flow, start) {
  const byId = new Map(flow.map((node) => [node.id, node]));
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
  }
  return [...visited].sort();
}

export function synchronizeTournamentPrepare(
  flow,
  prepareSource,
  sourceSha256,
  contract = TOURNAMENT_PREPARE_CONTRACT,
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
  if (!isDeepStrictEqual(
    reachableIds(flow, contract.route.id),
    contract.reachableNodeIds,
  )) {
    fail('Tournament prepare reachable graph mismatch');
  }
  if (
    typeof prepareSource !== 'string'
    || sha256(prepareSource) !== contract.target.sourceSha256
  ) {
    fail('Tournament prepare tracked source contract mismatch');
  }
  target.func = prepareSource;
  target.outputs = contract.target.postimageOutputs;
  target.wires = structuredClone(contract.target.postimageWires);

  const debugNodes = contract.graphNodes.filter((item) => item.type === 'debug');
  for (const item of debugNodes) {
    exactNode(flow, item.id, 'Tournament prepare debug').active = item.postimageActive;
  }
  const responseContract = contract.graphNodes.find((item) => item.type === 'http response');
  if (!responseContract) fail('Tournament prepare response contract missing');
  const responseNode = exactNode(flow, responseContract.id, 'Tournament prepare response');
  responseNode.statusCode = responseContract.postimageStatusCode;

  if (sha256Json(target) !== contract.target.postimageNodeSha256) {
    fail('Tournament prepare target postimage mismatch');
  }
  for (const item of [...debugNodes, responseContract]) {
    if (sha256Json(exactNode(flow, item.id, 'Tournament prepare approved postimage'))
      !== item.postimageNodeSha256) {
      fail(`Tournament prepare approved postimage mismatch for ${item.id}`);
    }
  }

  const changedNodes = flow.flatMap((node, index) => {
    const previous = before[index];
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
  ].sort((left, right) => left.id.localeCompare(right.id));
  if (!isDeepStrictEqual(
    [...changedNodes].sort((left, right) => left.id.localeCompare(right.id)),
    expectedChanges,
  )) {
    fail('Candidate changed nodes or fields outside tournament prepare hardening');
  }

  const afterInvariants = snapshotInvariants(flow);
  const withoutTargetWires = (items) => items.filter((item) => item.id !== contract.target.id);
  if (
    !isDeepStrictEqual(beforeInvariants.ids, afterInvariants.ids)
    || !isDeepStrictEqual(
      withoutTargetWires(beforeInvariants.wires),
      withoutTargetWires(afterInvariants.wires),
    )
    || !isDeepStrictEqual(beforeInvariants.links, afterInvariants.links)
    || !isDeepStrictEqual(beforeInvariants.routes, afterInvariants.routes)
  ) {
    fail('Candidate changed flow topology');
  }
  return {
    candidate: flow,
    changedNodes,
    invariants: {
      nodeCount: flow.length,
      httpRouteCount: afterInvariants.routes.length,
      reachableNodeCount: contract.reachableNodeIds.length,
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
