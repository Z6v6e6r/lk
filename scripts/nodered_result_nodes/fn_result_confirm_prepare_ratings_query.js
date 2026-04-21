const asArray = (v) => Array.isArray(v) ? v : [];
const uniq = (arr) => Array.from(new Set(arr.filter(Boolean)));
const DISPUTE_WINDOW_MS = 24 * 60 * 60 * 1000;

const rows = asArray(msg.payload);
const ctx = msg._resultConfirm || {};

const pending = rows
  .filter((r) => r && typeof r === 'object' && ['PENDING_CONFIRMATION', 'PENDING_DISPUTE'].includes(String(r.status || '').toUpperCase()))
  .sort((a, b) => Number(b?.submittedAtTs || b?.createdTs || 0) - Number(a?.submittedAtTs || a?.createdTs || 0))[0] || null;

if (!pending) {
  msg.statusCode = 409;
  msg.headers = { "Content-Type": "application/json; charset=utf-8" };
  msg.payload = { error: 'No pending result to dispute' };
  return [null, msg, msg];
}

if (pending?.submittedBy?.phoneNorm === ctx.phone) {
  msg.statusCode = 409;
  msg.headers = { "Content-Type": "application/json; charset=utf-8" };
  msg.payload = { error: 'Result should be disputed by opposite team player' };
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

const submittedByTeam = pending?.submittedByTeam === 'A' || pending?.submittedByTeam === 'B'
  ? pending.submittedByTeam
  : teamA.some((p) => p.phoneNorm === pending?.submittedBy?.phoneNorm)
    ? 'A'
    : teamB.some((p) => p.phoneNorm === pending?.submittedBy?.phoneNorm)
      ? 'B'
      : null;
const disputerTeam = teamA.some((p) => p.phoneNorm === ctx.phone)
  ? 'A'
  : teamB.some((p) => p.phoneNorm === ctx.phone)
    ? 'B'
    : null;

if (!submittedByTeam || !disputerTeam || submittedByTeam === disputerTeam) {
  msg.statusCode = 409;
  msg.headers = { "Content-Type": "application/json; charset=utf-8" };
  msg.payload = { error: 'Only the opposite team can dispute result' };
  return [null, msg, msg];
}

const submittedAtTs = Number(pending?.submittedAtTs || pending?.createdTs || 0);
const disputeDeadlineTsRaw = Number(pending?.disputeDeadlineTs || 0);
const disputeDeadlineTs =
  Number.isFinite(disputeDeadlineTsRaw) && disputeDeadlineTsRaw > 0
    ? disputeDeadlineTsRaw
    : Number.isFinite(submittedAtTs) && submittedAtTs > 0
      ? submittedAtTs + DISPUTE_WINDOW_MS
      : null;

if (Number.isFinite(disputeDeadlineTs) && disputeDeadlineTs <= Date.now()) {
  msg.statusCode = 409;
  msg.headers = { "Content-Type": "application/json; charset=utf-8" };
  msg.payload = { error: 'Dispute window has expired' };
  return [null, msg, msg];
}

const phones = uniq([
  ...teamA.map((p) => p.phoneNorm),
  ...teamB.map((p) => p.phoneNorm),
]);

msg._resultPending = Object.assign({}, pending, {
  submittedByTeam,
  disputeDeadlineTs,
});
msg.payload = { phoneNorm: { $in: phones } };
return [msg, null, msg];
