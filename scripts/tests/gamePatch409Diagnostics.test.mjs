import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { randomUUID, randomBytes } from 'node:crypto';
import { EventEmitter } from 'node:events';
import ts from 'typescript';
import { diagnosticBuildIdentity } from '../diagnostic_build_identity.ts';
import { gamePatchClaims, gamePatchDiagnosticUrl } from '../../src/utils/gamePatchDiagnostics.mjs';
import { sanitizeEvent, routeTemplate, UUID } from '../../src/utils/errorDiagnosticsCore.mjs';
import { createDiagnostics } from '../diagnostics/runtime.mjs';
import { createCollector } from '../diagnostics/collector.mjs';

const build = 'a'.repeat(40), logicalOperation = randomUUID();
const query = new URL(gamePatchDiagnosticUrl('/lk/games/fixture-game', { callerBuild: build, logicalOperation }), 'https://fixture.invalid').search;
const request = (alias = false) => ({ method: 'PATCH', path: alias ? '/lk/games/records/fixture-game' : '/lk/games/fixture-game',
  url: (alias ? '/lk/games/records/fixture-game' : '/lk/games/fixture-game') + query,
  params: { gameId: 'fixture-game' }, headers: { authorization: 'SYNTHETIC_PRIVATE' },
  body: { participants: [], expectedUpdatedAt: 'version-old', token: 'SYNTHETIC_PRIVATE' } });
const game = () => ({ _id: 'fixture-document', id: 'fixture-game', updatedAt: 'version-old', revision: 1, participants: [], waitlist: [], payments: [] });
const sources = Object.fromEntries(['preflight', 'authorize', 'ack'].map(name => [name, fs.readFileSync(`scripts/nodered_partner_roster_nodes/fn_${name}.js`, 'utf8')]));
const run = (name, msg, diagnostics) => new Function('msg', 'global', sources[name])(msg, { get: name => name === 'lkDiagnostics' ? diagnostics : null });
function observed(options = {}) {
  const events = [];
  const diagnostics = createDiagnostics({ release: 'b'.repeat(40), key: randomBytes(32), sink: event => events.push(event), ...options });
  return { events, diagnostics };
}
function scenario(kind, diagnostics, alias = false) {
  const req = request(alias), msg = { req, payload: structuredClone(req.body) };
  run('preflight', msg, diagnostics);
  msg.payload = kind === 'binding' ? [game(), game()] : [{ ...game(), updatedAt: kind === 'precondition' ? 'version-new' : 'version-old' }];
  const allowed = run('authorize', msg, diagnostics);
  if (allowed[1]) return allowed;
  msg._partnerRosterPatch.response = { payload: { id: 'fixture-game' }, statusCode: 200, headers: {} };
  msg.payload = { acknowledged: true, matchedCount: kind === 'cas' ? 0 : 1, modifiedCount: kind === 'cas' ? 0 : 1 };
  return run('ack', msg, diagnostics);
}
class Response extends EventEmitter {
  headers = {}; statusCode = 200;
  setHeader(name, value) { this.headers[name.toLowerCase()] = value; }
  getHeader(name) { return this.headers[name.toLowerCase()]; }
  end(body) { this.body = body; this.emit('finish'); }
}

for (const alias of [false, true]) {
  for (const kind of ['binding', 'precondition', 'cas']) {
    test(`actual ${alias ? 'alias' : 'direct'} server ${kind} conflict carries safe claims/stage without changing the refusal`, () => {
      const { events, diagnostics } = observed();
      const enabled = scenario(kind, diagnostics, alias), disabled = scenario(kind, undefined, alias);
      assert.deepEqual(enabled, disabled);
      const failures = events.filter(e => e.httpStatus === 409);
      assert.equal(failures.length, 1);
      const event = failures[0];
      assert.equal(event.patchConflictStage, kind); assert.equal(event.callerBuild, build);
      assert.equal(event.logicalOperation, logicalOperation); assert(UUID.test(event.requestId));
      assert.equal(event.routeTemplate, alias ? '/lk/games/records/:gameId' : '/lk/games/:gameId');
      assert.equal(event.outcome, 'refused');
      for (const privateValue of ['SYNTHETIC_PRIVATE', 'fixture-game', 'fixture-document', 'version-old', 'version-new']) assert(!JSON.stringify(event).includes(privateValue));
      assert.deepEqual(sanitizeEvent(event), event);
      diagnostics.dispose();
    });
  }
}

