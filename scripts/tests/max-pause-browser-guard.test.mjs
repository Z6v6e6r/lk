import assert from 'node:assert/strict';
import { createHash, webcrypto } from 'node:crypto';
import test from 'node:test';
import vm from 'node:vm';
import { buildMaxPauseBrowserGuard } from '../nodered_reviewed_flow_deploy/max-pause-browser-guard.mjs';
import { codePointGraphSha256 } from '../nodered_reviewed_flow_deploy/max-pause-body-preserver.mjs';

const script = await buildMaxPauseBrowserGuard();
const target = 'http://127.0.0.1:18801/flows';
const ids = ['e75785ffa19c2e20', 'c1ecd06ce451751b'];
const httpId = 'lk_booked_operation_provider_request_20261021';
const rev = 'synthetic-native-revision';
const hash = value => createHash('sha256').update(value).digest('hex');
const graph = () => [
  { id: ids[0], type: 'inject', repeat: '5', once: true, unicode: 'ёж 🥎' },
  { id: ids[1], type: 'inject', repeat: '5', once: true, d: false },
  { id: httpId, type: 'http request', requestTimeout: '15000', unknown: ['a', 'b'] },
  ...Array.from({length:4854}, (_,i) => ({ id: 'synthetic-'+i, type: 'debug', x:i })),
];
const body = () => { const flows = graph(); flows[0].d = true; flows[1].d = true; delete flows[2].requestTimeout; return { rev, flows }; };
async function setup({ origin = 'http://127.0.0.1:18801', expiryMs=60000, notAfter, topLevel=true } = {}) {
  const sent = [], fetched = [], opened = [];
  class Xhr {
    open(method,url,async=true) { this.nativeOpen = {method,url,async}; opened.push(this.nativeOpen); this.nativeHeaders = []; this.onNativeOpen?.(); }
    setRequestHeader(name,value) { this.nativeHeaders.push([name,value]); }
    send(data) { sent.push({ xhr:this, data }); }
    abort() { this.aborted = true; }
  }
  let release;
  let delay = false;
  const view = { location: { origin, href: origin+'/' }, XMLHttpRequest:Xhr,
    fetch(...args) { fetched.push(args); return Promise.resolve('native-fetch'); },
    crypto: { subtle: { async digest(...args) { if(delay) { delay = false; await new Promise(resolve => { release=resolve; }); } return webcrypto.subtle.digest(...args); } } },
  };
  view.top=topLevel?view:{};
  let now=Date.now(), monotonic=0;
  class FixtureDate extends Date {static now(){return now;}}
  const sourceGraph = graph();
  const seal = { sourceGraph, expectedSourceCodePointSha256:codePointGraphSha256(sourceGraph), expectedPreRevisionSha256:hash(rev), operationId:'offline-rehearsal',notAfter:notAfter??new Date(now+expiryMs).toISOString() };
  const install = vm.runInNewContext(script, { URL, TextEncoder, structuredClone, window:view, Date:FixtureDate,performance:{now:()=>monotonic} });
  const handle = await install(seal);
  function ready({url=target,method='POST',apiVersion='v2',deploymentType='nodes',async=true}={}) {
    const xhr = new Xhr(); xhr.open(method,url,async);
    xhr.setRequestHeader('Node-RED-API-Version',apiVersion);
    xhr.setRequestHeader('Node-RED-Deployment-Type',deploymentType);
    return xhr;
  }
  return { view, install, seal, handle, sent, fetched, opened, ready, delay:()=>{delay=true;}, release:()=>release(),advance:ms=>{now+=ms;monotonic+=ms;},wallBack:ms=>{now-=ms;monotonic+=ms;} };
}
async function settled(env) {
  for(let i=0;i<100 && env.handle.status().state==='VALIDATING';i++) await new Promise(resolve=>setTimeout(resolve,5));
  assert.notEqual(env.handle.status().state,'VALIDATING');
}

test('portable core preserves one omitted field, forwards the original XHR and native header values once',async()=>{
  const env = await setup(), xhr = env.ready();
  const opaqueAuth = { toString() { throw new Error('credential must not be coerced by guard'); } };
  xhr.setRequestHeader('Authorization',opaqueAuth);
  const data = body(), original = JSON.stringify(data); xhr.send(original); await settled(env);
  assert.equal(env.sent.length,1); assert.equal(env.sent[0].xhr,xhr);
  assert.equal(xhr.nativeHeaders.find(([n])=>n==='Authorization')[1],opaqueAuth);
  const expected=graph();expected[0].d=true;expected[1].d=true;
  assert.deepEqual(JSON.parse(env.sent[0].data),{rev,flows:expected});
  assert.equal(JSON.stringify(data),original);
  const audit=env.handle.status();assert.equal(audit.state,'FORWARDED_AWAITING_READBACK');
  assert.equal(audit.forwardedBodySha256,hash(env.sent[0].data));assert.equal(audit.restoredRequestTimeoutCount,1);
  assert.equal(JSON.stringify(audit).includes(rev),false);assert.equal(JSON.stringify(audit).includes('Authorization'),false);
  assert.throws(()=>env.ready().send(original),/CONSUMED/);assert.equal(env.sent.length,1);
});

