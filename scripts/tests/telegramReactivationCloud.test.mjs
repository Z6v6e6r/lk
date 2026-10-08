import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { test } from 'node:test';
import { compatibleDatabase } from '../telegram_reactivation/mongo_compat.mjs';
import { buildCloudFlow } from '../telegram_reactivation/build_cloud_flow.mjs';

function fixture() {
  const ids=['academy','friendship','group','return'];
  return { manifest:{schemaVersion:1,batchId:'reactivation-20261008-cloud-v2',audienceSnapshotDate:'2026-09-30',
    campaigns:ids.map((campaignId,i)=>({campaignId,recipients:[{chatId:String(1001+i),privateSource:'strip-this'}]}))},
  config:{schemaVersion:1,botId:'1000',credentials:'do-not-embed',campaigns:ids.map(campaignId=>({
    campaignId,type:'photo',fileId:'synthetic_photo_file_id_'+campaignId,text:'Test https://example.invalid/'+campaignId,
    link:'https://example.invalid/'+campaignId,utmConfirmed:true,
    utm:{source:'telegram',medium:'bot',campaign:campaignId,privateSource:'strip-this'},extra:'do-not-embed'}))} };
}

test('driver3 real successful acknowledgements and CAS counts are preserved',async()=>{
  const result={result:{ok:1},matchedCount:1,modifiedCount:1,deletedCount:1,connection:'must-not-escape',ops:['private']};
  const collection={insertOne:async()=>result,updateOne:async()=>result,updateMany:async()=>result,deleteOne:async()=>result};
  const c=compatibleDatabase({collection:()=>collection}).collection('test');
  for(const method of ['insertOne','updateOne','updateMany','deleteOne']) {
    const out=await c[method]({},{});
    assert.equal(out.acknowledged,true);
    assert.equal(out.matchedCount,1);
    assert.equal(out.deletedCount,1);
    assert.equal('connection' in out,false);
    assert.equal('ops' in out,false);
  }
});

test('acknowledgements are never invented for malformed/unacknowledged writes',async()=>{
  for(const result of [{},{result:{ok:0}},null]) {
    const c=compatibleDatabase({collection:()=>({updateOne:async()=>result})}).collection('test');
    await assert.rejects(c.updateOne({},{}),/mongo_ack_missing/);
  }
  const modern={acknowledged:false,matchedCount:0};
  const c=compatibleDatabase({collection:()=>({updateOne:async()=>modern})}).collection('test');
  assert.equal((await c.updateOne({},{})).acknowledged,false);
});

test('driver3 and modern atomic claim outputs unwrap without weakening confirmation',async()=>{
  const row={_id:'row',status:'sending',owner:'owner'};
  for(const result of [{ok:1,value:row},{ok:1,value:null},row,null]) {
    let actualOptions;
    const c=compatibleDatabase({collection:()=>({findOneAndUpdate:async(f,u,o)=>{actualOptions=o;return result;}})}).collection('test');
    assert.equal(await c.findOneAndUpdate({},{$set:{status:'sending'}},{}),result?.value===undefined?result:result.value);
    assert.equal(actualOptions.returnOriginal,undefined);
    assert.equal(actualOptions.returnDocument,'after');
    assert.equal(actualOptions.includeResultMetadata,false);
  }
  const c=compatibleDatabase({collection:()=>({findOneAndUpdate:async()=>({ok:0,value:row})})}).collection('test');
  await assert.rejects(c.findOneAndUpdate({},{}),/claim_not_confirmed/);
  for(const malformed of [{ok:1,value:undefined},{ok:1,value:{}},{ok:1}]) {
    const c=compatibleDatabase({collection:()=>({findOneAndUpdate:async()=>malformed})}).collection('test');
    await assert.rejects(c.findOneAndUpdate({},{}),/claim_not_confirmed/);
  }
});

test('reads, exact counts, cursor aggregate and real index creation delegate directly',async()=>{
  const expected={findOne:'doc',createIndex:'index',countDocuments:7,aggregate:{toArray:async()=>[]}};
  const calls=[];
  const native=Object.fromEntries(Object.entries(expected).map(([k,v])=>[k,(...args)=>{calls.push([k,args]);return v;}]));
  const c=compatibleDatabase({collection:n=>{assert.equal(n,'test');return native;}}).collection('test');
  for(const method of Object.keys(expected)) assert.equal(c[method]({a:1}),expected[method]);
  assert.equal(calls.length,4);
});

