#!/usr/bin/env node

import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import { fileURLToPath } from 'node:url';
import { verifyWorkspace } from './verify_nodered_source_origin.mjs';

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = fs.realpathSync(path.resolve(SCRIPT_DIR, '..'));
const SOURCE_DIR = path.join(SCRIPT_DIR, 'nodered_games_nodes');

export const GAMES_LIST_CONTRACT = Object.freeze({
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
      id: '66c844d829df6210',
      nodeSha256: '3956b9645302bee911590a55074fc48946e94f2ea1befa7a7a9a093ace5b2894',
      type: 'http in',
      z: '4b91e2a2413688db',
      name: 'LK games by phone',
      method: 'get',
      url: '/lk/games/by-phone',
      wires: [['25a807ca124cd83e']],
    },
    {
      id: '880fdc834e479525',
      nodeSha256: 'be876c74ec20bc6cd2d6703c51212243bb5b47f5a4f161e29f0594072b143ca1',
      type: 'http in',
      z: '4b91e2a2413688db',
      name: 'LK games list alias',
      method: 'get',
      url: '/lk/games',
      wires: [['25a807ca124cd83e']],
    },
  ],
  query: {
    id: '25a807ca124cd83e',
    nodeSha256: '51f74b51e77480efffbe35027b1c93148ae1ab7bc06fa326077d4268b300c2c9',
    type: 'function',
    z: '4b91e2a2413688db',
    name: 'Build upcoming query by phone',
    outputs: 3,
    wires: [['77859abc9f190e6b'], ['7b8f8065271f5b4c'], ['62b2b0e16ed306e7']],
    file: 'fn_list_query.js',
    preimageSha256: '2535de7d1219cc56fe4eb752c5b4df14f9f4dc1f8f2443a0b29422fb3af990ee',
    sourceSha256: '2535de7d1219cc56fe4eb752c5b4df14f9f4dc1f8f2443a0b29422fb3af990ee',
  },
  mongo: {
    id: '77859abc9f190e6b',
    nodeSha256: 'd156c5978ea62d7f81f8c4b8dd2963e4e15fd4c601cae052b0334e50f82e210a',
    type: 'mongodb4',
    z: '4b91e2a2413688db',
    name: 'Find lk games by phone',
    clientNode: '4e820638cc39c730',
    mode: 'collection',
    collection: 'lk_games',
    operation: 'find',
    output: 'toArray',
    maxTimeMS: '0',
    handleDocId: false,
    wires: [['0485dea01865b2dd']],
  },
  normalizer: {
    id: '0485dea01865b2dd',
    nodeSha256: '098436c2d89299cfe26e4156ceef84ed15d3c7e3bf54c0fb0cab6cc5b8511546',
    type: 'function',
    z: '4b91e2a2413688db',
    name: 'Dedupe + normalize upcoming games',
    outputs: 2,
    wires: [['7b8f8065271f5b4c'], ['62b2b0e16ed306e7']],
    file: 'fn_list_normalize.js',
    preimageSha256: '33d5252688c6f25ab61ef9b3ad157b2ae970bc8d8b60e4264d30dac0a5296172',
    sourceSha256: 'c7e19ef7dcb24143a20af70bb8a1787f66a7f85fdb1a53efc41e110758b2e162',
  },
  orphanIds: ['fcb8b28e2ecb4e7c', 'f4cc88af12330122'],
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
}

function assertNodeSha(node, contract, description) {
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
  const httpRoutes = flow
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
    httpRoutes,
    hashes: {
      idsSha256: sha256Json(ids),
      wiresSha256: sha256Json(wires),
      linksSha256: sha256Json(links),
      httpRoutesSha256: sha256Json(httpRoutes),
    },
  };
}

function readApprovedSources(contract) {
  return Object.fromEntries([contract.query, contract.normalizer].map((mapping) => {
    const source = fs.readFileSync(path.join(SOURCE_DIR, mapping.file), 'utf8');
    if (sha256(source) !== mapping.sourceSha256) {
      fail(`Games list source contract mismatch for ${mapping.file}`);
    }
    return [mapping.file, source];
  }));
}

