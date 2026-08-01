import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { isDeepStrictEqual } from 'node:util';
import { fileURLToPath } from 'node:url';
import {
  GAMES_LIST_CONTRACT,
  publishGamesListCandidate,
  readVerifiedGamesListSourceBytes,
  synchronizeGamesListIdentity,
} from '../patch_live_games_list_identity.mjs';
import { verifyWorkspace } from '../verify_nodered_source_origin.mjs';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const SOURCE_DIR = path.join(REPO_ROOT, 'scripts/nodered_games_nodes');
const TEMP_ROOTS = [];
const NORMALIZER_CANDIDATE_SHA256 =
  '33d5252688c6f25ab61ef9b3ad157b2ae970bc8d8b60e4264d30dac0a5296172';

function sha256(value) {
  return crypto.createHash('sha256').update(value).digest('hex');
}

function sha256Json(value) {
  return sha256(Buffer.from(JSON.stringify(value), 'utf8'));
}

function sourceByFile() {
  return {
    'fn_list_query.js': fs.readFileSync(path.join(SOURCE_DIR, 'fn_list_query.js'), 'utf8'),
    'fn_list_normalize.js': fs.readFileSync(path.join(SOURCE_DIR, 'fn_list_normalize.js'), 'utf8'),
  };
}

function runFunction(source, msg) {
  return new Function('msg', source)(msg);
}

function queryFor(query) {
  const [ok, error] = runFunction(sourceByFile()['fn_list_query.js'], {
    req: { query },
  });
  assert.equal(error, null);
  return ok;
}

function futureGame(overrides = {}) {
  return {
    id: overrides.id ?? crypto.randomUUID(),
    status: 'ACTIVE',
    booking: {
      endTs: Date.now() + 3_600_000,
      startTs: Date.now() + 1_800_000,
      date: '2026-07-26',
    },
    participants: overrides.participants ?? [],
    waitlist: overrides.waitlist ?? [],
    metadata: overrides.metadata ?? {},
    ...overrides.extra,
  };
}

function normalizeFor(identity, games, filters = {}) {
  const msg = {
    _lkPhone: identity.phone ?? null,
    _lkClientId: identity.clientId ?? null,
    _lkIncludePast: false,
    _lkPaymentRef: filters.paymentRef ?? null,
    _lkBookingIds: filters.bookingIds ?? [],
    _lkOffset: 0,
    _lkPublicMode: false,
    payload: games,
  };
  runFunction(sourceByFile()['fn_list_normalize.js'], msg);
  return msg.payload;
}

function tempRoot() {
  const created = fs.mkdtempSync(path.join(os.tmpdir(), 'lk-games-list-recovery-'));
  const canonical = fs.realpathSync(created);
  TEMP_ROOTS.push(canonical);
  return canonical;
}

