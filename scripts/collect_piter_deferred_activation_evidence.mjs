#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { performance } from 'node:perf_hooks';
import { DEFERRED, sha256, stableJson, assertFreshDeferredActivationRecheck,
  validatePiterDeferredActivationPacket } from './lib/piterDeferredActivationContract.mjs';
import { PITER_ATOMIC_ACTIVATION as TARGET } from './lib/piterAtomicActivationContract.mjs';
import { PITER_DEFERRED_PRIVATE_PATHS, assertDeferredPrivateDirectory,
  assertDeferredPublicationReadback, digestDeferredBsonDocuments } from './manage_piter_deferred_ledger.mjs';

const FLOW='/root/.node-red/flows.json';
const LEASE='/root/.node-red/.padlhub-reviewed-flow-deploy.lease.json';
const MONGO_SOURCE='MONGO_LK_TOURNAMENT_SUBSCRIPTION_SALES';
const SCOPE=Object.freeze({inventoryId:TARGET.inventoryId,counterKey:TARGET.counterKey});
const ATTEMPT_SCOPE=Object.freeze({...SCOPE,includeSentinel:true,includeAtomicSales:true});
const HEX=/^[a-f0-9]{64}$/;
const fail=code=>{throw new Error(`Piter evidence: ${code}`);};
const jsonValue=value=>JSON.parse(JSON.stringify(value));
const object=value=>value!==null&&typeof value==='object'&&!Array.isArray(value);
const iso=value=>new Date(value).toISOString();
const envelope=(source,query,key,rows,capturedAt,pages)=>({formatVersion:1,complete:true,source,query,
  capturedAt,pagination:{complete:true,pages,rowCount:rows.length},[key]:rows});
const alias=values=>{
  const present=values.filter(v=>v!==undefined&&v!==null&&v!=='');
  if(!present.length||present.some(v=>typeof v!=='string'||!v.trim()||v!==present[0]))fail('IDENTITY');
  return present[0];
};
const id=row=>alias([row?.id,row?.uuid]);
const transactionId=row=>alias([row?.transactionId,row?.paymentId,row?.externalId,row?.id,row?.uuid]);
const clientId=row=>alias([row?.clientId,row?.client?.id,row?.client?.uuid,row?.client?.clientId]);

export function parseCollectorArgs(args){
  const result={};
  const flags={'--mode':'mode','--packet':'packetFile','--output-dir':'outputDir'};
  for(let i=0;i<args.length;i+=2){
    const key=flags[args[i]],value=args[i+1];
    if(!key||Object.hasOwn(result,key)||!value||value.startsWith('--'))fail('ARGUMENT');
    result[key]=value;
  }
  if(!['packet','recheck'].includes(result.mode)||!path.isAbsolute(result.outputDir||''))fail('MODE_OR_OUTPUT');
  if((result.mode==='recheck')!==Boolean(result.packetFile)
    ||(result.packetFile&&!path.isAbsolute(result.packetFile)))fail('PACKET_ARGUMENT');
  return result;
}

// No caller-selected URL, mutation endpoint, authentication flow or token refresh.
export function evidenceUrl(endpoint,params={}){
  const allowed=new Set(['/studios','/transactions','/products/subscriptions']);
  if(!allowed.has(endpoint)&&!/^\/clients\/[A-Za-z0-9_-]{1,128}\/subscriptions$/.test(endpoint))fail('ENDPOINT');
  const keys=Object.keys(params).sort().join(',');
  const expected=endpoint==='/transactions'?'page,productIds,size,studioId'
    :endpoint.startsWith('/clients/')?'includeFinished,page,size':'page,size';
  if(keys!==expected||params.size!==500||!Number.isSafeInteger(params.page)||params.page<0||params.page>=100
    ||(endpoint==='/transactions'&&(params.productIds!==DEFERRED.productId||typeof params.studioId!=='string'||!params.studioId))
    ||(endpoint.startsWith('/clients/')&&params.includeFinished!==true))fail('QUERY');
  const url=new URL(`https://api.vivacrm.ru/api/v1${endpoint}`);
  for(const [key,value]of Object.entries(params))url.searchParams.set(key,String(value));
  return url;
}

