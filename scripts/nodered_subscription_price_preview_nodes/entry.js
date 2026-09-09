const body = msg.payload;
const auth = msg.req?.headers?.authorization || msg.req?.headers?.Authorization;
const uuid = value => typeof value === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value);
const bad = code => {
  msg._subscriptionPricePreview = { done: true, statusCode: 400, error: code };
  return msg;
};
if (Object.keys(body || {}).some(key => !['target', 'subscriptionIds'].includes(key))) return bad('PRICE_PREVIEW_REQUEST_INVALID');
if (!auth || !/^Bearer\s+\S+$/i.test(auth) || !body || typeof body !== 'object' || Array.isArray(body)) return bad('PRICE_PREVIEW_AUTH_REQUIRED');
const target = body.target;
const ids = body.subscriptionIds;
const existing = target?.targetKind === 'EXISTING_GAME';
const allowedTarget = existing ? ['targetKind', 'gameId', 'startsAt', 'durationMinutes'] : ['targetKind', 'slotId', 'stationId', 'roomId', 'masterServiceId', 'subServiceIds', 'startsAt', 'durationMinutes', 'shareCount'];
if (!target || typeof target !== 'object' || Array.isArray(target) || Object.keys(target).some(key => !allowedTarget.includes(key))
  || (existing ? !(typeof target.gameId === 'string' && /^[A-Za-z0-9][A-Za-z0-9._:-]{0,199}$/.test(target.gameId)) : (target.targetKind !== 'NEW_GAME' || !(typeof target.slotId === 'string' && /^[A-Za-z0-9._:-]{1,200}$/.test(target.slotId)) || !uuid(target.stationId) || !uuid(target.roomId)
  || !uuid(target.masterServiceId) || !Array.isArray(target.subServiceIds) || target.subServiceIds.length < 1 || target.subServiceIds.length > 20
  || new Set(target.subServiceIds).size !== target.subServiceIds.length || target.subServiceIds.some(id => !uuid(id)) || ![2, 4].includes(target.shareCount)))
  || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?\+03:00$/.test(String(target.startsAt || ''))
  || !Number.isFinite(Date.parse(target.startsAt)) || Date.parse(target.startsAt) <= Date.now()
  || new Date(Date.parse(target.startsAt) + 180 * 60000).toISOString().slice(0, 19) !== target.startsAt.slice(0, 19)
  || ![60, 90, 120].includes(target.durationMinutes)
  || !Array.isArray(ids) || ids.length < 1 || ids.length > 20 || new Set(ids).size !== ids.length || ids.some(id => !uuid(id))) return bad('PRICE_PREVIEW_REQUEST_INVALID');
msg._subscriptionPricePreview = {
  done: false, step: 'start', auth, tenantKey: 'iSkq6G', requestedIds: ids,
  target: existing ? { ...target } : { ...target, subServiceIds: [...target.subServiceIds].sort() }, startedAt: Date.now(),
  existingGame: existing,
  selectionKey: existing ? JSON.stringify([target.targetKind, target.gameId, target.startsAt, target.durationMinutes])
    : JSON.stringify([target.slotId, target.stationId, target.roomId, target.masterServiceId,
      [...target.subServiceIds].sort(), target.startsAt, target.durationMinutes, target.shareCount]),
};
return msg;
