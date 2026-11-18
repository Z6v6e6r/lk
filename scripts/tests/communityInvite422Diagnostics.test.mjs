import assert from 'node:assert/strict';
import test from 'node:test';
import vm from 'node:vm';
import fs from 'node:fs';
import { instrumentCommunityInvite422, patchCommunityInvite422Flow } from '../diagnostics/community-invite-422.mjs';

// Invented private markers only. The response deliberately contains private data
// to prove that neither the response object nor exception text reaches the sink.
const source = `
const ctx = msg.ctx, community = msg.community, perpetual = msg.perpetual;
const notice = msg.notice;
const withJson = (original, statusCode, payload) => Object.assign({}, original, {statusCode, payload});
if (msg.reject === 'challenge') return [null, null, null, null, withJson(msg, 422, {error:'EVENT_REGISTRATION_REQUIRED', eventNotice: notice}), null];
if (msg.reject === 'validation') {
  const error = { message: msg.errorMessage };
  return [null, null, null, null, withJson(msg, 422, { error: error.message, communityId: community.id, eventNotice: notice }), null];
}
return msg.success;
`;
const patched = instrumentCommunityInvite422(source);
const fixtureEmail = ['private', 'example.invalid'].join('@');
const fixtureOperatorEmail = ['operator', 'example.invalid'].join('@');
function input() {
  return { ctx: { inviteCode: 'synthetic-invite-private', eventRegistration: { policyRevision: 2,
    fullName: 'Synthetic Private Person', company: 'Synthetic Private Company', email: fixtureEmail,
    phone: 'synthetic-phone-private', pushOptIn: true } }, community: { id: 'synthetic-community-private', typeSettingsRevision: 2 },
  notice: { policy: { contactEmail: fixtureOperatorEmail, responsibleName: 'Synthetic Private Operator' } },
  req: { headers: { authorization: 'synthetic-bearer-private' }, originalUrl: '/synthetic?invite=synthetic-query-private' },
  errorMessage: 'EVENT_REGISTRATION_INVALID', reject: 'challenge', perpetual: false };
}
function run(body, msg, node) {
  return vm.runInNewContext(`(function(msg,node) { ${body}\n})(msg,node)`, {msg,node}, {timeout:1000});
}
function compare(msg, nodeFactory = warnings => ({warn:value => warnings.push(value)})) {
  const warnings = [];
  const before = run(source, msg, {});
  const after = run(patched, msg, nodeFactory(warnings));
  assert.deepEqual(JSON.parse(JSON.stringify(after)), JSON.parse(JSON.stringify(before)));
  if (after !== undefined) assert.equal(after?.[4]?.req, msg.req);
  return warnings.map(s => { assert.equal(typeof s,'string'); return JSON.parse(s); });
}

test('challenge emits one fixed record with only booleans; response and write outputs unchanged', () => {
  const msg=input(), before=structuredClone(msg);
  const records=compare(msg);
  assert.deepEqual(msg,before);
  assert.deepEqual(records,[{code:'COMMUNITY_INVITE_JOIN_422',route:'/lk/communities/join-by-invite',httpStatus:422,
    branch:'registration_challenge',reason:'EVENT_REGISTRATION_REQUIRED',registrationPresent:true,revisionMatches:true,retentionMatches:true}]);
  assert(run(patched,msg,{warn(){}}).slice(0,4).every(v=>v===null));
  for(const marker of ['synthetic-invite-private','Synthetic Private','example.invalid','synthetic-phone-private','synthetic-community-private','synthetic-bearer-private','synthetic-query-private']) assert(!JSON.stringify(records).includes(marker));
});

test('missing registration, wrong revision and retention mismatch remain distinct boolean facts', () => {
  const missing=input();delete missing.ctx.eventRegistration;
  assert.equal(compare(missing)[0].registrationPresent,false);
  assert.equal(compare(missing)[0].revisionMatches,false);
  const stale=input();stale.ctx.eventRegistration.policyRevision=1;
  assert.equal(compare(stale)[0].revisionMatches,false);
  const rolling=input();rolling.perpetual=true;
  assert.equal(compare(rolling)[0].retentionMatches,false);
  rolling.ctx.eventRegistration.retentionMode='submitted-year-v1';
  assert.equal(compare(rolling)[0].retentionMatches,true);
});

test('validation distinguishes allowlisted errors and maps private, forged or non-string messages to UNKNOWN', () => {
  for(const value of ['EVENT_REGISTRATION_INVALID','EVENT_REGISTRATION_REQUIRED','synthetic-private-error\nforged',
    fixtureEmail,{private:'synthetic-object-private'},undefined]) {
    const msg=input();msg.reject='validation';msg.errorMessage=value;
    const records=compare(msg);
    assert.equal(records.length,1);
    assert.deepEqual(Object.keys(records[0]).sort(),['branch','code','httpStatus','reason','route']);
    assert.equal(records[0].reason,['EVENT_REGISTRATION_INVALID','EVENT_REGISTRATION_REQUIRED'].includes(value)?value:'UNKNOWN');
    assert(!JSON.stringify(records).includes('synthetic-'));
  }
});

