import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import {fileURLToPath} from 'node:url';
import {execFileSync,spawn} from 'node:child_process';
import {generateKeyPairSync,randomUUID} from 'node:crypto';
import test from 'node:test';
import {MongoClient} from 'mongodb';
import {createBookedOperationAdmissionHandler,createBookedOperationAdmissionOwner,createBookedOperationAdmissionVerifier} from '../lib/bookedOperationAdmission.mjs';
import {createBookedOperationDelegationVerifier,createBookedOperationMongoReader,createBookedOperationReadHandler} from '../lib/bookedOperationRead.mjs';
import {PLAN_RULES_LIMIT_8,HUB_POLICY_LIMIT_8} from '../lib/lk1ActiveBookingLimit.mjs';

const task='b1-booked-operation-admission-20261006';
const mongoUrl=process.env.B1_ADMISSION_MONGO_URL;
const pgUrl=process.env.B1_ADMISSION_PG_URL;
const checkout=process.env.B1_ADMISSION_LK2_CHECKOUT;
const required=process.env.B1_ADMISSION_REQUIRED==='1';
if(required&&(!mongoUrl||!pgUrl||!checkout))throw Error('B1_ADMISSION_PHYSICAL_FIXTURE_REQUIRED');
function ownFixtures() {
  assert.equal(process.env.B1_ADMISSION_ACK,task);
  const ci=process.env.GITHUB_ACTIONS==='true';
  if(ci)assert.match(process.env.GITHUB_RUN_ID||'',/^[1-9][0-9]+$/);
  const mongo=new URL(mongoUrl);const pg=new URL(pgUrl);
  assert.equal(mongo.hostname,'127.0.0.1');assert.equal(mongo.port,'27039');assert.equal(mongo.username,'b1_fixture');assert.ok(mongo.password);
  assert.equal(pg.hostname,'127.0.0.1');assert.equal(pg.port,'55439');assert.equal(pg.pathname,'/b1_admission');assert.equal(pg.username,'b1_fixture');
  for(const [name,port,digest] of [['mongo','27039','sha256:06dac52f00d294982cab93756436a2f67806101b485a34dca758116311338fdd'],['pg','55439','sha256:721873c34ceb9f8d8fc265984940dc982404c105f19ad51be9fdc5970a6080ea']]) {
    const owned=JSON.parse(execFileSync('docker',['inspect',`b1-admission-${name}-20261006`],{encoding:'utf8'}))[0];
    assert.equal(owned.Config.Labels['padlhub.task'],task);assert.equal(owned.State.Running,true);
    if(ci) {
      assert.equal(owned.Config.Labels['padlhub.ci-run'],process.env.GITHUB_RUN_ID);
      const image=JSON.parse(execFileSync('docker',['image','inspect',owned.Image],{encoding:'utf8'}))[0];
      assert.ok(image.RepoDigests.includes(`${name==='pg'?'postgres':'mongo'}@${digest}`),'Pinned CI manifest required');
    } else assert.equal(owned.Image,digest);
    const expectedVolumes=name==='mongo'?['b1-admission-mongo-20261006-data','b1-admission-mongo-20261006-configdb']:['b1-admission-pg-20261006-data'];
    assert.deepEqual(owned.Mounts.map(m=>m.Name).sort(),expectedVolumes.sort());assert.ok(owned.Mounts.every(m=>m.Type==='volume'));
    const ports=Object.values(owned.HostConfig.PortBindings).flat();assert.deepEqual(ports,[{HostIp:'127.0.0.1',HostPort:port}]);
    for(const mount of owned.Mounts){const volume=JSON.parse(execFileSync('docker',['volume','inspect',mount.Name],{encoding:'utf8'}))[0];assert.equal(volume.Labels['padlhub.task'],task);}
  }
  if(ci) {
    for(const [root,head] of [[checkout,process.env.B1_ADMISSION_LK2_HEAD],[fileURLToPath(new URL('../../',import.meta.url)),process.env.B1_ADMISSION_LK1_HEAD]]) {
      assert.match(head||'',/^[a-f0-9]{40}$/);assert.equal(execFileSync('git',['-C',root,'rev-parse','HEAD'],{encoding:'utf8'}).trim(),head);
    }
  } else assert.equal(execFileSync('git',['-C',checkout,'branch','--show-current'],{encoding:'utf8'}).trim(),'codex/lk2-booked-operation-admission-20261006');
  assert.ok(fs.existsSync(checkout+'/scripts/b1-booked-operation-admission-rehearsal.ts'));
}
const listen=async server=>{await new Promise(r=>server.listen(0,'127.0.0.1',r));return `http://127.0.0.1:${server.address().port}`;};
const close=server=>new Promise((resolve,reject)=>server.close(e=>e?reject(e):resolve()));
test('real session/PG -> owning source admission -> physical Mongo -> authorized B1 SDK read, with no business continuation', {skip:!mongoUrl||!pgUrl||!checkout,timeout:45000}, async()=>{
  ownFixtures();
  const client=new MongoClient(mongoUrl,{serverSelectionTimeoutMS:2000,connectTimeoutMS:2000,monitorCommands:true,maxPoolSize:4});
  const commands=[];client.on('commandStarted',e=>commands.push(e.commandName));
  const dbName='b1_admission_'+randomUUID().replaceAll('-','');
  const actor=randomUUID();const providerExerciseId=randomUUID();const userId=randomUUID();const tenantId=randomUUID();const gameId=randomUUID();const mappingId=randomUUID();const targetMappingId=randomUUID();
  const tenantKey='b1-admit-'+tenantId;const subscriptionId=randomUUID();const roomId=randomUUID();
  const startsAt=new Date(Date.now()+86400000*10).toISOString().slice(0,10)+'T09:00:00.000Z';
  const exercise={id:providerExerciseId,typeId:1613,directionId:4588,studioId:'0d5504f6-ea6f-44bb-a9e4-947faf0273ab',roomId,
    timeFrom:startsAt.replace('09:00:00.000Z','12:00:00+03:00'),timeTo:startsAt.replace('09:00:00.000Z','13:00:00+03:00'),durationMinutes:60,maxClientsCount:4};
  const owned={id:subscriptionId,subscriptionId,clientSubscriptionId:subscriptionId,clientId:actor,productId:'db7a5250-7369-4f43-8ac5-9111be24bc74',
    status:'ACTIVE',name:'Synthetic HUB',purchaseDate:'2026-09-05',purchaseAt:'2026-09-05',activationDate:'2026-09-05',expirationDate:'2099-12-31',visitsLeft:10,variant:'BY_VISITS'};
  let providerDrift=false;let loseNextAck=false;let loseNextHttpResponse=false;let providerCalls=0;let providerWrites=0;let inserts=0;const ownerResults=[];const phases=[];
  const mockProvider=http.createServer((req,res)=>{
    providerCalls++;if(req.method!=='GET'){providerWrites++;res.writeHead(405);return res.end();}
    res.setHeader('Content-Type','application/json');
    assert.equal(req.headers.authorization,'Bearer fixture');
    const pathname=new URL(req.url,'http://127.0.0.1').pathname;
    let body;
    if(pathname.endsWith('/profile'))body={id:actor,phone:'0000000000'};
    else if(pathname.endsWith('/exercises/'+providerExerciseId))body={...exercise,availableClientSubscriptions:providerDrift?[]:[owned]};
    else if(pathname.endsWith('/subscriptions'))body={content:[owned],totalElements:1,number:0,totalPages:1,last:true};
    else if(pathname.endsWith('/bookings')||pathname.endsWith('/bookings/history'))body={content:[],totalElements:0,number:0,totalPages:0,last:true};
    else if(pathname.includes('/rooms/'+roomId+'/sub-services/')&&pathname.endsWith('/price'))body={total:12000};
    else {res.writeHead(404);return res.end(JSON.stringify({code:'MOCK_READ_UNSUPPORTED'}));}
    res.writeHead(200);res.end(JSON.stringify(body));
  });
  let collection;let getSnapshot;
  const control=http.createServer(async(req,res)=>{
    let raw='';for await(const c of req)raw+=c;
    const {action}=JSON.parse(raw);
    const readSnapshot=async()=>({rows:await collection.find({}).sort({_id:1}).toArray(),inserts,providerCalls,providerWrites,mongoWrites:commands.filter(c=>['insert','update','delete'].includes(c))});
    if(action==='provider_drift')providerDrift=true;
    else if(action==='restore')providerDrift=false;
    else if(action==='lose_next_insert_ack')loseNextAck=true;
    else if(action==='lose_next_http_response')loseNextHttpResponse=true;
    else if(action==='checkpoint_get')getSnapshot=await readSnapshot();
    else if(action==='assert_get_unchanged'){try{assert.deepEqual(await readSnapshot(),getSnapshot);}catch{res.writeHead(500);return res.end();}}
    else {res.writeHead(400);return res.end();}
    res.writeHead(204);res.end();
  });
  let ownerServer;
  try {
    await client.connect();collection=client.db(dbName).collection('lk_subscription_daily_booking_ops');
    const providerBase=await listen(mockProvider);const controlBase=await listen(control);
    const {publicKey,privateKey}=generateKeyPairSync('rsa',{modulusLength:2048});
    const issuer='https://lk2.example.test';const audience='lk1-admission-synthetic';
    const trust={keys:{'b1-admission-key':publicKey.export({type:'spki',format:'pem'})},issuer,audience,tenantBindings:{[tenantKey]:tenantId}};
    const globalContext={get:key=>key==='subscriptions_lk1_plan_rules'?PLAN_RULES_LIMIT_8:key==='subscriptions_lk1_product_policy'?HUB_POLICY_LIMIT_8:undefined};
    const admit=createBookedOperationAdmissionOwner({
      collection:{find:(...args)=>collection.find(...args),insertOne:async(...args)=>{inserts++;const result=await collection.insertOne(...args);if(loseNextAck){loseNextAck=false;throw Error('Synthetic lost ACK');}return result;}},
      globalContext,onMetric:({phase})=>phases.push(phase),resolveProviderAuthorization:async()=> 'Bearer fixture',
      providerRead:async(path,{authorization,signal})=>{
        const response=await fetch(providerBase+path,{method:'GET',redirect:'error',signal,headers:{Authorization:authorization}});
        return {status:response.status,body:await response.json()};
      },
    });
    const admissionHandler=createBookedOperationAdmissionHandler({verifyDelegation:createBookedOperationAdmissionVerifier(trust),admit:async(...args)=>{const r=await admit(...args);ownerResults.push({status:r.status,code:r.body?.details?.code??r.body?.code??null,reason:r.body?.error??null});return r;}});
    const readHandler=createBookedOperationReadHandler({verifyDelegation:createBookedOperationDelegationVerifier(trust),read:createBookedOperationMongoReader(collection)});
    ownerServer=http.createServer((req,res)=>{
      if(req.url.startsWith('/lk/integrations/v1/booked-operations/'))return readHandler(req,res);
      const end=res.end.bind(res);res.end=(...args)=>{if(loseNextHttpResponse&&res.statusCode===202){loseNextHttpResponse=false;res.destroy();return res;}return end(...args);};
      return admissionHandler(req,res);
    });
    const baseUrl=await listen(ownerServer);
    const child=spawn(process.execPath,['--import',checkout+'/node_modules/tsx/dist/loader.mjs',checkout+'/scripts/b1-booked-operation-admission-rehearsal.ts'],{
      cwd:checkout,env:{PATH:process.env.PATH,TMPDIR:process.env.TMPDIR,NODE_OPTIONS:'--max-old-space-size=768'},stdio:['pipe','pipe','pipe']});
    let output='';let error='';child.stdout.on('data',c=>{output+=c;assert.ok(output.length<10000);});child.stderr.on('data',c=>{error+=c;assert.ok(error.length<20000);});
    child.stdin.end(JSON.stringify({baseUrl,pgUrl,privateKeyPem:privateKey.export({type:'pkcs8',format:'pem'}),issuer,audience,tenantId,tenantKey,userId,providerClientId:actor,mappingId,gameId,providerExerciseId,targetMappingId,
      startsAt,durationMinutes:60,capacity:4,targetVersion:'fixture-v1',controlUrl:controlBase}));
    const watchdog=setTimeout(()=>child.kill('SIGTERM'),35000);
    const code=await new Promise((resolve,reject)=>{child.on('error',reject);child.on('exit',resolve);}).finally(()=>clearTimeout(watchdog));
    // Child failure diagnostics have no credential input echo; errors remain in private LOCAL logs.
    assert.equal(code,0,error+'\nOwner result codes: '+JSON.stringify(ownerResults)+'\nPhases: '+JSON.stringify(phases));
    const proof=JSON.parse(output.trim());assert.equal(proof.result,'PASS');assert.equal(proof.acceptedOperations,4);
    const rows=await collection.find({}).toArray();assert.equal(rows.length,4);
    for(const row of rows) {
      assert.equal(row.state,'PREPARED');assert.equal(row.admissionOnly,true);assert.equal(row.attempts,0);assert.match(row._id,/^lk1-product-v2:/);
      assert.equal(row.padlHubOperation.userId,userId);assert.equal(row.padlHubOperation.tenantId,tenantId);assert.equal(row.padlHubOperation.providerMappingId,mappingId);
      assert.equal(row.lk1.target.eventId,providerExerciseId);assert.equal(row.lk1.target.basePriceMinor,300000);assert.equal(row.lk1.decision.eligible,true);
      for(const field of ['bookingId','upstreamBookingId','transactionId'])assert.equal(row[field],undefined);
      for(const field of ['createAttemptedAt','bookingAttemptedAt','transactionAttemptedAt','checkout'])assert.equal(row.lk1[field],undefined);
    }
    assert.equal(providerWrites,0);assert.ok(providerCalls>0);assert.ok(inserts>=4);assert.equal(commands.includes('update'),false);
    console.log(JSON.stringify({proof:'LOCAL_PHYSICAL_AUTH_PG_MONGO_B1',ownerRecords:rows.length,providerWrites,ownerUpdates:0,sourcePath:true}));
  } finally {
    if(ownerServer?.listening)await close(ownerServer);
    if(mockProvider.listening)await close(mockProvider);if(control.listening)await close(control);
    await client.db(dbName).dropDatabase();await client.close();
  }
});
