import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { isDeepStrictEqual } from 'node:util';
import { fileURLToPath } from 'node:url';
import {
  DIRECT_LOOKUP_CONTRACT,
  publishDirectLookupCandidate,
  readVerifiedDirectLookupBytes,
  synchronizeDirectLookup,
} from '../patch_live_games_direct_lookup.mjs';
import { verifyWorkspace } from '../verify_nodered_source_origin.mjs';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const QUERY_PATH = path.join(REPO_ROOT, 'scripts/nodered_games_nodes/fn_get_by_id_query.js');
const RESPONSE_PATH = path.join(REPO_ROOT, 'scripts/nodered_games_nodes/fn_get_by_id_resp.js');
const LIST_NORMALIZER_PATH = path.join(
  REPO_ROOT,
  'scripts/nodered_games_nodes/fn_list_normalize.js',
);
const TEMP_ROOTS = [];

function sha256(value) {
  return crypto.createHash('sha256').update(value).digest('hex');
}

function sha256Json(value) {
  return sha256(Buffer.from(JSON.stringify(value), 'utf8'));
}

function querySource() {
  return fs.readFileSync(QUERY_PATH, 'utf8');
}

function responseSource() {
  return fs.readFileSync(RESPONSE_PATH, 'utf8');
}

function listNormalizerSource() {
  return fs.readFileSync(LIST_NORMALIZER_PATH, 'utf8');
}

function runQuery(params = {}, query = {}) {
  const msg = { req: { params, query } };
  const result = new Function('msg', querySource())(msg);
  return { msg, result };
}

function tempRoot() {
  const created = fs.mkdtempSync(path.join(os.tmpdir(), 'lk-direct-lookup-'));
  const canonical = fs.realpathSync(created);
  TEMP_ROOTS.push(canonical);
  return canonical;
}

test.after(() => {
  for (const directory of TEMP_ROOTS) fs.rmSync(directory, { recursive: true, force: true });
});

