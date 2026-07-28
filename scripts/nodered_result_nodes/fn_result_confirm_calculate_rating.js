const asArray = (value) => (Array.isArray(value) ? value : []);
const toStr = (value) => {
  if (value === null || value === undefined) return null;
  const text = String(value).trim();
  return text ? text : null;
};
const normPhone = (value) => {
  const digits = String(value || "").replace(/\D/g, "");
  if (!digits) return null;
  if (digits.length === 10) return `7${digits}`;
  if (digits.length === 11 && digits.startsWith("8")) return `7${digits.slice(1)}`;
  return digits;
};
const roundTo = (value, digits) => Number(Number(value).toFixed(digits));
const clamp = (value, min, max) => Math.max(min, Math.min(max, value));
const mapGradeToNum = (grade) => {
  const normalized = String(grade || "").toUpperCase();
  if (normalized === "D") return 2.0;
  if (normalized === "D+") return 2.5;
  if (normalized === "C") return 3.0;
  if (normalized === "C+") return 3.5;
  if (normalized === "B") return 4.2;
  if (normalized === "B+") return 5.0;
  if (normalized === "A") return 6.0;
  return null;
};
const mapNumToGrade = (value) => {
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) return null;
  if (numeric < 2) return "D";
  if (numeric < 3) return "D+";
  if (numeric < 3.5) return "C";
  if (numeric < 4) return "C+";
  if (numeric < 4.7) return "B";
  if (numeric < 5.5) return "B+";
  return "A";
};
const ratingValueFromAny = (value) => {
  if (value === null || value === undefined) return null;
  if (typeof value === "string" && !value.trim()) return null;
  const numeric = Number(value);
  if (Number.isFinite(numeric)) return numeric;
  const mapped = mapGradeToNum(value);
  return Number.isFinite(mapped) ? mapped : null;
};
const teamPower = (ratings) => {
  const values = ratings.filter((item) => Number.isFinite(item));
  if (values.length === 2) {
    const [left, right] = values;
    const denominator = left + right;
    if (denominator > 0) return (left * left + right * right) / denominator;
  }
  return values.length > 0
    ? values.reduce((sum, item) => sum + item, 0) / values.length
    : null;
};
const buildIdentityKey = (member) => (
  (toStr(member?.id || member?.clientId) ? `id:${toStr(member?.id || member?.clientId)}` : null)
    || (normPhone(member?.phoneNorm) ? `phone:${normPhone(member.phoneNorm)}` : null)
    || toStr(member?.memberKey)
);
const buildEffectiveSetPairings = (pending) => {
  const stored = asArray(pending?.ratingFacts?.effectiveSetPairings);
  if (stored.length > 0) return stored;
  const teamA = asArray(pending?.teams?.teamA);
  const teamB = asArray(pending?.teams?.teamB);
  const sets = asArray(pending?.sets || pending?.resultPayload?.sets);
  if (teamA.length === 0 && teamB.length === 0) return [];
  return (sets.length > 0 ? sets : [null]).map((_, setIndex) => ({ setIndex, teamA, teamB }));
};
const buildError = (message, details = null) => {
  const errorMsg = Object.assign({}, msg, {
    statusCode: 409,
    headers: { "Content-Type": "application/json; charset=utf-8" },
    payload: {
      error: message,
      code: "RATING_STATE_INCOMPLETE",
      details,
    },
  });
  return [null, errorMsg, errorMsg];
};

const pending = msg._resultPending || null;
if (!pending) return buildError("No pending result for rating calculation");
if (msg._resultRatingCalculationRequired !== true || pending?.ratingEnabled === false) {
  return [msg, null, msg];
}

const params = Object.assign(
  { K: 0.3, D: 3, B: 0.3, minRating: 1, maxRating: 7, round: 5 },
  pending?.ratingFacts?.params || msg?._resultConfirm?.game?.params || {},
);
const K = Number.isFinite(Number(params.K)) ? Number(params.K) : 0.3;
const D = Number.isFinite(Number(params.D)) ? Number(params.D) : 3;
const B = Number.isFinite(Number(params.B)) ? Number(params.B) : 0.3;
const MIN_R = Number.isFinite(Number(params.minRating)) ? Number(params.minRating) : 1;
const MAX_R = Number.isFinite(Number(params.maxRating)) ? Number(params.maxRating) : 7;
const ROUND = Number.isFinite(Number(params.round)) ? Number(params.round) : 5;
const formula = {
  version: "game-rating-v1",
  K,
  D,
  B,
  minRating: MIN_R,
  maxRating: MAX_R,
  round: ROUND,
  ratingSource: "player_rating_state_at_confirm",
};

const ratingsById = new Map();
const ratingsByPhone = new Map();
asArray(msg.payload).forEach((row) => {
  const clientId = toStr(row?.clientId || (
    String(row?.playerKey || "").startsWith("client:")
      ? String(row.playerKey).slice("client:".length)
      : null
  ));
  const phoneNorm = normPhone(row?.phoneNorm || row?.phone);
  const liveRating = ratingValueFromAny(row?.ratingNumeric ?? row?.rating);
  if (!Number.isFinite(liveRating)) return;
  if (clientId) ratingsById.set(clientId, Number(liveRating));
  if (phoneNorm) ratingsByPhone.set(phoneNorm, Number(liveRating));
});

const sets = asArray(pending?.ratingFacts?.sets).length > 0
  ? asArray(pending.ratingFacts.sets)
  : asArray(pending?.sets || pending?.resultPayload?.sets);
const pairings = buildEffectiveSetPairings(pending);
if (sets.length === 0 || pairings.length !== sets.length) {
  return buildError("Pending result does not contain rating facts for every set", {
    setCount: sets.length,
    pairingCount: pairings.length,
  });
}

