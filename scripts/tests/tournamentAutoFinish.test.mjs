import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import vm from 'node:vm';
import { build } from 'esbuild';
import { MongoClient } from 'mongodb';
import { buildAutoFinishNode, AUTO_FINISH_NODES } from '../lib/tournamentAutoFinishNodes.mjs';
import { planTournamentAutoFinish, applyTournamentAutoFinish, tournamentRoundFacts } from '../lib/tournamentAutoFinish.mjs';
import { buildTournamentAutoFinish } from '../patch_tournament_auto_finish.mjs';
import { runTournamentAutoFinish } from '../tournament_auto_finish_worker.mjs';
import { buildFprNodeFunction } from '../nodered_fpr6x25.mjs';
import { createFprState, applyFprCommand, fprProjection } from '../../src/components/tournaments/fpr6x25.ts';
import { planCommunityTournamentClose } from '../lib/communityMonthlyFinalization.mjs';
import { tournamentResultNeedsReview } from '../../src/utils/tournamentOfflineSyncPolicy.ts';
import { tournamentAutoFinishNotice } from '../../src/components/tournaments/tournamentAutoFinish.ts';

const start = '2026-11-10T09:00:00.000Z';
const due = '2026-11-10T12:00:00.000Z';
const now = Date.parse(due);
const read = name => fs.readFileSync('scripts/nodered_games_nodes/' + name + '.js', 'utf8');
const source = read('fn_tournament_recalculate');
const guarded = buildAutoFinishNode(source, 'write');
class FixedDate extends Date {
  constructor(value) { super(value === undefined ? due : value); }
  static now() { return Date.parse(due); }
}
const invoke = (text, msg) => new Function('msg', 'Date', text)(msg, FixedDate);
const fixture = () => ({ _id: 'synthetic-auto-finish', tournamentId: 'synthetic-auto-finish', tournamentType: 'americano', createdAt: start, updatedAt: start,
  params: { autoFinish: { version: 1, session: 1, startedAt: start, deadlineAt: due } },
  participants: [1, 2, 3, 4].map(i => ({ id: 'p' + i, name: 'Synthetic player ' + i, rating: 3 })),
  courts: ['Synthetic court'], targetScore: 21,
  rounds: [{ id: 'round-1', index: 1, byes: [], matches: [
    { id: 'match-1', pair1: ['p1', 'p2'], pair2: ['p3', 'p4'], score1: 12, score2: 9 },
    { id: 'match-2', pair1: ['p1', 'p3'], pair2: ['p2', 'p4'], score1: null, score2: null },
  ] }],
});
const flow = () => [{ id: 'tab', type: 'tab' }, ...Object.entries(AUTO_FINISH_NODES).map(([kind, id]) => ({
  id, type: 'function', z: 'tab', wires: [], func: read({ write: 'fn_tournament_recalculate', prepare: 'fn_tournament_prepare', ack: 'fn_tournament_save_ack' }[kind]),
}))];
function request(tournament, body = {}) { return { payload: [structuredClone(tournament)], req: { body: { results: [], ...body } } }; }

