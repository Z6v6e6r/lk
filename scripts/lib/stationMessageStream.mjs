import { smStream, smLifetime, smMongoIdentity, smUuid, smId, smEqual, smHash, smIdentity, smSequence, smKeys } from './stationMembershipLifetime.mjs';

// Concrete STATION stream storage. No automatic adoption, collection or index creation.
export function stationStreamAdoptionPlan(community, streamId) {
  if ((!smUuid(streamId) || streamId.length !== 36) || !smMongoIdentity(community) || community.communityType !== 'STATION' || community.archived === true ||
    (community.communityMessageOutbox !== undefined && (!Array.isArray(community.communityMessageOutbox) || community.communityMessageOutbox.length))) throw Error('STREAM_ADOPTION_REQUIRES_DRAIN');
  const previous = smLifetime(community);
  if (previous.version !== 1 || !smSequence(previous.revision + 1) || !Array.isArray(community.members)) throw Error('STREAM_ADOPTION_INVALID');
  const players = structuredClone(previous.players), seen = new Set();
  for (const member of community.members) {
    const id = smIdentity(member);
    if (!id || seen.has(id) || (member.status && member.status !== 'ACTIVE')) throw Error('STREAM_ADOPTION_INVALID');
    seen.add(id);
    const existing = players.find(p => p.playerId === id);
    if (existing && existing.state !== 'ACTIVE') throw Error('STREAM_ADOPTION_INVALID');
    if (!existing) players.push({ playerId: id, epoch: 0, state: 'ACTIVE' });
  }
  for (const player of players) {
    delete player.readPosition;
    if (player.state === 'ACTIVE') player.readPosition = { streamId, baselineSequence: 0, readThroughSequence: 0 };
  }
  return {
    filter: { _id: community._id, $expr: { $eq: ['$$ROOT', { $literal: community }] } },
    update: { $set: {
      communityMessageOutbox: { version: 2, streamId, revision: 0, acceptedSequence: 0, publishedSequence: 0, intents: [] },
      stationMembershipLifetime: { version: 2, streamId, revision: previous.revision + 1, players },
    } },
    options: { upsert: false, maxTimeMS: 3000 },
  };
}

export function stationStreamEnvelope(community) {
  const stream = smStream(community);
  if (!stream) throw Error('READ_STREAM_UNAVAILABLE');
  smLifetime(community);
  const keys = new Set(), sequences = new Set();
  for (const intent of stream.intents) {
    if (!intent || typeof intent.id !== 'string' || keys.has(intent.id) || !['MESSAGE', 'READ_COMMAND'].includes(intent.kind) ||
      !smUuid(intent.requestId) || !smId(intent.actorId) || !smId(intent.communityId) || intent.communityId !== community.id ||
      !smEqual(intent.communityIdentity, smMongoIdentity(community)) || intent.streamId !== stream.streamId || !smSequence(intent.epoch)) throw Error('STATION_STREAM_INTENT_INVALID');
    keys.add(intent.id);
    if (intent.kind === 'MESSAGE') {
      if (!smSequence(intent.sequence) || intent.sequence < 1 || intent.sequence <= stream.publishedSequence || intent.sequence > stream.acceptedSequence || sequences.has(intent.sequence) || typeof intent.published !== 'boolean') throw Error('STATION_STREAM_SEQUENCE_INVALID');
      if(intent.message?.recordType!=='MESSAGE'||intent.message.streamId!==stream.streamId||intent.message.sequence!==intent.sequence||!smUuid(intent.message.id)||intent.message.communityId!==community.id||intent.message.authorId!==intent.actorId||typeof intent.message.text!=='string'||intent.event?.type!=='CHAT_MESSAGE_CREATED'||intent.event.streamId!==stream.streamId||intent.event.sequence!==intent.sequence||intent.event.payload?.messageId!==intent.message.id||intent.requestHash!==smHash('station-message-request:v1',{communityId:community.id,actorId:intent.actorId,text:intent.message.text}))throw Error('STATION_STREAM_INTENT_INVALID');
      sequences.add(intent.sequence);
    } else if ('sequence' in intent || 'message' in intent || 'event' in intent || 'published' in intent) throw Error('STATION_READ_INTENT_INVALID');
  }
  if (stream.acceptedSequence - stream.publishedSequence !== sequences.size) throw Error('STATION_STREAM_GAP');
  return stream;
}

export function stationStreamAppend(community, intent) {
  const stream = stationStreamEnvelope(community);
  if (stream.intents.length >= 32 || !smSequence(stream.revision + 1) || stream.intents.some(i => i.id === intent.id)) throw Error('MESSAGE_OUTBOX_FULL');
  const next = structuredClone(stream);
  next.revision++;
  if (intent.kind === 'MESSAGE') {
    if (!smSequence(stream.acceptedSequence + 1) || intent.sequence !== stream.acceptedSequence + 1) throw Error('STATION_STREAM_SEQUENCE_INVALID');
    next.acceptedSequence++;
  }
  next.intents.push(intent);
  return next;
}

// Only a caller that read back the exact durable message AND event may publish a slot.
export function stationStreamPublished(community, originalIntent) {
  const stream = stationStreamEnvelope(community), next = structuredClone(stream);
  const found = next.intents.find(i => i.id === originalIntent.id);
  if (!found || !smEqual({ ...found, published: false }, { ...originalIntent, published: false }) || found.kind !== 'MESSAGE') throw Error('STATION_STREAM_INTENT_CHANGED');
  found.published = true;
  while (next.intents.some(i => i.kind === 'MESSAGE' && i.sequence === next.publishedSequence + 1 && i.published)) next.publishedSequence++;
  next.intents = next.intents.filter(i => i.kind !== 'MESSAGE' || i.sequence > next.publishedSequence);
  if (!smSequence(next.revision + 1)) throw Error('STATION_STREAM_SEQUENCE_INVALID');
  next.revision++;
  return next;
}

export function stationStreamReceiptDigest(receipt) {
  return smHash('station-read-receipt:v1', receipt);
}

export function stationReadBody(body) {
  return smKeys(body, ['requestId','streamId','membershipEpoch','throughSequence']) && smUuid(body.requestId) && body.requestId.length === 36 && smUuid(body.streamId) && body.streamId.length === 36 && smSequence(body.membershipEpoch) && smSequence(body.throughSequence);
}
