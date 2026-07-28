#!/usr/bin/env node

import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import { fileURLToPath } from 'node:url';
import { verifyWorkspace } from './verify_nodered_source_origin.mjs';

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = fs.realpathSync(path.resolve(SCRIPT_DIR, '..'));
export const PATCH_SOURCE_PATH = path.join(SCRIPT_DIR, 'nodered_games_nodes/fn_patch.js');

const routes = [
  ['7ad34f13c4b25d60', 'LK game patch', '/lk/games/:gameId', 'd6b463d4ece6bfa8b17e95cd5e274b38ced5252459e7dc592c280950f66f5124'],
  ['4cb1e542db56b508', 'LK game patch alias', '/lk/games/records/:gameId', 'b436103dabe1c4bf8cce5bca182eeb7a253d82070fc4213959001f2e42c08350'],
].map(([id, name, url, nodeSha256]) => ({ id, name, url, nodeSha256 }));

const graphNodes = [
  ['2b6a41011ad0f494', 'e6d1fc02ecec7d21d136529fd38804c226a895fdda9bf223bfb5bc39acf194c4'],
  ['2e7c4fa34ac9c12a', 'd64e76375d3ec1bb404f23e731e11d6577f8ca19efa1b699324eee67864b63d3'],
  ['3b822085d5f18e97', '29cbcdb4c50645443a44d889de9e858441e9f96ed1ecf6ca7bac3545b850f79a'],
  ['4e02d01a60d941fe', '8c74203d72c02b3f7d1e260fc0ba5631497ab5f0717aae81e4864380c0501412'],
  ['591234d213742276', '2431488c00119972c85a1d2847e3e1489466eb0aedb3461a72302fa0889ffa57'],
  ['5fc5eaeab97f3f88', '05d99385f6935ba4d66a45b05ab969bee2cb7a3da92feded716f4d78abe35e67'],
  ['66930ded7a2eb836', 'fa5886ef9fdeb2fb04c05bf40ebbe6f985ce1a9bf3d01fe2809d83ea1103063e'],
  ['9756d9125563753f', '281aacfa493c31df5f336e0577dcd994e35cf119a09c1cdc40d334147bf68757'],
  ['b2a10027fc45966c', '416b23893f4156171fb4adfea64016ca8b1f26f2cca1652a8066887b237f1eaf'],
  ['b89b08776d9a67a5', '1a226b3f490838d2f33c08c609a28c43bd055109fed8a896c0ee1b7bede8a073'],
  ['c031d81cb06bdc18', 'bf1f856748d862ae1ea98657665ceeaa5fe0e215999413da56b794efa6c7cfd0'],
  ['ce224a53446e9a79', '85cedd87d4b5d1d6ac8f99c09efa0ef5ee4c5afa08491eda34e12133bb53f5aa'],
  ['d02913d3f17dbdc7', '8e1cd072a6b0773b59931e1c7619d90425de1767ad961d31a4eed5583cc2b183'],
  ['db55cbd9b66b9009', '85129afef9ce37bc630c807071abcad920b291a22768950cb8fbfbfda4f73f20'],
  ['e17f8a411d4dfa91', '9d9a41b970d88ca92d3024175b5b25327cacebdcef92e3173b698e56d499912c'],
  ['ea34e59402d510c4', '2076208b17f0a154183651a5698ae8feae2469f7ce323055a21fed2cb1533011'],
].map(([id, nodeSha256]) => ({ id, nodeSha256 }));

export const GAMES_PATCH_CONTRACT = Object.freeze({
  wholeFlowSha256: 'd9f84e4fd6b087752dc810b9fc247e3d532cc6580c19a4a822f2111ddebeca4c',
  nodeCount: 4617,
  httpRouteCount: 203,
  tabId: '4b91e2a2413688db',
  routes,
  target: {
    id: 'e0d7883bc1a9fa8c', name: 'Prepare game patch', outputs: 4,
    wires: [['b2a10027fc45966c'], ['e17f8a411d4dfa91'], ['3b822085d5f18e97'], ['5fc5eaeab97f3f88']],
    preimageSha256: 'cd19171a18ec18a553418d5b1725bab50ee1df2788e5160143430aaeb758c8ad',
    sourceSha256: '7d007ab69297b7ab4314bf23a21cb6fbebcdc6f149e0bfd9d931f0329718261c',
    nodeSha256: '2c0f67b4a7b36a9511b6a6dd71e7037ca6cfc3cef905263d1f0515bbe23a26d4',
  },
  graphNodes,
});

