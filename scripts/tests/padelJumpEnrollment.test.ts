import test, { mock } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, readdirSync, readFileSync, mkdirSync, chmodSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createIdentityVerifier } from '../../games/padel-jump/live/identity.mjs';
import { createEnrollment } from '../../games/padel-jump/live/enrollment.mjs';
import { createLiveServer } from '../../games/padel-jump/live/server.mjs';
import { normalizeEnrollment } from '../../src/components/padel-jump/enrollment-form.ts';

const communityId = 'fixture-community';
const email = ['entry', 'example.invalid'].join('@');
const form = { firstName: 'Анкета', lastName: 'Участника', email, companyWebsite: 'company.example.invalid', consent: true };
const req = (id = 'fixture-a') => ({ headers: { authorization: 'Bearer ' + id } });
function harness(directory: string, { initial = false, joinWorks = true, role = 'MEMBER', profileFails = false, rosterFails = false, banned = false, pending = false, incomplete = false, delayed = false } = {}) {
  type FixtureJoinBody = { inviteCode: string; member: { id: string; name: string; role: string } };
  const members = new Set<string>(initial ? ['fixture-a'] : []), calls: Array<{ url: string; body: FixtureJoinBody | null }> = [];
  let joins = 0, concurrent = 0, maximum = 0;
  const fetcher = async (url: string, options: { headers: Record<string, string>; body?: string }) => {
    const id = options.headers.Authorization.slice(7), body = options.body ? JSON.parse(options.body) : null;
    calls.push({ url: String(url), body });
    if (String(url).includes('vivacrm')) return new Response(JSON.stringify({ id, firstName: 'Проверенный', lastName: 'Профиль', email: null }), { status: profileFails ? 503 : 200 });
    if (String(url).endsWith('join-by-invite')) {
      joins++; concurrent++; maximum = Math.max(maximum, concurrent);
      if (delayed) await new Promise(resolve => setTimeout(resolve, 5));
      if (joinWorks) members.add(id);
      concurrent--;
      return new Response(JSON.stringify({ ok: true, membershipStatus: 'ACTIVE', privateUpstreamRoster: [email] }));
    }
    return new Response(JSON.stringify({ id: communityId, name: 'Тестовое сообщество', inviteCode: 'fixture-invite', joinRule: 'INSTANT', membersLoaded: !incomplete,
      members: [...members].map(id => ({ id, name: 'Проверенный Профиль', status: 'ACTIVE', role })), bannedMembers: banned ? [{ id }] : [], pendingMembers: pending ? [{ id }] : [] }), { status: rosterFails ? 503 : 200 });
  };
  const authenticate = createIdentityVerifier({ communityId, fetcher });
  const service = createEnrollment({ authenticate, communityId, directory, fetcher });
  return { service, authenticate, calls, members, stats: () => ({ joins, maximum }), restart: () => createEnrollment({ authenticate, communityId, directory, fetcher }) };
}
function temporary(run: (directory: string) => unknown) {
  const directory = mkdtempSync(join(tmpdir(), 'jump-enrollment-'));
  return Promise.resolve().then(() => run(directory)).finally(() => rmSync(directory, { recursive: true, force: true }));
}