function fixture() {
  const responseFunc = responseSource();
  const flow = [
    { ...DIRECT_LOOKUP_CONTRACT.tab, info: '' },
    ...DIRECT_LOOKUP_CONTRACT.routes.map((route) => ({
      id: route.id,
      type: route.type,
      z: route.z,
      name: route.name,
      url: route.url,
      method: route.method,
      upload: false,
      swaggerDoc: '',
      wires: structuredClone(route.wires),
    })),
    {
      id: DIRECT_LOOKUP_CONTRACT.query.id,
      type: 'function',
      z: DIRECT_LOOKUP_CONTRACT.tab.id,
      name: DIRECT_LOOKUP_CONTRACT.query.name,
      func: querySource(),
      outputs: 2,
      wires: structuredClone(DIRECT_LOOKUP_CONTRACT.query.wires),
    },
    {
      id: DIRECT_LOOKUP_CONTRACT.mongo.id,
      type: 'mongodb4',
      z: DIRECT_LOOKUP_CONTRACT.tab.id,
      name: DIRECT_LOOKUP_CONTRACT.mongo.name,
      clientNode: DIRECT_LOOKUP_CONTRACT.mongo.clientNode,
      mode: DIRECT_LOOKUP_CONTRACT.mongo.mode,
      collection: DIRECT_LOOKUP_CONTRACT.mongo.collection,
      operation: DIRECT_LOOKUP_CONTRACT.mongo.operation,
      output: DIRECT_LOOKUP_CONTRACT.mongo.output,
      maxTimeMS: DIRECT_LOOKUP_CONTRACT.mongo.maxTimeMS,
      handleDocId: false,
      wires: structuredClone(DIRECT_LOOKUP_CONTRACT.mongo.wires),
    },
    {
      id: DIRECT_LOOKUP_CONTRACT.response.id,
      type: 'function',
      z: DIRECT_LOOKUP_CONTRACT.tab.id,
      name: DIRECT_LOOKUP_CONTRACT.response.name,
      func: responseFunc,
      outputs: 2,
      wires: structuredClone(DIRECT_LOOKUP_CONTRACT.response.wires),
    },
    {
      id: DIRECT_LOOKUP_CONTRACT.listNormalizer.id,
      type: 'function',
      z: DIRECT_LOOKUP_CONTRACT.listNormalizer.z,
      name: DIRECT_LOOKUP_CONTRACT.listNormalizer.name,
      func: listNormalizerSource(),
      outputs: DIRECT_LOOKUP_CONTRACT.listNormalizer.outputs,
      wires: structuredClone(DIRECT_LOOKUP_CONTRACT.listNormalizer.wires),
    },
    {
      id: DIRECT_LOOKUP_CONTRACT.httpResponse.id,
      type: 'http response',
      z: DIRECT_LOOKUP_CONTRACT.tab.id,
      name: '',
      wires: [],
    },
    {
      id: DIRECT_LOOKUP_CONTRACT.diagnostic.id,
      type: 'debug',
      z: DIRECT_LOOKUP_CONTRACT.tab.id,
      name: DIRECT_LOOKUP_CONTRACT.diagnostic.name,
      active: false,
      wires: [],
    },
  ];
  const raw = Buffer.from(`${JSON.stringify(flow, null, 2)}\n`);
  const contract = structuredClone(DIRECT_LOOKUP_CONTRACT);
  contract.wholeFlowSha256 = sha256(raw);
  contract.nodeCount = flow.length;
  contract.httpRouteCount = contract.routes.length;
  for (const route of contract.routes) {
    route.nodeSha256 = sha256Json(flow.find((node) => node.id === route.id));
  }
  for (const part of [
    'query', 'mongo', 'response', 'listNormalizer', 'httpResponse', 'diagnostic',
  ]) {
    contract[part].nodeSha256 = sha256Json(flow.find((node) => node.id === contract[part].id));
  }
  contract.response.preimageSha256 = sha256(responseFunc);
  contract.response.sourceSha256 = sha256(responseFunc);
  contract.listNormalizer.preimageSha256 = sha256(listNormalizerSource());
  contract.listNormalizer.sourceSha256 = sha256(listNormalizerSource());
  return { flow, raw, contract };
}

function workspaceFixture() {
  const root = tempRoot();
  const workspace = path.join(root, 'workspace');
  const input = path.join(workspace, 'input');
  fs.mkdirSync(input, { recursive: true, mode: 0o700 });
  fs.chmodSync(workspace, 0o700);
  fs.chmodSync(input, 0o700);
  const built = fixture();
  const sourcePath = path.join(input, 'source.flow.json');
  const metaPath = path.join(input, 'source.flow.meta.json');
  fs.writeFileSync(sourcePath, built.raw, { mode: 0o600 });
  fs.writeFileSync(metaPath, `${JSON.stringify({
    formatVersion: 1,
    sourceKind: 'live-147',
    sourceHost: 'lk-primary-147',
    sourceUser: 'root',
    sourcePort: '22',
    remoteFlowPath: '/root/.node-red/flows.json',
    localSourcePath: sourcePath,
    pulledAt: new Date().toISOString(),
    sourceSha256: built.contract.wholeFlowSha256,
    nodeCount: built.flow.length,
  }, null, 2)}\n`, { mode: 0o600 });
  fs.chmodSync(sourcePath, 0o600);
  fs.chmodSync(metaPath, 0o600);
  return { root, workspace, sourcePath, ...built };
}

test('tracked query is the exact current live/dirty-equal function', () => {
  assert.equal(sha256(querySource()), DIRECT_LOOKUP_CONTRACT.query.sourceSha256);
  assert.equal(
    DIRECT_LOOKUP_CONTRACT.query.sourceSha256,
    DIRECT_LOOKUP_CONTRACT.query.preimageSha256,
  );
});

