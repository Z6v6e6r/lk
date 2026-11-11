import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { transformSync } from 'esbuild';

const source = readFileSync('src/components/communities/CommunityJoinPage.tsx', 'utf8');
const start = source.indexOf('  const handleJoin =');
const end = source.indexOf('  const handleReload =', start);
assert.ok(start >= 0 && end > start);
const callback = transformSync(source.slice(start, end), { loader: 'tsx' }).code;
const EXHIBITION_COMMUNITY_ID = 'community_1794221739126_корпспорт-падлхаб-2026';
const policy = { version: 'event-registration-v1', responsibleName: 'Synthetic Organizer', contactEmail: 'organizer@example.invalid', startsAt: '2026-11-11T21:00:00.000Z', endsAt: '2026-11-13T21:00:00.000Z', retentionYears: 1 };
const notice = { policy, revision: 1, retentionMode: 'submitted-year-v1' };
const registration = { fullName: 'Synthetic Participant', company: 'Synthetic Company', email: 'participant@example.invalid', policyRevision: 1, retentionMode: 'submitted-year-v1' };

function harness({ member = false, response, freshContext = true, initialNotice = null } = {}) {
  const context = {}, calls = [], redirects = [], states = [], notices = [], errors = [];
  let logins = 0;
  const community = { id: EXHIBITION_COMMUNITY_ID, inviteCode: 'synthetic-invite', members: [] };
  const bindings = {
    useCallback: fn => fn, EXHIBITION_COMMUNITY_ID,
    activeAction: { current: false }, loading: false, context, loadedContext: context,
    currentContext: { current: freshContext ? context : {} }, mounted: { current: true },
    profile: { id: 'synthetic-player' }, alreadyMember: member, community,
    eventAdmissionConfirmed: false, eventNotice: initialNotice,
    state: member ? 'member' : 'unverified', cabinetUrl: 'https://example.invalid/lk',
    normalizedInviteCode: 'synthetic-invite', normalizedInviteLink: null,
    setActionError: value => errors.push(value), setSubmitting() {},
    setState: value => states.push(value), setCommunity() {},
    setEventNotice: value => notices.push(value), setEventAdmissionConfirmed() {},
    requireLogin: () => { logins++; },
    redirectToCabinet: (...args) => { redirects.push(args); return true; },
    buildCommunityActor: profile => ({ id: profile.id }),
    apiJoinCommunityByInvite: async (...args) => { calls.push(args); return response; },
    communityErrorMessage: () => 'Synthetic rejection',
    findInviteCommunity: list => list[0]?.id === community.id ? list[0] : null,
    isCommunityMember: value => value.id === community.id,
  };
  const handle = new Function(...Object.keys(bindings), callback + '\nreturn handleJoin;')(...Object.values(bindings));
  return { handle, calls, redirects, states, notices, errors, logins: () => logins };
}

test('public invite shows the canonical questionnaire instead of blocking on 422', async () => {
  const h = harness({ response: { status: 422, error: { message: 'EVENT_REGISTRATION_REQUIRED' }, data: { eventNotice: notice } } });
  await h.handle();
  assert.deepEqual(h.notices, [notice]);
  assert.ok(!h.states.includes('blocked'));
  assert.equal(h.calls.length, 1);
  assert.deepEqual(h.calls[0][1], { allowFallback: false });
});

test('existing exhibition membership does not bypass canonical questionnaire admission', async () => {
  const h = harness({ member: true, response: { status: 422, error: { message: 'EVENT_REGISTRATION_REQUIRED' }, data: { eventNotice: notice } } });
  await h.handle();
  assert.equal(h.calls.length, 1);
  assert.equal(h.redirects.length, 0);
  assert.deepEqual(h.notices, [notice]);
});

test('public invite sends the explicit retention acknowledgement without fallback or duplicate request', async () => {
  const h = harness({ initialNotice: notice, response: { status: 200, data: { community: { id: EXHIBITION_COMMUNITY_ID } } } });
  await h.handle(registration);
  assert.equal(h.calls.length, 1);
  assert.deepEqual(h.calls[0][0].eventRegistration, registration);
  assert.deepEqual(h.calls[0][1], { allowFallback: false });
  assert.ok(h.states.includes('member'));
  assert.ok(h.notices.includes(null));
});

test('changed canonical terms require a new explicit submission, never automatic replay', async () => {
  const fresh = { ...notice, revision: 2 };
  const h = harness({ initialNotice: notice, response: { status: 422, error: { message: 'EVENT_REGISTRATION_REQUIRED' }, data: { eventNotice: fresh } } });
  const error = await h.handle(registration);
  assert.deepEqual(h.notices, [fresh]);
  assert.match(error, /Условия анкеты обновились/);
  assert.equal(h.calls.length, 1);
});

test('a response from a superseded invite context cannot open a questionnaire', async () => {
  const h = harness({ freshContext: false, response: { status: 422, error: { message: 'EVENT_REGISTRATION_REQUIRED' }, data: { eventNotice: notice } } });
  await h.handle();
  assert.deepEqual(h.notices, []);
  assert.deepEqual(h.states, []);
  assert.equal(h.calls.length, 0, 'a stale invitation handler must not send a command');
});

test('unauthenticated public invite response still requires login', async () => {
  const h = harness({ response: { status: 401, error: { message: 'UNAUTHORIZED' } } });
  await h.handle();
  assert.equal(h.logins(), 1);
  assert.deepEqual(h.notices, []);
});

test('ambiguous questionnaire outcome removes the form and requires a status read before retry', async () => {
  const h = harness({ initialNotice: notice, response: { status: 503, error: { message: 'UNAVAILABLE' } } });
  await h.handle(registration);
  assert.deepEqual(h.notices, [null]);
  assert.ok(h.states.includes('error'));
  assert.equal(h.calls.length, 1);
});

test('a definite membership rejection cannot leave an actionable questionnaire behind', async () => {
  const h = harness({ initialNotice: notice, response: { status: 403, error: { message: 'INVITE_FORBIDDEN' } } });
  await h.handle(registration);
  assert.deepEqual(h.notices, [null]);
  assert.ok(h.states.includes('blocked'));
  assert.equal(h.calls.length, 1);
});
