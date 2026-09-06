import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { BSON } from 'mongodb';
import { DEFERRED, sha256, stableJson, buildPiterDeferredAttestation,
  validateDeferredRefundCaseAgainstExpectedPin, validateProductionDeferredRefundCases,
  buildPiterDeferredActivationPacket, validatePiterDeferredActivationPacket,
  buildPiterDeferredSentinel, digestDeferredDocuments, assertFreshDeferredProviderRecheck } from '../lib/piterDeferredActivationContract.mjs';
import { buildPiterDeferredLedgerPlan } from '../lib/piterDeferredLedgerOperations.mjs';
import { validatePiterAtomicActivationPacket } from '../lib/piterAtomicActivationContract.mjs';
import { runDeferredLedgerOperation, parseArgs, expectedDeferredPostimage, digestDeferredBsonDocuments,
  assertDeferredRuntimeStopped, assertDeferredPublicationReadback, deferredPm2Identity, deferredStartEnvironment,
  assertDeferredStartGrant, assertDeferredQuiescenceProof, performDeferredGuardedStart, publishDeferredStartEvidence,
  PITER_DEFERRED_PRIVATE_PATHS, assertDeferredPrivateDirectory, assertNoLegacyDeferredStartEvidence } from '../manage_piter_deferred_ledger.mjs';
const ejson = v=>BSON.EJSON.stringify(v,null,2,{relaxed:false});

test('private-directory relocation cannot bypass old consumed/result or partial evidence',()=>{
  const absent=()=>{throw Object.assign(new Error('missing'),{code:'ENOENT'});};
  assertNoLegacyDeferredStartEvidence({lstatSync:absent});
  const files=['/root/.node-red/.padlhub-piter-only-start-consumed.json','/root/.node-red/.padlhub-piter-only-start-result.json'];
  for(const file of files.flatMap(p=>[p,p+'.pending'])){
    for(const stat of [{isFile:()=>true},{isSymbolicLink:()=>true},{isDirectory:()=>true}]){
      assert.throws(()=>assertNoLegacyDeferredStartEvidence({lstatSync:p=>p===file?stat:absent()}),/reviewed recovery/);
    }
  }
  assert.throws(()=>assertNoLegacyDeferredStartEvidence({lstatSync:()=>{throw Object.assign(new Error('private'),{code:'EACCES'});}}),/custody unknown/);
});

test('fixed Piter private paths do not change shared Node-RED permissions or accept old paths',()=>{
  const directory='/root/.node-red/.padlhub-piter-only';
  assert.equal(Object.isFrozen(PITER_DEFERRED_PRIVATE_PATHS),true);
  assert.deepEqual(Object.values(PITER_DEFERRED_PRIVATE_PATHS),[
    'release.json','start-grant.json','start-consumed.json','start-result.json','quiescence.json',
  ].map(name=>`${directory}/${name}`));
  for(const flag of ['--publication-path','--private-directory','--start-grant','--quiescence-proof']){
    assert.throws(()=>parseArgs([flag,'/root/.node-red/.padlhub-piter-only-release.json']),/Unsupported/);
  }
  const stat=(mode=0o755)=>({isDirectory:()=>true,isSymbolicLink:()=>false,uid:0,mode});
  const base={lstatSync:p=>stat(p===directory||p==='/root'?0o700:0o755)};
  assertDeferredPrivateDirectory(directory,0,base);
  assert.throws(()=>assertDeferredPrivateDirectory('/root/.node-red',0,base),/private/);
  for(const target of [directory,'/root/.node-red','/root','/']){
    for(const bad of [{uid:1},{mode:0o777},{isSymbolicLink:()=>true},{isDirectory:()=>false}]){
      const fake={lstatSync:p=>({...base.lstatSync(p),...(p===target?bad:{})})};
      assert.throws(()=>assertDeferredPrivateDirectory(directory,0,fake),/custody|private/);
    }
  }
  for(const mode of [0o755,0o750,0o770,0o000]){
    assert.throws(()=>assertDeferredPrivateDirectory(directory,0,{lstatSync:p=>stat(p===directory?mode:0o755)}),/private|custody/);
  }
});

// Guarded-start fixtures below are entirely synthetic, with no host process,
// provider, Mongo connection or real-person data. The adapter records calls only.
const startTime='2026-09-06T05:30:00.000Z';
const startGrant=()=>({formatVersion:1,operation:'ACTIVATE_AND_START_PITER_ONLY',targetHost:'lk-primary-147',
  ...Object.fromEntries(['contractDigest','candidateSha256','publicationDigest','preimageDigest','mutationDigest',
    'expectedDocumentsDigest','hostIdentitySha256','mongoIdentitySha256','leaseDigest','pm2DefinitionDigest',
    'externalBundleDigest','quiescenceEvidenceDigest'].map(k=>[k,'a'.repeat(64)])),
  preRevision:0,postRevision:1,stoppedRestartCount:2,activationAt:startTime,createdAt:startTime,
  expiresAt:'2026-09-06T05:30:30.000Z',effectiveUserDir:'/root/.node-red',effectiveFlowPath:'/root/.node-red/flows.json'});
const quiescenceProof=grant=>({formatVersion:1,purpose:'PITER_ONLY_START_QUIESCENCE',createdAt:grant.createdAt,expiresAt:grant.expiresAt,
  externalWritersExcluded:true,writerInventoryDigest:'d'.repeat(64),
  ...Object.fromEntries(['hostIdentitySha256','mongoIdentitySha256','candidateSha256','publicationDigest','leaseDigest','preimageDigest',
    'pm2DefinitionDigest','stoppedRestartCount','effectiveUserDir','effectiveFlowPath'].map(k=>[k,grant[k]]))});
