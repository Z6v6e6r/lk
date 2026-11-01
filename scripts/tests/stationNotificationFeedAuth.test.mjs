import test from 'node:test';
import assert from 'node:assert/strict';
import { verifyStationNotificationFeed } from '../lib/stationNotificationFeedAuth.mjs';
import { notificationFixture, publications, recipients, eligibility, signedMessage, authEnvironment, uid } from './helpers/stationNotificationHarness.mjs';
const get=k=>authEnvironment[k];
test('dedicated synthetic RS256 binds all three exact read-only operations',async()=>{
 const f=await notificationFixture();
 for(const [mode,body]of [['publications',publications(f.c)],['recipients',recipients(f.c,f.records[0])],['eligibility',eligibility(f.c,f.records[0])]]){const result=verifyStationNotificationFeed(signedMessage(mode,body),get,mode);assert.deepEqual(result.request,body);assert.ok(result.expiresAtMs>Date.now());}
});
test('wrong purpose, scope, tenant/namespace, caller, request/body and expiry never authorize storage',async()=>{
 const f=await notificationFixture(),body=publications(f.c),now=Math.floor(Date.now()/1000);
 for(const claims of [{iss:'wrong'},{aud:'wrong'},{tenant_id:uid(998)},{owner_namespace:uid(999)},{sub:'lk2-api'},{scope:'communities.station-membership.confirm'},{method:'GET'},{path:'/lk/communities/station/messages'},{body_sha256:'sha256:'+'0'.repeat(64)},{request_id:uid(998)},{correlation_id:'other'},{exp:now},{exp:now+31},{iat:now+1,nbf:now+1},{nbf:now-1},{sid:uid(1)},{contract:'station-membership.v1'}])assert.ok(verifyStationNotificationFeed(signedMessage('publications',body,{claims}),get,'publications').response);
 for(const header of [{typ:'phub-station-membership-delegation+jwt'},{typ:'JWT'},{alg:'HS256'},{kid:'other'},{jku:'https://synthetic.invalid'}])assert.equal(verifyStationNotificationFeed(signedMessage('publications',body,{header}),get,'publications').response.status,401);
});
test('exact HTTP context required; user credential/header replay cannot replace service purpose',async()=>{
 const f=await notificationFixture(),body=publications(f.c);
 for(const mutate of [m=>m.req.headers['x-padlhub-station-notification-contract']='wrong',m=>m.req.query={afterSequence:0},m=>m.req.originalUrl+='?x=1',m=>m.req.method='GET',m=>m.payload.limit=49,m=>m.req.headers['x-correlation-id']='wrong',m=>{m.req.headers.authorization='Bearer synthetic-user';delete m.req.headers['x-station-notification-delegation'];},m=>m.req.headers['x-station-notification-delegation']+='bad']){const m=signedMessage('publications',body);mutate(m);assert.ok(verifyStationNotificationFeed(m,get,'publications').response);}
});
test('default-off, missing config and invalid public key fail closed without a successful receipt',async()=>{
 const f=await notificationFixture(),m=signedMessage('publications',publications(f.c));
 assert.equal(verifyStationNotificationFeed(m,()=>undefined,'publications').response.status,503);
 for(const key of Object.keys(authEnvironment)){const env={...authEnvironment};delete env[key];assert.equal(verifyStationNotificationFeed(m,k=>env[k],'publications').response.status,503);}
 assert.equal(verifyStationNotificationFeed(m,k=>k.endsWith('PUBLIC_KEY_PEM')?'not a key':get(k),'publications').response.status,401);
 const response=verifyStationNotificationFeed(m,k=>k.endsWith('OWNER_NAMESPACE')?'foreign':get(k),'publications').response;assert.equal(response.status,503);assert.deepEqual(Object.keys(response.body).sort(),['contract','error','requestId']);
});