test('terminal409 retains only validated scalar claims and server phase for joining records', () => {
  const { events, diagnostics } = observed(), req = request(), res = new Response();
  diagnostics.middleware(req, res, () => {});
  diagnostics.observe({ req }, 'roster_authorize', { code: 'GAME_PATCH_VERSION_CONFLICT', httpStatus: 409 });
  res.statusCode = 409; res.end('unchanged response');
  const terminal = events.find(e => e.eventKind === 'request_terminal');
  assert.equal(terminal.patchConflictStage, 'precondition'); assert.equal(terminal.callerBuild, build);
  assert.equal(terminal.logicalOperation, logicalOperation);
  assert.equal(terminal.requestId, res.headers['x-lk-request-id']);
  assert.equal(res.body, 'unchanged response');
  const collector = createCollector();
  const result = collector.ingest({ source: 'logical_operations', available: true, inode: '1', offset: 0, nextOffset: 100,
    fromUtc: '2026-11-12T00:00:00.000Z', toUtc: '2026-11-13T00:00:00.000Z', serverIngestTime: '2026-11-13T00:00:00.000Z', records: events });
  assert.equal(result.distinctObservedOperations, 1); assert.equal(result.malformedRecords, 0);
  diagnostics.dispose();
});

test('legacy alias middleware keeps its response/header behavior while node hooks can classify it', () => {
  const { diagnostics } = observed(), res = new Response(); let next = 0;
  diagnostics.middleware(request(true), res, () => { next++; });
  assert.deepEqual(res.headers, {}); assert.equal(next, 1);
  diagnostics.dispose();
});

for (const text of [
  '?__lk_diag_op=not-an-id&__lk_diag_build=SYNTHETIC_PRIVATE',
  `?__lk_diag_op=${logicalOperation}&__lk_diag_op=${logicalOperation}&__lk_diag_build=${build}&__lk_diag_build=${build}`,
  '?__lk_diag_op[x]=SYNTHETIC_PRIVATE&__lk_diag_build[x]=SYNTHETIC_PRIVATE',
  '?__lk_diag_op=' + 'x'.repeat(5000),
]) {
  test('invalid/duplicated/oversized query claims are dropped without changing the request', () => {
    const { events, diagnostics } = observed(), req = request(); req.url = req.path + text;
    const before = structuredClone(req);
    diagnostics.observe({ req }, 'roster_authorize', { code: 'GAME_PATCH_VERSION_CONFLICT', httpStatus: 409 });
    const [event] = events; assert.equal(event.callerBuild, 'UNKNOWN'); assert.equal(event.logicalOperation, undefined);
    assert.equal(event.patchConflictStage, 'precondition'); assert.deepEqual(req, before);
    assert(!JSON.stringify(event).includes('SYNTHETIC_PRIVATE')); diagnostics.dispose();
  });
}

test('phase is server-derived: forged query phase, browser events and non-CAS ACK cannot classify a conflict', () => {
  const { events, diagnostics } = observed(), req = request(); req.url += '&patchConflictStage=cas';
  diagnostics.observe({ req }, 'roster_authorize', { code: 'GAME_PATCH_VERSION_CONFLICT', httpStatus: 409 });
  assert.equal(events[0].patchConflictStage, 'precondition');
  diagnostics.observe({ req, payload: { acknowledged: false, matchedCount: 0 }, _partnerRosterPatch: { preimage: {} } }, 'roster_ack', { code: 'GAME_PATCH_VERSION_CONFLICT', httpStatus: 409 });
  assert.equal(events.at(-1).patchConflictStage, 'UNKNOWN');
  const client = sanitizeEvent({ ...events[0], source: 'browser', patchConflictStage: 'cas' });
  assert.equal(client.patchConflictStage, undefined); diagnostics.dispose();
});