const sha256 = (value) => crypto.createHash('sha256').update(value).digest('hex');
const sha256Json = (value) => sha256(Buffer.from(JSON.stringify(value), 'utf8'));
const fail = (message) => { throw new Error(message); };
const exactNode = (flow, id) => {
  const nodes = flow.filter((node) => node?.id === id);
  if (nodes.length !== 1) fail(`Node ${id} must exist exactly once`);
  return nodes[0];
};

function invariants(flow) {
  const ids = flow.map((node) => node.id);
  if (new Set(ids).size !== ids.length) fail('Flow contains duplicate node IDs');
  const topology = flow.map((node) => ({
    id: node.id,
    wires: Object.hasOwn(node, 'wires') ? node.wires : null,
    links: Object.hasOwn(node, 'links') ? node.links : null,
  }));
  const httpRoutes = flow.filter((node) => node.type === 'http in').map((node) => ({
    id: node.id, z: node.z ?? '', method: node.method ?? '', url: node.url ?? '', wires: node.wires ?? null,
  }));
  return { ids, topology, httpRoutes };
}

function reachableIds(flow, starts) {
  const nodes = new Map(flow.map((node) => [node.id, node]));
  const seen = new Set();
  const pending = [...starts];
  while (pending.length) {
    const id = pending.shift();
    if (seen.has(id)) continue;
    const node = nodes.get(id);
    if (!node) fail(`Reachable graph references missing node ${id}`);
    seen.add(id);
    for (const output of node.wires ?? []) for (const next of output ?? []) pending.push(next);
  }
  return [...seen].sort();
}

export function synchronizeGamesPatch(flow, source, sourceSha256, contract = GAMES_PATCH_CONTRACT) {
  if (sourceSha256 !== contract.wholeFlowSha256) fail('Flow preimage SHA mismatch');
  if (flow.length !== contract.nodeCount) fail('Flow node count mismatch');
  const tab = exactNode(flow, contract.tabId);
  if (tab.type !== 'tab' || tab.label !== 'LK Games' || tab.disabled !== false) fail('Games tab contract mismatch');
  const before = structuredClone(flow);
  const beforeInvariants = invariants(before);
  if (beforeInvariants.httpRoutes.length !== contract.httpRouteCount) fail('HTTP route count mismatch');
  for (const route of contract.routes) {
    const node = exactNode(flow, route.id);
    if (node.type !== 'http in' || node.z !== contract.tabId || node.name !== route.name || node.method !== 'patch' || node.url !== route.url || !isDeepStrictEqual(node.wires, [[contract.target.id]]) || sha256Json(node) !== route.nodeSha256) fail(`PATCH route ${route.id} contract mismatch`);
  }
  const target = exactNode(flow, contract.target.id);
  if (target.type !== 'function' || target.z !== contract.tabId || target.name !== contract.target.name || target.outputs !== contract.target.outputs || !isDeepStrictEqual(target.wires, contract.target.wires) || sha256Json(target) !== contract.target.nodeSha256 || sha256(String(target.func ?? '')) !== contract.target.preimageSha256) fail('PATCH target preimage mismatch');
  for (const item of contract.graphNodes) if (sha256Json(exactNode(flow, item.id)) !== item.nodeSha256) fail(`PATCH graph node ${item.id} preimage mismatch`);
  const expectedReachable = [...contract.routes.map((item) => item.id), contract.target.id, ...contract.graphNodes.map((item) => item.id)].sort();
  if (!isDeepStrictEqual(reachableIds(flow, contract.routes.map((item) => item.id)), expectedReachable)) fail('PATCH reachable graph mismatch');
  if (typeof source !== 'string' || sha256(source) !== contract.target.sourceSha256) fail('PATCH tracked source contract mismatch');
  target.func = source;
  const changedNodes = flow.flatMap((node, index) => isDeepStrictEqual(node, before[index]) ? [] : [{ id: node.id, changedFields: Object.keys(node).filter((key) => !isDeepStrictEqual(node[key], before[index][key])).sort() }]);
  if (!isDeepStrictEqual(changedNodes, [{
    id: contract.target.id,
    changedFields: ['func'],
  }])) fail('PATCH candidate must change only the target function');
  const afterInvariants = invariants(flow);
  if (!isDeepStrictEqual(beforeInvariants, afterInvariants)) fail('Candidate changed flow topology');
  return { candidate: flow, changedNodes, reachableNodeCount: expectedReachable.length };
}