for(const [name,change] of [
  ['foreign-origin',{url:'https://example.test/flows'}], ['wrong-port',{url:'http://127.0.0.1:18802/flows'}],
  ['query',{url:target+'?force=1'}], ['fragment',{url:target+'#x'}], ['PUT',{method:'PUT'}],
  ['v1',{apiVersion:'v1'}], ['full-deploy',{deploymentType:'full'}], ['flow-deploy',{deploymentType:'flows'}],
]) test('native metadata '+name+' blocks transmission and consumes attempt',async()=>{
  const env=await setup();env.ready(change).send(JSON.stringify(body()));await settled(env);
  assert.equal(env.sent.length,0);assert.equal(env.handle.status().state,'BLOCKED');
  assert.throws(()=>env.ready().send(JSON.stringify(body())),/CONSUMED/);
});

for(const [name,mutate] of [
  ['wrong-revision',b=>b.rev+='changed'], ['extra-envelope',b=>b.force=true],
  ['missing-node',b=>b.flows.pop()], ['extra-node',b=>b.flows.push({id:'extra'})],
  ['duplicate-id',b=>b.flows[4].id=b.flows[3].id], ['foreign-delta',b=>b.flows[4].x=999],
  ['foreign-drop',b=>delete b.flows[4].type], ['one-paused',b=>delete b.flows[1].d],
  ['target-config-delta',b=>b.flows[0].repeat='10'], ['null-timeout',b=>b.flows[2].requestTimeout=null],
  ['number-timeout',b=>b.flows[2].requestTimeout=15000], ['array-reorder',b=>b.flows[2].unknown.reverse()],
]) test('portable payload '+name+' blocks native send',async()=>{
  const env=await setup(),data=body();mutate(data);env.ready().send(JSON.stringify(data));await settled(env);
  assert.equal(env.sent.length,0);assert.equal(env.handle.status().state,'BLOCKED');
});

