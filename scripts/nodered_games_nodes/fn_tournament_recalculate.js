const roundTo = (value, digits) => Number(Number(value || 0).toFixed(digits));
const clamp = (value, min, max) => Math.max(min, Math.min(max, value));
const toNum = (value, fallback = 0) => {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
};

const tournament = Array.isArray(msg.payload) ? msg.payload[0] : msg.payload;
if (!tournament) {
  msg.statusCode = 404;
  msg.payload = { error: "Tournament not found" };
  delete msg.mongoQuery;
  delete msg.mongoUpdate;
  return msg;
}

const body = msg.req?.body || {};
const results = Array.isArray(body.results) ? body.results : [];
const requestParams = body.params && typeof body.params === "object"
  ? body.params
  : {};
const now = new Date().toISOString();

const params = Object.assign({}, tournament.params || {}, requestParams);
const toLower = (value) => String(value ?? "").trim().toLowerCase();
const isTruthy = (value) => (
  value === true
  || value === 1
  || value === "1"
  || String(value ?? "").trim().toLowerCase() === "true"
);
const isTournamentMarkedFinished = (paramsValue, summaryValue) => {
  const paramsRecord = paramsValue && typeof paramsValue === "object" ? paramsValue : {};
  const summaryRecord = summaryValue && typeof summaryValue === "object" ? summaryValue : {};
  const statuses = [
    paramsRecord.status,
    paramsRecord.state,
    paramsRecord.tournamentStatus,
    summaryRecord.status,
    summaryRecord.state,
    summaryRecord.tournamentStatus,
  ]
    .map((value) => toLower(value))
    .filter(Boolean);
  if (statuses.some((status) => (
    status === "completed"
    || status === "finished"
    || status === "closed"
    || status === "done"
    || status === "завершен"
    || status === "завершён"
  ))) {
    return true;
  }

  const finishMarkers = [
    paramsRecord.finishedAt,
    paramsRecord.completedAt,
    summaryRecord.finishedAt,
    summaryRecord.completedAt,
  ];
  if (finishMarkers.some((value) => value != null && String(value).trim() !== "")) {
    return true;
  }

  const flags = [
    paramsRecord.finished,
    paramsRecord.isFinished,
    paramsRecord.tournamentFinished,
    paramsRecord.manualFinish,
    summaryRecord.finished,
    summaryRecord.isFinished,
    summaryRecord.tournamentFinished,
    summaryRecord.manualFinish,
  ];
  return flags.some((value) => isTruthy(value));
};

const resumeRequested = isTruthy(requestParams.resumeRequested) || isTruthy(requestParams.resumeTournament);
delete params.resumeRequested;
delete params.resumeTournament;

const previousSummary = tournament.summary && typeof tournament.summary === "object"
  ? tournament.summary
  : {};
const previousParams = tournament.params && typeof tournament.params === "object"
  ? tournament.params
  : {};
const tournamentFinished = resumeRequested
  ? false
  : isTournamentMarkedFinished(params, previousSummary);
if (resumeRequested) {
  params.status = "in_progress";
  params.state = "in_progress";
  params.tournamentStatus = "in_progress";
  params.finished = false;
  params.isFinished = false;
  params.tournamentFinished = false;
  params.manualFinish = false;
  params.finishedAt = null;
  params.completedAt = null;
  params.manualFinishedAt = null;
} else if (tournamentFinished) {
  params.status = "completed";
  params.finished = true;
  params.manualFinish = true;
  const finishedAt = String(
    previousParams.finishedAt
    || previousParams.completedAt
    || previousSummary.finishedAt
    || previousSummary.completedAt
    || params.finishedAt
    || params.completedAt
    || now,
  );
  params.finishedAt = finishedAt;
  params.completedAt = String(
    previousParams.completedAt
    || previousSummary.completedAt
    || finishedAt,
  );
}

const K = toNum(params.K, 0.3);
const D = toNum(params.D, 3);
const B = toNum(params.B, 0.3);
const Influence = toNum(params.Influence, 0.5);
const Wv = toNum(params.weights?.verif, 0.5);
const Wr = toNum(params.weights?.regularity, 0.3);
const We = toNum(params.weights?.engagement, 0.2);
const MIN_R = toNum(params.minRating, 1);
const MAX_R = toNum(params.maxRating, 7);
const ROUND = toNum(params.round, 5);
const BYE_POLICY = "round_average_points";
const BYE_POLICY_ZERO = "zero_points";
const BYE_POINTS_MODE = String(params.byePointsMode || "").trim().toLowerCase() === "zero"
  || String(params.byePointsMode || "").trim().toLowerCase() === "zero_points"
  ? "zero_points"
  : "round_average_points";

if (!Array.isArray(tournament.rounds)) tournament.rounds = [];

const toPlayerId = (value, fallback) => {
  if (typeof value === "string" || typeof value === "number") {
    const normalized = String(value).trim();
    return normalized || fallback;
  }
  if (value && typeof value === "object") {
    const id = value.id ?? value.phone ?? fallback;
    return String(id).trim() || fallback;
  }
  return fallback;
};

const normalizeIdArray = (list, prefix) => (
  Array.isArray(list)
    ? list
      .map((item, index) => toPlayerId(item, `${prefix}-${index + 1}`))
      .filter(Boolean)
    : []
);

const roundIndexFromId = (id) => {
  const match = String(id || "").match(/round-(\d+)/i);
  return match ? Number(match[1]) : tournament.rounds.length + 1;
};