export function synchronizeGamesListIdentity(
  sourceFlow,
  sourceByFile,
  sourceSha256,
  contract = GAMES_LIST_CONTRACT,
) {
  if (sourceSha256 !== contract.wholeFlowSha256) fail('Flow preimage SHA mismatch');
  if (sourceFlow.length !== contract.nodeCount) fail('Flow node count mismatch');
  assertFields(
    exactNode(sourceFlow, contract.tab.id, 'Games list tab'),
    contract.tab,
    ['id', 'type', 'label', 'disabled'],
    'Games list tab',
  );

  const before = structuredClone(sourceFlow);
  const beforeInvariants = snapshotInvariants(before);
  if (beforeInvariants.httpRoutes.length !== contract.httpRouteCount) {
    fail('HTTP route count mismatch');
  }

  for (const route of contract.routes) {
    const routeNode = exactNode(sourceFlow, route.id, 'Games list route');
    assertFields(routeNode, route, ['id', 'type', 'z', 'name', 'method', 'url', 'wires'], 'Games list route');
    assertNodeSha(routeNode, route, 'Games list route');
  }

  const queryNode = exactNode(sourceFlow, contract.query.id, 'Games list query');
  assertFields(
    queryNode,
    contract.query,
    ['id', 'type', 'z', 'name', 'outputs', 'wires'],
    'Games list query',
  );
  assertNodeSha(queryNode, contract.query, 'Games list query');

  const mongoNode = exactNode(sourceFlow, contract.mongo.id, 'Games list mongo');
  assertFields(
    mongoNode,
    contract.mongo,
    [
      'id', 'type', 'z', 'name', 'clientNode', 'mode', 'collection',
      'operation', 'output', 'maxTimeMS', 'handleDocId', 'wires',
    ],
    'Games list mongo',
  );
  assertNodeSha(mongoNode, contract.mongo, 'Games list mongo');

  const normalizerNode = exactNode(sourceFlow, contract.normalizer.id, 'Games list normalizer');
  assertFields(
    normalizerNode,
    contract.normalizer,
    ['id', 'type', 'z', 'name', 'outputs', 'wires'],
    'Games list normalizer',
  );
  assertNodeSha(normalizerNode, contract.normalizer, 'Games list normalizer');

  for (const [node, mapping] of [
    [queryNode, contract.query],
    [normalizerNode, contract.normalizer],
  ]) {
    if (sha256(String(node.func ?? '')) !== mapping.preimageSha256) {
      fail(`Games list function ${mapping.id} preimage mismatch`);
    }
    const nextSource = sourceByFile[mapping.file];
    if (typeof nextSource !== 'string' || sha256(nextSource) !== mapping.sourceSha256) {
      fail(`Games list source contract mismatch for ${mapping.file}`);
    }
    node.func = nextSource;
  }

  const changedNodes = sourceFlow.flatMap((node, index) => {
    const previous = before[index];
    if (isDeepStrictEqual(node, previous)) return [];
    const changedFields = [...new Set([
      ...Object.keys(previous),
      ...Object.keys(node),
    ])]
      .filter((field) => !isDeepStrictEqual(previous[field], node[field]))
      .sort();
    return [{ id: node.id, changedFields }];
  });
  const targetIds = new Set([contract.query.id, contract.normalizer.id]);
  if (changedNodes.some((change) => (
    !targetIds.has(change.id) || !isDeepStrictEqual(change.changedFields, ['func'])
  ))) {
    fail('Candidate changed nodes or fields outside approved games list functions');
  }
  for (const orphanId of contract.orphanIds) {
    const beforeOrphan = exactNode(before, orphanId, 'Orphan games list function');
    const afterOrphan = exactNode(sourceFlow, orphanId, 'Orphan games list function');
    if (!isDeepStrictEqual(beforeOrphan, afterOrphan)) {
      fail(`Orphan games list function ${orphanId} changed`);
    }
  }

  const afterInvariants = snapshotInvariants(sourceFlow);
  if (
    !isDeepStrictEqual(beforeInvariants.ids, afterInvariants.ids)
    || !isDeepStrictEqual(beforeInvariants.wires, afterInvariants.wires)
    || !isDeepStrictEqual(beforeInvariants.links, afterInvariants.links)
    || !isDeepStrictEqual(beforeInvariants.httpRoutes, afterInvariants.httpRoutes)
  ) {
    fail('Candidate changed flow topology');
  }
  return {
    candidate: sourceFlow,
    changedNodes,
    invariants: {
      nodeCount: sourceFlow.length,
      httpRouteCount: afterInvariants.httpRoutes.length,
      ...afterInvariants.hashes,
    },
  };
}

