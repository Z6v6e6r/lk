#!/usr/bin/env node

import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import { fileURLToPath } from 'node:url';
import { verifyWorkspace } from './verify_nodered_source_origin.mjs';

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = fs.realpathSync(path.resolve(SCRIPT_DIR, '..'));
const QUERY_SOURCE_PATH = path.join(
  SCRIPT_DIR,
  'nodered_games_nodes/fn_get_by_id_query.js',
);
const RESPONSE_SOURCE_PATH = path.join(
  SCRIPT_DIR,
  'nodered_games_nodes/fn_get_by_id_resp.js',
);
const LIST_NORMALIZER_SOURCE_PATH = path.join(
  SCRIPT_DIR,
  'nodered_games_nodes/fn_list_normalize.js',
);

export const DIRECT_LOOKUP_CONTRACT = Object.freeze({
  wholeFlowSha256: '14b5aff65e0b49fd4f37d6d1d9465af8af3ccdf2e6cfa77bc76b4a9f2a831350',
  nodeCount: 4762,
  httpRouteCount: 215,
  tab: {
    id: '4b91e2a2413688db',
    type: 'tab',
    label: 'LK Games',
    disabled: false,
  },
  routes: [
    {
      id: 'afc9bf23bcc54804',
      nodeSha256: '5d2a0f4fbbbb03ca23ea7ff94f11fa21c9243f9db5902e966775140f520c47eb',
      type: 'http in',
      z: '4b91e2a2413688db',
      name: 'LK game by id',
      method: 'get',
      url: '/lk/games/:gameId',
      wires: [['b6bc67d99744e060']],
    },
    {
      id: '2cbeac53cecb3971',
      nodeSha256: '6c9858d191abff86613832fa163bfc7dfd84a45a8e32534b4f93be5ce9e1f2ff',
      type: 'http in',
      z: '4b91e2a2413688db',
      name: 'LK game by id alias',
      method: 'get',
      url: '/lk/games/records/:gameId',
      wires: [['b6bc67d99744e060']],
    },
  ],
  query: {
    id: 'b6bc67d99744e060',
    nodeSha256: '63b3131f2f725b407374751781886b9504d408ea006994dcaca61f08973c25d1',
    type: 'function',
    z: '4b91e2a2413688db',
    name: 'Build game by id query',
    outputs: 2,
    wires: [['8b64bb43086a39e1'], ['7b893cc97a815f66']],
    preimageSha256: 'eb771a2cf6f4f8e1fa71cca0aae253462fb47a397c4b91bca6f5f0e0006a69f6',
    sourceSha256: 'eb771a2cf6f4f8e1fa71cca0aae253462fb47a397c4b91bca6f5f0e0006a69f6',
  },
  mongo: {
    id: '8b64bb43086a39e1',
    nodeSha256: 'b6d383271f2cbb545f6ce2b67102dc5e6abc2201cdfb6666fcdd991f2fc0b7c8',
    type: 'mongodb4',
    z: '4b91e2a2413688db',
    name: 'Find lk game by id',
    clientNode: '4e820638cc39c730',
    mode: 'collection',
    collection: 'lk_games',
    operation: 'find',
    output: 'toArray',
    maxTimeMS: '0',
    handleDocId: false,
    wires: [['d44d0fcf9250927f']],
  },
  response: {
    id: 'd44d0fcf9250927f',
    nodeSha256: 'e7b8ec038569f143589963861c8ddfd92b808e42d3ccccfd8a08ac0d50fa23e4',
    preimageSha256: 'dd2be64ed8e2ff42a951a799ee72b18e13e98486d3b06a24d55a872023979b68',
    sourceSha256: '6456ce747d8533e27996b693621f85c0cd7264153c010bb5e000421f16f904be',
    type: 'function',
    z: '4b91e2a2413688db',
    name: 'Build game by id response',
    outputs: 2,
    wires: [['7b893cc97a815f66'], ['c45153b02914e7e4']],
  },
  listNormalizer: {
    id: '0485dea01865b2dd',
    nodeSha256: '098436c2d89299cfe26e4156ceef84ed15d3c7e3bf54c0fb0cab6cc5b8511546',
    preimageSha256: '33d5252688c6f25ab61ef9b3ad157b2ae970bc8d8b60e4264d30dac0a5296172',
    sourceSha256: '355db4a4ea94e4fab1ff5918842eeb891e4bca0f4b9e0e6a3f8a080b6b8692c7',
    type: 'function',
    z: '4b91e2a2413688db',
    name: 'Dedupe + normalize upcoming games',
    outputs: 2,
    wires: [['7b8f8065271f5b4c'], ['62b2b0e16ed306e7']],
  },
  httpResponse: {
    id: '7b893cc97a815f66',
    nodeSha256: '12b5520f54b2a796fac3d98794f9650b67e4f596f8bf29d8e71d568601432d0a',
    type: 'http response',
    z: '4b91e2a2413688db',
    name: '',
    wires: [],
  },
  diagnostic: {
    id: 'c45153b02914e7e4',
    nodeSha256: '6683cad144c10ffdc0fc0e8d55dee784edf0fb766af7bb290144ff4152ea3ab6',
    type: 'debug',
    z: '4b91e2a2413688db',
    name: 'lk game by id debug',
    active: false,
    wires: [],
  },
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

function assertNode(node, contract, fields, description) {
  for (const field of fields) {
    if (!isDeepStrictEqual(node?.[field], contract[field])) {
      fail(`${description} ${contract.id} contract mismatch for ${field}`);
    }
  }
  if (sha256Json(node) !== contract.nodeSha256) {
    fail(`${description} ${contract.id} node preimage mismatch`);
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

export function synchronizeDirectLookup(
  flow,
  querySource,
  responseSource,
  listNormalizerSource,
  sourceSha256,
  contract = DIRECT_LOOKUP_CONTRACT,
) {
  if (sourceSha256 !== contract.wholeFlowSha256) fail('Flow preimage SHA mismatch');
  if (flow.length !== contract.nodeCount) fail('Flow node count mismatch');
  const tab = exactNode(flow, contract.tab.id, 'Direct lookup tab');
  for (const field of ['id', 'type', 'label', 'disabled']) {
    if (!isDeepStrictEqual(tab[field], contract.tab[field])) {
      fail(`Direct lookup tab contract mismatch for ${field}`);
    }
  }

  const before = structuredClone(flow);
  const beforeInvariants = snapshotInvariants(before);
  if (beforeInvariants.routes.length !== contract.httpRouteCount) fail('HTTP route count mismatch');

  for (const route of contract.routes) {
    assertNode(
      exactNode(flow, route.id, 'Direct lookup route'),
      route,
      ['id', 'type', 'z', 'name', 'method', 'url', 'wires'],
      'Direct lookup route',
    );
  }
  const query = exactNode(flow, contract.query.id, 'Direct lookup query');
  assertNode(
    query,
    contract.query,
    ['id', 'type', 'z', 'name', 'outputs', 'wires'],
    'Direct lookup query',
  );
  const mongo = exactNode(flow, contract.mongo.id, 'Direct lookup mongo');
  assertNode(
    mongo,
    contract.mongo,
    [
      'id', 'type', 'z', 'name', 'clientNode', 'mode', 'collection',
      'operation', 'output', 'maxTimeMS', 'handleDocId', 'wires',
    ],
    'Direct lookup mongo',
  );
  const response = exactNode(flow, contract.response.id, 'Direct lookup response');
  assertNode(
    response,
    contract.response,
    ['id', 'type', 'z', 'name', 'outputs', 'wires'],
    'Direct lookup response',
  );
  if (sha256(String(response.func ?? '')) !== contract.response.preimageSha256) {
    fail('Direct lookup response function preimage mismatch');
  }
  if (
    typeof responseSource !== 'string'
    || sha256(responseSource) !== contract.response.sourceSha256
  ) {
    fail('Direct lookup response source contract mismatch');
  }
  const listNormalizer = exactNode(flow, contract.listNormalizer.id, 'Games list normalizer');
  assertNode(
    listNormalizer,
    contract.listNormalizer,
    ['id', 'type', 'z', 'name', 'outputs', 'wires'],
    'Games list normalizer',
  );
  if (sha256(String(listNormalizer.func ?? '')) !== contract.listNormalizer.preimageSha256) {
    fail('Games list normalizer function preimage mismatch');
  }
  if (
    typeof listNormalizerSource !== 'string'
    || sha256(listNormalizerSource) !== contract.listNormalizer.sourceSha256
  ) {
    fail('Games list normalizer source contract mismatch');
  }
  assertNode(
    exactNode(flow, contract.httpResponse.id, 'Direct lookup HTTP response'),
    contract.httpResponse,
    ['id', 'type', 'z', 'name', 'wires'],
    'Direct lookup HTTP response',
  );
  assertNode(
    exactNode(flow, contract.diagnostic.id, 'Direct lookup diagnostic'),
    contract.diagnostic,
    ['id', 'type', 'z', 'name', 'active', 'wires'],
    'Direct lookup diagnostic',
  );

  if (sha256(String(query.func ?? '')) !== contract.query.preimageSha256) {
    fail('Direct lookup query function preimage mismatch');
  }
  if (typeof querySource !== 'string' || sha256(querySource) !== contract.query.sourceSha256) {
    fail('Direct lookup query source contract mismatch');
  }
  query.func = querySource;
  response.func = responseSource;
  listNormalizer.func = listNormalizerSource;

  const changedNodes = flow.flatMap((node, index) => {
    const previous = before[index];
    if (isDeepStrictEqual(node, previous)) return [];
    const changedFields = [...new Set([...Object.keys(previous), ...Object.keys(node)])]
      .filter((field) => !isDeepStrictEqual(previous[field], node[field]))
      .sort();
    return [{ id: node.id, changedFields }];
  });
  const targetIds = new Set([
    contract.query.id,
    contract.response.id,
    contract.listNormalizer.id,
  ]);
  if (changedNodes.some((change) => (
    !targetIds.has(change.id) || !isDeepStrictEqual(change.changedFields, ['func'])
  ))) {
    fail('Candidate changed nodes or fields outside approved direct lookup functions');
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
  const stagePrefix = `.${path.basename(directory)}.direct-lookup-stage-`;
  if (fs.readdirSync(parent).some((name) => name.startsWith(stagePrefix))) {
    fail('Partial direct lookup publication exists');
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

export function readVerifiedDirectLookupBytes(verified) {
  const bytes = fs.readFileSync(verified.sourcePath);
  if (sha256(bytes) !== verified.sourceSha256) {
    fail('Verified Node-RED source changed after verification');
  }
  return bytes;
}

export function publishDirectLookupCandidate({
  workspace,
  output,
  report,
  contract = DIRECT_LOOKUP_CONTRACT,
}) {
  const verified = verifyWorkspace(workspace, { quiet: true });
  const sourceBytes = readVerifiedDirectLookupBytes(verified);
  const paths = publicationPaths(output, report, verified.workspace);
  const querySource = fs.readFileSync(QUERY_SOURCE_PATH, 'utf8');
  const responseSource = fs.readFileSync(RESPONSE_SOURCE_PATH, 'utf8');
  const listNormalizerSource = fs.readFileSync(LIST_NORMALIZER_SOURCE_PATH, 'utf8');
  const result = synchronizeDirectLookup(
    structuredClone(verified.source),
    querySource,
    responseSource,
    listNormalizerSource,
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
      'Usage: node scripts/patch_live_games_direct_lookup.mjs '
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
    publishDirectLookupCandidate(parseArgs(process.argv.slice(2)));
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
