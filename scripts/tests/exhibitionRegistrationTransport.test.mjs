import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { transformSync } from 'esbuild';

const source = readFileSync('src/utils/communityApi.ts', 'utf8');
const declarations = ['apiAddCommunityMember', 'apiJoinCommunityByInvite'].map(name => {
  const start = source.indexOf('export async function ' + name + '(');
  const end = source.indexOf('\n}', start);
  assert.ok(start >= 0 && end > start);
  return source.slice(start, end + 2).replace(/^export /, '');
}).join('\n');
const code = transformSync(declarations, { loader: 'ts' }).code;
const registration = { fullName: 'Synthetic Participant', company: 'Synthetic Company', email: 'participant@example.invalid', policyRevision: 1, retentionMode: 'submitted-year-v1' };

function client() {
  const calls = [];
  const bindings = {
    requestCommunityMutation: async (...args) => { calls.push(args); return { status: 503, error: { message: 'UNAVAILABLE' }, data: null }; },
    buildMemberPayload: member => member,
    eventRegistrationError: response => response,
    extractCommunityInviteCode: value => value,
    buildCommunityInviteLink: code => 'https://example.invalid/community_join?invite=' + code,
  };
  const api = new Function(...Object.keys(bindings), code + '\nreturn {apiAddCommunityMember,apiJoinCommunityByInvite};')(...Object.values(bindings));
  return { api, calls };
}

for (const invite of [false, true]) {
  test((invite ? 'invite' : 'direct') + ' questionnaire transport cannot automatically replay an ambiguous PII submission', async () => {
    const { api, calls } = client();
    const payload = { member: { id: 'synthetic-player' }, eventRegistration: registration };
    if (invite) await api.apiJoinCommunityByInvite({ ...payload, inviteCode: 'synthetic-invite' });
    else await api.apiAddCommunityMember('synthetic-community', payload);
    assert.equal(calls.length, 1);
    assert.equal(calls[0][1].retries, 0);
    assert.equal(calls[0][2], false);
    assert.deepEqual(JSON.parse(calls[0][1].body).eventRegistration, registration);
  });
}

test('ordinary joins preserve their existing retry and fallback options', async () => {
  const { api, calls } = client();
  const member = { id: 'synthetic-player' };
  await api.apiAddCommunityMember('synthetic-community', { member });
  await api.apiJoinCommunityByInvite({ inviteCode: 'synthetic-invite', member }, { allowFallback: false });
  assert.deepEqual(calls.map(call => call[1].retries), [1, 1]);
  assert.deepEqual(calls.map(call => call[2]), [undefined, false]);
  assert.ok(calls.every(call => !Object.hasOwn(JSON.parse(call[1].body), 'eventRegistration')));
});