test('tracked response is a pinned phone-redacting candidate', () => {
  assert.equal(sha256(responseSource()), DIRECT_LOOKUP_CONTRACT.response.sourceSha256);
  assert.notEqual(
    DIRECT_LOOKUP_CONTRACT.response.sourceSha256,
    DIRECT_LOOKUP_CONTRACT.response.preimageSha256,
  );
});

test('tracked list normalizer is a pinned phone-redacting candidate', () => {
  assert.equal(
    sha256(listNormalizerSource()),
    DIRECT_LOOKUP_CONTRACT.listNormalizer.sourceSha256,
  );
  assert.notEqual(
    DIRECT_LOOKUP_CONTRACT.listNormalizer.sourceSha256,
    DIRECT_LOOKUP_CONTRACT.listNormalizer.preimageSha256,
  );
});

test('reachable gameId builds the archived-safe direct lookup query', () => {
  const { msg, result } = runQuery({ gameId: 'game-42' });
  assert.equal(isDeepStrictEqual(result, [msg, null]), true);
  assert.equal(isDeepStrictEqual(msg.payload, {
    id: 'game-42',
    archived: { $ne: true },
  }), true);
});

test('empty lookup fails through second output with HTTP 400', () => {
  const { msg, result } = runQuery({ gameId: '  ' });
  assert.equal(isDeepStrictEqual(result, [null, msg]), true);
  assert.equal(msg.statusCode, 400);
  assert.equal(msg.payload.error, 'gameId or paymentRef or bookingIds is required');
});

test('unrouted paymentRef and bookingIds branches are characterized without API reachability claim', () => {
  const payment = runQuery({}, { paymentRef: 'pay-1' }).msg.payload;
  assert.equal(
    payment.$or.some((entry) => entry['metadata.splitPayment.payments.paymentRef'] === 'pay-1'),
    true,
  );
  const booking = runQuery({}, { bookingIds: 'b1,b2' }).msg.payload;
  assert.equal(
    booking.$or.some((entry) => isDeepStrictEqual(
      entry['metadata.splitPayment.payments.bookingIds'],
      { $in: ['b1', 'b2'] },
    )),
    true,
  );
  // Neither confirmed GET route supplies these query-only branches without :gameId.
  assert.equal(DIRECT_LOOKUP_CONTRACT.routes.every((route) => route.url.includes(':gameId')), true);
});

test('exact two routes and graph terminate through pinned response/HTTP/diagnostic nodes', () => {
  assert.equal(isDeepStrictEqual(
    DIRECT_LOOKUP_CONTRACT.routes.map((route) => [route.id, route.method, route.url, route.wires]),
    [
      ['afc9bf23bcc54804', 'get', '/lk/games/:gameId', [['b6bc67d99744e060']]],
      ['2cbeac53cecb3971', 'get', '/lk/games/records/:gameId', [['b6bc67d99744e060']]],
    ],
  ), true);
  assert.equal(isDeepStrictEqual(
    DIRECT_LOOKUP_CONTRACT.query.wires,
    [['8b64bb43086a39e1'], ['7b893cc97a815f66']],
  ), true);
  assert.equal(isDeepStrictEqual(
    DIRECT_LOOKUP_CONTRACT.response.wires,
    [['7b893cc97a815f66'], ['c45153b02914e7e4']],
  ), true);
});

test('zero-change synchronization preserves response and topology', () => {
  const built = fixture();
  const responseBefore = sha256Json(
    built.flow.find((node) => node.id === built.contract.response.id),
  );
  const result = synchronizeDirectLookup(
    structuredClone(built.flow),
    querySource(),
    responseSource(),
    listNormalizerSource(),
    built.contract.wholeFlowSha256,
    built.contract,
  );
  assert.equal(isDeepStrictEqual(result.changedNodes, []), true);
  assert.equal(isDeepStrictEqual(result.candidate, built.flow), true);
  assert.equal(
    sha256Json(result.candidate.find((node) => node.id === built.contract.response.id)),
    responseBefore,
  );
});

