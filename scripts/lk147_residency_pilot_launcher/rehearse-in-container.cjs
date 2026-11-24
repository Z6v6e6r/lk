'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { createHash } = require('node:crypto');
const { spawnSync } = require('node:child_process');

assert(process.env.LK487_ISOLATED_FIXTURE === '1' && fs.existsSync('/.dockerenv') && process.getuid() === 0,
  'Run only in the disposable fixture container');

const live = '/opt/padlhub/lk147-node-red-launcher';
const control = '/etc/phab-traffic/lk-residency-preview-487/mode';
const graph = '/root/.node-red/flows.json';
const retained = ['/etc/phab-traffic/subscriptions-residency-node-red.env',
  '/etc/phab-traffic/subscriptions-residency-node-red-flags.env'];
const credential = '/etc/padlhub/lk147-tournament-owner/integration.token';
const selector = live + '/select-profile.cjs';
const launcher = live + '/start-node-red.sh';
const pilotEnv = live + '/residency-preview.env';
const policy = live + '/profiles.json';
const stub = '/usr/local/bin/node-red';
const hash = input => createHash('sha256').update(input).digest('hex');
for (const directory of new Set([live, path.dirname(control), path.dirname(graph), path.dirname(retained[0]), path.dirname(credential)])) {
  fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
}
function write(file, content) {
  fs.writeFileSync(file, content, { mode: 0o600 });
  fs.chmodSync(file, 0o600);
}
fs.copyFileSync('/fixture/select-profile.cjs', selector);
fs.copyFileSync('/fixture/start-node-red.sh', launcher);
fs.chmodSync(selector, 0o600);
fs.chmodSync(launcher, 0o700);
assert(!fs.existsSync(stub), 'Fixture must use an image without an installed Node-RED');
function probe() {
  const fs = require('node:fs');
  const env = process.env;
  process.stdout.write(JSON.stringify({
    retained: env.RETAINED_FIRST + ':' + env.RETAINED_SECOND,
    tournamentRecoveryOnly: env.TOURNAMENT_OWNER_RECOVERY_ONLY ?? null,
    tournamentOwner: env.TOURNAMENT_OWNER_INTEGRATION_TOKEN === 'fixture-tournament-token' &&
      env.TOURNAMENT_OWNER_API_BASE === 'https://padlhub.su/api',
    cup: env.CUP_API_BASE_URL,
    pilot: env.LK_RESIDENCY_LIFECYCLE_PREVIEW_ONLY ?? null,
    create: env.LK_RESIDENCY_LIFECYCLE_CREATE_ENABLED ?? null,
    control: env.LK_RESIDENCY_LIFECYCLE_PILOT_CONTROL_FILE
      ? fs.readFileSync(env.LK_RESIDENCY_LIFECYCLE_PILOT_CONTROL_FILE, 'utf8').trim() : null,
  }));
}
write(stub, '(' + probe.toString() + ')();\n');
const oldEnv = ['RETAINED_FIRST=one\n', 'RETAINED_SECOND=two\n'];
retained.forEach((file, index) => write(file, oldEnv[index]));
write(control, 'off\n');
write(credential, 'fixture-tournament-token\n');
const graphs = Object.fromEntries(['source', 'candidate', 'pilot', 'successor', 'quote', 'kids-booking'].map(name =>
  [name, JSON.stringify([{ id: name, type: 'tab' }]) + '\n']));
