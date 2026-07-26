import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { isDeepStrictEqual } from 'node:util';
import { fileURLToPath } from 'node:url';
import {
  TOURNAMENT_PREPARE_CONTRACT,
  TOURNAMENT_PREPARE_SOURCE_PATH,
  publishTournamentPrepareCandidate,
  readVerifiedTournamentPrepareBytes,
  synchronizeTournamentPrepare,
} from '../patch_live_tournament_prepare.mjs';
import { verifyWorkspace } from '../verify_nodered_source_origin.mjs';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const TEMP_ROOTS = [];

function sha256(value) {
  return crypto.createHash('sha256').update(value).digest('hex');
}

function sha256Json(value) {
  return sha256(Buffer.from(JSON.stringify(value), 'utf8'));
}

function prepareSource() {
  return fs.readFileSync(TOURNAMENT_PREPARE_SOURCE_PATH, 'utf8');
}

function runPrepare(payload) {
  const msg = { payload };
  const result = new Function('msg', prepareSource())(msg);
  assert.equal(result === msg, true);
  return msg;
}

function tempRoot() {
  const created = fs.mkdtempSync(path.join(os.tmpdir(), 'lk-tournament-prepare-'));
  const canonical = fs.realpathSync(created);
  TEMP_ROOTS.push(canonical);
  return canonical;
}

