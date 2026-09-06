import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { BSON } from 'mongodb';
import { collectDeferredEvidence,collectCompletePages,evidenceUrl,bindingValue,parseCollectorArgs,
  assertCollectorAuthorization,writeCollectorOutput,readEvidenceJson,verifyPackagedDependencies } from '../collect_piter_deferred_activation_evidence.mjs';
import { DEFERRED,sha256,assertFreshDeferredActivationRecheck } from '../lib/piterDeferredActivationContract.mjs';
import { PITER_ATOMIC_ACTIVATION as TARGET } from '../lib/piterAtomicActivationContract.mjs';
import { digestDeferredBsonDocuments } from '../manage_piter_deferred_ledger.mjs';

const ejson=value=>BSON.EJSON.stringify(value,null,2,{relaxed:false});
const scope={inventoryId:TARGET.inventoryId,counterKey:TARGET.counterKey};
const signal=new AbortController().signal;
const page=rows=>({content:rows,totalElements:rows.length,totalPages:rows.length?1:0,number:0});
function fixture(){
  let clock=Date.parse('2026-09-06T13:00:00.000Z'),ticks=0;
  const calls=[],transactions=[1,2].map(n=>({id:`synthetic-refund-${n}`,status:'REFUNDED',clientId:`synthetic-client-${n}`,
    refundedAt:'2026-09-01T12:00:00Z',products:[{id:DEFERRED.productId}]}));
  const documents=[{_id:'synthetic-sale',...scope,amount:new BSON.Int32(19800),captured:new Date('2026-09-01T00:00:00Z')}];
  const adapter={now:()=>clock,monotonic:()=>ticks,ejsonStringify:ejson,
    readCustody:async()=>({host:'a'.repeat(64),flow:DEFERRED.candidateSha256}),
    getPage:async(endpoint,params)=>{
      calls.push({endpoint,params});
      if(endpoint==='/studios')return page([{id:'synthetic-studio'}]);
      if(endpoint==='/transactions')return page(transactions);
      if(endpoint.startsWith('/clients/'))return page([{subscriptionId:`sub-${endpoint.split('/')[2]}`,status:'REFUNDED'}]);
      if(endpoint==='/products/subscriptions')return page([{id:DEFERRED.productId,productType:'SUBSCRIPTION',visits:365}]);
      throw Error('unexpected endpoint');
    },readBinding:async()=>({msg:DEFERRED.productId}),readLedger:async()=>documents};
  return {adapter,calls,documents,transactions,now:()=>clock,advance:ms=>{clock+=ms;ticks+=ms;},wall:ms=>{clock+=ms;},mono:ms=>{ticks+=ms;}};
}
const options={mode:'packet',publication:{sourceCommit:'a'.repeat(40)}};
const packetFrom=(input,createdAt)=>({createdAt,
  attestation:{snapshots:{providerEvidence:input.providerEvidence,subscriptionEvidence:input.subscriptionEvidence}},
  inputs:{productEvidence:input.productEvidence,bindingEvidence:input.bindingEvidence}});

test('CLI is read-only, exact mode/paths and live collection is independently default-off',()=>{
  assert.deepEqual(parseCollectorArgs(['--mode','packet','--output-dir','/private/new']),{mode:'packet',outputDir:'/private/new'});
  for(const args of [[],['--mode','seed','--output-dir','/x'],['--mode','recheck','--output-dir','/x'],
    ['--mode','packet','--output-dir','/x','--packet','/p'],['--mode','packet','--output-dir','relative'],
    ['--mode','packet','--output-dir','/x','--apply','yes'],['--mode','packet','--mode','packet'],
    ['--base-url','https://invalid.example']])assert.throws(()=>parseCollectorArgs(args));
  assert.throws(()=>assertCollectorAuthorization({},0));
  const env={LK_PITER_DEFERRED_TARGET:'lk-primary-147',LK_PITER_DEFERRED_EVIDENCE_ACTION:'COLLECT_PITER_ONLY_147',
    ...Object.fromEntries(['HOST_IDENTITY','MONGO_IDENTITY','COLLECTOR'].map(k=>[`LK_PITER_DEFERRED_EXPECTED_${k}_SHA256`,'a'.repeat(64)])),
    LK_PITER_DEFERRED_VIVA_TOKEN:'synthetic-viva',LK_PITER_DEFERRED_ADMIN_TOKEN:'synthetic-admin',LK_PITER_DEFERRED_MONGO_URI:'synthetic-uri'};
  assertCollectorAuthorization(env,0);
  assert.throws(()=>assertCollectorAuthorization(env,1));
  for(const key of Object.keys(env)){const missing={...env};delete missing[key];assert.throws(()=>assertCollectorAuthorization(missing,0));}
});