const ensureRound = (roundId) => {
  let round = tournament.rounds.find((item) => item && item.id === roundId);
  if (!round) {
    round = { id: roundId, index: roundIndexFromId(roundId), matches: [], byes: [] };
    tournament.rounds.push(round);
  }
  if (!Array.isArray(round.matches)) round.matches = [];
  if (!Array.isArray(round.byes)) round.byes = [];
  return round;
};

const ensureMatch = (round, matchId) => {
  let match = round.matches.find((item) => item && item.id === matchId);
  if (!match) {
    match = {
      id: matchId,
      court: null,
      courtIndex: null,
      pair1: [],
      pair2: [],
      score1: null,
      score2: null,
    };
    round.matches.push(match);
  }
  return match;
};

const findRound = (roundId) => (
  Array.isArray(tournament.rounds)
    ? tournament.rounds.find((item) => item && item.id === roundId)
    : null
);

const findMatch = (round, matchId) => (
  round && Array.isArray(round.matches)
    ? round.matches.find((item) => item && item.id === matchId)
    : null
);

const players = {};
const participantIds = [];

(tournament.participants || []).forEach((participant, index) => {
  const id = toPlayerId(participant, `p-${index + 1}`);
  participantIds.push(id);
  players[id] = {
    id,
    name: participant?.name || `Участник ${index + 1}`,
    rating: toNum(participant?.rating, MIN_R),
    baseRating: toNum(participant?.rating, MIN_R),
    verif: toNum(participant?.verif, 0.1),
    regularity: toNum(participant?.regularity, 1),
    engagement: toNum(participant?.engagement, 1),
    pressure: toNum(participant?.pressure, 1),
    tournamentMultiplier: toNum(participant?.tournamentMultiplier, 1),
    delta: 0,
    stats: {
      wins: 0,
      losses: 0,
      draws: 0,
      games: 0,
      pointsFor: 0,
      pointsAgainst: 0,
      playedPoints: 0,
      byeCount: 0,
      byePoints: 0,
    },
  };
});

const participantIdSet = new Set(participantIds);

const validateRoundLayouts = (layoutByMatchId) => {
  const usedInRound = new Set();
  for (const layout of layoutByMatchId.values()) {
    const pair1 = normalizeIdArray(layout?.pair1, "layout-pair1");
    const pair2 = normalizeIdArray(layout?.pair2, "layout-pair2");
    if (pair1.length === 0 && pair2.length === 0) continue;
    if (pair1.length !== 2 || pair2.length !== 2) return false;

    const ids = [...pair1, ...pair2];
    if (new Set(ids).size !== 4) return false;
    if (!ids.every((id) => participantIdSet.has(id))) return false;
    if (ids.some((id) => usedInRound.has(id))) return false;
    ids.forEach((id) => usedInRound.add(id));
  }
  return true;
};

const hasValidMatchLayout = (match) => {
  const pair1 = normalizeIdArray(match?.pair1, "match-pair1");
  const pair2 = normalizeIdArray(match?.pair2, "match-pair2");
  const ids = [...pair1, ...pair2];
  return (
    pair1.length === 2
    && pair2.length === 2
    && new Set(ids).size === 4
    && ids.every((id) => participantIdSet.has(id))
  );
};

const isClassicMexicanoResultGuarded = () => {
  const tournamentType = String(tournament.tournamentType || params.tournamentType || "").toLowerCase();
  if (!tournamentType.includes("mexicano")) return false;
  if (
    tournamentType === "paired_mexicano"
    || tournamentType === "mexicano_pairs"
    || String(params.mexicanoMode || "").toLowerCase() === "paired"
  ) {
    return false;
  }
  return true;
};

let incomingResultError = null;
const markIncomingResultError = (code, message) => {
  if (incomingResultError) return;
  incomingResultError = { code, message };
};

