const asArray = (v) => Array.isArray(v) ? v : [];
const DISPUTE_WINDOW_MS = 24 * 60 * 60 * 1000;

const rows = asArray(msg.payload);
const ctx = msg._resultState || {};

const latest = rows
  .filter((r) => r && typeof r === 'object')
  .sort((a, b) => Number(b?.submittedAtTs || b?.createdTs || 0) - Number(a?.submittedAtTs || a?.createdTs || 0))[0] || null;

const latestStatus = String(latest?.status || '').toUpperCase();
const latestSubmittedAtTs = Number(latest?.submittedAtTs || latest?.createdTs || 0);
const latestDeadlineTsRaw = Number(latest?.disputeDeadlineTs || 0);
const latestDeadlineTs =
  Number.isFinite(latestDeadlineTsRaw) && latestDeadlineTsRaw > 0
    ? latestDeadlineTsRaw
    : Number.isFinite(latestSubmittedAtTs) && latestSubmittedAtTs > 0
      ? latestSubmittedAtTs + DISPUTE_WINDOW_MS
      : null;
const pending = latest
  && (latestStatus === 'PENDING_CONFIRMATION' || latestStatus === 'PENDING_DISPUTE')
  && (!Number.isFinite(latestDeadlineTs) || latestDeadlineTs > Date.now())
  ? latest
  : null;
const confirmed = latest && (
  latestStatus === 'CONFIRMED'
  || (
    (latestStatus === 'PENDING_CONFIRMATION' || latestStatus === 'PENDING_DISPUTE')
    && Number.isFinite(latestDeadlineTs)
    && latestDeadlineTs <= Date.now()
  )
)
  ? latest
  : null;

const inTeamA = asArray(ctx?.teams?.teamA).some((p) => p.phoneNorm === ctx.phone);
const inTeamB = asArray(ctx?.teams?.teamB).some((p) => p.phoneNorm === ctx.phone);

const canSubmit = Boolean(ctx.isFinished && (inTeamA || inTeamB) && !pending && !confirmed);
const canDispute = Boolean(
  ctx.isFinished &&
  (inTeamA || inTeamB) &&
  pending &&
  pending?.submittedBy?.phoneNorm &&
  pending.submittedBy.phoneNorm !== ctx.phone &&
  (
    (inTeamA && !asArray(ctx?.teams?.teamA).some((p) => p.phoneNorm === pending.submittedBy.phoneNorm))
    || (inTeamB && !asArray(ctx?.teams?.teamB).some((p) => p.phoneNorm === pending.submittedBy.phoneNorm))
  ),
);
const latestResult = confirmed && latestStatus !== 'CONFIRMED'
  ? Object.assign({}, confirmed, {
      status: 'CONFIRMED',
      confirmedAt: confirmed.confirmedAt || confirmed.disputeDeadlineAt || (
        Number.isFinite(latestDeadlineTs) ? new Date(latestDeadlineTs).toISOString() : null
      ),
      confirmedAtTs: confirmed.confirmedAtTs || latestDeadlineTs || null,
      confirmedBy: confirmed.confirmedBy || null,
      autoConfirmed: true,
      confirmedReason: 'DISPUTE_TIMEOUT',
    })
  : latest;

msg.statusCode = 200;
msg.headers = { "Content-Type": "application/json; charset=utf-8" };
msg.payload = {
  gameId: ctx.gameId || null,
  phone: ctx.phone || null,
  isFinished: Boolean(ctx.isFinished),
  endTs: Number.isFinite(Number(ctx.endTs)) ? Number(ctx.endTs) : null,
  teams: ctx.teams || { teamA: [], teamB: [], source: 'none' },
  latestResult,
  canSubmit,
  canConfirm: false,
  canDispute,
  disputeDeadlineAt: pending?.disputeDeadlineAt || (Number.isFinite(latestDeadlineTs) ? new Date(latestDeadlineTs).toISOString() : null),
};

return [msg, msg];
