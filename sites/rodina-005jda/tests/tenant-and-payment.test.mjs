import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { arenaData, assertBinding } from '../src/tenant-config.js';
import * as Viva from '../src/viva-booking.js';
import * as Payment from '../src/viva-payment.js';

const arenas = arenaData.arenas;
const binding = arenas.find(a => a.id === 'kantemirovskaya').viva;
const token = 'fixture.' + Buffer.from(JSON.stringify({exp:Math.floor(Date.now()/1000)+3600,tenantKey:'005JDA'})).toString('base64url') + '.fixture';
function setup(t, cookie = '') {
 const store = new Map();
 for(const [key,value] of Object.entries({document:{cookie},sessionStorage:{getItem:key=>store.get(key)||null,setItem:(key,value)=>store.set(key,value),removeItem:key=>store.delete(key)},location:{href:'https://example.test/rodina',origin:'https://example.test',pathname:'/rodina',protocol:'https:'},history:{state:null,replaceState(){}}})) {
  const old=Object.getOwnPropertyDescriptor(globalThis,key);
  Object.defineProperty(globalThis,key,{value,writable:true,configurable:true});
  t.after(()=>old?Object.defineProperty(globalThis,key,old):delete globalThis[key]);
 }
 return store;
}
function interval(amount = 100) {
 const day=Viva.addDays(Viva.moscowDay(),1);
 return {timeFrom:day+'T12:00:00+03:00',timeTo:day+'T13:00:00+03:00',amount};
}
const response = body => ({ok:true,status:200,text:async()=>JSON.stringify(body),json:async()=>body});