function startHarness(){
  const grant=startGrant();let clock=Date.parse(startTime),starts=0,checks=0,consumed=false;
  const receipts=[];
  const stopped={status:'stopped',pid:0,restartCount:2,definitionDigest:grant.pm2DefinitionDigest};
  let processState={...stopped};
  const args={grant,expected:{contractDigest:grant.contractDigest,preRevision:0,postRevision:1},
    readGrant:()=>structuredClone(grant),now:()=>new Date(clock),
    check:async()=>{checks++;return {validUntilMs:Date.parse(startTime)+15_000,fullDocumentsDigest:grant.expectedDocumentsDigest};},
    postcheck:async()=>true,
    consume:()=>{if(consumed)throw Error('consumed');consumed=true;return 'b'.repeat(64);},
    persist:r=>{if(receipts.length)throw Error('exclusive result');receipts.push(r);},
    adapter:{inspect:()=>({...processState}),start:()=>{starts++;processState={...stopped,status:'online',pid:123,restartCount:3};return {ok:true};}}};
  return {args,receipts,starts:()=>starts,checks:()=>checks,consumed:()=>consumed,
    advance:ms=>{clock+=ms;},setState:s=>{processState={...s};}};
}

test('guarded start strict scope, off by default and no path override',async()=>{
  for(const argv of [ ['--guarded-start','--action','seed','--packet','/p','--ledger-file','/l','--active-flow','/f','--expected-revision','0'],
    ['--guarded-start','--action','activate','--packet','/p','--ledger-file','/l','--active-flow','/f','--activation-recheck-file','/e','--expected-revision','0'],
    ['--start-grant','/p'] ])assert.throws(()=>parseArgs(argv));
  for(const options of [{action:'activate',apply:true},{guardedStart:true,action:'seed',apply:true},{guardedStart:true,action:'activate',apply:false}]){
    if(!options.guardedStart)continue;
    await assert.rejects(()=>runDeferredLedgerOperation(options,{env:{}}),/disabled or invalid scope/);
  }
  await assert.rejects(()=>runDeferredLedgerOperation({guardedStart:true,apply:true,action:'activate'},{env:{}}),/disabled/);
  assert.deepEqual(Object.keys(deferredStartEnvironment()).sort(),['HOME','LANG','PATH','PM2_HOME']);
  assert.equal(JSON.stringify(deferredStartEnvironment()).includes('MONGO'),false);
});
test('guarded start grant exact schema, all digest bindings, time, revision and target deny',()=>{
  const g=startGrant(),now=new Date(startTime);assertDeferredStartGrant(g,{},now);
  for(const key of Object.keys(g)){
    const missing={...g};delete missing[key];assert.throws(()=>assertDeferredStartGrant(missing,{},now));
    if(key.endsWith('Digest')||key.endsWith('Sha256')){
      assert.throws(()=>assertDeferredStartGrant({...g,[key]:'b'.repeat(64)},{[key]:g[key]},now));
    }
  }
  for(const delta of [{extra:true},{targetHost:'elsewhere'},{operation:'START_HUB'},{postRevision:2},
    {effectiveUserDir:'/tmp'},{effectiveFlowPath:'/tmp/flows.json'},{activationAt:'2026-09-06T05:30:01.000Z'},
    {createdAt:'2026-09-06T05:30:01.000Z'},{expiresAt:startTime},{activationAt:'2026-09-06T05:28:00.000Z'},
    {activationAt:'2026-09-06T05:29:59.000Z'}])assert.throws(()=>assertDeferredStartGrant({...g,...delta},{},now));
});
test('guarded start quiescence remains a required bound fresh release-owner attestation',()=>{
  const proof=quiescenceProof(startGrant()),now=new Date(startTime);
  const expected={candidateSha256:proof.candidateSha256,preimageDigest:proof.preimageDigest};
  assertDeferredQuiescenceProof(proof,expected,now);
  for(const change of [{externalWritersExcluded:false},{writerInventoryDigest:''},{expiresAt:startTime},
    {candidateSha256:'b'.repeat(64)},{preimageDigest:'b'.repeat(64)},{extra:true}])assert.throws(()=>assertDeferredQuiescenceProof({...proof,...change},expected,now));
  for(const key of Object.keys(proof)){const missing={...proof};delete missing[key];assert.throws(()=>assertDeferredQuiescenceProof(missing,expected,now));}
});
test('guarded start synthetic single dispatch and durable outcome; replay denied',async()=>{
  const h=startHarness(),start=h.args.adapter.start;
  h.args.adapter.start=options=>{assert.equal(options.deadlineMs,Date.parse(startTime)+15_000);return start();};
  const result=await performDeferredGuardedStart(h.args);
  assert.equal(result.state,'STARTED');assert.equal(result.salesOpeningVerified,false);assert.equal(result.retryAuthorized,false);
  assert.equal(h.starts(),1);assert.equal(h.checks(),2);assert.equal(h.receipts.length,1);
  await assert.rejects(()=>performDeferredGuardedStart(h.args));assert.equal(h.starts(),1);
});
test('guarded start before-dispatch failures never start, including consumed intent failure',async()=>{
  const changes=[h=>h.args.readGrant=()=>({...h.args.grant,publicationDigest:'b'.repeat(64)}),
    h=>h.args.check=async()=>{throw Error('C/custody drift');},
    h=>h.args.consume=()=>{throw Error('fsync failed');},
    h=>{let n=0;h.args.check=async()=>{if(++n===2)throw Error('late drift');return {validUntilMs:Date.parse(startTime)+15000};};},
    h=>{let n=0;h.args.adapter.inspect=()=>{if(++n===2)h.advance(14_001);return {status:'stopped',pid:0,restartCount:2,definitionDigest:'a'.repeat(64)};};},
    h=>h.setState({status:'online',pid:12,restartCount:2,definitionDigest:'a'.repeat(64)}),
    h=>h.setState({status:'stopped',pid:0,restartCount:2,definitionDigest:'b'.repeat(64)})];
  for(const change of changes){const h=startHarness();change(h);await assert.rejects(()=>performDeferredGuardedStart(h.args));assert.equal(h.starts(),0);}
});
test('guarded start unknown/extra restart/changed definition never becomes normal success',async()=>{
  for(const failure of ['throw','nonzero','counter','definition','postcustody','inspect','receipt']){
    const h=startHarness(),original=h.args.adapter.start;
    if(failure==='postcustody')h.args.postcheck=async()=>false;
    if(failure==='receipt')h.args.persist=()=>{throw Error('receipt fsync');};
    h.args.adapter.start=()=>{original();if(failure==='throw')throw Error('timeout');if(failure==='nonzero')return {ok:false};
      if(failure==='counter')h.setState({status:'online',pid:123,restartCount:4,definitionDigest:'a'.repeat(64)});
      if(failure==='definition')h.setState({status:'online',pid:123,restartCount:3,definitionDigest:'b'.repeat(64)});
      if(failure==='inspect')h.args.adapter.inspect=()=>{throw Error('inspect unknown');};return {ok:true};};
    if(failure==='receipt')await assert.rejects(()=>performDeferredGuardedStart(h.args));
    else assert.equal((await performDeferredGuardedStart(h.args)).state,'UNKNOWN');
    assert.equal(h.starts(),1);assert.equal(h.consumed(),true);
  }
  const h=startHarness();h.args.adapter.start=()=>({ok:false});
  assert.equal((await performDeferredGuardedStart(h.args)).state,'UNKNOWN');assert.equal(h.consumed(),true);
});
test('guarded start final inspection and deadline reject exit or stale success during postcheck',async()=>{
  for(const failure of ['exit','restart','late','late-before-dispatch']){
    const h=startHarness();
    if(failure==='late-before-dispatch')h.advance(6_001);
    else h.args.postcheck=async()=>{
      if(failure==='late')h.advance(15_001);
      else h.setState({status:failure==='exit'?'stopped':'online',pid:failure==='exit'?0:124,
        restartCount:failure==='exit'?3:4,definitionDigest:'a'.repeat(64)});
      return true;
    };
    if(failure==='late-before-dispatch'){
      await assert.rejects(()=>performDeferredGuardedStart(h.args));assert.equal(h.starts(),0);
    }else{
      assert.equal((await performDeferredGuardedStart(h.args)).state,'UNKNOWN');assert.equal(h.starts(),1);
    }
  }
});
test('guarded start PM2 stable configuration digest binds execution, env and lifecycle',()=>{
  const process={name:'node-red',pm_id:1,pid:0,pm2_env:{status:'stopped',restart_time:2,
    pm_exec_path:'/fixture/node-red.js',pm_cwd:'/fixture',exec_interpreter:'/fixture/node',exec_mode:'fork_mode',
    args:['--userDir','/root/.node-red','/root/.node-red/flows.json'],env:{SYNTHETIC_ONLY:'yes'},autorestart:false}};
  const a=deferredPm2Identity([process]);
  for(const key of ['pm_exec_path','pm_cwd','exec_interpreter','args','env','autorestart']){
    const p=structuredClone(process);p.pm2_env[key]=key==='args'?['/other']:key==='env'?{CHANGED:true}:key==='autorestart'?true:'/other';
    assert.notEqual(deferredPm2Identity([p]).definitionDigest,a.definitionDigest);
  }
  const online=structuredClone(process);online.pid=44;online.pm2_env.status='online';online.pm2_env.restart_time=3;
  assert.equal(deferredPm2Identity([online]).definitionDigest,a.definitionDigest);
  assert.throws(()=>deferredPm2Identity([]));assert.throws(()=>deferredPm2Identity([process,process]));
  const incomplete=structuredClone(process);delete incomplete.pm2_env.pm_exec_path;assert.throws(()=>deferredPm2Identity([incomplete]));
});

