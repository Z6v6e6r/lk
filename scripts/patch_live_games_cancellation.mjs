#!/usr/bin/env node

import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import { fileURLToPath } from 'node:url';
import { verifyWorkspace } from './verify_nodered_source_origin.mjs';

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = fs.realpathSync(path.resolve(SCRIPT_DIR, '..'));
const TAB_ID = '4b91e2a2413688db';
const RESPONSE_ID = 'dfaa7a139e9538c8';
const LEAVE_RESPONSE_ID = '35f7c89069fc393a';
const LEAVE_DEBUG_ID = 'cf731009d4167f78';

export const CANCELLATION_SOURCE_PATHS = Object.freeze({
  query: path.join(SCRIPT_DIR, 'nodered_games_nodes/fn_split_cleanup_query.js'),
  prepare: path.join(SCRIPT_DIR, 'nodered_games_nodes/fn_split_cleanup_prepare.js'),
  router: path.join(SCRIPT_DIR, 'nodered_games_nodes/fn_split_cleanup_router.js'),
  authPrepare: path.join(SCRIPT_DIR, 'nodered_games_nodes/fn_split_cleanup_auth_prepare.js'),
  authResolve: path.join(SCRIPT_DIR, 'nodered_games_nodes/fn_split_cleanup_auth_resolve.js'),
  leavePrepare: path.join(SCRIPT_DIR, 'nodered_games_nodes/fn_split_leave_prepare.js'),
  leaveAuthorize: path.join(SCRIPT_DIR, 'nodered_games_nodes/fn_split_leave_authorize.js'),
  leaveRouter: path.join(SCRIPT_DIR, 'nodered_games_nodes/fn_split_leave_router.js'),
});

const TARGETS = [
  {
    key: 'query',
    id: 'dcd649158bd8df8e',
    nodeSha256: '9b6147b96038dd70469dd58833a98f833ed3d574d19fc7f7a751a822d1d99ae0',
    funcSha256: '976b6d91828f39aa75a720c1040c53c021d81835de8e53510bcf3a8392c570a4',
    sourceSha256: '0f344c78dbe9dbe5ec0b14667ce5da83dd2f26253dd514e46ae0dcaffc07e9a9',
  },
  {
    key: 'prepare',
    id: '9508f8e0ae8d282a',
    nodeSha256: '13bdf7b161f9ebea040ed00aa55680491dc697d805be90d5a026a878cfb76c82',
    funcSha256: 'd9502f6234cf5b166acccc6a686e711515ec6daa506aeeb712d5f3a4ad4137df',
    sourceSha256: 'f1f68c57999886ac14f5865ee0c18521544faf12f583121c6c49c2c874c57092',
  },
  {
    key: 'router',
    id: 'bcc3dccf8d64f9bb',
    nodeSha256: '503820793530ce1c52cdcd78cf66b9aafa8c289dd0ba25a290ca55c44c8abbdc',
    funcSha256: 'c50ae57361b473b585315bc656b0415df65a4128a75d7a94133a4ad5fe237c8f',
    sourceSha256: 'af775ca938b1f89236b162fa7d63a3ffce159b5bb59df160c8777bcefba23f96',
  },
  {
    key: 'leavePrepare',
    id: '016d6797a530ed0a',
    nodeSha256: 'b4d282e5e367743e47a8f51fd2df7ef4b855d7dc61c8fc5a3f80ecf7dadb6984',
    funcSha256: 'd815a3f519f4c74a27d161548260c3ad962cefa9efc94857430f4183895d565c',
    sourceSha256: 'c139295e487b2dd66b52719bd352d540926f65db66ac5b0787d1631b52cb0b7c',
    allowedFields: ['func', 'wires'],
  },
  {
    key: 'leaveRouter',
    id: '9878400d518ebcbd',
    nodeSha256: '97dd714a99ec752a8c4a9704ec3776d5c436822ca53df219fec4dd708d4c9412',
    funcSha256: '469988aa6fa0793a6d5bda0c36f511a7de53dcb9cbd1f48bc2c356b035e77e45',
    sourceSha256: '38bfcd24c6e71ab0d738f058a559284a1fb1c9df169bb0d88c32667ecd3b93fb',
  },
];

