import {
  buildGameResultCompensationEvent,
  buildGameResultRatingEvent,
  buildPlayerRatingKey,
  normalizeRatingPhone,
  ratingGradeFromNumeric,
  roundPlayerRating,
  toFiniteRating,
} from "../../src/services/player-rating/ledger.ts";

const asArray = (value) => Array.isArray(value) ? value : [];
const toStr = (value) => {
  if (value === null || value === undefined) return null;
  const normalized = String(value).trim();
  return normalized || null;
};
const roundTo = (value, digits) => Number(Number(value).toFixed(digits));
const clamp = (value, min, max) => Math.max(min, Math.min(max, value));

export class GameResultRatingError extends Error {
  constructor(code, message, details = null, retryable = false) {
    super(message);
    this.name = "GameResultRatingError";
    this.code = code;
    this.details = details;
    this.retryable = retryable;
  }
}

export function buildGameResultIdentity(member) {
  const clientId = toStr(member?.id || member?.clientId);
  const phoneNorm = normalizeRatingPhone(member?.phoneNorm || member?.phone);
  const memberKey = toStr(member?.memberKey);
  const playerKey = buildPlayerRatingKey({ clientId, phoneNorm, fallback: memberKey });
  return playerKey ? {
    playerKey,
    clientId,
    phoneNorm,
    memberKey,
    name: toStr(member?.name) || "Игрок",
  } : null;
}

function teamPower(ratings) {
  const values = ratings.filter(Number.isFinite);
  if (values.length === 2) {
    const [left, right] = values;
    const denominator = left + right;
    if (denominator > 0) return (left * left + right * right) / denominator;
  }
  return values.length > 0
    ? values.reduce((sum, value) => sum + value, 0) / values.length
    : null;
}

function effectiveSetPairings(result) {
  const stored = asArray(result?.ratingFacts?.effectiveSetPairings);
  if (stored.length > 0) return stored;
  const teamA = asArray(result?.teams?.teamA);
  const teamB = asArray(result?.teams?.teamB);
  const sets = asArray(result?.ratingFacts?.sets || result?.sets || result?.resultPayload?.sets);
  if (teamA.length === 0 && teamB.length === 0) return [];
  return (sets.length > 0 ? sets : [null]).map((_, setIndex) => ({ setIndex, teamA, teamB }));
}

function indexRatings(rows) {
  const byPlayerKey = new Map();
  const byClientId = new Map();
  const byPhone = new Map();
  asArray(rows).forEach((row) => {
    const identity = buildGameResultIdentity(row);
    const ratingNumeric = toFiniteRating(row?.ratingNumeric ?? row?.rating);
    if (!identity || ratingNumeric == null) return;
    byPlayerKey.set(identity.playerKey, ratingNumeric);
    if (identity.clientId) byClientId.set(identity.clientId, ratingNumeric);
    if (identity.phoneNorm) byPhone.set(identity.phoneNorm, ratingNumeric);
  });
  return { byPlayerKey, byClientId, byPhone };
}

function resolveRating(index, identity) {
  if (index.byPlayerKey.has(identity.playerKey)) return index.byPlayerKey.get(identity.playerKey);
  if (identity.clientId && index.byClientId.has(identity.clientId)) return index.byClientId.get(identity.clientId);
  if (identity.phoneNorm && index.byPhone.has(identity.phoneNorm)) return index.byPhone.get(identity.phoneNorm);
  return null;
}

