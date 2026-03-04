const asArray = (v) => Array.isArray(v) ? v : [];
const uniq = (arr) => Array.from(new Set(arr.filter(Boolean)));

const defaultParams = { K: 0.3, D: 3, B: 0.3, minRating: 1, maxRating: 7, round: 5 };

const roundTo = (n, d) => Number(Number(n).toFixed(d));
const clamp = (v, min, max) => Math.max(min, Math.min(max, v));

const mapGradeToNum = (grade) => {
  const g = String(grade || '').toUpperCase();
  if (g === 'D') return 2.0;
  if (g === 'D+') return 2.5;
  if (g === 'C') return 3.0;
  if (g === 'C+') return 3.5;
  if (g === 'B') return 4.2;
  if (g === 'B+') return 5.0;
  if (g === 'A') return 6.0;
  return null;
};

const mapNumToGrade = (n) => {
  const v = Number(n);
  if (!Number.isFinite(v)) return null;
  if (v < 2.25) return 'D';
  if (v < 2.75) return 'D+';
  if (v < 3.25) return 'C';
  if (v < 3.75) return 'C+';
  if (v < 4.6) return 'B';
  if (v < 5.5) return 'B+';
  return 'A';
};

const ratingFromAny = (value, fallback = 2.5) => {
  const n = Number(value);
  if (Number.isFinite(n)) return n;
  const mapped = mapGradeToNum(value);
  if (Number.isFinite(mapped)) return mapped;
  return fallback;
};

const teamPower = (ratings) => {
  const arr = ratings.filter((v) => Number.isFinite(v));
  if (arr.length === 0) return 2.5;
  if (arr.length === 2) {
    const [a, b] = arr;
    const denom = a + b;
    if (denom > 0) return (a * a + b * b) / denom;
  }
  return arr.reduce((s, v) => s + v, 0) / arr.length;
};

const ratingRows = asArray(msg.payload);
const ctx = msg._resultConfirm || {};
const pending = msg._resultPending || null;
if (!pending) {
  msg.statusCode = 409;
  msg.headers = { "Content-Type": "application/json; charset=utf-8" };
  msg.payload = { error: 'No pending result context' };
  return [null, null, null, msg, msg];
}

const params = Object.assign({}, defaultParams, pending?.params || {}, ctx?.game?.params || {});
const K = Number.isFinite(Number(params.K)) ? Number(params.K) : defaultParams.K;
const D = Number.isFinite(Number(params.D)) ? Number(params.D) : defaultParams.D;
const B = Number.isFinite(Number(params.B)) ? Number(params.B) : defaultParams.B;
const MIN_R = Number.isFinite(Number(params.minRating)) ? Number(params.minRating) : defaultParams.minRating;
const MAX_R = Number.isFinite(Number(params.maxRating)) ? Number(params.maxRating) : defaultParams.maxRating;
const ROUND = Number.isFinite(Number(params.round)) ? Number(params.round) : defaultParams.round;

const ratingsMap = new Map();
ratingRows.forEach((r) => {
  const phone = String(r?.phoneNorm || '').trim();
  if (!phone) return;
  const numeric = ratingFromAny(r?.ratingNumeric ?? r?.rating, 2.5);
  ratingsMap.set(phone, numeric);
});

const teamA = asArray(pending?.teams?.teamA).map((p) => ({
  id: p?.id || null,
  name: p?.name || 'Игрок',
  phoneNorm: p?.phoneNorm,
  ratingSeed: p?.ratingNumeric ?? p?.rating,
})).filter((p) => p.phoneNorm);
const teamB = asArray(pending?.teams?.teamB).map((p) => ({
  id: p?.id || null,
  name: p?.name || 'Игрок',
  phoneNorm: p?.phoneNorm,
  ratingSeed: p?.ratingNumeric ?? p?.rating,
})).filter((p) => p.phoneNorm);

if (teamA.length === 0 || teamB.length === 0) {
  msg.statusCode = 409;
  msg.headers = { "Content-Type": "application/json; charset=utf-8" };
  msg.payload = { error: 'Pending result teams invalid' };
  return [null, null, null, msg, msg];
}

