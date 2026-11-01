import crypto from 'node:crypto';
import { smPlayer, smIdentity } from './stationMembershipLifetime.mjs';

// Read-only STATION history. No candidate, outbox, event or receipt writes.
export const HISTORY_LEGACY_LIMIT = 2000;
export const HISTORY_MAX_TIME_MS = 3000;
const shUuid = value => typeof value === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(value);
const shObject = value => value && typeof value === 'object' && !Array.isArray(value);
const shFail = code => { throw new Error(code); };
const shTime = value => Number.isSafeInteger(value) && value > 0 && value <= 8_640_000_000_000_000;

export function historyActorAllowed(community, actor) {
  try {
    return typeof actor?.id === 'string' && community?.communityType === 'STATION' && community.archived !== true &&
      smPlayer(community, actor.id).state === 'ACTIVE' && Array.isArray(community.members) &&
      community.members.some(member => smIdentity(member) === actor.id && (!member.status || member.status === 'ACTIVE')) &&
      !(Array.isArray(community.bannedMembers) && community.bannedMembers.some(member => !smIdentity(member) || smIdentity(member) === actor.id));
  } catch { return false; }
}

export function historyRequest(communityId, query) {
  if (typeof communityId !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,199}$/.test(communityId)) shFail('HISTORY_REQUEST_INVALID');
  if (!shObject(query) || query.historyVersion !== '2' || Object.keys(query).some(key => !['historyVersion', 'limit', 'beforeTs', 'beforeId', 'clientId', 'phone', 'phoneNumber', 'mobile'].includes(key))) shFail('HISTORY_REQUEST_INVALID');
  // Existing identity query values are compatibility inputs only; the composed guard binds the actor.
  for (const key of ['clientId','phone','phoneNumber','mobile']) if (query[key] !== undefined && (typeof query[key] !== 'string' || query[key].length > (key === 'clientId' ? 200 : 64))) shFail('HISTORY_REQUEST_INVALID');
  const limit = query.limit === undefined ? 50 : typeof query.limit === 'string' && /^(?:[1-9]|[1-4][0-9]|50)$/.test(query.limit) ? Number(query.limit) : NaN;
  if (!Number.isInteger(limit)) shFail('HISTORY_REQUEST_INVALID');
  let before = null;
  if (query.beforeTs !== undefined) {
    if (typeof query.beforeTs !== 'string' || !/^(?:0|[1-9][0-9]{0,15})$/.test(query.beforeTs) || !shTime(Number(query.beforeTs))) shFail('HISTORY_CURSOR_INVALID');
    before = { createdTs: Number(query.beforeTs), publicId: null };
  }
  if (query.beforeId !== undefined) {
    if (!before || !shUuid(query.beforeId)) shFail('HISTORY_CURSOR_INVALID');
    before.publicId = query.beforeId;
  }
  return { communityId, limit, before };
}

export function historyMongoIdentity(row) {
  const id = row?._id;
  if (typeof id === 'string' && id.length > 0 && id.length <= 512) return { type: 'string', value: id };
  if (id?._bsontype === 'ObjectId' && typeof id.toHexString === 'function') {
    const value = id.toHexString();
    if (/^[a-f0-9]{24}$/.test(value)) return { type: 'objectId', value };
  }
  shFail('HISTORY_IDENTITY_INVALID');
}

export function historyLegacyId(communityId, row) {
  const identity = historyMongoIdentity(row);
  // RFC4122 UUIDv5, fixed private projection namespace. Canonical owner IDs are UUIDv8.
  const namespace = Buffer.from('3a89844107cf5be9a8526769cbca22d0', 'hex');
  const bytes = crypto.createHash('sha1').update(namespace).update(JSON.stringify(['station-history-legacy:v2', 'iSkq6G', 'lk_community_chat_messages', communityId, identity.type, identity.value])).digest().subarray(0, 16);
  bytes[6] = (bytes[6] & 15) | 80; bytes[8] = (bytes[8] & 63) | 128;
  const hex = bytes.toString('hex');
  return `${hex.slice(0,8)}-${hex.slice(8,12)}-${hex.slice(12,16)}-${hex.slice(16,20)}-${hex.slice(20)}`;
}

