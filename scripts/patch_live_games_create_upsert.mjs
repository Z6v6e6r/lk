#!/usr/bin/env node

import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import { fileURLToPath } from 'node:url';
import { verifyWorkspace } from './verify_nodered_source_origin.mjs';

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = fs.realpathSync(path.resolve(SCRIPT_DIR, '..'));
export const CREATE_SOURCE_PATH = path.join(
  SCRIPT_DIR,
  'nodered_games_nodes/fn_create.js',
);

const ROUTES = [
  ['80cb234f44506bc6', 'LK games create', '/lk/games',
    '76d2ee586595469f85be1e6144af25041d09979bcb2ba6c3b859486dded07832'],
  ['e21acf182f861df9', 'LK games create alias', '/lk/games/records',
    '283f3b023002d6dea0b484ac9c2995866a4181c85def403e7ed8be6cd63189c4'],
  ['715662c56fc5eac6', 'LK games payment confirm', '/lk/games/payment/confirm',
    '19fcceacbe73c153b9c3db3472f5d3472695086d0ffc84bba5bb9606d8461b5d'],
  ['4d960c11d162d102', 'LK games confirm alias', '/lk/games/confirm',
    '84d644e7669306870b5edfb30900ad2023270bf5ce0672006fc6c8f3443b1fd7'],
  ['d495ad3a75867661', 'LK games draft create', '/lk/games/drafts',
    '708cf0c74382e9f25805c4a11369d381221a916dacf6e7a654c4383bc2a59a18'],
  ['38ad5b5ccb3e5b39', 'LK games draft alias', '/lk/games/draft',
    '4e4812655faf930576ae7280ea8c31dba4ad79594ec61d19665c1ae6a4e4c6f9'],
].map(([id, name, url, nodeSha256]) => ({
  id,
  type: 'http in',
  z: '4b91e2a2413688db',
  name,
  method: 'post',
  url,
  wires: [['e656cff36a8cd210']],
  nodeSha256,
}));

const GRAPH_NODES = [
  ['e656cff36a8cd210', '3f64a79ee3256d811c0e98d9cbb589a8d7cb1ff5eebf4f36a0640b1dfeba4dc0',
    '08c2b5ac7d2f5ee111efab6edb0c19c3eb663fd16e5bfa5798a1f717cc82312f'],
  ['79307f9bcbc28b6c', 'cb761b316a5ea8ace17f80ae04e67592270b33777bc0434e67526910e5d1bba1',
    'b0d21fdbd8b5e1d4c6004f1e4bce6ba2fc74a9bbf62a49937775ed301604ce06'],
  ['ae5ee70de15fe66e', '226632580cac9eeb2671d8a158cb7e1fcf509bae606a1c4ad53335b42151da93'],
  ['60a3353902ae9973', '706c3f0c8b23f93f3fb6676a11c7ea3eee6af5162e3bd405eb7b37426ffa7e88'],
  ['9756d9125563753f', '281aacfa493c31df5f336e0577dcd994e35cf119a09c1cdc40d334147bf68757',
    'ad35739c33b9583b01c5b04b4ee396f56752abedeca9c890a74273f4e490e771'],
  ['5eaf4c087c0cc668', 'efe5bcb87b5a95e6f88eb76e59d6b747ec0a37bea8e202ac86702deb9fc30c40'],
  ['ce224a53446e9a79', '85cedd87d4b5d1d6ac8f99c09efa0ef5ee4c5afa08491eda34e12133bb53f5aa'],
  ['ea34e59402d510c4', '2076208b17f0a154183651a5698ae8feae2469f7ce323055a21fed2cb1533011'],
  ['66930ded7a2eb836', 'fa5886ef9fdeb2fb04c05bf40ebbe6f985ce1a9bf3d01fe2809d83ea1103063e',
    '8d5d2547c0728d2d968d98cae382bcb11dd4a24952c256e67e4e28bf8f75b17d'],
  ['db55cbd9b66b9009', '85129afef9ce37bc630c807071abcad920b291a22768950cb8fbfbfda4f73f20',
    'e0e1e7bd925ccdfda7cf02b8582885822a889a4e82adeda7d7aa4cda68ead6f0'],
  ['2e7c4fa34ac9c12a', 'd64e76375d3ec1bb404f23e731e11d6577f8ca19efa1b699324eee67864b63d3',
    'b0d21fdbd8b5e1d4c6004f1e4bce6ba2fc74a9bbf62a49937775ed301604ce06'],
  ['b89b08776d9a67a5', '1a226b3f490838d2f33c08c609a28c43bd055109fed8a896c0ee1b7bede8a073'],
  ['2b6a41011ad0f494', 'e6d1fc02ecec7d21d136529fd38804c226a895fdda9bf223bfb5bc39acf194c4'],
  ['c031d81cb06bdc18', 'bf1f856748d862ae1ea98657665ceeaa5fe0e215999413da56b794efa6c7cfd0'],
  ['4e02d01a60d941fe', '8c74203d72c02b3f7d1e260fc0ba5631497ab5f0717aae81e4864380c0501412'],
].map(([id, nodeSha256, funcSha256]) => ({ id, nodeSha256, funcSha256 }));

