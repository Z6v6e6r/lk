const fail = (statusCode, error, playerId) => {
  msg.statusCode = statusCode;
  msg.headers = { 'Content-Type': 'application/json', 'Cache-Control': 'no-store', 'Access-Control-Allow-Origin': '*' };
  msg.payload = { error, ...(playerId ? { playerId } : {}), message: 'Стартовый уровень ЦУП недоступен или изменился. Обновите данные состава.' };
  delete msg._fprStart;
  return [null, msg];
};
const ctx = msg._fprStart;
if (!ctx || !Array.isArray(msg.payload) || msg.payload.length > 84) return fail(503, 'FPR_CANONICAL_START_NOT_READY');
const states = msg.payload;
// Opaque source version: raw ledger event IDs can contain historical phone aliases.
const sourceVersion = value => {
  let h = 0xcbf29ce484222325n;
  for (const c of value) h = BigInt.asUintN(64, (h ^ BigInt(c.charCodeAt(0))) * 0x100000001b3n);
  return 'v1-' + h.toString(16).padStart(16, '0');
};
const rows = [];
const used = new Set();
for (const id of ctx.ids) {
  const matches = states.filter(s => s.clientId === id || (Array.isArray(s.identityAliases?.clientIds) && s.identityAliases.clientIds.includes(id)));
  if (matches.length !== 1) return fail(503, 'FPR_CANONICAL_IDENTITY_CONFLICT', id);
  const s = matches[0];
  if (used.has(s.playerKey) || s.ownership !== 'CUP_CANONICAL' || typeof s.playerKey !== 'string' || typeof s.clientId !== 'string' || !s.clientId
    || typeof s.ratingNumeric !== 'number' || !Number.isFinite(s.ratingNumeric)
    || s.ratingNumeric < 1 || s.ratingNumeric > 7 || typeof s.lastEventId !== 'string' || !s.lastEventId) return fail(503, 'FPR_CANONICAL_START_NOT_READY', id);
  used.add(s.playerKey);
  rows.push({ clientId: id, ratingNumeric: s.ratingNumeric, version: sourceVersion(JSON.stringify([s.playerKey, s.lastEventId, s.ratingNumeric])) });
}
const snapshot = { source: 'CUP_CANONICAL', rows };
delete msg._fprStart;
delete msg.projection;
delete msg.limit;
if (ctx.create) {
  const supplied = ctx.body.params?.fprCanonicalStart;
  if (supplied?.source !== snapshot.source || !Array.isArray(supplied.rows) || supplied.rows.length !== rows.length
    || rows.some(r => supplied.rows.filter(s => s.clientId === r.clientId && s.ratingNumeric === r.ratingNumeric && s.version === r.version).length !== 1
      || ctx.body.params.fpr6x25.players.find(p => p.id === r.clientId)?.level !== r.ratingNumeric)) return fail(409, 'FPR_CANONICAL_START_CHANGED');
  msg.payload = { ...ctx.body, params: { ...ctx.body.params, fprCanonicalStart: snapshot },
    participants: (ctx.body.participants || []).map(p => ({ ...p, rating: String(rows.find(r => r.clientId === p.id)?.ratingNumeric ?? '') })) };
  delete msg.statusCode;
  return [msg, null];
}
msg.statusCode = 200;
msg.headers = { 'Content-Type': 'application/json', 'Cache-Control': 'no-store', 'Access-Control-Allow-Origin': '*' };
msg.payload = snapshot;
return [null, msg];