test('whole-flow, route, graph, node, func, response, and non-func drift fail closed', () => {
  const built = fixture();
  const sync = (flow, sha = built.contract.wholeFlowSha256) => synchronizeDirectLookup(
    flow,
    querySource(),
    responseSource(),
    listNormalizerSource(),
    sha,
    built.contract,
  );
  assert.throws(() => sync(structuredClone(built.flow), '0'.repeat(64)), /Flow preimage SHA/);
  for (const [id, field, value, pattern] of [
    [built.contract.tab.id, 'label', 'Wrong tab', /tab.*label/],
    [built.contract.routes[0].id, 'method', 'post', /route.*method/],
    [built.contract.query.id, 'name', 'Renamed direct lookup', /query.*name/],
    [built.contract.query.id, 'z', 'wrong-tab', /query.*z/],
    [built.contract.query.id, 'outputs', 1, /query.*outputs/],
    [built.contract.mongo.id, 'collection', 'wrong', /mongo.*collection/],
    [built.contract.response.id, 'wires', [[]], /response.*wires/],
    [built.contract.listNormalizer.id, 'outputs', 1, /normalizer.*outputs/i],
    [built.contract.diagnostic.id, 'active', true, /diagnostic.*active/],
  ]) {
    const drift = structuredClone(built.flow);
    drift.find((node) => node.id === id)[field] = value;
    assert.throws(() => sync(drift), pattern);
  }
  const bodyDrift = structuredClone(built.flow);
  bodyDrift.find((node) => node.id === built.contract.query.id).func += '\n';
  assert.throws(() => sync(bodyDrift), /node preimage|function preimage/);

  const hiddenNodeDrift = structuredClone(built.flow);
  hiddenNodeDrift.find((node) => node.id === built.contract.httpResponse.id).unexpected = true;
  assert.throws(() => sync(hiddenNodeDrift), /HTTP response.*node preimage/);

  const responseBodyDrift = structuredClone(built.flow);
  const responseNode = responseBodyDrift.find((node) => node.id === built.contract.response.id);
  responseNode.func += '\n';
  const responseContract = structuredClone(built.contract);
  responseContract.response.nodeSha256 = sha256Json(responseNode);
  assert.throws(
    () => synchronizeDirectLookup(
      responseBodyDrift,
      querySource(),
      responseSource(),
      listNormalizerSource(),
      responseContract.wholeFlowSha256,
      responseContract,
    ),
    /response function preimage/,
  );

  assert.throws(
    () => synchronizeDirectLookup(
      structuredClone(built.flow),
      `${querySource()}\n`,
      responseSource(),
      listNormalizerSource(),
      built.contract.wholeFlowSha256,
      built.contract,
    ),
    /query source contract mismatch/,
  );
  assert.throws(
    () => synchronizeDirectLookup(
      structuredClone(built.flow),
      querySource(),
      `${responseSource()}\n`,
      listNormalizerSource(),
      built.contract.wholeFlowSha256,
      built.contract,
    ),
    /response source contract mismatch/,
  );
  assert.throws(
    () => synchronizeDirectLookup(
      structuredClone(built.flow),
      querySource(),
      responseSource(),
      `${listNormalizerSource()}\n`,
      built.contract.wholeFlowSha256,
      built.contract,
    ),
    /normalizer source contract mismatch/,
  );

  for (const target of [
    built.contract.query,
    built.contract.mongo,
    built.contract.response,
    built.contract.listNormalizer,
    built.contract.httpResponse,
    built.contract.diagnostic,
  ]) {
    const missing = structuredClone(built.flow);
    missing.find((node) => node.id === target.id).id = crypto.randomUUID();
    assert.throws(() => sync(missing), /must exist exactly once/);

    const duplicate = structuredClone(built.flow);
    duplicate.find((node) => node.id === built.contract.tab.id).id = target.id;
    assert.throws(() => sync(duplicate), /must exist exactly once|duplicate node IDs/);
  }
});