test('cloud flow is portable, private, disabled and retains durable runtime controls',()=>{
  const {manifest,config}=fixture();
  const flow=buildCloudFlow(manifest,config);
  const fn=flow.find(n=>n.type==='function');
  const ids=new Set(flow.map(n=>n.id));
  assert.equal(ids.size,flow.length);
  assert.equal(flow[0].disabled,true);
  assert.equal(fn.libs.some(n=>n.var==='fs'),false);
  assert.equal(fn.func.includes('readPrivate'),false);
  assert.equal(fn.func.includes('TG_REACTIVATION_MANIFEST'),false);
  assert.equal(fn.func.includes('TG_REACTIVATION_CONFIG'),false);
  assert.equal(fn.func.includes('strip-this'),false);
  assert.equal(fn.func.includes('do-not-embed'),false);
  assert.ok(fn.func.includes("writeConcern: { w: 'majority', j: true }, readConcern: { level: 'majority' }, readPreference: 'primary'"));
  assert.ok(fn.func.includes('compatibleDatabase(client.db(database))'));
  assert.ok(fn.func.includes("env.get('TG_REACTIVATION_SEND_ENABLED') === 'true'"));
  assert.ok(fn.func.includes("if (context.get('job') === job)"));
  assert.ok(fn.finalize.includes('job.stopped = true'));
  assert.doesNotThrow(()=>new (Object.getPrototypeOf(async function(){}).constructor)('msg',fn.func));
  for(const n of flow) {
    if(n.type==='inject') {assert.equal(n.once,false);assert.equal(n.repeat,'');assert.equal(n.crontab,'');}
    assert.equal(['http in','exec','telegram bot','mongodb'].includes(n.type),false);
    for(const wire of n.wires||[]) for(const id of wire) assert.ok(ids.has(id));
  }
});

test('invalid audiences, unconfirmed posts and token-bearing captions cannot be packaged',()=>{
  const a=fixture();a.manifest.campaigns[1].recipients[0].chatId='1001';
  assert.throws(()=>buildCloudFlow(a.manifest,a.config),/invalid_or_duplicate_endpoint/);
  const b=fixture();b.config.campaigns[0].utmConfirmed=false;
  assert.throws(()=>buildCloudFlow(b.manifest,b.config),/utm_not_confirmed/);
  const c=fixture();c.config.campaigns[0].text+=' '+String(10_000_000)+':'+ 'A'.repeat(32);
  assert.throws(()=>buildCloudFlow(c.manifest,c.config),/credential_in_message_config/);
});

test('generated Function executes with Node-RED globals and automatic async completion',async()=>{
  const {manifest,config}=fixture();
  const source=buildCloudFlow(manifest,config).find(n=>n.type==='function').func;
  const AsyncFunction=Object.getPrototypeOf(async function(){}).constructor;
  const execute=new AsyncFunction('msg','node','context','env','mongo','https','crypto',source);
  for(const action of ['preview','prepare','stop','busy']) {
    const state=new Map(action==='busy'?[['busy',true]]:[]);
    const emitted=[],warnings=[];
    await execute({action:action==='busy'?'preview':action},
      {send:m=>emitted.push(m),warn:m=>warnings.push(m),done:()=>{throw new Error('manual_completion_unexpected');}},
      {get:k=>state.get(k),set:(k,v)=>state.set(k,v)}, {get:()=>undefined}, {}, {}, crypto);
    if(action==='preview') {
      assert.equal(emitted.length,1);
      assert.deepEqual(emitted[0].payload.counts,manifest.campaigns.map(c=>({campaignId:c.campaignId,eligible:1})));
      assert.equal(state.get('busy'),false);
      assert.equal(state.get('job'),null);
    } else if(action==='prepare') {
      assert.deepEqual(emitted,[{payload:{error:'mongo_not_configured',action:'prepare'}}]);
      assert.equal(state.get('busy'),false);
    } else if(action==='stop') assert.deepEqual(emitted,[{payload:{status:'idle'}}]);
    else {assert.deepEqual(emitted,[]);assert.deepEqual(warnings,['reactivation_busy']);}
  }
});

test('cloud import accepts only a bare installed module name, never an npm install spec',()=>{
  const {manifest,config}=fixture();
  const fn=buildCloudFlow(manifest,config,{mongoModule:'tg-reactivation-mongodb'}).find(n=>n.type==='function');
  assert.deepEqual(fn.libs.find(n=>n.var==='mongo'),{var:'mongo',module:'tg-reactivation-mongodb'});
  for(const mongoModule of ['tg-reactivation-mongodb@npm:mongodb@3.7.4','../mongodb',''])
    assert.throws(()=>buildCloudFlow(manifest,config,{mongoModule}),/invalid_mongo_module/);
});
