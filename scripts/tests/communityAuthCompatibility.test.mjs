import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs';
import vm from 'node:vm';
import { addCommunityPolicyAuth, COMMUNITY_AUTH_PREPARE, COMMUNITY_AUTH_RESPONSE, COMMUNITY_PLAYER_RATING_ACCESS } from '../lib/communityPolicyAuth.mjs';
const source = fs.readFileSync('scripts/patch_nodered_communities_flow.mjs', 'utf8');
const common = source.split('const commonHelpers = String.raw`')[1].split('\n`;')[0];
const body = name => common + source.split('const ' + name + ' = `${commonHelpers}')[1].split('\n`;')[0];
const run = (code, msg) => vm.runInNewContext('(function(msg){' + code + '\n})(msg)', { msg });
const json = x => JSON.parse(JSON.stringify(x));
function patched(code, outputs = 3, response = 1) {
  return addCommunityPolicyAuth([{ id: 'fn', type: 'function', name: 'Synthetic request handler', func: code, outputs,
    wires: Array.from({ length: outputs }, (_, i) => i === response ? ['response'] : []) },
  { id: 'response', type: 'http response', wires: [] }]).find(x => x.id === 'fn').func;
}
const get = patched(body('fnGetResponse'));
const community = type => ({ id: 'synthetic', communityType: type, visibility: 'CLOSED', members: [{ id: 'victim', name: 'Owner', role: 'OWNER' }] });
function authenticate(status, profile = { id: 'attacker' }) {
  const msg = { req: { method: 'POST', headers: { authorization: 'Bearer synthetic' }, query: { clientId: 'victim', phone: '79990000000' } },
    payload: { actor: { id: 'victim' }, member: { id: 'target' } }, method: 'original', url: '/original', headers: { retained: 'synthetic' }, followRedirects: true };
  const before = json(msg);
  assert.equal(run(COMMUNITY_AUTH_PREPARE, msg)[0], msg);
  assert.equal(msg.followRedirects, false);
  msg.statusCode = status; msg.payload = profile;
  const result = run(COMMUNITY_AUTH_RESPONSE, msg)[0];
  assert.deepEqual(json(result.req), before.req); assert.deepEqual(json(result.payload), before.payload);
  for (const key of ['method', 'url', 'headers', 'followRedirects']) assert.deepEqual(json(result[key]), before[key]);
  assert.equal(Object.hasOwn(result, 'statusCode'), false);
  return result;
}

test('auth success, rejected credentials, provider outage and redirect restore the raw legacy request', () => {
  for (const status of [200, 401, 403, 302, 503]) {
    const msg = authenticate(status);
    assert.equal(msg._communityPolicyAuth, undefined);
    if (status === 200) assert.equal(msg._verifiedCommunityActor.id, 'attacker');
    else assert.ok(['INVALID','UNAVAILABLE'].includes(msg._communityPolicyAuthFailure));
  }
  const flow = addCommunityPolicyAuth([{ id: 'in', type: 'http in', z: 'tab', method: 'get', url: '/lk/communities', wires: [['list']] },
    { id: 'list', type: 'function', z: 'tab', name: 'List', func: 'return msg;', wires: [[]] }]);
  assert.equal(flow.find(x => x.id.endsWith('-http')).followRedirects, false);
});

test('FRIENDS retains requested identity on success and 401/503/redirect; typed reads fail closed', () => {
  for (const status of [200, 401, 302, 503]) {
    const auth = authenticate(status);
    const msg = { ...auth, req: { ...auth.req, method: 'GET' }, payload: [community('FRIENDS')], _communityGet: { clientId: 'victim' } };
    assert.equal(run(get, msg)[0].statusCode, 200);
    const typed = { ...auth, req: { ...auth.req, method: 'GET' }, payload: [community('STATION')], _communityGet: { clientId: 'victim' } };
    const denied = run(get, typed).find(x => x?.statusCode);
    assert.equal(denied.statusCode, status === 200 ? 403 : status === 401 ? 401 : 503);
    assert.doesNotMatch(JSON.stringify(denied.payload), /Owner|victim|79990000000/);
  }
});