const selectGraph = name => write(graph, graphs[name] ?? '[]\n');
const env = {
  LK_RESIDENCY_LIFECYCLE_ENABLED: 'true',
  LK_RESIDENCY_LIFECYCLE_PREVIEW_ONLY: 'true',
  LK_RESIDENCY_LIFECYCLE_CREATE_ENABLED: 'false',
  LK_RESIDENCY_LIFECYCLE_CREATE_AUDIENCE: 'pilot',
  LK_RESIDENCY_LIFECYCLE_PILOT_USERS: '["iSkq6G:fixture-owner"]',
  LK_RESIDENCY_LIFECYCLE_IDENTITY_LOG: 'false',
  LK_RESIDENCY_LIFECYCLE_ENSURE_INDEXES: 'false',
  LK_RESIDENCY_LIFECYCLE_MONGO_URI: 'mongodb://127.0.0.1:27017/games',
  LK_RESIDENCY_LIFECYCLE_MONGO_DB: 'games',
  LK_RESIDENCY_LIFECYCLE_CUP_API_URL: 'https://padlhub.su/api',
  LK_RESIDENCY_LIFECYCLE_CUP_INTEGRATION_TOKEN: 'fixture-only-000000000000000000000000',
  LK_RESIDENCY_LIFECYCLE_ALLOW_ORIGIN: 'https://padlhub.ru',
  LK_RESIDENCY_LIFECYCLE_PILOT_CONTROL_FILE: control,
};
const encode = values => Object.entries(values).map(([key, value]) => key + "='" + value + "'\n").join('');
const v2 = { schema: 2, sourceSha256: hash(graphs.source), candidateSha256: hash(graphs.candidate), retainedEnvSha256: oldEnv.map(hash) };
const v3 = { ...v2, schema: 3, pilotSha256: hash(graphs.pilot), pilotEnvSha256: hash(encode(env)) };
const v4 = { ...v3, schema: 4, pilotSuccessorSha256: hash(graphs.successor) };
const v5 = { ...v4, schema: 5, pilotQuoteSha256: hash(graphs.quote) };
const v6 = { ...v5, schema: 6, pilotKidsBookingSha256: hash(graphs['kids-booking']) };
const ra497Sha256 = '83b9182d12e206a05051d2c666743cbdb8c6f6bfdd48e946bed72a4fa6eaaa08';
const raPacket = process.argv[2];
if (raPacket) {
  const reviewed = fs.readFileSync(raPacket);
  assert.equal(hash(reviewed), ra497Sha256, 'RA release graph does not match the reviewed bytes');
  graphs.ra497 = reviewed;
}
const v7 = { ...v6, schema: 7, pilotRa497Sha256: ra497Sha256 };
const genderRetrySha256 = '6812c12a5d51fa51713a9b368353dd2ab5afe2110889c3fa9a8e0c82dd4d6da7';
const retryPacket = process.argv[3];
if (retryPacket) {
  const reviewed = fs.readFileSync(retryPacket);
  assert.equal(hash(reviewed), genderRetrySha256, 'LK1 retry graph does not match the reviewed bytes');
  graphs.genderRetry = reviewed;
}
const v8 = { ...v7, schema: 8, genderRetrySha256 };
const manifest = value => write(policy, JSON.stringify(value) + '\n');
const run = (file, args = [], extraEnv = {}) => spawnSync(file, args, {
  encoding: 'utf8', env: { ...process.env, ...extraEnv }, timeout: 12000,
});
const rawSelect = (command = 'select', extraEnv = {}) => run('/usr/local/bin/node', [selector, command], extraEnv);
function expectRefusal(result, code) {
  assert.equal(result.status, 78);
  assert.equal(result.stdout, '');
  assert.match(result.stderr, new RegExp(code + '\\n$'));
}
function checkLaunch(name, tournamentOwner, pilot, profile = name, controlMode = 'off') {
  selectGraph(name);
  assert.equal(rawSelect().stdout, profile);
  const result = run(launcher, [], { TOURNAMENT_OWNER_RECOVERY_ONLY: 'true' });
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(JSON.parse(result.stdout), {
    retained: 'one:two',
    tournamentRecoveryOnly: name === 'candidate' ? 'true' : null,
    tournamentOwner,
    cup: 'http://127.0.0.1:3000/api',
    pilot: pilot ? 'true' : null, create: pilot ? 'false' : null, control: pilot ? controlMode : null,
  });
}
manifest(v2);
checkLaunch('source', false, false);
checkLaunch('candidate', true, false);
selectGraph('pilot');
expectRefusal(rawSelect(), 'UNREVIEWED_GRAPH_SHA');
manifest(v3);
write(pilotEnv, encode(env));
checkLaunch('source', false, false);
expectRefusal(rawSelect('read-pilot-token'), 'INVOCATION_INVALID');
expectRefusal(rawSelect('read-candidate-token'), 'INVOCATION_INVALID');
checkLaunch('candidate', true, false);
expectRefusal(rawSelect('read-pilot-token'), 'INVOCATION_INVALID');
checkLaunch('pilot', true, true);
expectRefusal(rawSelect('read-candidate-token'), 'INVOCATION_INVALID');
expectRefusal(rawSelect('select', { LK_RESIDENCY_LIFECYCLE_CREATE_ENABLED: 'true' }), 'PILOT_ENV_INHERITED_OVERRIDE');
expectRefusal(run(launcher, ['unexpected']), 'unexpected arguments\\.');
for (const extra of [
  { LK_RESIDENCY_LIFECYCLE_CREATE_ENABLED: 'true' },
  { LK_RESIDENCY_LIFECYCLE_PILOT_USERS: '["iSkq6G:one","iSkq6G:two"]' },
  { NODE_OPTIONS: '--trace-warnings' },
]) {
  const bytes = encode({ ...env, ...extra });
  write(pilotEnv, bytes);
  manifest({ ...v3, pilotEnvSha256: hash(bytes) });
  selectGraph('pilot');
  expectRefusal(rawSelect(), 'PILOT_ENV_CONTRACT_INVALID');
  checkLaunch('candidate', true, false);
}
manifest(v3);
write(pilotEnv, '# drift\n' + encode(env));
selectGraph('pilot');
expectRefusal(rawSelect(), 'PILOT_ENV_HASH_MISMATCH');
checkLaunch('source', false, false);
fs.unlinkSync(pilotEnv);
selectGraph('pilot');
expectRefusal(rawSelect(), 'INPUT_UNAVAILABLE');
checkLaunch('candidate', true, false);
write(pilotEnv, encode(env));
fs.chmodSync(pilotEnv, 0o644);
selectGraph('pilot');
expectRefusal(rawSelect(), 'FILE_NOT_PROTECTED');
fs.chmodSync(pilotEnv, 0o600);
fs.renameSync(pilotEnv, pilotEnv + '.fixture');
fs.symlinkSync(pilotEnv + '.fixture', pilotEnv);
expectRefusal(rawSelect(), 'INPUT_UNAVAILABLE');
fs.unlinkSync(pilotEnv);
fs.renameSync(pilotEnv + '.fixture', pilotEnv);
selectGraph('unknown');
expectRefusal(rawSelect(), 'UNREVIEWED_GRAPH_SHA');
selectGraph('successor');
expectRefusal(rawSelect(), 'UNREVIEWED_GRAPH_SHA');
manifest(v4);
for (const name of Object.keys(graphs)) {
  selectGraph(name);
  write(retained[0], 'RETAINED_FIRST=unapproved\n');
  expectRefusal(rawSelect(), 'RETAINED_ENV_HASH_MISMATCH');
  write(retained[0], oldEnv[0]);
}
checkLaunch('pilot', true, true);
checkLaunch('candidate', true, false);
checkLaunch('source', false, false);
write(control, 'preview\n');
checkLaunch('pilot', true, true, 'pilot', 'preview');
checkLaunch('successor', true, true, 'pilot', 'preview');
expectRefusal(rawSelect('read-candidate-token'), 'INVOCATION_INVALID');
expectRefusal(rawSelect('select', { LK_RESIDENCY_LIFECYCLE_CREATE_ENABLED: 'true' }), 'PILOT_ENV_INHERITED_OVERRIDE');
write(pilotEnv, '# drift\n' + encode(env));
expectRefusal(rawSelect(), 'PILOT_ENV_HASH_MISMATCH');
write(pilotEnv, encode(env));
for (const invalid of [
  v3, { ...v4, pilotSuccessorSha256: undefined }, { ...v4, pilotSuccessorSha256: [v4.pilotSuccessorSha256] },
  { ...v4, pilotSuccessorSha256: v4.pilotSuccessorSha256.toUpperCase() },
  { ...v4, pilotSuccessorSha256: v4.sourceSha256 }, { ...v4, pilotSuccessorSha256: v4.candidateSha256 },
  { ...v4, pilotSuccessorSha256: v4.pilotSha256 }, { ...v4, secondSuccessorSha256: hash('unknown') },
]) {
  manifest(invalid);
  expectRefusal(rawSelect(), invalid === v3 ? 'UNREVIEWED_GRAPH_SHA' : 'PROFILES_INVALID');
}
manifest(v4);
selectGraph('unknown');
expectRefusal(rawSelect(), 'UNREVIEWED_GRAPH_SHA');
selectGraph('quote');
expectRefusal(rawSelect(), 'UNREVIEWED_GRAPH_SHA');
manifest(v5);
checkLaunch('source', false, false);
checkLaunch('candidate', true, false);
for (const name of ['pilot', 'successor', 'quote']) checkLaunch(name, true, true, 'pilot', 'preview');
expectRefusal(rawSelect('read-candidate-token'), 'INVOCATION_INVALID');
expectRefusal(rawSelect('select', { LK_RESIDENCY_LIFECYCLE_CREATE_ENABLED: 'true' }), 'PILOT_ENV_INHERITED_OVERRIDE');
write(pilotEnv, '# drift\n' + encode(env));
expectRefusal(rawSelect(), 'PILOT_ENV_HASH_MISMATCH');
write(pilotEnv, encode(env));
write(retained[0], 'RETAINED_FIRST=unapproved\n');
expectRefusal(rawSelect(), 'RETAINED_ENV_HASH_MISMATCH');
write(retained[0], oldEnv[0]);
for (const value of [undefined, [v5.pilotQuoteSha256], v5.pilotQuoteSha256.toUpperCase(),
  v5.sourceSha256, v5.candidateSha256, v5.pilotSha256, v5.pilotSuccessorSha256]) {
  manifest({ ...v5, pilotQuoteSha256: value });
  expectRefusal(rawSelect(), 'PROFILES_INVALID');
}
manifest({ ...v5, extraSha256: hash('unreviewed') });
expectRefusal(rawSelect(), 'PROFILES_INVALID');
manifest(v5);
selectGraph('unknown');
expectRefusal(rawSelect(), 'UNREVIEWED_GRAPH_SHA');
manifest(v4);
checkLaunch('successor', true, true, 'pilot', 'preview');
manifest(v5);
selectGraph('kids-booking');
expectRefusal(rawSelect(), 'UNREVIEWED_GRAPH_SHA');
manifest(v6);
checkLaunch('source', false, false);
checkLaunch('candidate', true, false);
for (const name of ['pilot', 'successor', 'quote', 'kids-booking']) {
  checkLaunch(name, true, true, 'pilot', 'preview');
}
expectRefusal(rawSelect('read-candidate-token'), 'INVOCATION_INVALID');
expectRefusal(rawSelect('select', { LK_RESIDENCY_LIFECYCLE_CREATE_ENABLED: 'true' }), 'PILOT_ENV_INHERITED_OVERRIDE');
write(pilotEnv, '# drift\n' + encode(env));
expectRefusal(rawSelect(), 'PILOT_ENV_HASH_MISMATCH');
write(pilotEnv, encode(env));
for (const value of [undefined, [v6.pilotKidsBookingSha256], v6.pilotKidsBookingSha256.toUpperCase(),
  v6.sourceSha256, v6.candidateSha256, v6.pilotSha256, v6.pilotSuccessorSha256, v6.pilotQuoteSha256]) {
  manifest({ ...v6, pilotKidsBookingSha256: value });
  expectRefusal(rawSelect(), 'PROFILES_INVALID');
}
manifest({ ...v6, extraSha256: hash('unreviewed') });
expectRefusal(rawSelect(), 'PROFILES_INVALID');
manifest(v6);
selectGraph('unknown');
expectRefusal(rawSelect(), 'UNREVIEWED_GRAPH_SHA');
manifest(v5);
checkLaunch('successor', true, true, 'pilot', 'preview');
console.log('PASS: all retained launcher profiles, exact kids booking graph, rollback and fail-closed guards');