test('deadline is actual server start plus three hours, never publication/created/updated time', () => {
  const t = fixture(); t.createdAt = '2025-01-01'; t.updatedAt = '2027-01-01';
  assert.equal(planTournamentAutoFinish(t, now - 1, guarded).reason, 'NOT_DUE');
  assert.equal(planTournamentAutoFinish(t, now, guarded).close, true);
  assert.equal(planTournamentAutoFinish({ ...t, params: {} }, now, guarded).reason, 'NOT_MANAGED');
  t.params.autoFinish.deadlineAt = start;
  assert.equal(planTournamentAutoFinish(t, now, guarded).reason, 'INVALID_SERVER_DEADLINE');
});
test('partial tournament finishes using saved complete scores, preserving every match', () => {
  const t = fixture(), before = structuredClone(t);
  const plan = planTournamentAutoFinish(t, now, guarded);
  assert.equal(plan.close, true); assert.deepEqual(t, before);
  assert.equal(plan.set.params.finishedAt, due);
  assert.equal(plan.set.params.autoFinish.reason, 'time_limit');
  assert.equal(plan.set.summary.completedMatches, 1);
  assert.deepEqual(JSON.parse(JSON.stringify(tournamentRoundFacts(plan.set.rounds))), tournamentRoundFacts(t.rounds));
  assert.ok(plan.set.standings.every(row => row.matchesPlayed === 1));
  assert.equal(planTournamentAutoFinish({ ...t, ...plan.set }, now + 60_000, guarded).reason, 'ALREADY_FINISHED');
});
test('scoring all scheduled matches does not skip the administrative finish', () => {
  const t = fixture(); t.summary = { status: 'completed', finished: false };
  assert.equal(planTournamentAutoFinish(t, now, guarded).close, true);
});
test('zero complete matches produce no standings, totals or player rating logs', () => {
  const t = fixture(); t.rounds[0].matches[0].score2 = null;
  const plan = planTournamentAutoFinish(t, now, guarded);
  assert.equal(plan.close, true);
  assert.equal(plan.set.standings.length, 0);
  assert.equal(Object.keys(plan.set.totals).length, 0);
  assert.equal(Object.keys(plan.set.playerLogs).length, 0);
});
test('invalid saved scores are quarantined; cancelled tournaments never finalize', () => {
  const t = fixture(); t.rounds[0].matches[0].score1 = -1;
  assert.equal(planTournamentAutoFinish(t, now, guarded).reason, 'INVALID_SAVED_SCORE');
  assert.equal(planTournamentAutoFinish({ ...fixture(), cancelled: true }, now, guarded).reason, 'INACTIVE');
});
test('managed closure and deadline cannot be overridden by stale params or a client internal marker', () => {
  const t = fixture();
  const out = invoke(guarded, request(t, { _tournamentAutoFinishInternal: true, params: { autoFinish: { deadlineAt: '2099-01-01' } } }));
  assert.equal(out.statusCode, 409); assert.equal(out.mongoUpdate, undefined);
  const closed = { ...t, params: { ...t.params, finished: true, finishedAt: due } };
  assert.equal(invoke(guarded, request(closed)).payload.error, 'TOURNAMENT_CLOSED');
});
test('resume arms a fresh session; an old queued session cannot write into it', () => {
  const t = fixture(); t.params.finished = true; t.params.finishedAt = due;
  const out = invoke(guarded, request(t, { params: { resumeRequested: true, autoFinish: t.params.autoFinish } }));
  const timing = out.mongoUpdate.$set.params.autoFinish;
  assert.equal(timing.session, 2);
  assert.equal(Date.parse(timing.deadlineAt) - Date.parse(timing.resumedAt), 10800000);
  assert.equal(timing.reason, undefined);
  const reopened = { ...t, ...out.mongoUpdate.$set };
  assert.equal(invoke(guarded, request(reopened)).payload.error, 'TOURNAMENT_SESSION_CHANGED');
  assert.equal(invoke(guarded, request(reopened, { params: { autoFinish: t.params.autoFinish } })).payload.error, 'TOURNAMENT_SESSION_CHANGED');
});
test('monthly finalizer delegates managed sessions, including resumed tournaments', () => {
  assert.equal(planCommunityTournamentClose({ tournament: fixture(), publications: [], nowTs: now }).reason, 'AUTO_FINISH_OWNS_LIFECYCLE');
});
test('flow patch is focused, preserves graph, rejects disabled nodes and repeated installation', () => {
  const before = flow(), after = buildTournamentAutoFinish(before);
  assert.equal(after.filter((node, i) => node.func !== before[i].func).length, 3);
  const graph = nodes => nodes.map(node => Object.fromEntries(Object.entries(node).filter(([key]) => key !== "func")));
  assert.deepEqual(graph(after), graph(before));
  assert.throws(() => buildTournamentAutoFinish(after), /ALREADY_INSTALLED/);
  assert.throws(() => buildTournamentAutoFinish(before.map(n => n.type === 'tab' ? { ...n, disabled: true } : n)), /ACTIVE_TOURNAMENT/);
});
test('terminal late result conflicts require review, unlike transient CAS conflicts', () => {
  for (const error of ['TOURNAMENT_CLOSED', 'TOURNAMENT_DEADLINE_REACHED', 'TOURNAMENT_SESSION_CHANGED']) {
    assert.equal(tournamentResultNeedsReview({ status: 409, message: 'Synthetic', raw: { error } }), true);
  }
  assert.equal(tournamentResultNeedsReview({ status: 409, message: 'Synthetic', raw: { error: 'TOURNAMENT_PERSISTENCE_CONFLICT' } }), false);
  assert.equal(tournamentResultNeedsReview({ status: 503, message: 'Synthetic' }), false);
});
test('UI identifies automatic completion and displays the server deadline', () => {
  assert.match(tournamentAutoFinishNotice(fixture().params), /Автоматическое завершение/);
  assert.match(tournamentAutoFinishNotice({ autoFinish: { version: 1, reason: 'time_limit' } }), /завершён автоматически/);
  assert.equal(tournamentAutoFinishNotice({}), null);
});
function fprFixture() {
  let state = createFprState({ tournamentId: 'synthetic-fpr', players: fixture().participants.map((p, i) => ({ id: p.id, name: p.name, level: 3, leaguePoints: i, leaguePlace: i + 1 })),
    courts: ['Synthetic court'], leagueSource: 'Synthetic', now: start, endsAt: '2026-11-10T15:00:00.000Z', reserveAllowed: true });
  state = applyFprCommand(state, { action: 'start_round', id: 'synthetic-start', expectedRevision: 0 }, start);
  return { ...fixture(), tournamentId: state.tournamentId, tournamentType: 'fpr_6x25', ...fprProjection(state, fixture().params) };
}
test('FPR timeout uses its own finish reducer and never enables generic ratings', () => {
  const t = fprFixture(), plan = planTournamentAutoFinish(t, now, guarded);
  assert.equal(plan.close, true);
  assert.equal(plan.set['params.fpr6x25'].status, 'incomplete');
  assert.equal(plan.set['params.finished'], false);
  assert.equal(plan.set['params.fpr6x25'].attempts[0].status, 'cancelled');
  assert.equal(plan.set.rounds.length, 0);
});
test('FPR first actual round start arms timer; creating a ready protocol does not', () => {
  const t = fprFixture();
  const state = createFprState({ ...t.params.fpr6x25, now: start });
  t.params = { ...fprProjection(state, {}).params };
  const wrapped = buildAutoFinishNode(buildFprNodeFunction(source, 'recalculate'), 'write');
  const msg = invoke(wrapped, request(t, { params: { fprCommand: { action: 'start_round', id: 'first-round', expectedRevision: 0 } } }));
  assert.equal(msg.mongoUpdate.$set['params.autoFinish'].version, 1);
  const oldTiming = msg.mongoUpdate.$set['params.autoFinish'];
  assert.equal(Date.parse(oldTiming.deadlineAt) - Date.parse(oldTiming.startedAt), 180 * 60_000);
  assert.equal(oldTiming.durationMs, undefined);
});