test('guarded start evidence uses exclusive durable publication and retains partial failure',()=>{
  // Synthetic filesystem adapter: no actual host paths/files are accessed.
  const files=new Map(),fds=new Map();let next=1;const calls=[];
  const fake={lstatSync:()=>({isDirectory:()=>true,isSymbolicLink:()=>false,uid:0,mode:0o700}),
    openSync:(p,flags)=>{calls.push(['open',flags]);if(flags==='wx'&&files.has(p))throw Error('exists');
      if(flags==='wx')files.set(p,Buffer.alloc(0));fds.set(next,p);return next++;},
    writeFileSync:(fd,bytes)=>files.set(fds.get(fd),bytes),fsyncSync:()=>calls.push(['fsync']),closeSync:()=>{},
    readFileSync:p=>files.get(p),linkSync:(a,b)=>{calls.push(['link']);if(files.has(b))throw Error('exists');files.set(b,files.get(a));}};
  const file='/fixture/intent.json';publishDeferredStartEvidence(file,{state:'CONSUMED'},0,fake);
  assert.equal(files.has(file),true);assert.equal(files.has(file+'.pending'),true);
  assert.ok(calls.findIndex(c=>c[0]==='fsync')<calls.findIndex(c=>c[0]==='link'));
  assert.equal(calls.at(-1)[0],'fsync');assert.throws(()=>publishDeferredStartEvidence(file,{},0,fake));
  const broken={...fake,linkSync:()=>{throw Error('link interrupted');}};
  assert.throws(()=>publishDeferredStartEvidence('/fixture/broken.json',{},0,broken));
  assert.equal(files.has('/fixture/broken.json.pending'),true);assert.equal(files.has('/fixture/broken.json'),false);
});

test('all five original strict files remain byte-identical',()=>{
  const pins={ 'lib/piterAtomicActivationContract.mjs':'9d7592f9249c72eed0b8e9bfe57e43bad4111fd6e1958a3e1a96d84f17626a87',
    'lib/piterAtomicLedgerOperations.mjs':'3ac59e5524c9bff868f7335f817bfe39a102d9a6176d43a00c0a2661b24225c7',
    'prepare_piter_atomic_activation_packet.mjs':'af6c49f279b893516633f468adb1764dd73de1d9d3e338c8cc669854b46d6dcd',
    'manage_piter_atomic_ledger.mjs':'e60249fba1cb6ceeae312699b8d21d37d0daee6b2a75f20bdf9fffb55cdc7c1e',
    'lib/piterLegacySalesReconciliation.mjs':'9483299fb3eb7ce778ac881c13bee0ac2b50b23c95ed3f78bbff5e81792456ce'};
  for(const [file,pin] of Object.entries(pins))assert.equal(sha256(fs.readFileSync(new URL('../'+file,import.meta.url))),pin,file);
});

const hash = v => sha256(stableJson(v));
const pair = () => ({ transaction:{ id:'fixture-refund',clientId:'fixture-client',status:'REFUND',toPay:100,refundSum:90,
  refundedAt:'2026-09-01T12:00:00.000001+03:00',products:[{id:DEFERRED.productId}] },
  subscription:{id:'fixture-sub',clientId:'fixture-client',transactionId:'fixture-refund',productId:DEFERRED.productId,
    status:'REFUNDED',refundSum:90,refundedAt:'2026-09-01T09:00:00.000002'},hasLocal:true });