const isWithin = (parent, child) => child === parent || child.startsWith(`${parent}${path.sep}`);

function publicationPaths(outputArg, reportArg, workspace) {
  if (!path.isAbsolute(outputArg) || !path.isAbsolute(reportArg)) fail('Output and report paths must be absolute');
  if (path.resolve(outputArg) === path.resolve(reportArg)) fail('Output and report must be distinct');
  const directory = path.dirname(path.resolve(outputArg));
  if (path.dirname(path.resolve(reportArg)) !== directory) fail('Output and report must share one new publication directory');
  const parentArg = path.dirname(directory);
  if (fs.existsSync(directory) || fs.lstatSync(parentArg).isSymbolicLink()) fail('Publication directory must not already exist or use a symlink parent');
  const parent = fs.realpathSync(parentArg);
  const canonicalDirectory = path.join(parent, path.basename(directory));
  const output = path.join(canonicalDirectory, path.basename(outputArg));
  const report = path.join(canonicalDirectory, path.basename(reportArg));
  if (canonicalDirectory !== directory || output !== outputArg || report !== reportArg) fail('Output and report paths must be canonical');
  if (isWithin(REPO_ROOT, directory) || isWithin(path.join(workspace, 'input'), directory)) fail('Publication directory must be outside repository and verified input');
  const stagePrefix = `.${path.basename(directory)}.games-patch-stage-`;
  if (fs.readdirSync(parent).some((name) => name.startsWith(stagePrefix))) fail('Partial games-patch publication exists');
  return { directory, parent, output, report, stagePrefix };
}

function writePrivate(filePath, value) {
  const descriptor = fs.openSync(filePath, fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_WRONLY, 0o600);
  try { fs.writeFileSync(descriptor, value); fs.fsyncSync(descriptor); } finally { fs.closeSync(descriptor); }
}

export function readVerifiedGamesPatchBytes(verified) {
  const bytes = fs.readFileSync(verified.sourcePath);
  if (sha256(bytes) !== verified.sourceSha256) fail('Verified Node-RED source changed after verification');
  return bytes;
}

export function publishGamesPatchCandidate({ workspace, output, report, contract = GAMES_PATCH_CONTRACT }) {
  const verified = verifyWorkspace(workspace, { quiet: true });
  if (verified.sourceSha256 !== contract.wholeFlowSha256) fail('Verified workspace SHA mismatch');
  const sourceBytes = readVerifiedGamesPatchBytes(verified);
  const paths = publicationPaths(output, report, verified.workspace);
  const source = fs.readFileSync(PATCH_SOURCE_PATH, 'utf8');
  const result = synchronizeGamesPatch(structuredClone(verified.source), source, verified.sourceSha256, contract);
  const candidateBytes = result.changedNodes.length === 0 ? sourceBytes : Buffer.from(`${JSON.stringify(result.candidate, null, 2)}\n`);
  const candidateSha256 = sha256(candidateBytes);
  const redactedReport = { formatVersion: 1, ok: true, sourceSha256: verified.sourceSha256, candidateSha256, changedNodeCount: result.changedNodes.length, changedNodes: result.changedNodes, reachableNodeCount: result.reachableNodeCount };
  const stage = path.join(paths.parent, `${paths.stagePrefix}${process.pid}-${crypto.randomUUID()}`);
  fs.mkdirSync(stage, { mode: 0o700 });
  try {
    writePrivate(path.join(stage, path.basename(paths.output)), candidateBytes);
    writePrivate(path.join(stage, path.basename(paths.report)), Buffer.from(`${JSON.stringify(redactedReport, null, 2)}\n`));
    fs.renameSync(stage, paths.directory);
  } catch (error) { fs.rmSync(stage, { recursive: true, force: true }); throw error; }
  return redactedReport;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const values = Object.fromEntries(Array.from({ length: (process.argv.length - 2) / 2 }, (_, index) => [process.argv[2 + index * 2], process.argv[3 + index * 2]]));
  if (process.argv.length !== 8 || !values['--workspace'] || !values['--output'] || !values['--report'] || Object.keys(values).length !== 3) fail('Usage: node scripts/patch_live_games_patch.mjs --workspace <workspace> --output <candidate.json> --report <report.json>');
  process.stdout.write(`${JSON.stringify(publishGamesPatchCandidate({ workspace: values['--workspace'], output: values['--output'], report: values['--report'] }))}\n`);
}