export async function collectCompletePages(getPage,endpoint,params,check,signal){
  const rows=[],seen=new Set();let total=null,pagesTotal=null,metadata=null;
  for(let page=0;page<100;page++){
    check();
    const payload=await getPage(endpoint,{...params,size:500,page},signal);check();
    const lists=Array.isArray(payload)?[payload]:['content','data','items'].filter(k=>Array.isArray(payload?.[k])).map(k=>payload[k]);
    if(lists.length!==1)fail('PAGE_SHAPE');
    const part=lists[0];
    if(part.length>500||part.some(row=>!object(row)))fail('PAGE_ROWS');
    const hasTotal=Object.hasOwn(payload,'totalElements'),hasPages=Object.hasOwn(payload,'totalPages');
    const signature=`${hasTotal}/${hasPages}`;
    if(metadata!==null&&metadata!==signature)fail('PAGE_METADATA_DRIFT');metadata=signature;
    if(hasTotal){
      const n=payload.totalElements;
      if(!Number.isSafeInteger(n)||n<0||n>50000||(total!==null&&total!==n))fail('PAGE_TOTAL');total=n;
    }
    if(hasPages){
      const n=payload.totalPages;
      if(!Number.isSafeInteger(n)||n<0||n>100||(pagesTotal!==null&&pagesTotal!==n)
        ||(n===0&&(page!==0||part.length!==0))||(n>0&&page>=n))fail('PAGE_COUNT');pagesTotal=n;
    }
    if(hasTotal&&hasPages&&pagesTotal!==Math.ceil(total/500))fail('PAGE_TOTAL_COUNT');
    if(Object.hasOwn(payload,'number')&&payload.number!==page)fail('PAGE_INDEX');
    for(const row of part){
      const key=endpoint==='/transactions'?transactionId(row):endpoint.startsWith('/clients/')
        ?alias([row.subscriptionId,row.clientSubscriptionId,row.id,row.uuid]):id(row);
      if(seen.has(key))fail('REPEATED_ROW');seen.add(key);rows.push(row);
    }
    const done=pagesTotal!==null?page+1>=pagesTotal:part.length<500;
    if(!done&&part.length!==500)fail('SHORT_NONTERMINAL_PAGE');
    if(done){
      if(total!==null&&rows.length!==total)fail('PAGE_FINAL_COUNT');
      return {rows,pages:page+1};
    }
  }
  fail('PAGE_LIMIT');
}

export function bindingValue(payload){
  const candidates=typeof payload==='string'?[payload]
    :[payload?.value,payload?.data?.value,payload?.msg,payload?.[TARGET.productBindingKey]].filter(v=>v!==undefined);
  if(!candidates.length||candidates.some(v=>v!==DEFERRED.productId))fail('BINDING');
  return DEFERRED.productId;
}