const applyIncomingResults = () => {
  const updatesByRoundId = new Map();
  const guardClassicMexicano = isClassicMexicanoResultGuarded();

  results.forEach((result, resultIndex) => {
    if (!result?.roundId || !result?.matchId) return;
    const round = findRound(result.roundId);
    const match = findMatch(round, result.matchId);
    const update = {
      roundId: result.roundId,
      matchId: result.matchId,
      round,
      match,
      index: resultIndex,
      layout: null,
    };

    const hasIncomingPair1 = Array.isArray(result.pair1) && result.pair1.length > 0;
    const hasIncomingPair2 = Array.isArray(result.pair2) && result.pair2.length > 0;
    if (hasIncomingPair1 || hasIncomingPair2) {
      update.layout = {
        pair1: normalizeIdArray(result.pair1, `${update.roundId || "round"}-${update.matchId || "match"}-pair1`),
        pair2: normalizeIdArray(result.pair2, `${update.roundId || "round"}-${update.matchId || "match"}-pair2`),
        court: result.court,
        courtIndex: result.courtIndex,
      };
    }

    if (!updatesByRoundId.has(update.roundId)) updatesByRoundId.set(update.roundId, []);
    updatesByRoundId.get(update.roundId).push(update);
  });

  updatesByRoundId.forEach((updates, roundId) => {
    if (incomingResultError) return;
    const existingRound = findRound(roundId);
    const hasLayoutUpdates = updates.some((update) => update.layout);
    if (!existingRound && !hasLayoutUpdates) {
      if (guardClassicMexicano) {
        markIncomingResultError(
          "ROUND_LAYOUT_REQUIRED",
          "Classic mexicano result requires a persisted round layout before score-only updates",
        );
        return;
      }

      updates.forEach((update) => {
        const result = results[update.index];
        const round = ensureRound(update.roundId);
        const match = ensureMatch(round, update.matchId);
        if (result?.score1 !== undefined) match.score1 = result.score1;
        if (result?.score2 !== undefined) match.score2 = result.score2;
        if (result?.court) match.court = result.court;
        if (result?.courtIndex !== undefined) match.courtIndex = result.courtIndex;
      });
      return;
    }

    const candidateLayouts = new Map();
    (Array.isArray(existingRound?.matches) ? existingRound.matches : []).forEach((match, matchIndex) => {
      candidateLayouts.set(match.id, {
        pair1: normalizeIdArray(match?.pair1, `${roundId}-current-pair1-${matchIndex + 1}`),
        pair2: normalizeIdArray(match?.pair2, `${roundId}-current-pair2-${matchIndex + 1}`),
        court: match?.court,
        courtIndex: match?.courtIndex,
      });
    });

    const layoutUpdates = updates
      .filter((update) => update.layout)
      .sort((left, right) => left.index - right.index);

    if (layoutUpdates.length === 0) {
      updates.forEach((update) => {
        if (guardClassicMexicano && (!update.match || !hasValidMatchLayout(update.match))) {
          markIncomingResultError(
            "ROUND_LAYOUT_REQUIRED",
            "Classic mexicano score-only update requires an existing valid match layout",
          );
          return;
        }
        const match = update.match ?? ensureMatch(ensureRound(update.roundId), update.matchId);
        if (!match) return;
        const result = results[update.index];
        if (result?.score1 !== undefined) match.score1 = result.score1;
        if (result?.score2 !== undefined) match.score2 = result.score2;
        if (result?.court) match.court = result.court;
        if (result?.courtIndex !== undefined) match.courtIndex = result.courtIndex;
      });
      return;
    }

    layoutUpdates.forEach((update) => {
      const current = candidateLayouts.get(update.matchId) || {
        pair1: [],
        pair2: [],
        court: update.match?.court,
        courtIndex: update.match?.courtIndex,
      };
      candidateLayouts.set(update.matchId, {
        pair1: update.layout.pair1,
        pair2: update.layout.pair2,
        court: update.layout.court !== undefined ? update.layout.court : current.court,
        courtIndex: update.layout.courtIndex !== undefined ? update.layout.courtIndex : current.courtIndex,
      });
    });

    if (!validateRoundLayouts(candidateLayouts)) {
      if (guardClassicMexicano) {
        markIncomingResultError(
          "INVALID_ROUND_LAYOUT",
          "Classic mexicano round layout is invalid",
        );
      }
      return;
    }

    layoutUpdates.forEach((update) => {
      const round = ensureRound(update.roundId);
      const match = ensureMatch(round, update.matchId);
      update.round = round;
      update.match = match;

      const nextLayout = candidateLayouts.get(update.matchId);
      if (!nextLayout) return;
      match.pair1 = nextLayout.pair1;
      match.pair2 = nextLayout.pair2;
      if (nextLayout.court) match.court = nextLayout.court;
      if (nextLayout.courtIndex !== undefined) match.courtIndex = nextLayout.courtIndex;
    });

    updates.forEach((update) => {
      const result = results[update.index];
      const match = findMatch(findRound(update.roundId), update.matchId);
      if (!match || !hasValidMatchLayout(match)) return;
      if (result?.score1 !== undefined) match.score1 = result.score1;
      if (result?.score2 !== undefined) match.score2 = result.score2;
      if (result?.court && !layoutUpdates.some((layoutUpdate) => layoutUpdate.matchId === update.matchId)) {
        match.court = result.court;
      }
      if (
        result?.courtIndex !== undefined
        && !layoutUpdates.some((layoutUpdate) => layoutUpdate.matchId === update.matchId)
      ) {
        match.courtIndex = result.courtIndex;
      }
    });
  });
};

applyIncomingResults();
if (incomingResultError) {
  msg.statusCode = 422;
  msg.payload = { error: incomingResultError.code, message: incomingResultError.message };
  delete msg.mongoQuery;
  delete msg.mongoUpdate;
  return msg;
}

const pairRating = (left, right) => {
  const sum = left.rating + right.rating;
  if (sum <= 0) return MIN_R;
  return (left.rating * left.rating + right.rating * right.rating) / sum;
};

const calcDelta = (player, opponentPairRating, actual, opponentVerif) => {
  const expected = 1 / (1 + Math.pow(10, (opponentPairRating - player.rating) / D));
  const base = K * (actual - expected);
  const confidence = Wv * player.verif + Wr * player.regularity + We * player.engagement;
  const selfApplied = (1 - Influence) + Influence * confidence;
  const opponentApplied = (1 - Influence) + Influence * opponentVerif;
  const delta = base * selfApplied * opponentApplied * player.pressure * player.tournamentMultiplier;
  return { delta: roundTo(delta, ROUND), expected };
};

const playerLogs = {};
const addLog = (playerId, log) => {
  if (!playerLogs[playerId]) playerLogs[playerId] = [];
  playerLogs[playerId].push(log);
};

const inferRoundByes = (round) => {
  const activeIds = new Set();
  (Array.isArray(round?.matches) ? round.matches : []).forEach((match, matchIndex) => {
    normalizeIdArray(match?.pair1, `pair1-${matchIndex + 1}`).forEach((id) => activeIds.add(id));
    normalizeIdArray(match?.pair2, `pair2-${matchIndex + 1}`).forEach((id) => activeIds.add(id));
  });

  return participantIds.filter((id) => !activeIds.has(id));
};

let totalMatches = 0;
let completedMatches = 0;
let completedRounds = 0;