test('HTTP destination/query allowlist cannot become another host, product or write route',()=>{
  const u=evidenceUrl('/transactions',{studioId:'synthetic-studio',productIds:DEFERRED.productId,size:500,page:0});
  assert.equal(u.origin,'https://api.vivacrm.ru');assert.equal(u.pathname,'/api/v1/transactions');
  for(const [endpoint,params]of [['https://invalid.example',{}],['/transactions',{productIds:'HUB',studioId:'s',size:500,page:0}],
    ['/studios',{size:500,page:100}],['/clients/../subscriptions',{includeFinished:true,size:500,page:0}],
    ['/clients/%2Fother/subscriptions',{includeFinished:true,size:500,page:0}],
    ['/studios',{size:500,page:0,token:'synthetic'}]])assert.throws(()=>evidenceUrl(endpoint,params));
  assert.equal(bindingValue({value:DEFERRED.productId,msg:DEFERRED.productId}),DEFERRED.productId);
  for(const value of [null,{},'HUB',{value:DEFERRED.productId,msg:'HUB'},{data:{value:1}}])assert.throws(()=>bindingValue(value));
});

test('pagination accepts exact counts and requires final count/metadata/identity consistency',async()=>{
  const rows=Array.from({length:501},(_,i)=>({id:`row-${i}`}));
  const result=await collectCompletePages(async(_,p)=>({content:rows.slice(p.page*500,(p.page+1)*500),
    totalElements:501,totalPages:2,number:p.page}),'/studios',{},()=>{},signal);
  assert.equal(result.rows.length,501);assert.equal(result.pages,2);
  const cases=[async()=>({content:[],items:[]}),async()=>({content:[],totalPages:1,totalElements:1}),
    async()=>({content:[{id:'same'},{id:'same'}]}),async()=>({content:[],totalElements:'0'}),
    async()=>({content:[],totalPages:-1}),async()=>({content:[],number:3}),
    async()=>({content:rows,totalPages:1,totalElements:501}),
    async(_,p)=>p.page===0?{content:rows.slice(0,500),totalPages:2,totalElements:501}:{content:rows.slice(500),totalPages:2,totalElements:502},
    async(_,p)=>p.page===0?{content:rows.slice(0,500),totalPages:2}:{content:rows.slice(500)},
    async()=>({content:rows.slice(0,5),totalPages:2})];
  for(const get of cases)await assert.rejects(()=>collectCompletePages(get,'/studios',{},()=>{},signal));
  await assert.rejects(()=>collectCompletePages(async(_,p)=>Array.from({length:500},(_,i)=>({id:`${p.page}-${i}`})),
    '/studios',{},()=>{},signal),/PAGE_LIMIT/);
});

test('seven inputs include full refund subscriptions and exact canonical BSON attempts',async()=>{
  const h=fixture(),input=await collectDeferredEvidence(options,h.adapter);
  assert.deepEqual(Object.keys(input).sort(),['attemptEvidence','bindingEvidence','ledgerEvidence','productEvidence','providerEvidence','publication','subscriptionEvidence']);
  assert.deepEqual(input.attemptEvidence.query,{...scope,includeSentinel:true,includeAtomicSales:true});
  assert.equal(input.attemptEvidence.canonicalDocumentsSha256,digestDeferredBsonDocuments(h.documents,ejson));
  const changed=[{...h.documents[0],amount:new BSON.Double(19800)}];
  assert.notEqual(input.attemptEvidence.canonicalDocumentsSha256,digestDeferredBsonDocuments(changed,ejson));
  assert.equal(input.subscriptionEvidence.clients.length,2);
  assert.equal(input.subscriptionEvidence.clients[0].subscriptions.length,1);
  assert.equal(input.subscriptionEvidence.query.includeFinished,true);
  assert.equal(input.providerEvidence.transactions[0].refundedAt,'2026-09-01T12:00:00Z');
  assert.deepEqual(input.bindingEvidence.values,[{key:TARGET.productBindingKey,value:DEFERRED.productId}]);
  assert.equal(h.calls.every(c=>['/studios','/transactions','/products/subscriptions'].includes(c.endpoint)||c.endpoint.startsWith('/clients/')),true);
});