const pin = p => ({transactionSha256:hash(p.transaction),subscriptionSha256:hash(p.subscription),hasLocal:p.hasLocal});

test('subordinate refund verifier preserves both raw timestamps, partial amount and full hashes',()=>{
  const p=pair(),r=validateDeferredRefundCaseAgainstExpectedPin(p,pin(p));
  assert.equal(r.providerRefundedAt,p.transaction.refundedAt);assert.equal(r.subscriptionRefundedAt,p.subscription.refundedAt);
  assert.equal(r.refundSumMinor,90);assert.equal(r.transactionSha256.length,64);
});
test('synthetic pins can never authorize production, including caller pins override',()=>{
  assert.throws(()=>validateProductionDeferredRefundCases([pair(),pair()]),/REFUND_SET/);
  for(const n of [0,1,3])assert.throws(()=>validateProductionDeferredRefundCases(Array.from({length:n},pair)),/EXACT_TWO/);
  assert.throws(()=>buildPiterDeferredAttestation({pins:[pin(pair())]}),/UNEXPECTED_INPUT/);
});
test('refund pin and semantic negatives remain independent',()=>{
  for(const mutate of [p=>p.transaction.refundedAt+='0',p=>p.subscription.transactionId='other',p=>p.subscription.clientId='other',
    p=>p.subscription.productId='other',p=>p.transaction.uuid='other',p=>p.subscription.transactionUuid='other',
    p=>p.subscription.refundSum=1,p=>p.transaction.refundSum=101,p=>p.subscription.status='ACTIVE',
    p=>p.subscription.refundedAt=p.transaction.refundedAt,p=>p.transaction.state='PAID']){
    const p=pair(),original=pin(p);mutate(p);assert.throws(()=>validateDeferredRefundCaseAgainstExpectedPin(p,original));
    assert.throws(()=>validateDeferredRefundCaseAgainstExpectedPin(p,pin(p)));
  }
});
test('full document digest preserves Date changes and ignores set ordering only',()=>{
  const a=[{_id:'1',at:new Date('2026-01-01')},{_id:'2',x:3}];
  assert.equal(digestDeferredDocuments(a),digestDeferredDocuments([...a].reverse()));
  assert.equal(digestDeferredDocuments(a),digestDeferredDocuments(JSON.parse(JSON.stringify(a))));
  const b=structuredClone(a);b[0].at=new Date('2026-01-02');assert.notEqual(digestDeferredDocuments(a),digestDeferredDocuments(b));
});
test('kind cross-denial and strict CLI action/phrase boundaries',()=>{
  assert.throws(()=>validatePiterDeferredActivationPacket({kind:'PADLHUB_PITER_ATOMIC_SALES_ACTIVATION_V1'}),/PACKET_KIND/);
  assert.throws(()=>validatePiterAtomicActivationPacket({kind:DEFERRED.kind,formatVersion:1}),/identity/);
  assert.throws(()=>parseArgs(['--action','activate','--packet','/fixture','--ledger-file','/fixture','--active-flow','/fixture','--expected-revision','0']),/activation-recheck/);
  assert.throws(()=>parseArgs(['--action','seed','--packet','/fixture','--ledger-file','/fixture','--apply','--active-flow','/fixture','--expected-revision','0']),/forbidden/);
});

// Optional PRIVATE historical records, never copied to the repository or logged.
// Additional product/publication/custody values below are SYNTHETIC test fixtures.
// All resulting in-memory packets expire in September 2026 and are not live evidence.
const privateRoot=process.env.PITER_DEFERRED_TEST_EVIDENCE;
const candidateFile=process.env.PITER_DEFERRED_TEST_CANDIDATE;
const historicalAt='2026-09-05T13:54:05.000Z';
const capturedAt='2026-09-05T13:54:04.500Z';
const envp=(source,query,key,rows)=>({formatVersion:1,complete:true,source,query,capturedAt,
  pagination:{complete:true,pages:1,rowCount:rows.length},[key]:rows});