test('enrollment validation normalizes a company URL and rejects spoofed identity, controls, bad email and unsafe schemes', () => {
  assert.equal(normalizeEnrollment(form).companyWebsite, 'https://company.example.invalid/');
  const credentialedFixture = new URL('https://company.example.invalid'); credentialedFixture.username = 'fixture-user'; credentialedFixture.password = 'fixture-password';
  for (const value of [{ ...form, actorId: 'other' }, { ...form, role: 'OWNER' }, { ...form, consent: false }, { ...form, email: 'bad' }, { ...form, firstName: 'bad\nname' }, { ...form, firstName: '<b>x</b>' }, { ...form, companyWebsite: 'javascript:alert(1)' }, { ...form, companyWebsite: credentialedFixture.href }]) assert.throws(() => normalizeEnrollment(value), /ENROLLMENT_INVALID/);
});
test('existing members skip the form; only verified nonmembers see own profile prefill', () => temporary(async directory => {
  const h = harness(directory); const state = await h.service.status(req());
  assert.equal(state.state, 'form'); assert.equal(state.fields.firstName, 'Проверенный');
  assert.equal((await harness(directory, { initial: true }).service.status(req())).state, 'ready');
  assert.equal(readdirSync(directory).length, 0);
}));
test('unavailable or incomplete identity never becomes nonmember; pending and bans cannot join', () => temporary(async directory => {
  for (const options of [{ profileFails: true }, { rosterFails: true }, { incomplete: true }]) {
    const h = harness(directory, options); await assert.rejects(h.service.status(req())); await assert.rejects(h.service.submit(req(), form)); assert.equal(h.stats().joins, 0);
  }
  for (const [options, state] of [[{ pending: true }, 'pending'], [{ banned: true }, 'blocked']] as const) {
    const h = harness(directory, options); assert.equal((await h.service.submit(req(), form)).state, state); assert.equal(h.stats().joins, 0);
  }
  assert.equal(readdirSync(directory).length, 0);
}));
test('durable private form precedes verified-ID join; private PII never enters member payload or public board', () => temporary(async directory => {
  const h = harness(directory); assert.equal((await h.service.submit(req(), form)).state, 'ready');
  const call = h.calls.find(v => v.body); assert.deepEqual(Object.keys(call!.body).sort(), ['inviteCode', 'member']);
  assert.deepEqual(call!.body.member, { id: 'fixture-a', name: 'Проверенный Профиль', role: 'MEMBER' });
  assert.ok(!JSON.stringify(call).includes(email)); assert.ok(!JSON.stringify(call).includes(form.companyWebsite));
  const files = readdirSync(join(directory, 'enrollments')); assert.equal(files.length, 1); assert.match(files[0], /^[a-f0-9]{64}\.json$/);
  const saved = JSON.parse(readFileSync(join(directory, 'enrollments', files[0]), 'utf8')); assert.equal(saved.data.email, email); assert.equal(saved.phase, 'complete');
  assert.equal((await h.restart().status(req())).state, 'ready');
  assert.equal((await h.service.submit(req(), form)).state, 'ready'); assert.equal(h.stats().joins, 1);
}));
test('an unconfirmed upstream 200 does not open the game and is not blindly retried after restart', () => temporary(async directory => {
  const h = harness(directory, { joinWorks: false });
  assert.equal((await h.service.submit(req(), form)).state, 'confirming');
  assert.equal((await h.restart().submit(req(), form)).state, 'confirming'); assert.equal(h.stats().joins, 1);
  h.members.add('fixture-a'); assert.equal((await h.restart().status(req())).state, 'ready');
}));
test('all own community joins serialize across players and repeated submission stays idempotent', () => temporary(async directory => {
  const h = harness(directory, { delayed: true });
  const states = await Promise.all([h.service.submit(req(), form), h.service.submit(req('fixture-b'), form), h.service.submit(req(), form)]);
  assert.ok(states.every(s => s.state === 'ready')); assert.deepEqual(h.stats(), { joins: 2, maximum: 1 });
}));
test('ordinary identity GET retains its replay-safe timeout while only join POST gets the longer budget', () => temporary(async directory => {
  const budgets: number[] = [];
  const timeout = mock.method(AbortSignal, 'timeout', (duration: number) => { budgets.push(duration); return new AbortController().signal; });
  try { await harness(directory).service.submit(req(), form); assert.deepEqual(budgets, [3000, 3000, 8000, 3000, 3000]); }
  finally { timeout.mock.restore(); }
}));
test('native timeout/abort codes are not HTTP statuses and cannot crash the live server or disclose diagnostic payloads', async () => {
  for (const name of ['TimeoutError', 'AbortError']) {
    const secretMarker = 'fixture-private-provider-payload';
    const authenticate = createIdentityVerifier({ communityId, fetcher: async () => { throw new DOMException(secretMarker, name); } });
    await assert.rejects(authenticate.inspect(req()), { code: 503, message: 'IDENTITY_UNAVAILABLE' });
    for (const actual of [authenticate, async () => { throw new DOMException(secretMarker, name); }]) {
      const logs: string[] = [], warning = mock.method(console, 'warn', (message: string) => logs.push(message));
      const server = createLiveServer({ communityId, authenticate: actual }); await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
      const address = server.address(); assert.ok(address && typeof address === 'object'); const base = `http://127.0.0.1:${address.port}/jump-live-api/`;
      try {
        const failed = await fetch(base + 'me', { headers: { Authorization: 'Bearer fixture-a' } }); assert.equal(failed.status, 503); assert.ok(!(await failed.text()).includes(secretMarker));
        assert.equal((await fetch(base + 'health')).status, 200);
        assert.ok(logs.length && logs.every(line => !line.includes(secretMarker)));
        assert.deepEqual(Object.keys(JSON.parse(logs[0])).sort(), ['code', 'event', 'stage']);
      } finally { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); warning.mock.restore(); }
    }
  }
});
test('private storage failure prevents membership writes', () => temporary(async directory => {
  mkdirSync(join(directory, 'enrollments'), { mode: 0o755 }); chmodSync(join(directory, 'enrollments'), 0o755);
  const h = harness(directory); await assert.rejects(h.service.submit(req(), form), /ENROLLMENT_STORAGE_UNAVAILABLE/); assert.equal(h.stats().joins, 0);
}));
test('a symlinked private store is rejected before registration can join', () => temporary(async directory => {
  const outside = mkdtempSync(join(tmpdir(), 'jump-outside-')); try {
    symlinkSync(outside, join(directory, 'enrollments'));
    const h = harness(directory); await assert.rejects(h.service.submit(req(), form), /ENROLLMENT_STORAGE_UNAVAILABLE/); assert.equal(h.stats().joins, 0);
  } finally { rmSync(outside, { recursive: true, force: true }); }
}));
test('real redacted detail shape requires zero hidden pending/banned counts before declaring nonmember', () => temporary(async directory => {
  for (const counts of [{ pendingCount: 0, bannedCount: 0 }, { pendingCount: 1, bannedCount: 0 }, { pendingCount: 0, bannedCount: 1 }, {}]) {
    const authenticate = createIdentityVerifier({ communityId, fetcher: async (url: string) => new Response(JSON.stringify(String(url).includes('vivacrm') ? { id: 'fixture-a', name: 'Проверенный профиль' } : { id: communityId, members: [], membersLoaded: true, ...counts })) });
    const service = createEnrollment({ authenticate, communityId, directory });
    if (counts.pendingCount === 0 && counts.bannedCount === 0) assert.equal((await service.status(req())).state, 'form');
    else await assert.rejects(service.status(req()), /MEMBERSHIP_NOT_VERIFIED/);
  }
}));
test('HTTP entry is auth-first, enrollment is same-origin JSON only, and the public wall remains free of form data', () => temporary(async directory => {
  const h = harness(directory); const server = createLiveServer({ directory, communityId, origin: 'http://127.0.0.1:5192', authenticate: h.authenticate, enrollment: h.service });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve)); const address = server.address(); assert.ok(address && typeof address === 'object'); const base = `http://127.0.0.1:${address.port}/jump-live-api/`;
  const headers = { Authorization: 'Bearer fixture-a', Origin: 'http://127.0.0.1:5192', 'Content-Type': 'application/json' };
  try {
    assert.equal((await fetch(base + 'entry')).status, 401);
    assert.equal((await fetch(base + 'entry', { headers })).status, 200);
    assert.equal((await fetch(base + 'enrollment', { method: 'POST', headers: { ...headers, Origin: 'https://other.example.invalid' }, body: JSON.stringify(form) })).status, 403);
    assert.equal((await fetch(base + 'enrollment', { method: 'POST', headers, body: JSON.stringify({ ...form, member: { id: 'spoof' } }) })).status, 422);
    const joined = await fetch(base + 'enrollment', { method: 'POST', headers, body: JSON.stringify(form) }); assert.equal((await joined.json()).state, 'ready');
    assert.equal((await fetch(base + 'registrations', { headers })).status, 404);
    const board = await (await fetch(base + 'board')).text(); assert.ok(!board.includes(email) && !board.includes(form.companyWebsite) && !board.includes(form.lastName));
    assert.ok(h.calls.every(c => !c.url.includes(form.companyWebsite)));
  } finally { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); }
}));
