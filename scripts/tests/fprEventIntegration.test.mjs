import { ratingFixture } from "./helpers/fprRatingFixture.ts";
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { createRequire } from 'node:module';
import { build } from 'esbuild';
import { buildFprNodeFunction } from '../nodered_fpr6x25.mjs';
import { patchFprFlow, fprSha256 } from '../patch_live_fpr6x25.mjs';

const require = createRequire(import.meta.url);
const output = await build({ stdin: { contents: `export * from './src/components/tournaments/fpr6x25'; export * from './src/utils/tournamentEventIdentity'; export * from './src/utils/tournamentDraftExercise'; export { buildResultRows } from './src/components/cabinet/TournamentDetailsModal'; export {normalizeTournamentHistoryRecord} from './src/utils/apiClient';`, resolveDir: process.cwd() },
  bundle: true, write: false, format: 'cjs', platform: 'node', jsx: 'automatic', define: { 'import.meta.env': '{}' }, external: ['react', 'react/jsx-runtime', 'react-dom'], loader: { '.css': 'empty' }, logLevel: 'silent',
  plugins: [{ name: 'expose-real-result-mapper', setup(b) { b.onLoad({ filter: /utils\/apiClient\.ts$/ }, args => ({ contents: fs.readFileSync(args.path, 'utf8') + '\nexport { normalizeTournamentHistoryRecord };', loader: 'ts' })); b.onLoad({ filter: /cabinet\/TournamentDetailsModal\.tsx$/ }, args => ({ contents: fs.readFileSync(args.path, 'utf8') + '\nexport { buildResultRows };', loader: 'tsx' })); } }],
});
const mod = { exports: {} };
new Function('require', 'module', 'exports', output.outputFiles[0].text)(require, mod, mod.exports);
const { createFprState, fprProjection, fprStandings, applyFprCommand, buildResultRows, normalizeTournamentHistoryRecord, tournamentEventId, tournamentIdentityKeys, buildTournamentDraftExercise } = mod.exports;
const start = '2026-11-03T09:00:00Z';
const end = '2026-11-03T11:00:00Z';
const sourceId = '11111111-2222-4333-8444-555555555555';
export function fixture(id = sourceId) {
  const state = createFprState({ tournamentId: id, players: Array.from({ length: 8 }, (_, i) => ({ id: `p${i}`, name: `Player ${i}`, level: 3, leaguePlace: i + 1, leaguePoints: i })), courts: ['Court 1', 'Court 2'], leagueSource: 'Synthetic', now: start, endsAt: end, reserveAllowed: true,
    communityRating: { policy: 'community-tournament-v1', communityId: 'community', communityName: 'Synthetic', period: 'all', snapshotUpdatedAt: null, sourceExerciseId: sourceId, publicationId: null } });
  return { tournamentId: id, tournamentType: 'fpr_6x25', tenantKey: 'synthetic', organizer: { id: 'organizer' }, createdAt: start, participants: state.players, courts: state.courts, ...fprProjection(state, { sourceExerciseId: sourceId, localDateKey: '2026-11-03', stationName: 'Synthetic' }) };
}

function act(doc, action, now = start) {
  const state = applyFprCommand(doc.params.fpr6x25, { ...action, id: `command-${doc.params.fpr6x25.revision}`, expectedRevision: doc.params.fpr6x25.revision }, now);
  return { ...doc, ...fprProjection(state, doc.params) };
}

test('one original event identity for new and legacy FPR; drafts merge under event ID', () => {
  for (const id of [sourceId, 'fpr-11111111-2222-4333-8444-555555555555']) {
    const doc = fixture(id);
    assert.equal(tournamentEventId(doc), sourceId);
    assert.deepEqual(tournamentIdentityKeys(doc), [...new Set([id, sourceId])]);
    const exercise = buildTournamentDraftExercise({ payload: doc, updatedAt: start, totals: null, playerLogs: null });
    assert.equal(exercise.id, sourceId);
  }
  assert.equal(tournamentEventId({ tournamentId: 'mexicano', tournamentType: 'mexicano', params: { sourceExerciseId: 'other' } }), 'mexicano');
});