test('new-policy FPR timer lasts 225 minutes, preserves old sessions and rejects mismatched deadlines', () => {
  const t = fprFixture();
  const state = createFprState({ ...t.params.fpr6x25, now: start });
  const baseEndsAt = state.endsAt;
  state.endsAt = new Date(Date.parse(baseEndsAt) + 45 * 60_000).toISOString();
  t.params = { ...fprProjection(state).params, fprDeadlinePolicy: { version: 1, extensionMinutes: 45, baseEndsAt } };
  const wrapped = buildAutoFinishNode(buildFprNodeFunction(source, 'recalculate'), 'write');
  const msg = invoke(wrapped, request(t, { params: { autoFinish: { durationMs: 999999999 }, fprCommand: { action: 'start_round', id: 'new-policy-start', expectedRevision: 0 } } }));
  const timing = msg.mongoUpdate.$set['params.autoFinish'];
  assert.equal(timing.durationMs, 225 * 60_000);
  assert.equal(Date.parse(timing.deadlineAt) - Date.parse(timing.startedAt), 225 * 60_000);
  const saved = structuredClone(t);
  saved.params.fpr6x25 = msg.mongoUpdate.$set['params.fpr6x25'];
  saved.params.autoFinish = timing;
  const threeHours = Date.parse(timing.startedAt) + 180 * 60_000;
  assert.equal(planTournamentAutoFinish(saved, threeHours, guarded).reason, 'NOT_DUE');
  assert.equal(planTournamentAutoFinish(saved, Date.parse(timing.deadlineAt) - 1, guarded).reason, 'NOT_DUE');
  const finish = planTournamentAutoFinish(saved, Date.parse(timing.deadlineAt), guarded);
  assert.equal(finish.close, true);
  assert.equal(finish.set['params.fpr6x25'].status, 'incomplete');
  assert.match(tournamentAutoFinishNotice({ ...saved.params, autoFinish: { ...timing, reason: 'time_limit' } }), /3 часа 45 минут/);
  for (const mutate of [
    x => { x.params.autoFinish.durationMs = 226 * 60_000; },
    x => { x.params.autoFinish.deadlineAt = new Date(Date.parse(timing.deadlineAt) + 1).toISOString(); },
    x => { delete x.params.fprDeadlinePolicy; },
    x => { x.params.fprDeadlinePolicy.extensionMinutes = 90; },
    x => { x.params.fprDeadlinePolicy.baseEndsAt = 'invalid'; },
    x => { x.params.fpr6x25.endsAt = baseEndsAt; },
  ]) {
    const invalid = structuredClone(saved); mutate(invalid);
    assert.equal(planTournamentAutoFinish(invalid, Date.parse(timing.deadlineAt), guarded).reason, 'INVALID_SERVER_DEADLINE');
  }
  const generic = fixture();
  generic.params.fprDeadlinePolicy = saved.params.fprDeadlinePolicy;
  assert.equal(planTournamentAutoFinish(generic, now, guarded).close, true, 'generic tournaments retain their 3-hour deadline');
});
test('dry run has no database writes; apply rejects missing writer guards', async () => {
  const t = fixture();
  const db = { collection() { return { find() { return { sort() { return this; }, batchSize() { return this; }, async *[Symbol.asyncIterator]() { yield t; } }; }, async countDocuments() { return 1; }, updateOne() { throw Error('unexpected write'); } }; } };
  const built = buildTournamentAutoFinish(flow());
  const result = await runTournamentAutoFinish({ db, flow: built, nowTs: now });
  assert.equal(result.outcomes[0].reason, 'DRY_RUN_CANDIDATE');
  await assert.rejects(runTournamentAutoFinish({ db, flow: flow(), nowTs: now, apply: true }), /WRITERS_NOT_INSTALLED/);
});