tournament.rounds
  .sort((left, right) => toNum(left?.index, 0) - toNum(right?.index, 0))
  .forEach((round, roundIndex) => {
    if (!Array.isArray(round.matches)) round.matches = [];

    const byeIds = inferRoundByes(round);
    round.byes = byeIds;

    let roundPlayedPoints = 0;
    let roundActivePlayers = 0;
    let roundCompleted = round.matches.length > 0;

    round.matches.forEach((match, matchIndex) => {
      const pair1Ids = normalizeIdArray(match?.pair1, `${round.id || roundIndex + 1}-pair1-${matchIndex + 1}`);
      const pair2Ids = normalizeIdArray(match?.pair2, `${round.id || roundIndex + 1}-pair2-${matchIndex + 1}`);

      match.pair1 = pair1Ids;
      match.pair2 = pair2Ids;

      totalMatches += 1;

      if (pair1Ids.length < 2 || pair2Ids.length < 2) {
        roundCompleted = false;
        return;
      }

      roundActivePlayers += pair1Ids.length + pair2Ids.length;

      if (match.score1 == null || match.score2 == null) {
        roundCompleted = false;
        return;
      }

      const p1a = players[pair1Ids[0]];
      const p1b = players[pair1Ids[1]];
      const p2a = players[pair2Ids[0]];
      const p2b = players[pair2Ids[1]];
      if (!p1a || !p1b || !p2a || !p2b) {
        roundCompleted = false;
        return;
      }

      completedMatches += 1;

      const score1 = toNum(match.score1, 0);
      const score2 = toNum(match.score2, 0);
      const actual1 = 1 / (1 + Math.exp(-B * (score1 - score2)));
      const actual2 = 1 / (1 + Math.exp(-B * (score2 - score1)));

      const opponentVerif1 = (p2a.verif + p2b.verif) / 2;
      const opponentVerif2 = (p1a.verif + p1b.verif) / 2;
      const pair1Rating = pairRating(p1a, p1b);
      const pair2Rating = pairRating(p2a, p2b);

      const leftA = calcDelta(p1a, pair2Rating, actual1, opponentVerif1);
      const leftB = calcDelta(p1b, pair2Rating, actual1, opponentVerif1);
      const rightA = calcDelta(p2a, pair1Rating, actual2, opponentVerif2);
      const rightB = calcDelta(p2b, pair1Rating, actual2, opponentVerif2);

      const leftResult = score1 > score2 ? "win" : score1 < score2 ? "loss" : "draw";
      const rightResult = score2 > score1 ? "win" : score2 < score1 ? "loss" : "draw";

      const applyRating = (player, delta) => {
        const before = player.rating;
        player.delta += delta;
        player.rating = roundTo(clamp(player.rating + delta, MIN_R, MAX_R), ROUND);
        return { before, after: player.rating };
      };

      [p1a, p1b].forEach((player) => {
        player.stats.games += 1;
        player.stats.pointsFor += score1;
        player.stats.pointsAgainst += score2;
        player.stats.playedPoints += score1;
        if (leftResult === "win") player.stats.wins += 1;
        else if (leftResult === "loss") player.stats.losses += 1;
        else player.stats.draws += 1;
      });

      [p2a, p2b].forEach((player) => {
        player.stats.games += 1;
        player.stats.pointsFor += score2;
        player.stats.pointsAgainst += score1;
        player.stats.playedPoints += score2;
        if (rightResult === "win") player.stats.wins += 1;
        else if (rightResult === "loss") player.stats.losses += 1;
        else player.stats.draws += 1;
      });

      roundPlayedPoints += score1 * pair1Ids.length;
      roundPlayedPoints += score2 * pair2Ids.length;

      const applied11 = applyRating(p1a, leftA.delta);
      const applied12 = applyRating(p1b, leftB.delta);
      const applied21 = applyRating(p2a, rightA.delta);
      const applied22 = applyRating(p2b, rightB.delta);

      if (!match.results || typeof match.results !== "object") match.results = {};
      match.results[p1a.id] = {
        actual: actual1,
        ratingBefore: applied11.before,
        ratingAfter: applied11.after,
        delta: leftA.delta,
      };
      match.results[p1b.id] = {
        actual: actual1,
        ratingBefore: applied12.before,
        ratingAfter: applied12.after,
        delta: leftB.delta,
      };
      match.results[p2a.id] = {
        actual: actual2,
        ratingBefore: applied21.before,
        ratingAfter: applied21.after,
        delta: rightA.delta,
      };
      match.results[p2b.id] = {
        actual: actual2,
        ratingBefore: applied22.before,
        ratingAfter: applied22.after,
        delta: rightB.delta,
      };

      addLog(p1a.id, {
        roundId: round.id,
        matchId: match.id,
        scoreFor: score1,
        scoreAgainst: score2,
        delta: leftA.delta,
        ratingBefore: applied11.before,
        ratingAfter: applied11.after,
        expected: leftA.expected,
        actual: actual1,
      });
      addLog(p1b.id, {
        roundId: round.id,
        matchId: match.id,
        scoreFor: score1,
        scoreAgainst: score2,
        delta: leftB.delta,
        ratingBefore: applied12.before,
        ratingAfter: applied12.after,
        expected: leftB.expected,
        actual: actual1,
      });
      addLog(p2a.id, {
        roundId: round.id,
        matchId: match.id,
        scoreFor: score2,
        scoreAgainst: score1,
        delta: rightA.delta,
        ratingBefore: applied21.before,
        ratingAfter: applied21.after,
        expected: rightA.expected,
        actual: actual2,
      });
      addLog(p2b.id, {
        roundId: round.id,
        matchId: match.id,
        scoreFor: score2,
        scoreAgainst: score1,
        delta: rightB.delta,
        ratingBefore: applied22.before,
        ratingAfter: applied22.after,
        expected: rightB.expected,
        actual: actual2,
      });
    });

    if (roundCompleted) completedRounds += 1;

    const byePoints = roundCompleted && byeIds.length > 0
      ? (
          BYE_POINTS_MODE === "zero_points"
            ? 0
            : (roundActivePlayers > 0 ? roundTo(roundPlayedPoints / roundActivePlayers, 2) : null)
        )
      : null;

    round.summary = Object.assign({}, round.summary || {}, {
      byePolicy: BYE_POINTS_MODE === "zero_points" ? BYE_POLICY_ZERO : BYE_POLICY,
      byePoints,
      completed: roundCompleted,
    });

    byeIds.forEach((playerId) => {
      const player = players[playerId];
      if (!player) return;
      player.stats.byeCount += 1;
      if (byePoints != null) {
        player.stats.byePoints += byePoints;
      }
    });
  });