test('capture timestamps precede first source reads and may not hide slow pages',async()=>{
  const h=fixture(),begin=h.now(),get=h.adapter.getPage;
  h.adapter.getPage=async(...args)=>{h.advance(100);return get(...args);};
  const input=await collectDeferredEvidence(options,h.adapter);
  assert.equal(input.providerEvidence.capturedAt,new Date(begin).toISOString());
  assert.ok(Date.parse(input.bindingEvidence.capturedAt)>begin);
  assert.ok(Date.parse(input.subscriptionEvidence.capturedAt)<h.now());
});

test('deadline, wall-clock reversal, custody drift and missing binding prevent any output',async()=>{
  for(const mutate of [h=>{h.adapter.readBinding=async()=>{h.advance(15000);return DEFERRED.productId;};},
    h=>{h.adapter.readBinding=async()=>{h.wall(-1);return DEFERRED.productId;};},
    h=>{h.adapter.readBinding=async()=>{h.mono(15001);return DEFERRED.productId;};},
    h=>{let n=0;h.adapter.readCustody=async()=>({revision:++n});},
    h=>{h.adapter.readBinding=async()=>{throw Error('SYNTHETIC_PRIVATE_MARKER');};},
    h=>{h.adapter.readLedger=async()=>[...h.documents,{_id:TARGET.ledgerId,...scope}];},
    h=>{h.adapter.readLedger=async()=>[{...h.documents[0],counterKey:'HUB'}];},
    h=>{h.transactions[0].products[0].id='HUB';}]){
    const h=fixture();mutate(h);await assert.rejects(()=>collectDeferredEvidence(options,h.adapter),error=>{
      assert.equal(error.message,'Piter evidence: CAPTURE_FAILED');return true;
    });
  }
});

test('post-packet four-bundle is exact, freshly captured and leaves nine-second start budget',async()=>{
  const h=fixture(),input=await collectDeferredEvidence(options,h.adapter);
  h.advance(1);const packet=packetFrom(input,new Date(h.now()).toISOString());h.advance(1);
  const result=await collectDeferredEvidence({mode:'recheck',packet},h.adapter);
  assert.deepEqual(Object.keys(result).sort(),['bindingEvidence','productEvidence','providerEvidence','subscriptionEvidence']);
  assertFreshDeferredActivationRecheck(result,packet,new Date(h.now()));
  h.transactions[0].refundedAt='2026-09-01T12:00:01Z';
  // Snapshot objects are independent evidence, not references to a mutable provider adapter.
  assert.equal(input.providerEvidence.transactions[0].refundedAt,'2026-09-01T12:00:00Z');
  await assert.rejects(()=>collectDeferredEvidence({mode:'recheck',packet},h.adapter));
  const slow=fixture(),base=await collectDeferredEvidence(options,slow.adapter),p=packetFrom(base,new Date(slow.now()).toISOString());
  slow.adapter.readBinding=async()=>{slow.advance(6001);return DEFERRED.productId;};
  await assert.rejects(()=>collectDeferredEvidence({mode:'recheck',packet:p},slow.adapter));
  await assert.rejects(()=>collectDeferredEvidence({mode:'recheck',packet:{...packet,createdAt:'2026-09-07T00:00:00.000Z'}},fixture().adapter));
});

test('a hanging request is aborted at the real timer boundary with no result',async t=>{
  t.mock.timers.enable({apis:['setTimeout']});
  const h=fixture();let enter;
  const entered=new Promise(resolve=>{enter=resolve;});
  h.adapter.getPage=async(_endpoint,_params,requestSignal)=>{enter(requestSignal);return new Promise(()=>{});};
  const pending=collectDeferredEvidence(options,h.adapter);
  const requestSignal=await entered;
  t.mock.timers.tick(15000);
  await assert.rejects(()=>pending,/CAPTURE_FAILED/);
  assert.equal(requestSignal.aborted,true);
});