test('typed join binds member before the local join variable is computed; FRIENDS stays legacy', () => {
  const join = patched(body('fnJoinGamesQuery'));
  for (const type of ['STATION', 'FRIENDS']) {
    const msg = { req: { method: 'POST', headers: {} }, payload: [{ ...community(type), visibility: 'OPEN' }],
      _verifiedCommunityActor: { id: 'attacker', name: 'Verified', phone: '79990000002' },
      _communityJoin: { communityId: 'synthetic', member: { id: 'victim', name: 'Untrusted' } } };
    const output = run(join, msg)[0];
    assert.equal(output._communityJoin.member.id, type === 'STATION' ? 'attacker' : 'victim');
  }
  for (const failure of ['INVALID','UNAVAILABLE']) {
    const msg = { req: { method: 'POST' }, payload: [community('LEAGUE')], _communityPolicyAuthFailure: failure,
      _communityJoin: { member: { id: 'victim' } } };
    const output = run(join, msg); assert.equal(output[0], null);
    assert.equal(output[1].statusCode, failure === 'INVALID' ? 401 : 503);
  }
});

test('typed member management replaces only caller, preserves target, and rejects spoofed owner', () => {
  const manage = patched(body('fnMemberManageApply'), 6, 4);
  const doc = { ...community('LEAGUE'), members: [...community('LEAGUE').members,
    { id: 'attacker', role: 'MEMBER' }, { id: 'target', role: 'MEMBER' }] };
  const msg = { req: { method: 'POST' }, payload: [doc], _verifiedCommunityActor: { id: 'attacker' },
    _communityMemberManage: { action: 'REMOVE', actor: { id: 'victim' }, member: { id: 'target' } } };
  const output = run(manage, msg);
  assert.equal(output[0], null); assert.ok(output.some(x => x?.statusCode === 403));
  assert.equal(msg._communityMemberManage.actor.id, 'attacker'); assert.equal(msg._communityMemberManage.member.id, 'target');
});

test('mixed list preserves FRIENDS and hides closed typed rows on provider failure', () => {
  const list = patched(common + fs.readFileSync('scripts/nodered_community_list_nodes/fn_list_response_tail.js', 'utf8'), 2, 0);
  const msg = { req: { method: 'GET', headers: {} }, _communityList: { clientId: 'victim', listMode: 'FULL' },
    _communityPolicyAuthFailure: 'UNAVAILABLE', payload: [community('FRIENDS'), { ...community('STATION'), id: 'closed-typed' }] };
  const result = run(list, msg)[0];assert.equal(result.statusCode, 200);
  assert.deepEqual(json(result.payload.communities.map(x => x.id)), ['synthetic']);
});


test('closed typed player-rating preserves invalid-token versus provider-outage errors', () => {
  for (const [failure,status] of [['INVALID',401],['UNAVAILABLE',503]]) {
    const code = "const community=msg.community; const toTrimmed=x=>String(x||'').trim(); const toRows=x=>Array.isArray(x)?x:[]; const exactMemberIds=x=>[x.id]; const jsonError=(status,error)=>({statusCode:status,payload:{error}});" + COMMUNITY_PLAYER_RATING_ACCESS;
    const output=run(code,{community:community('LEAGUE'),_communityPolicyAuthFailure:failure});
    assert.equal(output[1].statusCode,status); assert.doesNotMatch(JSON.stringify(output),/victim|Owner/);
  }
});

test('actual player-rating source and known legacy graph upgrade keep EVENT closed and are idempotent', () => {
  const current = fs.readFileSync('scripts/nodered_community_player_rating_nodes/fn_community_player_rating_community.js', 'utf8');
  const legacy = current.replace(",'EVENT'", '').replace(/ {2}const failure = msg\._communityPolicyAuthFailure;\n {2}if \(failure === 'INVALID' \|\| failure === 'UNAVAILABLE'\) \{[\s\S]*?\n {2}\}\n/, '');
  for (const source of [current, legacy]) {
    const result = patched(source, 2, 1);
    assert.equal(patched(result, 2, 1), result);
    assert.ok(result.includes(COMMUNITY_PLAYER_RATING_ACCESS.trim()));
    for (const [failure, status] of [[undefined,403],['INVALID',401],['UNAVAILABLE',503]]) {
      const output = run(result, {payload:[community('EVENT')],_communityPlayerRating:{playerId:'victim'},_communityPolicyAuthFailure:failure});
      assert.equal(output[1].statusCode,status);
      assert.doesNotMatch(JSON.stringify(output[1].payload),/victim|Owner/);
    }
  }
  assert.throws(()=>patched(current.replace("'AUTH_SERVICE_UNAVAILABLE'", "'DRIFTED'"),2,1),/COMMUNITY_PLAYER_RATING_ACCESS_SHAPE_DRIFT/);
});