manifest(v7);
checkLaunch('source', false, false);
checkLaunch('candidate', true, false);
for (const name of ['pilot', 'successor', 'quote', 'kids-booking']) {
  checkLaunch(name, true, true, 'pilot', 'preview');
}
selectGraph('unknown');
expectRefusal(rawSelect(), 'UNREVIEWED_GRAPH_SHA');
for (const value of [undefined, hash('arbitrary reviewed-looking graph'), v6.pilotKidsBookingSha256, [ra497Sha256]]) {
  manifest({ ...v7, pilotRa497Sha256: value });
  expectRefusal(rawSelect(), 'PROFILES_INVALID');
}
manifest({ ...v7, pilotKidsBookingSha256: ra497Sha256 });
expectRefusal(rawSelect(), 'PROFILES_INVALID');
manifest({ ...v7, extraSha256: hash('unreviewed') });
expectRefusal(rawSelect(), 'PROFILES_INVALID');
if (raPacket) {
  manifest(v6);
  selectGraph('ra497');
  expectRefusal(rawSelect(), 'UNREVIEWED_GRAPH_SHA');
  manifest(v7);
  checkLaunch('ra497', true, true, 'pilot', 'preview');
  expectRefusal(rawSelect('read-candidate-token'), 'INVOCATION_INVALID');
  expectRefusal(rawSelect('select', { LK_RESIDENCY_LIFECYCLE_CREATE_ENABLED: 'true' }), 'PILOT_ENV_INHERITED_OVERRIDE');
}
manifest(v6);
checkLaunch('kids-booking', true, true, 'pilot', 'preview');
console.log('PASS: exact RA approval, retained profiles, unrelated graph refusal, and schema 6 rollback');

manifest(v8);
for (const name of ['pilot', 'successor', 'quote', 'kids-booking']) {
  checkLaunch(name, true, true, 'pilot', 'preview');
}
if (raPacket) checkLaunch('ra497', true, true, 'pilot', 'preview');
selectGraph('unknown');
expectRefusal(rawSelect(), 'UNREVIEWED_GRAPH_SHA');
for (const value of [undefined, hash('arbitrary graph'), ra497Sha256]) {
  manifest({ ...v8, genderRetrySha256: value });
  expectRefusal(rawSelect(), 'PROFILES_INVALID');
}
if (retryPacket) {
  manifest(v7);
  selectGraph('genderRetry');
  expectRefusal(rawSelect(), 'UNREVIEWED_GRAPH_SHA');
  manifest(v8);
  checkLaunch('genderRetry', true, true, 'pilot', 'preview');
}
console.log('PASS: exact LK1 retry hash, previous admitted graphs, and rejection of unrelated graphs');