test('cursor reaches a valid tournament after more than one hundred skipped records', async () => {
  const t = fixture();
  const db = { collection() { return { find() { return { sort() { return this; }, batchSize() { return this; }, async *[Symbol.asyncIterator]() {
    for (let i = 0; i < 110; i++) yield { ...t, tournamentId: 'synthetic-skip-' + i };
    yield t;
  } }; }, async countDocuments(query) { return query.tournamentId === t.tournamentId ? 1 : 2; } }; } };
  const result = await runTournamentAutoFinish({ db, flow: buildTournamentAutoFinish(flow()), nowTs: now });
  assert.equal(result.outcomes.length, 111);
  assert.equal(result.outcomes.at(-1).reason, 'DRY_RUN_CANDIDATE');
});

test('late offline payload remains in storage and automatic queue stops sending it', async () => {
  const storage = new Map();
  const request = operation => {
    const req = {};
    queueMicrotask(() => { req.result = operation(); req.onsuccess?.(); });
    return req;
  };
  const store = {
    getAll: () => request(() => structuredClone([...storage.values()])),
    get: key => request(() => structuredClone(storage.get(key))),
    put: value => request(() => storage.set(value.jobId || value.tournamentId || value.key, structuredClone(value))),
    delete: key => request(() => storage.delete(key)),
  };
  const code = (await build({ entryPoints: ['src/utils/tournamentOfflineSync.ts'], bundle: true, write: false, format: 'iife', globalName: 'Offline',
    plugins: [{ name: 'synthetic-api', setup(build) {
      build.onResolve({ filter: /apiClient$/ }, () => ({ path: 'api', namespace: 'synthetic' }));
      build.onLoad({ filter: /.*/, namespace: 'synthetic' }, () => ({ contents: 'export async function apiUpdateAmericanoResults(payload) { globalThis.sent.push(payload); return globalThis.response; }' }));
    } }],
  })).outputFiles[0].text;
  const context = vm.createContext({ window: {}, navigator: { onLine: true }, queueMicrotask, structuredClone,
    indexedDB: { open: () => request(() => ({ transaction: () => ({ objectStore: () => store }), objectStoreNames: { contains: () => true } })) },
    sent: [], response: { data: null, status: 409, error: { status: 409, message: 'Synthetic closed', raw: { error: 'TOURNAMENT_CLOSED' } } },
  });
  new vm.Script(code).runInContext(context);
  const payload = { tournamentId: 'synthetic-queue', results: [{ roundId: 'r1', matchId: 'm1', score1: 12, score2: 9 }] };
  await context.Offline.submitTournamentResultsWithOfflineFallback(payload, { tournamentId: payload.tournamentId });
  assert.equal(storage.size, 1);
  const saved = [...storage.values()][0];
  assert.equal(saved.reviewRequired, true);
  assert.equal(JSON.stringify(saved.payload), JSON.stringify(payload));
  saved.nextAttemptAt = 0;
  storage.set(saved.jobId, saved);
  const before = context.sent.length;
  await context.Offline.processPendingTournamentResultSyncQueue({ forceTournamentId: payload.tournamentId });
  assert.equal(context.sent.length, before);
  assert.equal(storage.size, 1);
  const newSession = { ...payload, params: { autoFinish: { version: 1, session: 2 } } };
  await context.Offline.enqueuePendingTournamentResultSync(newSession, { tournamentId: payload.tournamentId });
  assert.equal(storage.size, 2);
  await context.Offline.clearPendingTournamentResultQueueByPayload(newSession, payload.tournamentId);
  assert.equal(storage.size, 1);
  assert.equal([...storage.values()][0].reviewRequired, true);
});