// Test adapters are in-memory; the CLI alone constructs the separately gated live adapter.
// capturedAt is the START of each source read, never an end timestamp that hides old pages.
export async function collectDeferredEvidence(options,adapters){
  const {mode,packet,publication}=options;
  if(!['packet','recheck'].includes(mode)||(mode==='recheck'&&!packet))fail('MODE');
  const now=adapters.now||Date.now,mono=adapters.monotonic||(()=>performance.now());
  const started=now(),tick=mono();let last=started;
  const abort=new AbortController();
  const check=()=>{
    const n=now(),elapsed=mono()-tick;
    if(!Number.isFinite(n)||n<last||elapsed<0||n-started>=15000||elapsed>=15000||abort.signal.aborted)fail('CAPTURE_DEADLINE');
    last=n;return n;
  };
  let timer;
  const expired=new Promise((_,reject)=>{timer=setTimeout(()=>{abort.abort();reject(new Error('Piter evidence: CAPTURE_DEADLINE'));},15000);});
  const execute=async()=>{
    const custody=await adapters.readCustody(abort.signal);check();
    const all=(endpoint,params={})=>collectCompletePages(adapters.getPage,endpoint,params,check,abort.signal);
    const providerAt=iso(check());
    const studios=await all('/studios');if(!studios.rows.length)fail('STUDIOS_EMPTY');
    const transactions=[],seen=new Set();let providerPages=0;
    for(const studio of studios.rows){
      const page=await all('/transactions',{studioId:id(studio),productIds:DEFERRED.productId});
      providerPages+=page.pages;
      for(const row of page.rows){
        const tid=transactionId(row);
        if(seen.has(tid))fail('TRANSACTION_DUPLICATE');seen.add(tid);
        if(row.products?.length!==1||alias([row.products[0].id,row.products[0].uuid,row.products[0].productId,
          row.products[0].subscriptionId,row.products[0].product?.id,row.products[0].product?.uuid])!==DEFERRED.productId)fail('PRODUCT_SCOPE');
        transactions.push(row);
        if(transactions.length>50000)fail('TRANSACTION_LIMIT');
      }
    }
    const providerEvidence=envelope('VIVA_TRANSACTIONS',{productId:DEFERRED.productId},'transactions',transactions,providerAt,providerPages);
    const refunds=transactions.filter(row=>['REFUND','REFUNDED'].includes(alias([row.status,row.state,row.paymentStatus])));
    const transactionIds=refunds.map(transactionId).sort(),clientIds=[...new Set(refunds.map(clientId))].sort();
    const subscriptionAt=iso(check()),clients=[];let subscriptionPages=0;
    for(const cid of clientIds){
      const page=await all(`/clients/${encodeURIComponent(cid)}/subscriptions`,{includeFinished:true});
      subscriptionPages+=page.pages;
      clients.push({clientId:cid,complete:true,pagination:{complete:true,pages:page.pages,rowCount:page.rows.length},subscriptions:page.rows});
    }
    const subscriptionEvidence=envelope('VIVA_CLIENT_SUBSCRIPTIONS',{productId:DEFERRED.productId,transactionIds,includeFinished:true},
      'clients',clients,subscriptionAt,Math.max(1,subscriptionPages));
    const productAt=iso(check()),products=await all('/products/subscriptions');
    const selected=products.rows.filter(row=>id(row)===DEFERRED.productId);
    if(selected.length!==1)fail('PRODUCT_CARDINALITY');
    const productEvidence=envelope('VIVA_PRODUCTS',{productId:DEFERRED.productId},'products',selected,productAt,products.pages);
    const bindingAt=iso(check()),value=bindingValue(await adapters.readBinding(abort.signal));check();
    const bindingEvidence=envelope('NODE_RED_GLOBAL_CONTEXT',{key:TARGET.productBindingKey},'values',
      [{key:TARGET.productBindingKey,value}],bindingAt,1);
    let result={providerEvidence,subscriptionEvidence,productEvidence,bindingEvidence};
    if(mode==='packet'){
      const ledgerAt=iso(check()),documents=await adapters.readLedger(abort.signal);check();
      if(!Array.isArray(documents)||documents.length>50000)fail('LEDGER_SCOPE');
      const rows=jsonValue(documents);
      if(rows.some(row=>row._id===TARGET.ledgerId||String(row._id).startsWith('piter-sale:')
        ||row.inventoryId!==SCOPE.inventoryId||row.counterKey!==SCOPE.counterKey))fail('ATOMIC_STATE_OR_SCOPE');
      const canonicalDocumentsSha256=digestDeferredBsonDocuments(documents,adapters.ejsonStringify);
      result={...result,ledgerEvidence:envelope(MONGO_SOURCE,SCOPE,'rows',rows,ledgerAt,1),
        attemptEvidence:{...envelope(MONGO_SOURCE,ATTEMPT_SCOPE,'rows',rows,ledgerAt,1),canonicalDocumentsSha256},publication};
    }
    const after=await adapters.readCustody(abort.signal);check();
    if(stableJson(custody)!==stableJson(after))fail('CUSTODY_DRIFT');
    if(mode==='recheck'){
      assertFreshDeferredActivationRecheck(result,packet,new Date(check()));
      if(Date.parse(providerAt)+15000-check()<9000)fail('INSUFFICIENT_START_BUDGET');
    }
    result=jsonValue(result);check();return result;
  };
  try{return await Promise.race([execute(),expired]);}
  catch{abort.abort();throw new Error('Piter evidence: CAPTURE_FAILED');}
  finally{clearTimeout(timer);}
}