const currentA = teamA.map((p) => ratingsMap.get(p.phoneNorm) ?? ratingFromAny(p.ratingSeed, 2.5));
const currentB = teamB.map((p) => ratingsMap.get(p.phoneNorm) ?? ratingFromAny(p.ratingSeed, 2.5));

const scoreA = Number(pending?.score?.teamA || 0);
const scoreB = Number(pending?.score?.teamB || 0);

const actualA = 1 / (1 + Math.exp(-B * (scoreA - scoreB)));
const actualB = 1 / (1 + Math.exp(-B * (scoreB - scoreA)));
const powerA = teamPower(currentA);
const powerB = teamPower(currentB);

const applyDeltas = (teamPlayers, teamCurrentRatings, opponentPower, actual, teamLabel) => {
  return teamPlayers.map((p, idx) => {
    const before = Number(teamCurrentRatings[idx]);
    const expected = 1 / (1 + Math.pow(10, (opponentPower - before) / D));
    const delta = roundTo(K * (actual - expected), ROUND);
    const after = roundTo(clamp(before + delta, MIN_R, MAX_R), ROUND);
    return {
      id: p.id,
      name: p.name,
      phoneNorm: p.phoneNorm,
      team: teamLabel,
      before,
      expected: roundTo(expected, ROUND),
      actual: roundTo(actual, ROUND),
      delta,
      after,
      gradeAfter: mapNumToGrade(after),
    };
  });
};

const impactA = applyDeltas(teamA, currentA, powerB, actualA, 'A');
const impactB = applyDeltas(teamB, currentB, powerA, actualB, 'B');
const ratingImpact = [...impactA, ...impactB];

const now = new Date();
const nowIso = now.toISOString();
const nowTs = now.getTime();

const confirmer = teamB.find((p) => p.phoneNorm === ctx.phone) || { id: null, name: 'Игрок', phoneNorm: ctx.phone };

const resultUpdateMsg = Object.assign({}, msg, {
  query: { id: pending.id, status: 'PENDING_CONFIRMATION' },
  payload: {
    $set: {
      status: 'CONFIRMED',
      confirmedBy: {
        id: confirmer.id,
        name: confirmer.name,
        phoneNorm: confirmer.phoneNorm,
      },
      confirmedAt: nowIso,
      confirmedAtTs: nowTs,
      ratingImpact,
      updatedAt: nowIso,
    },
  },
});

const ratingsBulk = ratingImpact.map((entry) => ({
  query: { phoneNorm: entry.phoneNorm },
  update: {
    $set: {
      phoneNorm: entry.phoneNorm,
      name: entry.name,
      ratingNumeric: entry.after,
      rating: entry.gradeAfter,
      updatedAt: nowIso,
      lastGameId: ctx.game?.id || pending.gameId,
      lastResultId: pending.id,
      lastDelta: entry.delta,
      team: entry.team,
    },
    $setOnInsert: {
      createdAt: nowIso,
    },
  },
}));

const updatedParticipants = asArray(ctx?.game?.participants).map((p) => {
  const phoneNorm = String(p?.phoneNorm || p?.phone || '').replace(/\D/g, '');
  const found = ratingImpact.find((ri) => ri.phoneNorm === phoneNorm);
  if (!found) return p;
  return Object.assign({}, p, {
    ratingNumeric: found.after,
    rating: found.gradeAfter,
  });
});

const gameUpdateMsg = Object.assign({}, msg, {
  query: { id: ctx.game?.id || pending.gameId },
  payload: {
    $set: {
      resultStatus: 'CONFIRMED',
      resultId: pending.id,
      lastResultAt: nowIso,
      participants: updatedParticipants,
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
    status: 'CONFIRMED',
    confirmedAt: nowIso,
    ratingImpact,
  },
});

const ratingsMsg = Object.assign({}, msg, { payload: ratingsBulk });

return [resultUpdateMsg, ratingsMsg, gameUpdateMsg, responseMsg, responseMsg];