function shBoundedValue(paths, maxCharacters, otherTypes = ['null']) {
  const value = { $ifNull: [...paths, null] };
  // One extra character is retained so validation rejects oversized content instead of accepting
  // a truncated message. Malformed objects/arrays never reach the Node-RED heap.
  return { $cond: [
    { $eq: [{ $type: value }, 'string'] }, { $substrCP: [value, 0, maxCharacters + 1] },
    { $cond: [{ $in: [{ $type: value }, otherTypes] }, value, false] },
  ] };
}

export function historyFindArguments(request, legacy = false) {
  const filter = legacy
    ? { communityId: request.communityId, stationMessageOwner: { $ne: 1 }, archived: { $ne: true } }
    : { communityId: request.communityId, stationMessageOwner: 1, state: 'COMMITTED', archived: false };
  filter.recordType = { $ne: 'READ_COMMAND' };
  if (!legacy && request.before) {
    filter.$or = [{ createdTs: { $lt: request.before.createdTs } }];
    if (request.before.publicId) filter.$or.push({ createdTs: request.before.createdTs, id: { $lt: request.before.publicId } });
  }
  return [filter, {
    limit: legacy ? HISTORY_LEGACY_LIMIT + 1 : request.limit + 1,
    sort: legacy ? { _id: 1 } : { createdTs: -1, id: -1 },
    collation: { locale: 'simple' }, maxTimeMS: HISTORY_MAX_TIME_MS,
    projection: {
      _id: shBoundedValue(['$_id'],512,['objectId']),
      ...(legacy ? {
        stationMessageOwner: { $cond: [{ $eq: [{ $type: '$stationMessageOwner' }, 'missing'] }, '$$REMOVE', false] },
        archived: { $eq: ['$archived', true] },
      } : { stationMessageOwner: 1, state: 1, archived: 1 }),
      recordType: 1,
      communityId: shBoundedValue(['$communityId'],200), id: shBoundedValue(['$id'],36), publicId: shBoundedValue(['$publicId'],36),
      createdTs: shBoundedValue(['$createdTs'],64,['null','int','long','double']),
      timestamp: shBoundedValue(['$timestamp'],64,['null','int','long','double']),
      createdAt: shBoundedValue(['$createdAt'],64), publishedAt: shBoundedValue(['$publishedAt'],64),
      text: shBoundedValue(['$text','$body','$message'],8000),
      authorId: shBoundedValue(['$authorId','$author.id','$sender.id'],200),
      authorPhone: shBoundedValue(['$authorPhone','$author.phone','$author.phoneNorm','$sender.phone','$sender.phoneNorm'],64),
      authorName: shBoundedValue(['$authorName','$author.name','$sender.name',{$literal:'Игрок'}],120),
    },
  }];
}