const uri = process.env.TOURNAMENT_AUTO_FINISH_TEST_MONGO_URI;
test('real Mongo: duplicate finalizers, stale score/create, resume, backup and readback', { skip: !uri }, async t => {
  const client = new MongoClient(uri); await client.connect();
  const db = client.db('tournament_auto_finish_test_' + Date.now());
  const backup = fs.mkdtempSync(path.join(os.tmpdir(), 'tournament-auto-finish-'));
  t.after(async () => { await db.dropDatabase(); await client.close(); fs.rmSync(backup, { recursive: true, force: true }); });
  const collection = db.collection('tournaments'), tournament = fixture();
  await collection.insertOne(tournament);
  const plan = planTournamentAutoFinish(tournament, now, guarded);
  const stale = invoke(guarded, { ...request(tournament), _tournamentAutoFinishInternal: true });
  const results = await Promise.all([1, 2].map(() => applyTournamentAutoFinish(collection, tournament, plan, backup)));
  assert.equal(results.filter(r => r.applied).length, 1);
  assert.equal((await collection.updateOne(stale.mongoQuery, stale.mongoUpdate)).matchedCount, 0);
  const saved = await collection.findOne({ _id: tournament._id });
  assert.equal(saved.params.finishedAt, due);
  assert.deepEqual(tournamentRoundFacts(saved.rounds), tournamentRoundFacts(tournament.rounds));
  assert.equal(fs.readdirSync(backup).length, 1);
  const prepare = buildAutoFinishNode(read('fn_tournament_prepare'), 'prepare');
  const create = invoke(prepare, { payload: { ...tournament, params: { autoFinish: { version: 1, deadlineAt: '2099-01-01' } } } })[0];
  const write = await collection.updateOne(create.payload[0], create.payload[1], { upsert: true });
  assert.equal(write.modifiedCount, 0);
  const fresh = invoke(prepare, { payload: { ...tournament, tournamentId: 'fresh-server-start', createdAt: '2000-01-01' } })[0];
  await collection.updateOne(fresh.payload[0], fresh.payload[1], { upsert: true });
  const inserted = await collection.findOne({ tournamentId: 'fresh-server-start' });
  assert.ok(Date.parse(inserted.params.autoFinish.startedAt) > Date.parse('2026-01-01'));
  assert.equal(Date.parse(inserted.params.autoFinish.deadlineAt) - Date.parse(inserted.params.autoFinish.startedAt), 10800000);
  // Score wins first: the previous finalizer must lose rather than delete the score.
  const other = fixture(); other._id = other.tournamentId = 'score-wins-first';
  await collection.insertOne(other);
  const stalePlan = planTournamentAutoFinish(other, now, guarded);
  await collection.updateOne({ _id: other._id }, { $set: { 'rounds.0.matches.1.score1': 10, 'rounds.0.matches.1.score2': 11 } });
  assert.equal((await applyTournamentAutoFinish(collection, other, stalePlan, backup)).reason, 'SOURCE_CHANGED');
  const reread = await collection.findOne({ _id: other._id });
  const newPlan = planTournamentAutoFinish(reread, now, guarded);
  assert.equal(newPlan.set.summary.completedMatches, 2);
});