export const CANCELLATION_CONTRACT = Object.freeze({
  wholeFlowSha256: '8d88b56165f59c47f82ce2fda1a5739862601dc16313291619c0246889ac7988',
  nodeCount: 4617,
  candidateNodeCount: 4625,
  httpRouteCount: 203,
  tab: {
    id: TAB_ID,
    type: 'tab',
    label: 'LK Games',
    disabled: false,
  },
  route: {
    id: '9e6c24c105675e17',
    type: 'http in',
    z: TAB_ID,
    name: 'LK games split cleanup',
    method: 'post',
    url: '/lk/games/split/cleanup',
    wires: [['dcd649158bd8df8e']],
    nodeSha256: '708218d2cabb8e306337312b3eed00feedfe704ac8334b69fd5a9380b5867be6',
  },
  leaveRoute: {
    id: 'ecf32036257013bd',
    type: 'http in',
    z: TAB_ID,
    name: 'LK games split leave',
    method: 'post',
    url: '/lk/games/:gameId/split/leave',
    wires: [['016d6797a530ed0a']],
    nodeSha256: '2f20700db93a2393cb55cded8bbd371a92f4d7ed0a57f3f5ab58054a3f089e23',
  },
  targets: TARGETS,
  addedSourceSha256: {
    authPrepare: '354fa99ed0a8fcd82df154373d138c0a98ca3bbd12c1b0c5ae1a440e3ee36e57',
    authResolve: 'efb06f89dc604b45232849e1fa3528a492461a332a4d35339ce1af0ef565c61f',
    leaveAuthorize: '95e29513063ff8506b4ed4808283ff704044daaee3ed32af0fc5f0cdd5e20800',
  },
  addedNodeIds: [
    '7c280001a0c1e001',
    '7c280001a0c1e002',
    '7c280001a0c1e003',
    '7c280001a0c1e011',
    '7c280001a0c1e012',
    '7c280001a0c1e013',
    '7c280001a0c1e014',
    '7c280001a0c1e015',
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

function readSources(contract) {
  const expectedHashes = {
    ...Object.fromEntries(contract.targets.map((target) => [target.key, target.sourceSha256])),
    ...contract.addedSourceSha256,
  };
  return Object.fromEntries(Object.entries(CANCELLATION_SOURCE_PATHS).map(([key, sourcePath]) => {
    const source = fs.readFileSync(sourcePath, 'utf8');
    if (sha256(source) !== expectedHashes[key]) {
      fail(`Tracked cancellation source mismatch for ${key}`);
    }
    return [key, source];
  }));
}

function snapshot(flow) {
  const ids = flow.map((node) => node.id);
  if (new Set(ids).size !== ids.length) fail('Flow contains duplicate node IDs');
  const routes = flow
    .filter((node) => node.type === 'http in')
    .map((node) => ({
      id: node.id,
      z: node.z ?? '',
      method: node.method ?? '',
      url: node.url ?? '',
      name: node.name ?? '',
    }));
  const links = flow.map((node) => ({
    id: node.id,
    links: Object.hasOwn(node, 'links') ? node.links : null,
  }));
  return { ids, routes, links };
}

function countBrokenReferences(flow) {
  const ids = new Set(flow.map((node) => node.id));
  let brokenWires = 0;
  let brokenLinks = 0;
  for (const node of flow) {
    for (const output of node.wires ?? []) {
      for (const targetId of output ?? []) {
        if (!ids.has(targetId)) brokenWires += 1;
      }
    }
    if ((node.type === 'link in' || node.type === 'link out') && Array.isArray(node.links)) {
      for (const targetId of node.links) {
        if (!ids.has(targetId)) brokenLinks += 1;
      }
    }
  }
  return { brokenWires, brokenLinks };
}

function buildAddedNodes(sources) {
  return [
    {
      id: '7c280001a0c1e001',
      type: 'function',
      z: TAB_ID,
      name: 'Authorize split cleanup',
      func: sources.authPrepare,
      outputs: 2,
      timeout: '',
      noerr: 0,
      initialize: '',
      finalize: '',
      libs: [],
      x: 410,
      y: 1960,
      wires: [['7c280001a0c1e002'], [RESPONSE_ID]],
    },
    {
      id: '7c280001a0c1e002',
      type: 'http request',
      z: TAB_ID,
      name: 'Viva split cleanup profile',
      method: 'use',
      ret: 'obj',
      paytoqs: 'ignore',
      url: '',
      x: 670,
      y: 1960,
      wires: [['7c280001a0c1e003']],
    },
    {
      id: '7c280001a0c1e003',
      type: 'function',
      z: TAB_ID,
      name: 'Resolve split cleanup actor',
      func: sources.authResolve,
      outputs: 2,
      timeout: '',
      noerr: 0,
      initialize: '',
      finalize: '',
      libs: [],
      x: 960,
      y: 1960,
      wires: [['dcd649158bd8df8e'], [RESPONSE_ID]],
    },
    {
      id: '7c280001a0c1e011',
      type: 'function',
      z: TAB_ID,
      name: 'Authorize split leave request',
      func: sources.authPrepare,
      outputs: 2,
      timeout: '',
      noerr: 0,
      initialize: '',
      finalize: '',
      libs: [],
      x: 390,
      y: 1880,
      wires: [['7c280001a0c1e012'], [LEAVE_RESPONSE_ID]],
    },
    {
      id: '7c280001a0c1e012',
      type: 'http request',
      z: TAB_ID,
      name: 'Viva split leave profile',
      method: 'use',
      ret: 'obj',
      paytoqs: 'ignore',
      url: '',
      x: 650,
      y: 1880,
      wires: [['7c280001a0c1e013']],
    },
    {
      id: '7c280001a0c1e013',
      type: 'function',
      z: TAB_ID,
      name: 'Resolve split leave actor',
      func: sources.authResolve,
      outputs: 2,
      timeout: '',
      noerr: 0,
      initialize: '',
      finalize: '',
      libs: [],
      x: 920,
      y: 1880,
      wires: [['016d6797a530ed0a'], [LEAVE_RESPONSE_ID]],
    },
    {
      id: '7c280001a0c1e014',
      type: 'mongodb4',
      z: TAB_ID,
      clientNode: '4e820638cc39c730',
      mode: 'collection',
      collection: 'lk_games',
      operation: 'find',
      output: 'toArray',
      maxTimeMS: '0',
      handleDocId: false,
      name: 'Find game for split leave authorization',
      x: 760,
      y: 1920,
      wires: [['7c280001a0c1e015']],
    },
    {
      id: '7c280001a0c1e015',
      type: 'function',
      z: TAB_ID,
      name: 'Authorize split leave booking targets',
      func: sources.leaveAuthorize,
      outputs: 3,
      timeout: '',
      noerr: 0,
      initialize: '',
      finalize: '',
      libs: [],
      x: 1080,
      y: 1920,
      wires: [['52af61191cdbe9ef'], [LEAVE_RESPONSE_ID], []],
    },
  ];
}

export function synchronizeCancellation(
  flow,
  sourceSha256,
  contract = CANCELLATION_CONTRACT,
) {
  if (sourceSha256 !== contract.wholeFlowSha256) fail('Flow preimage SHA mismatch');
  if (flow.length !== contract.nodeCount) fail('Flow node count mismatch');
  const tab = exactNode(flow, contract.tab.id, 'Cancellation tab');
  for (const field of ['id', 'type', 'label', 'disabled']) {
    if (!isDeepStrictEqual(tab[field], contract.tab[field])) {
      fail(`Cancellation tab contract mismatch for ${field}`);
    }
  }

  const before = structuredClone(flow);
  const beforeSnapshot = snapshot(before);
  if (beforeSnapshot.routes.length !== contract.httpRouteCount) fail('HTTP route count mismatch');
  for (const id of contract.addedNodeIds) {
    if (flow.some((node) => node?.id === id)) fail(`Added cancellation node ${id} already exists`);
  }

  const routes = [contract.route, contract.leaveRoute];
  for (const routeContract of routes) {
    const route = exactNode(flow, routeContract.id, 'Cancellation route');
    if (sha256Json(route) !== routeContract.nodeSha256) {
      fail('Cancellation route preimage mismatch');
    }
    for (const field of ['id', 'type', 'z', 'name', 'method', 'url', 'wires']) {
      if (!isDeepStrictEqual(route[field], routeContract[field])) {
        fail(`Cancellation route contract mismatch for ${field}`);
      }
    }
  }

  const sources = readSources(contract);
  for (const target of contract.targets) {
    const node = exactNode(flow, target.id, `Cancellation ${target.key}`);
    if (sha256Json(node) !== target.nodeSha256) {
      fail(`Cancellation ${target.key} node preimage mismatch`);
    }
    if (sha256(String(node.func ?? '')) !== target.funcSha256) {
      fail(`Cancellation ${target.key} function preimage mismatch`);
    }
    node.func = sources[target.key];
    if (target.key === 'leavePrepare') {
      node.wires = [['7c280001a0c1e014'], [LEAVE_RESPONSE_ID], [LEAVE_DEBUG_ID]];
    }
  }

  exactNode(flow, contract.route.id, 'Cancellation route').wires = [[contract.addedNodeIds[0]]];
  exactNode(flow, contract.leaveRoute.id, 'Cancellation leave route').wires = [[
    contract.addedNodeIds[3],
  ]];
  flow.push(...buildAddedNodes(sources));

  if (flow.length !== contract.candidateNodeCount) fail('Candidate node count mismatch');
  const afterSnapshot = snapshot(flow);
  if (!isDeepStrictEqual(beforeSnapshot.routes, afterSnapshot.routes)) {
    fail('Candidate changed HTTP route identities');
  }
  if (!isDeepStrictEqual(beforeSnapshot.links, afterSnapshot.links.slice(0, before.length))) {
    fail('Candidate changed existing link topology');
  }
  if (!isDeepStrictEqual(beforeSnapshot.ids, afterSnapshot.ids.slice(0, before.length))) {
    fail('Candidate reordered or replaced existing nodes');
  }
  const brokenReferences = countBrokenReferences(flow);
  if (brokenReferences.brokenWires !== 0 || brokenReferences.brokenLinks !== 0) {
    fail('Candidate contains broken wires or links');
  }

  const changedNodes = flow.flatMap((node, index) => {
    if (index >= before.length) return [{ id: node.id, changedFields: ['added'] }];
    const previous = before[index];
    if (isDeepStrictEqual(node, previous)) return [];
    const changedFields = [...new Set([...Object.keys(previous), ...Object.keys(node)])]
      .filter((field) => !isDeepStrictEqual(previous[field], node[field]))
      .sort();
    return [{ id: node.id, changedFields }];
  });
  const allowed = new Map([
    [contract.route.id, ['wires']],
    [contract.leaveRoute.id, ['wires']],
    ...contract.targets.map((target) => [target.id, target.allowedFields || ['func']]),
    ...contract.addedNodeIds.map((id) => [id, ['added']]),
  ]);
  for (const change of changedNodes) {
    if (!isDeepStrictEqual(change.changedFields, allowed.get(change.id))) {
      fail(`Candidate changed an unexpected node or field: ${change.id}`);
    }
  }

  return {
    candidate: flow,
    changedNodes,
    invariants: {
      sourceNodeCount: before.length,
      candidateNodeCount: flow.length,
      httpRouteCount: afterSnapshot.routes.length,
      addedNodeIds: [...contract.addedNodeIds],
      ...brokenReferences,
    },
  };
}

function isWithin(parent, candidate) {
  const relative = path.relative(parent, candidate);
  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
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

export function publishCancellationCandidate({
  workspace,
  outputDirectory,
  contract = CANCELLATION_CONTRACT,
}) {
  const verified = verifyWorkspace(workspace, { quiet: true });
  const directory = path.resolve(outputDirectory);
  if (!path.isAbsolute(outputDirectory)) fail('Output directory must be absolute');
  if (fs.existsSync(directory)) fail('Output directory must not already exist');
  if (isWithin(REPO_ROOT, directory)) fail('Output directory must be outside the repository');

  const parent = fs.realpathSync(path.dirname(directory));
  if (path.join(parent, path.basename(directory)) !== directory) {
    fail('Output directory must be canonical');
  }
  const result = synchronizeCancellation(
    structuredClone(verified.source),
    verified.sourceSha256,
    contract,
  );
  const candidateBytes = Buffer.from(`${JSON.stringify(result.candidate, null, 2)}\n`);
  const report = {
    formatVersion: 1,
    ok: true,
    sourceSha256: verified.sourceSha256,
    candidateSha256: sha256(candidateBytes),
    changedNodeCount: result.changedNodes.length,
    changedNodes: result.changedNodes,
    invariants: result.invariants,
  };

  const stage = path.join(
    parent,
    `.${path.basename(directory)}.cancellation-stage-${process.pid}-${crypto.randomUUID()}`,
  );
  fs.mkdirSync(stage, { mode: 0o700 });
  try {
    writePrivate(path.join(stage, 'candidate.flow.json'), candidateBytes);
    writePrivate(
      path.join(stage, 'report.json'),
      Buffer.from(`${JSON.stringify(report, null, 2)}\n`),
    );
    fs.renameSync(stage, directory);
  } catch (error) {
    fs.rmSync(stage, { recursive: true, force: true });
    throw error;
  }

  console.log(`sourceSha256=${report.sourceSha256}`);
  console.log(`candidateSha256=${report.candidateSha256}`);
  console.log(`candidateNodeCount=${report.invariants.candidateNodeCount}`);
  console.log(`httpRouteCount=${report.invariants.httpRouteCount}`);
  console.log(`changedNodeCount=${report.changedNodeCount}`);
  return report;
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
  const allowed = new Set(['--workspace', '--output-directory']);
  for (const key of Object.keys(values)) if (!allowed.has(key)) fail(`Unknown argument: ${key}`);
  if (!values['--workspace'] || !values['--output-directory']) {
    fail(
      'Usage: node scripts/patch_live_games_cancellation.mjs '
      + '--workspace /absolute/external/workspace '
      + '--output-directory /absolute/new-publication',
    );
  }
  return {
    workspace: values['--workspace'],
    outputDirectory: values['--output-directory'],
  };
}

const invokedPath = process.argv[1] ? fs.realpathSync(process.argv[1]) : '';
if (invokedPath === fileURLToPath(import.meta.url)) {
  try {
    publishCancellationCandidate(parseArgs(process.argv.slice(2)));
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
