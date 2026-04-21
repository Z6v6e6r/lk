const body = msg.payload || {};
const now = new Date().toISOString();

const params = body.params || {
  K: 0.3,
  D: 3,
  B: 0.3,
  Influence: 0.5,
  weights: { verif: 0.5, regularity: 0.3, engagement: 0.2 },
  minRating: 1,
  maxRating: 7,
  round: 5,
};

msg.query = { tournamentId: body.tournamentId };

msg.payload = {
  $set: {
    tournamentId: body.tournamentId,
    tenantKey: body.tenantKey || null,
    updatedAt: now,
    tournamentType: body.tournamentType || "americano",
    targetScore: body.targetScore ?? 21,
    courts: Array.isArray(body.courts) ? body.courts : [],
    organizer: body.organizer || {},
    participants: Array.isArray(body.participants) ? body.participants : [],
    rounds: Array.isArray(body.rounds) ? body.rounds : [],
    params,
    playerLogs: body.playerLogs || {},
    totals: body.totals || {},
    standings: Array.isArray(body.standings) ? body.standings : [],
    summary: body.summary || null,
  },
  $setOnInsert: { createdAt: body.createdAt || now },
};

return msg;