function historicalInputs(){return Object.fromEntries(['ledgerEvidence','providerEvidence','subscriptionEvidence'].map(k=>[k,JSON.parse(fs.readFileSync(path.join(privateRoot,k+'.json'),'utf8'))]));}
function historicalPacket(){
  const inputs=historicalInputs();const attestation=buildPiterDeferredAttestation({...inputs,createdAt:historicalAt});
  return buildPiterDeferredActivationPacket({attestation,createdAt:historicalAt,
    productEvidence:envp('VIVA_PRODUCTS',{productId:DEFERRED.productId},'products',[{id:DEFERRED.productId,productType:'SUBSCRIPTION',cost:5680000,activationDays:26,validityDays:365,visits:365}]),
    bindingEvidence:envp('NODE_RED_GLOBAL_CONTEXT',{key:'summer_subscription_piter_friendship_product_id'},'values',[{key:'summer_subscription_piter_friendship_product_id',value:DEFERRED.productId}]),
    attemptEvidence:{...envp('MONGO_LK_TOURNAMENT_SUBSCRIPTION_SALES',{inventoryId:'piter_friendship_12m_2026_v1',counterKey:'piter_friendship',includeSentinel:true,includeAtomicSales:true},'rows',inputs.ledgerEvidence.rows),canonicalDocumentsSha256:digestDeferredBsonDocuments(inputs.ledgerEvidence.rows,ejson)},
    publication:{runtimeSourceTree:DEFERRED.runtimeSourceTree,sourceCommit:'a'.repeat(40),releaseManifestSha256:'b'.repeat(64),candidateSha256:DEFERRED.candidateSha256,forwardContractSha256:DEFERRED.forwardContractSha256}});
}
const privateTest=(name,fn)=>test(name,{skip:!privateRoot},fn);
privateTest('historical opt-in attestation: 41 cash, five free, two deferred, quota9; expired at real clock',()=>{
  const p=historicalPacket();assert.equal(p.baseline.paidCount,41);assert.equal(p.evidence.providerOnlyFreeIssueCount,5);
  assert.equal(p.attestation.refunds.length,2);assert.equal(p.attestation.terminal.length,89);assert.equal(p.launchQuota.adjustment,9);
  assert.equal(p.reconciliationOutcome,'DEFERRED');assert.equal(p.legacyMutationPerformed,false);
  validatePiterDeferredActivationPacket(p,{now:historicalAt});
  assert.throws(()=>validatePiterDeferredActivationPacket(p,{now:'2026-09-05T14:00:00.000Z'}),/EXPIRED/);
  assert.throws(()=>validatePiterAtomicActivationPacket(p),/identity/);
});
privateTest('complete snapshot, aliases, pin, paid/free, pending and freshness negative matrix',()=>{
  const mutate=[e=>e.providerEvidence.pagination.complete=false,e=>e.ledgerEvidence.rows.pop(),
    e=>e.providerEvidence.transactions.push(e.providerEvidence.transactions[0]),e=>e.providerEvidence.query.extra=true,
    e=>e.subscriptionEvidence.clients[0].pagination.complete=false,e=>e.subscriptionEvidence.clients[0].subscriptions=[],
    e=>e.providerEvidence.transactions.find(t=>t.status==='REFUND').refundedAt+='0',
    e=>e.providerEvidence.transactions.find(t=>t.status==='UNPAID').paymentDueDate='2026-10-01T00:00:00Z',
    e=>e.providerEvidence.transactions.find(t=>t.status==='UNPAID').paymentDate='2026-09-01T00:00:00Z',
    e=>e.providerEvidence.transactions.find(t=>t.status==='PAID'&&t.toPay>0).discount=0,
    e=>e.ledgerEvidence.rows.find(r=>r.status==='PAID').status='PAYMENT_PENDING',
    e=>e.providerEvidence.capturedAt='2026-09-05T13:40:00.000Z'];
  for(const change of mutate){const e=historicalInputs();change(e);assert.throws(()=>buildPiterDeferredAttestation({...e,createdAt:historicalAt}));}
  const p=historicalPacket();for(const change of [p=>p.launchQuota.adjustment++,p=>p.inputs.publication.candidateSha256='c'.repeat(64),
    p=>p.attestation.providerOnlyFreeIssueCount=0,p=>p.inputs.productEvidence.products[0].activationDays=0]){
    const c=structuredClone(p);change(c);assert.throws(()=>validatePiterDeferredActivationPacket(c,{now:historicalAt}));}
});
privateTest('separate typed path constructs inactive seed then exact activation CAS without legacy rewrites',()=>{
  const p=historicalPacket(),rows=historicalInputs().ledgerEvidence.rows,base={packet:p,documents:rows,activeFlowSha256:DEFERRED.candidateSha256,now:new Date(historicalAt),expectedRevision:0};
  const seed=buildPiterDeferredLedgerPlan({...base,action:'seed'});assert.equal(seed.mutation.document.ready,false);assert.equal(seed.mutation.document.quotaAdjustment,9);
  const after=expectedDeferredPostimage(rows,seed.mutation,p.target.ledgerId);
  assert.equal(digestDeferredDocuments(after.filter(r=>r._id!==p.target.ledgerId)),digestDeferredDocuments(rows));
  const activate=buildPiterDeferredLedgerPlan({...base,documents:after,action:'activate'});
  assert.equal(activate.mutation.filter.ready,false);assert.equal(activate.mutation.filter.schemaVersion,2);assert.equal(activate.mutation.update.$set.ready,true);
  for(const changed of [[...after,{_id:'piter-sale:unexpected'}],after.map((r,i)=>i===0?{...r,status:'FAILED'}:r),after.map(r=>r._id===p.target.ledgerId?{...r,revision:4}:r)])
    assert.throws(()=>buildPiterDeferredLedgerPlan({...base,documents:changed,action:'activate'}));
});
privateTest('fresh provider recheck binds complete unchanged rows and 15-second window',()=>{
  const p=historicalPacket();const e=structuredClone(p.attestation.snapshots.providerEvidence);e.capturedAt=historicalAt;
  assertFreshDeferredProviderRecheck(e,p,historicalAt);
  assert.throws(()=>assertFreshDeferredProviderRecheck(e,p,'2026-09-05T13:54:21.000Z'),/RECHECK/);
  e.transactions.pop();assert.throws(()=>assertFreshDeferredProviderRecheck(e,p,historicalAt));
});