test('missing or throwing logger never alters rejection, output identity or emits a fallback payload', () => {
  for(const reject of ['challenge','validation']) for(const factory of [()=>undefined,()=>({}),()=>({warn(){throw Error('synthetic-sink-private');}})]) {
    const msg=input();msg.reject=reject;
    assert.deepEqual(compare(msg,factory),[]);
  }
});

test('success, auth failures, not-found, policy, ban and CAS outputs are silent and identical', () => {
  for(const status of [200,400,401,403,404,409,503]) {
    const msg=input();msg.reject=null;msg.success=[null,null,null,null,{statusCode:status,payload:{private:'synthetic-private'}},null];
    const warnings=[];
    assert.strictEqual(run(patched,msg,{warn:v=>warnings.push(v)}),msg.success);
    assert.deepEqual(warnings,[]);
  }
  const msg=input();msg.reject=null;msg.success=null;
  assert.strictEqual(run(patched,msg,{warn(){throw Error('must not log');}}),null);
});

test('unknown/duplicate/repeated anchors fail closed without exposing source', () => {
  for(const body of [undefined,source.replace('error.message','error.detail'),source+source,patched]) {
    assert.throws(()=>instrumentCommunityInvite422(body),/^Error: COMMUNITY_INVITE_DIAGNOSTIC_SOURCE_DRIFT$/);
  }
});

test('production hash pin rejects synthetic flow, malformed identity and ambiguous routes', () => {
  const flow=[{id:'synthetic-tab',type:'tab'},{id:'synthetic-route',type:'http in',url:'/lk/communities/join-by-invite',method:'post',z:'synthetic-tab',wires:[['synthetic-apply']]},
    {id:'synthetic-apply',type:'function',name:'Apply invite join',z:'synthetic-tab',outputs:6,func:source,wires:[[],[],[],[],['synthetic-response'],[]]},
    {id:'synthetic-response',type:'http response',z:'synthetic-tab',wires:[]}];
  const before=structuredClone(flow);
  assert.throws(()=>patchCommunityInvite422Flow(flow),/SOURCE_DRIFT/);
  assert.deepEqual(flow,before);
  assert.throws(()=>patchCommunityInvite422Flow([...flow,flow[0]]),/FLOW_INVALID/);
  assert.throws(()=>patchCommunityInvite422Flow([...flow,{...flow[1],id:'synthetic-second-route'}]),/ROUTE_DRIFT/);
});

// Optional private preimage, never copied into this test or repository. The
// production source hash is enforced by the builder, even in this rehearsal.
test('private exact preimage: one-field-only patch, disabled duplicates and alternate ingress refusal',
  {skip:!process.env.COMMUNITY_INVITE_422_FIXTURE}, () => {
    const flow=JSON.parse(fs.readFileSync(process.env.COMMUNITY_INVITE_422_FIXTURE,'utf8'));
    const before=structuredClone(flow);
    const built=patchCommunityInvite422Flow(flow);
    assert.deepEqual(flow,before);
    const changed=built.candidate.filter((n,i)=>n.func!==flow[i].func);
    assert.equal(changed.length,1);
    const target=changed[0], original=flow.find(n=>n.id===target.id);
    target.func=original.func;
    assert.deepEqual(built.candidate,flow);
    for(const type of ['http in','inject','link in','function']) {
      const drift=structuredClone(flow);
      drift.push({id:'synthetic-other-ingress',z:target.z,type,url:'/synthetic-other-route',method:'post',wires:[[target.id]]});
      assert.throws(()=>patchCommunityInvite422Flow(drift),/INGRESS_DRIFT/);
    }
    const crossTab=structuredClone(flow);
    crossTab.push({id:'synthetic-other-tab',type:'tab'},
      {id:'synthetic-cross-tab-input',type:'function',z:'synthetic-other-tab',func:'return msg;',wires:[[target.id]]});
    assert.throws(()=>patchCommunityInvite422Flow(crossTab),/INGRESS_DRIFT/);
    const onStart=structuredClone(flow);
    onStart.find(n=>n.id===target.id).initialize='node.send({});';
    assert.throws(()=>patchCommunityInvite422Flow(onStart),/INGRESS_DRIFT/);
    const once=patchCommunityInvite422Flow(flow).candidate;
    assert.throws(()=>patchCommunityInvite422Flow(once),/SOURCE_DRIFT/);
    const sourceDrift=structuredClone(flow);
    sourceDrift.find(n=>n.id===target.id).func+='\n// drift';
    assert.throws(()=>patchCommunityInvite422Flow(sourceDrift),/SOURCE_DRIFT/);
  });
