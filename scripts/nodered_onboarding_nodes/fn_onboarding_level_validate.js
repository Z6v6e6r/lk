const body = msg.payload && typeof msg.payload === 'object' ? msg.payload : {};
const clientId = body.clientId || body.id;
const toTrimmed = (value) => {
  if (value === null || value === undefined) return null;
  const text = String(value).trim();
  return text || null;
};
const toNumber = (value) => {
  if (value === null || value === undefined || value === '') return null;
  const parsed = Number(String(value).trim().replace(',', '.'));
  return Number.isFinite(parsed) ? parsed : null;
};
const errorResponse = (error, code) => {
  msg.statusCode = 400;
  msg.headers = { 'Content-Type': 'application/json; charset=utf-8' };
  msg.payload = { error, code };
  return [null, msg];
};

if (!clientId) return errorResponse('clientId required', 'CLIENT_ID_REQUIRED');

const rawLetter = toTrimmed(body.levelLetter);
const rawNumeric = toTrimmed(body.levelNumeric);
if (!rawLetter && !rawNumeric) {
  return errorResponse('levelLetter or levelNumeric required', 'LEVEL_VALUE_REQUIRED');
}

const parsedNumeric = rawNumeric === null ? null : toNumber(rawNumeric);
if (rawNumeric !== null && parsedNumeric === null) {
  return errorResponse('levelNumeric must be a finite number', 'LEVEL_NUMERIC_INVALID');
}

const levelLetter = rawLetter || '';
const levelNumeric = parsedNumeric === null ? '' : parsedNumeric.toFixed(5);
const xff = (msg.req?.headers?.['x-forwarded-for'] || '').split(',')[0].trim();
const ip = xff || msg.req?.connection?.remoteAddress || msg.req?.ip || null;
const source = toTrimmed(body.source) || 'onboarding';
const previousRating = toNumber(body.previousRating ?? body.ratingBefore);
const nextRating = toNumber(body.nextRating ?? body.ratingAfter ?? levelNumeric);
const ratingDelta = previousRating !== null && nextRating !== null
  ? Number((nextRating - previousRating).toFixed(5))
  : null;
const confirmedAt = toTrimmed(body.confirmedAt);
const changedBy = {
  id: toTrimmed(body.changedById),
  name: toTrimmed(body.changedByName),
  phone: toTrimmed(body.changedByPhone),
};

msg.clientId = clientId;
msg.clientPhone = body.phone || body.clientPhone || null;
msg.playerName = toTrimmed(body.playerName);
msg.levelLetter = levelLetter;
msg.levelNumeric = levelNumeric;
msg.clientIp = ip;
msg.source = source;
msg.gameId = toTrimmed(body.gameId);
msg.confirmedAt = confirmedAt;
msg.ratingAudit = {
  eventId: toTrimmed(body.eventId) || `rating_evt_${clientId}_${Date.now()}`,
  source,
  gameId: toTrimmed(body.gameId),
  player: {
    clientId,
    name: toTrimmed(body.playerName),
    phone: body.phone || body.clientPhone || null,
  },
  rating: {
    previous: previousRating,
    next: nextRating,
    delta: ratingDelta,
    levelLetter,
    levelNumeric,
  },
  confirmedAt,
  changedBy,
  request: { ip },
};

return [msg, null];
