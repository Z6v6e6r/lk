const asArray = (v) => Array.isArray(v) ? v : [];
const uniq = (arr) => Array.from(new Set(arr.filter(Boolean)));

const rows = asArray(msg.payload);
const ctx = msg._resultConfirm || {};

const pending = rows
  .filter((r) => r && typeof r === 'object' && String(r.status || '').toUpperCase() === 'PENDING_CONFIRMATION')
  .sort((a, b) => Number(b?.submittedAtTs || b?.createdTs || 0) - Number(a?.submittedAtTs || a?.createdTs || 0))[0] || null;

if (!pending) {
  msg.statusCode = 409;
  msg.headers = { "Content-Type": "application/json; charset=utf-8" };
  msg.payload = { error: 'No pending result to confirm' };
  return [null, msg, msg];
}

if (pending?.submittedBy?.phoneNorm === ctx.phone) {
  msg.statusCode = 409;
  msg.headers = { "Content-Type": "application/json; charset=utf-8" };
  msg.payload = { error: 'Result should be confirmed by opposite team player' };
  return [null, msg, msg];
}

const teamA = asArray(pending?.teams?.teamA);
const teamB = asArray(pending?.teams?.teamB);
if (teamA.length === 0 || teamB.length === 0) {
  msg.statusCode = 409;
  msg.headers = { "Content-Type": "application/json; charset=utf-8" };
  msg.payload = { error: 'Pending result has invalid teams' };
  return [null, msg, msg];
}

const phones = uniq([
  ...teamA.map((p) => p.phoneNorm),
  ...teamB.map((p) => p.phoneNorm),
]);

msg._resultPending = pending;
msg.payload = { phoneNorm: { $in: phones } };
return [msg, null, msg];
