import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import path from 'node:path';
import {initialState,providerRequest,ACTOR,TOKEN} from '../lk1_subscription_visit_dev/fixture.mjs';
import {validateConfig} from '../lk1_subscription_visit_dev/runtime.mjs';
import {verifyPacket,newPrivateUserDir} from '../lk1_subscription_visit_dev/packet.mjs';
import {isNodeRedHttpsCheckout} from '../patch_nodered_subscription_paid_join.mjs';
import {buildVisitDevGraph} from '../lk1_subscription_visit_dev/graph.mjs';
const config={environment:'DEV',mongoUri:'mongodb://127.0.0.1:27030',database:'lk1_subscription_dev_fixture_verify_test',providerPort:3038,nodeRedPort:1882};
test('DEV configuration rejects shared/external DB, credentials, alternate Mongo port and listener collisions',()=>{
  assert.equal(validateConfig(config),config);
  for(const extra of [{environment:'PROD'},{mongoUri:'mongodb://localhost:27030'},{mongoUri:'mongodb://127.0.0.1:27029'},
    {mongoUri:'mongodb://user:pass@127.0.0.1:27030'},{database:'lk_games'},{database:config.database+'a'.repeat(64)},{providerPort:1882},{nodeRedPort:27030}])assert.throws(()=>validateConfig({...config,...extra}));
});
test('provider rejects foreign identities and malformed paid checkout DTOs',()=>{
  const state=initialState(),headers={authorization:'Bearer '+TOKEN};
  const call=(url,body)=>providerRequest(state,{method:'POST',url,headers,body},'http://127.0.0.1:3038');
  const booking={clientId:ACTOR,phone:'+70000000001',paymentType:'ON_PLACE',customFields:[]};
  assert.throws(()=>call('/api/v1/exercises/fixture-exercise/bookings',{...booking,clientId:'foreign'}));
  assert.throws(()=>call('/api/v1/exercises/fixture-exercise/bookings',{...booking,clientSubscriptionId:'foreign'}));
  const id=call('/api/v1/exercises/fixture-exercise/bookings',booking).body.id;
  assert.throws(()=>call('/api/v1/products/available/by-booking',{bookingIds:['missing'],clientId:ACTOR,studioId:'fixture-studio'}));
  const tx={clientPhone:'+70000000001',paymentMethod:'SMS',studioId:'fixture-studio',offlineTillId:null,deposit:0,
    products:[{id:'fixture-carrier',type:'SERVICE',count:1,customAmount:null,discount:973750,bookingIds:[id]}]};
  for(const extra of [{clientPhone:'+70000000002'},{studioId:'foreign'},{paymentMethod:'CASH'},
    {products:[{...tx.products[0],customAmount:1}]}])assert.throws(()=>call('/api/v1/transactions',{...tx,...extra}));
  assert.equal(state.transactions.length,0);assert.equal(call('/api/v1/transactions',tx).status,201);
  assert.equal(state.transactions[0].toPayMinor,26250);
});
test('runtime user directory must be new and private',()=>{
  const parent=fs.mkdtempSync('/private/tmp/visit-unit-');
  try{assert.throws(()=>newPrivateUserDir(parent));const child=newPrivateUserDir(path.join(parent,'new'));assert.equal(fs.statSync(child).mode&0o777,0o700);}
  finally{fs.rmSync(parent,{recursive:true});}
});
const source=process.env.LK1_PAID_JOIN_LIVE_FIXTURE;
test('native graph retains scoped recovery, and HTTPS validation works without global URL',{skip:!source},()=>{
  const graph=buildVisitDevGraph(fs.readFileSync(source));
  assert.equal(graph.flow.filter(n=>n.type==='catch'&&n.scope?.length).length,4);
  assert.equal(graph.flow.find(n=>n.id==='dev-catch').uncaught,true);
  assert.ok(graph.flow.every(n=>!['http request','mongodb4','inject'].includes(n.type)));
  const gateway=graph.flow.find(n=>n.id==='lk_subscription_booking_router_20260804').func;
  assert.ok(!gateway.includes('new URL('));
  const canonical=fs.readFileSync(new URL('../nodered_lk1_hub_nodes/gateway.js',import.meta.url),'utf8');
  assert.ok(canonical.includes(isNodeRedHttpsCheckout.toString()));assert.ok(!canonical.includes('new URL('));
  const safe=paymentUrl=>vm.runInNewContext(isNodeRedHttpsCheckout.toString()+'\nisNodeRedHttpsCheckout(paymentUrl)',{paymentUrl});
  assert.equal(safe('https://checkout.invalid/fixture-pay/1?next=%2F'),true);
  for(const url of ['http://checkout.invalid','https://user:pass@checkout.invalid','https://checkout.invalid\\@evil.invalid',
    'https://checkout.invalid\n.evil.invalid','https://%65vil.invalid','javascript:alert(1)','https://-bad.invalid','https://checkout.invalid:99999'])assert.equal(safe(url),false,url);
});
const packet=process.env.LK1_VISIT_DEV_PACKET;
test('packet requires exact inventory, entry binding and content integrity',{skip:!packet},()=>{
  verifyPacket(packet);
  assert.throws(()=>verifyPacket(packet,import.meta.filename),/ENTRY_MISMATCH/);
  const copy=fs.mkdtempSync('/private/tmp/visit-packet-unit-');
  try{
    fs.cpSync(packet,copy,{recursive:true,filter:src=>!src.includes('node_modules')});
    const manifest=JSON.parse(fs.readFileSync(path.join(copy,'manifest.json')));
    fs.appendFileSync(path.join(copy,'config.json'),' ');assert.throws(()=>verifyPacket(copy),/PACKET_DRIFT/);
    manifest.files=manifest.files.filter(r=>r.path!=='config.json');
    fs.writeFileSync(path.join(copy,'manifest.json'),JSON.stringify(manifest));assert.throws(()=>verifyPacket(copy),/MANIFEST_INVALID/);
  }finally{fs.rmSync(copy,{recursive:true});}
});