const getPairKey = (pairIds) => normalizeIdArray(pairIds, "pair").sort().join("::");
const makePairVsPairKey = (pair1, pair2) => [getPairKey(pair1), getPairKey(pair2)].sort().join("||");
const getTournamentType = () => String(tournament.tournamentType || params.tournamentType || "").toLowerCase();
const isPairedMexicanoTournament = () => {
  const tournamentType = getTournamentType();
  return (
    tournamentType === "paired_mexicano"
    || tournamentType === "mexicano_pairs"
    || (tournamentType.includes("mexicano") && String(params.mexicanoMode || "").toLowerCase() === "paired")
  );
};
const isClassicMexicanoTournament = () => {
  const tournamentType = getTournamentType();
  if (!tournamentType.includes("mexicano")) return false;
  if (isPairedMexicanoTournament()) return false;
  return String(params.mexicanoMode || "classic").toLowerCase() !== "paired";
};

const maybeAppendPairedMexicanoRound = () => {
  if (tournamentFinished) return;
  if (!isPairedMexicanoTournament()) return;

  const totalRounds = Math.max(1, Math.floor(toNum(params.totalRounds, 0)));
  if (!totalRounds || tournament.rounds.length >= totalRounds) return;

  const sortedRounds = tournament.rounds
    .filter((round) => round && Array.isArray(round.matches))
    .sort((left, right) => toNum(left?.index, 0) - toNum(right?.index, 0));
  const lastRound = sortedRounds[sortedRounds.length - 1];
  if (!lastRound || !Array.isArray(lastRound.matches) || lastRound.matches.length === 0) return;
  if (Array.isArray(lastRound.byes) && lastRound.byes.length > 0) return;

  const completedMatches = [...lastRound.matches]
    .sort((left, right) => toNum(left?.courtIndex, 0) - toNum(right?.courtIndex, 0));
  const isRoundComplete = completedMatches.every((match) => (
    normalizeIdArray(match?.pair1, "pair1").length === 2
    && normalizeIdArray(match?.pair2, "pair2").length === 2
    && match.score1 != null
    && match.score2 != null
  ));
  if (!isRoundComplete) return;

  const courtCount = completedMatches.length;
  const nextCourtPairs = Array.from({ length: courtCount }, () => []);

  completedMatches.forEach((match, index) => {
    const pair1 = normalizeIdArray(match.pair1, `round-${lastRound.index}-pair1-${index + 1}`);
    const pair2 = normalizeIdArray(match.pair2, `round-${lastRound.index}-pair2-${index + 1}`);
    const score1 = toNum(match.score1, 0);
    const score2 = toNum(match.score2, 0);
    const winner = score1 >= score2 ? pair1 : pair2;
    const loser = score1 >= score2 ? pair2 : pair1;
    const winnerCourt = Math.max(0, index - 1);
    const loserCourt = Math.min(courtCount - 1, index + 1);
    nextCourtPairs[winnerCourt].push(winner);
    nextCourtPairs[loserCourt].push(loser);
  });

  if (nextCourtPairs.some((courtPairs) => courtPairs.length !== 2)) return;

  const previousSignature = completedMatches
    .map((match) => [getPairKey(match.pair1), getPairKey(match.pair2)].sort().join("|"))
    .join(";");
  const nextSignature = nextCourtPairs
    .map((courtPairs) => courtPairs.map((pair) => getPairKey(pair)).sort().join("|"))
    .join(";");

  const nextRoundIndex = toNum(lastRound.index, sortedRounds.length) + 1;
  const nextRound = {
    id: `round-${nextRoundIndex}`,
    index: nextRoundIndex,
    collapsed: false,
    saved: false,
    byes: [],
    summary: {
      mexicanoMode: "paired",
      movementFromRoundId: lastRound.id,
      repeatedLayout: previousSignature === nextSignature,
    },
    matches: nextCourtPairs.map((courtPairs, index) => ({
      id: `round-${nextRoundIndex}-match-${index + 1}`,
      court: completedMatches[index]?.court || tournament.courts?.[index] || `Корт №${index + 1}`,
      courtIndex: toNum(completedMatches[index]?.courtIndex, index),
      pair1: courtPairs[0],
      pair2: courtPairs[1],
      score1: null,
      score2: null,
    })),
  };

  tournament.rounds.push(nextRound);
};

