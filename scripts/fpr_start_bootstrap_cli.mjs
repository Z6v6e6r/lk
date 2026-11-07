// Private Node-RED child. No credentials, contacts or raw errors cross stdout.
import fs from 'node:fs';import crypto from 'node:crypto';import {spawnSync} from 'node:child_process';import {createRequire} from 'node:module';
/* global __FPR_START_WORKER_HASHES__ */
import {initializeFprStarts} from './lib/fprStartBootstrap.mjs';
let client,lock;
try{
 if(process.getuid()!==0)throw Error('FPR_START_UNAVAILABLE');
 const script=fs.realpathSync(process.argv[1]);
 if(!/^\/opt\/padlhub-fpr-start\/releases\/[a-zA-Z0-9-]+\/bootstrap\.mjs$/.test(script))throw Error('FPR_START_UNAVAILABLE');
 const manifest=JSON.parse(fs.readFileSync(script.replace(/bootstrap\.mjs$/,'release-manifest.json')));
 if(manifest.sourceDirty!==false||manifest.bootstrapSha256!==crypto.createHash('sha256').update(fs.readFileSync(script)).digest('hex'))throw Error('FPR_START_UNAVAILABLE');
 const bytes=fs.readFileSync(0);if(bytes.length>16384)throw Error('FPR_START_ARGUMENTS');
 const input=JSON.parse(bytes);
 const path='/var/lock/padlhub-rating-worker.lock';lock=fs.openSync(path,'a+');
 const stat=fs.fstatSync(lock),actual=fs.statSync(path);
 if(!stat.isFile()||stat.ino!==actual.ino||stat.dev!==actual.dev)throw Error('FPR_START_UNAVAILABLE');
 const held=spawnSync('/usr/bin/flock',['-w','10','-E','75','9'],{stdio:['ignore','ignore','ignore','ignore','ignore','ignore','ignore','ignore','ignore',lock]});
 if(held.status!==0)throw Error('FPR_START_BUSY');
 const runtime='/opt/padlhub-rating-worker/current';
 const expected=typeof __FPR_START_WORKER_HASHES__==='undefined'?null:__FPR_START_WORKER_HASHES__;
 if(!expected||Object.keys(expected).length!==9)throw Error('FPR_START_UNAVAILABLE');
 for(const [file,sha]of Object.entries(expected))if(crypto.createHash('sha256').update(fs.readFileSync(runtime+'/'+file)).digest('hex')!==sha)throw Error('FPR_START_RUNTIME_CHANGED');
 const {MongoClient}=createRequire(runtime+'/package.json')('mongodb');
 const cfg=JSON.parse(fs.readFileSync('/root/.node-red/flows.json')).find(n=>n.id==='4e820638cc39c730'&&n.type==='mongodb4-client'&&n.dbName==='games');
 if(!cfg?.uri)throw Error('FPR_START_UNAVAILABLE');
 client=new MongoClient(cfg.uri,{serverSelectionTimeoutMS:5000,connectTimeoutMS:5000,socketTimeoutMS:10000});
 await client.connect();
 const db=client.db('games');
 for(const name of ['player_rating_state','player_ratings']){const indexes=await db.collection(name).indexes();
  if(!['clientId','playerKey'].every(k=>indexes.some(i=>i.unique&&Object.keys(i.key).length===1&&i.key[k]===1&&(!i.partialFilterExpression||JSON.stringify(i.partialFilterExpression)===JSON.stringify({[k]:{$type:'string'}})))))throw Error('FPR_START_INDEXES_REQUIRED');}
 const indexes=await db.collection('rating_events').indexes();
 if(!indexes.some(i=>i.unique&&Object.keys(i.key).length===1&&i.key.idempotencyKey===1&&!i.partialFilterExpression))throw Error('FPR_START_INDEXES_REQUIRED');
 const result=await initializeFprStarts(db,client,input.clientIds,input.actorId,new Date().toISOString(),{dryRun:input.dryRun===true});
 console.log(JSON.stringify({ok:true,...result}));
}catch(e){console.log(JSON.stringify({ok:false,error:/^FPR_START_[A-Z_]+$/.test(e.message)?e.message:'FPR_START_UNAVAILABLE',
 ...(typeof e.playerId==='string'?{playerId:e.playerId}:{})}));process.exitCode=1;
}finally{if(client)await client.close();if(lock!==undefined)fs.closeSync(lock);}