export function calculateGameResultRating(result, ratingRows) {
  const sets = asArray(result?.ratingFacts?.sets).length > 0
    ? asArray(result.ratingFacts.sets)
    : asArray(result?.sets || result?.resultPayload?.sets);
  const pairings = effectiveSetPairings(result);
  if (sets.length === 0 || pairings.length !== sets.length) {
    throw new GameResultRatingError(
      "INVALID_RATING_FACTS",
      "Result does not contain rating facts for every set",
      { setCount: sets.length, pairingCount: pairings.length },
    );
  }

  const params = {
    K: 0.3,
    D: 3,
    B: 0.3,
    minRating: 1,
    maxRating: 7,
    round: 5,
    ...(result?.ratingFacts?.params || {}),
  };
  const K = Number.isFinite(Number(params.K)) ? Number(params.K) : 0.3;
  const D = Number.isFinite(Number(params.D)) ? Number(params.D) : 3;
  const B = Number.isFinite(Number(params.B)) ? Number(params.B) : 0.3;
  const minRating = Number.isFinite(Number(params.minRating)) ? Number(params.minRating) : 1;
  const maxRating = Number.isFinite(Number(params.maxRating)) ? Number(params.maxRating) : 7;
  const round = Number.isFinite(Number(params.round)) ? Number(params.round) : 5;
  const formula = {
    version: "game-rating-v1",
    K,
    D,
    B,
    minRating,
    maxRating,
    round,
    ratingSource: "player_rating_state_at_worker",
  };
  const ratingIndex = indexRatings(ratingRows);
  const playerStates = new Map();
  const missingRatings = [];
  const ensurePlayer = (member) => {
    const identity = buildGameResultIdentity(member);
    if (!identity) return null;
    if (playerStates.has(identity.playerKey)) return playerStates.get(identity.playerKey);
    const initial = resolveRating(ratingIndex, identity);
    if (initial == null) {
      missingRatings.push(identity);
      return null;
    }
    const state = {
      ...identity,
      initial,
      current: initial,
      expectedSum: 0,
      actualSum: 0,
      appearances: 0,
      teamsPlayed: new Set(),
    };
    playerStates.set(identity.playerKey, state);
    return state;
  };
  pairings.forEach((pairing) => {
    [...asArray(pairing?.teamA), ...asArray(pairing?.teamB)].forEach(ensurePlayer);
  });
  if (missingRatings.length > 0) {
    throw new GameResultRatingError(
      "RATING_STATE_INCOMPLETE",
      "Canonical rating is missing for one or more played players",
      missingRatings,
      true,
    );
  }

  const intermediateResults = [];
  for (let setIndex = 0; setIndex < sets.length; setIndex += 1) {
    const score = sets[setIndex];
    const pairing = pairings.find((item) => Number(item?.setIndex) === setIndex) || pairings[setIndex];
    const teamA = asArray(pairing?.teamA).map(ensurePlayer).filter(Boolean);
    const teamB = asArray(pairing?.teamB).map(ensurePlayer).filter(Boolean);
    const setPlayers = [...teamA, ...teamB];
    if (teamA.length !== 2 || teamB.length !== 2 || new Set(setPlayers.map((item) => item.playerKey)).size !== 4) {
      throw new GameResultRatingError(
        "INVALID_SET_PAIRING",
        `Rating facts for set ${setIndex + 1} do not contain a valid 2v2 pairing`,
      );
    }
    const scoreA = Number(score?.left);
    const scoreB = Number(score?.right);
    if (!Number.isFinite(scoreA) || !Number.isFinite(scoreB) || scoreA === scoreB) {
      throw new GameResultRatingError("INVALID_SET_SCORE", `Invalid score for set ${setIndex + 1}`);
    }
    const currentA = teamA.map((item) => Number(item.current));
    const currentB = teamB.map((item) => Number(item.current));
    const powerA = teamPower(currentA);
    const powerB = teamPower(currentB);
    if (!Number.isFinite(powerA) || !Number.isFinite(powerB)) {
      throw new GameResultRatingError("INVALID_RATING_STATE", `Invalid rating state for set ${setIndex + 1}`, null, true);
    }
    const actualA = 1 / (1 + Math.exp(-B * (scoreA - scoreB)));
    const actualB = 1 / (1 + Math.exp(-B * (scoreB - scoreA)));
    const applyTeam = (players, ratings, opponentPower, actual, team) => players.map((player, index) => {
      const before = Number(ratings[index]);
      const expected = 1 / (1 + Math.pow(10, (opponentPower - before) / D));
      const delta = roundTo(K * (actual - expected), round);
      const after = roundTo(clamp(before + delta, minRating, maxRating), round);
      player.current = after;
      player.expectedSum += expected;
      player.actualSum += actual;
      player.appearances += 1;
      player.teamsPlayed.add(team);
      return {
        ...player,
        team,
        before,
        expected: roundTo(expected, round),
        actual: roundTo(actual, round),
        delta,
        after,
        gradeBefore: ratingGradeFromNumeric(before),
        gradeAfter: ratingGradeFromNumeric(after),
      };
    });
    intermediateResults.push({
      setIndex,
      score: { left: scoreA, right: scoreB },
      impact: [
        ...applyTeam(teamA, currentA, powerB, actualA, "A"),
        ...applyTeam(teamB, currentB, powerA, actualB, "B"),
      ],
    });
  }

  const ratingImpact = Array.from(playerStates.values())
    .filter((item) => item.appearances > 0)
    .map((item) => {
      const before = roundTo(item.initial, round);
      const after = roundTo(item.current, round);
      const teamsPlayed = Array.from(item.teamsPlayed.values());
      return {
        memberKey: item.memberKey,
        id: item.clientId,
        phoneNorm: item.phoneNorm,
        playerKey: item.playerKey,
        name: item.name,
        team: teamsPlayed.length === 1 ? teamsPlayed[0] : null,
        before,
        expected: roundTo(item.expectedSum / item.appearances, round),
        actual: roundTo(item.actualSum / item.appearances, round),
        delta: roundTo(after - before, round),
        after,
        gradeBefore: ratingGradeFromNumeric(before),
        gradeAfter: ratingGradeFromNumeric(after),
      };
    });
  if (ratingImpact.length !== 4) {
    throw new GameResultRatingError(
      "INVALID_RATING_PARTICIPANTS",
      "Rating calculation must contain exactly four players",
      { count: ratingImpact.length },
    );
  }
  return { formula, ratingImpact, intermediateResults };
}

