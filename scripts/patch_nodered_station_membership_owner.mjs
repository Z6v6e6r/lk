import crypto from 'node:crypto';
import vm from 'node:vm';
import { stationMembershipReceiverSource } from './lib/stationMembershipReceiverSource.mjs';
import { addCommunityRosterWrites } from './lib/communityRosterWrites.mjs';
import { addTypedCommunityResponseRedaction } from './lib/communityResponseRedaction.mjs';

export const stationOwnerIds = Object.fromEntries(['tab','admissionIn','confirmationIn','admissionVerify','confirmationVerify','router','admissionFind','admissionWrite','communityFind','communityWrite','claimFind','claimWrite','response','catch']
  .map(key => [key, 'lk_station_membership_' + key + '_v1']));
export function stationOwnerNodes(mongoClientId) {
  const id = stationOwnerIds, z = id.tab;
  const fn = (key, outputs, func, wires) => ({ id: id[key], type: 'function', z, name: 'Station membership ' + key, outputs, func, libs: [{ var: 'nodeCrypto', module: 'crypto' }], wires });
  const mongo = (key, collection, operation) => ({ id: id[key], type: 'mongodb4', z, name: 'Station membership ' + key,
    collection, operation, clientNode: mongoClientId, mode: 'collection', output: 'toArray', maxTimeMS: '5000', handleDocId: false, wires: [[id.router]] });
  return [
    { id: id.tab, type: 'tab', label: 'STATION membership owner v1 (source default off)', disabled: false },
    ...['admission','confirmation'].map(mode => ({ id: id[mode + 'In'], type: 'http in', z, name: 'Station membership ' + mode, method: 'post',
      url: '/lk/integrations/v1/station-memberships/operations/:operationId/' + mode, upload: false, wires: [[id[mode + 'Verify']]] })),
    ...['admission','confirmation'].map(mode => fn(mode + 'Verify', 2, stationMembershipReceiverSource('verify', mode), [[id.admissionFind], [id.response]])),
    fn('router', 7, stationMembershipReceiverSource('router'), ['admissionFind','admissionWrite','communityFind','communityWrite','claimFind','claimWrite','response'].map(k => [id[k]])),
    mongo('admissionFind', 'lk_station_membership_admissions', 'find'),
    mongo('admissionWrite', 'lk_station_membership_admissions', 'updateOne'),
    mongo('communityFind', 'lk_communities', 'find'), mongo('communityWrite', 'lk_communities', 'updateOne'),
    mongo('claimFind', 'lk_station_membership_generation_claims', 'find'), mongo('claimWrite', 'lk_station_membership_generation_claims', 'updateOne'),
    { id: id.response, type: 'http response', z, name: 'Private station membership response', wires: [] },
    { id: id.catch, type: 'catch', z, name: 'Station store ambiguity recovery', scope: ['admissionFind','admissionWrite','communityFind','communityWrite','claimFind','claimWrite'].map(k => id[k]), uncaught: false, wires: [[id.router]] },
  ];
}
// Pure exact-preimage candidate construction. Never reads credentials or deploys a graph.
export function buildStationMembershipOwner(bytes, { expectedFlowSha256, mongoClientId }) {
  const buffer = Buffer.from(bytes);
  if (!/^[a-f0-9]{64}$/.test(expectedFlowSha256 || '') || crypto.createHash('sha256').update(buffer).digest('hex') !== expectedFlowSha256) throw Error('STATION_FLOW_PREIMAGE_MISMATCH');
  const original = JSON.parse(buffer);
  if (!Array.isArray(original) || new Set(original.map(n => n.id)).size !== original.length) throw Error('STATION_FLOW_INVALID');
  if (!original.some(n => n.id === mongoClientId && n.type === 'mongodb4-client') ||
    !original.some(n => n.type === 'mongodb4' && n.collection === 'lk_communities' && n.clientNode === mongoClientId)) throw Error('STATION_COMMUNITY_MONGO_BINDING_MISSING');
  for (const name of ['Apply community join','Apply invite join','Apply member management']) {
    const nodes = original.filter(n => n.type === 'function' && n.name === name && n.d !== true);
    if (nodes.length !== 1 || !nodes[0].func.includes('COMMUNITY_TYPED_ACCESS_GUARD') || !nodes[0].func.includes('COMMUNITY_ROSTER_COMMIT_BARRIER')) throw Error('STATION_ROSTER_PREREQUISITE_MISSING');
  }
  const nodes = stationOwnerNodes(mongoClientId), ids = new Set(nodes.map(n => n.id));
  if (original.some(n => ids.has(n.id) || (n.type === 'http in' && /station-memberships/.test(n.url || '')))) throw Error('STATION_OWNER_ALREADY_PRESENT_OR_ROUTE_COLLISION');
  const flow = [...addTypedCommunityResponseRedaction(addCommunityRosterWrites(original)), ...nodes];
  const all = new Set(flow.map(n => n.id));
  for (const node of flow) {
    for (const targets of node.wires || []) for (const target of targets) if (!all.has(target)) throw Error('STATION_BROKEN_WIRE');
    if (node.type === 'function') new vm.Script('(function(msg,env,nodeCrypto){' + node.func + '\n})');
  }
  const changes = flow.filter(n => JSON.stringify(n) !== JSON.stringify(original.find(o => o.id === n.id))).map(n => ({ id: n.id, name: n.name || n.type }));
  return { flow, changes, activationRequired: true, providerNodesAdded: 0 };
}
