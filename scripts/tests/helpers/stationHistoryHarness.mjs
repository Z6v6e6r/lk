import fs from 'node:fs';
import crypto from 'node:crypto';
import { addCommunityPolicyAuth } from '../../lib/communityPolicyAuth.mjs';
import { patchStationMessageHistory, historyNodeIds } from '../../lib/stationMessageHistorySource.mjs';

const source=fs.readFileSync(new URL('../../patch_nodered_communities_flow.mjs',import.meta.url),'utf8');
const common=source.split('const commonHelpers = String.raw`')[1].split('\n`;')[0];
export const originalHistoryFunction=name=>common+source.split('const '+name+' = `${commonHelpers}')[1].split('\n`;')[0];
export function historyGraphBase() {
  return addCommunityPolicyAuth([
    {id:'tab',type:'tab'},{id:'mongo',type:'mongodb4-client'},
    {id:'response',type:'http response',wires:[]},{id:'debug',type:'debug',wires:[]},
    {id:'entry',type:'http in',method:'get',url:'/lk/communities/:communityId/messages',wires:[['prepare']]},
    {id:'prepare',type:'function',name:'Prepare chat messages request',func:originalHistoryFunction('fnChatGetPrepare'),outputs:3,wires:[['community'],['response'],['debug']]},
    {id:'community',type:'mongodb4',clientNode:'mongo',collection:'lk_communities',operation:'find',mode:'collection',output:'toArray',wires:[['query']]},
    {id:'query',type:'function',z:'tab',name:'Build community chat query',func:originalHistoryFunction('fnChatGetQuery'),outputs:3,wires:[['messages'],['response'],['debug']]},
    {id:'messages',type:'mongodb4',clientNode:'mongo',collection:'lk_community_chat_messages',operation:'find',mode:'collection',output:'toArray',wires:[['render']]},
    {id:'render',type:'function',name:'Build community chat response',func:originalHistoryFunction('fnChatGetResponse'),outputs:2,wires:[['response'],['debug']]},
  ]);
}
export function historyGraph(base=historyGraphBase()) {
  const bytes=JSON.stringify(base);
  return patchStationMessageHistory(bytes,{expectedFlowSha256:crypto.createHash('sha256').update(bytes).digest('hex'),mongoClientId:'mongo'});
}
export const historyEvaluate=(flow,id,msg)=>new Function('msg','nodeCrypto','env',flow.find(node=>node.id===id).func)(msg,crypto,{get:()=>''});
export const historyCommunity=()=>({_id:'community-row',id:'community',communityType:'STATION',visibility:'CLOSED',members:[{id:'actor',name:'Synthetic',status:'ACTIVE'}],bannedMembers:[]});
export const historyMessage=(index,time=1000)=>({_id:'canonical-'+index,communityId:'community',stationMessageOwner:1,state:'COMMITTED',archived:false,id:`00000000-0000-8000-8000-${String(index).padStart(12,'0')}`,publicId:`00000000-0000-8000-8000-${String(index).padStart(12,'0')}`,createdTs:time,createdAt:new Date(time).toISOString(),text:'same body',authorId:'actor',authorName:'Synthetic'});
export const historyLegacy=(index,time=1000)=>({_id:'legacy-'+index,communityId:'community',id:'provider-message-'+index,createdAt:new Date(time).toISOString(),text:'same body',authorName:'Synthetic'});

/** Drive actual composed functions, with storage supplied by the focused test/owned CI fixture. */
export async function historyReadGraph({flow=historyGraph(),query={historyVersion:'2',limit:'2'},community=historyCommunity(),actor={id:'actor'},find,initialFind,beforeFinal}) {
  const msg={req:{method:'GET',params:{communityId:'community'},query,headers:{}},_verifiedCommunityActor:actor};
  let output=historyEvaluate(flow,'prepare',msg);
  if(!output[0])return output[1];
  msg.payload=initialFind?await initialFind(msg.payload):[community];output=historyEvaluate(flow,'query',msg);
  if(!output[3])return output[1];
  for(const stage of ['canonical','legacy','access']) {
    if(stage==='access'&&beforeFinal)await beforeFinal();
    msg.payload=await find(stage,msg.payload);
    output=historyEvaluate(flow,historyNodeIds.router,msg);
    if(output[2])return output[2];
  }
  throw Error('HISTORY_TEST_NO_RESPONSE');
}
