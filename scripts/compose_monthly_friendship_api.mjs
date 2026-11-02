import crypto from 'node:crypto';
import { monthlyFriendshipApi } from './lib/monthlyFriendshipApi.mjs';
import { monthlyFriendshipApiSource } from './lib/monthlyFriendshipApiSource.mjs';
import { monthlyFriendshipSource } from './lib/monthlyFriendshipSource.mjs';
import { monthlyFriendshipIds } from './compose_monthly_friendship_custody.mjs';
import { buildExactGraphContract, validateReviewedFlowContract } from './nodered_reviewed_flow_deploy/runtime_contract.mjs';
const sha = s => crypto.createHash('sha256').update(s).digest('hex');
export const monthlyApiIds = Object.freeze(Object.fromEntries(['quote','purchase','read','reconcile','router','find','update','projection','http','response','catch']
  .map(k => [k,'monthly_friendship_api_' + k + '_20261102'])));
// Adds only a closed private ingress over the SAME owner collection/kernel.
// It never imports, enables, dispatches or changes the existing legacy graph.
export function composeMonthlyFriendshipApi(liveBytes, deploymentId) {
  const flow = JSON.parse(Buffer.from(liveBytes).toString('utf8')), ids = monthlyApiIds;
  if (!Array.isArray(flow) || flow.some(n => !n || typeof n.id !== 'string' || !n.id) || new Set(flow.map(n => n.id)).size !== flow.length) throw Error('MONTHLY_API_GRAPH_INVALID');
  const get = (id,type) => { const n=flow.find(x=>x.id===id);if(n?.type!==type)throw Error('MONTHLY_API_PREREQUISITE:'+id);return n; };
  const owner = get(monthlyFriendshipIds.atomic,'function'), z=owner.z;
  for(const name of ['status_response','purchase_limit','confirm_resolve','purchase_router','atomic']) {
    const n=get(monthlyFriendshipIds[name],'function');
    if(n.z!==z || sha(n.func)!==sha(monthlyFriendshipSource(name)))throw Error('MONTHLY_API_OWNER_SOURCE_DRIFT:'+name);
  }
  const find=get(monthlyFriendshipIds.find,'mongodb4');
  if(find.z!==z || !find.clientNode || find.collection!=='lk_tournament_subscription_sales' || find.operation!=='find'
    || find.output!=='toArray' || find.handleDocId!==false || JSON.stringify(find.wires)!==JSON.stringify([[owner.id]]))throw Error('MONTHLY_API_STORAGE_DRIFT');
  const same = (a,b) => JSON.stringify(a) === JSON.stringify(b);
  if(owner.outputs !== 5 || !same(owner.wires, [[monthlyFriendshipIds.find],[monthlyFriendshipIds.update],[monthlyFriendshipIds.projection],[monthlyFriendshipIds.response],[monthlyFriendshipIds.http]])) throw Error('MONTHLY_API_OWNER_TOPOLOGY_DRIFT');
  for(const key of ['update','projection']) {
    const n=get(monthlyFriendshipIds[key],'mongodb4');
    if(n.z!==z || n.clientNode!==find.clientNode || n.collection!==find.collection || n.operation!=='updateOne'
      || n.output!=='toArray' || n.handleDocId!==false || !same(n.wires,[[owner.id]]))throw Error('MONTHLY_API_STORAGE_DRIFT');
  }
  const reserved=new Set(Object.values(ids)),routes=monthlyFriendshipApi.modes.map(m=>monthlyFriendshipApi.prefix+m);
  if(flow.some(n=>reserved.has(n.id)||reserved.has(n.z)||routes.includes(n.url)
    || [n.wires,n.links,n.scope].some(v=>Array.isArray(v)&&v.flat().some(x=>reserved.has(x)))))throw Error('MONTHLY_API_ROUTE_COLLISION');
  const source=monthlyFriendshipApiSource();new Function('msg','env','global','node','nodeCrypto',source);
  flow.push(...monthlyFriendshipApi.modes.map(mode=>({id:ids[mode],type:'http in',z,name:'Private monthly '+mode,url:monthlyFriendshipApi.prefix+mode,method:'post',upload:false,wires:[[ids.router]]})),
    {id:ids.router,type:'function',z,name:'Monthly actor-bound owner',func:source,outputs:5,
      libs:[{var:'nodeCrypto',module:'crypto'}],initialize:'',finalize:'',wires:[[ids.find],[ids.update],[ids.projection],[ids.response],[ids.http]]},
    ...[['find','find'],['update','updateOne'],['projection','updateOne']].map(([key,operation])=>({...structuredClone(find),id:ids[key],name:'Monthly private '+key,operation,wires:[[ids.router]]})),
    {id:ids.http,type:'http request',z,name:'Monthly bounded transport',method:'use',ret:'obj',url:'',paytoqs:'ignore',requestTimeout:'10000',senderr:true,persist:false,authType:'',insecureHTTPParser:false,wires:[[ids.router]]},
    {id:ids.response,type:'http response',z,name:'Monthly private receipt',statusCode:'',headers:{},wires:[]},
    {id:ids.catch,type:'catch',z,name:'Monthly storage/transport uncertainty',uncaught:false,scope:[ids.find,ids.update,ids.projection,ids.http],wires:[[ids.router]]});
  const candidateBytes=Buffer.from(JSON.stringify(flow,null,2)+'\n');
  const contract=buildExactGraphContract({liveBytes,candidateBytes,deploymentId,allowedChanges:[],allowedAdditionIds:Object.values(ids)});
  validateReviewedFlowContract({liveBytes,candidateBytes,contract});return {candidate:flow,candidateBytes,contract};
}
