import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { isDeepStrictEqual } from 'node:util';
import { fileURLToPath } from 'node:url';
import {
  CHAT_CONTRACT,
  publishChatCandidate,
  readVerifiedSourceBytes,
  synchronizeChatFlow,
} from '../patch_nodered_chat_flow.mjs';
import { verifyWorkspace } from '../verify_nodered_source_origin.mjs';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const CHAT_SOURCE_DIR = path.join(REPO_ROOT, 'scripts/nodered_chat_nodes');
const TEMP_ROOTS = [];

function sha256(value) {
  return crypto.createHash('sha256').update(value).digest('hex');
}

function tempRoot() {
  const created = fs.mkdtempSync(path.join(os.tmpdir(), 'lk-chat-recovery-'));
  const canonical = fs.realpathSync(created);
  TEMP_ROOTS.push(canonical);
  return canonical;
}

test.after(() => {
  for (const directory of TEMP_ROOTS) {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

function sourcesByFile() {
  return Object.fromEntries(CHAT_CONTRACT.functions.map((mapping) => [
    mapping.file,
    fs.readFileSync(path.join(CHAT_SOURCE_DIR, mapping.file), 'utf8'),
  ]));
}

function fixtureFlow() {
  const sources = sourcesByFile();
  return [
    { ...CHAT_CONTRACT.tab, info: '' },
    ...CHAT_CONTRACT.routes.map((route) => ({ ...route, upload: false })),
    ...CHAT_CONTRACT.functions.map((mapping) => ({
      id: mapping.id,
      type: 'function',
      z: CHAT_CONTRACT.tab.id,
      name: mapping.name,
      func: sources[mapping.file],
      outputs: mapping.outputs,
      wires: structuredClone(mapping.wires),
      timeout: '',
      noerr: 0,
    })),
  ];
}

function fixtureContract(flow, raw) {
  const contract = {
    ...structuredClone(CHAT_CONTRACT),
    wholeFlowSha256: sha256(raw),
    nodeCount: flow.length,
    httpRouteCount: CHAT_CONTRACT.routes.length,
  };
  for (const mapping of contract.functions) {
    const fixtureSource = String(
      flow.find((node) => node.id === mapping.id)?.func ?? '',
    );
    mapping.preimageSha256 = sha256(fixtureSource);
    mapping.sourceSha256 = sha256(fixtureSource);
  }
  return contract;
}

function createVerifiedWorkspace() {
  const root = tempRoot();
  const workspace = path.join(root, 'workspace');
  const input = path.join(workspace, 'input');
  fs.mkdirSync(input, { recursive: true, mode: 0o700 });
  fs.chmodSync(workspace, 0o700);
  fs.chmodSync(input, 0o700);
  const sourcePath = path.join(input, 'source.flow.json');
  const metaPath = path.join(input, 'source.flow.meta.json');
  const flow = fixtureFlow();
  const raw = Buffer.from(`${JSON.stringify(flow, null, 2)}\n`, 'utf8');
  fs.writeFileSync(sourcePath, raw, { mode: 0o600 });
  const contract = fixtureContract(flow, raw);
  const meta = {
    formatVersion: 1,
    sourceKind: 'live-147',
    sourceHost: 'lk-primary-147',
    sourceUser: 'root',
    sourcePort: '22',
    remoteFlowPath: '/root/.node-red/flows.json',
    localSourcePath: sourcePath,
    pulledAt: new Date().toISOString(),
    sourceSha256: contract.wholeFlowSha256,
    nodeCount: flow.length,
  };
  fs.writeFileSync(metaPath, `${JSON.stringify(meta, null, 2)}\n`, { mode: 0o600 });
  fs.chmodSync(sourcePath, 0o600);
  fs.chmodSync(metaPath, 0o600);
  return { root, workspace, flow, raw, contract, sourcePath };
}

test('all 11 tracked chat sources match pinned source contracts', () => {
  const sources = sourcesByFile();
  assert.equal(CHAT_CONTRACT.functions.length, 11);
  for (const mapping of CHAT_CONTRACT.functions) {
    const actual = sha256(sources[mapping.file]);
    assert.equal(actual, mapping.sourceSha256, mapping.file);
  }
});

test('three promoted chat candidates remain distinct from their live preimages', () => {
  const promotedCandidates = {
    'fn_chat_get_build_query.js': '0a6bae2353a33db70df4122cf311a726d6bb51866fd41998efbdb47758cb3ef2',
    'fn_chat_post_build_insert.js': '029583aa83efb6becc0cf52b683e58d474bd01fa3bc80d81e76af8afabea7aa7',
    'fn_chat_read_insert.js': '0ad53e135d6f41111b013c796d485a25f621fab2aaef2863aecc9081351f873f',
  };
  const byFile = new Map(CHAT_CONTRACT.functions.map((mapping) => [mapping.file, mapping]));
  for (const [file, candidateSha256] of Object.entries(promotedCandidates)) {
    const mapping = byFile.get(file);
    assert.equal(mapping.sourceSha256, candidateSha256);
    assert.notEqual(mapping.preimageSha256, candidateSha256);
  }
});

test('current approved functions produce a zero-change semantic candidate', () => {
  const flow = fixtureFlow();
  const raw = Buffer.from(`${JSON.stringify(flow, null, 2)}\n`);
  const contract = fixtureContract(flow, raw);
  const result = synchronizeChatFlow(
    structuredClone(flow),
    sourcesByFile(),
    contract.wholeFlowSha256,
    contract,
  );
  assert.equal(isDeepStrictEqual(result.candidate, flow), true);
  assert.deepEqual(result.changedNodes, []);
  assert.equal(result.invariants.nodeCount, flow.length);
  assert.equal(result.invariants.httpRouteCount, 4);
});

test('whole-flow, tab, route, function identity, wires, and preimage guards fail closed', () => {
  const base = fixtureFlow();
  const raw = Buffer.from(`${JSON.stringify(base, null, 2)}\n`);
  const contract = fixtureContract(base, raw);
  const sync = (flow, sourceSha256 = contract.wholeFlowSha256) => synchronizeChatFlow(
    flow,
    sourcesByFile(),
    sourceSha256,
    contract,
  );

  assert.throws(() => sync(structuredClone(base), '0'.repeat(64)), /Flow preimage SHA/);

  const tabDrift = structuredClone(base);
  tabDrift[0].label = 'LK Games drift';
  assert.throws(() => sync(tabDrift), /Chat tab.*label/);

  const missingFunction = structuredClone(base)
    .filter((node) => node.id !== CHAT_CONTRACT.functions[0].id);
  assert.throws(() => sync(missingFunction), /node count mismatch/);

  const duplicateFunction = structuredClone(base);
  duplicateFunction.push(structuredClone(
    duplicateFunction.find((node) => node.id === CHAT_CONTRACT.functions[0].id),
  ));
  assert.throws(() => synchronizeChatFlow(
    duplicateFunction,
    sourcesByFile(),
    contract.wholeFlowSha256,
    { ...contract, nodeCount: duplicateFunction.length },
  ), /duplicate node IDs|must exist exactly once/);

  const functionNameDrift = structuredClone(base);
  functionNameDrift.find((node) => node.id === CHAT_CONTRACT.functions[0].id).name = 'Renamed';
  assert.throws(() => sync(functionNameDrift), /Chat function.*name/);

  const functionTabDrift = structuredClone(base);
  functionTabDrift.find((node) => node.id === CHAT_CONTRACT.functions[0].id).z = 'wrong-tab';
  assert.throws(() => sync(functionTabDrift), /Chat function.*z/);

  const routeDrift = structuredClone(base);
  routeDrift.find((node) => node.id === CHAT_CONTRACT.routes[0].id).wires = [[]];
  assert.throws(() => sync(routeDrift), /Chat route.*wires/);

  const routeMethodDrift = structuredClone(base);
  routeMethodDrift.find((node) => node.id === CHAT_CONTRACT.routes[0].id).method = 'put';
  assert.throws(() => sync(routeMethodDrift), /Chat route.*method/);

  const routeUrlDrift = structuredClone(base);
  routeUrlDrift.find((node) => node.id === CHAT_CONTRACT.routes[0].id).url = '/wrong';
  assert.throws(() => sync(routeUrlDrift), /Chat route.*url/);

  const functionDrift = structuredClone(base);
  functionDrift.find((node) => node.id === CHAT_CONTRACT.functions[0].id).outputs = 2;
  assert.throws(() => sync(functionDrift), /Chat function.*outputs/);

  const wireDrift = structuredClone(base);
  wireDrift.find((node) => node.id === CHAT_CONTRACT.functions[0].id).wires = [[]];
  assert.throws(() => sync(wireDrift), /Chat function.*wires/);

  const bodyDrift = structuredClone(base);
  bodyDrift.find((node) => node.id === CHAT_CONTRACT.functions[0].id).func += '\n';
  assert.throws(() => sync(bodyDrift), /preimage mismatch/);
});

test('an explicitly contracted source update can change only func', () => {
  const flow = fixtureFlow();
  const raw = Buffer.from(`${JSON.stringify(flow, null, 2)}\n`);
  const contract = fixtureContract(flow, raw);
  const sources = sourcesByFile();
  const mapping = contract.functions[0];
  sources[mapping.file] += '\n// approved-test-candidate\n';
  mapping.sourceSha256 = sha256(sources[mapping.file]);

  const result = synchronizeChatFlow(
    structuredClone(flow),
    sources,
    contract.wholeFlowSha256,
    contract,
  );
  assert.deepEqual(result.changedNodes, [{
    id: mapping.id,
    changedFields: ['func'],
  }]);
  const changedIds = result.candidate
    .filter((node, index) => !isDeepStrictEqual(node, flow[index]))
    .map((node) => node.id);
  assert.equal(isDeepStrictEqual(changedIds, [mapping.id]), true);
});

test('verified external publication is private, atomic, redacted, and byte-identical at zero change', () => {
  const workspace = createVerifiedWorkspace();
  const publicationDirectory = path.join(workspace.root, 'publication');
  const output = path.join(publicationDirectory, 'candidate.json');
  const report = path.join(publicationDirectory, 'report.json');
  const result = publishChatCandidate({
    workspace: workspace.workspace,
    output,
    report,
    contract: workspace.contract,
  });

  assert.equal(result.changedNodeCount, 0);
  assert.equal(result.sourceSha256, result.candidateSha256);
  assert.equal(sha256(fs.readFileSync(output)), sha256(workspace.raw));
  assert.equal(fs.statSync(publicationDirectory).mode & 0o777, 0o700);
  assert.equal(fs.statSync(output).mode & 0o777, 0o600);
  assert.equal(fs.statSync(report).mode & 0o777, 0o600);
  const reportText = fs.readFileSync(report, 'utf8');
  assert.doesNotMatch(reportText, /\/lk\/|function|return msg|source\.flow|private\/tmp/);
  assert.deepEqual(Object.keys(JSON.parse(reportText)).sort(), [
    'candidateSha256',
    'changedNodeCount',
    'changedNodes',
    'formatVersion',
    'invariants',
    'ok',
    'sourceSha256',
  ]);
});

test('verified source bytes fail closed if the file changes after verification', () => {
  const workspace = createVerifiedWorkspace();
  const verified = verifyWorkspace(workspace.workspace, { quiet: true });
  fs.appendFileSync(workspace.sourcePath, '\n');
  fs.chmodSync(workspace.sourcePath, 0o600);

  assert.throws(
    () => readVerifiedSourceBytes(verified),
    /changed after verification/,
  );
  assert.equal(fs.existsSync(path.join(workspace.root, 'publication')), false);
  assert.equal(
    fs.readdirSync(workspace.root).some((name) => name.includes('chat-recovery-stage')),
    false,
  );
});

test('existing, partial, non-atomic, and repository publication targets are rejected', () => {
  const existing = createVerifiedWorkspace();
  const existingDirectory = path.join(existing.root, 'existing');
  fs.mkdirSync(existingDirectory, { mode: 0o700 });
  assert.throws(() => publishChatCandidate({
    workspace: existing.workspace,
    output: path.join(existingDirectory, 'candidate.json'),
    report: path.join(existingDirectory, 'report.json'),
    contract: existing.contract,
  }), /must not already exist/);

  const split = createVerifiedWorkspace();
  assert.throws(() => publishChatCandidate({
    workspace: split.workspace,
    output: path.join(split.root, 'output', 'candidate.json'),
    report: path.join(split.root, 'report', 'report.json'),
    contract: split.contract,
  }), /share one new publication directory/);

  const partial = createVerifiedWorkspace();
  fs.mkdirSync(path.join(partial.root, '.publication.chat-recovery-stage-stale'), { mode: 0o700 });
  assert.throws(() => publishChatCandidate({
    workspace: partial.workspace,
    output: path.join(partial.root, 'publication', 'candidate.json'),
    report: path.join(partial.root, 'publication', 'report.json'),
    contract: partial.contract,
  }), /Partial chat candidate publication/);

  const stale = createVerifiedWorkspace();
  const staleMetaPath = path.join(stale.workspace, 'input', 'source.flow.meta.json');
  const staleMeta = JSON.parse(fs.readFileSync(staleMetaPath, 'utf8'));
  staleMeta.pulledAt = new Date(Date.now() - (31 * 60 * 1000)).toISOString();
  fs.writeFileSync(staleMetaPath, `${JSON.stringify(staleMeta, null, 2)}\n`);
  fs.chmodSync(staleMetaPath, 0o600);
  assert.throws(() => publishChatCandidate({
    workspace: stale.workspace,
    output: path.join(stale.root, 'publication', 'candidate.json'),
    report: path.join(stale.root, 'publication', 'report.json'),
    contract: stale.contract,
  }), /stale/);

  const symlinkParent = createVerifiedWorkspace();
  const actualParent = path.join(symlinkParent.root, 'actual-parent');
  const aliasParent = path.join(symlinkParent.root, 'alias-parent');
  fs.mkdirSync(actualParent, { mode: 0o700 });
  fs.symlinkSync(actualParent, aliasParent);
  assert.throws(() => publishChatCandidate({
    workspace: symlinkParent.workspace,
    output: path.join(aliasParent, 'publication', 'candidate.json'),
    report: path.join(aliasParent, 'publication', 'report.json'),
    contract: symlinkParent.contract,
  }), /symlink parent|canonical/);
  assert.equal(fs.existsSync(path.join(actualParent, 'publication')), false);

  const atomicFailure = createVerifiedWorkspace();
  const atomicDirectory = path.join(atomicFailure.root, 'publication');
  assert.throws(() => publishChatCandidate({
    workspace: atomicFailure.workspace,
    output: path.join(atomicDirectory, 'candidate.json'),
    report: path.join(atomicDirectory, `${'r'.repeat(260)}.json`),
    contract: atomicFailure.contract,
  }));
  assert.equal(fs.existsSync(atomicDirectory), false);
  assert.equal(
    fs.readdirSync(atomicFailure.root).some(
      (name) => name.startsWith('.publication.chat-recovery-stage-'),
    ),
    false,
  );

  const insideRepo = createVerifiedWorkspace();
  const uniqueDirectory = path.join(
    REPO_ROOT,
    `.nodered-chat-recovery-${process.pid}-${crypto.randomUUID()}`,
  );
  assert.equal(fs.existsSync(uniqueDirectory), false);
  assert.throws(() => publishChatCandidate({
    workspace: insideRepo.workspace,
    output: path.join(uniqueDirectory, 'candidate.json'),
    report: path.join(uniqueDirectory, 'report.json'),
    contract: insideRepo.contract,
  }), /outside the repository/);
  assert.equal(fs.existsSync(uniqueDirectory), false);
});
