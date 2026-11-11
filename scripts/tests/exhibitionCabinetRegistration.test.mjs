import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { transformSync } from 'esbuild';

const source = readFileSync('src/components/cabinet/CommunitiesSection.tsx', 'utf8');
function load(name, bindings) {
  const start = source.indexOf('  const ' + name + ' =');
  if (start < 0) return async () => {};
  const next = source.indexOf('\n  const ', start + 10);
  const code = transformSync(source.slice(start, next), { loader: 'tsx' }).code;
  return new Function(...Object.keys(bindings), code + '\nreturn ' + name + ';')(...Object.values(bindings));
}
const policy = { version: 'event-registration-v1', responsibleName: 'Synthetic Organizer A', contactEmail: ['organizer', 'example.invalid'].join('@'), startsAt: '2026-11-11T21:00:00.000Z', endsAt: '2026-11-13T21:00:00.000Z', retentionYears: 1 };
const notice = { policy, revision: 1, retentionMode: 'submitted-year-v1' };
const registration = { fullName: 'Synthetic Participant', company: 'Synthetic Company', email: ['participant', 'example.invalid'].join('@'), policyRevision: 1, retentionMode: 'submitted-year-v1' };
function deferred() { let resolve, reject; const promise = new Promise((done, fail) => { resolve = done; reject = fail; }); return { promise, resolve, reject }; }
function harness(result, readResult = { data: { communities: [] }, error: null }) {
  let state = { community: { id: 'synthetic-community-a' }, notice, profileKey: 'synthetic-profile' }, applied = 0;
  const origin = state, requests = [], reads = [], selected = [], messages = [];
  const eventJoinRef = { current: state }, eventProfileRef = { current: 'synthetic-profile' }, eventRecoveryRef = { current: null }, eventRegistrationPendingRef = { current: null };
  const bindings = {
    eventJoin: origin, eventJoinRef, eventProfileRef, eventRecoveryRef, eventRegistrationPendingRef,
    currentMember: { id: 'synthetic-player' },
    apiAddCommunityMember: async (...args) => { requests.push(args); return result; },
    apiJoinCommunityByInvite: async (...args) => { requests.push(args); return result; },
    apiFetchCommunities: async (...args) => { reads.push(args); return readResult; },
    setEventJoin(value) { state = typeof value === 'function' ? value(state) : value; eventJoinRef.current = state; },
    setEventRecovery(value) { eventRecoveryRef.current = value; },
    updateEventRecovery() {},
    setAccessMessage(value) { messages.push(value); },
    communityErrorMessage: () => 'Synthetic rejection',
    applyActionResponse() { applied++; },
    setFocusedCommunityId(value) { selected.push(value); }, setSelectedCommunityId(value) { selected.push(value); },
    setIsInviteOpen() {}, setInviteValue() {},
  };
  return { handle: load('handleEventRegistration', bindings), status: load('handleEventRegistrationStatus', bindings),
    requests, reads, selected, messages, origin, state: () => state, applied: () => applied,
    replace(value) { state = value; eventJoinRef.current = value; }, eventProfileRef, eventRecoveryRef };
}

test('a late canonical notice from form A cannot replace form B terms', async () => {
  const pending = deferred(), h = harness(pending.promise);
  const request = h.handle(registration);
  const other = { community: { id: 'synthetic-community-b' }, notice: { ...notice, policy: { ...policy, responsibleName: 'Synthetic Organizer B' } }, profileKey: 'synthetic-profile' };
  h.replace(other);
  pending.resolve({ status: 422, error: { message: 'EVENT_REGISTRATION_REQUIRED' }, data: { eventNotice: { ...notice, revision: 2 } } });
  await request;
  assert.equal(h.state(), other);
  assert.equal(h.state().notice.policy.responsibleName, 'Synthetic Organizer B');
  assert.equal(h.applied(), 0);
});

test('a cancelled or replaced cabinet form cannot dispatch through its old callback', async () => {
  const h = harness({ status: 503, error: { message: 'UNAVAILABLE' } });
  h.replace(null);
  await h.handle(registration);
  assert.equal(h.requests.length, 0);
});