test('all verified catalog tuples stay inside 005JDA; unknown venues fail closed',()=>{
 assert.equal(arenas.length,9);
 assert.ok(arenas.every(arena=>arena.viva.masterServiceId), 'all nine venues must have verified mappings');
 for(const arena of arenas) {
  assert.equal(arena.viva.tenantKey,'005JDA');
  if(arena.viva.masterServiceId) assert.doesNotThrow(()=>assertBinding(arena.viva));
  else assert.throws(()=>assertBinding(arena.viva),/временно недоступна/);
 }
});
test('old tenant and mixed room tuples cannot make public or payment requests',async t=>{
 setup(t);let calls=0;t.mock.method(globalThis,'fetch',async()=>{calls++;throw Error('unexpected fetch');});
 for(const bad of [{...binding,tenantKey:'iSkq6G'},{...binding,roomId:'unrelated-room'}]) {
  await assert.rejects(Viva.settingsFor(bad),/конфигурация/);
  await assert.rejects(Viva.slotsFor(bad,Viva.moscowDay()),/конфигурация/);
  await assert.rejects(Payment.createPayment(bad,interval(),60),/конфигурация/);
  assert.throws(()=>Payment.paymentPayload(bad,interval()),/конфигурация/);
 }
 await assert.rejects(Payment.accessToken('iSkq6G'),/конфигурация/);
 await assert.rejects(Payment.requestLoginCode('iSkq6G','70000000000'),/конфигурация/);
 assert.equal(calls,0);
});
test('old-tenant tokens and OAuth records are never reused for target tenant',async t=>{
 const store=setup(t,'iSkq6GAuthToken='+token);store.set('iSkq6GAuthToken',token);
 store.set('viva-oauth-pkce-v1',JSON.stringify({state:'fixture',tenant:'iSkq6G'}));
 globalThis.location.href+='?code=fixture&state=fixture';
 let calls=0;t.mock.method(globalThis,'fetch',async()=>{calls++;throw Error('unexpected fetch');});
 await assert.rejects(Payment.accessToken('005JDA'),{code:'AUTH_REQUIRED'});
 assert.match((await Payment.finishOAuthRedirect()).error,/подтвердить/);
 assert.equal(calls,0);
});
test('wrong-tenant, mismatched-state, expired and malformed OAuth callbacks do not exchange codes',async t=>{
 const store=setup(t);let calls=0;t.mock.method(globalThis,'fetch',async()=>{calls++;throw Error('unexpected fetch');});
 for(const change of [{tenant:'iSkq6G'},{state:'different'},{createdAt:Date.now()-11*60000},{createdAt:'invalid'}]) {
  store.set('rodina-005JDA-oauth-pkce-v1',JSON.stringify({tenant:'005JDA',state:'fixture',redirectUri:'https://example.test/rodina',createdAt:Date.now(),...change}));
  globalThis.location.href='https://example.test/rodina?code=fixture&state=fixture';
  assert.ok((await Payment.finishOAuthRedirect()).error);
 }
 assert.equal(calls,0);
});
test('each verified venue uses its exact target IDs in public URL and payment payload',async t=>{
 setup(t);const urls=[];t.mock.method(globalThis,'fetch',async(url,options)=>{urls.push([url,options]);return response({byTrainer:{}});});
 for(const {viva:b}of arenas.filter(a=>a.viva.masterServiceId)) {
  await Viva.slotsFor(b,Viva.moscowDay());const [url,options]=urls.at(-1);
  assert.match(url,new RegExp('/005JDA/products/master-services/'+b.masterServiceId+'/timeslots$'));
  const body=JSON.parse(options.body);assert.equal(body.studioId,b.studioId);assert.equal(body.roomId,b.roomId);assert.deepEqual(body.subServiceIds,[b.subServiceId]);
  const payment=Payment.paymentPayload(b,interval());assert.equal(payment.studioId,b.studioId);assert.equal(payment.roomId,b.roomId);assert.deepEqual(payment.subServiceIds,[b.subServiceId]);
 }
});
test('price change and unavailable interval prevent payment POST',async t=>{
 setup(t,'005JDAAuthToken='+token);const calls=[];let available=true;
 t.mock.method(globalThis,'fetch',async url=>{calls.push(url);if(url.includes('/validate'))return response({available});if(url.includes('/price?'))return response({[binding.subServiceId]:{net:200}});throw Error('unexpected payment');});
 await assert.rejects(Payment.createPayment(binding,interval(100),60),/Стоимость изменилась/);
 available=false;await assert.rejects(Payment.createPayment(binding,interval(100),60),/время уже недоступно/);
 assert.ok(calls.every(url=>!url.includes('/pay')));
});
test('ambiguous payment is never resubmitted, including after module reload',async t=>{
 const store=setup(t,'005JDAAuthToken='+token);let payments=0;
 t.mock.method(globalThis,'fetch',async url=>{
  if(url.includes('/validate'))return response({available:true});
  if(url.includes('/price?'))return response({[binding.subServiceId]:{net:100}});
  if(url.endsWith('/pay/preview'))return response({});
  if(url.endsWith('/pay')){payments++;throw Error('connection closed after submission');}
  throw Error('unexpected endpoint '+url);
 });
 const chosen=interval();await assert.rejects(Payment.createPayment(binding,chosen,60),{code:'PAYMENT_UNKNOWN'});
 assert.equal((await Payment.createPayment(binding,chosen,60)).phase,'unknown');
 const reloaded=await import('../src/viva-payment.js?reload=1');
 assert.equal((await reloaded.createPayment(binding,chosen,60)).phase,'unknown');
 assert.equal(payments,1);assert.ok(store.has(Payment.attemptKey(binding,chosen)));
});
test('runtime source contains no old tenant and embeds only isolated application roots',()=>{
 const runtime=fs.readdirSync(new URL('../src/',import.meta.url)).filter(x=>x.endsWith('.js')).map(x=>fs.readFileSync(new URL('../src/'+x,import.meta.url),'utf8')).join('\n');
 assert.ok(!runtime.includes('iSkq6G'));
 assert.ok(!runtime.includes('window.ARENA_DATA'));
 assert.match(fs.readFileSync(new URL('../scripts/build.mjs',import.meta.url),'utf8'),/attachShadow/);
});
