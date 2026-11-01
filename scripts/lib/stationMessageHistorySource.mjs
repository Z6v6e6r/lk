import fs from 'node:fs';
import crypto from 'node:crypto';
import vm from 'node:vm';
import { addCommunityPolicyAuth, COMMUNITY_AUTH_SUBFLOW } from './communityPolicyAuth.mjs';
import { stationLifetimeRuntimeSource } from './stationMembershipReceiverSource.mjs';

export const historyNodeIds = Object.fromEntries(['router','canonical','legacy','community','catch'].map(key => [key, 'station_history_v2_' + key]));
export const historyRuntimeSource = () => stationLifetimeRuntimeSource() + '\n' + fs.readFileSync(new URL('./stationMessageHistory.mjs', import.meta.url), 'utf8').replace(/^import .*;\n/gm, '').replace(/^export /gm, '');
const sha = value => crypto.createHash('sha256').update(value).digest('hex');

/** Add only the opt-in reader to an already authenticated community graph. No runtime apply. */
export function patchStationMessageHistory(bytes, { expectedFlowSha256, mongoClientId }) {
  if (sha(bytes) !== expectedFlowSha256) throw Error('HISTORY_GRAPH_PREIMAGE');
  const flow = JSON.parse(bytes), ids = new Set(Object.values(historyNodeIds));
  if (!Array.isArray(flow) || new Set(flow.map(node => node.id)).size !== flow.length) throw Error('HISTORY_GRAPH_INVALID');
  const referencesReserved = value => typeof value === 'string' ? ids.has(value) : value && typeof value === 'object' ? Object.values(value).some(referencesReserved) : false;
  if (flow.some(referencesReserved)) throw Error('HISTORY_RESERVED_REFERENCE');
  // Verify existing auth definitions/custody; this patch does not inject unrelated authorization.
  if (JSON.stringify(addCommunityPolicyAuth(structuredClone(flow))) !== JSON.stringify(flow)) throw Error('HISTORY_AUTH_GRAPH_REQUIRED');
  const byId = new Map(flow.map(node => [node.id,node]));
  if (byId.get(mongoClientId)?.type !== 'mongodb4-client') throw Error('HISTORY_MONGO_CLIENT_REQUIRED');
  const only = (predicate, code) => { const matches = flow.filter(predicate); if (matches.length !== 1) throw Error(code); return matches[0]; };
  const ingress = only(node => node.type === 'http in' && node.method === 'get' && node.url === '/lk/communities/:communityId/messages' && node.d !== true, 'HISTORY_INGRESS_REQUIRED');
  const oneTarget = node => { if (node.wires?.length !== 1 || node.wires[0]?.length !== 1) throw Error('HISTORY_WIRE_DRIFT'); const target=byId.get(node.wires[0][0]); if (!target) throw Error('HISTORY_WIRE_DRIFT'); return target; };
  const auth = oneTarget(ingress);
  if (auth.type !== 'subflow:' + COMMUNITY_AUTH_SUBFLOW) throw Error('HISTORY_AUTH_INGRESS_REQUIRED');
  const prepare = oneTarget(auth);
  const query = only(node => node.type === 'function' && node.name === 'Build community chat query' && node.d !== true, 'HISTORY_QUERY_REQUIRED');
  if (prepare.type !== 'function' || prepare.name !== 'Prepare chat messages request' || !prepare.func.includes('msg._communityChat = {') || !query.func.includes('COMMUNITY_TYPED_ACCESS_GUARD')) throw Error('HISTORY_SOURCE_DRIFT');
  if (prepare.outputs !== 3 || query.outputs !== 3 || prepare.wires?.length !== 3 || query.wires?.length !== 3 || prepare.wires[0]?.length !== 1 || query.wires[0]?.length !== 1 || query.wires[1]?.length !== 1) throw Error('HISTORY_WIRE_DRIFT');
  const communityStore=byId.get(prepare.wires[0][0]), messageStore=byId.get(query.wires[0][0]), response=byId.get(query.wires[1][0]);
  for (const [node,collection] of [[communityStore,'lk_communities'],[messageStore,'lk_community_chat_messages']]) {
    if (node?.type !== 'mongodb4' || node.operation !== 'find' || node.collection !== collection || node.clientNode !== mongoClientId || node.mode !== 'collection' || node.output !== 'toArray') throw Error('HISTORY_STORE_DRIFT');
  }
  if (oneTarget(communityStore).id !== query.id || response?.type !== 'http response' || prepare.wires[1]?.length !== 1 || prepare.wires[1][0] !== response.id) throw Error('HISTORY_WIRE_DRIFT');
  // Node-RED observers can receive a message without an ordinary incoming wire.
  // Accept only explicit, understood scopes: null/missing/all or unfamiliar modes
  // are not evidence of isolation, even when the supplied whole-flow SHA matches.
  const privateNodes=new Set([prepare.id,communityStore.id,query.id,...ids]);
  const observerFields=new Set(['id','type','z','g','name','scope','uncaught','wires','x','y','d','l','info']);
  for (const node of flow.filter(node=>node.type==='catch' || node.type==='complete')) {
    if (Object.keys(node).some(key=>!observerFields.has(key)) ||
      !Array.isArray(node.scope) || node.scope.length===0 || new Set(node.scope).size!==node.scope.length ||
      node.scope.some(target=>typeof target!=='string' || !byId.has(target) || privateNodes.has(target))) throw Error('HISTORY_OBSERVER_SCOPE_UNSAFE');
  }
  // Neither an unrelated preimage nor an alternate executable ingress may reach the v2 router.
  for (const [target,allowed] of [[prepare.id,auth.id],[communityStore.id,prepare.id],[query.id,communityStore.id]]) {
    for (const node of flow) if (node.id !== allowed && ((node.wires || []).flat().includes(target) || (node.links || []).includes(target) || (Array.isArray(node.scope) && node.scope.includes(target)))) throw Error('HISTORY_INGRESS_BYPASS');
  }
  const originalPrepare=prepare.func, originalQuery=query.func, runtime=historyRuntimeSource();
  const errorSource=String.raw`
const historyError=(status,code)=>{delete msg._stationHistory;delete msg._stationHistoryRequest;delete msg.error;msg.statusCode=status;msg.headers={'Content-Type':'application/json','Cache-Control':'no-store'};msg.payload={historyVersion:2,error:code};return msg;};
`;
  prepare.func=runtime+'\n'+errorSource+String.raw`
delete msg._stationHistoryRequest; delete msg._stationHistory;
if (Object.prototype.hasOwnProperty.call(msg.req?.query || {},'historyVersion')) {
  try { msg._stationHistoryRequest=historyRequest(msg.req?.params?.communityId,msg.req.query); }
  catch { return [null,historyError(400,'HISTORY_REQUEST_INVALID'),null]; }
}
`+'const prepared=(function(){\n'+originalPrepare+'\n}).call(this);\n'+String.raw`
if (!msg._stationHistoryRequest) return prepared;
if (!prepared?.[0]) return [null,historyError(400,'HISTORY_REQUEST_INVALID'),null];
msg.payload=[msg.payload,{limit:2,maxTimeMS:HISTORY_MAX_TIME_MS}];
return [msg,null,null];
`;
  query.func=runtime+'\n'+errorSource+'\nconst originalCommunityRows=msg.payload;\nconst originalResult=(function(){\n'+originalQuery+'\n}).call(this);\n'+String.raw`
if (!msg._stationHistoryRequest) return originalResult;
if (!originalResult?.[0]) return [null,historyError([401,403,404,503].includes(msg.statusCode)?msg.statusCode:403,'HISTORY_ACCESS_DENIED'),null,null];
if (!Array.isArray(originalCommunityRows) || originalCommunityRows.length !== 1 || originalCommunityRows[0].id !== msg._stationHistoryRequest.communityId || !historyActorAllowed(originalCommunityRows[0],msg._verifiedCommunityActor)) return [null,historyError(403,'HISTORY_ACCESS_DENIED'),null,null];
try {
  msg._stationHistory={request:msg._stationHistoryRequest,identity:historyMongoIdentity(originalCommunityRows[0]),mongoId:originalCommunityRows[0]._id,stage:'canonical'};
  msg.payload=historyFindArguments(msg._stationHistory.request);
  return [null,null,null,msg];
} catch {return [null,historyError(503,'HISTORY_UNAVAILABLE'),null,null];}
`;
  query.outputs=4; query.wires=[...query.wires,[historyNodeIds.canonical]];
  const finalAcl='(function(){\n'+originalQuery+'\n}).call(this)';
  const router=runtime+'\n'+errorSource+String.raw`
const context=msg._stationHistory;
if (!context || msg.error || !Array.isArray(msg.payload)) return [null,null,historyError(503,'HISTORY_UNAVAILABLE')];
try {
  if (context.stage==='canonical') {
    if(msg.payload.length>context.request.limit+1)throw Error('HISTORY_STORE_INVALID');
    context.canonical=msg.payload;context.stage='legacy';
    msg.payload=historyFindArguments(context.request,true);return [msg,null,null];
  }
  if (context.stage==='legacy') {
    context.page=historyPage(context.request,context.canonical,msg.payload);delete context.canonical;context.stage='access';
    msg.payload=[{_id:context.mongoId,id:context.request.communityId},{limit:2,maxTimeMS:HISTORY_MAX_TIME_MS}];return [null,msg,null];
  }
  if (context.stage!=='access' || msg.payload.length!==1 || JSON.stringify(historyMongoIdentity(msg.payload[0]))!==JSON.stringify(context.identity) || !historyActorAllowed(msg.payload[0],msg._verifiedCommunityActor)) return [null,null,historyError(403,'HISTORY_ACCESS_DENIED')];
  const authorized=`+finalAcl+String.raw`;
  if(!authorized?.[0])return [null,null,historyError(403,'HISTORY_ACCESS_DENIED')];
  const page=context.page;delete msg._stationHistory;delete msg._stationHistoryRequest;delete msg.error;
  msg.statusCode=200;msg.headers={'Content-Type':'application/json','Cache-Control':'no-store'};msg.payload=page;return [null,null,msg];
} catch {return [null,null,historyError(503,'HISTORY_UNAVAILABLE')];}
`;
  for (const node of [prepare,query]) node.libs=[...(node.libs || []).filter(lib => lib.var !== 'nodeCrypto'),{var:'nodeCrypto',module:'crypto'}];
  const z=query.z;
  flow.push({id:historyNodeIds.router,type:'function',z,name:'Read bounded station history v2',func:router,outputs:3,libs:[{var:'nodeCrypto',module:'crypto'}],wires:[[historyNodeIds.legacy],[historyNodeIds.community],[response.id]]});
  for (const key of ['canonical','legacy','community']) flow.push({id:historyNodeIds[key],type:'mongodb4',z,clientNode:mongoClientId,collection:key==='community'?'lk_communities':'lk_community_chat_messages',operation:'find',mode:'collection',output:'toArray',handleDocId:false,maxTimeMS:String(3000),wires:[[historyNodeIds.router]]});
  flow.push({id:historyNodeIds.catch,type:'catch',z,scope:['canonical','legacy','community'].map(key=>historyNodeIds[key]),uncaught:false,wires:[[historyNodeIds.router]]});
  const allIds=new Set(flow.map(node=>node.id));
  for(const node of flow) {
    for(const target of [...(node.wires || []).flat(),...(node.links || []),...(Array.isArray(node.scope)?node.scope:[])])if(!allIds.has(target))throw Error('HISTORY_DANGLING_REFERENCE');
    if(node.type==='function')new vm.Script('(function(msg,nodeCrypto){'+node.func+'\n})');
  }
  return flow;
}
