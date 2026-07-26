import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { isDeepStrictEqual } from 'node:util';
import { fileURLToPath } from 'node:url';
import {
  CREATE_SOURCE_PATH,
  CREATE_UPSERT_CONTRACT,
  publishCreateUpsertCandidate,
  readVerifiedCreateUpsertBytes,
  synchronizeCreateUpsert,
} from '../patch_live_games_create_upsert.mjs';
import { verifyWorkspace } from '../verify_nodered_source_origin.mjs';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const TEMP_ROOTS = [];

function sha256(value) {
  return crypto.createHash('sha256').update(value).digest('hex');
}

function sha256Json(value) {
  return sha256(Buffer.from(JSON.stringify(value), 'utf8'));
}

function createSource() {
  return fs.readFileSync(CREATE_SOURCE_PATH, 'utf8');
}

function runCreate(pathname, payload = {}, query = {}) {
  const msg = {
    req: {
      path: pathname,
      originalUrl: pathname,
      query,
    },
    payload,
  };
  return {
    msg,
    outputs: new Function('msg', createSource())(msg),
  };
}

function tempRoot() {
  const created = fs.mkdtempSync(path.join(os.tmpdir(), 'lk-create-upsert-'));
  const canonical = fs.realpathSync(created);
  TEMP_ROOTS.push(canonical);
  return canonical;
}