test('explicitly contracted source update can change only query func', () => {
  const built = fixture();
  const next = `${querySource()}\n// approved-test-only\n`;
  built.contract.query.sourceSha256 = sha256(next);
  const result = synchronizeDirectLookup(
    structuredClone(built.flow),
    next,
    responseSource(),
    listNormalizerSource(),
    built.contract.wholeFlowSha256,
    built.contract,
  );
  assert.equal(isDeepStrictEqual(result.changedNodes, [{
    id: built.contract.query.id,
    changedFields: ['func'],
  }]), true);
});

test('explicitly contracted source update can change only response func', () => {
  const built = fixture();
  const next = `${responseSource()}\n// approved-test-only\n`;
  built.contract.response.sourceSha256 = sha256(next);
  const result = synchronizeDirectLookup(
    structuredClone(built.flow),
    querySource(),
    next,
    listNormalizerSource(),
    built.contract.wholeFlowSha256,
    built.contract,
  );
  assert.equal(isDeepStrictEqual(result.changedNodes, [{
    id: built.contract.response.id,
    changedFields: ['func'],
  }]), true);
});

test('publication is byte-identical, private, redacted, atomic, and TOCTOU-safe', () => {
  const built = workspaceFixture();
  const publication = path.join(built.root, 'publication');
  const output = path.join(publication, 'candidate.json');
  const report = path.join(publication, 'report.json');
  const stdout = [];
  const originalLog = console.log;
  console.log = (line) => stdout.push(String(line));
  let result;
  try {
    result = publishDirectLookupCandidate({
      workspace: built.workspace,
      output,
      report,
      contract: built.contract,
    });
  } finally {
    console.log = originalLog;
  }
  assert.equal(result.changedNodeCount, 0);
  assert.equal(sha256(fs.readFileSync(output)), sha256(built.raw));
  assert.equal(fs.statSync(publication).mode & 0o777, 0o700);
  assert.equal(fs.statSync(output).mode & 0o777, 0o600);
  assert.equal(fs.statSync(report).mode & 0o777, 0o600);
  const candidateText = fs.readFileSync(output, 'utf8');
  const reportText = fs.readFileSync(report, 'utf8');
  assert.equal(candidateText.includes('/lk/games/:gameId'), true);
  assert.equal(candidateText.includes('Build game by id query'), true);
  assert.doesNotMatch(reportText, /\/lk\/|return msg|source\.flow|private\/tmp/);
  assert.doesNotMatch(stdout.join('\n'), /\/lk\/|return msg|source\.flow|private\/tmp/);

  const mutated = workspaceFixture();
  const verified = verifyWorkspace(mutated.workspace, { quiet: true });
  const sensitiveMarker = 'SECRET_DIRECT_LOOKUP';
  fs.appendFileSync(mutated.sourcePath, `\n${sensitiveMarker}`);
  let mutationError;
  try {
    readVerifiedDirectLookupBytes(verified);
    assert.fail('TOCTOU mutation must fail');
  } catch (error) {
    mutationError = error;
  }
  assert.match(mutationError.message, /changed after verification/);
  assert.doesNotMatch(mutationError.message, new RegExp(sensitiveMarker));
  assert.equal(fs.readdirSync(mutated.root).some((name) => name.includes('direct-lookup-stage')), false);

  const reportFailure = workspaceFixture();
  const failedPublication = path.join(reportFailure.root, 'failed-publication');
  const originalOpenSync = fs.openSync;
  fs.openSync = (filePath, ...args) => {
    if (String(filePath).endsWith(`${path.sep}report.json`)) {
      throw new Error('simulated report write failure');
    }
    return originalOpenSync(filePath, ...args);
  };
  try {
    assert.throws(() => publishDirectLookupCandidate({
      workspace: reportFailure.workspace,
      output: path.join(failedPublication, 'candidate.json'),
      report: path.join(failedPublication, 'report.json'),
      contract: reportFailure.contract,
    }), /simulated report write failure/);
  } finally {
    fs.openSync = originalOpenSync;
  }
  assert.equal(fs.existsSync(failedPublication), false);
  assert.equal(
    fs.readdirSync(reportFailure.root).some((name) => name.includes('direct-lookup-stage')),
    false,
  );
});

