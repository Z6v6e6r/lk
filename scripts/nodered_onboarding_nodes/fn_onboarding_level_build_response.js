const asArray = (value) => Array.isArray(value) ? value : [];
const now = new Date().toISOString();
const results = asArray(msg.payload);
const failures = results.filter((item) => !item?.ok);
const ok = results.length > 0 && failures.length === 0;
const ratingAudit = msg.ratingAudit && typeof msg.ratingAudit === 'object'
  ? msg.ratingAudit
  : null;
const auditEventId = typeof ratingAudit?.eventId === 'string' && ratingAudit.eventId.trim()
  ? ratingAudit.eventId.trim()
  : null;
const projectionStatus = ok ? 'SYNCED' : 'FAILED';

const logDoc = {
  clientId: msg.clientId,
  phone: msg.clientPhone,
  playerName: msg.playerName || null,
  levelLetter: msg.levelLetter,
  levelNumeric: msg.levelNumeric,
  ip: msg.clientIp,
  source: msg.source || 'onboarding',
  gameId: msg.gameId || null,
  confirmedAt: msg.confirmedAt || null,
  auditEventId,
  createdAt: now,
  ratingAudit,
  projectionStatus,
  results,
};
const auditDoc = ratingAudit
  ? {
    eventId: ratingAudit.eventId,
    source: ratingAudit.source,
    gameId: ratingAudit.gameId,
    confirmedAt: ratingAudit.confirmedAt || null,
    player: ratingAudit.player || null,
    rating: ratingAudit.rating || null,
    changedBy: ratingAudit.changedBy || null,
    request: ratingAudit.request || null,
    createdAt: now,
    projectionStatus,
    vivaResult: results,
  }
  : null;
const response = {
  ok,
  projectionStatus,
  clientId: msg.clientId,
  levelLetter: msg.levelLetter,
  levelNumeric: msg.levelNumeric,
  auditEventId,
  updatedFields: results.filter((item) => item?.ok).map((item) => item.fieldId).filter(Boolean),
  failures: failures.map((item) => ({
    fieldId: item?.fieldId || null,
    httpStatus: item?.httpStatus || null,
    error: item?.error || 'Unknown Viva projection error',
  })),
};

return [
  { ...msg, payload: logDoc },
  auditDoc ? { ...msg, payload: auditDoc } : null,
  {
    ...msg,
    payload: response,
    statusCode: ok ? 200 : 502,
    headers: { 'Content-Type': 'application/json; charset=utf-8' },
  },
];
