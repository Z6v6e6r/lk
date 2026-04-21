const asArray = (v) => Array.isArray(v) ? v : [];

const ctx = msg._resultConfirm || {};
const pending = msg._resultPending || null;
if (!pending) {
  msg.statusCode = 409;
  msg.headers = { "Content-Type": "application/json; charset=utf-8" };
  msg.payload = { error: 'No pending result context' };
  return [null, null, null, msg, msg];
}

const now = new Date();
const nowIso = now.toISOString();
const nowTs = now.getTime();

const teamA = asArray(pending?.teams?.teamA);
const teamB = asArray(pending?.teams?.teamB);
const disputers = pending?.submittedByTeam === 'A' ? teamB : teamA;
const disputer = disputers.find((p) => p.phoneNorm === ctx.phone) || { id: null, name: 'Игрок', phoneNorm: ctx.phone };

const resultUpdateMsg = Object.assign({}, msg, {
  query: { id: pending.id, status: { $in: ['PENDING_CONFIRMATION', 'PENDING_DISPUTE'] } },
  payload: {
    $set: {
      status: 'DISPUTED',
      disputedBy: {
        id: disputer.id,
        name: disputer.name,
        phoneNorm: disputer.phoneNorm,
      },
      disputedAt: nowIso,
      disputedAtTs: nowTs,
      confirmedBy: null,
      confirmedAt: null,
      confirmedAtTs: null,
      ratingImpact: null,
      updatedAt: nowIso,
    },
  },
});

const gameUpdateMsg = Object.assign({}, msg, {
  query: { id: ctx.game?.id || pending.gameId },
  payload: {
    $set: {
      resultStatus: 'DISPUTED',
      resultId: pending.id,
      lastResultAt: nowIso,
      updatedAt: nowIso,
    },
  },
});

const responseMsg = Object.assign({}, msg, {
  statusCode: 200,
  headers: { "Content-Type": "application/json; charset=utf-8" },
  payload: {
    gameId: ctx.game?.id || pending.gameId,
    resultId: pending.id,
    status: 'DISPUTED',
    disputedAt: nowIso,
  },
});

const ratingsMsg = Object.assign({}, msg, { payload: [] });

return [resultUpdateMsg, ratingsMsg, gameUpdateMsg, responseMsg, responseMsg];
