const DEFAULT_RATING = 3.5;
const MAX_BEAM_STATES = 48;
const MAX_MATCH_CANDIDATES_FIRST = 24;
const MAX_MATCH_CANDIDATES_NEXT = 14;
const BYE_POLICY = "round_average_points";
const clampNumber = (value, min, max) => Math.max(min, Math.min(max, value));
const roundTo = (value, digits = 2) => Number(value.toFixed(digits));
function safeNumber(value, fallback = 0) {
    const parsed = typeof value === "number" ? value : Number(value);
    return Number.isFinite(parsed) ? parsed : fallback;
}
export function parseTournamentRatingValue(value) {
    if (value == null)
        return null;
    if (typeof value === "number")
        return Number.isFinite(value) ? value : null;
    const normalized = value.replace(",", ".").trim();
    const digits = normalized.replace(/\D/g, "");
    if (digits.length >= 10)
        return null;
    const parsed = Number.parseFloat(normalized);
    if (!Number.isFinite(parsed))
        return null;
    if (parsed < 0 || parsed > 10)
        return null;
    return parsed;
}
function teamRatingPower(left, right) {
    const sum = left + right;
    if (sum <= 0)
        return DEFAULT_RATING;
    return (left * left + right * right) / sum;
}
function makePairKey(leftId, rightId) {
    return [leftId, rightId].sort().join("::");
}
function makeOpponentKey(leftId, rightId) {
    return [leftId, rightId].sort().join("::");
}
function getCourtQualityLabel(score) {
    if (score >= 90)
        return "Высокое";
    if (score >= 75)
        return "Хорошее";
    if (score >= 60)
        return "Нормальное";
    return "Риск повторов";
}
function getRoundProgress(roundIndex, totalRounds) {
    if (totalRounds <= 1)
        return 0;
    return clampNumber(roundIndex / (totalRounds - 1), 0, 1);
}
function getSelectionPartnerPenalty(repeatCount, progressRatio) {
    if (repeatCount <= 0)
        return 0;
    const perRepeatPenalty = 72 - progressRatio * 32;
    const extraRepeatPenalty = 24 - progressRatio * 8;
    return repeatCount * perRepeatPenalty + Math.max(0, repeatCount - 1) * extraRepeatPenalty;
}
function getSelectionOpponentPenalty(repeatCount) {
    if (repeatCount <= 0)
        return 0;
    return repeatCount * 26 + Math.max(0, repeatCount - 1) * 18;
}
function getSelectionBalancePenalty(balanceGap) {
    return Math.max(0, balanceGap - 0.1) * 30
        + Math.max(0, balanceGap - 0.55) * 36
        + Math.max(0, balanceGap - 1.15) * 48;
}
function getQualityPartnerPenalty(repeatCount, progressRatio) {
    if (repeatCount <= 0)
        return 0;
    const perRepeatPenalty = 24 - progressRatio * 8;
    const extraRepeatPenalty = 16 - progressRatio * 4;
    return repeatCount * perRepeatPenalty + Math.max(0, repeatCount - 1) * extraRepeatPenalty;
}
function getAllowedOpponentRepeatBudget(progressRatio, totalPlayers) {
    const roundEndAllowance = clampNumber(totalPlayers / 2.5, 2, 6);
    return progressRatio * roundEndAllowance;
}
function getQualityOpponentPenalty(repeatCount, progressRatio, totalPlayers) {
    const excessRepeats = Math.max(0, repeatCount - getAllowedOpponentRepeatBudget(progressRatio, totalPlayers));
    return excessRepeats * 8 + Math.max(0, excessRepeats - 1) * 4;
}
function getQualityBalancePenalty(balanceGap) {
    return Math.max(0, balanceGap - 0.2) * 8
        + Math.max(0, balanceGap - 0.85) * 13
        + Math.max(0, balanceGap - 1.6) * 18;
}
function getNormalizedCourtPressure(players, courtIndex, history, roundIndex, courtsCount) {
    if (roundIndex <= 0 || courtsCount <= 1)
        return 0;
    const expectedVisitsPerCourt = roundIndex / courtsCount;
    const pressure = players.reduce((total, player) => (total + Math.max(0, getCourtCount(history, player.id, courtIndex) - expectedVisitsPerCourt)), 0);
    return roundTo(pressure, 2);
}
function getStateRankingScore(score, minBaseScore) {
    if (!Number.isFinite(minBaseScore))
        return score;
    return score + minBaseScore * 0.45;
}
function normalizeParticipants(participants) {
    return participants.map((participant, index) => ({
        ...participant,
        id: String(participant.id || participant.phone || `participant-${index}`),
        name: participant.name || `Участник ${index + 1}`,
        ratingValue: parseTournamentRatingValue(participant.rating) ?? DEFAULT_RATING,
        seed: index,
    }));
}
function createHistory(players, courts) {
    const byeCounts = new Map();
    const courtCounts = new Map();
    players.forEach((player) => {
        byeCounts.set(player.id, { count: 0, lastRound: null });
        courtCounts.set(player.id, Array.from({ length: courts.length }, () => 0));
    });
    return {
        partnerCounts: new Map(),
        opponentCounts: new Map(),
        byeCounts,
        courtCounts,
    };
}
function getPartnerCount(history, leftId, rightId) {
    return history.partnerCounts.get(makePairKey(leftId, rightId)) ?? 0;
}
function getOpponentCount(history, leftId, rightId) {
    return history.opponentCounts.get(makeOpponentKey(leftId, rightId)) ?? 0;
}
function getCourtCount(history, playerId, courtIndex) {
    return history.courtCounts.get(playerId)?.[courtIndex] ?? 0;
}
function countUnseenPartners(player, pool, history) {
    return pool.reduce((total, candidate) => (candidate.id !== player.id && getPartnerCount(history, player.id, candidate.id) === 0 ? total + 1 : total), 0);
}
function orderRemainingPlayers(players, history) {
    return [...players].sort((left, right) => {
        const leftFlex = countUnseenPartners(left, players, history);
        const rightFlex = countUnseenPartners(right, players, history);
        if (leftFlex !== rightFlex)
            return leftFlex - rightFlex;
        if (right.ratingValue !== left.ratingValue)
            return right.ratingValue - left.ratingValue;
        return left.seed - right.seed;
    });
}
function selectByePlayers(players, byeCount, history) {
    if (byeCount <= 0)
        return [];
    return [...players]
        .sort((left, right) => {
        const leftBye = history.byeCounts.get(left.id) ?? { count: 0, lastRound: null };
        const rightBye = history.byeCounts.get(right.id) ?? { count: 0, lastRound: null };
        if (leftBye.count !== rightBye.count)
            return leftBye.count - rightBye.count;
        const leftLast = leftBye.lastRound ?? Number.NEGATIVE_INFINITY;
        const rightLast = rightBye.lastRound ?? Number.NEGATIVE_INFINITY;
        if (leftLast !== rightLast)
            return leftLast - rightLast;
        const leftCourtLoad = (history.courtCounts.get(left.id) ?? []).reduce((sum, value) => sum + value, 0);
        const rightCourtLoad = (history.courtCounts.get(right.id) ?? []).reduce((sum, value) => sum + value, 0);
        if (rightCourtLoad !== leftCourtLoad)
            return rightCourtLoad - leftCourtLoad;
        return left.seed - right.seed;
    })
        .slice(0, byeCount);
}
function buildMatchExplanation(summary, courtRepeatPressure) {
    const parts = [
        summary.partnerRepeatCount > 0
            ? `${summary.partnerRepeatCount} повтор партнера`
            : "новые пары",
        summary.opponentRepeatCount > 0
            ? `${summary.opponentRepeatCount} повтор соперника`
            : "новые соперники",
        `баланс ${roundTo(summary.balanceGap, 2)}`,
    ];
    if (courtRepeatPressure > 0.1) {
        parts.push(`перекос корта ${roundTo(courtRepeatPressure, 1)}`);
    }
    return parts.join(" · ");
}
function evaluateMatchDraft(pair1, pair2, history, roundIndex, totalRounds) {
    const [p1a, p1b] = pair1;
    const [p2a, p2b] = pair2;
    const progressRatio = getRoundProgress(roundIndex, totalRounds);
    const partnerRepeatCount = getPartnerCount(history, p1a.id, p1b.id) + getPartnerCount(history, p2a.id, p2b.id);
    const opponentRepeatCount = getOpponentCount(history, p1a.id, p2a.id)
        + getOpponentCount(history, p1a.id, p2b.id)
        + getOpponentCount(history, p1b.id, p2a.id)
        + getOpponentCount(history, p1b.id, p2b.id);
    const pairPower1 = teamRatingPower(p1a.ratingValue, p1b.ratingValue);
    const pairPower2 = teamRatingPower(p2a.ratingValue, p2b.ratingValue);
    const balanceGap = Math.abs(pairPower1 - pairPower2);
    const unseenPartnerEdges = (getPartnerCount(history, p1a.id, p1b.id) === 0 ? 1 : 0)
        + (getPartnerCount(history, p2a.id, p2b.id) === 0 ? 1 : 0);
    const unseenOpponentEdges = (getOpponentCount(history, p1a.id, p2a.id) === 0 ? 1 : 0)
        + (getOpponentCount(history, p1a.id, p2b.id) === 0 ? 1 : 0)
        + (getOpponentCount(history, p1b.id, p2a.id) === 0 ? 1 : 0)
        + (getOpponentCount(history, p1b.id, p2b.id) === 0 ? 1 : 0);
    const baseScore = 280
        - getSelectionPartnerPenalty(partnerRepeatCount, progressRatio)
        - getSelectionOpponentPenalty(opponentRepeatCount)
        - getSelectionBalancePenalty(balanceGap)
        + unseenPartnerEdges * 12
        + unseenOpponentEdges * 3;
    return {
        players: [p1a, p1b, p2a, p2b],
        pair1,
        pair2,
        baseScore,
        summary: {
            pairPower1: roundTo(pairPower1, 3),
            pairPower2: roundTo(pairPower2, 3),
            balanceGap: roundTo(balanceGap, 3),
            partnerRepeatCount,
            opponentRepeatCount,
        },
    };
}
function generateMatchCandidates(players, history, roundIndex, totalRounds) {
    const ordered = orderRemainingPlayers(players, history);
    const anchor = ordered[0];
    if (!anchor)
        return [];
    const candidates = new Map();
    ordered.slice(1).forEach((partner) => {
        const opponents = ordered.filter((player) => player.id !== anchor.id && player.id !== partner.id);
        for (let firstIndex = 0; firstIndex < opponents.length; firstIndex += 1) {
            for (let secondIndex = firstIndex + 1; secondIndex < opponents.length; secondIndex += 1) {
                const draft = evaluateMatchDraft([anchor, partner], [opponents[firstIndex], opponents[secondIndex]], history, roundIndex, totalRounds);
                const key = draft.players.map((player) => player.id).sort().join("|");
                if (!candidates.has(key) || (candidates.get(key)?.baseScore ?? Number.NEGATIVE_INFINITY) < draft.baseScore) {
                    candidates.set(key, draft);
                }
            }
        }
    });
    return [...candidates.values()].sort((left, right) => right.baseScore - left.baseScore);
}
function removePlayers(source, idsToRemove) {
    const blacklist = new Set(idsToRemove);
    return source.filter((player) => !blacklist.has(player.id));
}
function buildFallbackMatches(players, history, roundIndex, totalRounds) {
    const ordered = orderRemainingPlayers(players, history);
    const drafts = [];
    for (let index = 0; index < ordered.length; index += 4) {
        const block = ordered.slice(index, index + 4);
        if (block.length < 4)
            break;
        drafts.push(evaluateMatchDraft([block[0], block[1]], [block[2], block[3]], history, roundIndex, totalRounds));
    }
    return drafts;
}
function planRoundMatches(players, history, roundIndex, totalRounds) {
    const matchesCount = Math.floor(players.length / 4);
    if (matchesCount <= 0)
        return [];
    let states = [{
            remaining: orderRemainingPlayers(players, history),
            matches: [],
            score: 0,
            minBaseScore: Number.POSITIVE_INFINITY,
        }];
    for (let matchIndex = 0; matchIndex < matchesCount; matchIndex += 1) {
        const nextStates = [];
        states.forEach((state) => {
            const orderedRemaining = orderRemainingPlayers(state.remaining, history);
            const candidates = generateMatchCandidates(orderedRemaining, history, roundIndex, totalRounds);
            const limitedCandidates = candidates.slice(0, matchIndex === 0 ? MAX_MATCH_CANDIDATES_FIRST : MAX_MATCH_CANDIDATES_NEXT);
            limitedCandidates.forEach((candidate) => {
                nextStates.push({
                    remaining: removePlayers(state.remaining, candidate.players.map((player) => player.id)),
                    matches: [...state.matches, candidate],
                    score: state.score + candidate.baseScore,
                    minBaseScore: Math.min(state.minBaseScore, candidate.baseScore),
                });
            });
        });
        if (nextStates.length === 0) {
            return buildFallbackMatches(players, history, roundIndex, totalRounds);
        }
        states = nextStates
            .sort((left, right) => {
            const rankingGap = getStateRankingScore(right.score, right.minBaseScore)
                - getStateRankingScore(left.score, left.minBaseScore);
            if (rankingGap !== 0)
                return rankingGap;
            return right.score - left.score;
        })
            .slice(0, MAX_BEAM_STATES);
    }
    const bestCompleted = states.find((state) => state.remaining.length === 0);
    if (bestCompleted)
        return bestCompleted.matches;
    return states[0]?.matches.length ? states[0].matches : buildFallbackMatches(players, history, roundIndex, totalRounds);
}
function materializeMatch(draft, court, courtIndex, history, roundIndex, matchIndex, totalRounds, totalPlayers, courtsCount) {
    const progressRatio = getRoundProgress(roundIndex, totalRounds);
    const courtRepeatPressure = getNormalizedCourtPressure(draft.players, courtIndex, history, roundIndex, courtsCount);
    const qualityScore = clampNumber(100
        - getQualityPartnerPenalty(draft.summary.partnerRepeatCount, progressRatio)
        - getQualityOpponentPenalty(draft.summary.opponentRepeatCount, progressRatio, totalPlayers)
        - getQualityBalancePenalty(draft.summary.balanceGap)
        - courtRepeatPressure * 5, 18, 100);
    return {
        id: `round-${roundIndex + 1}-match-${matchIndex + 1}`,
        court,
        courtIndex,
        pair1: [draft.pair1[0], draft.pair1[1]],
        pair2: [draft.pair2[0], draft.pair2[1]],
        score1: null,
        score2: null,
        saved: false,
        quality: {
            score: roundTo(qualityScore, 1),
            label: getCourtQualityLabel(qualityScore),
            explanation: buildMatchExplanation(draft.summary, courtRepeatPressure),
            partnerRepeatCount: draft.summary.partnerRepeatCount,
            opponentRepeatCount: draft.summary.opponentRepeatCount,
            balanceGap: draft.summary.balanceGap,
            courtRepeatPressure,
        },
        summary: draft.summary,
    };
}
function assignCourts(drafts, courts, history, roundIndex, totalRounds, totalPlayers) {
    const freeCourts = courts.map((court, index) => ({ court, index }));
    const assignedMatches = [];
    const orderedDrafts = [...drafts].sort((left, right) => ((left.summary.partnerRepeatCount + left.summary.opponentRepeatCount) - (right.summary.partnerRepeatCount + right.summary.opponentRepeatCount)));
    orderedDrafts.forEach((draft, matchIndex) => {
        const bestCourt = [...freeCourts].sort((left, right) => {
            const leftPressure = getNormalizedCourtPressure(draft.players, left.index, history, roundIndex, courts.length);
            const rightPressure = getNormalizedCourtPressure(draft.players, right.index, history, roundIndex, courts.length);
            if (leftPressure !== rightPressure)
                return leftPressure - rightPressure;
            return left.index - right.index;
        })[0];
        if (!bestCourt)
            return;
        assignedMatches.push(materializeMatch(draft, bestCourt.court, bestCourt.index, history, roundIndex, matchIndex, totalRounds, totalPlayers, courts.length));
        const freeIndex = freeCourts.findIndex((item) => item.index === bestCourt.index);
        if (freeIndex >= 0) {
            freeCourts.splice(freeIndex, 1);
        }
    });
    return assignedMatches.sort((left, right) => left.courtIndex - right.courtIndex);
}
function buildRoundQuality(matches, byes) {
    const scores = matches.map((match) => match.quality.score);
    const averageCourtScore = scores.length
        ? roundTo(scores.reduce((sum, score) => sum + score, 0) / scores.length, 1)
        : 0;
    const minCourtScore = scores.length ? roundTo(Math.min(...scores), 1) : 0;
    const roundScore = roundTo(clampNumber(averageCourtScore * 0.78 + minCourtScore * 0.22 - byes.length, 0, 100), 1);
    return {
        score: roundScore,
        label: getCourtQualityLabel(roundScore),
        explanation: byes.length > 0
            ? `${matches.length} матч. · bye: ${byes.length}`
            : `${matches.length} матч.`,
        averageCourtScore,
        minCourtScore,
        byeCount: byes.length,
    };
}
function applyRoundToHistory(round, history) {
    round.matches.forEach((match) => {
        const pair1Ids = match.pair1.map((player) => player.id);
        const pair2Ids = match.pair2.map((player) => player.id);
        if (pair1Ids.length === 2) {
            const partnerKey = makePairKey(pair1Ids[0], pair1Ids[1]);
            history.partnerCounts.set(partnerKey, (history.partnerCounts.get(partnerKey) ?? 0) + 1);
        }
        if (pair2Ids.length === 2) {
            const partnerKey = makePairKey(pair2Ids[0], pair2Ids[1]);
            history.partnerCounts.set(partnerKey, (history.partnerCounts.get(partnerKey) ?? 0) + 1);
        }
        pair1Ids.forEach((leftId) => {
            pair2Ids.forEach((rightId) => {
                const opponentKey = makeOpponentKey(leftId, rightId);
                history.opponentCounts.set(opponentKey, (history.opponentCounts.get(opponentKey) ?? 0) + 1);
            });
        });
        [...pair1Ids, ...pair2Ids].forEach((playerId) => {
            const courtCounts = history.courtCounts.get(playerId) ?? [];
            courtCounts[match.courtIndex] = (courtCounts[match.courtIndex] ?? 0) + 1;
            history.courtCounts.set(playerId, courtCounts);
        });
    });
}
export function createAmericanoRounds(participants, courts) {
    const players = normalizeParticipants(participants);
    if (players.length < 4 || courts.length === 0)
        return [];
    const matchesPerRound = Math.min(courts.length, Math.floor(players.length / 4));
    if (matchesPerRound < 1)
        return [];
    const activePlayersCount = matchesPerRound * 4;
    const byeCount = Math.max(0, players.length - activePlayersCount);
    const roundCount = players.length % 2 === 0 ? players.length - 1 : players.length;
    const history = createHistory(players, courts);
    const rounds = [];
    for (let roundIndex = 0; roundIndex < roundCount; roundIndex += 1) {
        const byes = selectByePlayers(players, byeCount, history);
        const byeIds = new Set(byes.map((player) => player.id));
        const activePlayers = players.filter((player) => !byeIds.has(player.id));
        const drafts = planRoundMatches(activePlayers, history, roundIndex, roundCount);
        const matches = assignCourts(drafts, courts, history, roundIndex, roundCount, players.length);
        const round = {
            id: `round-${roundIndex + 1}`,
            index: roundIndex + 1,
            matches,
            byes,
            collapsed: roundIndex !== 0,
            saved: false,
            quality: buildRoundQuality(matches, byes),
        };
        rounds.push(round);
        applyRoundToHistory(round, history);
        byes.forEach((player) => {
            const prev = history.byeCounts.get(player.id) ?? { count: 0, lastRound: null };
            history.byeCounts.set(player.id, {
                count: prev.count + 1,
                lastRound: roundIndex,
            });
        });
    }
    return rounds;
}
function resolveParticipantFromValue(value, participantMap, fallbackIndex) {
    if (typeof value === "string" || typeof value === "number") {
        const key = String(value);
        const direct = participantMap.get(key);
        if (direct)
            return direct;
        return {
            id: key,
            name: `Участник ${fallbackIndex + 1}`,
            photo: null,
            phone: null,
            spot: null,
            rating: null,
            ratingValue: DEFAULT_RATING,
            seed: fallbackIndex,
        };
    }
    if (value && typeof value === "object") {
        const record = value;
        const id = String(record.id ?? record.phone ?? `participant-${fallbackIndex}`);
        const direct = participantMap.get(id);
        if (direct)
            return direct;
        return {
            id,
            name: typeof record.name === "string" && record.name.trim() ? record.name.trim() : `Участник ${fallbackIndex + 1}`,
            photo: typeof record.photo === "string" ? record.photo : null,
            phone: typeof record.phone === "string" ? record.phone : null,
            spot: null,
            rating: typeof record.rating === "string" ? record.rating : null,
            ratingValue: parseTournamentRatingValue(typeof record.rating === "string" || typeof record.rating === "number" ? record.rating : null) ?? DEFAULT_RATING,
            seed: fallbackIndex,
        };
    }
    return {
        id: `participant-${fallbackIndex}`,
        name: `Участник ${fallbackIndex + 1}`,
        photo: null,
        phone: null,
        spot: null,
        rating: null,
        ratingValue: DEFAULT_RATING,
        seed: fallbackIndex,
    };
}
function inferRoundByes(round, matches, participants, participantMap) {
    const explicitByes = Array.isArray(round.byes) ? round.byes : null;
    if (explicitByes) {
        return explicitByes.map((value, index) => resolveParticipantFromValue(value, participantMap, index));
    }
    const activeIds = new Set();
    matches.forEach((match) => {
        match.pair1.forEach((player) => activeIds.add(player.id));
        match.pair2.forEach((player) => activeIds.add(player.id));
    });
    return participants.filter((player) => !activeIds.has(player.id));
}
export function hydrateAmericanoRounds(rawRounds, participants, courts) {
    if (!Array.isArray(rawRounds) || rawRounds.length === 0) {
        return createAmericanoRounds(participants, courts);
    }
    const ratedParticipants = normalizeParticipants(participants);
    const participantMap = new Map();
    ratedParticipants.forEach((participant) => {
        participantMap.set(participant.id, participant);
        if (participant.phone)
            participantMap.set(participant.phone, participant);
    });
    const history = createHistory(ratedParticipants, courts);
    const normalizedRounds = [];
    const sortedRawRounds = [...rawRounds]
        .filter((value) => Boolean(value) && typeof value === "object")
        .sort((left, right) => safeNumber(left.index, 0) - safeNumber(right.index, 0));
    sortedRawRounds.forEach((rawRound, roundIndex) => {
        const rawMatches = Array.isArray(rawRound.matches) ? rawRound.matches : [];
        const matches = rawMatches
            .map((value, matchIndex) => {
            if (!value || typeof value !== "object")
                return null;
            const record = value;
            const pair1Values = Array.isArray(record.pair1) ? record.pair1 : [];
            const pair2Values = Array.isArray(record.pair2) ? record.pair2 : [];
            const pair1 = pair1Values.map((item, index) => resolveParticipantFromValue(item, participantMap, index));
            const pair2 = pair2Values.map((item, index) => resolveParticipantFromValue(item, participantMap, pair1.length + index));
            if (pair1.length < 2 || pair2.length < 2)
                return null;
            const courtName = typeof record.court === "string" && record.court.trim()
                ? record.court.trim()
                : courts[matchIndex] ?? `Корт №${matchIndex + 1}`;
            const courtIndex = clampNumber(safeNumber(record.courtIndex, courts.findIndex((court) => court === courtName)), 0, Math.max(courts.length - 1, 0));
            const draft = evaluateMatchDraft([pair1[0], pair1[1]], [pair2[0], pair2[1]], history, roundIndex, sortedRawRounds.length);
            const match = materializeMatch(draft, courtName, courtIndex, history, roundIndex, matchIndex, sortedRawRounds.length, ratedParticipants.length, courts.length);
            match.id = typeof record.id === "string" && record.id.trim()
                ? record.id.trim()
                : `round-${roundIndex + 1}-match-${matchIndex + 1}`;
            match.score1 = record.score1 == null ? null : safeNumber(record.score1, 0);
            match.score2 = record.score2 == null ? null : safeNumber(record.score2, 0);
            match.saved = match.score1 != null && match.score2 != null;
            return match;
        })
            .filter((value) => Boolean(value));
        const byes = inferRoundByes(rawRound, matches, ratedParticipants, participantMap);
        const round = {
            id: typeof rawRound.id === "string" && rawRound.id.trim()
                ? rawRound.id.trim()
                : `round-${roundIndex + 1}`,
            index: safeNumber(rawRound.index, roundIndex + 1),
            matches,
            byes,
            collapsed: rawRound.collapsed === true ? true : roundIndex !== 0,
            saved: matches.length > 0 && matches.every((match) => match.saved),
            quality: buildRoundQuality(matches, byes),
        };
        normalizedRounds.push(round);
        applyRoundToHistory(round, history);
        byes.forEach((player) => {
            const prev = history.byeCounts.get(player.id) ?? { count: 0, lastRound: null };
            history.byeCounts.set(player.id, {
                count: prev.count + 1,
                lastRound: roundIndex,
            });
        });
    });
    return normalizedRounds.length > 0 ? normalizedRounds : createAmericanoRounds(participants, courts);
}
export function serializeAmericanoRounds(rounds) {
    return rounds.map((round) => ({
        id: round.id,
        index: round.index,
        byes: round.byes.map((player) => player.id),
        quality: round.quality,
        matches: round.matches.map((match) => ({
            id: match.id,
            court: match.court,
            courtIndex: match.courtIndex,
            pair1: match.pair1.map((player) => player.id),
            pair2: match.pair2.map((player) => player.id),
            score1: match.score1,
            score2: match.score2,
            quality: match.quality,
            summary: match.summary,
        })),
    }));
}
export function buildAmericanoStandings(participants, rounds, serverTotals) {
    const rowsMap = new Map();
    const normalizedParticipants = normalizeParticipants(participants);
    normalizedParticipants.forEach((participant) => {
        const total = serverTotals?.[participant.id];
        rowsMap.set(participant.id, {
            id: participant.id,
            name: participant.name,
            photo: participant.photo ?? null,
            rank: 0,
            matchesPlayed: 0,
            wins: 0,
            losses: 0,
            draws: 0,
            byeCount: 0,
            byePoints: 0,
            playedPoints: 0,
            totalPoints: 0,
            pointsFor: 0,
            pointsAgainst: 0,
            pointDiff: 0,
            ratingBefore: total?.ratingBefore ?? null,
            ratingAfter: total?.ratingAfter ?? null,
            ratingDelta: safeNumber(total?.deltaTotal, 0),
            hasServerTotals: Boolean(total),
        });
    });
    const roundByePoints = {};
    let totalMatches = 0;
    let completedMatches = 0;
    let completedRounds = 0;
    rounds.forEach((round) => {
        let roundPlayedPoints = 0;
        let roundActivePlayers = 0;
        const roundCompleted = round.matches.length > 0 && round.matches.every((match) => (match.pair1.length === 2
            && match.pair2.length === 2
            && match.score1 != null
            && match.score2 != null));
        totalMatches += round.matches.length;
        round.matches.forEach((match) => {
            if (match.pair1.length !== 2 || match.pair2.length !== 2)
                return;
            roundActivePlayers += match.pair1.length + match.pair2.length;
            if (match.score1 == null || match.score2 == null)
                return;
            completedMatches += 1;
            const pair1Result = match.score1 > match.score2 ? "win" : match.score1 < match.score2 ? "loss" : "draw";
            const pair2Result = match.score2 > match.score1 ? "win" : match.score2 < match.score1 ? "loss" : "draw";
            match.pair1.forEach((player) => {
                const row = rowsMap.get(player.id);
                if (!row)
                    return;
                row.matchesPlayed += 1;
                row.pointsFor += match.score1 ?? 0;
                row.pointsAgainst += match.score2 ?? 0;
                row.playedPoints += match.score1 ?? 0;
                if (pair1Result === "win")
                    row.wins += 1;
                else if (pair1Result === "loss")
                    row.losses += 1;
                else
                    row.draws += 1;
            });
            match.pair2.forEach((player) => {
                const row = rowsMap.get(player.id);
                if (!row)
                    return;
                row.matchesPlayed += 1;
                row.pointsFor += match.score2 ?? 0;
                row.pointsAgainst += match.score1 ?? 0;
                row.playedPoints += match.score2 ?? 0;
                if (pair2Result === "win")
                    row.wins += 1;
                else if (pair2Result === "loss")
                    row.losses += 1;
                else
                    row.draws += 1;
            });
            roundPlayedPoints += (match.score1 ?? 0) * match.pair1.length;
            roundPlayedPoints += (match.score2 ?? 0) * match.pair2.length;
        });
        if (roundCompleted) {
            completedRounds += 1;
        }
        const byePoints = roundCompleted && round.byes.length > 0 && roundActivePlayers > 0
            ? roundTo(roundPlayedPoints / roundActivePlayers, 2)
            : null;
        roundByePoints[round.id] = byePoints;
        round.byes.forEach((player) => {
            const row = rowsMap.get(player.id);
            if (!row)
                return;
            row.byeCount += 1;
            if (byePoints != null) {
                row.byePoints += byePoints;
            }
        });
    });
    const rows = [...rowsMap.values()]
        .map((row) => {
        const total = serverTotals?.[row.id];
        const pointsFor = total?.pointsFor != null ? safeNumber(total.pointsFor, row.pointsFor) : row.pointsFor;
        const pointsAgainst = total?.pointsAgainst != null ? safeNumber(total.pointsAgainst, row.pointsAgainst) : row.pointsAgainst;
        const wins = total?.wins != null ? safeNumber(total.wins, row.wins) : row.wins;
        const losses = total?.losses != null ? safeNumber(total.losses, row.losses) : row.losses;
        const draws = total?.draws != null ? safeNumber(total.draws, row.draws) : row.draws;
        const playedPoints = total?.playedPoints != null
            ? safeNumber(total.playedPoints, row.playedPoints)
            : pointsFor;
        const totalPoints = total?.tournamentPoints != null
            ? safeNumber(total.tournamentPoints, playedPoints + row.byePoints)
            : playedPoints + row.byePoints;
        const byePoints = total?.byePoints != null ? safeNumber(total.byePoints, row.byePoints) : row.byePoints;
        const byeCount = total?.byeCount != null ? safeNumber(total.byeCount, row.byeCount) : row.byeCount;
        return {
            ...row,
            wins,
            losses,
            draws,
            pointsFor,
            pointsAgainst,
            playedPoints: roundTo(playedPoints, 2),
            byePoints: roundTo(byePoints, 2),
            byeCount,
            totalPoints: roundTo(totalPoints, 2),
            pointDiff: roundTo(total?.pointDiff != null ? safeNumber(total.pointDiff, pointsFor - pointsAgainst) : pointsFor - pointsAgainst, 2),
            ratingBefore: total?.ratingBefore ?? row.ratingBefore,
            ratingAfter: total?.ratingAfter ?? row.ratingAfter,
            ratingDelta: roundTo(total?.deltaTotal != null ? safeNumber(total.deltaTotal, row.ratingDelta) : row.ratingDelta, 5),
            hasServerTotals: Boolean(total),
        };
    })
        .sort((left, right) => {
        if (right.totalPoints !== left.totalPoints)
            return right.totalPoints - left.totalPoints;
        if (right.pointDiff !== left.pointDiff)
            return right.pointDiff - left.pointDiff;
        if (right.wins !== left.wins)
            return right.wins - left.wins;
        if (right.pointsFor !== left.pointsFor)
            return right.pointsFor - left.pointsFor;
        if (right.ratingDelta !== left.ratingDelta)
            return right.ratingDelta - left.ratingDelta;
        return left.name.localeCompare(right.name, "ru");
    })
        .map((row, index) => ({
        ...row,
        rank: index + 1,
    }));
    return {
        rows,
        roundByePoints,
        totalRounds: rounds.length,
        completedRounds,
        totalMatches,
        completedMatches,
        byePolicy: BYE_POLICY,
    };
}