function ownedFile(file,uid,privateMode=false){
  if(!path.isAbsolute(file)||fs.realpathSync(file)!==file)fail('FILE_PATH');
  for(let dir=path.dirname(file);;dir=path.dirname(dir)){
    const s=fs.lstatSync(dir);
    if(!s.isDirectory()||s.isSymbolicLink()||s.uid!==uid||(s.mode&0o022))fail('ANCESTOR');
    if(dir===path.dirname(dir))break;
  }
  const fd=fs.openSync(file,fs.constants.O_RDONLY|fs.constants.O_NOFOLLOW);
  try{
    const s=fs.fstatSync(fd);
    if(!s.isFile()||s.uid!==uid||s.nlink!==1||(privateMode?(s.mode&0o777)!==0o600:Boolean(s.mode&0o022)))fail('FILE_CUSTODY');
    return fs.readFileSync(fd);
  }finally{fs.closeSync(fd);}
}

export async function readEvidenceJson(url,headers,signal,fetchImpl=fetch){
  const response=await fetchImpl(url,{method:'GET',headers,redirect:'error',signal});
  if(!response.ok||!response.body)fail('HTTP_READ');
  const reader=response.body.getReader(),chunks=[];let count=0;
  try{
    for(;;){const {done,value}=await reader.read();if(done)break;count+=value.byteLength;
      if(count>16*1024*1024)fail('RESPONSE_SIZE');chunks.push(value);}
    return JSON.parse(Buffer.concat(chunks).toString('utf8'));
  }finally{await reader.cancel().catch(()=>{});reader.releaseLock();}
}

export function assertCollectorAuthorization(env,uid){
  if(uid!==0||env.LK_PITER_DEFERRED_TARGET!=='lk-primary-147'
    ||env.LK_PITER_DEFERRED_EVIDENCE_ACTION!=='COLLECT_PITER_ONLY_147')fail('COLLECTION_NOT_AUTHORIZED');
  for(const key of ['LK_PITER_DEFERRED_EXPECTED_HOST_IDENTITY_SHA256','LK_PITER_DEFERRED_EXPECTED_MONGO_IDENTITY_SHA256',
    'LK_PITER_DEFERRED_EXPECTED_COLLECTOR_SHA256'])if(!HEX.test(env[key]||''))fail('IDENTITY_REQUIRED');
  for(const key of ['LK_PITER_DEFERRED_VIVA_TOKEN','LK_PITER_DEFERRED_ADMIN_TOKEN','LK_PITER_DEFERRED_MONGO_URI']){
    if(typeof env[key]!=='string'||!env[key]||/[\r\n]/.test(env[key]))fail('AUTH_INPUT_REQUIRED');
  }
}

// Reviewed offline standalone closure. No npm install, shared driver or optional peer.
export function verifyPackagedDependencies(root,uid=0){
  const files=[];
  const visit=relative=>{
    const file=path.join(root,relative),s=fs.lstatSync(file);
    if(s.isSymbolicLink()||s.uid!==uid||(s.mode&0o022))fail('DEPENDENCY_CUSTODY');
    if(s.isDirectory())for(const name of fs.readdirSync(file))visit(path.join(relative,name));
    else if(s.isFile())files.push({path:relative,sha256:sha256(ownedFile(file,uid)),mode:s.mode&0o777});
    else fail('DEPENDENCY_TYPE');
  };
  for(const relative of ['package.json','package-lock.json','node_modules'])visit(relative);
  files.sort((a,b)=>a.path.localeCompare(b.path,'en'));
  if(files.length!==558||sha256(JSON.stringify(files))!=='ab01492202027e06139a1cd479928c38aa41655a4cd7a50a32274dc8e65363bb')fail('DEPENDENCY_PROVENANCE');
}