// Local filesystem + in-memory Mongo harness; never opens a network connection.
function harness({action='seed',driftBefore=false,driftAfter=false,ambiguous=false,ackWrong=false,gate={},fsFailure=false,alreadyApplied=false}={}){
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'piter-deferred-test-'));fs.chmodSync(root,0o700);
  const p=historicalPacket();let docs=structuredClone(p.attestation.snapshots.ledgerEvidence.rows);
  if(action==='activate')docs.push(buildPiterDeferredSentinel(p,historicalAt));
  if(alreadyApplied){const plan=buildPiterDeferredLedgerPlan({action,packet:p,documents:docs,activeFlowSha256:DEFERRED.candidateSha256,now:new Date(historicalAt),expectedRevision:0});docs=expectedDeferredPostimage(docs,plan.mutation,p.target.ledgerId);}
  fs.writeFileSync(path.join(root,'packet.json'),JSON.stringify(p),{mode:0o600});
  const bundle=structuredClone({providerEvidence:p.attestation.snapshots.providerEvidence,subscriptionEvidence:p.attestation.snapshots.subscriptionEvidence,
    productEvidence:p.inputs.productEvidence,bindingEvidence:p.inputs.bindingEvidence});
  for(const e of Object.values(bundle))e.capturedAt=historicalAt;
  fs.writeFileSync(path.join(root,'recheck.json'),JSON.stringify(bundle),{mode:0o600});
  let reads=0,writes=0;
  const collection={find(_query,options){assert.equal(options.promoteValues,false);return{toArray:async()=>{reads++;if(driftBefore&&reads===2)docs[0]={...docs[0],drift:true};return BSON.EJSON.parse(ejson(docs),{relaxed:false});}};},
    async insertOne(row){writes++;docs.push(structuredClone(row));if(driftAfter)docs[0].drift=true;if(ambiguous)throw Error('fixture uncertain');return{acknowledged:!ackWrong,insertedId:row._id};},
    async updateOne(filter,update,options){writes++;assert.equal(options.upsert,false);docs=expectedDeferredPostimage(docs,{type:'updateOne',filter,update},p.target.ledgerId);if(driftAfter)docs[0].drift=true;if(ambiguous)throw Error('fixture uncertain');return{acknowledged:!ackWrong,matchedCount:1,modifiedCount:1,upsertedCount:0,upsertedId:null};}};
  const mongo={setName:'fixture',hosts:['fixture'],me:'fixture',primary:'fixture'};
  const options={action,apply:true,packetFile:path.join(root,'packet.json'),activeFlowFile:candidateFile,activationRecheckFile:path.join(root,'recheck.json'),
    expectedRevision:0,expectedContractDigest:p.contractDigest,backupDir:path.join(root,'backup')};
  const env={LK_PITER_DEFERRED_TARGET:'lk-primary-147',LK_PITER_DEFERRED_LEDGER_ACTION:action==='seed'?'DEFERRED_SEED_147':'DEFERRED_ACTIVATE_147',
    LK_PITER_DEFERRED_MONGO_URI:'mongodb://fixture.invalid',LK_PITER_DEFERRED_EXPECTED_HOST_IDENTITY_SHA256:'a'.repeat(64),LK_PITER_DEFERRED_EXPECTED_MONGO_IDENTITY_SHA256:hash(mongo)};
  const deps={env,now:()=>new Date(historicalAt),client:{db:n=>n==='admin'?{command:async()=>mongo}:{collection:()=>collection}},
    expectedUid:process.getuid(),getUid:()=>process.getuid(),verifyDeploymentLock:()=>true,liveFlowPath:candidateFile,
    readHostIdentitySha256:()=> 'a'.repeat(64),readDeploymentLease:()=>({formatVersion:2,deploymentId:DEFERRED.deploymentId,
      sourceSha256:DEFERRED.sourceSha256,candidateSha256:DEFERRED.candidateSha256,phase:'soaking',token:'fixture-only',
      acquiredAtMs:Date.parse('2026-09-05T13:54:00.000Z'),expiresAtMs:Date.parse('2026-09-05T13:59:00.000Z')}),
    inspectStoppedRuntime:()=>({status:'stopped',pid:0,restartCount:2}),readPublicationProof:()=>p.inputs.publication.releaseManifestSha256,
    ejsonStringify:ejson,...gate};
  if(fsFailure)deps.fsImpl=new Proxy(fs,{get(target,k){if(k==='fsyncSync')return()=>{throw Error('fixture fsync failure')};return target[k];}});
  return {options,deps,writeCount:()=>writes,root,packet:p,snapshot:()=>BSON.EJSON.parse(ejson(docs),{relaxed:false})};
}
test('guarded-start connection to existing operator uses exact CAS and synthetic process only',{skip:!privateRoot||!candidateFile},async()=>{
  // Reuse the existing opt-in, private historical CONTRACT fixture. Mongo,
  // process control and evidence writes below remain entirely synthetic adapters.
  for(const failure of ['none','C-drift','grant-drift','already-active','consumed','postcustody']){
    const h=harness({action:'activate',alreadyApplied:failure==='already-active'});
    let starts=0,consumed=false,online=false,receipt=null,checks=0;
    try{
      h.options.guardedStart=true;h.deps.env.LK_PITER_DEFERRED_START_ACTION='DEFERRED_START_PITER_ONLY_147';
      const p=h.packet,before=h.snapshot();
      const plan=buildPiterDeferredLedgerPlan({action:'activate',packet:p,documents:JSON.parse(JSON.stringify(before)),
        activeFlowSha256:DEFERRED.candidateSha256,expectedRevision:0,now:new Date(historicalAt)});
      const grant={...startGrant(),contractDigest:p.contractDigest,candidateSha256:p.deployment.candidateSha256,
        publicationDigest:p.inputs.publication.releaseManifestSha256,activationAt:historicalAt,createdAt:historicalAt,
        expiresAt:'2026-09-05T13:54:35.000Z',hostIdentitySha256:h.deps.readHostIdentitySha256(),
        mongoIdentitySha256:h.deps.env.LK_PITER_DEFERRED_EXPECTED_MONGO_IDENTITY_SHA256,
        leaseDigest:hash(h.deps.readDeploymentLease()),externalBundleDigest:hash(JSON.parse(fs.readFileSync(h.options.activationRecheckFile))),
        preimageDigest:digestDeferredBsonDocuments(before,ejson),mutationDigest:hash(plan.mutation??{}),
        expectedDocumentsDigest:plan.mutation?digestDeferredBsonDocuments(expectedDeferredPostimage(before,plan.mutation,p.target.ledgerId),ejson):'a'.repeat(64)};
      h.deps.readStartGrant=()=>failure==='grant-drift'&&++checks>1?{...grant,quiescenceEvidenceDigest:'b'.repeat(64)}:structuredClone(grant);
      const proof=quiescenceProof(grant);grant.quiescenceEvidenceDigest=hash(proof);
      h.deps.readQuiescenceProof=()=>structuredClone(proof);
      h.deps.assertStartUnused=()=>{if(consumed||failure==='consumed')throw Error('spent');};
      h.deps.consumeStartIntent=()=>{consumed=true;if(failure==='C-drift'){
        const original=h.deps.client.db;h.deps.client.db=n=>n==='admin'?original(n):{collection:()=>({find:()=>({toArray:async()=>[]})})};
        // Mutate the adapter at its actual captured collection instead.
        const collection=original('games').collection();collection.find=()=>({toArray:async()=>[]});
      }return 'b'.repeat(64);};
      h.deps.persistStartResult=r=>{if(receipt)throw Error('exclusive');receipt=r;};
      h.deps.startAdapter={inspect:()=>({status:online?'online':'stopped',pid:online?123:0,restartCount:online?3:2,definitionDigest:grant.pm2DefinitionDigest}),
        start:()=>{starts++;online=true;if(failure==='postcustody')h.deps.env.LK_PITER_DEFERRED_TARGET='drift';return {ok:true};}};
      if(['none','postcustody'].includes(failure)){
        const result=await runDeferredLedgerOperation(h.options,h.deps);
        assert.equal(result.startOutcome.state,failure==='none'?'STARTED':'UNKNOWN');assert.equal(starts,1);assert.equal(h.writeCount(),1);
        assert.equal(result.startOutcome.salesOpeningVerified,false);assert.ok(receipt);
      }else{
        await assert.rejects(()=>runDeferredLedgerOperation(h.options,h.deps));assert.equal(starts,0);
        if(failure!=='C-drift')assert.equal(h.writeCount(),0);
        else{assert.equal(h.writeCount(),1);assert.equal(receipt.state,'START_NOT_DISPATCHED');}
      }
    }finally{fs.rmSync(h.root,{recursive:true,force:true});}
  }
});
test('operator full preimage, custody and ambiguous-write recovery matrix',{skip:!privateRoot||!candidateFile},async()=>{
  assert.equal(sha256(fs.readFileSync(candidateFile)),DEFERRED.candidateSha256);
  for(const action of ['seed','activate'])for(const config of [{},{ambiguous:true},{ackWrong:true},{driftBefore:true},{driftAfter:true},{fsFailure:true},
    {gate:{verifyDeploymentLock:()=>false}},{gate:{getUid:()=>-1}}]){
    const h=harness({action,...config});
    try{
      if(config.driftBefore||config.driftAfter||config.fsFailure||config.gate){await assert.rejects(()=>runDeferredLedgerOperation(h.options,h.deps));assert.equal(h.writeCount(),config.driftAfter?1:0);}
      else{const result=await runDeferredLedgerOperation(h.options,h.deps);assert.equal(h.writeCount(),1);assert.equal(result.postReady,action==='activate');assert.equal(result.ambiguousWriteRecovered,!!(config.ambiguous||config.ackWrong));}
    }finally{fs.rmSync(h.root,{recursive:true,force:true});}
  }
});

