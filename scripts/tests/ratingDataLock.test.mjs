import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { once } from 'node:events';
import { withRatingDataLock } from '../lib/ratingDataLock.mjs';
const linux = process.platform === 'linux';
const watchdog = new URL('../../deploy/rating-worker/run-with-watchdog.sh',import.meta.url).pathname;
const helper = new URL('../lib/ratingDataLock.mjs',import.meta.url).href;
const probe = lock => spawnSync('flock',['-n',lock,'true']).status;

test('Linux: data flock survives awaits, excludes a second writer, and releases on failure', {skip:!linux}, async t => {
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'rating-data-lock-'));t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
 const lock=path.join(root,'data.lock');
 await assert.rejects(withRatingDataLock(async()=>{
  assert.equal(probe(lock),1);await new Promise(resolve=>setTimeout(resolve,30));assert.equal(probe(lock),1);
  const other=spawnSync(process.execPath,['--input-type=module','-e',
   `import {withRatingDataLock} from ${JSON.stringify(helper)};try{await withRatingDataLock(()=>{}, {path:process.argv[1],waitSeconds:0});process.exit(90);}catch(e){if(e.message!=='RATING_DATA_LOCK_BUSY')throw e;}`,
   lock],{encoding:'utf8'});
  assert.equal(other.status,0,other.stderr);throw Error('synthetic failure');
 },{path:lock}),/synthetic failure/);
 assert.equal(probe(lock),0);
 await withRatingDataLock(()=>assert.equal(probe(lock),1),{path:lock});
 assert.equal(probe(lock),0);
});

test('Linux: long scheduled community work excludes another job without blocking FPR data initialization', {skip:!linux}, async t=>{
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'rating-community-lock-'));
 const install=path.join(root,'install'),scripts=path.join(install,'current/scripts');fs.mkdirSync(scripts,{recursive:true});
 fs.writeFileSync(path.join(scripts,'run_rating_worker_147.mjs'),"console.log('ready');process.stdin.resume();setInterval(()=>{},1000);");
 const schedule=path.join(root,'schedule.lock'),data=path.join(root,'data.lock'),logs=path.join(root,'logs');
 const child=spawn('bash',[watchdog,'incremental'],{detached:true,stdio:'ignore',env:{...process.env,
  RATING_WORKER_INSTALL_ROOT:install,RATING_WORKER_LOG_DIR:logs,RATING_WORKER_SCHEDULE_LOCK_FILE:schedule,
  RATING_WORKER_LOCK_FILE:data,RATING_WORKER_INCREMENTAL_HARD_TIMEOUT_SECONDS:'3'}});
 const done=once(child,'exit');
 t.after(async()=>{if(child.exitCode===null){try{process.kill(-child.pid,'SIGTERM');}catch{/* The process group may already have exited. */}}await done;fs.rmSync(root,{recursive:true,force:true});});
 const log=path.join(logs,'incremental.log'),deadline=Date.now()+3000;
 while(!fs.existsSync(log)||!fs.readFileSync(log,'utf8').includes('ready')){
  assert.ok(Date.now()<deadline,'scheduled child readiness');await new Promise(resolve=>setTimeout(resolve,10));
 }
 assert.equal(probe(schedule),1);
 await withRatingDataLock(async()=>{assert.equal(probe(data),1);assert.equal(probe(schedule),1);},{path:data,waitSeconds:0});
 assert.equal(probe(data),0);assert.equal(probe(schedule),1);
});


test('Linux: an orphaned mutating child retains the data lock after runner SIGKILL', {skip:!linux}, async t=>{
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'rating-orphan-lock-'));
 const lock=path.join(root,'data.lock'),ready=path.join(root,'ready'),release=path.join(root,'release'),finished=path.join(root,'finished');
 const childHelper=new URL('../lib/ratingWorkerChildProcess.mjs',import.meta.url).href;
 const mutation=`const fs=require('fs');fs.writeFileSync(${JSON.stringify(ready)},String(process.pid));const timer=setInterval(()=>{if(fs.existsSync(${JSON.stringify(release)})){clearInterval(timer);fs.writeFileSync(${JSON.stringify(finished)},'done');}},10);setTimeout(()=>process.exit(99),5000).unref();`;
 const runnerCode=`import {withRatingDataLock} from ${JSON.stringify(helper)};import {spawnRatingWorkerChild} from ${JSON.stringify(childHelper)};await withRatingDataLock(lockFd=>{const r=spawnRatingWorkerChild(['-e',${JSON.stringify(mutation)}],{lockFd});if(r.status!==0)throw Error('child failed');},{path:${JSON.stringify(lock)}});`;
 const runner=spawn(process.execPath,['--input-type=module','-e',runnerCode],{detached:true,stdio:'ignore'});
 const done=once(runner,'exit');
 t.after(async()=>{fs.writeFileSync(release,'go');if(runner.exitCode===null){try{process.kill(-runner.pid,'SIGKILL');}catch{/* The process group may already have exited. */}}await done;fs.rmSync(root,{recursive:true,force:true});});
 const wait=async check=>{const deadline=Date.now()+3000;while(!check()){assert.ok(Date.now()<deadline);await new Promise(resolve=>setTimeout(resolve,10));}};
 await wait(()=>fs.existsSync(ready));assert.equal(probe(lock),1);
 runner.kill('SIGKILL');await done;
 assert.equal(probe(lock),1,'mutating child continues holding the inherited flock');
 fs.writeFileSync(release,'go');await wait(()=>fs.existsSync(finished));await wait(()=>probe(lock)===0);
});


test('scheduler rejects a data-lock path reused as its whole-run lock',()=>{
 const lock=path.join(os.tmpdir(),'synthetic-shared-rating-lock');
 const result=spawnSync('bash',[watchdog,'incremental'],{encoding:'utf8',env:{...process.env,
  RATING_WORKER_LOCK_FILE:lock,RATING_WORKER_SCHEDULE_LOCK_FILE:lock}});
 assert.equal(result.status,64);assert.match(result.stderr,/distinct paths/);
});