test('metadata never propagates outside exact PATCH game routes or to provider URLs', () => {
  const { events, diagnostics } = observed();
  for (const [method, target] of [['POST', '/lk/games/fixture-game'], ['GET', '/lk/games/fixture-game'], ['PATCH', '/lk/games/fixture-game/split/leave'], ['PATCH', '/lk/subscription-bookings']]) {
    diagnostics.observe({ req: { ...request(), method, path: target } }, 'roster_authorize', { code: 'GAME_PATCH_VERSION_CONFLICT', httpStatus: 409 });
    assert.equal(events.at(-1).logicalOperation, undefined); assert.equal(events.at(-1).callerBuild, 'UNKNOWN');
    assert.equal(events.at(-1).patchConflictStage, undefined);
  }
  for (const url of ['https://provider.invalid/lk/games/fixture-game', '/end-user/bookings', '/lk/games/fixture-game/split/leave']) {
    assert.equal(gamePatchDiagnosticUrl(url, { callerBuild: build, logicalOperation }), url);
  }
  assert.equal(routeTemplate('/lk/games/records/SYNTHETIC_PRIVATE?token=private'), '/lk/games/records/:gameId');
  diagnostics.dispose();
});

test('missing/throwing observer and failed sink preserve business responses and writes', () => {
  for (const kind of ['binding', 'precondition', 'cas', 'success']) {
    const expected = scenario(kind);
    assert.deepEqual(scenario(kind, { observe() { throw Error('SYNTHETIC_PRIVATE'); } }), expected);
    const { diagnostics } = observed({ sink() { throw Error('SYNTHETIC_PRIVATE'); } });
    assert.deepEqual(scenario(kind, diagnostics), expected); diagnostics.dispose();
  }
  assert.deepEqual(gamePatchClaims({ getAll() { throw Error('private'); } }), { callerBuild: 'UNKNOWN' });
});

test('build identity uses the clean owning Git tree, with UNKNOWN for dirty or unavailable source', t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'patch409-build-')); t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const git = (...args) => execFileSync('git', args, { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
  assert.equal(diagnosticBuildIdentity(root), 'UNKNOWN');
  git('init', '--quiet'); fs.writeFileSync(path.join(root, 'source.txt'), 'fixture'); git('add', 'source.txt');
  git('-c', 'user.name=fixture', '-c', 'user.email=fixture@invalid', '-c', 'commit.gpgsign=false', '-c', 'core.hooksPath=/dev/null', 'commit', '--quiet', '-m', 'fixture');
  assert.equal(diagnosticBuildIdentity(root), git('rev-parse', 'HEAD'));
  fs.writeFileSync(path.join(root, 'source.txt'), 'modified'); assert.equal(diagnosticBuildIdentity(root), 'UNKNOWN');
});

test('callerBuild is an embedded literal and cannot follow mutable latest-release globals', () => {
  const source = ts.createSourceFile('errorDiagnostics.ts', fs.readFileSync('src/utils/errorDiagnostics.ts', 'utf8'), ts.ScriptTarget.Latest, true);
  const fn = source.statements.find(n => ts.isFunctionDeclaration(n) && n.name?.text === 'callerBuild');
  const code = ts.transpileModule(fn.getText(source).replace(/^export /, '').replace('import.meta.env.VITE_DIAGNOSTIC_BUILD', JSON.stringify(build)), { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText;
  const window = { __LK_RELEASE_VERSION__: 'old-manifest' };
  const read = new Function('window', code + ';return callerBuild;')(window);
  assert.equal(read(), build); window.__LK_RELEASE_VERSION__ = 'new-manifest'; assert.equal(read(), build);
  for (const file of ['vite.config.ts', 'vite.config.games.ts']) assert.match(fs.readFileSync(file, 'utf8'), /VITE_DIAGNOSTIC_BUILD.*diagnosticBuildIdentity\(\)/);
});