test.after(() => {
  for (const directory of TEMP_ROOTS) {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

function fixtureFlowAndContract() {
  const sources = sourceByFile();
  const flow = [
    { ...GAMES_LIST_CONTRACT.tab, info: '' },
    ...GAMES_LIST_CONTRACT.routes.map((route) => ({
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
      id: GAMES_LIST_CONTRACT.query.id,
      type: 'function',
      z: GAMES_LIST_CONTRACT.tab.id,
      name: GAMES_LIST_CONTRACT.query.name,
      func: sources[GAMES_LIST_CONTRACT.query.file],
      outputs: GAMES_LIST_CONTRACT.query.outputs,
      wires: structuredClone(GAMES_LIST_CONTRACT.query.wires),
    },
    {
      id: GAMES_LIST_CONTRACT.mongo.id,
      type: 'mongodb4',
      z: GAMES_LIST_CONTRACT.tab.id,
      name: GAMES_LIST_CONTRACT.mongo.name,
      clientNode: GAMES_LIST_CONTRACT.mongo.clientNode,
      mode: GAMES_LIST_CONTRACT.mongo.mode,
      collection: GAMES_LIST_CONTRACT.mongo.collection,
      operation: GAMES_LIST_CONTRACT.mongo.operation,
      output: GAMES_LIST_CONTRACT.mongo.output,
      maxTimeMS: GAMES_LIST_CONTRACT.mongo.maxTimeMS,
      handleDocId: GAMES_LIST_CONTRACT.mongo.handleDocId,
      wires: structuredClone(GAMES_LIST_CONTRACT.mongo.wires),
    },
    {
      id: GAMES_LIST_CONTRACT.normalizer.id,
      type: 'function',
      z: GAMES_LIST_CONTRACT.tab.id,
      name: GAMES_LIST_CONTRACT.normalizer.name,
      func: sources[GAMES_LIST_CONTRACT.normalizer.file],
      outputs: GAMES_LIST_CONTRACT.normalizer.outputs,
      wires: structuredClone(GAMES_LIST_CONTRACT.normalizer.wires),
    },
    {
      id: GAMES_LIST_CONTRACT.orphanIds[0],
      type: 'function',
      z: GAMES_LIST_CONTRACT.tab.id,
      name: GAMES_LIST_CONTRACT.query.name,
      func: 'return [msg, null, msg];',
      outputs: 3,
      wires: [[], [], []],
    },
    {
      id: GAMES_LIST_CONTRACT.orphanIds[1],
      type: 'function',
      z: GAMES_LIST_CONTRACT.tab.id,
      name: GAMES_LIST_CONTRACT.normalizer.name,
      func: 'return [msg, msg];',
      outputs: 2,
      wires: [[], []],
    },
  ];
  const raw = Buffer.from(`${JSON.stringify(flow, null, 2)}\n`, 'utf8');
  const contract = structuredClone(GAMES_LIST_CONTRACT);
  contract.wholeFlowSha256 = sha256(raw);
  contract.nodeCount = flow.length;
  contract.httpRouteCount = contract.routes.length;
  for (const route of contract.routes) {
    route.nodeSha256 = sha256Json(flow.find((node) => node.id === route.id));
  }
  contract.query.nodeSha256 = sha256Json(flow.find((node) => node.id === contract.query.id));
  contract.mongo.nodeSha256 = sha256Json(flow.find((node) => node.id === contract.mongo.id));
  contract.normalizer.nodeSha256 = sha256Json(
    flow.find((node) => node.id === contract.normalizer.id),
  );
  contract.query.preimageSha256 = sha256(sources[contract.query.file]);
  contract.query.sourceSha256 = sha256(sources[contract.query.file]);
  contract.normalizer.preimageSha256 = sha256(sources[contract.normalizer.file]);
  contract.normalizer.sourceSha256 = sha256(sources[contract.normalizer.file]);
  return { flow, raw, contract };
}

function createWorkspace() {
  const root = tempRoot();
  const workspace = path.join(root, 'workspace');
  const input = path.join(workspace, 'input');
  fs.mkdirSync(input, { recursive: true, mode: 0o700 });
  fs.chmodSync(workspace, 0o700);
  fs.chmodSync(input, 0o700);
  const fixture = fixtureFlowAndContract();
  const sourcePath = path.join(input, 'source.flow.json');
  const metaPath = path.join(input, 'source.flow.meta.json');
  fs.writeFileSync(sourcePath, fixture.raw, { mode: 0o600 });
  fs.writeFileSync(metaPath, `${JSON.stringify({
    formatVersion: 1,
    sourceKind: 'live-147',
    sourceHost: 'lk-primary-147',
    sourceUser: 'root',
    sourcePort: '22',
    remoteFlowPath: '/root/.node-red/flows.json',
    localSourcePath: sourcePath,
    pulledAt: new Date().toISOString(),
    sourceSha256: fixture.contract.wholeFlowSha256,
    nodeCount: fixture.flow.length,
  }, null, 2)}\n`, { mode: 0o600 });
  fs.chmodSync(sourcePath, 0o600);
  fs.chmodSync(metaPath, 0o600);
  return { root, workspace, sourcePath, ...fixture };
}

test('tracked query stays live-exact while the normalizer is a pinned candidate', () => {
  const sources = sourceByFile();
  assert.equal(sha256(sources[GAMES_LIST_CONTRACT.query.file]), GAMES_LIST_CONTRACT.query.sourceSha256);
  assert.equal(
    sha256(sources[GAMES_LIST_CONTRACT.normalizer.file]),
    GAMES_LIST_CONTRACT.normalizer.sourceSha256,
  );
  assert.equal(GAMES_LIST_CONTRACT.query.sourceSha256, GAMES_LIST_CONTRACT.query.preimageSha256);
  assert.notEqual(
    GAMES_LIST_CONTRACT.normalizer.sourceSha256,
    GAMES_LIST_CONTRACT.normalizer.preimageSha256,
  );
  assert.equal(
    NORMALIZER_CANDIDATE_SHA256,
    GAMES_LIST_CONTRACT.normalizer.sourceSha256,
  );
});

test('query accepts phone-only, clientId-only, and both identities', () => {
  const phoneOnly = queryFor({ phone: '8 999 111-22-33' });
  assert.equal(phoneOnly._lkPhone, '79991112233');
  assert.equal(phoneOnly._lkClientId, null);
  assert.equal(phoneOnly.payload.$or.some((item) => item.participantPhones === '79991112233'), true);
  assert.equal(
    phoneOnly.payload.$or.some(
      (item) => item['metadata.splitPayment.payments.clientPhoneNorm'] === '79991112233',
    ),
    true,
  );

  const clientOnly = queryFor({ clientId: 'client-42' });
  assert.equal(clientOnly._lkPhone, null);
  assert.equal(clientOnly._lkClientId, 'client-42');
  assert.equal(clientOnly.payload.$or.some((item) => item['participants.id'] === 'client-42'), true);
  assert.equal(
    clientOnly.payload.$or.some(
      (item) => item['metadata.splitPayment.payments.clientId'] === 'client-42',
    ),
    true,
  );

  const both = queryFor({ phone: '79991112233', profileId: 'client-42' });
  assert.equal(both._lkPhone, '79991112233');
  assert.equal(both._lkClientId, 'client-42');
  assert.equal(both.payload.$or.some((item) => item.waitlistPhones === '79991112233'), true);
  assert.equal(both.payload.$or.some((item) => item.waitlistIds === 'client-42'), true);
  assert.equal(
    both.payload.$or.some(
      (item) => item['metadata.splitPayment.payments.clientPhone'] === '79991112233',
    ),
    true,
  );
  assert.equal(
    both.payload.$or.some(
      (item) => item['metadata.splitPayment.payments.playerId'] === 'client-42',
    ),
    true,
  );
});

test('normalizer retains clientId-only participants and uses OR for current dual identity', () => {
  const clientOnly = futureGame({ participants: [{ id: 'client-42', status: 'ACTIVE' }] });
  assert.equal(normalizeFor({ clientId: 'client-42' }, [clientOnly]).games.length, 1);

  const idMatchPhoneMismatch = futureGame({
    participants: [{ id: 'client-42', phone: '79990000000', status: 'ACTIVE' }],
  });
  assert.equal(normalizeFor({
    phone: '79991112233',
    clientId: 'client-42',
  }, [idMatchPhoneMismatch]).games.length, 1);
});

test('active roster identities work while stale projections and inactive split identities do not', () => {
  const participantPhone = futureGame({
    participants: [{ id: 'p1', phone: '+7 999 111-22-33', status: 'ACTIVE' }],
  });
  assert.equal(normalizeFor({ phone: '79991112233' }, [participantPhone]).games.length, 1);

  const waitlistId = futureGame({
    waitlist: [{ id: 'wait-7', status: 'WAITING' }],
  });
  assert.equal(normalizeFor({ clientId: 'wait-7' }, [waitlistId]).games.length, 1);

  const persistedProjections = futureGame({
    extra: {
      participantPhones: ['+7 999 111-22-33'],
      waitlistPhones: ['+7 999 222-33-44'],
      participantIds: ['participant-projection'],
      waitlistIds: ['waitlist-projection'],
    },
  });
  assert.equal(normalizeFor({ phone: '79991112233' }, [persistedProjections]).games.length, 0);
  assert.equal(normalizeFor({ phone: '79992223344' }, [persistedProjections]).games.length, 0);
  assert.equal(
    normalizeFor({ clientId: 'participant-projection' }, [persistedProjections]).games.length,
    0,
  );
  assert.equal(
    normalizeFor({ clientId: 'waitlist-projection' }, [persistedProjections]).games.length,
    0,
  );

  const inactiveRoster = futureGame({
    participants: [{
      id: 'inactive-participant',
      phone: '79991112233',
      status: 'ARCHIVED',
    }],
    waitlist: [{
      id: 'inactive-waitlist',
      phone: '79992223344',
      status: 'CANCELLED',
    }],
  });
  assert.equal(normalizeFor({ clientId: 'inactive-participant' }, [inactiveRoster]).games.length, 0);
  assert.equal(normalizeFor({ phone: '79991112233' }, [inactiveRoster]).games.length, 0);
  assert.equal(normalizeFor({ clientId: 'inactive-waitlist' }, [inactiveRoster]).games.length, 0);
  assert.equal(normalizeFor({ phone: '79992223344' }, [inactiveRoster]).games.length, 0);

  const staleAggregateOnly = futureGame({
    extra: {
      allRelatedPhones: ['79991112233'],
      allRelatedClientIds: ['stale-client'],
    },
  });
  assert.equal(normalizeFor({ phone: '79991112233' }, [staleAggregateOnly]).games.length, 0);
  assert.equal(normalizeFor({ clientId: 'stale-client' }, [staleAggregateOnly]).games.length, 0);

  const activeSplit = futureGame({
    metadata: {
      splitPayment: {
        payments: [{
          clientId: 'active-client',
          playerId: 'active-player',
          clientPhone: '79991112233',
          status: 'PAID',
        }],
      },
    },
  });
  assert.equal(normalizeFor({ phone: '79991112233' }, [activeSplit]).games.length, 1);
  assert.equal(normalizeFor({ clientId: 'active-client' }, [activeSplit]).games.length, 1);
  assert.equal(normalizeFor({ clientId: 'active-player' }, [activeSplit]).games.length, 1);
  assert.equal(normalizeFor({
    phone: '79990000000',
    clientId: 'active-client',
  }, [activeSplit]).games.length, 1);

  const inactiveSplit = futureGame({
    metadata: {
      splitPayment: {
        payments: [{
          clientId: 'inactive-client',
          clientPhone: '79991112233',
          status: 'CANCELLED',
        }],
      },
    },
  });
  assert.equal(normalizeFor({ clientId: 'inactive-client' }, [inactiveSplit]).games.length, 0);
  assert.equal(normalizeFor({ phone: '79991112233' }, [inactiveSplit]).games.length, 0);
});

test('exact cancellation lookup preserves colliding game records instead of deduping them', () => {
  const paymentRef = 'shared-payment-ref';
  const bookingId = 'shared-booking-id';
  const games = [
    futureGame({
      id: 'game-a',
      metadata: {
        paymentRef,
        splitPayment: { payments: [{ bookingId, paymentRef, status: 'PAID' }] },
      },
    }),
    futureGame({
      id: 'game-b',
      metadata: {
        paymentRef,
        splitPayment: { payments: [{ bookingId, paymentRef, status: 'PAID' }] },
      },
    }),
  ];

  assert.equal(normalizeFor({}, games, { paymentRef }).games.length, 2);
  assert.equal(normalizeFor({}, games, { bookingIds: [bookingId] }).games.length, 2);
  assert.equal(normalizeFor({}, games).games.length, 1);

  const missingId = futureGame({ metadata: { paymentRef } });
  delete missingId.id;
  const incomplete = normalizeFor({}, [missingId], { paymentRef });
  assert.equal(incomplete.games.length, 0);
  assert.equal(incomplete.total, 1);

  const cancelled = futureGame({
    id: "cancelled-game",
    metadata: { paymentRef },
    extra: { status: "CANCELLED" },
  });
  assert.equal(normalizeFor({}, [cancelled]).games.length, 0);
  assert.equal(normalizeFor({}, [cancelled], { paymentRef }).games.length, 1);
});

test('exact route and graph contracts remain fixed to the active LK Games chain', () => {
  assert.equal(GAMES_LIST_CONTRACT.routes.length, 2);
  assert.equal(isDeepStrictEqual(
    GAMES_LIST_CONTRACT.routes.map((route) => [route.id, route.method, route.url, route.wires]),
    [
      ['66c844d829df6210', 'get', '/lk/games/by-phone', [['25a807ca124cd83e']]],
      ['880fdc834e479525', 'get', '/lk/games', [['25a807ca124cd83e']]],
    ],
  ), true);
  assert.equal(isDeepStrictEqual(
    GAMES_LIST_CONTRACT.query.wires,
    [['77859abc9f190e6b'], ['7b8f8065271f5b4c'], ['62b2b0e16ed306e7']],
  ), true);
  assert.equal(isDeepStrictEqual(
    GAMES_LIST_CONTRACT.mongo.wires,
    [['0485dea01865b2dd']],
  ), true);
});

test('zero-change synchronization preserves topology and orphan nodes', () => {
  const { flow, raw, contract } = fixtureFlowAndContract();
  const result = synchronizeGamesListIdentity(
    structuredClone(flow),
    sourceByFile(),
    sha256(raw),
    contract,
  );
  assert.equal(isDeepStrictEqual(result.candidate, flow), true);
  assert.equal(isDeepStrictEqual(result.changedNodes, []), true);
  for (const orphanId of contract.orphanIds) {
    assert.equal(
      sha256Json(result.candidate.find((node) => node.id === orphanId)),
      sha256Json(flow.find((node) => node.id === orphanId)),
    );
  }
});

test('whole-flow, node, function, route, graph, and non-func drift fail closed', () => {
  const fixture = fixtureFlowAndContract();
  const sync = (flow, sha = fixture.contract.wholeFlowSha256) => synchronizeGamesListIdentity(
    flow,
    sourceByFile(),
    sha,
    fixture.contract,
  );
  assert.throws(() => sync(structuredClone(fixture.flow), '0'.repeat(64)), /Flow preimage SHA/);

  for (const [id, field, value, expected] of [
    [fixture.contract.tab.id, 'label', 'Wrong', /tab.*label/],
    [fixture.contract.routes[0].id, 'method', 'post', /route.*method/],
    [fixture.contract.query.id, 'outputs', 2, /query.*outputs/],
    [fixture.contract.mongo.id, 'collection', 'wrong', /mongo.*collection/],
    [fixture.contract.normalizer.id, 'wires', [[]], /normalizer.*wires/],
  ]) {
    const changed = structuredClone(fixture.flow);
    changed.find((node) => node.id === id)[field] = value;
    assert.throws(() => sync(changed), expected);
  }

  const bodyDrift = structuredClone(fixture.flow);
  bodyDrift.find((node) => node.id === fixture.contract.query.id).func += '\n';
  assert.throws(() => sync(bodyDrift), /node preimage|preimage mismatch/);

  for (const target of [fixture.contract.query, fixture.contract.normalizer]) {
    const missing = structuredClone(fixture.flow);
    missing.find((node) => node.id === target.id).id = crypto.randomUUID();
    assert.throws(() => sync(missing), /must exist exactly once/);

    const duplicate = structuredClone(fixture.flow);
    duplicate.find((node) => node.id === fixture.contract.orphanIds[0]).id = target.id;
    assert.throws(() => sync(duplicate), /duplicate node IDs/);
  }
});

test('an explicitly contracted update can change only target func', () => {
  const fixture = fixtureFlowAndContract();
  const sources = sourceByFile();
  sources[fixture.contract.query.file] += '\n// approved-test-only\n';
  fixture.contract.query.sourceSha256 = sha256(sources[fixture.contract.query.file]);
  const result = synchronizeGamesListIdentity(
    structuredClone(fixture.flow),
    sources,
    fixture.contract.wholeFlowSha256,
    fixture.contract,
  );
  assert.equal(isDeepStrictEqual(result.changedNodes, [{
    id: fixture.contract.query.id,
    changedFields: ['func'],
  }]), true);
});

test('publication keeps the full candidate private while report/stdout stay redacted', () => {
  const fixture = createWorkspace();
  const publication = path.join(fixture.root, 'publication');
  const output = path.join(publication, 'candidate.json');
  const report = path.join(publication, 'report.json');
  const stdout = [];
  const originalLog = console.log;
  let result;
  console.log = (...values) => stdout.push(values.join(' '));
  try {
    result = publishGamesListCandidate({
      workspace: fixture.workspace,
      output,
      report,
      contract: fixture.contract,
    });
  } finally {
    console.log = originalLog;
  }
  assert.equal(result.changedNodeCount, 0);
  assert.equal(result.sourceSha256, result.candidateSha256);
  assert.equal(sha256(fs.readFileSync(output)), sha256(fixture.raw));
  assert.equal(fs.statSync(publication).mode & 0o777, 0o700);
  assert.equal(fs.statSync(output).mode & 0o777, 0o600);
  assert.equal(fs.statSync(report).mode & 0o777, 0o600);
  const candidateText = fs.readFileSync(output, 'utf8');
  const reportText = fs.readFileSync(report, 'utf8');
  assert.equal(/\/lk\/games/.test(candidateText), true);
  assert.equal(/return \[msg, null, msg\]/.test(candidateText), true);
  assert.doesNotMatch(reportText, /\/lk\/|return msg|source\.flow|private\/tmp/);
  assert.doesNotMatch(stdout.join('\n'), /\/lk\/|return msg|source\.flow|private\/tmp/);

  const mutated = createWorkspace();
  const verified = verifyWorkspace(mutated.workspace, { quiet: true });
  const sensitiveMarker = 'TEST_SENSITIVE_FLOW_BODY_MARKER';
  fs.appendFileSync(mutated.sourcePath, sensitiveMarker);
  let mutationError;
  try {
    readVerifiedGamesListSourceBytes(verified);
    assert.fail('TOCTOU mutation must fail');
  } catch (error) {
    mutationError = error;
  }
  assert.match(mutationError.message, /changed after verification/);
  assert.doesNotMatch(mutationError.message, new RegExp(sensitiveMarker));
  assert.equal(fs.readdirSync(mutated.root).some((name) => name.includes('games-list-stage')), false);

  const reportFailure = createWorkspace();
  const failedPublication = path.join(reportFailure.root, 'failed-publication');
  const originalOpenSync = fs.openSync;
  fs.openSync = (filePath, ...args) => {
    if (String(filePath).endsWith(`${path.sep}report.json`)) {
      throw new Error('simulated report write failure');
    }
    return originalOpenSync(filePath, ...args);
  };
  try {
    assert.throws(() => publishGamesListCandidate({
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
    fs.readdirSync(reportFailure.root).some((name) => name.includes('games-list-stage')),
    false,
  );
});

test('existing, split, partial, aliases, stale input, and hardlinks fail closed', () => {
  const existing = createWorkspace();
  const existingDir = path.join(existing.root, 'existing');
  fs.mkdirSync(existingDir, { mode: 0o700 });
  assert.throws(() => publishGamesListCandidate({
    workspace: existing.workspace,
    output: path.join(existingDir, 'candidate.json'),
    report: path.join(existingDir, 'report.json'),
    contract: existing.contract,
  }), /must not already exist/);

  const split = createWorkspace();
  assert.throws(() => publishGamesListCandidate({
    workspace: split.workspace,
    output: path.join(split.root, 'one', 'candidate.json'),
    report: path.join(split.root, 'two', 'report.json'),
    contract: split.contract,
  }), /share one new publication directory/);

  const partial = createWorkspace();
  fs.mkdirSync(path.join(partial.root, '.publication.games-list-stage-stale'), { mode: 0o700 });
  assert.throws(() => publishGamesListCandidate({
    workspace: partial.workspace,
    output: path.join(partial.root, 'publication', 'candidate.json'),
    report: path.join(partial.root, 'publication', 'report.json'),
    contract: partial.contract,
  }), /Partial games list publication/);

  const inputAlias = createWorkspace();
  assert.throws(() => publishGamesListCandidate({
    workspace: inputAlias.workspace,
    output: path.join(inputAlias.workspace, 'input', 'new', 'candidate.json'),
    report: path.join(inputAlias.workspace, 'input', 'new', 'report.json'),
    contract: inputAlias.contract,
  }), /verified input/);

  const symlinkParent = createWorkspace();
  const realParent = path.join(symlinkParent.root, 'real-parent');
  const parentAlias = path.join(symlinkParent.root, 'parent-alias');
  fs.mkdirSync(realParent, { mode: 0o700 });
  fs.symlinkSync(realParent, parentAlias);
  assert.throws(() => publishGamesListCandidate({
    workspace: symlinkParent.workspace,
    output: path.join(parentAlias, 'publication', 'candidate.json'),
    report: path.join(parentAlias, 'publication', 'report.json'),
    contract: symlinkParent.contract,
  }), /symlink parent/);

  const hardlinked = createWorkspace();
  fs.linkSync(hardlinked.sourcePath, path.join(hardlinked.root, 'source.flow.hardlink.json'));
  assert.throws(() => publishGamesListCandidate({
    workspace: hardlinked.workspace,
    output: path.join(hardlinked.root, 'publication', 'candidate.json'),
    report: path.join(hardlinked.root, 'publication', 'report.json'),
    contract: hardlinked.contract,
  }), /hard-linked/);

  const stale = createWorkspace();
  const staleMetaPath = path.join(stale.workspace, 'input', 'source.flow.meta.json');
  const staleMeta = JSON.parse(fs.readFileSync(staleMetaPath, 'utf8'));
  staleMeta.pulledAt = new Date(Date.now() - (31 * 60 * 1000)).toISOString();
  fs.writeFileSync(staleMetaPath, `${JSON.stringify(staleMeta, null, 2)}\n`, { mode: 0o600 });
  assert.throws(() => publishGamesListCandidate({
    workspace: stale.workspace,
    output: path.join(stale.root, 'publication', 'candidate.json'),
    report: path.join(stale.root, 'publication', 'report.json'),
    contract: stale.contract,
  }), /stale/);

  const insideRepo = createWorkspace();
  const unique = path.join(REPO_ROOT, `.games-list-${process.pid}-${crypto.randomUUID()}`);
  assert.equal(fs.existsSync(unique), false);
  assert.throws(() => publishGamesListCandidate({
    workspace: insideRepo.workspace,
    output: path.join(unique, 'candidate.json'),
    report: path.join(unique, 'report.json'),
    contract: insideRepo.contract,
  }), /outside the repository/);
  assert.equal(fs.existsSync(unique), false);
});
