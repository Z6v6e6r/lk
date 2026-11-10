import {sameRuntimeNode} from './communityRuntimeNode.mjs';
import crypto from 'node:crypto';
import {prepareEventErasure, verifyEventErasureAck} from '../prepare_event_erasure.mjs';
import {eventRetentionUntil} from '../../src/services/community-policy.ts';

const TARGET='community_1794221739126_корпспорт-падлхаб-2026';
const PREFIX='community-exhibition-retention-v1';

function metadataQuery() {
  return [{id:TARGET},{maxTimeMS:5000,limit:2,projection:{_id:0,id:1,communityType:1,typeSettingsRevision:1,typeSettingsEffectiveAt:1,eventEntriesRevision:1,
    'eventEntries.playerId':1,'eventEntries.epoch':1,'eventEntries.policyRevision':1,'eventEntries.policyVersion':1,
    'eventEntries.registeredAt':1,'eventEntries.retentionUntil':1,'eventEntries.retentionMode':1}}];
}
function metadataSignature(document) {
  const keys=['playerId','epoch','policyRevision','policyVersion','registeredAt','retentionUntil','retentionMode'];
  const entries=document.eventEntries.map(row=>keys.map(key=>row[key] ?? null));
  entries.sort((a,b)=>JSON.stringify(a).localeCompare(JSON.stringify(b)));
  return crypto.createHash('sha256').update(JSON.stringify([document.id,document.communityType,document.typeSettingsRevision,
    document.typeSettingsEffectiveAt ?? null,document.eventEntriesRevision ?? null,entries])).digest('hex');
}
function expiryPlan(document,now) {
  const iso=value=>typeof value==='string' && Number.isFinite(Date.parse(value)) && new Date(value).toISOString()===value;
  if(!iso(now)) throw new Error('EXHIBITION_RETENTION_TIME_INVALID');
  if(document && document.id!==TARGET) throw new Error('EXHIBITION_RETENTION_TARGET_INVALID');
  const empty=()=>({command:null,receipt:{operationId:crypto.randomUUID(),preparedAt:now,status:'NOOP',beforeCount:0,afterCount:0,removedCount:0,applied:false}});
  if(!document || document.eventEntries===undefined) return empty();
  if(!Array.isArray(document.eventEntries) || document.eventEntries.length>500) throw new Error('EXHIBITION_RETENTION_METADATA_INVALID');
  if(!document.eventEntries.length) return empty();
  const keys=['playerId','epoch','policyRevision','policyVersion','registeredAt','retentionUntil','retentionMode'];
  for(const row of document.eventEntries) {
    if(!row || typeof row!=='object' || Object.keys(row).some(key=>!keys.includes(key)) ||
      typeof row.playerId!=='string' || !row.playerId || row.playerId.length>120 || /[\p{C}]/u.test(row.playerId) ||
      !iso(row.epoch) || !iso(row.registeredAt) || !iso(row.retentionUntil) || row.registeredAt>now ||
      !Number.isSafeInteger(row.policyRevision) || row.policyRevision<1 || row.policyVersion!=='event-registration-v1' ||
      row.retentionMode!==undefined && row.retentionMode!=='submitted-year-v1' ||
      row.retentionMode==='submitted-year-v1' && row.retentionUntil!==eventRetentionUntil(row.registeredAt)) throw new Error('EXHIBITION_RETENTION_METADATA_INVALID');
  }
  const plan=prepareEventErasure(document,{expired:true,now});
  plan.receipt.status='NOOP';
  if(plan.command) {
    plan.command.options.maxTimeMS=5000;
    const after={...document,eventEntriesRevision:(document.eventEntriesRevision ?? 0)+1,eventEntries:document.eventEntries.filter(row=>row.retentionUntil>now)};
    plan.expectedSignature=metadataSignature(after);
  }
  return plan;
}