test('critical duplicate headers cannot silently concatenate a v2 revision guard',async()=>{
  const env=await setup(),xhr=env.ready();xhr.setRequestHeader('node-red-api-version','v2');
  xhr.send(JSON.stringify(body()));await settled(env);assert.equal(env.sent.length,0);
});
test('synchronous native open event cannot bypass validation through reentrant send',async()=>{
  const env=await setup(),xhr=new env.view.XMLHttpRequest();
  xhr.onNativeOpen=()=>xhr.send(JSON.stringify(body()));
  xhr.open('POST',target);await settled(env);
  assert.equal(env.sent.length,0);assert.equal(env.handle.status().state,'BLOCKED');
});
test('synchronous native open event may send only after exact headers and full seal validation',async()=>{
  const env=await setup(),xhr=new env.view.XMLHttpRequest();
  xhr.onNativeOpen=()=>{xhr.setRequestHeader('Node-RED-API-Version','v2');xhr.setRequestHeader('Node-RED-Deployment-Type','nodes');xhr.send(JSON.stringify(body()));};
  xhr.open('POST',target);await settled(env);
  assert.equal(env.sent.length,1);assert.equal(JSON.parse(env.sent[0].data).flows[2].requestTimeout,'15000');
});
test('untracked pre-install XHR cannot send through the new wrapper',async()=>{
  const env=await setup(),xhr=new env.view.XMLHttpRequest();
  assert.throws(()=>xhr.send(JSON.stringify(body())),/UNTRACKED/);assert.equal(env.sent.length,0);
});
test('nested reentrant open state is not overwritten when outer native open returns',async()=>{
  const env=await setup(),xhr=new env.view.XMLHttpRequest();let nested=false;
  xhr.onNativeOpen=()=>{if(!nested){nested=true;xhr.open('POST',target+'?wrong=1');}};
  xhr.open('POST',target);xhr.setRequestHeader('Node-RED-API-Version','v2');xhr.setRequestHeader('Node-RED-Deployment-Type','nodes');
  xhr.send(JSON.stringify(body()));await settled(env);assert.equal(env.sent.length,0);
});
test('abort during digest cannot later send and cannot re-arm the page',async()=>{
  const env=await setup(),xhr=env.ready();env.delay();xhr.send(JSON.stringify(body()));xhr.abort();
  env.release();await settled(env);assert.equal(env.sent.length,0);
  await assert.rejects(env.install(env.seal),/ALREADY_INSTALLED/);
});
test('open reuse during digest cannot send to a changed destination or abort the new request',async()=>{
  const env=await setup(),xhr=env.ready();env.delay();xhr.send(JSON.stringify(body()));
  xhr.open('GET','/unrelated');env.release();await settled(env);
  assert.equal(env.sent.length,0);assert.equal(xhr.aborted,undefined);
  xhr.send();assert.equal(env.sent.length,1);assert.equal(env.sent[0].data,undefined);
});
test('headers are locked while asynchronous validation is pending',async()=>{
  const env=await setup(),xhr=env.ready();env.delay();xhr.send(JSON.stringify(body()));
  assert.throws(()=>xhr.setRequestHeader('Authorization','synthetic-value'),/HEADERS_LOCKED/);
  assert.throws(()=>xhr.setRequestHeader('Node-RED-Deployment-Type','full'),/HEADERS_LOCKED/);
  env.release();await settled(env);assert.equal(env.sent.length,1);
});
test('fetch mutation is blocked and consumes attempt; read-only and unrelated calls remain native',async()=>{
  const env=await setup();await env.view.fetch('/flows');assert.equal(env.fetched.length,1);
  await assert.rejects(env.view.fetch('/flows',{method:'POST',body:'synthetic'}),/FETCH_FORBIDDEN/);
  assert.equal(env.fetched.length,1);assert.throws(()=>env.ready().send(JSON.stringify(body())),/CONSUMED/);
  await env.view.fetch('/unrelated',{method:'POST'});assert.equal(env.fetched.length,2);
});
test('bad JSON never appears in audit or network',async()=>{
  const env=await setup();env.ready().send('private-synthetic-invalid-json');await settled(env);
  assert.equal(env.sent.length,0);assert.equal(JSON.stringify(env.handle.status()).includes('private-synthetic'),false);
});
test('wrong installation origin fails before modifying XHR prototype',async()=>{
  await assert.rejects(setup({origin:'https://example.test'}),/ORIGIN/);
});
test('portable source contains no token acquisition, storage, new HTTP client or CDP interceptor',()=>{
  for(const forbidden of ['localStorage','sessionStorage','document.cookie','new XMLHttpRequest','Fetch.requestPaused','fetch(target','Authorization:']) assert.equal(script.includes(forbidden),false);
});
for(const args of [[false],[0],[null],[''],[undefined],[true,undefined],[true,'user'],[true,'user','password'],[true,null,null],[true,undefined,'password']])test('non-native open authority '+JSON.stringify(args)+' rejected before native open',async()=>{
  const env=await setup(),xhr=new env.view.XMLHttpRequest();
  assert.throws(()=>xhr.open('POST',target,...args),/OPEN_AUTHORITY/);assert.equal(env.opened.length,0);assert.equal(env.sent.length,0);
});
test('actual jQuery five-argument shape with undefined credentials preserves native auth',async()=>{
  const env=await setup(),xhr=new env.view.XMLHttpRequest();
  xhr.open('POST',target,true,undefined,undefined);xhr.setRequestHeader('Node-RED-API-Version','v2');xhr.setRequestHeader('Node-RED-Deployment-Type','nodes');
  xhr.send(JSON.stringify(body()));await settled(env);assert.equal(env.sent.length,1);
});
test('opaque explicit credentials rejected without coercion or native open',async()=>{
  const env=await setup(),xhr=new env.view.XMLHttpRequest(),opaque={toString(){throw new Error('coerced');}};
  assert.throws(()=>xhr.open('POST',target,true,opaque,opaque),/OPEN_AUTHORITY/);assert.equal(env.opened.length,0);
});
test('an extra fake-view argument cannot install into a different realm',async()=>{
  const env=await setup();await assert.rejects(env.install(env.seal,{location:{origin:'http://127.0.0.1:18801'}}),/ARGUMENTS/);
});
test('expiry at send consumes and aborts without native send',async()=>{
  const env=await setup(),xhr=env.ready();env.advance(60000);
  assert.throws(()=>xhr.send(JSON.stringify(body())),/EXPIRED/);assert.equal(env.sent.length,0);assert.equal(xhr.aborted,true);
});
test('expiry during digest blocks the final native send',async()=>{
  const env=await setup(),xhr=env.ready();env.delay();xhr.send(JSON.stringify(body()));env.advance(60000);env.release();await settled(env);
  assert.equal(env.sent.length,0);assert.equal(xhr.aborted,true);
});
test('monotonic expiry survives wall-clock rollback while disconnected',async()=>{
  const env=await setup(),xhr=env.ready();env.wallBack(60001);
  assert.throws(()=>xhr.send(JSON.stringify(body())),/EXPIRED/);assert.equal(env.sent.length,0);
});
for(const expiryMs of [0,-1,600001])test('invalid expiry budget '+expiryMs+' rejects installation',async()=>{await assert.rejects(setup({expiryMs}),/EXPIRY/);});
test('non-canonical UTC expiry rejects installation',async()=>{await assert.rejects(setup({notAfter:'2026-10-27T04:00:00+03:00'}),/EXPIRY/);});
test('subframe installation rejects before any native XHR',async()=>{await assert.rejects(setup({topLevel:false}),/REALM/);});
