const body = msg.payload || {};
const now = new Date().toISOString();

const toText = (value) => {
  if (value === null || value === undefined) return null;
  const normalized = String(value).trim();
  return normalized || null;
};
const toRating = (value) => {
  if (value === null || value === undefined || value === "") return null;
  const parsed = Number(String(value).replace(",", "."));
  return Number.isFinite(parsed) ? parsed : null;
};
const organizer = body.organizer && typeof body.organizer === "object" ? body.organizer : {};
const tournamentId = toText(body.tournamentId);
const startedAt = toText(body.createdAt) || now;
const startRatingChanges = (Array.isArray(body.startRatingChanges) ? body.startRatingChanges : [])
  .map((entry, index) => {
    const player = entry?.player && typeof entry.player === "object" ? entry.player : {};
    const change = entry?.change && typeof entry.change === "object" ? entry.change : {};
    const participantId = toText(player.participantId);
    const clientId = toText(player.clientId);
    const before = toRating(change.before);
    const after = toRating(change.after);
    if ((!participantId && !clientId) || after === null || before === after) return null;
    const reason = entry?.source?.reason === "MINIMUM_ASSIGNED"
      ? "MINIMUM_ASSIGNED"
      : "MANUAL_OVERRIDE";
    return {
      eventId: toText(entry.eventId) || `rating_evt:tournament_start:${tournamentId || "unknown"}:${clientId || participantId}:${index}`,
      eventType: "TOURNAMENT_START_RATING_CHANGED",
      occurredAt: startedAt,
      source: { domain: "TOURNAMENT", tournamentId, reason },
      player: {
        participantId,
        clientId,
        name: toText(player.name) || "Игрок",
        phone: toText(player.phone),
      },
      change: { before, after },
      changedBy: {
        id: toText(organizer.id),
        name: toText(organizer.name) || toText(body?.params?.organizerName),
        phone: toText(organizer.phone),
      },
    };
  })
  .filter(Boolean);

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
    organizer,
    participants: Array.isArray(body.participants) ? body.participants : [],
    ...(Array.isArray(body.startRatingChanges) ? { startRatingChanges } : {}),
    rounds: Array.isArray(body.rounds) ? body.rounds : [],
    params: {
      ...params,
      ...(body.tournamentType === "paired_mexicano"
        ? {
          mexicanoMode: "paired",
          pairAssignments: Array.isArray(body?.params?.pairAssignments)
            ? body.params.pairAssignments
            : [],
          totalRounds: Number.isFinite(Number(body?.params?.totalRounds))
            ? Number(body.params.totalRounds)
            : undefined,
        }
        : {}),
    },
    playerLogs: body.playerLogs || {},
    totals: body.totals || {},
    standings: Array.isArray(body.standings) ? body.standings : [],
    summary: body.summary || null,
  },
  $setOnInsert: { createdAt: body.createdAt || now },
};

return msg;