export function applyCorrectionCompensationToRatings(ratingRows, previousEvents) {
  const deltas = new Map();
  asArray(previousEvents).forEach((event) => {
    const playerKey = toStr(event?.player?.key);
    const delta = toFiniteRating(event?.change?.delta);
    if (playerKey && delta != null) deltas.set(playerKey, (deltas.get(playerKey) || 0) - delta);
  });
  return asArray(ratingRows).map((row) => {
    const identity = buildGameResultIdentity(row);
    const current = toFiniteRating(row?.ratingNumeric ?? row?.rating);
    if (!identity || current == null || !deltas.has(identity.playerKey)) return row;
    return {
      ...row,
      ratingNumeric: roundPlayerRating(current + deltas.get(identity.playerKey)),
    };
  });
}

export function buildGameResultRatingPlan({
  result,
  ratingRows,
  previousEvents = [],
  previousCompensationEvents = [],
  predecessorReverted = false,
  nowIso,
}) {
  const scoreRevision = Number.isInteger(Number(result?.scoreRevision)) ? Number(result.scoreRevision) : 1;
  const isCorrection = Boolean(toStr(result?.supersedesResultId));
  const predecessorAlreadyReverted = isCorrection && (
    predecessorReverted
    || (
      asArray(previousEvents).length > 0
      && asArray(previousCompensationEvents).length >= asArray(previousEvents).length
    )
  );
  if (
    isCorrection
    && asArray(previousCompensationEvents).length > 0
    && !predecessorAlreadyReverted
  ) {
    throw new GameResultRatingError(
      "PREDECESSOR_PARTIAL_REVERT",
      "Predecessor result contains a partial rating compensation",
      {
        applyEvents: asArray(previousEvents).length,
        compensationEvents: asArray(previousCompensationEvents).length,
      },
      true,
    );
  }
  const adjustedRows = isCorrection && !predecessorAlreadyReverted
    ? applyCorrectionCompensationToRatings(ratingRows, previousEvents)
    : asArray(ratingRows);
  if (isCorrection && asArray(previousEvents).length === 0 && !predecessorAlreadyReverted) {
    throw new GameResultRatingError(
      "PREDECESSOR_EVENTS_MISSING",
      "Correction cannot be applied before predecessor rating events are available",
      { supersedesResultId: result.supersedesResultId },
      true,
    );
  }
  const calculation = calculateGameResultRating(result, adjustedRows);
  const stateByKey = new Map(asArray(ratingRows).map((row) => [buildGameResultIdentity(row)?.playerKey, row]));
  const previousByKey = new Map(asArray(previousEvents).map((event) => [toStr(event?.player?.key), event]));
  const compensationEvents = isCorrection && !predecessorAlreadyReverted
    ? asArray(previousEvents).map((event) => {
      const currentRow = stateByKey.get(toStr(event?.player?.key));
      return buildGameResultCompensationEvent({
        event,
        correctionResultId: result.id,
        scoreRevision,
        occurredAt: nowIso,
        canonicalBefore: currentRow?.ratingNumeric ?? currentRow?.rating,
        createdAt: nowIso,
      });
    }).filter(Boolean)
    : [];
  const applyOccurredAt = new Date(Date.parse(nowIso) + (compensationEvents.length > 0 ? 1 : 0)).toISOString();
  const applyEvents = calculation.ratingImpact.map((impact) => buildGameResultRatingEvent({
    gameId: result.gameId,
    resultId: result.id,
    scoreRevision,
    occurredAt: applyOccurredAt,
    impact,
    formula: calculation.formula,
    actor: result.submittedBy,
    supersedesResultId: toStr(result.supersedesResultId),
    supersedesEventId: previousByKey.get(impact.playerKey)?.id || null,
    applySemantics: result?.ratingWork?.applySemantics,
    createdAt: nowIso,
  })).filter(Boolean);
  if (
    applyEvents.length !== 4
    || (isCorrection && !predecessorAlreadyReverted && compensationEvents.length !== 4)
  ) {
    throw new GameResultRatingError(
      "INVALID_EVENT_PLAN",
      "Game result rating plan must contain four apply events and four correction compensations",
      { applyEvents: applyEvents.length, compensationEvents: compensationEvents.length },
    );
  }
  return {
    schemaVersion: 1,
    jobKey: result?.ratingWork?.jobKey || `game-result:${result.id}:score:${scoreRevision}:apply`,
    gameId: result.gameId,
    resultId: result.id,
    scoreRevision,
    supersedesResultId: toStr(result.supersedesResultId),
    predecessorAlreadyReverted,
    applySemantics: result?.ratingWork?.applySemantics || (isCorrection ? "CORRECTION_TIME" : "INITIAL_APPLY"),
    preparedAt: nowIso,
    formula: calculation.formula,
    ratingImpact: calculation.ratingImpact,
    intermediateResults: calculation.intermediateResults,
    compensationEvents,
    applyEvents,
    eventIds: [...compensationEvents, ...applyEvents].map((event) => event.id),
  };
}