async function liveAdapters(env){
  assertCollectorAuthorization(env,process.getuid());
  const here=fileURLToPath(import.meta.url);
  if(sha256(ownedFile(here,0))!==env.LK_PITER_DEFERRED_EXPECTED_COLLECTOR_SHA256)fail('COLLECTOR_PROVENANCE');
  assertDeferredPrivateDirectory(path.dirname(PITER_DEFERRED_PRIVATE_PATHS.publication));
  const descriptor=JSON.parse(ownedFile(PITER_DEFERRED_PRIVATE_PATHS.publication,0,true));
  const publication={sourceCommit:descriptor.sourceCommit,runtimeSourceTree:descriptor.runtimeSourceTree,
    releaseManifestSha256:sha256(stableJson(descriptor)),candidateSha256:descriptor.candidateSha256,
    forwardContractSha256:descriptor.forwardContractSha256};
  // Validate the exact nine-name allowlist BEFORE reading any descriptor-selected path.
  assertDeferredPublicationReadback({inputs:{publication}},descriptor,descriptor.scriptHashes);
  const hashes=Object.fromEntries(Object.keys(descriptor.scriptHashes).map(name=>
    [name,sha256(ownedFile(fileURLToPath(new URL(name,import.meta.url)),0))]));
  assertDeferredPublicationReadback({inputs:{publication}},descriptor,hashes);
  if(!/^[a-f0-9]{40}$/.test(publication.sourceCommit)||publication.runtimeSourceTree!==DEFERRED.runtimeSourceTree
    ||publication.candidateSha256!==DEFERRED.candidateSha256||publication.forwardContractSha256!==DEFERRED.forwardContractSha256)fail('PUBLICATION');
  const packageRoot=path.dirname(path.dirname(here));
  verifyPackagedDependencies(packageRoot);
  const entry=fileURLToPath(import.meta.resolve('mongodb'));
  if(entry!==path.join(packageRoot,'node_modules/mongodb/lib/index.js'))fail('DEPENDENCY_RESOLUTION');
  const mongodb=await import('mongodb');
  if(typeof mongodb.BSON?.EJSON?.stringify!=='function')fail('CANONICAL_BSON_REQUIRED');
  const client=new mongodb.MongoClient(env.LK_PITER_DEFERRED_MONGO_URI,{serverSelectionTimeoutMS:3000,connectTimeoutMS:3000,socketTimeoutMS:3000});
  // Connection and these administrative reads never create or alter business records.
  const readCustody=async signal=>{
    const host=sha256(ownedFile('/etc/machine-id',0).toString().trim());
    if(host!==env.LK_PITER_DEFERRED_EXPECTED_HOST_IDENTITY_SHA256||sha256(ownedFile(FLOW,0))!==DEFERRED.candidateSha256)fail('HOST_OR_FLOW');
    const bytes=ownedFile(LEASE,0,true),lease=JSON.parse(bytes),n=Date.now();
    if(lease.formatVersion!==2||lease.phase!=='soaking'||lease.deploymentId!==DEFERRED.deploymentId
      ||lease.sourceSha256!==DEFERRED.sourceSha256||lease.candidateSha256!==DEFERRED.candidateSha256
      ||typeof lease.token!=='string'||!lease.token.trim()||!Number.isSafeInteger(lease.acquiredAtMs)||lease.acquiredAtMs>n
      ||!Number.isSafeInteger(lease.expiresAtMs)||lease.expiresAtMs<=n||lease.expiresAtMs<=lease.acquiredAtMs)fail('LEASE');
    const hello=await client.db('admin').command({hello:1},{maxTimeMS:3000,signal});
    const identity={setName:hello.setName,hosts:Array.isArray(hello.hosts)?hello.hosts.map(String).sort():[],me:hello.me,primary:hello.primary};
    if(!identity.setName||!identity.hosts.length||!identity.me||!identity.primary)fail('MONGO_IDENTITY');
    const mongo=sha256(stableJson(identity));if(mongo!==env.LK_PITER_DEFERRED_EXPECTED_MONGO_IDENTITY_SHA256)fail('MONGO_TARGET');
    if(sha256(stableJson(JSON.parse(ownedFile(PITER_DEFERRED_PRIVATE_PATHS.publication,0,true))))!==publication.releaseManifestSha256)fail('PUBLICATION_DRIFT');
    return {host,mongo,leaseDigest:sha256(bytes),publicationDigest:publication.releaseManifestSha256};
  };
  return {publication,close:()=>client.close(),readCustody,
    getPage:(endpoint,params,signal)=>readEvidenceJson(evidenceUrl(endpoint,params),
      {Authorization:`Bearer ${env.LK_PITER_DEFERRED_VIVA_TOKEN}`,Accept:'application/json'},signal),
    readBinding:signal=>readEvidenceJson(new URL(`http://127.0.0.1:1880/context/global/${TARGET.productBindingKey}`),
      {Authorization:`Bearer ${env.LK_PITER_DEFERRED_ADMIN_TOKEN}`,Accept:'application/json'},signal),
    readLedger:signal=>client.db('games').collection('lk_tournament_subscription_sales').find({$or:[{_id:TARGET.ledgerId},SCOPE]},
      {readConcern:{level:'majority'},maxTimeMS:3000,promoteValues:false,signal}).limit(50001).toArray(),
    ejsonStringify:value=>mongodb.BSON.EJSON.stringify(value,null,2,{relaxed:false}),
  };
}

