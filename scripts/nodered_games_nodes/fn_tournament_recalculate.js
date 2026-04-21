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
  return msg;
}

const body = msg.req?.body || {};
const results = Array.isArray(body.results) ? body.results : [];
const now = new Date().toISOString();

const params = Object.assign({}, tournament.params || {}, body.params || {});
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

results.forEach((result) => {
  if (!result?.roundId || !result?.matchId) return;
  const round = ensureRound(result.roundId);
  const match = ensureMatch(round, result.matchId);

  if (Array.isArray(result.pair1) && result.pair1.length) match.pair1 = result.pair1;
  if (Array.isArray(result.pair2) && result.pair2.length) match.pair2 = result.pair2;
  if (result.court) match.court = result.court;
  if (result.courtIndex !== undefined) match.courtIndex = result.courtIndex;
  if (result.score1 !== undefined) match.score1 = result.score1;
  if (result.score2 !== undefined) match.score2 = result.score2;
});

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
  const explicit = normalizeIdArray(round?.byes, `${round?.id || "round"}-bye`);
  if (explicit.length > 0) return explicit;

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

    const byePoints = roundCompleted && byeIds.length > 0 && roundActivePlayers > 0
      ? roundTo(roundPlayedPoints / roundActivePlayers, 2)
      : null;

    round.summary = Object.assign({}, round.summary || {}, {
      byePolicy: BYE_POLICY,
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
    if (right.totalPoints !== left.totalPoints) return right.totalPoints - left.totalPoints;
    if (right.pointDiff !== left.pointDiff) return right.pointDiff - left.pointDiff;
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

const summary = {
  totalRounds: tournament.rounds.length,
  completedRounds,
  totalMatches,
  completedMatches,
  byePolicy: BYE_POLICY,
};

tournament.playerLogs = playerLogs;
tournament.totals = totals;
tournament.standings = standings;
tournament.summary = summary;
tournament.updatedAt = now;

msg.mongoQuery = { tournamentId: tournament.tournamentId };
msg.mongoUpdate = {
  $set: {
    rounds: tournament.rounds,
    totals,
    playerLogs,
    standings,
    summary,
    updatedAt: now,
  },
};

msg.payload = {
  tournamentId: tournament.tournamentId,
  rounds: tournament.rounds,
  totals,
  standings,
  summary,
  playerLogs,
};

return msg;
