import test from 'node:test';
import assert from 'node:assert/strict';
import { composeMonthlyFriendshipApi, monthlyApiIds as ids } from '../compose_monthly_friendship_api.mjs';
import { monthlyFriendshipIds as old } from '../compose_monthly_friendship_custody.mjs';
import { monthlyFriendshipSource } from '../lib/monthlyFriendshipSource.mjs';
const fixture = () => {
  const z='fixture-monthly-tab';
  return [{id:z,type:'tab',label:'Synthetic monthly'},
    ...['status_response','purchase_limit','confirm_resolve','purchase_router','atomic'].map(k=>({id:old[k],type:'function',z,name:k,
      func:monthlyFriendshipSource(k),outputs:k==='atomic'?5:1,wires:k==='atomic'?[[old.find],[old.update],[old.projection],[old.response],[old.http]]:[[]]})),
    ...[['find','find'],['update','updateOne'],['projection','updateOne']].map(([k,operation])=>({id:old[k],type:'mongodb4',z,name:k,
      clientNode:'fixture-mongo',collection:'lk_tournament_subscription_sales',operation,output:'toArray',handleDocId:false,wires:[[old.atomic]]})),
    {id:'fixture-mongo',type:'mongodb4-client',name:'Synthetic never connected'},
    {id:old.response,type:'http response',z,wires:[]}, {id:old.http,type:'http request',z,wires:[[old.purchase_router]]}];
};
const compose = f => composeMonthlyFriendshipApi(Buffer.from(JSON.stringify(f)),'monthly-private-fixture');
test('private graph adds exact isolated ingress and preserves every existing byte-level node',()=>{
  const f=fixture(),r=compose(f);assert.equal(r.candidate.length,f.length+Object.keys(ids).length);
  assert.deepEqual(r.candidate.slice(0,f.length),f);assert.ok(r.contract.candidateSha256);
  for(const id of [ids.find,ids.update,ids.projection]){const n=r.candidate.find(n=>n.id===id);assert.equal(n.collection,'lk_tournament_subscription_sales');assert.equal(n.clientNode,'fixture-mongo');}
  assert.deepEqual(r.candidate.find(n=>n.id===ids.catch).scope,[ids.find,ids.update,ids.projection,ids.http]);
});
test('private composition rejects old kernel, foreign storage, duplicate/routed identities and route collision',()=>{
  for(const change of [f=>{f.find(n=>n.id===old.atomic).func+='\n// drift';},f=>{f.find(n=>n.id===old.find).collection='foreign';},
    f=>{f.find(n=>n.id===old.update).clientNode='other';},f=>{f.find(n=>n.id===old.atomic).wires[4]=[old.response];},
    f=>f.push({...f[0],id:ids.router}),f=>f.push({...f[0],id:'collision',url:'/lk/integrations/v1/monthly-friendship/quote'}),
    f=>{f.find(n=>n.id===old.http).wires=[[ids.router]];},f=>f.push(f[0])]) {
    const f=fixture();change(f);assert.throws(()=>compose(f),/MONTHLY_API_/);
  }
});