const maybeAppendClassicMexicanoRound = () => {
  if (tournamentFinished) return;
  if (!isClassicMexicanoTournament()) return;

  const sortedRounds = tournament.rounds
    .filter((round) => round && Array.isArray(round.matches))
    .sort((left, right) => toNum(left?.index, 0) - toNum(right?.index, 0));
  const lastRound = sortedRounds[sortedRounds.length - 1];
  if (!lastRound || !Array.isArray(lastRound.matches) || lastRound.matches.length === 0) return;

  const isRoundComplete = lastRound.matches.every((match) => (
    normalizeIdArray(match?.pair1, "pair1").length === 2
    && normalizeIdArray(match?.pair2, "pair2").length === 2
    && match.score1 != null
    && match.score2 != null
  ));
  if (!isRoundComplete) return;

  const partnerCounts = {};
  const opponentCounts = {};
  const pairVsPairCounts = {};
  const headToHeadMap = {};
  const makeHeadToHeadKey = (leftId, rightId) => [leftId, rightId].sort().join("::");
  const updateHeadToHead = (leftId, rightId, leftScore, rightScore) => {
    const entryLeftId = leftId < rightId ? leftId : rightId;
    const entryRightId = leftId < rightId ? rightId : leftId;
    const key = makeHeadToHeadKey(entryLeftId, entryRightId);
    const entry = headToHeadMap[key] || {
      leftId: entryLeftId,
      rightId: entryRightId,
      matchesPlayed: 0,
      leftWins: 0,
      rightWins: 0,
      leftPointsFor: 0,
      rightPointsFor: 0,
    };
    const normalizedLeftScore = leftId === entry.leftId ? leftScore : rightScore;
    const normalizedRightScore = leftId === entry.leftId ? rightScore : leftScore;
    entry.matchesPlayed += 1;
    entry.leftPointsFor += normalizedLeftScore;
    entry.rightPointsFor += normalizedRightScore;
    if (normalizedLeftScore > normalizedRightScore) {
      entry.leftWins += 1;
    } else if (normalizedRightScore > normalizedLeftScore) {
      entry.rightWins += 1;
    }
    headToHeadMap[key] = entry;
  };
  sortedRounds.forEach((round) => {
    (Array.isArray(round.matches) ? round.matches : []).forEach((match, matchIndex) => {
      const pair1 = normalizeIdArray(match?.pair1, `pair1-${matchIndex + 1}`);
      const pair2 = normalizeIdArray(match?.pair2, `pair2-${matchIndex + 1}`);
      if (pair1.length !== 2 || pair2.length !== 2) return;

      const pair1Key = getPairKey(pair1);
      const pair2Key = getPairKey(pair2);
      partnerCounts[pair1Key] = (partnerCounts[pair1Key] || 0) + 1;
      partnerCounts[pair2Key] = (partnerCounts[pair2Key] || 0) + 1;
      const pairVsPairKey = makePairVsPairKey(pair1, pair2);
      pairVsPairCounts[pairVsPairKey] = (pairVsPairCounts[pairVsPairKey] || 0) + 1;

      pair1.forEach((leftId) => {
        pair2.forEach((rightId) => {
          const key = getPairKey([leftId, rightId]);
          opponentCounts[key] = (opponentCounts[key] || 0) + 1;
          if (match.score1 != null && match.score2 != null) {
            updateHeadToHead(leftId, rightId, toNum(match.score1, 0), toNum(match.score2, 0));
          }
        });
      });
    });
  });

  const isPlayerActiveInRound = (round, playerId) => {
    return (Array.isArray(round.matches) ? round.matches : []).some((match, matchIndex) => {
      const pair1 = normalizeIdArray(match?.pair1, `${matchIndex}-pair1`);
      const pair2 = normalizeIdArray(match?.pair2, `${matchIndex}-pair2`);
      return pair1.includes(playerId) || pair2.includes(playerId);
    });
  };

  const getByeStreak = (playerId) => {
    let streak = 0;
    for (let index = sortedRounds.length - 1; index >= 0; index -= 1) {
      const round = sortedRounds[index];
      if (isPlayerActiveInRound(round, playerId)) break;
      const byeIds = normalizeIdArray(round?.byes, `round-${index + 1}-bye`);
      if (!byeIds.includes(playerId)) break;
      streak += 1;
    }
    return streak;
  };
  const playerSeedById = new Map(participantIds.map((id, index) => [id, index]));
  const compareByHeadToHead = (leftId, rightId) => {
    const entry = headToHeadMap[makeHeadToHeadKey(leftId, rightId)];
    if (!entry || entry.matchesPlayed <= 0) return 0;
    const leftWins = leftId === entry.leftId ? entry.leftWins : entry.rightWins;
    const rightWins = leftId === entry.leftId ? entry.rightWins : entry.leftWins;
    if (leftWins !== rightWins) return rightWins - leftWins;
    const leftPointsFor = leftId === entry.leftId ? entry.leftPointsFor : entry.rightPointsFor;
    const rightPointsFor = leftId === entry.leftId ? entry.rightPointsFor : entry.leftPointsFor;
    if (leftPointsFor !== rightPointsFor) return rightPointsFor - leftPointsFor;
    return 0;
  };

  const ranked = participantIds
    .map((id) => {
      const player = players[id];
      if (!player) return null;
      const playedPoints = roundTo(player.stats.playedPoints, 2);
      const byePoints = BYE_POINTS_MODE === "zero_points"
        ? 0
        : roundTo(player.stats.byePoints, 2);
      return {
        id,
        name: player.name,
        totalPoints: roundTo(playedPoints + byePoints, 2),
        pointDiff: roundTo(player.stats.pointsFor - player.stats.pointsAgainst, 2),
        wins: player.stats.wins,
        currentRating: toNum(player.rating, 0),
        seed: playerSeedById.get(id) ?? Number.MAX_SAFE_INTEGER,
        matchesPlayed: player.stats.games,
        byesTotal: player.stats.byeCount,
        byesStreak: getByeStreak(id),
      };
    })
    .filter(Boolean)
    .sort((left, right) => {
      if (right.pointDiff !== left.pointDiff) return right.pointDiff - left.pointDiff;
      if (right.totalPoints !== left.totalPoints) return right.totalPoints - left.totalPoints;
      if (right.wins !== left.wins) return right.wins - left.wins;
      const headToHeadCompare = compareByHeadToHead(left.id, right.id);
      if (headToHeadCompare !== 0) return headToHeadCompare;
      if (right.currentRating !== left.currentRating) return right.currentRating - left.currentRating;
      if (left.seed !== right.seed) return left.seed - right.seed;
      return String(left.id).localeCompare(String(right.id), "ru");
    });

  const matchesPerRound = Math.min(
    Array.isArray(tournament.courts) ? tournament.courts.length : 0,
    Math.floor(ranked.length / 4),
  );
  if (matchesPerRound < 1) return;

  const activePlayersCount = matchesPerRound * 4;
  const byeCount = Math.max(0, ranked.length - activePlayersCount);
  const byeMode = String(params.byeMode || "rotating_bye").toLowerCase();
  if (byeMode === "strict" && byeCount > 0) return;

  const byePool = [...ranked].sort((left, right) => {
    if (left.byesTotal !== right.byesTotal) return left.byesTotal - right.byesTotal;
    const leftConsecutive = left.byesStreak > 0 ? 1 : 0;
    const rightConsecutive = right.byesStreak > 0 ? 1 : 0;
    if (leftConsecutive !== rightConsecutive) return leftConsecutive - rightConsecutive;
    if (right.matchesPlayed !== left.matchesPlayed) return right.matchesPlayed - left.matchesPlayed;
    if (left.totalPoints !== right.totalPoints) return left.totalPoints - right.totalPoints;
    return String(left.id).localeCompare(String(right.id), "ru");
  });
  const byeWithoutConsecutive = byePool.filter((player) => player.byesStreak === 0);
  const byes = byeWithoutConsecutive.length >= byeCount
    ? byeWithoutConsecutive.slice(0, byeCount)
    : [...byeWithoutConsecutive, ...byePool.filter((player) => player.byesStreak > 0)].slice(0, byeCount);
  const byeIdSet = new Set(byes.map((player) => player.id));
  const activePlayers = ranked.filter((player) => !byeIdSet.has(player.id)).slice(0, activePlayersCount);

  const weights = {
    repeatedPartner: 100,
    repeatedPairVsPair: 80,
    repeatedOpponent: 30,
    groupSpread: 50,
  };
  const evaluateCandidate = (group, leftPair, rightPair, schemeLabel) => {
    const partnerRepeatCount =
      (partnerCounts[getPairKey(leftPair)] || 0)
      + (partnerCounts[getPairKey(rightPair)] || 0);
    const pairVsPairRepeatCount = pairVsPairCounts[makePairVsPairKey(leftPair, rightPair)] || 0;
    const opponentRepeatCount =
      (opponentCounts[getPairKey([leftPair[0], rightPair[0]])] || 0)
      + (opponentCounts[getPairKey([leftPair[0], rightPair[1]])] || 0)
      + (opponentCounts[getPairKey([leftPair[1], rightPair[0]])] || 0)
      + (opponentCounts[getPairKey([leftPair[1], rightPair[1]])] || 0);
    const spread = Math.max(...group.map((player) => player.totalPoints))
      - Math.min(...group.map((player) => player.totalPoints));
    const penalty =
      partnerRepeatCount * weights.repeatedPartner
      + pairVsPairRepeatCount * weights.repeatedPairVsPair
      + opponentRepeatCount * weights.repeatedOpponent
      + spread * weights.groupSpread;
    const leftPairRating = (players[leftPair[0]]?.rating || 0) + (players[leftPair[1]]?.rating || 0);
    const rightPairRating = (players[rightPair[0]]?.rating || 0) + (players[rightPair[1]]?.rating || 0);
    return {
      pair1: leftPair,
      pair2: rightPair,
      schemeLabel,
      penalty,
      partnerRepeatCount,
      opponentRepeatCount,
      pairVsPairRepeatCount,
      spread,
      ratingGap: Math.abs(leftPairRating - rightPairRating),
      replacementReasons: [],
    };
  };
  const pickBestPairing = (group) => {
    const playersByIndex = group.map((player) => player.id);
    return evaluateCandidate(
      group,
      [playersByIndex[0], playersByIndex[2]],
      [playersByIndex[1], playersByIndex[3]],
      "1+3 vs 2+4",
    );
  };

  const groups = [];
  for (let index = 0; index < activePlayers.length; index += 4) {
    const group = activePlayers.slice(index, index + 4);
    if (group.length === 4) groups.push(group);
  }
  if (groups.length < 1) return;

  const nextRoundIndex = toNum(lastRound.index, sortedRounds.length) + 1;
  const matches = groups.map((group, groupIndex) => {
    const pairing = pickBestPairing(group);
    return {
      id: `round-${nextRoundIndex}-match-${groupIndex + 1}`,
      court: tournament.courts?.[groupIndex] || `Корт №${groupIndex + 1}`,
      courtIndex: groupIndex,
      pair1: pairing.pair1,
      pair2: pairing.pair2,
      score1: null,
      score2: null,
      quality: {
        score: Math.max(20, 100 - roundTo(pairing.penalty / 10, 1)),
        label: "Мексикано",
        explanation: [
          `схема: ${pairing.schemeLabel}`,
          ...pairing.replacementReasons,
          `позиции ${group[0].id},${group[1].id},${group[2].id},${group[3].id}`,
        ].join(" · "),
        partnerRepeatCount: pairing.partnerRepeatCount,
        opponentRepeatCount: pairing.opponentRepeatCount,
        balanceGap: roundTo(pairing.spread, 2),
        courtRepeatPressure: 0,
      },
      summary: {
        pairPower1: 0,
        pairPower2: 0,
        balanceGap: roundTo(pairing.spread, 2),
        partnerRepeatCount: pairing.partnerRepeatCount,
        opponentRepeatCount: pairing.opponentRepeatCount,
      },
    };
  });

  const nextRound = {
    id: `round-${nextRoundIndex}`,
    index: nextRoundIndex,
    collapsed: false,
    saved: false,
    byes: byes.map((player) => player.id),
    summary: {
      mexicanoMode: "classic",
      byeMode: byeMode === "strict" ? "strict" : "rotating_bye",
      byePointsMode: BYE_POINTS_MODE,
      generatedFromRoundId: lastRound.id,
    },
    matches,
  };

  tournament.rounds.push(nextRound);
};