test('late success after closing the form cannot change selection or apply another community', async () => {
  const pending = deferred(), h = harness(pending.promise), request = h.handle(registration);
  h.replace(null);
  pending.resolve({ status: 200, data: { community: { id: 'synthetic-community-a' } } });
  await request;
  assert.equal(h.applied(), 0);
  assert.deepEqual(h.selected, []);
});

test('a profile change invalidates an in-flight cabinet questionnaire response', async () => {
  const pending = deferred(), h = harness(pending.promise), request = h.handle(registration);
  h.eventProfileRef.current = 'another-synthetic-profile';
  pending.resolve({ status: 200, data: { community: { id: 'synthetic-community-a' } } });
  await request;
  assert.equal(h.applied(), 0);
  assert.deepEqual(h.selected, []);
});

for (const status of [503, 401, 403]) {
  test('cabinet status ' + status + ' clears the actionable form and prevents an immediate second mutation', async () => {
    const h = harness({ status, error: { message: 'SYNTHETIC_REJECTION' } });
    await h.handle(registration);
    assert.equal(h.state(), null);
    assert.ok(h.eventRecoveryRef.current);
    await h.handle(registration);
    assert.equal(h.requests.length, 1);
    assert.equal(h.reads.length, 0);
  });
}

test('ambiguous cabinet registration is reconciled by a fresh read, not another registration command', async () => {
  const h = harness({ status: 503, error: { message: 'UNAVAILABLE' } });
  await h.handle(registration);
  assert.equal(h.state(), null);
  await h.status();
  assert.equal(h.reads.length, 1);
  assert.equal(h.reads[0][0].forceFresh, true);
  assert.equal(h.requests.length, 1);
  assert.equal(h.eventRecoveryRef.current, null);
  assert.equal(h.state(), null, 'a status read must not silently restore a PII form');
  assert.ok(!h.messages.includes('Анкета сохранена.'));
});

test('only a canonical 422 correction keeps the same form actionable without automatic replay', async () => {
  const freshNotice = { ...notice, revision: 2 };
  const h = harness({ status: 422, error: { message: 'EVENT_REGISTRATION_REQUIRED' }, data: { eventNotice: freshNotice } });
  const message = await h.handle(registration);
  assert.deepEqual(h.state().notice, freshNotice);
  assert.match(message, /Условия анкеты обновились/);
  assert.equal(h.requests.length, 1);
  assert.equal(h.eventRecoveryRef.current, null);
});

test('the actual form setter invalidates a cancelled form synchronously and keeps recovery blocking', () => {
  const start = source.indexOf('  const setEventJoin =');
  const end = source.indexOf('\n  useEffect(', start);
  assert.ok(start >= 0 && end > start);
  const code = transformSync(source.slice(start, end), { loader: 'tsx' }).code;
  const eventJoinRef = { current: null }, eventRecoveryRef = { current: null }, eventProfileRef = { current: 'synthetic-profile' }, eventJoinGenerationRef = { current: 0 };
  let visible, shownRecovery;
  const bindings = { useCallback: fn => fn, eventJoinRef, eventRecoveryRef, eventProfileRef, eventJoinGenerationRef, eventRegistrationPendingRef: {current:null}, setEventRecovery: value => {eventRecoveryRef.current=value;shownRecovery=value;}, updateEventJoin: value => { visible = value; }, updateEventRecovery: value => { shownRecovery = value; } };
  const set = new Function(...Object.keys(bindings), code + '\nreturn setEventJoin;')(...Object.values(bindings));
  set({ community: { id: 'synthetic-community-a' }, notice });
  assert.equal(eventJoinRef.current, visible);
  assert.equal(visible.profileKey, 'synthetic-profile');
  set(null);
  assert.equal(eventJoinRef.current, null);
  const blocked = { profileKey: 'synthetic-profile' };
  eventRecoveryRef.current = blocked;
  set({ community: { id: 'synthetic-community-b' }, notice });
  assert.equal(eventJoinRef.current, null);
  assert.equal(shownRecovery, blocked);
});

test('a stale status read cannot clear a newer recovery generation', async () => {
  const read = deferred(), h = harness({ status: 503, error: { message: 'UNAVAILABLE' } }, read.promise);
  await h.handle(registration);
  const checking = h.status();
  const nextRecovery = { profileKey: 'synthetic-profile' };
  h.eventRecoveryRef.current = nextRecovery;
  read.resolve({ data: { communities: [] }, error: null });
  await checking;
  assert.equal(h.eventRecoveryRef.current, nextRecovery);
  assert.equal(h.requests.length, 1);
});