/** Opt-in internal canonical writer. No HTTP route, contacts, credentials or alternate store. */
export function addExhibitionRegistrationRetention(input) {
  const flow=structuredClone(input);
  // Follow the already reviewed canonical admission client, never an unrelated first URI.
  const template=flow.find(node=>node.id==='community-event-admission-v1-find');
  if(!template || template.type!=='mongodb4' || template.collection!=='lk_communities' || template.operation!=='find' || !template.clientNode) throw new Error('EXHIBITION_RETENTION_CANONICAL_CLIENT_REQUIRED');
  const querySource='const TARGET='+JSON.stringify(TARGET)+';\n'+metadataQuery.toString()+'\n';
  const library=querySource+eventRetentionUntil.toString()+'\n'+prepareEventErasure.toString()+'\n'+metadataSignature.toString()+'\n'+expiryPlan.toString()+'\n';
  const node=(suffix,type,extra)=>({id:PREFIX+suffix,type,z:template.z,...extra});
  const mongo=(suffix,operation,next)=>({...structuredClone(template),id:PREFIX+suffix,name:'Exhibition retention '+operation,type:'mongodb4',mode:'collection',collection:'lk_communities',operation,output:'toArray',maxTimeMS:5000,handleDocId:false,wires:[[PREFIX+next]]});
  const prepare=querySource+`delete msg.req;delete msg.res;delete msg.error;delete msg._exhibitionRetention;
msg._retentionStarted=Date.now();msg.payload=metadataQuery();return msg;`;
  const plan=library+`const rows=msg.payload;
if(!Array.isArray(rows) || rows.length>1 || Date.now()<msg._retentionStarted) throw new Error('EXHIBITION_RETENTION_SOURCE_INVALID');
const plan=expiryPlan(rows[0],new Date().toISOString());
if(!plan.command){msg.payload=plan.receipt;delete msg._retentionStarted;return [null,msg];}
msg._exhibitionRetention={receipt:plan.receipt,expectedSignature:plan.expectedSignature,acknowledged:false};
msg.payload=[plan.command.filter,plan.command.update,plan.command.options];return [msg,null];`;
  const ack=querySource+verifyEventErasureAck.toString()+`\nif(!msg._exhibitionRetention) throw new Error('EXHIBITION_RETENTION_CONTEXT_INVALID');
try{verifyEventErasureAck(msg.payload);msg._exhibitionRetention.acknowledged=true;}catch{msg._exhibitionRetention.acknowledged=false;}
msg.payload=metadataQuery();return msg;`;
  const verify=querySource+metadataSignature.toString()+`\nconst ctx=msg._exhibitionRetention,rows=msg.payload;
if(!ctx || !Array.isArray(rows) || rows.length!==1 || metadataSignature(rows[0])!==ctx.expectedSignature) throw new Error('EXHIBITION_RETENTION_READBACK_DRIFT');
msg.payload={...ctx.receipt,status:ctx.acknowledged?'PURGED':'RECONCILE_REQUIRED',applied:ctx.acknowledged?true:null};
delete msg._exhibitionRetention;delete msg._retentionStarted;return msg;`;
  const error=querySource+`const writeError=msg.error?.source?.id===${JSON.stringify(PREFIX+'-write')};
delete msg.error;
if(writeError && msg._exhibitionRetention){msg._exhibitionRetention.acknowledged=false;msg.payload=metadataQuery();return [msg,null];}
msg.payload={operationId:msg._exhibitionRetention?.receipt?.operationId,preparedAt:new Date().toISOString(),status:'RECONCILE_REQUIRED',applied:null};
delete msg._exhibitionRetention;delete msg._retentionStarted;return [null,msg];`;
  const audit=`const source=msg.payload || {},out={};
out.status=['NOOP','PURGED','RECONCILE_REQUIRED'].includes(source.status)?source.status:'RECONCILE_REQUIRED';
if(typeof source.operationId==='string' && /^[a-f0-9-]{36}$/.test(source.operationId)) out.operationId=source.operationId;
if(typeof source.preparedAt==='string' && Number.isFinite(Date.parse(source.preparedAt))) out.preparedAt=new Date(source.preparedAt).toISOString();
for(const key of ['beforeCount','afterCount','removedCount','expectedRevision','expectedPolicyRevision']) if(Number.isSafeInteger(source[key]) && source[key]>=0) out[key]=source[key];
out.applied=source.applied===true?true:source.applied===false?false:null;
node.status({fill:out.status==='RECONCILE_REQUIRED'?'red':'green',shape:'dot',text:'retention '+out.status});
node.warn('EXHIBITION_REGISTRATION_RETENTION_V1 '+JSON.stringify(out));return null;`;
  const definitions=[
    node('-tick','inject',{name:'Hourly exhibition questionnaire expiry',props:[{p:'payload'}],repeat:'3600',crontab:'',once:true,onceDelay:'30',payload:'',payloadType:'date',wires:[[PREFIX+'-prepare']]}),
    node('-prepare','function',{name:'Read exact exhibition retention metadata',func:prepare,outputs:1,wires:[[PREFIX+'-find']]}),
    mongo('-find','find','-plan'),
    node('-plan','function',{name:'Fence expired exhibition questionnaires',func:plan,libs:[{var:'crypto',module:'crypto'}],outputs:2,wires:[[PREFIX+'-write'],[PREFIX+'-audit']]}),
    mongo('-write','updateOne','-ack'),
    node('-ack','function',{name:'Check retention acknowledgement',func:ack,outputs:1,wires:[[PREFIX+'-readback']]}),
    mongo('-readback','find','-verify'),
    node('-verify','function',{name:'Verify physical questionnaire expiry',func:verify,libs:[{var:'crypto',module:'crypto'}],outputs:1,wires:[[PREFIX+'-audit']]}),
    node('-catch','catch',{name:'Exhibition retention failure',scope:['-prepare','-find','-plan','-write','-ack','-readback','-verify'].map(suffix=>PREFIX+suffix),uncaught:false,wires:[[PREFIX+'-error']]}),
    node('-error','function',{name:'Reconcile retention without retrying writes',func:error,outputs:2,wires:[[PREFIX+'-readback'],[PREFIX+'-audit']]}),
    node('-audit','function',{name:'Non-identifying retention audit',func:audit,outputs:1,wires:[[]]}),
  ];
  const actual=flow.filter(node=>node.id.startsWith(PREFIX));
  if(!actual.length) flow.push(...definitions);
  else if(actual.length!==definitions.length || definitions.some(expected=>!sameRuntimeNode(actual.find(node=>node.id===expected.id),expected))) throw new Error('EXHIBITION_RETENTION_GRAPH_DRIFT');
  return flow;
}