function isWithin(parent, candidate) {
  const relative = path.relative(parent, candidate);
  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
}

function preparePublicationPaths(outputArg, reportArg, workspace) {
  if (!path.isAbsolute(outputArg) || !path.isAbsolute(reportArg)) {
    fail('Output and report paths must be absolute');
  }
  if (path.resolve(outputArg) === path.resolve(reportArg)) {
    fail('Output and report paths must be distinct');
  }
  const publicationDirectory = path.dirname(path.resolve(outputArg));
  if (path.dirname(path.resolve(reportArg)) !== publicationDirectory) {
    fail('Output and report must share one new publication directory');
  }
  const parentArg = path.dirname(publicationDirectory);
  if (fs.existsSync(publicationDirectory) || fs.lstatSync(parentArg).isSymbolicLink()) {
    fail('Publication directory must not already exist or use a symlink parent');
  }
  const publicationParent = fs.realpathSync(parentArg);
  const canonicalDirectory = path.join(publicationParent, path.basename(publicationDirectory));
  const outputPath = path.join(canonicalDirectory, path.basename(outputArg));
  const reportPath = path.join(canonicalDirectory, path.basename(reportArg));
  if (
    canonicalDirectory !== publicationDirectory
    || outputPath !== outputArg
    || reportPath !== reportArg
  ) {
    fail('Output and report paths must be canonical');
  }
  if (isWithin(REPO_ROOT, canonicalDirectory)) {
    fail('Publication directory must be outside the repository');
  }
  if (isWithin(path.join(workspace, 'input'), canonicalDirectory)) {
    fail('Publication directory must not alias the verified input');
  }
  const stagePrefix = `.${path.basename(canonicalDirectory)}.games-list-stage-`;
  if (fs.readdirSync(publicationParent).some((name) => name.startsWith(stagePrefix))) {
    fail('Partial games list publication exists');
  }
  return {
    publicationDirectory: canonicalDirectory,
    publicationParent,
    outputPath,
    reportPath,
    stagePrefix,
  };
}

function writePrivateFile(filePath, value) {
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

export function readVerifiedGamesListSourceBytes(verified) {
  const sourceBytes = fs.readFileSync(verified.sourcePath);
  if (sha256(sourceBytes) !== verified.sourceSha256) {
    fail('Verified Node-RED source changed after verification');
  }
  return sourceBytes;
}

export function publishGamesListCandidate({
  workspace,
  output,
  report,
  contract = GAMES_LIST_CONTRACT,
}) {
  const verified = verifyWorkspace(workspace, { quiet: true });
  const sourceBytes = readVerifiedGamesListSourceBytes(verified);
  const paths = preparePublicationPaths(output, report, verified.workspace);
  const result = synchronizeGamesListIdentity(
    structuredClone(verified.source),
    readApprovedSources(contract),
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

  const stageDirectory = path.join(
    paths.publicationParent,
    `${paths.stagePrefix}${process.pid}-${crypto.randomUUID()}`,
  );
  fs.mkdirSync(stageDirectory, { mode: 0o700 });
  try {
    writePrivateFile(path.join(stageDirectory, path.basename(paths.outputPath)), candidateBytes);
    writePrivateFile(
      path.join(stageDirectory, path.basename(paths.reportPath)),
      Buffer.from(`${JSON.stringify(redactedReport, null, 2)}\n`, 'utf8'),
    );
    fs.renameSync(stageDirectory, paths.publicationDirectory);
  } catch (error) {
    fs.rmSync(stageDirectory, { recursive: true, force: true });
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
  for (const key of Object.keys(values)) {
    if (!allowed.has(key)) fail(`Unknown argument: ${key}`);
  }
  if (!values['--workspace'] || !values['--output'] || !values['--report']) {
    fail(
      'Usage: node scripts/patch_live_games_list_identity.mjs '
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
    publishGamesListCandidate(parseArgs(process.argv.slice(2)));
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
