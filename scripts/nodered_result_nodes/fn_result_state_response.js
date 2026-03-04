const asArray = (v) => Array.isArray(v) ? v : [];

const rows = asArray(msg.payload);
const ctx = msg._resultState || {};

const latest = rows
  .filter((r) => r && typeof r === 'object')
  .sort((a, b) => Number(b?.submittedAtTs || b?.createdTs || 0) - Number(a?.submittedAtTs || a?.createdTs || 0))[0] || null;

const pending = latest && String(latest.status || '').toUpperCase() === 'PENDING_CONFIRMATION' ? latest : null;
const confirmed = latest && String(latest.status || '').toUpperCase() === 'CONFIRMED' ? latest : null;

const inTeamA = asArray(ctx?.teams?.teamA).some((p) => p.phoneNorm === ctx.phone);
const inTeamB = asArray(ctx?.teams?.teamB).some((p) => p.phoneNorm === ctx.phone);

const canSubmit = Boolean(ctx.isFinished && inTeamA && !pending && !confirmed);
const canConfirm = Boolean(
  ctx.isFinished &&
  inTeamB &&
  pending &&
  pending?.submittedBy?.phoneNorm &&
  pending.submittedBy.phoneNorm !== ctx.phone,
);

msg.statusCode = 200;
msg.headers = { "Content-Type": "application/json; charset=utf-8" };
msg.payload = {
  gameId: ctx.gameId || null,
  phone: ctx.phone || null,
  isFinished: Boolean(ctx.isFinished),
  endTs: Number.isFinite(Number(ctx.endTs)) ? Number(ctx.endTs) : null,
  teams: ctx.teams || { teamA: [], teamB: [], source: 'none' },
  latestResult: latest,
  canSubmit,
  canConfirm,
};

return [msg, msg];
