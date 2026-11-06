const fail = (statusCode, error) => {
  msg.statusCode = statusCode;
  msg.headers = { 'Content-Type': 'application/json', 'Cache-Control': 'no-store', 'Access-Control-Allow-Origin': '*' };
  msg.payload = { error, message: 'Не удалось подтвердить доступ к стартовым уровням ФПР' };
  delete msg._fprStart;
  return [null, msg];
};
if (!msg._fprStart) return fail(500, 'FPR_START_CONTEXT_MISSING');
if ([401,403].includes(Number(msg.statusCode))) return fail(401, 'AUTH_TOKEN_INVALID');
if (Number(msg.statusCode) !== 200 || !msg.payload || typeof msg.payload !== 'object') return fail(503, 'AUTH_SERVICE_UNAVAILABLE');
const profile = msg.payload;
const field = (Array.isArray(profile.customFields) ? profile.customFields : []).find(f => f.id === 'e17a32f3-65f7-47c5-bda1-33d79932c884');
const selected = field?.value?.[0];
const host = selected === 'проводит турниры' || (Array.isArray(field?.attributes?.options) ? field.attributes.options : [])
  .some(o => o.id === selected && String(o.name || '').trim().toLowerCase() === 'проводит турниры');
if (!(profile.id || profile.clientId || profile.uuid) || !host) return fail(403, 'FPR_HOST_ACCESS_REQUIRED');
// Exact IDs and explicitly recorded client aliases only. No phone/name matching.
msg.payload = [{ $or: [{ clientId: { $in: msg._fprStart.ids } }, { 'identityAliases.clientIds': { $in: msg._fprStart.ids } }] },
  { limit: 85, maxTimeMS: 5000, projection: { clientId: 1, playerKey: 1, identityAliases: 1, ownership: 1, ratingNumeric: 1, lastEventId: 1 } }];
delete msg.statusCode;
delete msg.headers;
return [msg, null];