const shCompare = (a, b) => a.createdTs - b.createdTs || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
function shLegacyTime(row) {
  for (const value of [row.createdTs, row.timestamp]) {
    if (value === undefined || value === null || value === '') continue;
    const number = typeof value === 'number' ? value : typeof value === 'string' && value.trim() ? Number(value.trim().replace(',', '.')) : NaN;
    if (!shTime(number)) shFail('HISTORY_TIMESTAMP_INVALID');
    return number;
  }
  for (const value of [row.publishedAt, row.createdAt]) {
    if (value === undefined || value === null || value === '') continue;
    const time = typeof value === 'string' ? Date.parse(value) : NaN;
    if (!shTime(time)) shFail('HISTORY_TIMESTAMP_INVALID');
    return time;
  }
  shFail('HISTORY_TIMESTAMP_INVALID');
}
function shMessage(request, row, legacy) {
  if (!shObject(row) || row.communityId !== request.communityId || row.archived === true || row.recordType === 'READ_COMMAND') shFail('HISTORY_ROW_INVALID');
  historyMongoIdentity(row);
  let id, createdTs;
  if (legacy) {
    if (Object.hasOwn(row, 'stationMessageOwner')) shFail('HISTORY_ROW_INVALID');
    id = historyLegacyId(request.communityId, row); createdTs = shLegacyTime(row);
  } else {
    if (row.stationMessageOwner !== 1 || row.state !== 'COMMITTED' || row.archived !== false || !shUuid(row.id) || row.id[14] !== '8' || row.publicId !== row.id || !shTime(row.createdTs) || typeof row.createdAt !== 'string' || Date.parse(row.createdAt) !== row.createdTs) shFail('HISTORY_ROW_INVALID');
    id = row.id; createdTs = row.createdTs;
  }
  const text = row.text ?? row.body ?? row.message;
  const authorName = row.authorName ?? row.author?.name ?? row.sender?.name ?? 'Игрок';
  if (typeof text !== 'string' || !text.trim() || text.length > 8000 || typeof authorName !== 'string' || !authorName.trim() || authorName.length > 120) shFail('HISTORY_ROW_INVALID');
  const authorId = row.authorId ?? row.author?.id ?? row.sender?.id ?? null;
  const authorPhone = row.authorPhone ?? row.author?.phone ?? row.author?.phoneNorm ?? row.sender?.phone ?? row.sender?.phoneNorm ?? null;
  if ((authorId !== null && (typeof authorId !== 'string' || authorId.length > 200)) || (authorPhone !== null && (typeof authorPhone !== 'string' || authorPhone.length > 64))) shFail('HISTORY_ROW_INVALID');
  // The integration adapter maps author identity; no Mongo ID, candidate or receipt is returned.
  return { id, text: text.trim(), createdAt: new Date(createdTs).toISOString(), createdTs, ...(authorId === null ? {} : {authorId}), ...(authorPhone === null ? {} : {authorPhone}), authorName: authorName.trim() };
}

export function historyPage(request, canonicalRows, legacyRows) {
  if (!Array.isArray(canonicalRows) || canonicalRows.length > request.limit + 1 || !Array.isArray(legacyRows)) shFail('HISTORY_STORE_INVALID');
  if (legacyRows.length > HISTORY_LEGACY_LIMIT) shFail('HISTORY_LEGACY_CAPACITY');
  const canonical = canonicalRows.map(row => shMessage(request, row, false));
  if (canonical.some((row, index) => index > 0 && shCompare(canonical[index - 1], row) <= 0)) shFail('HISTORY_ORDER_INVALID');
  const legacy = legacyRows.map(row => shMessage(request, row, true));
  const identities = new Set(), ids = new Set();
  for (const row of [...canonicalRows, ...legacyRows]) {
    const identity = JSON.stringify(historyMongoIdentity(row));
    if (identities.has(identity)) shFail('HISTORY_IDENTITY_COLLISION');
    identities.add(identity);
  }
  for (const row of [...canonical, ...legacy]) {
    if (ids.has(row.id)) shFail('HISTORY_IDENTITY_COLLISION');
    ids.add(row.id);
  }
  const boundary = request.before ? { createdTs: request.before.createdTs, id: request.before.publicId ?? '' } : null;
  if (boundary && canonical.some(row => shCompare(row, boundary) >= 0)) shFail('HISTORY_BOUNDARY_INVALID');
  const rows = [...canonical, ...legacy.filter(row => !boundary || shCompare(row, boundary) < 0)].sort((a,b) => shCompare(b,a));
  const selected = rows.slice(0, request.limit), hasMore = rows.length > selected.length;
  const last = selected.at(-1);
  const nextBefore = hasMore && last ? { createdTs: last.createdTs, publicId: last.id } : null;
  return { historyVersion: 2, messages: selected.map(({id,...row}) => ({publicId:id,...row})), hasMore, nextBefore };
}
