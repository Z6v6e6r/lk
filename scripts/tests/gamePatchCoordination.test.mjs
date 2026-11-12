import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';
import { webcrypto, createHash } from 'node:crypto';
import ts from 'typescript';

// Evaluate independent copies as cabinet/games IIFEs do. Only the host is shared.
function utility(name) {
  const source = ts.transpileModule(fs.readFileSync(`src/utils/${name}.ts`, 'utf8'), {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS },
  }).outputText;
  const exports = {}; new Function('exports', source)(exports); return exports;
}
const { gamePatchSnapshot: snapshot, gamePatchSnapshotKind: kind, applyGamePatchSnapshot: apply } = utility('gamePatchSnapshot');
const deferred = () => { let resolve; const promise = new Promise(r => { resolve = r; }); return { promise, resolve }; };
const tick = () => new Promise(resolve => setImmediate(resolve));
const options = (host, extra = {}) => ({ host, backend: 'https://fixture.invalid', tenant: 'fixture', gameId: 'game', token: 'fixture-session',
  payload: { expectedUpdatedAt: 'v1', participants: [{ id: 'fixture-player' }], waitlist: [] },
  background: { kind: 'roster_sync', intent: { providerPlayers: ['fixture-player'] } }, current: () => true,
  run: async () => 'accepted', ...extra });

test('independent IIFEs share one PATCH through canonical GET/publication, then suppress remount/version-only replay', async () => {
  const a = utility('gamePatchCoordinator').coordinateGamePatch, b = utility('gamePatchCoordinator').coordinateGamePatch;
  const host = { crypto: { subtle: { digest: async (_algorithm, bytes) => createHash('sha256').update(bytes).digest() } } }, gate = deferred(), entered = deferred(); let writes = 0;
  const run = async () => { writes++; entered.resolve(); await gate.promise; return { accepted: true }; };
  const first = a(options(host, { run })); await entered.promise;
  const second = b(options(host, { run })); await tick();
  assert.equal(writes, 1);
  gate.resolve();
  assert.deepEqual(await first, await second);
  const rerender = await b(options(host, { run, payload: { expectedUpdatedAt: 'v2', participants: [], waitlist: [] } }));
  assert.deepEqual(rerender, { kind: 'skipped', reason: 'completed' });
  assert.equal(writes, 1);
  assert.equal((await a(options(host, { background: { kind: 'roster_sync', intent: { providerPlayers: ['changed'] } } }))).kind, 'done');
  const text = JSON.stringify([...host[Symbol.for('padlhub.gamePatchCoordinator.v1')].resources]);
  assert(!text.includes('fixture-session')); assert(!text.includes('fixture-player'));
});

test('different payload/repair is skipped, manual mandatory finalizers keep admission and block later background writes', async () => {
  const { coordinateGamePatch: coordinate } = utility('gamePatchCoordinator');
  const host = { crypto: webcrypto }, gate = deferred(), entered = deferred(); let calls = 0;
  const first = coordinate(options(host, { background: undefined, run: async () => { calls++; entered.resolve(); await gate.promise; } }));
  await entered.promise;
  assert.equal((await coordinate(options(host))).reason, 'busy');
  assert.equal((await coordinate(options(host, { background: undefined, run: async () => ++calls }))).value, 2);
  gate.resolve(); await first;
  const pending = deferred(), started = deferred();
  const bg = coordinate(options(host, { run: async () => { started.resolve(); return pending.promise; } })); await started.promise;
  assert.equal((await coordinate(options(host, { payload: { participants: [] } }))).reason, 'busy');
  assert.equal((await coordinate(options(host, { background: { kind: 'related_phones', intent: [] } }))).reason, 'busy');
  assert.equal((await coordinate(options(host, { gameId: 'other' }))).kind, 'done');
  assert.equal((await coordinate(options(host, { tenant: 'other' }))).kind, 'done');
  pending.resolve(); await bg;
});

test('conflict, partial ACK, transport ambiguity and cleanup never enqueue or retry the same settled repair', async () => {
  for (const outcome of [409, 'partial_ack', 'transport_error']) {
    const { coordinateGamePatch: coordinate } = utility('gamePatchCoordinator'); const host = { crypto: webcrypto }; let writes = 0;
    const run = async () => { writes++; if (outcome === 'transport_error') throw Error('fixture'); return outcome; };
    await coordinate(options(host, { run })).catch(() => {});
    assert.equal((await coordinate(options(host, { run }))).reason, 'completed'); assert.equal(writes, 1);
  }
});

