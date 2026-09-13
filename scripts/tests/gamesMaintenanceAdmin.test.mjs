import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {installMaintenanceHold} from '../nodered_games_maintenance/hot_bootstrap.mjs';
const sourceFile=process.env.HANDOFF_SOURCE;
test('hot bootstrap rejects unknown runtime before any POST',async()=>{
  const calls=[];await assert.rejects(installMaintenanceHold({sourceBytes:Buffer.from('[]'),admin:async(method,url)=>{calls.push([method,url]);return {version:'5.0.0'};}}),/Unreviewed/);
  assert.deepEqual(calls,[['GET','/settings']]);
});
test('hot bootstrap refuses a changed live graph',async()=>{
  let writes=0;await assert.rejects(installMaintenanceHold({sourceBytes:Buffer.from('[]'),admin:async(method,url)=>{
    if(method==='POST')writes++;return url==='/settings'?{version:'4.0.9'}:{rev:'rev',flows:[{id:'foreign'}]};
  }}),/differs/);assert.equal(writes,0);
});
test('pinned private graph: exact revision, nodes deploy, full readback, no retry after ambiguous POST',{skip:!sourceFile},async()=>{
  const sourceBytes=fs.readFileSync(sourceFile), source=JSON.parse(sourceBytes);let submitted,writes=0;
  const admin=async(method,url,body,headers)=>{
    if(url==='/settings')return {version:'4.0.9'};
    if(method==='POST'){writes++;assert.equal(body.rev,'before');assert.equal(headers['Node-RED-Deployment-Type'],'nodes');submitted=body.flows;return {rev:'after'};}
    return submitted?{rev:'after',flows:submitted}:{rev:'before',flows:source};
  };
  const result=await installMaintenanceHold({sourceBytes,admin});
  assert.equal(writes,1);assert.equal(result.readyToRestart,false);assert.equal(result.readyToActivateOrganizer,false);
  let attempts=0;await assert.rejects(installMaintenanceHold({sourceBytes,admin:async(method,url)=>{
    if(url==='/settings')return {version:'4.0.9'};
    if(method==='POST'){attempts++;throw new Error('connection lost');}
    return {rev:'before',flows:source};
  }}),/outcome unknown/);assert.equal(attempts,1);
});