test('existing, split, partial, input/repo/symlink/hardlink/stale paths fail closed', () => {
  const existing = workspaceFixture();
  const existingDir = path.join(existing.root, 'existing');
  fs.mkdirSync(existingDir, { mode: 0o700 });
  assert.throws(() => publishDirectLookupCandidate({
    workspace: existing.workspace,
    output: path.join(existingDir, 'candidate.json'),
    report: path.join(existingDir, 'report.json'),
    contract: existing.contract,
  }), /must not already exist/);

  const split = workspaceFixture();
  assert.throws(() => publishDirectLookupCandidate({
    workspace: split.workspace,
    output: path.join(split.root, 'one', 'candidate.json'),
    report: path.join(split.root, 'two', 'report.json'),
    contract: split.contract,
  }), /share one new publication directory/);

  const partial = workspaceFixture();
  fs.mkdirSync(path.join(partial.root, '.publication.direct-lookup-stage-stale'), { mode: 0o700 });
  assert.throws(() => publishDirectLookupCandidate({
    workspace: partial.workspace,
    output: path.join(partial.root, 'publication', 'candidate.json'),
    report: path.join(partial.root, 'publication', 'report.json'),
    contract: partial.contract,
  }), /Partial direct lookup publication/);

  const alias = workspaceFixture();
  assert.throws(() => publishDirectLookupCandidate({
    workspace: alias.workspace,
    output: path.join(alias.workspace, 'input', 'new', 'candidate.json'),
    report: path.join(alias.workspace, 'input', 'new', 'report.json'),
    contract: alias.contract,
  }), /verified input/);

  const symlinked = workspaceFixture();
  const realParent = path.join(symlinked.root, 'real-parent');
  const parentAlias = path.join(symlinked.root, 'parent-alias');
  fs.mkdirSync(realParent, { mode: 0o700 });
  fs.symlinkSync(realParent, parentAlias);
  assert.throws(() => publishDirectLookupCandidate({
    workspace: symlinked.workspace,
    output: path.join(parentAlias, 'publication', 'candidate.json'),
    report: path.join(parentAlias, 'publication', 'report.json'),
    contract: symlinked.contract,
  }), /symlink parent|canonical/);

  const hardlink = workspaceFixture();
  fs.linkSync(hardlink.sourcePath, path.join(hardlink.root, 'source.hardlink.json'));
  assert.throws(() => publishDirectLookupCandidate({
    workspace: hardlink.workspace,
    output: path.join(hardlink.root, 'publication', 'candidate.json'),
    report: path.join(hardlink.root, 'publication', 'report.json'),
    contract: hardlink.contract,
  }), /hard-linked/);

  const stale = workspaceFixture();
  const staleMetaPath = path.join(stale.workspace, 'input', 'source.flow.meta.json');
  const staleMeta = JSON.parse(fs.readFileSync(staleMetaPath, 'utf8'));
  staleMeta.pulledAt = new Date(Date.now() - (31 * 60 * 1000)).toISOString();
  fs.writeFileSync(staleMetaPath, `${JSON.stringify(staleMeta, null, 2)}\n`);
  fs.chmodSync(staleMetaPath, 0o600);
  assert.throws(() => publishDirectLookupCandidate({
    workspace: stale.workspace,
    output: path.join(stale.root, 'publication', 'candidate.json'),
    report: path.join(stale.root, 'publication', 'report.json'),
    contract: stale.contract,
  }), /stale/);

  const insideRepo = workspaceFixture();
  const unique = path.join(REPO_ROOT, `.direct-lookup-${process.pid}-${crypto.randomUUID()}`);
  assert.throws(() => publishDirectLookupCandidate({
    workspace: insideRepo.workspace,
    output: path.join(unique, 'candidate.json'),
    report: path.join(unique, 'report.json'),
    contract: insideRepo.contract,
  }), /outside the repository/);
  assert.equal(fs.existsSync(unique), false);
});