export function writeCollectorOutput(outputDir,result,mode,uid=process.getuid(),now=Date.now){
  const parent=path.dirname(outputDir),stat=fs.lstatSync(parent);
  if(!path.isAbsolute(outputDir)||fs.realpathSync(parent)!==parent||!stat.isDirectory()||stat.isSymbolicLink()
    ||stat.uid!==uid||(stat.mode&0o777)!==0o700||fs.existsSync(outputDir))fail('OUTPUT_CUSTODY');
  const evidence=Object.values(result).filter(v=>v?.capturedAt);
  const fresh=()=>{
    const n=now();if(evidence.length!==(mode==='packet'?6:4)
      ||evidence.some(e=>!Number.isFinite(Date.parse(e.capturedAt))||Date.parse(e.capturedAt)>n||n-Date.parse(e.capturedAt)>=15000))fail('OUTPUT_EXPIRED');
    if(mode==='recheck'&&evidence.some(e=>Date.parse(e.capturedAt)+15000-n<9000))fail('OUTPUT_START_BUDGET');
  };
  fresh();fs.mkdirSync(outputDir,{mode:0o700});fresh();
  const filename=mode==='packet'?'activation-input.json':'activation-recheck.json';
  const bytes=Buffer.from(JSON.stringify(result,null,2)+'\n');
  const fd=fs.openSync(path.join(outputDir,filename),'wx',0o600);
  try{fs.writeFileSync(fd,bytes);fs.fsyncSync(fd);}finally{fs.closeSync(fd);}
  fresh();
  const summary={formatVersion:1,mode,artifact:filename,sha256:sha256(bytes),mutationPerformed:false,
    captureStartedAt:evidence.map(e=>e.capturedAt).sort()[0],completedAt:iso(now()),
    counts:Object.fromEntries(Object.entries(result).filter(([,v])=>v?.pagination).map(([key,v])=>[key,v.pagination.rowCount]))};
  fresh();
  const report=fs.openSync(path.join(outputDir,'report.json'),'wx',0o600);
  try{fs.writeFileSync(report,JSON.stringify(summary,null,2)+'\n');fs.fsyncSync(report);}finally{fs.closeSync(report);}
  fresh();
  for(const dir of [outputDir,parent]){fresh();const handle=fs.openSync(dir,'r');try{fs.fsyncSync(handle);}finally{fs.closeSync(handle);}fresh();}
  fresh();return summary;
}

async function main(){
  let adapter;
  try{
    const options=parseCollectorArgs(process.argv.slice(2));
    assertCollectorAuthorization(process.env,process.getuid());
    const packet=options.packetFile?JSON.parse(ownedFile(options.packetFile,0,true)):undefined;
    if(packet)validatePiterDeferredActivationPacket(packet,{now:new Date()});
    adapter=await liveAdapters(process.env);
    if(packet&&stableJson(packet.inputs.publication)!==stableJson(adapter.publication))fail('PACKET_PUBLICATION_DRIFT');
    const result=await collectDeferredEvidence({...options,packet,publication:adapter.publication},adapter);
    console.log(JSON.stringify(writeCollectorOutput(options.outputDir,result,options.mode,0)));
  }catch{console.error('Piter evidence collection blocked; no business mutation. Do not use partial output.');process.exitCode=1;}
  finally{if(adapter)await adapter.close().catch(()=>{});}
}
if(process.argv[1]&&path.resolve(process.argv[1])===fileURLToPath(import.meta.url))await main();
