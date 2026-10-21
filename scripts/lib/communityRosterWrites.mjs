// Typed membership mutations must commit before their response/derived writes.
const names = new Set(['Apply community join', 'Apply invite join', 'Apply member management']);
export function addCommunityRosterWrites(input) {
  const flow = structuredClone(input), byId = new Map(flow.map(node => [node.id, node]));
  for (const node of [...flow]) {
    if (node.type !== 'function' || !names.has(node.name) || node.func.includes('COMMUNITY_ROSTER_COMMIT_BARRIER')) continue;
    const originalWires = structuredClone(node.wires || []);
    if (Number(node.outputs) !== 6 || originalWires.length !== 6 || originalWires[0].length !== 1) throw new Error('COMMUNITY_ROSTER_MUTATION_SHAPE_DRIFT');
    let write = byId.get(originalWires[0][0]);
    if (write?.type === 'function' && write.wires?.[0]?.length === 1) write = byId.get(write.wires[0][0]);
    if (!write || write.collection !== 'lk_communities' || !['update', 'updateOne'].includes(write.operation) || !['mongodb out', 'mongodb4'].includes(write.type)) throw new Error('COMMUNITY_ROSTER_WRITE_NOT_PROVEN');
    if (write.wires?.some(group => group.length)) throw new Error('COMMUNITY_ROSTER_WRITE_ACK_DRIFT');
    const ackId = node.id + '-typed-roster-ack';
    if (byId.has(ackId)) throw new Error('COMMUNITY_ROSTER_ACK_ID_COLLISION');
    node.func = `// COMMUNITY_ROSTER_COMMIT_BARRIER\nconst outcome = (function() {\n${node.func}\n}).call(this);\n` + String.raw`
const preimage = msg._communityPolicyPreimage;
if (!Array.isArray(outcome) || !outcome[0] || !['STATION','CORPORATE','LEAGUE'].includes(preimage?.communityType)) return outcome;
const write = outcome[0];
if (!write.payload?.$set || !write.query || !write.query.id || write.query.id !== preimage.id) throw new Error('COMMUNITY_ROSTER_PREIMAGE_REQUIRED');
for (const field of ['members','pendingMembers','bannedMembers']) write.query[field] = Object.prototype.hasOwnProperty.call(preimage, field) ? preimage[field] : { $exists: false };
write.query.communityType = preimage.communityType;
write.query.typeSettingsRevision = preimage.typeSettingsRevision;
const allowed = ['members','pendingMembers','bannedMembers','memberCount','membersCount','pendingCount','updatedAt'];
if (Object.keys(write.payload.$set).some(key => !allowed.includes(key))) throw new Error('COMMUNITY_ROSTER_WRITE_SCOPE_DRIFT');
write._communityRosterDeferred = outcome.slice(1);
return [write, null, null, null, null, null];
`;
    const ack = { id: ackId, type: 'function', z: node.z, name: 'Confirm typed community roster commit', outputs: 5, wires: originalWires.slice(1), func: String.raw`
const deferred = msg._communityRosterDeferred;
if (!deferred) return null;
delete msg._communityRosterDeferred;
if (!msg.payload?.acknowledged || msg.payload.matchedCount !== 1) {
  const denied = Object.assign({}, msg, { statusCode: 409, headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' }, payload: { error: 'COMMUNITY_MEMBERS_CHANGED' } });
  return [null, null, null, denied, denied];
}
for (const message of deferred) if (message) { delete message._communityRosterDeferred; delete message._communityPolicyPreimage; }
return deferred;
`, x: (write.x || 0) + 200, y: write.y || 0 };
    write.wires = [[ackId]]; flow.push(ack); byId.set(ackId, ack);
  }
  return flow;
}
