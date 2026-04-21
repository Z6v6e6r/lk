const asArray = (v) => Array.isArray(v) ? v : [];
const DISPUTE_WINDOW_MS = 24 * 60 * 60 * 1000;

const rows = asArray(msg.payload);
const ctx = msg._resultSubmit || {};

const latest = rows
  .filter((r) => r && typeof r === 'object')
  .sort((a, b) => Number(b?.submittedAtTs || b?.createdTs || 0) - Number(a?.submittedAtTs || a?.createdTs || 0))[0] || null;

const latestStatus = String(latest?.status || '').toUpperCase();
const latestDeadlineTs = Number(latest?.disputeDeadlineTs || 0);
const latestSubmittedTs = Number(latest?.submittedAtTs || latest?.createdTs || 0);
const latestResolvedDeadlineTs =
  Number.isFinite(latestDeadlineTs) && latestDeadlineTs > 0
    ? latestDeadlineTs
    : Number.isFinite(latestSubmittedTs) && latestSubmittedTs > 0
      ? latestSubmittedTs + DISPUTE_WINDOW_MS
      : null;
const latestPendingActive =
  latest
  && (latestStatus === 'PENDING_CONFIRMATION' || latestStatus === 'PENDING_DISPUTE')
  && (!Number.isFinite(latestResolvedDeadlineTs) || latestResolvedDeadlineTs > Date.now());
const latestPendingExpired =
  latest
  && (latestStatus === 'PENDING_CONFIRMATION' || latestStatus === 'PENDING_DISPUTE')
  && Number.isFinite(latestResolvedDeadlineTs)
  && latestResolvedDeadlineTs <= Date.now();

if (latestPendingActive) {
  msg.statusCode = 409;
  msg.headers = { "Content-Type": "application/json; charset=utf-8" };
  msg.payload = { error: 'Pending result already exists', pendingResult: latest };
  return [null, msg, msg];
}

if (latestPendingExpired || latestStatus === 'CONFIRMED') {
  msg.statusCode = 409;
  msg.headers = { "Content-Type": "application/json; charset=utf-8" };
  msg.payload = {
    error: latestPendingExpired ? 'Result already agreed by timeout' : 'Result already confirmed',
    result: latest,
  };
  return [null, msg, msg];
}

const now = new Date();
const nowIso = now.toISOString();
const nowTs = now.getTime();
const disputeDeadlineTs = nowTs + DISPUTE_WINDOW_MS;
const disputeDeadlineAt = new Date(disputeDeadlineTs).toISOString();

const submitter = (
  (ctx.submitterTeam === 'A' ? ctx.teams?.teamA : ctx.teams?.teamB) || []
).find((p) => p.phoneNorm === ctx.phone) || { phoneNorm: ctx.phone, name: 'Игрок' };
const resultId = `res_${ctx.gameId}_${nowTs}`;

const doc = {
  id: resultId,
  gameId: ctx.gameId,
  tenantKey: ctx.game?.tenantKey || null,
  vivaExerciseId: ctx.game?.booking?.vivaExerciseId || null,
  status: 'PENDING_DISPUTE',
  score: {
    teamA: ctx.scoreA,
    teamB: ctx.scoreB,
  },
  teams: ctx.teams,
  submittedBy: {
    id: submitter.id || null,
    name: submitter.name || 'Игрок',
    phoneNorm: submitter.phoneNorm,
  },
  submittedByTeam: ctx.submitterTeam || null,
  submittedAt: nowIso,
  submittedAtTs: nowTs,
  disputeDeadlineAt,
  disputeDeadlineTs,
  confirmedBy: null,
  confirmedAt: null,
  confirmedAtTs: null,
  ratingImpact: null,
  createdAt: nowIso,
  createdTs: nowTs,
  updatedAt: nowIso,
  deleted: false,
};

msg._resultSubmitDoc = doc;
msg.payload = doc;
return [msg, null, msg];
