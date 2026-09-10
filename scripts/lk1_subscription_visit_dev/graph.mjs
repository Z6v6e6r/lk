import fs from 'node:fs';
import crypto from 'node:crypto';
import { composeGroupSubscriptionPricePreviewArtifacts } from '../patch_nodered_subscription_price_preview.mjs';
import { patchPaidJoinGateway } from '../patch_nodered_subscription_paid_join.mjs';
import { visitLifecycleRuntimeSource } from '../lib/subscriptionVisitRuntimeSource.mjs';
export const ROOTS=['67ba0da85846345a','ecf32036257013bd'];
const sha=b=>crypto.createHash('sha256').update(b).digest('hex');
const root=new URL('../',import.meta.url);
export function buildVisitDevGraph(bytes) {
  // The group composer validates exact historical preimages. This is a new,
  // isolated DEV graph, never a partial production install.
  const flow=composeGroupSubscriptionPricePreviewArtifacts(bytes,'fixture-visit-dev').candidate;
  const byId=new Map(flow.map(n=>[n.id,n]));
  const gateway=byId.get('lk_subscription_booking_router_20260804');
  gateway.func=patchPaidJoinGateway(gateway.func);
  for(const [id,name] of [
    ['lk_split_leave_daily_limit_find_build_20260811','find'],
    ['lk_split_leave_daily_limit_route_20260811','route'],
    ['lk_split_leave_daily_limit_ack_20260811','ack'],
  ]) byId.get(id).func=(name==='route'?visitLifecycleRuntimeSource():'')+fs.readFileSync(new URL(`nodered_games_nodes/fn_split_leave_daily_limit_${name}.js`,root),'utf8');
  byId.get('8f7bd5b482fe9763').wires[4]=['dev-unsupported'];
  const catches=['lk_split_leave_persistence_catch_20260801','lk_split_leave_daily_limit_catch_20260811',
    'lk_subscription_booking_catch_20260804','lk_subscription_product_catch_20260907'];
  const selected=new Set(),todo=[...ROOTS,...catches];
  while(todo.length){const id=todo.pop();if(selected.has(id)||id==='dev-unsupported')continue;
    const n=byId.get(id);if(!n)throw new Error('DEV_GRAPH_MISSING:'+id);
    if(n.type==='debug')continue;
    if(!['http in','http response','function','http request','mongodb4','delay','catch'].includes(n.type))throw new Error('DEV_GRAPH_UNSUPPORTED:'+n.type);
    selected.add(id);todo.push(...(n.wires||[]).flat());}
  const functions=[];
  const invoke=expression=>`global.get('visitDevIO').${expression}.then(value=>{node.send(value);node.done();}).catch(error=>{node.error(error.message,msg);node.done();}); return;`;
  const nodes=[{id:'dev-tab',type:'tab',label:'Isolated subscription paid JOIN',disabled:false}];
  for(const id of selected){const original=byId.get(id);
    let node={id,z:'dev-tab',type:original.type,name:original.name||'',wires:(original.wires||[]).map(w=>w.filter(t=>selected.has(t)||t==='dev-unsupported'))};
    if(original.type==='function'){
      functions.push({id,sha256:sha(original.func)});
      Object.assign(node,{func:original.func,outputs:original.outputs,noerr:0,initialize:'',finalize:'',libs:[]});
    } else if(original.type==='catch')Object.assign(node,{scope:original.scope.filter(id=>selected.has(id)),uncaught:false});
    else if(original.type==='http in')Object.assign(node,{url:original.url,method:original.method,upload:false});
    else if(original.type==='http response')Object.assign(node,{statusCode:'',headers:{}});
    else if(original.type==='delay')Object.assign(node,{type:'function',outputs:1,func:"setTimeout(()=>{node.send(msg);node.done();},10);return;",libs:[]});
    else if(original.type==='http request')Object.assign(node,{type:'function',outputs:1,func:invoke('transport(msg)'),libs:[]});
    else if(original.type==='mongodb4')Object.assign(node,{type:'function',outputs:1,
      func:invoke(`mongo(msg,${JSON.stringify(original.collection)},${JSON.stringify(original.operation)})`),libs:[]});
    nodes.push(node);
  }
  nodes.push({id:'dev-unsupported',z:'dev-tab',type:'function',name:'Unsupported DEV path fails closed',outputs:1,
    func:"msg.statusCode=501;msg.payload={code:'DEV_PATH_NOT_IMPLEMENTED'};return msg;",wires:[['dev-response']]},
    {id:'dev-catch',z:'dev-tab',type:'catch',scope:null,uncaught:true,wires:[['dev-error']]},
    {id:'dev-error',z:'dev-tab',type:'function',outputs:1,func:"msg.statusCode=503;msg.payload={code:'DEV_RUNTIME_ERROR',detail:String(msg.error?.message||'failed')};return msg;",wires:[['dev-response']]},
    {id:'dev-response',z:'dev-tab',type:'http response',statusCode:'',headers:{},wires:[]});
  for(const n of nodes)for(const target of (n.wires||[]).flat())if(!nodes.some(x=>x.id===target))throw new Error('DEV_DANGLING_WIRE');
  return {flow:nodes,sourceSha256:sha(bytes),productionFunctions:functions,
    limitations:['Synthetic provider/payment confirmation','Canonical post-payment branch explicitly unsupported'],
    routes:nodes.filter(n=>n.type==='http in').map(n=>({method:n.method,path:n.url}))};
}