test('actual LK mapper shows canonical FPR results despite empty totals and preserves ranks/DNF', () => {
  let doc = fixture();
  for (let round = 0; round < 6; round++) for (const match of [...doc.params.fpr6x25.attempts.at(-1).matches]) {
    doc = act(doc, { action: 'score', matchId: match.id, score1: round % 2 ? 20 : 10, score2: round % 2 ? 5 : 15, confirmed1: true, confirmed2: true, startIfScheduled: true, autoCloseRound: true, recordResult: true });
  }
  doc = act(doc, { action: 'withdraw', playerId: 'p0', reason: 'Synthetic withdrawal' });
  doc = act(doc, { action: 'finish' });
  const rows = buildResultRows(doc, []);
  const canonical = fprStandings(doc.params.fpr6x25);
  assert.equal(rows.length, 8);
  assert.deepEqual(rows.map(r => [r.key, r.rank, r.wins, r.pointsFor, r.pointsAgainst]), canonical.map(r => [r.id, r.rank, r.wins, r.pointsFor, r.pointsAgainst]));
  assert.ok(rows.every(r => r.delta === null));
  assert.equal(rows.find(r => r.key === 'p0').rank, null);
  assert.equal(buildTournamentDraftExercise({ payload: doc, updatedAt: start, totals: null, playerLogs: null }).status, 'COMPLETED');
  const ordinary = buildResultRows({ tournamentType: 'mexicano', totals: {}, standings: [{ id: 'x', name: 'Synthetic', wins: 1, pointsFor: 20, pointsAgainst: 5 }] }, []);
  assert.equal(ordinary.length, 1);
});

test('late score entry records server time without manual times/reason; no next draw after deadline', () => {
  let doc = fixture();
  const matches = [...doc.params.fpr6x25.attempts[0].matches];
  for (const match of matches) doc = act(doc, { action: 'score', matchId: match.id, score1: 13, score2: 12, confirmed1: true, confirmed2: true, startIfScheduled: true, autoCloseRound: true, recordResult: true }, '2026-11-03T11:05:00Z');
  assert.equal(doc.params.fpr6x25.attempts.length, 1);
  const round = doc.params.fpr6x25.attempts[0];
  assert.equal(round.status, 'closed');
  assert.throws(() => act(doc, { action: 'prepare_round' }, '2026-11-03T11:05:00Z'), /Время для нового раунда/);
  assert.ok(round.matches.every(m => m.recordedAt === '2026-11-03T11:05:00Z' && m.completedAt === m.recordedAt && !m.lateEntryReason));
});

test('reserve round admitted with remaining time can be saved after threshold changes without explanation', () => {
  let doc = fixture();
  for (let round = 0; round < 6; round++) for (const match of [...doc.params.fpr6x25.attempts.at(-1).matches]) doc = act(doc, { action: 'score', matchId: match.id, score1: 13, score2: 12, confirmed1: true, confirmed2: true, startIfScheduled: true, autoCloseRound: true, recordResult: true });
  assert.equal(doc.params.fpr6x25.attempts.at(-1).round, 7);
  for (const match of [...doc.params.fpr6x25.attempts.at(-1).matches]) doc = act(doc, { action: 'score', matchId: match.id, score1: 13, score2: 12, confirmed1: true, confirmed2: true, startIfScheduled: true, autoCloseRound: true, recordResult: true }, '2026-11-03T10:56:00Z');
  assert.equal(doc.params.fpr6x25.attempts.at(-1).status, 'closed');
  assert.equal(doc.params.fpr6x25.attempts.length, 7);
});

const communityLegacy = fs.readFileSync('scripts/nodered_tournament_community_nodes/fn_tournament_community_publications_query.js', 'utf8');
const queryCommunity = new Function('msg', buildFprNodeFunction(communityLegacy, 'community_context'));
const finalResponse = new Function('msg', buildFprNodeFunction('return msg;', 'history_response'));
test('source event GET finds old protocol, queries source publications, and fails closed on ambiguous results', () => {
  const legacy = fixture('fpr-11111111-2222-4333-8444-555555555555');
  const msg = queryCommunity({ payload: [legacy], req: { query: { tournamentId: sourceId } } });
  assert.equal(msg._tournamentCommunityContext.sourceRows[0].tournamentId, legacy.tournamentId);
  assert.ok(msg.payload.$or.some(q => q.relatedTournamentId === sourceId));
  for (const rows of [[legacy, fixture()], [legacy, { tournamentId: sourceId, tournamentType: 'mexicano' }]]) {
    const out = queryCommunity({ payload: rows, req: { query: { tournamentId: sourceId } }, _tournamentHistoryCacheKey: `id:${sourceId}` });
    out.payload = [];
    const response = finalResponse(out);
    assert.equal(response.statusCode, 409);
    assert.equal(response.payload.error, 'TOURNAMENT_EVENT_AMBIGUOUS');
    assert.equal(response._tournamentHistoryCacheKey, undefined);
  }
});

test('guarded query patch keeps all nodes/wires and rejects drift', () => {
  const node = { id: 'query', type: 'change', name: 'History by tournamentId', rules: [{ t: 'set', p: 'payload', pt: 'msg', to: '{ "tournamentId": $$.req.query.tournamentId }', tot: 'jsonata' }], wires: [['mongo']] };
  const bytes = Buffer.from(JSON.stringify([node, { id: 'mongo', type: 'mongodb4' }]));
  const contract = { flowSha256: fprSha256(bytes), nodes: [{ id: node.id, name: node.name, kind: 'history_query', sha256: fprSha256(JSON.stringify(node.rules)) }] };
  const changed = JSON.parse(patchFprFlow(bytes, contract).output);
  assert.ok(changed[0].rules[0].to.includes('params.fpr6x25.communityRating.sourceExerciseId'));
  assert.deepEqual(changed[0].wires, node.wires);
  assert.deepEqual(changed[1], { id: 'mongo', type: 'mongodb4' });
  assert.throws(() => patchFprFlow(bytes, { ...contract, nodes: [{ ...contract.nodes[0], sha256: '0'.repeat(64) }] }), /preimage/);
});