export const CREATE_UPSERT_CONTRACT = Object.freeze({
  wholeFlowSha256: '6d66ef25bdb2a03a031e8be6471fd9333ff960ed980e14e7011e95c76e006a90',
  nodeCount: 4614,
  httpRouteCount: 203,
  tab: {
    id: '4b91e2a2413688db',
    type: 'tab',
    label: 'LK Games',
    disabled: false,
  },
  routes: ROUTES,
  target: {
    id: 'e656cff36a8cd210',
    type: 'function',
    z: '4b91e2a2413688db',
    name: 'Prepare game upsert',
    outputs: 4,
    wires: [
      ['79307f9bcbc28b6c'],
      ['ae5ee70de15fe66e'],
      ['60a3353902ae9973'],
      ['9756d9125563753f'],
    ],
    preimageSha256: '08c2b5ac7d2f5ee111efab6edb0c19c3eb663fd16e5bfa5798a1f717cc82312f',
    sourceSha256: '08c2b5ac7d2f5ee111efab6edb0c19c3eb663fd16e5bfa5798a1f717cc82312f',
  },
  graphNodes: GRAPH_NODES,
  reachableNodeIds: [...ROUTES.map(({ id }) => id), ...GRAPH_NODES.map(({ id }) => id)].sort(),
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

function reachableIds(flow, starts) {
  const byId = new Map(flow.map((node) => [node.id, node]));
  const visited = new Set();
  const pending = [...starts];
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

function assertNodePreimage(flow, item, description) {
  const node = exactNode(flow, item.id, description);
  if (sha256Json(node) !== item.nodeSha256) {
    fail(`${description} ${item.id} node preimage mismatch`);
  }
  if (item.funcSha256 && sha256(String(node.func ?? '')) !== item.funcSha256) {
    fail(`${description} ${item.id} function preimage mismatch`);
  }
  return node;
}

export function synchronizeCreateUpsert(
  flow,
  createSource,
  sourceSha256,
  contract = CREATE_UPSERT_CONTRACT,
) {
  if (sourceSha256 !== contract.wholeFlowSha256) fail('Flow preimage SHA mismatch');
  if (flow.length !== contract.nodeCount) fail('Flow node count mismatch');
  const tab = exactNode(flow, contract.tab.id, 'Create/upsert tab');
  for (const field of ['id', 'type', 'label', 'disabled']) {
    if (!isDeepStrictEqual(tab[field], contract.tab[field])) {
      fail(`Create/upsert tab contract mismatch for ${field}`);
    }
  }

  const before = structuredClone(flow);
  const beforeInvariants = snapshotInvariants(before);
  if (beforeInvariants.routes.length !== contract.httpRouteCount) fail('HTTP route count mismatch');

  for (const route of contract.routes) {
    const node = assertNodePreimage(flow, route, 'Create/upsert route');
    for (const field of ['id', 'type', 'z', 'name', 'method', 'url', 'wires']) {
      if (!isDeepStrictEqual(node[field], route[field])) {
        fail(`Create/upsert route ${route.id} contract mismatch for ${field}`);
      }
    }
  }
  for (const item of contract.graphNodes) {
    assertNodePreimage(flow, item, 'Create/upsert graph node');
  }
  if (!isDeepStrictEqual(
    reachableIds(flow, contract.routes.map(({ id }) => id)),
    contract.reachableNodeIds,
  )) {
    fail('Create/upsert reachable graph mismatch');
  }

  const target = exactNode(flow, contract.target.id, 'Create/upsert target');
  for (const field of ['id', 'type', 'z', 'name', 'outputs', 'wires']) {
    if (!isDeepStrictEqual(target[field], contract.target[field])) {
      fail(`Create/upsert target contract mismatch for ${field}`);
    }
  }
  if (sha256(String(target.func ?? '')) !== contract.target.preimageSha256) {
    fail('Create/upsert target function preimage mismatch');
  }
  if (
    typeof createSource !== 'string'
    || sha256(createSource) !== contract.target.sourceSha256
  ) {
    fail('Create/upsert tracked source contract mismatch');
  }
  target.func = createSource;

  const changedNodes = flow.flatMap((node, index) => {
    const previous = before[index];
    if (isDeepStrictEqual(node, previous)) return [];
    const changedFields = [...new Set([...Object.keys(previous), ...Object.keys(node)])]
      .filter((field) => !isDeepStrictEqual(previous[field], node[field]))
      .sort();
    return [{ id: node.id, changedFields }];
  });
  if (changedNodes.some((change) => (
    change.id !== contract.target.id || !isDeepStrictEqual(change.changedFields, ['func'])
  ))) {
    fail('Candidate changed nodes or fields outside the create/upsert target');
  }

  const afterInvariants = snapshotInvariants(flow);
  if (
    !isDeepStrictEqual(beforeInvariants.ids, afterInvariants.ids)
    || !isDeepStrictEqual(beforeInvariants.wires, afterInvariants.wires)
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
  const stagePrefix = `.${path.basename(directory)}.create-upsert-stage-`;
  if (fs.readdirSync(parent).some((name) => name.startsWith(stagePrefix))) {
    fail('Partial create/upsert publication exists');
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

export function readVerifiedCreateUpsertBytes(verified) {
  const bytes = fs.readFileSync(verified.sourcePath);
  if (sha256(bytes) !== verified.sourceSha256) {
    fail('Verified Node-RED source changed after verification');
  }
  return bytes;
}

export function publishCreateUpsertCandidate({
  workspace,
  output,
  report,
  contract = CREATE_UPSERT_CONTRACT,
}) {
  const verified = verifyWorkspace(workspace, { quiet: true });
  const sourceBytes = readVerifiedCreateUpsertBytes(verified);
  const paths = publicationPaths(output, report, verified.workspace);
  const createSource = fs.readFileSync(CREATE_SOURCE_PATH, 'utf8');
  const result = synchronizeCreateUpsert(
    structuredClone(verified.source),
    createSource,
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
      'Usage: node scripts/patch_live_games_create_upsert.mjs '
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
    publishCreateUpsertCandidate(parseArgs(process.argv.slice(2)));
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
