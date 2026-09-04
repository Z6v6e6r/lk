#!/usr/bin/env node

import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import { fileURLToPath } from 'node:url';
import { verifyWorkspace } from './verify_nodered_source_origin.mjs';

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = fs.realpathSync(path.resolve(SCRIPT_DIR, '..'));
const SOURCE_FILE = path.join(
  SCRIPT_DIR,
  'nodered_community_list_nodes',
  'fn_list_prepare_tail.js',
);
const PREPARE_TAIL_MARKER = 'const listMode =';

export const COMMUNITY_LIST_PERFORMANCE_CONTRACT = Object.freeze({
  wholeFlowSha256: '90abcbaecf405bddf800099a4b20cf98f720d4dac675e7337b5023fd3e57e99b',
  nodeCount: 4762,
  httpRouteCount: 215,
  tab: {
    id: 'f7982bef49db88f7',
    nodeSha256: 'ad34989be5c2a93db8244fe3f1e59e30dec7f9184e90e6ee90fe504d84429839',
    type: 'tab',
    label: 'LK Communities',
    disabled: false,
  },
  route: {
    id: '1c21ceed36fb7ba5',
    nodeSha256: '702a8142db50d8f2726b6e3423aad0d4b640ca7a8448009f0cf84573d970fa31',
    type: 'http in',
    z: 'f7982bef49db88f7',
    name: 'LK communities list',
    method: 'get',
    url: '/lk/communities',
    wires: [['634ddb4d82d27e9f']],
  },
  prepare: {
    id: '634ddb4d82d27e9f',
    nodeSha256: 'ca063d14f91fcd8acd0c2c8f5cfb63c92788fddf1ebdbf9cbef698f09603923e',
    type: 'function',
    z: 'f7982bef49db88f7',
    name: 'Prepare communities list query',
    outputs: 3,
    wires: [['43a65858ca194292'], ['8ec761fa996c19af'], ['72aedd3c4155b80b']],
    preimageSha256: '9c6bb8987506e49f2ae5416cf9f6b643211444382bd1df5cf4b74ef830d4c088',
    sourceSha256: '42ab263139dbaa99a9c12f18ec29b07080245bcfbc4be4270008d5c38a6f9616',
  },
  mongo: {
    id: '43a65858ca194292',
    nodeSha256: '90d924d9af5c17d5804406c37985a3f618ad178f94628a6ce3c5166ee98629c0',
    type: 'mongodb4',
    z: 'f7982bef49db88f7',
    name: 'Find communities',
    clientNode: '4e820638cc39c730',
    mode: 'collection',
    collection: 'lk_communities',
    operation: 'find',
    output: 'toArray',
    maxTimeMS: '0',
    handleDocId: false,
    wires: [['9ec08e9a627fa3e2']],
  },
  response: {
    id: '9ec08e9a627fa3e2',
    nodeSha256: '1e23b60c31c38102fac133d098c4b63c5d44d5857aa1099cb19bc6931246fc90',
    type: 'function',
    z: 'f7982bef49db88f7',
    name: 'Build communities list response',
    outputs: 2,
    wires: [['8ec761fa996c19af'], ['72aedd3c4155b80b']],
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

export function synchronizeCommunityListPerformance(
  sourceFlow,
  approvedTail,
  sourceSha256,
  contract = COMMUNITY_LIST_PERFORMANCE_CONTRACT,
) {
  if (sourceSha256 !== contract.wholeFlowSha256) fail('Flow preimage SHA mismatch');
  if (sourceFlow.length !== contract.nodeCount) fail('Flow node count mismatch');
  const before = structuredClone(sourceFlow);
  const beforeInvariants = snapshotInvariants(before);
  if (beforeInvariants.httpRoutes.length !== contract.httpRouteCount) {
    fail('HTTP route count mismatch');
  }

  const tabNode = exactNode(sourceFlow, contract.tab.id, 'Community list tab');
  assertFields(tabNode, contract.tab, ['id', 'type', 'label', 'disabled'], 'Community list tab');
  assertNodeSha(tabNode, contract.tab, 'Community list tab');

  const routeNode = exactNode(sourceFlow, contract.route.id, 'Community list route');
  assertFields(
    routeNode,
    contract.route,
    ['id', 'type', 'z', 'name', 'method', 'url', 'wires'],
    'Community list route',
  );
  assertNodeSha(routeNode, contract.route, 'Community list route');

  const prepareNode = exactNode(sourceFlow, contract.prepare.id, 'Community list prepare');
  assertFields(
    prepareNode,
    contract.prepare,
    ['id', 'type', 'z', 'name', 'outputs', 'wires'],
    'Community list prepare',
  );
  assertNodeSha(prepareNode, contract.prepare, 'Community list prepare');
  if (sha256(String(prepareNode.func ?? '')) !== contract.prepare.preimageSha256) {
    fail('Community list prepare function preimage mismatch');
  }
  if (sha256(approvedTail) !== contract.prepare.sourceSha256) {
    fail('Community list prepare source contract mismatch');
  }

  const mongoNode = exactNode(sourceFlow, contract.mongo.id, 'Community list mongo');
  assertFields(
    mongoNode,
    contract.mongo,
    [
      'id', 'type', 'z', 'name', 'clientNode', 'mode', 'collection',
      'operation', 'output', 'maxTimeMS', 'handleDocId', 'wires',
    ],
    'Community list mongo',
  );
  assertNodeSha(mongoNode, contract.mongo, 'Community list mongo');

  const responseNode = exactNode(sourceFlow, contract.response.id, 'Community list response');
  assertFields(
    responseNode,
    contract.response,
    ['id', 'type', 'z', 'name', 'outputs', 'wires'],
    'Community list response',
  );
  assertNodeSha(responseNode, contract.response, 'Community list response');

  const markerIndex = prepareNode.func.indexOf(PREPARE_TAIL_MARKER);
  if (markerIndex < 0 || prepareNode.func.indexOf(PREPARE_TAIL_MARKER, markerIndex + 1) >= 0) {
    fail('Community list prepare tail marker must exist exactly once');
  }
  if (!approvedTail.startsWith(PREPARE_TAIL_MARKER) || !approvedTail.endsWith('\n')) {
    fail('Community list prepare source must be a complete newline-terminated tail');
  }
  prepareNode.func = `${prepareNode.func.slice(0, markerIndex)}${approvedTail}`;

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
  if (
    changedNodes.length !== 1
    || changedNodes[0].id !== contract.prepare.id
    || !isDeepStrictEqual(changedNodes[0].changedFields, ['func'])
  ) {
    fail('Candidate changed nodes or fields outside the approved community list function');
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
  const stagePrefix = `.${path.basename(canonicalDirectory)}.community-list-stage-`;
  if (fs.readdirSync(publicationParent).some((name) => name.startsWith(stagePrefix))) {
    fail('Partial community list publication exists');
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

function readVerifiedSourceBytes(verified) {
  const sourceBytes = fs.readFileSync(verified.sourcePath);
  if (sha256(sourceBytes) !== verified.sourceSha256) {
    fail('Verified Node-RED source changed after verification');
  }
  return sourceBytes;
}

export function publishCommunityListCandidate({
  workspace,
  output,
  report,
  contract = COMMUNITY_LIST_PERFORMANCE_CONTRACT,
}) {
  const verified = verifyWorkspace(workspace, { quiet: true });
  const sourceBytes = readVerifiedSourceBytes(verified);
  const approvedTail = fs.readFileSync(SOURCE_FILE, 'utf8');
  const paths = preparePublicationPaths(output, report, verified.workspace);
  const result = synchronizeCommunityListPerformance(
    structuredClone(verified.source),
    approvedTail,
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
    approvedTailSha256: sha256(approvedTail),
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
      'Usage: node scripts/patch_live_community_list_performance.mjs '
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
    publishCommunityListCandidate(parseArgs(process.argv.slice(2)));
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