maybeAppendPairedMexicanoRound();
// IMPORTANT:
// Classic mexicano next-round generation is frontend-owned (deterministic TS engine).
// Server-side auto-generation here caused FE/BE pair divergence after reopen.
// Keep paired mexicano generation on backend, but do not auto-append classic rounds.

const standings = Object.values(players)
  .map((player) => {
    const playedPoints = roundTo(player.stats.playedPoints, 2);
    const byePoints = roundTo(player.stats.byePoints, 2);
    const pointDiff = roundTo(player.stats.pointsFor - player.stats.pointsAgainst, 2);
    const tournamentPoints = roundTo(playedPoints + byePoints, 2);

    return {
      id: player.id,
      name: player.name,
      matchesPlayed: player.stats.games,
      wins: player.stats.wins,
      losses: player.stats.losses,
      draws: player.stats.draws,
      byeCount: player.stats.byeCount,
      byePoints,
      playedPoints,
      totalPoints: tournamentPoints,
      tournamentPoints,
      pointsFor: player.stats.pointsFor,
      pointsAgainst: player.stats.pointsAgainst,
      pointDiff,
      ratingBefore: roundTo(player.baseRating, ROUND),
      ratingAfter: roundTo(player.rating, ROUND),
      ratingDelta: roundTo(player.delta, ROUND),
      deltaTotal: roundTo(player.delta, ROUND),
    };
  })
  .sort((left, right) => {
    if (right.pointDiff !== left.pointDiff) return right.pointDiff - left.pointDiff;
    if (right.totalPoints !== left.totalPoints) return right.totalPoints - left.totalPoints;
    if (right.wins !== left.wins) return right.wins - left.wins;
    if (right.pointsFor !== left.pointsFor) return right.pointsFor - left.pointsFor;
    if (right.deltaTotal !== left.deltaTotal) return right.deltaTotal - left.deltaTotal;
    return String(left.name || "").localeCompare(String(right.name || ""), "ru");
  })
  .map((row, index) => Object.assign({}, row, { rank: index + 1 }));