test.after(() => {
  for (const directory of TEMP_ROOTS) {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

function fixture() {
  const contract = structuredClone(TOURNAMENT_PREPARE_CONTRACT);
  const route = {
    id: contract.route.id,
    type: contract.route.type,
    z: contract.route.z,
    name: contract.route.name,
    method: contract.route.method,
    url: contract.route.url,
    upload: false,
    swaggerDoc: '',
    wires: structuredClone(contract.route.wires),
  };
  const target = {
    id: contract.target.id,
    type: contract.target.type,
    z: contract.target.z,
    name: contract.target.name,
    func: prepareSource(),
    outputs: contract.target.outputs,
    wires: structuredClone(contract.target.wires),
  };
  const shapes = {
    '662c4669cc17d82a': {
      type: 'debug',
      name: 'Americano save payload',
      active: true,
      wires: [],
    },
    f476ee4e8d98c43b: {
      type: 'function',
      name: 'Upsert tournament -> mongodb4 args',
      outputs: 1,
      func: 'return msg;',
      wires: [['2d3808fb969990d4']],
    },
    c76ac8d5319455b4: {
      type: 'http response',
      name: '',
      wires: [],
    },
    bf7e8b4a95f35228: {
      type: 'debug',
      name: 'Americano save payload',
      active: true,
      wires: [],
    },
    '2d3808fb969990d4': {
      type: 'mongodb4',
      name: 'Upsert tournament',
      clientNode: '4e820638cc39c730',
      mode: 'collection',
      collection: 'tournaments',
      operation: 'updateOne',
      output: 'toArray',
      maxTimeMS: '0',
      handleDocId: false,
      wires: [[]],
    },
  };
  const graphNodes = contract.graphNodes.map((item) => ({
    id: item.id,
    z: contract.tab.id,
    ...structuredClone(shapes[item.id]),
  }));
  const flow = [{ ...contract.tab, info: '' }, route, target, ...graphNodes];
  contract.route.nodeSha256 = sha256Json(route);
  contract.target.nodeSha256 = sha256Json(target);
  contract.target.funcSha256 = sha256(target.func);
  contract.target.sourceSha256 = sha256(target.func);
  for (const item of contract.graphNodes) {
    const node = flow.find((candidate) => candidate.id === item.id);
    item.nodeSha256 = sha256Json(node);
    if (node.type === 'function') item.funcSha256 = sha256(node.func);
  }
  const raw = Buffer.from(`${JSON.stringify(flow, null, 2)}\n`);
  contract.wholeFlowSha256 = sha256(raw);
  contract.nodeCount = flow.length;
  contract.httpRouteCount = 1;
  return { contract, flow, raw };
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

test('tracked source is the exact live target function', () => {
  assert.equal(
    sha256(prepareSource()),
    '0b9a8c577a4fb0afb6f05888c7367b5806d2917e0ffd9d39edea191b8ce27688',
  );
  assert.equal(TOURNAMENT_PREPARE_CONTRACT.target.sourceSha256, sha256(prepareSource()));
  assert.equal(
    TOURNAMENT_PREPARE_CONTRACT.target.funcSha256,
    TOURNAMENT_PREPARE_CONTRACT.target.sourceSha256,
  );
});

test('default params are complete while a partial params object remains partial', () => {
  const defaults = runPrepare({ tournamentId: 'default-params' }).payload.$set.params;
  assert.equal(isDeepStrictEqual(defaults, {
    K: 0.3,
    D: 3,
    B: 0.3,
    Influence: 0.5,
    weights: { verif: 0.5, regularity: 0.3, engagement: 0.2 },
    minRating: 1,
    maxRating: 7,
    round: 5,
  }), true);

  const partial = runPrepare({
    tournamentId: 'partial-params',
    params: { K: 0.7 },
  }).payload.$set.params;
  assert.equal(isDeepStrictEqual(partial, { K: 0.7 }), true);
});

test('startRatingChanges sanitize values, filter invalid changes, and produce stable organizer events', () => {
  const msg = runPrepare({
    tournamentId: 't-rating',
    createdAt: '2026-07-26T12:00:00.000Z',
    organizer: {
      id: 'organizer-1',
      name: 'Real Organizer',
      phone: '+79990000001',
    },
    startRatingChanges: [
      {
        player: {
          participantId: ' participant-1 ',
          name: ' Player One ',
          phone: ' +79991111111 ',
        },
        change: {
          before: '1,5',
          after: '2',
          changedBy: { id: 'spoofed' },
        },
        changedBy: { id: 'also-spoofed' },
        source: { reason: 'MINIMUM_ASSIGNED' },
      },
      { player: { name: 'No identity' }, change: { before: 1, after: 2 } },
      { player: { clientId: 'invalid-after' }, change: { before: 1, after: 'bad' } },
      { player: { clientId: 'no-change' }, change: { before: '2', after: 2 } },
      {
        player: { clientId: 'client-4', name: ' Client Four ' },
        change: { before: null, after: '3,5' },
        source: { reason: 'OTHER' },
      },
      {
        eventId: 'explicit-event',
        player: { clientId: 'client-5' },
        change: { before: 4, after: 5 },
        source: { reason: 'MINIMUM_ASSIGNED' },
      },
    ],
  });
  const events = msg.payload.$set.startRatingChanges;
  assert.equal(events.length, 3);
  assert.equal(
    events[0].eventId,
    'rating_evt:tournament_start:t-rating:participant-1:0',
  );
  assert.equal(events[0].occurredAt, '2026-07-26T12:00:00.000Z');
  assert.equal(events[0].source.reason, 'MINIMUM_ASSIGNED');
  assert.equal(events[0].change.before, 1.5);
  assert.equal(events[0].change.after, 2);
  assert.equal(events[0].player.name, 'Player One');
  assert.equal(events[0].changedBy.id, 'organizer-1');
  assert.equal(events[0].changedBy.name, 'Real Organizer');
  assert.equal(events[1].eventId, 'rating_evt:tournament_start:t-rating:client-4:4');
  assert.equal(events[1].source.reason, 'MANUAL_OVERRIDE');
  assert.equal(events[1].change.before, null);
  assert.equal(events[1].change.after, 3.5);
  assert.equal(events[1].changedBy.id, 'organizer-1');
  assert.equal(events[2].eventId, 'explicit-event');
});

test('paired Mexicano adds paired fields and finite rounds; other types do not inject them', () => {
  const paired = runPrepare({
    tournamentId: 'paired',
    tournamentType: 'paired_mexicano',
    params: {
      K: 0.4,
      pairAssignments: [{ pairId: 'pair-1', players: ['p1', 'p2'] }],
      totalRounds: '7',
    },
  }).payload.$set.params;
  assert.equal(paired.mexicanoMode, 'paired');
  assert.equal(paired.pairAssignments.length, 1);
  assert.equal(paired.totalRounds, 7);

  const nonPaired = runPrepare({
    tournamentId: 'americano',
    tournamentType: 'americano',
    params: { K: 0.4 },
  }).payload.$set.params;
  assert.equal(Object.hasOwn(nonPaired, 'mexicanoMode'), false);
  assert.equal(Object.hasOwn(nonPaired, 'pairAssignments'), false);
  assert.equal(Object.hasOwn(nonPaired, 'totalRounds'), false);
});

test('query/update/insert shapes preserve explicit-empty arrays and missing-ID behavior', () => {
  const absent = runPrepare({});
  assert.equal(Object.hasOwn(absent.payload.$set, 'startRatingChanges'), false);
  assert.equal(absent.query.tournamentId, undefined);
  assert.equal(absent.payload.$set.tournamentId, undefined);
  assert.equal(typeof absent.payload.$setOnInsert.createdAt, 'string');
  assert.equal(isDeepStrictEqual(absent.payload.$set.courts, []), true);
  assert.equal(isDeepStrictEqual(absent.payload.$set.participants, []), true);
  assert.equal(isDeepStrictEqual(absent.payload.$set.rounds, []), true);

  const explicit = runPrepare({
    tournamentId: 'shape',
    createdAt: '2026-07-26T13:00:00.000Z',
    startRatingChanges: [],
    courts: [],
    participants: [],
    rounds: [],
    standings: [],
  });
  assert.equal(isDeepStrictEqual(explicit.query, { tournamentId: 'shape' }), true);
  assert.equal(isDeepStrictEqual(explicit.payload.$set.startRatingChanges, []), true);
  assert.equal(explicit.payload.$setOnInsert.createdAt, '2026-07-26T13:00:00.000Z');
});

test('the exact seven-node graph preserves parallel response and both active debug branches', () => {
  assert.equal(TOURNAMENT_PREPARE_CONTRACT.reachableNodeIds.length, 7);
  assert.equal(isDeepStrictEqual(
    TOURNAMENT_PREPARE_CONTRACT.route.wires,
    [['4f0f1ce8189a9e8c', '662c4669cc17d82a']],
  ), true);
  assert.equal(isDeepStrictEqual(
    TOURNAMENT_PREPARE_CONTRACT.target.wires,
    [['f476ee4e8d98c43b', 'c76ac8d5319455b4', 'bf7e8b4a95f35228']],
  ), true);
  const rawDebug = TOURNAMENT_PREPARE_CONTRACT.graphNodes
    .find((node) => node.id === '662c4669cc17d82a');
  const transformedDebug = TOURNAMENT_PREPARE_CONTRACT.graphNodes
    .find((node) => node.id === 'bf7e8b4a95f35228');
  assert.equal(rawDebug.active, true);
  assert.equal(transformedDebug.active, true);
  assert.equal(
    TOURNAMENT_PREPARE_CONTRACT.graphNodes
      .every((node) => /^[a-f0-9]{64}$/.test(node.nodeSha256)),
    true,
  );
});

test('zero-change and drift guards preserve topology and permit only target func', () => {
  const built = fixture();
  const sync = (flow, sha = built.contract.wholeFlowSha256, source = prepareSource()) => (
    synchronizeTournamentPrepare(flow, source, sha, built.contract)
  );
  const zero = sync(structuredClone(built.flow));
  assert.equal(isDeepStrictEqual(zero.changedNodes, []), true);
  assert.equal(isDeepStrictEqual(zero.candidate, built.flow), true);
  assert.equal(zero.invariants.reachableNodeCount, 7);
  assert.throws(() => sync(structuredClone(built.flow), '0'.repeat(64)), /Flow preimage SHA/);

  for (const [id, field, value, expected] of [
    [built.contract.tab.id, 'label', 'Wrong tab', /tab.*label/],
    [built.contract.route.id, 'url', '/wrong', /route.*url|route.*node preimage/],
    [built.contract.target.id, 'name', 'Wrong target', /target.*name/],
    [built.contract.target.id, 'wires', [[]], /target.*wires/],
    [built.contract.graphNodes[0].id, 'active', false, /graph node.*active/],
    [built.contract.graphNodes[1].id, 'unexpected', true, /graph node.*node preimage/],
  ]) {
    const drift = structuredClone(built.flow);
    drift.find((node) => node.id === id)[field] = value;
    assert.throws(() => sync(drift), expected);
  }
  const bodyDrift = structuredClone(built.flow);
  bodyDrift.find((node) => node.id === built.contract.target.id).func += '\n';
  assert.throws(() => sync(bodyDrift), /target.*node preimage|function preimage/);
  assert.throws(
    () => sync(structuredClone(built.flow), built.contract.wholeFlowSha256, `${prepareSource()}\n`),
    /tracked source contract mismatch/,
  );

  for (const item of [built.contract.target, built.contract.graphNodes[0]]) {
    const missing = structuredClone(built.flow);
    missing.find((node) => node.id === item.id).id = crypto.randomUUID();
    assert.throws(() => sync(missing), /must exist exactly once|missing node/);

    const duplicate = structuredClone(built.flow);
    duplicate.find((node) => node.id === built.contract.tab.id).id = item.id;
    assert.throws(() => sync(duplicate), /must exist exactly once|duplicate node IDs/);
  }

  const nextSource = `${prepareSource()}\n// approved-test-only\n`;
  const nextContract = structuredClone(built.contract);
  nextContract.target.sourceSha256 = sha256(nextSource);
  const changed = synchronizeTournamentPrepare(
    structuredClone(built.flow),
    nextSource,
    nextContract.wholeFlowSha256,
    nextContract,
  );
  assert.equal(isDeepStrictEqual(changed.changedNodes, [{
    id: built.contract.target.id,
    changedFields: ['func'],
  }]), true);
});

test('publication is private, atomic, byte-identical, redacted, and TOCTOU-safe', () => {
  const built = workspaceFixture();
  const publication = path.join(built.root, 'publication');
  const output = path.join(publication, 'candidate.json');
  const report = path.join(publication, 'report.json');
  const stdout = [];
  const originalLog = console.log;
  console.log = (...values) => stdout.push(values.join(' '));
  let result;
  try {
    result = publishTournamentPrepareCandidate({
      workspace: built.workspace,
      output,
      report,
      contract: built.contract,
    });
  } finally {
    console.log = originalLog;
  }
  assert.equal(result.changedNodeCount, 0);
  assert.equal(result.sourceSha256, result.candidateSha256);
  assert.equal(sha256(fs.readFileSync(output)), sha256(built.raw));
  assert.equal(fs.statSync(publication).mode & 0o777, 0o700);
  assert.equal(fs.statSync(output).mode & 0o777, 0o600);
  assert.equal(fs.statSync(report).mode & 0o777, 0o600);
  const candidateText = fs.readFileSync(output, 'utf8');
  const reportText = fs.readFileSync(report, 'utf8');
  assert.equal(candidateText.includes('/lk/tournaments/americano'), true);
  assert.equal(candidateText.includes('Prepare tournament doc'), true);
  assert.doesNotMatch(reportText, /\/lk\/|return msg|source\.flow|private\/tmp/);
  assert.doesNotMatch(stdout.join('\n'), /\/lk\/|return msg|source\.flow|private\/tmp/);

  const mutated = workspaceFixture();
  const verified = verifyWorkspace(mutated.workspace, { quiet: true });
  const marker = 'SECRET_TOURNAMENT_PREPARE';
  fs.appendFileSync(mutated.sourcePath, marker);
  let mutationError;
  try {
    readVerifiedTournamentPrepareBytes(verified);
    assert.fail('TOCTOU mutation must fail');
  } catch (error) {
    mutationError = error;
  }
  assert.match(mutationError.message, /changed after verification/);
  assert.doesNotMatch(mutationError.message, new RegExp(marker));
  assert.equal(
    fs.readdirSync(mutated.root).some((name) => name.includes('tournament-prepare-stage')),
    false,
  );

  const failed = workspaceFixture();
  const failedPublication = path.join(failed.root, 'failed-publication');
  const originalOpenSync = fs.openSync;
  fs.openSync = (filePath, ...args) => {
    if (String(filePath).endsWith(`${path.sep}report.json`)) {
      throw new Error('simulated report write failure');
    }
    return originalOpenSync(filePath, ...args);
  };
  try {
    assert.throws(() => publishTournamentPrepareCandidate({
      workspace: failed.workspace,
      output: path.join(failedPublication, 'candidate.json'),
      report: path.join(failedPublication, 'report.json'),
      contract: failed.contract,
    }), /simulated report write failure/);
  } finally {
    fs.openSync = originalOpenSync;
  }
  assert.equal(fs.existsSync(failedPublication), false);
  assert.equal(
    fs.readdirSync(failed.root).some((name) => name.includes('tournament-prepare-stage')),
    false,
  );
});

test('existing, partial, split, repo/input, symlink, hardlink, and stale paths fail closed', () => {
  const existing = workspaceFixture();
  const existingDirectory = path.join(existing.root, 'existing');
  fs.mkdirSync(existingDirectory, { mode: 0o700 });
  assert.throws(() => publishTournamentPrepareCandidate({
    workspace: existing.workspace,
    output: path.join(existingDirectory, 'candidate.json'),
    report: path.join(existingDirectory, 'report.json'),
    contract: existing.contract,
  }), /must not already exist/);

  const partial = workspaceFixture();
  fs.mkdirSync(path.join(partial.root, '.publication.tournament-prepare-stage-stale'), {
    mode: 0o700,
  });
  assert.throws(() => publishTournamentPrepareCandidate({
    workspace: partial.workspace,
    output: path.join(partial.root, 'publication', 'candidate.json'),
    report: path.join(partial.root, 'publication', 'report.json'),
    contract: partial.contract,
  }), /Partial tournament prepare publication/);

  const split = workspaceFixture();
  assert.throws(() => publishTournamentPrepareCandidate({
    workspace: split.workspace,
    output: path.join(split.root, 'one', 'candidate.json'),
    report: path.join(split.root, 'two', 'report.json'),
    contract: split.contract,
  }), /share one new publication directory/);

  const input = workspaceFixture();
  assert.throws(() => publishTournamentPrepareCandidate({
    workspace: input.workspace,
    output: path.join(input.workspace, 'input', 'new', 'candidate.json'),
    report: path.join(input.workspace, 'input', 'new', 'report.json'),
    contract: input.contract,
  }), /verified input/);

  const symlink = workspaceFixture();
  const realParent = path.join(symlink.root, 'real-parent');
  const parentAlias = path.join(symlink.root, 'parent-alias');
  fs.mkdirSync(realParent, { mode: 0o700 });
  fs.symlinkSync(realParent, parentAlias);
  assert.throws(() => publishTournamentPrepareCandidate({
    workspace: symlink.workspace,
    output: path.join(parentAlias, 'publication', 'candidate.json'),
    report: path.join(parentAlias, 'publication', 'report.json'),
    contract: symlink.contract,
  }), /symlink parent|canonical/);

  const hardlink = workspaceFixture();
  fs.linkSync(hardlink.sourcePath, path.join(hardlink.root, 'source.hardlink.json'));
  assert.throws(() => publishTournamentPrepareCandidate({
    workspace: hardlink.workspace,
    output: path.join(hardlink.root, 'publication', 'candidate.json'),
    report: path.join(hardlink.root, 'publication', 'report.json'),
    contract: hardlink.contract,
  }), /hard-linked/);

  const stale = workspaceFixture();
  const metaPath = path.join(stale.workspace, 'input', 'source.flow.meta.json');
  const metadata = JSON.parse(fs.readFileSync(metaPath, 'utf8'));
  metadata.pulledAt = new Date(Date.now() - (31 * 60 * 1000)).toISOString();
  fs.writeFileSync(metaPath, `${JSON.stringify(metadata, null, 2)}\n`, { mode: 0o600 });
  assert.throws(() => publishTournamentPrepareCandidate({
    workspace: stale.workspace,
    output: path.join(stale.root, 'publication', 'candidate.json'),
    report: path.join(stale.root, 'publication', 'report.json'),
    contract: stale.contract,
  }), /stale/);

  const insideRepo = workspaceFixture();
  const unique = path.join(REPO_ROOT, `.tournament-prepare-${process.pid}-${crypto.randomUUID()}`);
  assert.equal(fs.existsSync(unique), false);
  assert.throws(() => publishTournamentPrepareCandidate({
    workspace: insideRepo.workspace,
    output: path.join(unique, 'candidate.json'),
    report: path.join(unique, 'report.json'),
    contract: insideRepo.contract,
  }), /outside the repository/);
  assert.equal(fs.existsSync(unique), false);
});