test('operator denies each identity/lease/late-loss gate before writes',{skip:!privateRoot||!candidateFile},async()=>{
  const changes=[
    h=>h.deps.env.LK_PITER_DEFERRED_TARGET='elsewhere',
    h=>h.deps.env.LK_PITER_DEFERRED_LEDGER_ACTION='SEED_147',
    h=>h.options.expectedContractDigest='0'.repeat(64),
    h=>h.deps.readHostIdentitySha256=()=> '0'.repeat(64),
    h=>h.deps.env.LK_PITER_DEFERRED_EXPECTED_MONGO_IDENTITY_SHA256='0'.repeat(64),
    h=>{const f=h.deps.readDeploymentLease;h.deps.readDeploymentLease=()=>({...f(),sourceSha256:'0'.repeat(64)});},
    h=>{const f=h.deps.readDeploymentLease;h.deps.readDeploymentLease=()=>({...f(),phase:'completed'});},
    h=>{const f=h.deps.readDeploymentLease;h.deps.readDeploymentLease=()=>({...f(),acquiredAtMs:Date.parse(historicalAt)+1});},
    h=>{const f=h.deps.readDeploymentLease;h.deps.readDeploymentLease=()=>({...f(),expiresAtMs:Date.parse(historicalAt)+10000});},
    h=>{const f=h.deps.readDeploymentLease;let calls=0;h.deps.readDeploymentLease=()=>({...f(),token:++calls>=5?'changed':'fixture-only'});},
    h=>{let calls=0;h.deps.verifyDeploymentLock=()=>++calls<5;},
    h=>{let calls=0;h.deps.now=()=>new Date(++calls>=4?'2026-09-05T14:00:00.000Z':historicalAt);},
    h=>fs.chmodSync(h.options.packetFile,0o644),
    h=>{let reads=0;h.deps.fsImpl=new Proxy(fs,{get(target,key){if(key==='readFileSync')return(file,...args)=>file===candidateFile&&++reads>=4?Buffer.from('drift'):fs.readFileSync(file,...args);return target[key];}});},
    h=>{h.deps.fsImpl=new Proxy(fs,{get(target,key){if(key==='lstatSync')return(file,...args)=>{const st=fs.lstatSync(file,...args);return file===candidateFile?new Proxy(st,{get(s,k){return k==='isSymbolicLink'?()=>true:s[k];}}):st;};return target[key];}});},
  ];
  for(const change of changes){const h=harness();try{change(h);await assert.rejects(()=>runDeferredLedgerOperation(h.options,h.deps));assert.equal(h.writeCount(),0);}finally{fs.rmSync(h.root,{recursive:true,force:true});}}
});
test('seed/activation retry is exact no-op, never a second mutation',{skip:!privateRoot||!candidateFile},async()=>{
  for(const action of ['seed','activate']){const h=harness({action,alreadyApplied:true});try{const result=await runDeferredLedgerOperation(h.options,h.deps);assert.equal(result.alreadyApplied,true);assert.equal(h.writeCount(),0);assert.equal(fs.existsSync(h.options.backupDir),false);}finally{fs.rmSync(h.root,{recursive:true,force:true});}}
});
test('activation recheck bundle rejects each mutable evidence drift/omission/staleness',{skip:!privateRoot||!candidateFile},async()=>{
  for(const mutate of [p=>p.providerEvidence.transactions[0].status='UNKNOWN',p=>p.providerEvidence.capturedAt='2026-09-05T13:54:04.000Z',
    p=>p.providerEvidence.pagination.complete=false,p=>p.subscriptionEvidence.clients[0].subscriptions[0].status='DRIFT',
    p=>p.bindingEvidence.values[0].value='other',p=>p.productEvidence.products[0].activationDays=0,p=>delete p.subscriptionEvidence]){
    const h=harness({action:'activate'});try{const e=JSON.parse(fs.readFileSync(h.options.activationRecheckFile));mutate(e);fs.writeFileSync(h.options.activationRecheckFile,JSON.stringify(e));await assert.rejects(()=>runDeferredLedgerOperation(h.options,h.deps));assert.equal(h.writeCount(),0);}finally{fs.rmSync(h.root,{recursive:true,force:true});}}
});
test('activation samples freshness after custody reads before write',{skip:!privateRoot||!candidateFile},async()=>{
  for(const lateAt of [1,5]){
    const h=harness({action:'activate'});let clockReads=0;
    h.deps.now=()=>new Date(Date.parse(historicalAt)+(++clockReads>=lateAt?14_500:0));
    try{
      await assert.rejects(()=>runDeferredLedgerOperation(h.options,h.deps),/external evidence deadline budget/);
      assert.equal(h.writeCount(),0);
    }finally{fs.rmSync(h.root,{recursive:true,force:true});}
  }
});
test('slow exact postread does not invalidate external freshness proven before CAS',{skip:!privateRoot||!candidateFile},async()=>{
  const h=harness({action:'activate'});
  h.deps.now=()=>new Date(Date.parse(historicalAt)+(h.writeCount()>0?20_000:0));
  try{
    const result=await runDeferredLedgerOperation(h.options,h.deps);
    assert.equal(h.writeCount(),1);assert.equal(result.postReady,true);assert.equal(result.startAuthorized,false);
  }finally{fs.rmSync(h.root,{recursive:true,force:true});}
});

