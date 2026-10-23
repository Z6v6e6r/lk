import assert from 'node:assert/strict';
import fs from 'node:fs';
import crypto from 'node:crypto';
import test from 'node:test';
import ts from 'typescript';
import { composeErrorCauseCandidate, ERROR_CAUSE_PREIMAGES } from '../prepare_lk_error_causes_candidate.mjs';

const sha = source => crypto.createHash('sha256').update(source).digest('hex');
const helperSource = fs.readFileSync('src/utils/tournamentRosterSearch.ts', 'utf8');
const exported = {};
new Function('exports', ts.transpileModule(helperSource, { compilerOptions: {
  module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022,
} }).outputText)(exported);
const { searchTournamentRosterPlayers, resolveTournamentRosterPhone, isStableTournamentClientId } = exported;
const id = n => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const phone = ['7', '999', '000', '00', '01'].join('');
const player = (n, fields = {}) => ({ id: id(n), name: `fixture member ${n}`, phone,
  photo: null, rating: null, ratingNumeric: null, ...fields });

test('roster search uses supplied stable identities only, bounded results and no network', () => {
  const roster = [player(1), player(1), player(2), player(3, { id: 'manual-participant-fixture' })];
  assert.deepEqual(searchTournamentRosterPlayers('member', roster).map(x => x.id), [id(1), id(2)]);
  assert.equal(searchTournamentRosterPlayers('member', roster, 1).length, 1);
  assert.deepEqual(searchTournamentRosterPlayers('outside', roster), []);
  assert.deepEqual(searchTournamentRosterPlayers('', roster), []);
  assert.equal(searchTournamentRosterPlayers(phone, roster).length, 2);
  const source = fs.readFileSync('src/utils/apiClient.ts', 'utf8');
  assert.doesNotMatch(source, /\/lk\/(?:games\/players|players|clients)\/search/);
});

test('manual sync needs exactly one real identity with an exact complete phone', () => {
  assert.equal(isStableTournamentClientId('player-local-1'), false);
  assert.equal(isStableTournamentClientId(id(1)), true);
  const page = fs.readFileSync('src/components/tournaments/TournamentsPage.tsx', 'utf8');
  assert.match(page, /if \(isStableTournamentClientId\(originalId\)\)/);
  assert.doesNotMatch(page, /isSyntheticParticipantId/);
  assert.equal(resolveTournamentRosterPhone(phone, [player(1), player(1)]).candidate.id, id(1));
  assert.equal(resolveTournamentRosterPhone(phone, [player(1), player(2)]).reason, 'ambiguous');
  assert.equal(resolveTournamentRosterPhone(phone.slice(-4), [player(1)]).reason, 'missing');
  assert.equal(resolveTournamentRosterPhone(phone, [player(1, { id: 'manual-participant-fixture' })]).reason, 'missing');
  assert.equal(resolveTournamentRosterPhone(phone, [player(1, { phone: phone.slice(0, -1) + '2' })]).candidate, null);
});

function fixture() {
  const flow = Object.keys(ERROR_CAUSE_PREIMAGES).map(id => ({ id, type: 'function', func: 'return msg;', outputs: 1, wires: [['response']] }));
  flow.find(n => n.id.endsWith('_router')).func = "if (ctx.step === 'groupExercise') {\nconst exercise = {};\nreturn msg;\n  ctx.exercise = exercise;\n}\nreturn msg;";
  flow.find(n => n.id === '9ec08e9a627fa3e2').func = 'const resolveCommunityLogoFields = () => null;\nconst normalizeCommunityForResponse = () => null;\nreturn msg;';
  flow.push({ id: 'auth_consent_userinfo_20260714', type: 'http request', method: 'use', ret: 'obj', url: '', wires: [['response']] },
    { id: 'lk_subscription_price_preview_20260908_http', type: 'http request', method: 'GET', ret: 'obj', url: '', wires: [['response']] },
    { id: 'response', type: 'http response', wires: [] },
    { id: 'route', type: 'http in', method: 'post', url: '/fixture', wires: [['auth_consent_prepare_20260714']] },
    { id: 'unrelated', type: 'function', func: 'return msg;', wires: [['response']] });
  return flow;
}
const pinsFor = flow => Object.fromEntries(flow.filter(n => ERROR_CAUSE_PREIMAGES[n.id]).map(n => [n.id, sha(n.func)]));
function compose(flow, pins = pinsFor(flow)) {
  const bytes = Buffer.from(JSON.stringify(flow));
  return composeErrorCauseCandidate(bytes, 'error-causes-synthetic', { expectedSourceSha256: sha(bytes), pins });
}

test('candidate changes only seven scoped nodes without mutating input, routes, wires or policy', () => {
  const source = fixture();
  const before = structuredClone(source);
  const packet = compose(source);
  assert.deepEqual(source, before);
  assert.equal(packet.changedNodeIds.length, 7);
  assert.deepEqual(packet.candidate.find(n => n.id === 'unrelated'), before.find(n => n.id === 'unrelated'));
  assert.equal(packet.candidate.find(n => n.id.endsWith('_http')).method, 'use');
  assert.equal(packet.candidate.find(n => n.id === 'auth_consent_userinfo_20260714').ret, 'txt');
  for (const n of source) assert.deepEqual(packet.candidate.find(c => c.id === n.id).wires, n.wires);
});

test('candidate refuses source digest, function, HTTP contract and node identity drift', () => {
  const source = fixture();
  const bytes = Buffer.from(JSON.stringify(source));
  assert.throws(() => composeErrorCauseCandidate(bytes, 'negative-test', { expectedSourceSha256: '0'.repeat(64) }), /preimage/);
  const changed = structuredClone(source);
  changed[0].func += '\n';
  assert.throws(() => compose(changed, pinsFor(source)), /Function preimage/);
  const method = structuredClone(source);
  method.find(n => n.id.endsWith('_http')).method = 'POST';
  assert.throws(() => compose(method), /HTTP preimage/);
  assert.throws(() => compose([...source, source[0]]), /Invalid source/);
});