test('a failed status read does not re-enable registration', async () => {
  const h = harness({ status: 503, error: { message: 'UNAVAILABLE' } }, { data: null, error: null });
  await h.handle(registration);
  await h.status();
  assert.ok(h.eventRecoveryRef.current);
  await h.handle(registration);
  assert.equal(h.requests.length, 1);
});

test('rapid duplicate submits share the pending-form guard', async () => {
  const pending = deferred(), h = harness(pending.promise);
  const first = h.handle(registration);
  await h.handle(registration);
  assert.equal(h.requests.length, 1);
  pending.resolve({ status: 422, error: { message: 'EVENT_REGISTRATION_REQUIRED' }, data: { eventNotice: notice } });
  await first;
});

function actualController() {
  const pending = deferred();
  let state = {community:{id:'synthetic-community-a'},notice,profileKey:'synthetic-profile'}, mutations=0, reads=0;
  const eventJoinRef={current:state}, eventRecoveryRef={current:null}, eventProfileRef={current:'synthetic-profile'}, eventJoinGenerationRef={current:0}, eventRegistrationPendingRef={current:null};
  const bindings={useCallback:fn=>fn,eventJoinRef,eventRecoveryRef,eventProfileRef,eventJoinGenerationRef,eventRegistrationPendingRef,currentMember:{id:'synthetic-player'},
    updateEventJoin:value=>{state=value;},updateEventRecovery(){},setEventRecovery:value=>{eventRecoveryRef.current=value;},
    setAccessMessage(){},setJoiningCommunityId(){},setDetailError(){},applyActionResponse(){},setFocusedCommunityId(){},setSelectedCommunityId(){},setIsInviteOpen(){},setInviteValue(){},
    redirectToInviteCabinet:()=>false,communityErrorMessage:()=>'',
    apiAddCommunityMember:async(id,payload)=>{
      if(!payload.eventRegistration)return{status:422,error:{message:'EVENT_REGISTRATION_REQUIRED'},data:{eventNotice:notice}};
      mutations++;return mutations===1?pending.promise:{status:503,error:{message:'UNAVAILABLE'}};
    },
    apiFetchCommunities:async()=>{reads++;return{data:{communities:[]},error:null};},
  };
  const start=source.indexOf('  const setEventJoin ='),end=source.indexOf('\n  useEffect(',start);
  const setter=transformSync(source.slice(start,end),{loader:'tsx'}).code;
  bindings.setEventJoin=new Function(...Object.keys(bindings),setter+'\nreturn setEventJoin;')(...Object.values(bindings));
  return{pending,state:()=>state,mutations:()=>mutations,reads:()=>reads,
    submit:()=>load('handleEventRegistration',{...bindings,eventJoin:state})(registration),
    close:()=>{bindings.setEventJoin(null);bindings.updateEventRecovery(null);},
    open:()=>load('handleJoinOpenCommunity',bindings)({id:'synthetic-community-a'}),
    status:()=>load('handleEventRegistrationStatus',bindings)(),
  };
}

for(const exception of [false,true]){
  test('actual dismissal during a pending questionnaire retains GET-first recovery after '+(exception?'late exception':'late 503'),async()=>{
    const h=actualController(),request=h.submit();
    h.close();
    await h.status();
    assert.equal(h.reads(),0,'a read before the outstanding write settles cannot reconcile it');
    if(exception)h.pending.reject(new Error('SYNTHETIC_NETWORK_FAILURE'));
    else h.pending.resolve({status:503,error:{message:'UNAVAILABLE'}});
    await request;
    await h.open();
    assert.equal(h.state(),null,'dismissing the UI must not permit a fresh PII form');
    await h.submit();
    assert.equal(h.mutations(),1);
    assert.equal(h.reads(),0);
    await h.status();
    assert.equal(h.reads(),1);
    await h.open();
    assert.ok(h.state()?.notice);
    await h.submit();
    assert.equal(h.mutations(),2,'a new explicit submission is allowed only after the fresh read');
  });
}