test('canonical BSON comparison distinguishes same-value numeric type drift',()=>{
  const a=[{_id:'fixture',n:new BSON.Int32(1)}],b=[{_id:'fixture',n:new BSON.Double(1)}];
  assert.equal(digestDeferredDocuments(a),digestDeferredDocuments(b));
  assert.notEqual(digestDeferredBsonDocuments(a,ejson),digestDeferredBsonDocuments(b,ejson));
});
test('stopped runtime and publication cannot be self-asserted by a packet',()=>{
  assertDeferredRuntimeStopped({status:'stopped',pid:0,restartCount:1});
  for(const state of [{status:'online',pid:1,restartCount:1},{status:'stopped',pid:1,restartCount:1},{status:'stopped',pid:0,restartCount:-1}])assert.throws(()=>assertDeferredRuntimeStopped(state));
  assert.throws(()=>assertDeferredPublicationReadback({inputs:{publication:{}}},{},{}));
});
test('protected publication binds exact installed dependency closure and canonical descriptor',()=>{
  const names=['manage_piter_deferred_ledger.mjs','prepare_piter_deferred_activation.mjs',
    'lib/piterDeferredActivationContract.mjs','lib/piterDeferredLedgerOperations.mjs',
    'lib/piterAtomicActivationContract.mjs','lib/piterAtomicLedgerOperations.mjs','lib/piterAtomicQuotaUpdateContract.mjs',
    'nodered_reviewed_flow_deploy/deploy_reviewed_flow_147_remote.mjs','nodered_reviewed_flow_deploy/runtime_contract.mjs'];
  const installed=Object.fromEntries(names.map(name=>[name,sha256(fs.readFileSync(new URL('../'+name,import.meta.url)))]));
  const descriptor={formatVersion:1,sourceCommit:'a'.repeat(40),runtimeSourceTree:DEFERRED.runtimeSourceTree,
    candidateSha256:DEFERRED.candidateSha256,forwardContractSha256:DEFERRED.forwardContractSha256,scriptHashes:installed};
  const publication={...descriptor,releaseManifestSha256:hash(descriptor)};
  const packet={inputs:{publication}};
  assertDeferredPublicationReadback(packet,descriptor,installed);
  for(const name of names){
    assert.throws(()=>assertDeferredPublicationReadback(packet,descriptor,{...installed,[name]:'0'.repeat(64)}));
    const missing={...installed};delete missing[name];
    assert.throws(()=>assertDeferredPublicationReadback(packet,descriptor,missing));
  }
  for(const key of ['sourceCommit','runtimeSourceTree','candidateSha256','forwardContractSha256']){
    assert.throws(()=>assertDeferredPublicationReadback({inputs:{publication:{...publication,[key]:'0'.repeat(publication[key].length)}}},descriptor,installed));
  }
  assert.throws(()=>assertDeferredPublicationReadback(packet,{...descriptor,extra:true},installed));
  assert.throws(()=>assertDeferredPublicationReadback(packet,descriptor,{...installed,extra:'0'.repeat(64)}));
});
test('runtime or publication drift at any custody phase stops writes',{skip:!privateRoot||!candidateFile},async()=>{
  for(const kind of ['runtime','publication'])for(const driftAt of [1,2,3,4,5]){
    const h=harness();let calls=0;
    if(kind==='runtime')h.deps.inspectStoppedRuntime=()=>({status:++calls>=driftAt?'online':'stopped',pid:calls>=driftAt?17:0,restartCount:2});
    else h.deps.readPublicationProof=()=>++calls>=driftAt?'0'.repeat(64):'b'.repeat(64);
    try{await assert.rejects(()=>runDeferredLedgerOperation(h.options,h.deps));assert.equal(h.writeCount(),0);}finally{fs.rmSync(h.root,{recursive:true,force:true});}
  }
});
privateTest('data-aware stop preserves active reservations; rollback proof is never authority',()=>{
  const p=historicalPacket(),rows=p.attestation.snapshots.ledgerEvidence.rows,seed=buildPiterDeferredSentinel(p,historicalAt);
  const base={packet:p,activeFlowSha256:DEFERRED.candidateSha256,now:new Date(historicalAt),expectedRevision:1};
  const rollback=buildPiterDeferredLedgerPlan({...base,action:'rollback-check',documents:[...rows,seed]});
  assert.equal(rollback.authorizesRollback,false);assert.equal(rollback.outcome,'OFFLINE_FLOW_ROLLBACK_PRECONDITION_SATISFIED');
  const active={...seed,ready:true,revision:1,reservedCount:1,takenCount:42,reservations:[{paymentRef:'fixture-new',state:'CLAIMED',intentFingerprint:'fixture-intent'}]};
  const stop=buildPiterDeferredLedgerPlan({...base,action:'deactivate',reason:'fixture controlled stop',documents:[...rows,active]});
  const after=expectedDeferredPostimage([...rows,active],stop.mutation,p.target.ledgerId).find(r=>r._id===p.target.ledgerId);
  assert.equal(after.ready,false);assert.deepEqual(after.reservations,active.reservations);assert.equal(after.reservedCount,1);assert.equal(after.takenCount,42);
  assert.equal(buildPiterDeferredLedgerPlan({...base,action:'rollback-check',documents:[...rows,after]}).outcome,'OFFLINE_FLOW_ROLLBACK_PRECONDITION_FAILED');
});
