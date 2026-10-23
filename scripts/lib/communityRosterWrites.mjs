// Typed membership mutations must commit before their response/derived writes.
const names = new Set(['Apply community join', 'Apply invite join', 'Apply member management']);
export function addCommunityRosterWrites(input) {
  const flow = structuredClone(input), byId = new Map(flow.map(node => [node.id, node]));
  for (const node of [...flow]) {
    if (node.type !== 'function' || !names.has(node.name)) continue;
    if (node.func.includes('COMMUNITY_ROSTER_COMMIT_BARRIER')) {
      if (!node.func.includes('EVENT_REGISTRATION_COMMIT_V1')) {
        if (!node.func.includes(LEGACY_BARRIER)) throw new Error('EVENT_ROSTER_BARRIER_DRIFT');
        node.func = node.func.replace(LEGACY_BARRIER, EVENT_BARRIER);
      }
      continue;
    }
    const originalWires = structuredClone(node.wires || []);
    if (Number(node.outputs) !== 6 || originalWires.length !== 6 || originalWires[0].length !== 1) throw new Error('COMMUNITY_ROSTER_MUTATION_SHAPE_DRIFT');
    let write = byId.get(originalWires[0][0]);
    if (write?.type === 'function' && write.wires?.[0]?.length === 1) write = byId.get(write.wires[0][0]);
    if (!write || write.collection !== 'lk_communities' || !['update', 'updateOne'].includes(write.operation) || !['mongodb out', 'mongodb4'].includes(write.type)) throw new Error('COMMUNITY_ROSTER_WRITE_NOT_PROVEN');
    if (write.wires?.some(group => group.length)) throw new Error('COMMUNITY_ROSTER_WRITE_ACK_DRIFT');
    const ackId = node.id + '-typed-roster-ack';
    if (byId.has(ackId)) throw new Error('COMMUNITY_ROSTER_ACK_ID_COLLISION');
    node.func = `// COMMUNITY_ROSTER_COMMIT_BARRIER\nconst outcome = (function() {\n${node.func}\n}).call(this);\n` + EVENT_BARRIER;
    const ack = { id: ackId, type: 'function', z: node.z, name: 'Confirm typed community roster commit', outputs: 5, wires: originalWires.slice(1), func: String.raw`
const deferred = msg._communityRosterDeferred;
if (!deferred) return null;
delete msg._communityRosterDeferred;
if (!msg.payload?.acknowledged || msg.payload.matchedCount !== 1) {
  const denied = Object.assign({}, msg, { statusCode: 409, headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' }, payload: { error: 'COMMUNITY_MEMBERS_CHANGED' } });
  return [null, null, null, denied, denied];
}
for (const message of deferred) if (message) { delete message._communityRosterDeferred; delete message._communityPolicyPreimage; delete message._eventEntry; if (message._communityJoin?.community?.communityType === 'EVENT') delete message._communityJoin; }
return deferred;
`, x: (write.x || 0) + 200, y: write.y || 0 };
    write.wires = [[ackId]]; flow.push(ack); byId.set(ackId, ack);
  }
  return flow;
}

const EVENT_BARRIER = String.raw`
const preimage = msg._communityPolicyPreimage;
if (!Array.isArray(outcome) || (!outcome[0] && !(preimage?.communityType === 'EVENT' && msg._eventEntry && outcome[4]?.statusCode === 200)) || !['STATION','CORPORATE','LEAGUE','EVENT'].includes(preimage?.communityType)) return outcome;
// EVENT_REGISTRATION_COMMIT_V1
if (preimage.communityType === 'EVENT') {
  outcome[5] = null;
  if (msg._eventEntry) {
    if (!outcome[0] && outcome[4]?.statusCode === 200) outcome[0] = Object.assign({}, msg, {query: {id: preimage.id}, payload: {$set: {updatedAt: new Date().toISOString()}}});
    if (outcome[0]) {
      outcome[0].payload.$set.eventEntries = [...(Array.isArray(preimage.eventEntries) ? preimage.eventEntries : []).filter(item => item.playerId !== msg._eventEntry.playerId), msg._eventEntry];
      if (preimage.eventEntriesRevision !== undefined && (!Number.isSafeInteger(preimage.eventEntriesRevision) || preimage.eventEntriesRevision < 0 || preimage.eventEntriesRevision >= Number.MAX_SAFE_INTEGER)) throw new Error('EVENT_REVISION_INVALID');
      outcome[0].query.eventEntriesRevision = Object.prototype.hasOwnProperty.call(preimage, 'eventEntriesRevision') ? preimage.eventEntriesRevision : {$exists:false};
      outcome[0].payload.$set.eventEntriesRevision = (Number(preimage.eventEntriesRevision) || 0) + 1;
    }
  }
}
const write = outcome[0];
if (!write.payload?.$set || !write.query || !write.query.id || write.query.id !== preimage.id) throw new Error('COMMUNITY_ROSTER_PREIMAGE_REQUIRED');
for (const field of ['members','pendingMembers','bannedMembers']) write.query[field] = Object.prototype.hasOwnProperty.call(preimage, field) ? preimage[field] : { $exists: false };
write.query.communityType = preimage.communityType;
write.query.typeSettingsRevision = preimage.typeSettingsRevision;
const allowed = ['members','pendingMembers','bannedMembers','memberCount','membersCount','pendingCount','updatedAt'];
if (preimage.communityType === 'EVENT') allowed.push('eventEntries', 'eventEntriesRevision');
if (Object.keys(write.payload.$set).some(key => !allowed.includes(key))) throw new Error('COMMUNITY_ROSTER_WRITE_SCOPE_DRIFT');
write._communityRosterDeferred = outcome.slice(1);
return [write, null, null, null, null, null];
`;

const LEGACY_BARRIER = "const preimage = msg._communityPolicyPreimage;\nif (!Array.isArray(outcome) || !outcome[0] || !['STATION','CORPORATE','LEAGUE','EVENT'].includes(preimage?.communityType)) return outcome;\nconst write = outcome[0];\nif (!write.payload?.$set || !write.query || !write.query.id || write.query.id !== preimage.id) throw new Error('COMMUNITY_ROSTER_PREIMAGE_REQUIRED');\nfor (const field of ['members','pendingMembers','bannedMembers']) write.query[field] = Object.prototype.hasOwnProperty.call(preimage, field) ? preimage[field] : { $exists: false };\nwrite.query.communityType = preimage.communityType;\nwrite.query.typeSettingsRevision = preimage.typeSettingsRevision;\nconst allowed = ['members','pendingMembers','bannedMembers','memberCount','membersCount','pendingCount','updatedAt'];\nif (Object.keys(write.payload.$set).some(key => !allowed.includes(key))) throw new Error('COMMUNITY_ROSTER_WRITE_SCOPE_DRIFT');\nwrite._communityRosterDeferred = outcome.slice(1);\nreturn [write, null, null, null, null, null];";
