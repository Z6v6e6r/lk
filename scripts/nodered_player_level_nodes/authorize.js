const fail = (statusCode, error) => { delete msg._cupLevel; msg.statusCode = statusCode; msg.headers = { 'Content-Type': 'application/json', 'Cache-Control': 'no-store', 'Access-Control-Allow-Origin': '*' }; msg.payload = { error }; return [null, msg]; };
if ([401, 403].includes(Number(msg.statusCode))) return fail(401, 'AUTH_TOKEN_INVALID');
if (Number(msg.statusCode) !== 200 || !msg.payload || typeof msg.payload !== 'object') return fail(503, 'AUTH_SERVICE_UNAVAILABLE');
const ctx = msg._cupLevel, profile = msg.payload;
const validId = id => typeof id === 'string' && /^[a-zA-Z0-9][a-zA-Z0-9._:-]{0,127}$/.test(id);
const actorId = profile.id || profile.clientId || profile.uuid;
if (!ctx || !validId(actorId)) return fail(503, 'AUTH_PROFILE_INVALID');
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