const playerStates = new Map();
const missingRatings = [];
const ensurePlayerState = (member) => {
  const memberKey = buildIdentityKey(member);
  const clientId = toStr(member?.id || member?.clientId);
  const phoneNorm = normPhone(member?.phoneNorm);
  if (!memberKey || (!clientId && !phoneNorm)) return null;
  if (playerStates.has(memberKey)) return playerStates.get(memberKey);
  const initial = clientId && ratingsById.has(clientId)
    ? ratingsById.get(clientId)
    : ratingsByPhone.get(phoneNorm);
  if (!Number.isFinite(initial)) {
    missingRatings.push({ memberKey, id: clientId, phoneNorm, name: toStr(member?.name) || "Игрок" });
    return null;
  }
  const state = {
    memberKey,
    id: clientId,
    phoneNorm,
    name: toStr(member?.name) || "Игрок",
    current: Number(initial),
    initial: Number(initial),
    expectedSum: 0,
    actualSum: 0,
    appearances: 0,
    teamsPlayed: new Set(),
  };
  playerStates.set(memberKey, state);
  return state;
};

pairings.forEach((pairing) => {
  [...asArray(pairing?.teamA), ...asArray(pairing?.teamB)].forEach(ensurePlayerState);
});
if (missingRatings.length > 0) {
  return buildError("Live rating is missing for one or more played players", missingRatings);
}

const intermediateResults = [];
for (let index = 0; index < sets.length; index += 1) {
  const setScore = sets[index];
  const pairing = pairings.find((item) => Number(item?.setIndex) === index) || pairings[index];
  const teamAStates = asArray(pairing?.teamA).map(ensurePlayerState).filter(Boolean);
  const teamBStates = asArray(pairing?.teamB).map(ensurePlayerState).filter(Boolean);
  const setKeys = [...teamAStates, ...teamBStates].map((item) => item.memberKey);
  if (teamAStates.length !== 2 || teamBStates.length !== 2 || new Set(setKeys).size !== 4) {
    return buildError(`Rating facts for set ${index + 1} do not contain a valid 2v2 pairing`);
  }

  const scoreA = Number(setScore?.left || 0);
  const scoreB = Number(setScore?.right || 0);
  const currentA = teamAStates.map((item) => Number(item.current));
  const currentB = teamBStates.map((item) => Number(item.current));
  const powerA = teamPower(currentA);
  const powerB = teamPower(currentB);
  if (!Number.isFinite(powerA) || !Number.isFinite(powerB)) {
    return buildError(`Live rating state is invalid for set ${index + 1}`);
  }
  const actualA = 1 / (1 + Math.exp(-B * (scoreA - scoreB)));
  const actualB = 1 / (1 + Math.exp(-B * (scoreB - scoreA)));
  const applyDelta = (players, ratings, opponentPower, actual, teamLabel) => players.map((player, playerIndex) => {
    const before = Number(ratings[playerIndex]);
    const expected = 1 / (1 + Math.pow(10, (opponentPower - before) / D));
    const delta = roundTo(K * (actual - expected), ROUND);
    const after = roundTo(clamp(before + delta, MIN_R, MAX_R), ROUND);
    player.current = after;
    player.expectedSum += expected;
    player.actualSum += actual;
    player.appearances += 1;
    player.teamsPlayed.add(teamLabel);
    return {
      memberKey: player.memberKey,
      id: player.id,
      phoneNorm: player.phoneNorm,
      name: player.name,
      team: teamLabel,
      before,
      expected: roundTo(expected, ROUND),
      actual: roundTo(actual, ROUND),
      delta,
      after,
      gradeBefore: mapNumToGrade(before),
      gradeAfter: mapNumToGrade(after),
    };
  });
  intermediateResults.push({
    setIndex: Number.isInteger(Number(pairing?.setIndex)) ? Number(pairing.setIndex) : index,
    score: { left: scoreA, right: scoreB },
    impact: [
      ...applyDelta(teamAStates, currentA, powerB, actualA, "A"),
      ...applyDelta(teamBStates, currentB, powerA, actualB, "B"),
    ],
  });
}

const ratingImpact = Array.from(playerStates.values())
  .filter((item) => item.appearances > 0)
  .map((item) => {
    const before = roundTo(item.initial, ROUND);
    const after = roundTo(item.current, ROUND);
    const teamsPlayed = Array.from(item.teamsPlayed.values());
    return {
      memberKey: item.memberKey,
      id: item.id,
      phoneNorm: item.phoneNorm,
      name: item.name,
      team: teamsPlayed.length === 1 ? teamsPlayed[0] : null,
      before,
      expected: roundTo(item.expectedSum / item.appearances, ROUND),
      actual: roundTo(item.actualSum / item.appearances, ROUND),
      delta: roundTo(after - before, ROUND),
      after,
      gradeBefore: mapNumToGrade(before),
      gradeAfter: mapNumToGrade(after),
    };
  });
if (ratingImpact.length === 0) {
  return buildError("Rating impact could not be calculated from live rating state");
}

const calculatedAt = new Date().toISOString();
msg._resultPending = Object.assign({}, pending, {
  ratingFormula: formula,
  ratingImpact,
  intermediateResults,
  ratingCalculatedAt: calculatedAt,
  ratingCalculatedAtTs: Date.parse(calculatedAt),
  ratingEvent: Object.assign({}, pending?.ratingEvent || {}, {
    id: pending?.ratingEvent?.id || `rate_${pending.id}`,
    gameId: pending.gameId,
    resultId: pending.id,
    ratingEnabled: true,
    formula,
    ratingImpact,
  }),
});
msg._resultLiveRatingCalculated = true;
return [msg, null, msg];
