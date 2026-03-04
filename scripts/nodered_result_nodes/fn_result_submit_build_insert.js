const asArray = (v) => Array.isArray(v) ? v : [];

const rows = asArray(msg.payload);
const ctx = msg._resultSubmit || {};

const latest = rows
  .filter((r) => r && typeof r === 'object')
  .sort((a, b) => Number(b?.submittedAtTs || b?.createdTs || 0) - Number(a?.submittedAtTs || a?.createdTs || 0))[0] || null;

if (latest && String(latest.status || '').toUpperCase() === 'PENDING_CONFIRMATION') {
  msg.statusCode = 409;
  msg.headers = { "Content-Type": "application/json; charset=utf-8" };
  msg.payload = { error: 'Pending result already exists', pendingResult: latest };
  return [null, msg, msg];
}

if (latest && String(latest.status || '').toUpperCase() === 'CONFIRMED') {
  msg.statusCode = 409;
  msg.headers = { "Content-Type": "application/json; charset=utf-8" };
  msg.payload = { error: 'Result already confirmed', result: latest };
  return [null, msg, msg];
}

const now = new Date();
const nowIso = now.toISOString();
const nowTs = now.getTime();

const submitter = (ctx.teams?.teamA || []).find((p) => p.phoneNorm === ctx.phone) || { phoneNorm: ctx.phone, name: 'Игрок' };
const resultId = `res_${ctx.gameId}_${nowTs}`;

const doc = {
  id: resultId,
  gameId: ctx.gameId,
  tenantKey: ctx.game?.tenantKey || null,
  vivaExerciseId: ctx.game?.booking?.vivaExerciseId || null,
  status: 'PENDING_CONFIRMATION',
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
  submittedAt: nowIso,
  submittedAtTs: nowTs,
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