export function buildGameResultRevertPlan({
  result,
  ratingRows,
  appliedEvents = [],
  existingCompensationEvents = [],
  nowIso,
}) {
  const scoreRevision = Number.isInteger(Number(result?.scoreRevision)) ? Number(result.scoreRevision) : 1;
  if (asArray(existingCompensationEvents).length > 0) {
    if (asArray(existingCompensationEvents).length < asArray(appliedEvents).length) {
      throw new GameResultRatingError(
        "RESULT_PARTIAL_REVERT",
        "Result contains a partial rating compensation",
        {
          applyEvents: asArray(appliedEvents).length,
          compensationEvents: asArray(existingCompensationEvents).length,
        },
        true,
      );
    }
    return {
      schemaVersion: 1,
      desiredState: "REVERTED",
      jobKey: result?.ratingWork?.jobKey,
      gameId: result.gameId,
      resultId: result.id,
      scoreRevision,
      preparedAt: nowIso,
      formula: result.ratingFormula || result?.ratingEvent?.formula || null,
      ratingImpact: asArray(existingCompensationEvents).map((event) => ({
        id: event.player?.clientId || null,
        phoneNorm: event.player?.phoneNorm || null,
        playerKey: event.player?.key || null,
        name: event.player?.name || "Игрок",
        before: event.change?.before ?? null,
        delta: event.change?.delta ?? null,
        after: event.change?.after ?? null,
        gradeBefore: event.change?.gradeBefore ?? null,
        gradeAfter: event.change?.gradeAfter ?? null,
      })),
      intermediateResults: [],
      compensationEvents: [],
      applyEvents: [],
      eventIds: asArray(existingCompensationEvents).map((event) => event.id),
      alreadyReverted: true,
    };
  }
  if (asArray(appliedEvents).length === 0) {
    return {
      schemaVersion: 1,
      desiredState: "REVERTED",
      jobKey: result?.ratingWork?.jobKey,
      gameId: result.gameId,
      resultId: result.id,
      scoreRevision,
      preparedAt: nowIso,
      formula: result.ratingFormula || result?.ratingEvent?.formula || null,
      ratingImpact: [],
      intermediateResults: [],
      compensationEvents: [],
      applyEvents: [],
      eventIds: [],
      cancelledBeforeApply: true,
    };
  }
  if (asArray(appliedEvents).length !== 4) {
    throw new GameResultRatingError(
      "INVALID_APPLIED_EVENT_SET",
      "Applied game result must contain four player events before revert",
      { count: asArray(appliedEvents).length },
      true,
    );
  }
  const stateByKey = new Map(asArray(ratingRows).map((row) => [buildGameResultIdentity(row)?.playerKey, row]));
  const compensationEvents = asArray(appliedEvents).map((event) => {
    const current = stateByKey.get(toStr(event?.player?.key));
    return buildGameResultCompensationEvent({
      event,
      correctionResultId: result.id,
      scoreRevision,
      occurredAt: nowIso,
      canonicalBefore: current?.ratingNumeric ?? current?.rating,
      createdAt: nowIso,
    });
  }).filter(Boolean);
  if (compensationEvents.length !== 4) {
    throw new GameResultRatingError(
      "INVALID_REVERT_PLAN",
      "Rating revert plan must contain four compensation events",
      { count: compensationEvents.length },
      true,
    );
  }
  return {
    schemaVersion: 1,
    desiredState: "REVERTED",
    jobKey: result?.ratingWork?.jobKey,
    gameId: result.gameId,
    resultId: result.id,
    scoreRevision,
    preparedAt: nowIso,
    formula: result.ratingFormula || result?.ratingEvent?.formula || null,
    ratingImpact: compensationEvents.map((event) => ({
      id: event.player?.clientId || null,
      phoneNorm: event.player?.phoneNorm || null,
      playerKey: event.player?.key || null,
      name: event.player?.name || "Игрок",
      before: event.change.before,
      delta: event.change.delta,
      after: event.change.after,
      gradeBefore: event.change.gradeBefore,
      gradeAfter: event.change.gradeAfter,
    })),
    intermediateResults: [],
    compensationEvents,
    applyEvents: [],
    eventIds: compensationEvents.map((event) => event.id),
  };
}
