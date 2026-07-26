#!/usr/bin/env node

import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import { fileURLToPath } from 'node:url';
import { verifyWorkspace } from './verify_nodered_source_origin.mjs';

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = fs.realpathSync(path.resolve(SCRIPT_DIR, '..'));
const FUNCTIONS_DIR = path.join(SCRIPT_DIR, 'nodered_chat_nodes');

export const CHAT_CONTRACT = Object.freeze({
  wholeFlowSha256: '6d66ef25bdb2a03a031e8be6471fd9333ff960ed980e14e7011e95c76e006a90',
  nodeCount: 4614,
  httpRouteCount: 203,
  tab: {
    id: '4b91e2a2413688db',
    type: 'tab',
    label: 'LK Games',
    disabled: false,
  },
  routes: [
    {
      id: 'e09a686660cfb90e',
      type: 'http in',
      z: '4b91e2a2413688db',
      name: 'LK game chat send',
      method: 'post',
      url: '/lk/games/:gameId/chat/messages',
      wires: [['a17b63049cd6b53e']],
    },
    {
      id: '87f3e06c0819bba9',
      type: 'http in',
      z: '4b91e2a2413688db',
      name: 'LK game chat messages',
      method: 'get',
      url: '/lk/games/:gameId/chat/messages',
      wires: [['5ab2c47e87907d6d']],
    },
    {
      id: 'c70dc6616359a74d',
      type: 'http in',
      z: '4b91e2a2413688db',
      name: 'LK game chat read',
      method: 'post',
      url: '/lk/games/:gameId/chat/read',
      wires: [['13e99b0963e03eff']],
    },
    {
      id: 'c2d79e1052eaffd8',
      type: 'http in',
      z: '4b91e2a2413688db',
      name: 'LK chats by phone',
      method: 'get',
      url: '/lk/chats/by-phone',
      wires: [['6b2d00ff210f6501']],
    },
  ],
  functions: [
    {
      id: 'a17b63049cd6b53e',
      file: 'fn_chat_post_prepare.js',
      name: 'Chat send validate',
      outputs: 3,
      wires: [['c47fed2ca27576f4'], ['98e207fde172bf95'], ['c3ee27b1b2b17c82']],
      preimageSha256: '45e0888d40a06a0c45d2207aaa5dfa4abfa9d42059c279cb7b8e2c2d5eef3779',
      sourceSha256: '45e0888d40a06a0c45d2207aaa5dfa4abfa9d42059c279cb7b8e2c2d5eef3779',
    },
    {
      id: '0f38c94e369cf7ca',
      file: 'fn_chat_post_build_insert.js',
      name: 'Build chat message doc',
      outputs: 3,
      wires: [['d323b4a2bc150c16'], ['98e207fde172bf95'], ['c3ee27b1b2b17c82']],
      preimageSha256: '20ac6e7b03e2c753ac827013e2e3d777e600e10a803ae3398d19893a6c90ccaa',
      sourceSha256: '20ac6e7b03e2c753ac827013e2e3d777e600e10a803ae3398d19893a6c90ccaa',
    },
    {
      id: '542d0ca0536bd35a',
      file: 'fn_chat_post_response.js',
      name: 'Chat send response',
      outputs: 2,
      wires: [['98e207fde172bf95'], ['c3ee27b1b2b17c82']],
      preimageSha256: '9bc443d9e7c1923294a8610f59ed6271a864e16742edd9f5986951a7730e0552',
      sourceSha256: '9bc443d9e7c1923294a8610f59ed6271a864e16742edd9f5986951a7730e0552',
    },
    {
      id: '5ab2c47e87907d6d',
      file: 'fn_chat_get_prepare.js',
      name: 'Chat get validate',
      outputs: 3,
      wires: [['dd9e09dfec3a552b'], ['303126e394d52ade'], ['645c9add7065c07b']],
      preimageSha256: '319831301c285f07edd186408dd68366eb3644169ecc6b5b10e568e9e0bfdc73',
      sourceSha256: '319831301c285f07edd186408dd68366eb3644169ecc6b5b10e568e9e0bfdc73',
    },
    {
      id: '1dbd5de98e73a04c',
      file: 'fn_chat_get_build_query.js',
      name: 'Build chat messages query',
      outputs: 3,
      wires: [['4d967af31e8055fb'], ['303126e394d52ade'], ['645c9add7065c07b']],
      preimageSha256: 'd9bdd9e3ae0255b27f2a1481e0845481842bc7fc598c5047d3ec3ba3ada37959',
      sourceSha256: 'd9bdd9e3ae0255b27f2a1481e0845481842bc7fc598c5047d3ec3ba3ada37959',
    },
    {
      id: '4f232b7d6aedd97d',
      file: 'fn_chat_get_response.js',
      name: 'Chat get response',
      outputs: 2,
      wires: [['303126e394d52ade'], ['645c9add7065c07b']],
      preimageSha256: '00d21346d31cf7dc50e5e93f77d1a17483f74770c0898d536bce976eaf5262fa',
      sourceSha256: '00d21346d31cf7dc50e5e93f77d1a17483f74770c0898d536bce976eaf5262fa',
    },
    {
      id: '13e99b0963e03eff',
      file: 'fn_chat_read_prepare.js',
      name: 'Chat read validate',
      outputs: 3,
      wires: [['6f902bcbd0fb034c'], ['893bbe1232021bd7'], ['b68cc60cabac2b81']],
      preimageSha256: 'aa16ee2b4ab49077ee65968beeb9e2a293edee3e1e18f55d587295918629fdd8',
      sourceSha256: 'aa16ee2b4ab49077ee65968beeb9e2a293edee3e1e18f55d587295918629fdd8',
    },
    {
      id: 'ff6908fd005f9b0c',
      file: 'fn_chat_read_insert.js',
      name: 'Build read event doc',
      outputs: 3,
      wires: [['a4d6699abb8c7098'], ['893bbe1232021bd7'], ['b68cc60cabac2b81']],
      preimageSha256: '16d5918109e8b719b2a4604cf0d8932b109e33121b822fe38f33712c8b69498a',
      sourceSha256: '16d5918109e8b719b2a4604cf0d8932b109e33121b822fe38f33712c8b69498a',
    },
    {
      id: 'ae9b1a8c2f1d5c24',
      file: 'fn_chat_read_response.js',
      name: 'Chat read response',
      outputs: 2,
      wires: [['893bbe1232021bd7'], ['b68cc60cabac2b81']],
      preimageSha256: '36f1bb18bb3df18d45264c5fc086aff0e6786c8e10d6f1a0926bab3318dce27f',
      sourceSha256: '36f1bb18bb3df18d45264c5fc086aff0e6786c8e10d6f1a0926bab3318dce27f',
    },
    {
      id: '6b2d00ff210f6501',
      file: 'fn_chat_list_prepare.js',
      name: 'Build chats by phone query',
      outputs: 3,
      wires: [['34c1169305c759cf'], ['69f47865aa3163d4'], ['def4413310926e97']],
      preimageSha256: 'ff24b11e0501d85dd3e584298b88d1af0eb2bbc6b147f527a23708288e0878a8',
      sourceSha256: 'ff24b11e0501d85dd3e584298b88d1af0eb2bbc6b147f527a23708288e0878a8',
    },
    {
      id: 'b529d59370ecad20',
      file: 'fn_chat_list_response.js',
      name: 'Build chats summary response',
      outputs: 2,
      wires: [['69f47865aa3163d4'], ['def4413310926e97']],
      preimageSha256: 'eaced14b57fa518b7b510acd01c2bd1e33692ac7f713eb9356e46fdb18aaee36',
      sourceSha256: 'eaced14b57fa518b7b510acd01c2bd1e33692ac7f713eb9356e46fdb18aaee36',
    },
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

function readApprovedSources(contract = CHAT_CONTRACT) {
  return Object.fromEntries(contract.functions.map((mapping) => {
    const filePath = path.join(FUNCTIONS_DIR, mapping.file);
    const source = fs.readFileSync(filePath, 'utf8');
    if (sha256(source) !== mapping.sourceSha256) {
      fail(`Chat source contract mismatch for ${mapping.file}`);
    }
    return [mapping.file, source];
  }));
}

export function synchronizeChatFlow(
  sourceFlow,
  sourceByFile,
  sourceSha256,
  contract = CHAT_CONTRACT,
) {
  if (sourceSha256 !== contract.wholeFlowSha256) fail('Flow preimage SHA mismatch');
  if (sourceFlow.length !== contract.nodeCount) fail('Flow node count mismatch');

  const tab = exactNode(sourceFlow, contract.tab.id, 'Chat tab');
  assertFields(tab, contract.tab, ['id', 'type', 'label', 'disabled'], 'Chat tab');

  const before = structuredClone(sourceFlow);
  const beforeInvariants = snapshotInvariants(before);
  if (beforeInvariants.httpRoutes.length !== contract.httpRouteCount) {
    fail('HTTP route count mismatch');
  }

  for (const route of contract.routes) {
    assertFields(
      exactNode(sourceFlow, route.id, 'Chat route'),
      route,
      ['id', 'type', 'z', 'name', 'method', 'url', 'wires'],
      'Chat route',
    );
  }

  for (const mapping of contract.functions) {
    const node = exactNode(sourceFlow, mapping.id, 'Chat function');
    assertFields(
      node,
      {
        ...mapping,
        type: 'function',
        z: contract.tab.id,
      },
      ['id', 'type', 'name', 'z', 'outputs', 'wires'],
      'Chat function',
    );
    if (sha256(String(node.func ?? '')) !== mapping.preimageSha256) {
      fail(`Chat function ${mapping.id} preimage mismatch`);
    }
    const nextSource = sourceByFile[mapping.file];
    if (typeof nextSource !== 'string' || sha256(nextSource) !== mapping.sourceSha256) {
      fail(`Chat source contract mismatch for ${mapping.file}`);
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
  const targetIds = new Set(contract.functions.map((mapping) => mapping.id));
  if (changedNodes.some((change) => (
    !targetIds.has(change.id)
    || !isDeepStrictEqual(change.changedFields, ['func'])
  ))) {
    fail('Candidate changed nodes or fields outside the approved chat functions');
  }

  const afterInvariants = snapshotInvariants(sourceFlow);
  if (
    !isDeepStrictEqual(beforeInvariants.ids, afterInvariants.ids)
    || !isDeepStrictEqual(beforeInvariants.wires, afterInvariants.wires)
    || !isDeepStrictEqual(beforeInvariants.links, afterInvariants.links)
    || !isDeepStrictEqual(beforeInvariants.httpRoutes, afterInvariants.httpRoutes)
  ) {
    fail('Candidate changed flow invariants');
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
  if (fs.existsSync(publicationDirectory) || fs.lstatSync(path.dirname(publicationDirectory)).isSymbolicLink()) {
    fail('Publication directory must not already exist or use a symlink parent');
  }
  const publicationParent = fs.realpathSync(path.dirname(publicationDirectory));
  const canonicalPublicationDirectory = path.join(
    publicationParent,
    path.basename(publicationDirectory),
  );
  const outputPath = path.join(canonicalPublicationDirectory, path.basename(outputArg));
  const reportPath = path.join(canonicalPublicationDirectory, path.basename(reportArg));
  if (
    canonicalPublicationDirectory !== publicationDirectory
    || outputPath !== outputArg
    || reportPath !== reportArg
  ) {
    fail('Output and report paths must be canonical');
  }
  if (isWithin(REPO_ROOT, canonicalPublicationDirectory)) {
    fail('Publication directory must be outside the repository');
  }
  const inputDirectory = path.join(workspace, 'input');
  if (isWithin(inputDirectory, canonicalPublicationDirectory)) {
    fail('Publication directory must not alias the verified input');
  }
  const stagePrefix = `.${path.basename(publicationDirectory)}.chat-recovery-stage-`;
  if (fs.readdirSync(publicationParent).some((name) => name.startsWith(stagePrefix))) {
    fail('Partial chat candidate publication exists');
  }
  return {
    publicationDirectory: canonicalPublicationDirectory,
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

export function readVerifiedSourceBytes(verified) {
  const sourceBytes = fs.readFileSync(verified.sourcePath);
  if (sha256(sourceBytes) !== verified.sourceSha256) {
    fail('Verified Node-RED source changed after verification');
  }
  return sourceBytes;
}

export function publishChatCandidate({
  workspace,
  output,
  report,
  contract = CHAT_CONTRACT,
}) {
  const verified = verifyWorkspace(workspace, { quiet: true });
  const sourceBytes = readVerifiedSourceBytes(verified);
  const paths = preparePublicationPaths(output, report, verified.workspace);
  const sourceByFile = readApprovedSources(contract);
  const result = synchronizeChatFlow(
    structuredClone(verified.source),
    sourceByFile,
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
      'Usage: node scripts/patch_nodered_chat_flow.mjs '
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
    publishChatCandidate(parseArgs(process.argv.slice(2)));
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
