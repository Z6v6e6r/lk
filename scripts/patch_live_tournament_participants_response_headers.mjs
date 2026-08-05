#!/usr/bin/env node

import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import { fileURLToPath } from 'node:url';
import { verifyWorkspace } from './verify_nodered_source_origin.mjs';

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = fs.realpathSync(path.resolve(SCRIPT_DIR, '..'));
export const TERMINAL_SOURCE_PATH = path.join(
  SCRIPT_DIR,
  'nodered_tournament_participants_nodes/fn_terminal_v2.js',
);

export const PARTICIPANTS_HEADERS_CONTRACT = Object.freeze({
  wholeFlowSha256: 'cb109f305bf48ff5f6026b5ff0ef944a3cfd49e81da247c757a90f1a880f43a2',
  nodeCount: 4673,
  httpRouteCount: 203,
  tab: {
    id: 'f9575c8726e29196',
    label: 'LK Tournaments',
    nodeSha256: 'a2eef6cfba178dfc93d8d70f8145310820dbfda6c6adee09ffc9108bd9b1f4e9',
  },
  route: {
    id: 'e0836350a9474a78',
    name: 'LK tournaments participants',
    method: 'get',
    url: '/lk/tournaments/participants',
    nodeSha256: '0efe3ee24bd0cdbcfed6d4a5204d5618cb2e0078c60e6f8a13d6f2a212a1d692',
  },
  target: {
    id: 'lk_tournament_participants_terminal_20260719',
    name: 'Participants cache terminal v2',
    outputs: 1,
    wires: [['afef710ac9f58b69']],
    preimageSha256: '2772af0a50c4ff0475179020417222d27e7aa296bf48ec2d0cc4e52139019429',
    sourceSha256: 'b83a269ae242baab05c918bb427cda29341056494260cc34df235cd2760dbf23',
    nodeSha256: '60b5eceec0a190159afb12340ed2bece34a8f6eb2e63680c2242cbd3cc554b35',
  },
  response: {
    id: 'afef710ac9f58b69',
    nodeSha256: '2589e894e1471830c99b760f9deff66848f655aa9d66d9e997bacf6341152596',
  },
  reachableNodeCount: 20,
  reachableGraphSha256: '792798b4bcc7afe3217df95df8b640f29088a3eea54428e1de458824b6ed0652',
});

const sha256 = (value) => crypto.createHash('sha256').update(value).digest('hex');
const sha256Json = (value) => sha256(Buffer.from(JSON.stringify(value), 'utf8'));
const fail = (message) => { throw new Error(message); };

function exactNode(flow, id) {
  const nodes = flow.filter((node) => node?.id === id);
  if (nodes.length !== 1) fail(`Node ${id} must exist exactly once`);
  return nodes[0];
}

function assertNoBrokenWires(flow) {
  const ids = new Set(flow.map((node) => node.id));
  for (const node of flow) {
    for (const output of node.wires ?? []) {
      for (const target of output ?? []) {
        if (!ids.has(target)) fail(`Node ${node.id} references missing wire target ${target}`);
      }
    }
  }
}

function flowInvariants(flow) {
  const ids = flow.map((node) => node.id);
  if (new Set(ids).size !== ids.length) fail('Flow contains duplicate node IDs');
  assertNoBrokenWires(flow);
  return {
    topology: flow.map((node) => ({
      id: node.id,
      wires: Object.hasOwn(node, 'wires') ? node.wires : null,
      links: Object.hasOwn(node, 'links') ? node.links : null,
    })),
    httpRoutes: flow.filter((node) => node.type === 'http in').map((node) => ({
      id: node.id,
      z: node.z ?? '',
      method: node.method ?? '',
      url: node.url ?? '',
      wires: node.wires ?? null,
    })),
  };
}

function reachableGraph(flow, startId) {
  const nodes = new Map(flow.map((node) => [node.id, node]));
  const seen = new Set();
  const pending = [startId];
  while (pending.length > 0) {
    const id = pending.shift();
    if (seen.has(id)) continue;
    const node = nodes.get(id);
    if (!node) fail(`Reachable graph references missing node ${id}`);
    seen.add(id);
    for (const output of node.wires ?? []) {
      for (const target of output ?? []) pending.push(target);
    }
  }
  return [...seen].sort().map((id) => {
    const node = nodes.get(id);
    return {
      id: node.id,
      type: node.type,
      z: node.z || '',
      name: node.name || '',
      url: node.url || '',
      method: node.method || '',
      outputs: node.outputs ?? null,
      wires: node.wires ?? null,
    };
  });
}