test.after(() => {
  for (const directory of TEMP_ROOTS) {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

const GRAPH_SHAPES = {
  e656cff36a8cd210: {
    type: 'function',
    name: 'Prepare game upsert',
    outputs: 4,
    wires: [
      ['79307f9bcbc28b6c'],
      ['ae5ee70de15fe66e'],
      ['60a3353902ae9973'],
      ['9756d9125563753f'],
    ],
  },
  '79307f9bcbc28b6c': {
    type: 'function',
    name: 'Upsert lk game -> mongodb4 args',
    outputs: 1,
    wires: [['5eaf4c087c0cc668']],
  },
  ae5ee70de15fe66e: {
    type: 'http response',
    name: '',
    wires: [],
  },
  '60a3353902ae9973': {
    type: 'debug',
    name: 'lk games create debug',
    active: false,
    wires: [],
  },
  '9756d9125563753f': {
    type: 'function',
    name: 'Prepare game station autojoin',
    outputs: 2,
    wires: [['ce224a53446e9a79'], ['ea34e59402d510c4']],
  },
  '5eaf4c087c0cc668': {
    type: 'mongodb4',
    name: 'Upsert lk game',
    wires: [[]],
  },
  ce224a53446e9a79: {
    type: 'mongodb4',
    name: 'Find communities for game autojoin',
    wires: [['66930ded7a2eb836']],
  },
  ea34e59402d510c4: {
    type: 'debug',
    name: 'game station autojoin debug',
    active: false,
    wires: [],
  },
  '66930ded7a2eb836': {
    type: 'function',
    name: 'Apply game station autojoin',
    outputs: 5,
    wires: [
      ['db55cbd9b66b9009'],
      ['2e7c4fa34ac9c12a'],
      ['b89b08776d9a67a5'],
      ['2b6a41011ad0f494'],
      ['ea34e59402d510c4'],
    ],
  },
  db55cbd9b66b9009: {
    type: 'function',
    name: 'Autojoin update community -> mongodb4 args',
    outputs: 1,
    wires: [['c031d81cb06bdc18']],
  },
  '2e7c4fa34ac9c12a': {
    type: 'function',
    name: 'Autojoin ranking upsert -> mongodb4 args',
    outputs: 1,
    wires: [['4e02d01a60d941fe']],
  },
  b89b08776d9a67a5: {
    type: 'mongodb4',
    name: 'Autojoin feed insert',
    wires: [[]],
  },
  '2b6a41011ad0f494': {
    type: 'mongodb4',
    name: 'Autojoin event insert',
    wires: [[]],
  },
  c031d81cb06bdc18: {
    type: 'mongodb4',
    name: 'Autojoin update community',
    wires: [[]],
  },
  '4e02d01a60d941fe': {
    type: 'mongodb4',
    name: 'Autojoin ranking upsert',
    wires: [[]],
  },
};

function fixture() {
  const contract = structuredClone(CREATE_UPSERT_CONTRACT);
  const routes = contract.routes.map((route) => ({
    id: route.id,
    type: route.type,
    z: route.z,
    name: route.name,
    method: route.method,
    url: route.url,
    upload: false,
    swaggerDoc: '',
    wires: structuredClone(route.wires),
  }));
  const graphNodes = contract.graphNodes.map((item) => {
    const shape = GRAPH_SHAPES[item.id];
    const node = {
      id: item.id,
      type: shape.type,
      z: contract.tab.id,
      name: shape.name,
      ...Object.hasOwn(shape, 'outputs') ? { outputs: shape.outputs } : {},
      ...Object.hasOwn(shape, 'active') ? { active: shape.active } : {},
      wires: structuredClone(shape.wires),
    };
    if (shape.type === 'function') {
      node.func = item.id === contract.target.id ? createSource() : `return msg; // ${item.id}`;
    }
    return node;
  });
  const flow = [{ ...contract.tab, info: '' }, ...routes, ...graphNodes];
  for (const route of contract.routes) {
    route.nodeSha256 = sha256Json(flow.find((node) => node.id === route.id));
  }
  for (const item of contract.graphNodes) {
    const node = flow.find((candidate) => candidate.id === item.id);
    item.nodeSha256 = sha256Json(node);
    if (node.type === 'function') item.funcSha256 = sha256(node.func);
  }
  contract.wholeFlowSha256 = sha256(Buffer.from(`${JSON.stringify(flow, null, 2)}\n`));
  contract.nodeCount = flow.length;
  contract.httpRouteCount = contract.routes.length;
  contract.target.preimageSha256 = sha256(createSource());
  contract.target.sourceSha256 = sha256(createSource());
  const raw = Buffer.from(`${JSON.stringify(flow, null, 2)}\n`);
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

test('tracked create source matches the exact live target preimage', () => {
  assert.equal(
    sha256(createSource()),
    '08c2b5ac7d2f5ee111efab6edb0c19c3eb663fd16e5bfa5798a1f717cc82312f',
  );
  assert.equal(
    CREATE_UPSERT_CONTRACT.target.sourceSha256,
    CREATE_UPSERT_CONTRACT.target.preimageSha256,
  );
  assert.equal(CREATE_UPSERT_CONTRACT.target.sourceSha256, sha256(createSource()));
});

test('all six POST routes preserve the current mode matrix', () => {
  const cases = [
    ['/lk/games', {}, 'create', 'GAME_CREATED'],
    ['/lk/games/records', {}, 'create', 'GAME_CREATED'],
    ['/lk/games/payment/confirm', { paymentRef: 'pay-confirm' }, 'confirm', 'GAME_PAYMENT_CONFIRMED'],
    ['/lk/games/confirm', {}, 'create', 'GAME_CREATED'],
    ['/lk/games/drafts', { paymentRef: 'pay-draft' }, 'draft', 'GAME_DRAFT_SAVED'],
    ['/lk/games/draft', { paymentRef: 'pay-draft' }, 'draft', 'GAME_DRAFT_SAVED'],
  ];
  for (const [route, payload, mode, eventType] of cases) {
    const { outputs } = runCreate(route, { id: `game-${mode}`, ...payload });
    assert.equal(outputs.length, 4);
    assert.equal(outputs[0]._requestMode, mode);
    assert.equal(outputs[0].payload.$push['audit.events'].$each[0].type, eventType);
  }
  assert.equal(CREATE_UPSERT_CONTRACT.routes.length, 6);
  assert.equal(CREATE_UPSERT_CONTRACT.routes.every((route) => (
    route.method === 'post'
    && isDeepStrictEqual(route.wires, [[CREATE_UPSERT_CONTRACT.target.id]])
  )), true);
});

test('explicit action overrides the path and missing paymentRef fails closed', () => {
  const explicitConfirm = runCreate('/lk/games', {
    id: 'explicit-confirm',
    action: 'confirm',
    paymentRef: 'pay-explicit',
  }).outputs;
  assert.equal(explicitConfirm[0]._requestMode, 'confirm');
  assert.equal(explicitConfirm[0].payload.$set.payment.paid, true);

  const explicitCreate = runCreate('/lk/games/payment/confirm', {
    id: 'explicit-create',
    action: 'create',
  }).outputs;
  assert.equal(explicitCreate[0]._requestMode, 'create');

  for (const route of ['/lk/games/payment/confirm', '/lk/games/draft']) {
    const outputs = runCreate(route, { id: 'missing-ref' }).outputs;
    assert.equal(outputs[0], null);
    assert.equal(outputs[1].statusCode, 400);
    assert.equal(outputs[1].payload.error, 'paymentRef is required');
    assert.equal(outputs[2].statusCode, 400);
  }
});

test('booking conversion allows open/court and rejects group/tournament/unknown on four outputs', () => {
  for (const payload of [
    { metadata: { source: 'cabinet_booking_convert' }, typeId: 1613 },
    { metadata: { source: 'cabinet_booking_convert' }, typeName: 'Аренда корта' },
    {
      metadata: { source: 'cabinet_booking_convert' },
      directionId: 4588,
      typeId: 839,
    },
  ]) {
    const outputs = runCreate('/lk/games', { id: crypto.randomUUID(), ...payload }).outputs;
    assert.equal(outputs.length, 4);
    assert.notEqual(outputs[0], null);
    assert.equal(outputs[1].statusCode, 200);
  }

  for (const [payload, expectedCode] of [
    [{ typeId: 605 }, 'BOOKING_CONVERT_CATEGORY_NOT_ALLOWED'],
    [{ typeId: 839 }, 'BOOKING_CONVERT_CATEGORY_NOT_ALLOWED'],
    [{
      typeName: 'Падел турнир',
      directionName: 'Открытая игра',
    }, 'BOOKING_CONVERT_CATEGORY_NOT_ALLOWED'],
    [{ typeName: 'Индивидуальное занятие' }, 'BOOKING_CONVERT_CATEGORY_UNKNOWN'],
  ]) {
    const outputs = runCreate('/lk/games', {
      id: crypto.randomUUID(),
      metadata: { source: 'cabinet_booking_convert' },
      ...payload,
    }).outputs;
    assert.equal(outputs.length, 4);
    assert.equal(outputs[0], null);
    assert.equal(outputs[1].statusCode, 409);
    assert.equal(outputs[1].payload.code, expectedCode);
    if (payload.typeName === 'Падел турнир') {
      assert.equal(outputs[1].payload.category, 'tournament');
    }
    assert.equal(outputs[2].payload.action, 'booking_convert_blocked');
    assert.equal(outputs[3], null);
  }
});

test('singles force maxPlayers=2 and canonical roster stays deduped, capped, seeded, and separated', () => {
  const seed = {
    allPlayers: [{
      memberKey: 'id:seed-player',
      clientId: 'seed-player',
      name: 'Seed Player',
    }],
    initialTeamSlots: [{
      memberKey: 'id:seed-player',
      clientId: 'seed-player',
      name: 'Seed Player',
    }],
  };
  const outputs = runCreate('/lk/games', {
    id: 'singles-roster',
    metadata: { gameFormat: 'singles' },
    organizer: { id: 'organizer', phone: '8 999 000-00-01', name: 'Organizer' },
    participants: [
      { id: 'player-1', phone: '8 999 111-11-11', name: 'Player One' },
      { clientId: 'player-1', phone: '+7 999 111-11-11', name: 'Player One duplicate' },
      { id: 'player-2', phone: '8 999 222-22-22', name: 'Player Two' },
    ],
    waitlist: [
      { id: 'player-1', phone: '8 999 111-11-11', name: 'Active duplicate' },
      { id: 'wait-1', phone: '8 999 333-33-33', name: 'Waiting' },
    ],
    resultRosterSnapshot: seed,
    invite: { maxPlayers: 9 },
  }).outputs;
  const record = outputs[0].payload.$set;
  const snapshot = record.resultRosterSnapshot;
  assert.equal(record.invite.maxPlayers, 2);
  assert.equal(snapshot.bookingContext.maxPlayers, 2);
  assert.equal(snapshot.canonical, true);
  assert.equal(snapshot.activeRoster.length, 2);
  assert.equal(new Set(snapshot.activeRoster.map((member) => member.memberKey)).size, 2);
  const activeKeys = new Set(snapshot.activeRoster.map((member) => member.memberKey));
  assert.equal(snapshot.waitlist.every((member) => !activeKeys.has(member.memberKey)), true);
  assert.equal(
    snapshot.allPlayers.filter((member) => member.phoneNorm === '79991111111').length,
    1,
  );
  assert.equal(snapshot.allPlayers.some((member) => member.clientId === 'seed-player'), true);
  assert.equal(snapshot.initialTeamSlots.length, 4);
  assert.equal(snapshot.initialTeamSlots[0].clientId, 'seed-player');
});

test('audit append is bounded and all four success outputs retain DB/response/debug/autojoin shapes', () => {
  const outputs = runCreate('/lk/games/payment/confirm', {
    id: 'audit-game',
    paymentRef: 'audit-payment',
    bookingIds: ['booking-1'],
  }).outputs;
  const [db, response, debug, autojoin] = outputs;
  const event = db.payload.$push['audit.events'].$each[0];
  assert.equal(outputs.length, 4);
  assert.equal(event.type, 'GAME_PAYMENT_CONFIRMED');
  assert.equal(event.source, 'games_create');
  assert.equal(db.payload.$push['audit.events'].$slice, -200);
  assert.equal(db.payload.$set['audit.version'], 1);
  assert.equal(db.payload.$set['audit.lastEvent'].id, event.id);
  assert.equal(typeof db.payload.$setOnInsert.createdAt, 'string');
  assert.equal(db.query.$or.some((item) => item['metadata.paymentRef'] === 'audit-payment'), true);
  assert.equal(response.statusCode, 200);
  assert.equal(response.payload.id, 'audit-game');
  assert.equal(debug.payload.mode, 'confirm');
  assert.equal(debug.payload.gameId, 'audit-game');
  assert.equal(autojoin._requestMode, 'confirm');
  assert.equal(autojoin._gameAutojoinSource, 'games_create');
  assert.equal(autojoin.payload.id, 'audit-game');
});

test('exact 21-node graph and all node/function hashes remain fixed', () => {
  assert.equal(CREATE_UPSERT_CONTRACT.reachableNodeIds.length, 21);
  assert.equal(CREATE_UPSERT_CONTRACT.graphNodes.length, 15);
  assert.equal(isDeepStrictEqual(
    CREATE_UPSERT_CONTRACT.target.wires,
    [
      ['79307f9bcbc28b6c'],
      ['ae5ee70de15fe66e'],
      ['60a3353902ae9973'],
      ['9756d9125563753f'],
    ],
  ), true);
  assert.equal(
    CREATE_UPSERT_CONTRACT.routes.every((route) => /^[a-f0-9]{64}$/.test(route.nodeSha256)),
    true,
  );
  assert.equal(
    CREATE_UPSERT_CONTRACT.graphNodes.every((node) => (
      /^[a-f0-9]{64}$/.test(node.nodeSha256)
      && (!node.funcSha256 || /^[a-f0-9]{64}$/.test(node.funcSha256))
    )),
    true,
  );
});

test('zero-change synchronization is semantic and byte stable', () => {
  const built = fixture();
  const result = synchronizeCreateUpsert(
    structuredClone(built.flow),
    createSource(),
    built.contract.wholeFlowSha256,
    built.contract,
  );
  assert.equal(isDeepStrictEqual(result.changedNodes, []), true);
  assert.equal(isDeepStrictEqual(result.candidate, built.flow), true);
  assert.equal(result.invariants.reachableNodeCount, 21);
});

test('whole-flow, topology, target, route, graph, and non-target drift fail closed', () => {
  const built = fixture();
  const sync = (flow, sha = built.contract.wholeFlowSha256, source = createSource()) => (
    synchronizeCreateUpsert(flow, source, sha, built.contract)
  );
  assert.throws(() => sync(structuredClone(built.flow), '0'.repeat(64)), /Flow preimage SHA/);

  for (const [id, field, value, expected] of [
    [built.contract.tab.id, 'label', 'Wrong tab', /tab.*label/],
    [built.contract.routes[0].id, 'url', '/wrong', /route.*node preimage/],
    [built.contract.target.id, 'name', 'Renamed target', /graph node.*node preimage/],
    [built.contract.target.id, 'z', 'wrong-tab', /graph node.*node preimage/],
    [built.contract.target.id, 'wires', [[], [], [], []], /graph node.*node preimage/],
    [built.contract.graphNodes[1].id, 'unexpected', true, /graph node.*node preimage/],
  ]) {
    const drift = structuredClone(built.flow);
    drift.find((node) => node.id === id)[field] = value;
    assert.throws(() => sync(drift), expected);
  }

  const bodyDrift = structuredClone(built.flow);
  bodyDrift.find((node) => node.id === built.contract.target.id).func += '\n';
  assert.throws(() => sync(bodyDrift), /graph node.*node preimage/);
  assert.throws(
    () => sync(structuredClone(built.flow), built.contract.wholeFlowSha256, `${createSource()}\n`),
    /tracked source contract mismatch/,
  );

  for (const target of [built.contract.target, built.contract.graphNodes[1]]) {
    const missing = structuredClone(built.flow);
    missing.find((node) => node.id === target.id).id = crypto.randomUUID();
    assert.throws(() => sync(missing), /must exist exactly once|missing node/);

    const duplicate = structuredClone(built.flow);
    duplicate.find((node) => node.id === built.contract.tab.id).id = target.id;
    assert.throws(() => sync(duplicate), /must exist exactly once|duplicate node IDs/);
  }

  const nextSource = `${createSource()}\n// approved-test-only\n`;
  const nextContract = structuredClone(built.contract);
  nextContract.target.sourceSha256 = sha256(nextSource);
  const changed = synchronizeCreateUpsert(
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
    result = publishCreateUpsertCandidate({
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
  assert.equal(candidateText.includes('/lk/games/payment/confirm'), true);
  assert.equal(candidateText.includes('Prepare game upsert'), true);
  assert.doesNotMatch(reportText, /\/lk\/|return msg|source\.flow|private\/tmp/);
  assert.doesNotMatch(stdout.join('\n'), /\/lk\/|return msg|source\.flow|private\/tmp/);

  const mutated = workspaceFixture();
  const verified = verifyWorkspace(mutated.workspace, { quiet: true });
  const marker = 'SECRET_CREATE_UPSERT';
  fs.appendFileSync(mutated.sourcePath, marker);
  let mutationError;
  try {
    readVerifiedCreateUpsertBytes(verified);
    assert.fail('TOCTOU mutation must fail');
  } catch (error) {
    mutationError = error;
  }
  assert.match(mutationError.message, /changed after verification/);
  assert.doesNotMatch(mutationError.message, new RegExp(marker));
  assert.equal(fs.readdirSync(mutated.root).some((name) => name.includes('create-upsert-stage')), false);

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
    assert.throws(() => publishCreateUpsertCandidate({
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
    fs.readdirSync(failed.root).some((name) => name.includes('create-upsert-stage')),
    false,
  );
});

test('existing, partial, split, repo/input, symlink, hardlink, and stale paths fail closed', () => {
  const existing = workspaceFixture();
  const existingDirectory = path.join(existing.root, 'existing');
  fs.mkdirSync(existingDirectory, { mode: 0o700 });
  assert.throws(() => publishCreateUpsertCandidate({
    workspace: existing.workspace,
    output: path.join(existingDirectory, 'candidate.json'),
    report: path.join(existingDirectory, 'report.json'),
    contract: existing.contract,
  }), /must not already exist/);

  const partial = workspaceFixture();
  fs.mkdirSync(path.join(partial.root, '.publication.create-upsert-stage-stale'), { mode: 0o700 });
  assert.throws(() => publishCreateUpsertCandidate({
    workspace: partial.workspace,
    output: path.join(partial.root, 'publication', 'candidate.json'),
    report: path.join(partial.root, 'publication', 'report.json'),
    contract: partial.contract,
  }), /Partial create\/upsert publication/);

  const split = workspaceFixture();
  assert.throws(() => publishCreateUpsertCandidate({
    workspace: split.workspace,
    output: path.join(split.root, 'one', 'candidate.json'),
    report: path.join(split.root, 'two', 'report.json'),
    contract: split.contract,
  }), /share one new publication directory/);

  const input = workspaceFixture();
  assert.throws(() => publishCreateUpsertCandidate({
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
  assert.throws(() => publishCreateUpsertCandidate({
    workspace: symlink.workspace,
    output: path.join(parentAlias, 'publication', 'candidate.json'),
    report: path.join(parentAlias, 'publication', 'report.json'),
    contract: symlink.contract,
  }), /symlink parent|canonical/);

  const hardlink = workspaceFixture();
  fs.linkSync(hardlink.sourcePath, path.join(hardlink.root, 'source.hardlink.json'));
  assert.throws(() => publishCreateUpsertCandidate({
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
  assert.throws(() => publishCreateUpsertCandidate({
    workspace: stale.workspace,
    output: path.join(stale.root, 'publication', 'candidate.json'),
    report: path.join(stale.root, 'publication', 'report.json'),
    contract: stale.contract,
  }), /stale/);

  const insideRepo = workspaceFixture();
  const unique = path.join(REPO_ROOT, `.create-upsert-${process.pid}-${crypto.randomUUID()}`);
  assert.equal(fs.existsSync(unique), false);
  assert.throws(() => publishCreateUpsertCandidate({
    workspace: insideRepo.workspace,
    output: path.join(unique, 'candidate.json'),
    report: path.join(unique, 'report.json'),
    contract: insideRepo.contract,
  }), /outside the repository/);
  assert.equal(fs.existsSync(unique), false);
});
