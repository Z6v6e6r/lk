// Diagnostic observer: optional, no-throw; sourceHash is the uninstrumented business preimage.
const lkDiagnostic = (fields = {}) => {
  try {
    if (typeof global === "undefined" || typeof global.get !== "function") return;
    const observer = global.get("lkDiagnostics");
    observer?.observe(msg, "preview_entry", { sourceHash: "9e8b52eb081c55160c457e702174dda9fa35ca5e30c03fa27347f5e99e546cb2", ...fields });
  } catch { /* Observability cannot alter business execution. */ }
};
lkDiagnostic({ code: "STAGE_ENTER" });
const body = msg.payload;
const auth = msg.req?.headers?.authorization || msg.req?.headers?.Authorization;
const uuid = value => typeof value === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value);
// Capture only the first evaluated failing guard; never retain its input value.
let requestValidation;
const invalid = (failed, predicate, value) => {
  if (failed && !requestValidation) {
    const shape = value === undefined ? 'MISSING' : value === null ? 'NULL'
      : Array.isArray(value) ? 'ARRAY' : ({ string: 'STRING', number: 'NUMBER',
        boolean: 'BOOLEAN', object: 'OBJECT' }[typeof value] || 'OTHER');
    requestValidation = { firstFailedValidationPredicate: predicate, validationFieldShape: shape };
  }
  return failed;
};
const bad = code => {
  msg._subscriptionPricePreview = { done: true, statusCode: 400, error: code,
    ...(code === 'PRICE_PREVIEW_REQUEST_INVALID' ? requestValidation : {}) };
  return msg;
};
if (invalid(Object.keys(body || {}).some(key => !['target', 'subscriptionIds'].includes(key)), 'BODY_EXTRA_KEYS', body)) return bad('PRICE_PREVIEW_REQUEST_INVALID');
if (!auth || !/^Bearer\s+\S+$/i.test(auth) || !body || typeof body !== 'object' || Array.isArray(body)) return bad('PRICE_PREVIEW_AUTH_REQUIRED');
const target = body.target;
const ids = body.subscriptionIds;
const eventCategory = ['GROUP_TRAINING', 'TOURNAMENT'].includes(target?.targetKind) ? target.targetKind : null;
if (eventCategory) {
  if (invalid(!target, 'TARGET_SHAPE', target)
    || invalid(Object.keys(target).some(key => !['targetKind', 'exerciseId'].includes(key)), 'TARGET_EXTRA_KEYS', target)
    || invalid(!uuid(target.exerciseId), 'EVENT_ID_SHAPE', target.exerciseId)
    || (ids !== undefined && (invalid(!Array.isArray(ids), 'SUBSCRIPTIONS_SHAPE', ids)
      || invalid(ids.length < 1 || ids.length > 20, 'SUBSCRIPTIONS_COUNT', ids)
      || invalid(new Set(ids).size !== ids.length, 'SUBSCRIPTIONS_DUPLICATE', ids)
      || ids.some(id => invalid(!uuid(id), 'SUBSCRIPTION_ID_SHAPE', id))))) return bad('PRICE_PREVIEW_REQUEST_INVALID');
  msg._subscriptionPricePreview = { done: false, step: 'start', auth, tenantKey: 'iSkq6G',
    target: { ...target }, exerciseId: target.exerciseId, eventCategory, groupTraining: eventCategory === 'GROUP_TRAINING', requestedIds: ids,
    selectionKey: JSON.stringify([eventCategory, target.exerciseId]), startedAt: Date.now() };
  return msg;
}
const existing = target?.targetKind === 'EXISTING_GAME';
const allowedTarget = existing ? ['targetKind', 'gameId', 'startsAt', 'durationMinutes'] : ['targetKind', 'slotId', 'stationId', 'roomId', 'masterServiceId', 'subServiceIds', 'startsAt', 'durationMinutes', 'shareCount'];
if (invalid(!target || typeof target !== 'object' || Array.isArray(target), 'TARGET_SHAPE', target)
  || invalid(Object.keys(target).some(key => !allowedTarget.includes(key)), 'TARGET_EXTRA_KEYS', target)
  || (existing ? invalid(!(typeof target.gameId === 'string' && /^[A-Za-z0-9][A-Za-z0-9._:-]{0,199}$/.test(target.gameId)), 'GAME_ID_SHAPE', target.gameId)
    : (invalid(target.targetKind !== 'NEW_GAME', 'TARGET_KIND', target.targetKind)
      || invalid(!(typeof target.slotId === 'string' && /^[A-Za-z0-9._:-]{1,200}$/.test(target.slotId)), 'SLOT_ID_SHAPE', target.slotId)
      || invalid(!uuid(target.stationId), 'STATION_ID_SHAPE', target.stationId)
      || invalid(!uuid(target.roomId), 'ROOM_ID_SHAPE', target.roomId)
      || invalid(!uuid(target.masterServiceId), 'MASTER_ID_SHAPE', target.masterServiceId)
      || invalid(!Array.isArray(target.subServiceIds), 'SERVICES_SHAPE', target.subServiceIds)
      || invalid(target.subServiceIds.length < 1 || target.subServiceIds.length > 20, 'SERVICES_COUNT', target.subServiceIds)
      || invalid(new Set(target.subServiceIds).size !== target.subServiceIds.length, 'SERVICES_DUPLICATE', target.subServiceIds)
      || target.subServiceIds.some(id => invalid(!uuid(id), 'SERVICE_ID_SHAPE', id))
      || invalid(![2, 4].includes(target.shareCount), 'SHARE_ENUM', target.shareCount)))
  || invalid(!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?\+03:00$/.test(String(target.startsAt || '')), 'START_FORMAT', target.startsAt)
  || invalid(!Number.isFinite(Date.parse(target.startsAt)), 'START_PARSE', target.startsAt)
  || invalid(Date.parse(target.startsAt) <= Date.now(), 'START_NOT_FUTURE', target.startsAt)
  || invalid(new Date(Date.parse(target.startsAt) + 180 * 60000).toISOString().slice(0, 19) !== target.startsAt.slice(0, 19), 'START_CALENDAR', target.startsAt)
  || invalid(![60, 90, 120].includes(target.durationMinutes), 'DURATION_ENUM', target.durationMinutes)
  || invalid(!Array.isArray(ids), 'SUBSCRIPTIONS_SHAPE', ids)
  || invalid(ids.length < 1 || ids.length > 20, 'SUBSCRIPTIONS_COUNT', ids)
  || invalid(new Set(ids).size !== ids.length, 'SUBSCRIPTIONS_DUPLICATE', ids)
  || ids.some(id => invalid(!uuid(id), 'SUBSCRIPTION_ID_SHAPE', id))) return bad('PRICE_PREVIEW_REQUEST_INVALID');
msg._subscriptionPricePreview = {
  done: false, step: 'start', auth, tenantKey: 'iSkq6G', requestedIds: ids,
  target: existing ? { ...target } : { ...target, subServiceIds: [...target.subServiceIds].sort() }, startedAt: Date.now(),
  existingGame: existing,
  selectionKey: existing ? JSON.stringify([target.targetKind, target.gameId, target.startsAt, target.durationMinutes])
    : JSON.stringify([target.slotId, target.stationId, target.roomId, target.masterServiceId,
      [...target.subServiceIds].sort(), target.startsAt, target.durationMinutes, target.shareCount]),
};
return msg;