test('results dispatch rejects both ambiguous orders and a command aimed at another mechanic before generic writes', () => {
  const fpr = fixture();
  const generic = { tournamentId: sourceId, tournamentType: 'mexicano' };
  const recalculate = new Function('msg', buildFprNodeFunction('msg.mongoUpdate = { forbidden: true }; return msg;', 'recalculate'));
  for (const payload of [[fpr, generic], [generic, fpr], [generic], []]) {
    const result = recalculate({ payload, req: { body: { params: { fprCommand: { action: 'finish' } } } } });
    assert.equal(result.statusCode, 409);
    assert.equal(result.mongoUpdate, undefined);
  }
});

test('conflicting root/nested source identity cannot open results through either event', () => {
  const doc = fixture('fpr-11111111-2222-4333-8444-555555555555');
  doc.params.sourceExerciseId = 'different-source';
  for (const id of [sourceId, 'different-source', doc.tournamentId]) {
    const prepared = queryCommunity({ payload: [doc], req: { query: { tournamentId: id } } });
    assert.equal(finalResponse(prepared).statusCode, 409);
  }
});


test('client history keeps exact server FPR level results and never substitutes current participant levels', () => {
  const state = ratingFixture(4, 6);
  const levels = { version: 1, protocolId: state.tournamentId, protocolRevision: state.revision,
    sourceEventId: state.communityRating.sourceExerciseId, calculatedAt: '2026-11-05T12:00:00Z', rootExcludedPlayerIds: [],
    rows: state.players.map((p, i) => ({ id: p.id, status: 'applied', before: 2, after: i === 0 ? 2 : i === 1 ? 2.00001 : 1.99999,
      delta: i === 0 ? 0 : i === 1 ? 0.00001 : -0.00001 })) };
  const doc = { tournamentId: state.tournamentId, tournamentType: 'fpr_6x25', ...fprProjection(state), fprLevelResults: levels };
  const normalized = normalizeTournamentHistoryRecord(doc);
  assert.deepEqual(normalized.fprLevelResults, levels);
  const rootOnly = { ...doc, params: { ...doc.params, sourceExerciseId: 'root-only-physical', fpr6x25: { ...state, communityRating: { ...state.communityRating, sourceExerciseId: null } } }, fprLevelResults: { ...levels, sourceEventId: 'root-only-physical' } };
  assert.ok(normalizeTournamentHistoryRecord(rootOnly).fprLevelResults);
  assert.equal(buildResultRows(normalizeTournamentHistoryRecord(rootOnly), []).find(r => r.key === 'p1').delta, 0.00001);
  const current = state.players.map(p => ({ key: p.id, clientId: p.id, name: p.name, rating: '6.9', ratingNumeric: 6.9, photo: null }));
  const rows = buildResultRows(normalized, current);
  assert.equal(rows.find(r => r.key === 'p0').delta, 0);
  assert.equal(rows.find(r => r.key === 'p1').delta, 0.00001);
  assert.equal(rows.find(r => r.key === 'p2').delta, -0.00001);
  assert.equal(rows.find(r => r.key === 'p1').levelResult.after, 2.00001);
  assert.deepEqual(rows.map(r => [r.key, r.rank]), fprStandings(state).map(r => [r.id, r.rank]));
  const stale = normalizeTournamentHistoryRecord({ ...doc, fprLevelResults: { ...levels, protocolRevision: state.revision - 1 } });
  assert.equal(stale.fprLevelResults, null);
  assert.ok(buildResultRows(stale, current).every(r => r.delta === null));
  const excluded = normalizeTournamentHistoryRecord({ ...doc, ratingExclusions: [{ playerId: 'p0', scopes: ['level'], auditId: 'synthetic', reason: 'private', recordedAt: '2026-11-05T12:00:00Z' }] });
  assert.deepEqual(excluded.fprLevelExcludedPlayerIds, ['p0']);
  assert.equal(excluded.fprLevelResults, null);
  const attach = new Function('msg', fs.readFileSync('scripts/nodered_tournament_community_nodes/fn_tournament_community_publications_attach.js', 'utf8'));
  assert.deepEqual(attach({ payload: [], _tournamentCommunityContext: { tournamentId: state.communityRating.sourceExerciseId, sourceRows: [doc] } }).payload[0].fprLevelResults, levels);
});
