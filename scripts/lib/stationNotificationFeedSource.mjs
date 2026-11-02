import fs from 'node:fs';
import crypto from 'node:crypto';
import vm from 'node:vm';
import { stationLifetimeRuntimeSource } from './stationMembershipReceiverSource.mjs';
import { nfPath } from './stationNotificationFeed.mjs';
export const notificationFeedIds = Object.fromEntries(['publications','recipients','eligibility','publicationsBegin','recipientsBegin','eligibilityBegin','router','community','messages','events','response','catch'].map(k => [k,'station_notification_feed_v1_' + k]));
export const notificationFeedRuntimeSource = () => stationLifetimeRuntimeSource() + '\n' + ['stationMessageStream.mjs','stationMessageProof.mjs','stationNotificationFeed.mjs','stationNotificationFeedAuth.mjs'].map(name => fs.readFileSync(new URL('./' + name, import.meta.url), 'utf8').replace(/^import .*;\n/gm, '').replace(/^export /gm, '')).join('\n');

/** Additive source composer only. Never reads/writes a live graph or provisions Mongo. */
export function patchStationNotificationFeed(bytes, { expectedFlowSha256, mongoClientId, tabId }) {
  if (crypto.createHash('sha256').update(bytes).digest('hex') !== expectedFlowSha256) throw Error('NOTIFICATION_GRAPH_PREIMAGE');
  const flow = JSON.parse(bytes), reserved = new Set(Object.values(notificationFeedIds));
  if (!Array.isArray(flow) || flow.some(n => !n || typeof n.id !== 'string') || new Set(flow.map(n => n.id)).size !== flow.length) throw Error('NOTIFICATION_GRAPH_INVALID');
  const refs = value => typeof value === 'string' ? reserved.has(value) : value && typeof value === 'object' ? Object.values(value).some(refs) : false;
  if (flow.some(refs)) throw Error('NOTIFICATION_RESERVED_REFERENCE');
  const byId = new Map(flow.map(n => [n.id,n]));
  if (byId.get(mongoClientId)?.type !== 'mongodb4-client' || byId.get(tabId)?.type !== 'tab' || byId.get(tabId)?.disabled === true) throw Error('NOTIFICATION_GRAPH_TARGET_INVALID');
  // Catch/complete bypass ordinary wires. Only proven unrelated explicit scope is safe.
  const observerFields = new Set(['id','type','z','g','name','scope','uncaught','wires','x','y','d','l','info']);
  for (const n of flow.filter(n => n.type === 'catch' || n.type === 'complete')) {
    if (Object.keys(n).some(k => !observerFields.has(k)) || !Array.isArray(n.scope) || !n.scope.length || new Set(n.scope).size !== n.scope.length || n.scope.some(id => typeof id !== 'string' || !byId.has(id))) throw Error('NOTIFICATION_OBSERVER_UNSAFE');
  }
  for (const n of flow.filter(n => n.type === 'http in' && ['post','all'].includes(String(n.method || 'get').toLowerCase()))) {
    const path = String(n.url || '').replace(/\/$/,''), parts = path.split('/');
    for (const mode of ['publications','recipients','eligibility']) {
      const expected = nfPath(mode).split('/');
      if (parts.some(p => /[*()?]/.test(p)) || parts.length === expected.length && parts.every((p,i) => p.startsWith(':') || p === expected[i])) throw Error('NOTIFICATION_ROUTE_COLLISION');
    }
  }
  const runtime = notificationFeedRuntimeSource();
  // Only req/res transport identity survives. No candidate, body, credential, private actor or DB exception reaches response/debug.
  const reply = `const nfReply=(response)=>({req:msg.req,res:msg.res,_msgid:msg._msgid,statusCode:response.status,headers:{'Content-Type':'application/json','Cache-Control':'no-store'},payload:response.body});\n`;
  const dispatch = `const nfDispatch=(next)=>{if(next.response)return [null,null,null,nfReply(next.response)];if(next.method!=='aggregate')return [null,null,null,nfReply(nfError(null))];msg._stationNotification=next.ctx;msg.payload=next.args;delete msg.error;return next.store==='lk_communities'?[msg,null,null,null]:next.store==='lk_community_chat_messages'?[null,msg,null,null]:next.store==='lk_community_events'?[null,null,msg,null]:[null,null,null,nfReply(nfError(null))];};\n`;
  const wires = [[notificationFeedIds.community],[notificationFeedIds.messages],[notificationFeedIds.events],[notificationFeedIds.response]];
  for (const mode of ['publications','recipients','eligibility']) {
    flow.push({ id: notificationFeedIds[mode], type: 'http in', z: tabId, method: 'post', url: nfPath(mode), upload: false, wires: [[notificationFeedIds[mode + 'Begin']]] });
    const func = runtime + '\n' + reply + dispatch + `delete msg._stationNotification;\ntry{const checked=verifyStationNotificationFeed(msg,k=>env.get(k),${JSON.stringify(mode)});if(checked.response)return [null,null,null,nfReply(checked.response)];return nfDispatch(beginStationNotificationFeed(${JSON.stringify(mode)},checked.request,{expiresAtMs:checked.expiresAtMs}));}catch{return [null,null,null,nfReply(nfError(null))];}`;
    flow.push({ id: notificationFeedIds[mode + 'Begin'], type: 'function', z: tabId, name: 'Verify station notification ' + mode, func, outputs: 4, libs: [{ var: 'nodeCrypto', module: 'crypto' }], wires });
  }
  flow.push({ id: notificationFeedIds.router, type: 'function', z: tabId, name: 'Read station notification owner proof', func: runtime + '\n' + reply + dispatch + `return nfDispatch(advanceStationNotificationFeed(msg._stationNotification,msg.payload,Boolean(msg.error)));`, outputs: 4, libs: [{ var: 'nodeCrypto', module: 'crypto' }], wires });
  for (const [key,collection] of [['community','lk_communities'],['messages','lk_community_chat_messages'],['events','lk_community_events']]) flow.push({ id: notificationFeedIds[key], type: 'mongodb4', z: tabId, clientNode: mongoClientId, collection, operation: 'aggregate', mode: 'collection', output: 'toArray', handleDocId: false, maxTimeMS: '3000', wires: [[notificationFeedIds.router]] });
  flow.push({ id: notificationFeedIds.response, type: 'http response', z: tabId, name: 'Private station notification response', wires: [] }, { id: notificationFeedIds.catch, type: 'catch', z: tabId, scope: ['community','messages','events'].map(k => notificationFeedIds[k]), uncaught: false, wires: [[notificationFeedIds.router]] });
  const ids = new Set(flow.map(n => n.id));
  for (const n of flow) {
    for (const id of [...(n.wires || []).flat(),...(n.links || []),...(Array.isArray(n.scope) ? n.scope : [])]) if (!ids.has(id)) throw Error('NOTIFICATION_DANGLING_REFERENCE');
    if (reserved.has(n.id) && n.type === 'function') new vm.Script('(function(msg,env,nodeCrypto){' + n.func + '\n})');
  }
  return flow;
}