test('bounded HTTP reader always uses GET with redirects refused and keeps errors private',async()=>{
  const calls=[];
  const value=await readEvidenceJson(new URL('https://api.vivacrm.ru/api/v1/studios'),{Authorization:'synthetic'},signal,async(url,opts)=>{
    calls.push({url:String(url),opts});return new Response('{"content":[]}');
  });
  assert.deepEqual(value,{content:[]});assert.equal(calls[0].opts.method,'GET');assert.equal(calls[0].opts.redirect,'error');
  await assert.rejects(()=>readEvidenceJson(new URL('https://api.vivacrm.ru/api/v1/studios'),{},signal,async()=>new Response('private',{status:401})),/HTTP_READ/);
  const large=new Uint8Array(16*1024*1024+1);
  await assert.rejects(()=>readEvidenceJson(new URL('https://api.vivacrm.ru/api/v1/studios'),{},signal,async()=>new Response(large)),/RESPONSE_SIZE/);
});

test('private output has canonical artifact hash and sanitized summary; never overwrites',async t=>{
  const parent=fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(),'piter-collector-test-')));
  fs.chmodSync(parent,0o700);t.after(()=>fs.rmSync(parent,{recursive:true,force:true}));
  const h=fixture(),input=await collectDeferredEvidence(options,h.adapter),output=path.join(parent,'capture');
  const report=writeCollectorOutput(output,input,'packet',process.getuid(),h.now);
  const artifact=fs.readFileSync(path.join(output,report.artifact));
  assert.equal(sha256(artifact),report.sha256);assert.equal(report.mutationPerformed,false);
  assert.equal(fs.statSync(output).mode&0o777,0o700);assert.equal(fs.statSync(path.join(output,report.artifact)).mode&0o777,0o600);
  for(const privateText of ['synthetic-refund','synthetic-client','synthetic-sale','Bearer','refundedAt'])assert.equal(JSON.stringify(report).includes(privateText),false);
  await assert.rejects(async()=>writeCollectorOutput(output,input,'packet',process.getuid(),h.now));
  assert.throws(()=>writeCollectorOutput(path.join(parent,'wrong-owner'),input,'packet',-1,h.now));
  fs.chmodSync(parent,0o755);assert.throws(()=>writeCollectorOutput(path.join(parent,'public'),input,'packet',process.getuid(),h.now));fs.chmodSync(parent,0o700);
  h.advance(15000);assert.throws(()=>writeCollectorOutput(path.join(parent,'expired'),input,'packet',process.getuid(),h.now));
  assert.equal(fs.existsSync(path.join(parent,'expired')),false);
  assert.throws(()=>verifyPackagedDependencies(parent,process.getuid()));
});

test('recheck durable writes preserve nine seconds after every file and directory fsync',async t=>{
  const parent=fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(),'piter-collector-budget-')));
  fs.chmodSync(parent,0o700);t.after(()=>fs.rmSync(parent,{recursive:true,force:true}));
  const originalFsync=fs.fsyncSync;
  for(let delayedStep=1;delayedStep<=4;delayedStep++){
    const h=fixture(),input=await collectDeferredEvidence(options,h.adapter);
    const packet=packetFrom(input,new Date(h.now()).toISOString());h.advance(1);
    const result=await collectDeferredEvidence({mode:'recheck',packet},h.adapter);
    let completedSteps=0;
    const mock=t.mock.method(fs,'fsyncSync',fd=>{
      originalFsync(fd);if(++completedSteps===delayedStep)h.advance(6001);
    });
    try{
      assert.throws(()=>writeCollectorOutput(path.join(parent,`delayed-${delayedStep}`),result,'recheck',process.getuid(),h.now),/OUTPUT_START_BUDGET/);
      assert.equal(completedSteps,delayedStep);
    }finally{mock.mock.restore();}
  }
});

test('CLI without explicit read authorization has no adapters, connections or private error output',()=>{
  const script=fileURLToPath(new URL('../collect_piter_deferred_activation_evidence.mjs',import.meta.url));
  const r=spawnSync(process.execPath,[script,'--mode','packet','--output-dir','/not-used'],{env:{PATH:process.env.PATH},encoding:'utf8'});
  assert.equal(r.status,1);assert.equal(r.stdout,'');
  assert.equal(r.stderr.trim(),'Piter evidence collection blocked; no business mutation. Do not use partial output.');
});
