// Atomic collision protection for the existing LK create/upsert writer.
export function protectStationCreate(flow, ids, mongoClientId) {
  const nodes = flow.filter(n => n.type === 'function' && n.name === 'Build community create docs' && n.d !== true);
  if (nodes.length !== 1) throw Error('STATION_CREATE_WRITER_REQUIRED');
  const node = nodes[0], wires = structuredClone(node.wires || []);
  if (node.outputs !== 6 || wires.length !== 6 || wires[0].length !== 1 || node.func.includes('STATION_CREATE_COLLISION_V1')) throw Error('STATION_CREATE_WRITER_DRIFT');
  const oldWrite = flow.find(n => n.id === wires[0][0]);
  if (!oldWrite || oldWrite.type !== 'mongodb4' || oldWrite.clientNode !== mongoClientId || oldWrite.collection !== 'lk_communities' || oldWrite.operation !== 'updateOne' || oldWrite.wires?.some(group=>group.length)) throw Error('STATION_CREATE_STORE_DRIFT');
  if (flow.some(n=>n.id!==node.id && ((n.wires||[]).flat().includes(oldWrite.id) || (n.links||[]).includes(oldWrite.id)))) throw Error('STATION_CREATE_EXTRA_STORE_INGRESS');
  node.func = '// STATION_CREATE_COLLISION_V1\nconst outcome=(function(){\n' + node.func + '\n}).call(this);\n' + String.raw`
if (!Array.isArray(outcome) || !outcome[0]) return outcome;
const write=outcome[0], set=write.payload?.$set;
if (!write.query?.id || set?.id !== write.query.id || Object.keys(write.query).length !== 1 || !set || '_id' in set || Object.keys(write.payload).some(k=>!['$set','$setOnInsert'].includes(k)) || Object.keys(write.payload.$setOnInsert||{}).some(k=>k!=='createdAt') || write.payload.$setOnInsert?.createdAt!==set.createdAt) throw Error('STATION_CREATE_UPDATE_DRIFT');
const protectedRow={$or:[{$ne:[{$type:'$stationMembershipLifetime'},'missing']},env.get('LK_STATION_MEMBERSHIP_LIFETIME_ENABLED')==='true'?{$eq:['$communityType','STATION']}:false]};
write.payload=[write.query,[{$replaceWith:{$cond:[protectedRow,'$$ROOT',{$mergeObjects:['$$ROOT',{$literal:set}]}]}}],{upsert:true}];
write._stationCreateDeferred=outcome.slice(1);
return [write,null,null,null,null,null];
`;
  node.wires = [[ids.createWrite], ...Array.from({ length: 5 }, () => [])];
  flow.push({ id: ids.createWrite, type: 'mongodb4', z: node.z, name: 'Guard station create collision', collection: 'lk_communities', operation: 'updateOne', clientNode: mongoClientId, mode: 'collection', output: 'toArray', handleDocId: false, maxTimeMS: '5000', wires: [[ids.createAck]] },
    { id: ids.createAck, type: 'function', z: node.z, name: 'Confirm station-safe community create', outputs: 5, wires: wires.slice(1), func: String.raw`
const deferred=msg._stationCreateDeferred;
if (!Array.isArray(deferred)) return null;
delete msg._stationCreateDeferred;
if (msg.error || msg.payload?.acknowledged !== true || !(msg.payload.upsertedCount === 1 || (msg.payload.matchedCount === 1 && msg.payload.modifiedCount === 1))) {
  const denied=Object.assign({},msg,{statusCode:msg.error||msg.payload?.acknowledged!==true?503:409,headers:{'Content-Type':'application/json','Cache-Control':'no-store'},payload:{error:'COMMUNITY_CREATE_NOT_COMMITTED'}});
  delete denied.error;
  return [null,null,null,denied,null];
}
for (const item of deferred) if (item) delete item._stationCreateDeferred;
return deferred;
` }, { id: ids.createCatch, type: 'catch', z: node.z, scope: [ids.createWrite], uncaught: false, wires: [[ids.createAck]] });
  return flow;
}