const totals = {};
standings.forEach((row) => {
  totals[row.id] = {
    ratingBefore: row.ratingBefore,
    ratingAfter: row.ratingAfter,
    deltaTotal: row.deltaTotal,
    wins: row.wins,
    losses: row.losses,
    draws: row.draws,
    pointsFor: row.pointsFor,
    pointsAgainst: row.pointsAgainst,
    byeCount: row.byeCount,
    byePoints: row.byePoints,
    tournamentPoints: row.totalPoints,
    playedPoints: row.playedPoints,
    pointDiff: row.pointDiff,
    matchesPlayed: row.matchesPlayed,
    rank: row.rank,
  };
});

const allScheduledMatchesCompleted =
  totalMatches > 0
  && completedMatches === totalMatches
  && completedRounds === tournament.rounds.length;
const keepTournamentInProgress =
  resumeRequested
  || (isClassicMexicanoTournament() && !tournamentFinished);

const summary = {
  totalRounds: tournament.rounds.length,
  completedRounds,
  totalMatches,
  completedMatches,
  byePolicy: BYE_POINTS_MODE === "zero_points" ? BYE_POLICY_ZERO : BYE_POLICY,
  status: tournamentFinished
    ? "completed"
    : keepTournamentInProgress
      ? "in_progress"
      : (allScheduledMatchesCompleted ? "completed" : "in_progress"),
  finished: tournamentFinished,
};
if (tournamentFinished) {
  summary.finishedAt = String(params.finishedAt || params.completedAt || now);
  summary.completedAt = String(params.completedAt || summary.finishedAt);
  summary.manualFinish = true;
}

tournament.playerLogs = playerLogs;
tournament.totals = totals;
tournament.standings = standings;
tournament.summary = summary;
tournament.params = params;
tournament.updatedAt = now;

msg.mongoQuery = { tournamentId: tournament.tournamentId };
msg.mongoUpdate = {
  $set: {
    rounds: tournament.rounds,
    params,
    totals,
    playerLogs,
    standings,
    summary,
    updatedAt: now,
  },
};

msg.payload = {
  tournamentId: tournament.tournamentId,
  params,
  rounds: tournament.rounds,
  totals,
  standings,
  summary,
  playerLogs,
};

return msg;
