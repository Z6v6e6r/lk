const fail = (statusCode, error) => { delete msg._cupLevel; msg.statusCode = statusCode; msg.headers = { 'Content-Type': 'application/json', 'Cache-Control': 'no-store', 'Access-Control-Allow-Origin': '*' }; msg.payload = { error }; return [null, msg]; };
if ([401, 403].includes(Number(msg.statusCode))) return fail(401, 'AUTH_TOKEN_INVALID');
if (Number(msg.statusCode) !== 200 || !msg.payload || typeof msg.payload !== 'object') return fail(503, 'AUTH_SERVICE_UNAVAILABLE');
const ctx = msg._cupLevel, profile = msg.payload;
const validId = id => typeof id === 'string' && /^[a-zA-Z0-9][a-zA-Z0-9._:-]{0,127}$/.test(id);
const actorId = profile.id || profile.clientId || profile.uuid;
if (!ctx || !validId(actorId)) return fail(503, 'AUTH_PROFILE_INVALID');
if (ctx.operation === 'fprMirror') {
  if (msg.error || msg.responseUrl !== 'https://api.vivacrm.ru/end-user/api/v1/iSkq6G/profile') {
    return fail(503, 'AUTH_SERVICE_UNAVAILABLE');
  }
  const fields = Array.isArray(profile.customFields)
    ? profile.customFields.filter(field => field?.id === 'e17a32f3-65f7-47c5-bda1-33d79932c884') : [];
  const access = fields.length === 1 ? fields[0] : null;
  const role = Array.isArray(access?.value) && access.value.length === 1 ? access.value[0] : null;
  const options = Array.isArray(access?.attributes?.options) ? access.attributes.options : [];
  const matchingOptions = options.filter(option => typeof role === 'string' && option?.id === role);
  const canHost = role === 'проводит турниры' || (matchingOptions.length === 1
    && String(matchingOptions[0].name || '').trim().toLowerCase() === 'проводит турниры');
  const claimedActor = ctx.body.changedById;
  if (!canHost || (claimedActor != null && claimedActor !== '' && claimedActor !== actorId)) {
    return fail(403, 'LEVEL_FORBIDDEN');
  }
  const decimal = String(ctx.body.levelNumeric ?? '').trim();
  const numeric = Number(decimal.replace(',', '.'));
  if (ctx.body.source !== 'tournament_start' || !validId(ctx.body.clientId)
    || !/^\d+(?:[.,]\d{1,5})?$/.test(decimal) || numeric < 1 || numeric > 7) {
    return fail(400, 'LEVEL_ARGUMENTS');
  }
  msg.payload = {
    ...ctx.body, levelNumeric: numeric.toFixed(5), changedById: actorId,
    changedByName: [profile.firstName, profile.lastName].filter(Boolean).join(' ') || null,
    changedByPhone: profile.phone || null,
  };
  delete msg._cupLevel; delete msg.headers; delete msg.statusCode; delete msg.requestTimeout;
  return [null, null, msg];
}
if (ctx.operation === 'initialize') {
  if (ctx.body.clientId && ctx.body.clientId !== actorId) return fail(403, 'LEVEL_FORBIDDEN');
  const numeric = Number(String(ctx.body.levelNumeric ?? '').replace(',', '.'));
  if (!Number.isFinite(numeric) || numeric < 1 || numeric > 7 || Math.abs(numeric * 1e5 - Math.round(numeric * 1e5)) > 1e-7) return fail(400, 'LEVEL_ARGUMENTS');
  msg.payload = { operation: 'initialize', actorId, clientId: actorId, ratingNumeric: numeric,
    phone: profile.phone || null, name: [profile.firstName, profile.lastName].filter(Boolean).join(' ') };
} else {
  const ids = ctx.operation === 'self' ? [actorId] : (Array.isArray(ctx.body.players) ? ctx.body.players.map(p => p?.clientId || p?.id) : null);
  if (!Array.isArray(ids) || !ids.length || ids.length > 100 || ids.some(id => !validId(id))) return fail(400, 'LEVEL_ARGUMENTS');
  msg.payload = { operation: 'read', actorId, clientIds: [...new Set(ids)] };
}
delete msg._cupLevel; delete msg.headers; delete msg.statusCode;
return [msg, null];