test('session change, missing crypto and incompatible registry fail closed only for background repairs', async () => {
  const { coordinateGamePatch: coordinate } = utility('gamePatchCoordinator');
  for (const host of [{}, { crypto: webcrypto, [Symbol.for('padlhub.gamePatchCoordinator.v1')]: { version: 2 } },
    Object.defineProperty({ crypto: webcrypto }, Symbol.for('padlhub.gamePatchCoordinator.v1'), { get() { throw Error('fixture'); } })]) {
    let calls = 0;
    assert.equal((await coordinate(options(host, { run: async () => ++calls }))).reason, 'unavailable');
    assert.equal(calls, 0);
    assert.equal((await coordinate(options(host, { background: undefined, run: async () => ++calls }))).kind, 'done');
    assert.equal(calls, 1);
  }
  assert.equal((await coordinate(options({ crypto: webcrypto }, { current: () => false }))).reason, 'session_changed');
  const host = { crypto: webcrypto };
  assert.equal((await coordinate(options(host))).kind, 'done');
  assert.equal((await coordinate(options(host, { token: 'new-session' }))).kind, 'done');
  assert.equal((await coordinate(options(host, { background: { kind: 'manual', intent: {} } }))).reason, 'unavailable');
});

const old = { id: 'game', updatedAt: '2026-11-12T10:00:00Z', revision: 1, participants: [{ id: 'removed' }], waitlist: [{ id: 'waiting' }], metadata: { obsolete: true }, payment: { paid: true } };
const full = { id: 'game', updatedAt: '2026-11-12T10:01:00Z', revision: 2, participants: [], waitlist: [], metadata: null };
test('canonical raw presence is required before normalized defaults; wrong/ambiguous IDs cannot become canonical', () => {
  for (const raw of [{ id: 'game', updatedAt: full.updatedAt }, { ...full, waitlist: undefined }, { ...full, id: 'other' }, [full, full], {}]) {
    assert.equal(snapshot(raw, full, 'game', 'canonical'), null);
  }
  assert.equal(kind(snapshot({ data: { ...full, players: [], participants: undefined, waitingList: [], waitlist: undefined } }, full, 'game', 'canonical')), 'canonical');
});
test('canonical replaces roster and absent business metadata in actual GamesPage and Cabinet mergers', () => {
  const incoming = snapshot(full, full, 'game', 'canonical');
  assert.deepEqual(apply(old, incoming), full);
  assert.equal(apply(old, incoming).payment, undefined);
  for (const [file, name, invoke] of [
    ['src/components/games/GamesPage.tsx', 'mergePadelGameRecord', fn => fn(old, incoming)],
    ['src/components/cabinet/Cabinet.tsx', 'mergeCabinetGameRecords', fn => fn([old], [incoming])[0]],
  ]) {
    const text = fs.readFileSync(file, 'utf8'), source = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
    const node = source.statements.find(node => ts.isFunctionDeclaration(node) && node.name?.text === name);
    const code = ts.transpileModule(`return (${node.getText(source)});`, { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText;
    const fn = new Function('applyGamePatchSnapshot', code)(apply);
    assert.deepEqual(invoke(fn), full);
  }
});
test('partial ACK retains unknown roster/metadata and old version; newer ACK prevents late canonical rollback', () => {
  const raw = { id: 'game', updatedAt: full.updatedAt, revision: 2, status: 'CONFIRMED' };
  const ack = snapshot(raw, { ...raw, participants: [], waitlist: [], metadata: null }, 'game', 'partial_ack');
  assert.deepEqual(Object.keys(ack).sort(), ['id', 'status']);
  const pending = apply(old, ack);
  assert.equal(pending.updatedAt, old.updatedAt); assert.equal(pending.revision, 1);
  assert.deepEqual(pending.participants, old.participants); assert.deepEqual(pending.metadata, old.metadata);
  assert.equal(apply(pending, snapshot(old, old, 'game', 'canonical')), pending);
  const canonical = snapshot(full, full, 'game', 'canonical');
  assert.deepEqual(apply(pending, canonical), full);
  assert.equal(apply(canonical, snapshot(old, old, 'game', 'canonical')), canonical);
  assert.equal(kind(JSON.parse(JSON.stringify(pending))), null, 'internal status never goes onto the wire');
  assert.equal(apply(pending, { id: 'game', status: 'CANCELLED' }), null, 'legacy manual finalizers keep existing merge semantics');
  assert.deepEqual(apply({ ...old, id: 'other', revision: 999 }, canonical), full, 'versions of different games never compare');
});

test('delayed unversioned/incomparable ACK cannot pair stale business fields with a newer canonical version', () => {
  for (const version of [{}, { updatedAt: null }, { updatedAt: 'opaque-unknown' }]) {
    const raw = { id: 'game', participants: old.participants, metadata: old.metadata, ...version };
    const ack = snapshot(raw, raw, 'game', 'partial_ack');
    const applied = apply(snapshot(full, full, 'game', 'canonical'), ack);
    assert.deepEqual(applied, full);
    assert.equal(kind(applied), 'partial_ack');
  }
});

test('unknown/null canonical version cannot replace an already versioned snapshot or pending ACK lower bound', () => {
  const raw = { id: 'game', updatedAt: null, participants: old.participants, waitlist: [] };
  const incoming = snapshot(raw, raw, 'game', 'canonical');
  const current = snapshot(full, full, 'game', 'canonical');
  assert.equal(apply(current, incoming), current);
  const ackRaw = { id: 'game', revision: 3, status: 'CONFIRMED' };
  const pending = apply(current, snapshot(ackRaw, ackRaw, 'game', 'partial_ack'));
  assert.equal(apply(pending, incoming), pending);
  assert.equal(apply(pending, snapshot({ ...full, revision: 2 }, { ...full, revision: 2 }, 'game', 'canonical')), pending);
});

test('actual subscribers apply canonical after owner cleanup; Cabinet keeps an id-only ACK visible and ignores late old snapshots', () => {
  const listeners = new Map(), host = {
    addEventListener: (name, fn) => { if (!listeners.has(name)) listeners.set(name, new Set()); listeners.get(name).add(fn); },
    removeEventListener: (name, fn) => listeners.get(name)?.delete(fn),
  };
  const eventName = 'padlhub:game-patch-snapshot:v1';
  const effects = file => {
    const source = ts.createSourceFile(file, fs.readFileSync(file, 'utf8'), ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
    let effect;
    const visit = node => {
      if (ts.isCallExpression(node) && node.expression.getText(source) === 'useEffect'
        && node.arguments[0]?.getText(source).includes('window.addEventListener(GAME_PATCH_SNAPSHOT_EVENT')) effect = node.arguments[0];
      ts.forEachChild(node, visit);
    }; visit(source); assert(effect, file); return { source, effect };
  };
  const compile = node => ts.transpileModule(`return (${node});`, { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText;
  const games = effects('src/components/games/GamesPage.tsx'), cabinet = effects('src/components/cabinet/Cabinet.tsx');
  let token = 'fixture-session', active = old, created = [old];
  const base = { window: host, readAuthToken: () => token, patchSnapshotSession: token, GAME_PATCH_SNAPSHOT_EVENT: eventName, gamePatchSnapshotKind: kind };
  const mountGames = () => {
    const scope = { ...base, upsertGameRecordInStores: record => { active = apply(active, record) ?? active; } };
    return new Function(...Object.keys(scope), compile(games.effect.getText(games.source)))(...Object.values(scope))();
  };
  const merger = cabinet.source.statements.find(node => ts.isFunctionDeclaration(node) && node.name?.text === 'mergeCabinetGameRecords');
  const mergeCabinet = new Function('applyGamePatchSnapshot', compile(merger.getText(cabinet.source)))(apply);
  const scope = { ...base, profile: { id: 'fixture-profile' }, mergeCabinetGameRecords: mergeCabinet,
    isGameRelevantToCabinetIdentity: record => Array.isArray(record.participants),
    setCreatedGames: fn => { created = fn(created); }, setCreatedGamesError: () => {},
  };
  const cleanupCabinet = new Function(...Object.keys(scope), compile(cabinet.effect.getText(cabinet.source)))(...Object.values(scope))();
  const cleanupOwner = mountGames(), cleanupOther = mountGames(); cleanupOwner();
  const emit = record => { for (const fn of listeners.get(eventName)) fn({ type: eventName, detail: { record } }); };
  emit(snapshot({ id: 'game' }, { id: 'game', participants: [], waitlist: [] }, 'game', 'partial_ack'));
  assert.deepEqual(created[0].participants, old.participants); assert.equal(created.length, 1);
  emit(snapshot(full, full, 'game', 'canonical'));
  assert.deepEqual(active, full); assert.deepEqual(created, [full]);
  emit(snapshot(old, old, 'game', 'canonical'));
  assert.deepEqual(active, full); assert.deepEqual(created, [full]);
  token = 'other-session'; emit(snapshot({ ...full, revision: 9 }, { ...full, revision: 9 }, 'game', 'canonical'));
  assert.equal(active.revision, 2); assert.equal(created[0].revision, 2);
  cleanupOther(); cleanupCabinet(); assert.equal(listeners.get(eventName).size, 0);
});