export function synchronizeParticipantsHeaders(
  flow,
  source,
  sourceSha256,
  contract = PARTICIPANTS_HEADERS_CONTRACT,
) {
  if (sourceSha256 !== contract.wholeFlowSha256) fail('Flow preimage SHA mismatch');
  if (!Array.isArray(flow) || flow.length !== contract.nodeCount) fail('Flow node count mismatch');

  const before = structuredClone(flow);
  const beforeInvariants = flowInvariants(before);
  if (beforeInvariants.httpRoutes.length !== contract.httpRouteCount) fail('HTTP route count mismatch');

  const tab = exactNode(flow, contract.tab.id);
  if (
    tab.type !== 'tab'
    || tab.label !== contract.tab.label
    || tab.disabled !== false
    || sha256Json(tab) !== contract.tab.nodeSha256
  ) fail('Tournament tab contract mismatch');

  const route = exactNode(flow, contract.route.id);
  if (
    route.type !== 'http in'
    || route.z !== contract.tab.id
    || route.name !== contract.route.name
    || route.method !== contract.route.method
    || route.url !== contract.route.url
    || sha256Json(route) !== contract.route.nodeSha256
  ) fail('Participants route contract mismatch');

  const target = exactNode(flow, contract.target.id);
  if (
    target.type !== 'function'
    || target.z !== contract.tab.id
    || target.name !== contract.target.name
    || target.outputs !== contract.target.outputs
    || !isDeepStrictEqual(target.wires, contract.target.wires)
    || sha256Json(target) !== contract.target.nodeSha256
    || sha256(String(target.func ?? '')) !== contract.target.preimageSha256
  ) fail('Participants terminal preimage mismatch');

  const response = exactNode(flow, contract.response.id);
  if (
    response.type !== 'http response'
    || response.z !== contract.tab.id
    || sha256Json(response) !== contract.response.nodeSha256
  ) fail('Participants HTTP response contract mismatch');

  const reachable = reachableGraph(flow, contract.route.id);
  if (
    reachable.length !== contract.reachableNodeCount
    || sha256Json(reachable) !== contract.reachableGraphSha256
  ) fail('Participants reachable graph mismatch');
  const reachableResponses = reachable
    .filter((node) => node.type === 'http response')
    .map((node) => node.id);
  if (!isDeepStrictEqual(reachableResponses, [contract.response.id])) {
    fail('Participants route must have exactly one verified HTTP response');
  }

  if (typeof source !== 'string' || sha256(source) !== contract.target.sourceSha256) {
    fail('Tracked participants terminal source mismatch');
  }
  target.func = source;

  const changedNodes = flow.flatMap((node, index) => (
    isDeepStrictEqual(node, before[index])
      ? []
      : [{
        id: node.id,
        changedFields: Object.keys(node)
          .filter((key) => !isDeepStrictEqual(node[key], before[index][key]))
          .sort(),
      }]
  ));
  if (!isDeepStrictEqual(changedNodes, [{
    id: contract.target.id,
    changedFields: ['func'],
  }])) fail('Candidate must change only the participants terminal function');

  const afterInvariants = flowInvariants(flow);
  if (!isDeepStrictEqual(beforeInvariants, afterInvariants)) fail('Candidate changed flow topology');
  if (sha256Json(reachableGraph(flow, contract.route.id)) !== contract.reachableGraphSha256) {
    fail('Candidate changed the participants reachable graph');
  }

  return {
    candidate: flow,
    changedNodes,
    reachableNodeCount: reachable.length,
  };
}

const isWithin = (parent, child) => {
  const relative = path.relative(parent, child);
  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
};

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
  if (isWithin(REPO_ROOT, directory) || isWithin(path.join(workspace, 'input'), directory)) {
    fail('Publication directory must be outside repository and verified input');
  }
  const stagePrefix = `.${path.basename(directory)}.participants-headers-stage-`;
  if (fs.readdirSync(parent).some((name) => name.startsWith(stagePrefix))) {
    fail('Partial participants-headers publication exists');
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

export function publishParticipantsHeadersCandidate({
  workspace,
  output,
  report,
  contract = PARTICIPANTS_HEADERS_CONTRACT,
}) {
  const verified = verifyWorkspace(workspace, { quiet: true });
  if (verified.sourceSha256 !== contract.wholeFlowSha256) fail('Verified workspace SHA mismatch');
  const sourceBytes = fs.readFileSync(verified.sourcePath);
  if (sha256(sourceBytes) !== verified.sourceSha256) {
    fail('Verified Node-RED source changed after verification');
  }
  const paths = publicationPaths(output, report, verified.workspace);
  const source = fs.readFileSync(TERMINAL_SOURCE_PATH, 'utf8');
  const result = synchronizeParticipantsHeaders(
    structuredClone(verified.source),
    source,
    verified.sourceSha256,
    contract,
  );
  const candidateBytes = Buffer.from(`${JSON.stringify(result.candidate, null, 2)}\n`);
  const candidateSha256 = sha256(candidateBytes);
  const redactedReport = {
    formatVersion: 1,
    ok: true,
    endpoint: contract.route.url,
    sourceSha256: verified.sourceSha256,
    candidateSha256,
    nodeCount: result.candidate.length,
    httpRouteCount: contract.httpRouteCount,
    changedNodeCount: result.changedNodes.length,
    changedNodes: result.changedNodes,
    reachableNodeCount: result.reachableNodeCount,
    deploymentPerformed: false,
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
  return redactedReport;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2);
  const values = Object.fromEntries(
    Array.from({ length: args.length / 2 }, (_, index) => [args[index * 2], args[index * 2 + 1]]),
  );
  if (
    args.length !== 6
    || !values['--workspace']
    || !values['--output']
    || !values['--report']
    || Object.keys(values).length !== 3
  ) {
    fail(
      'Usage: node scripts/patch_live_tournament_participants_response_headers.mjs '
      + '--workspace <workspace> --output <candidate.json> --report <report.json>',
    );
  }
  process.stdout.write(`${JSON.stringify(publishParticipantsHeadersCandidate({
    workspace: values['--workspace'],
    output: values['--output'],
    report: values['--report'],
  }))}\n`);
}
