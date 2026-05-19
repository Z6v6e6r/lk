import {
  parseTournamentRatingValue,
  type AmericanoLabParticipant,
  type AmericanoLabRound,
} from "./americanoLab.ts";

export type MexicanoByeMode = "strict" | "rotating_bye";
export type MexicanoFirstRoundMode = "random" | "by_level";

export type MexicanoPenaltyWeights = {
  repeatedPartner: number;
  repeatedPairVsPair: number;
  repeatedOpponent: number;
  groupSpread: number;
  crossGroupSwap: number;
  sameCourtRepeat: number;
  consecutiveBye: number;
};

export type MexicanoClassicOptions = {
  totalRounds?: number;
  firstRoundMode?: MexicanoFirstRoundMode;
  byeMode?: MexicanoByeMode;
  seed?: string | number;
  penaltyWeights?: Partial<MexicanoPenaltyWeights>;
};

type RatedParticipant = AmericanoLabParticipant & {
  id: string;
  name: string;
  ratingValue: number;
  seed: number;
};

type MatchDraft = {
  pair1: [RankedPlayer, RankedPlayer];
  pair2: [RankedPlayer, RankedPlayer];
  scheme: "classic_13_vs_24" | "balance_14_vs_23";
  schemeLabel: "1+3 vs 2+4" | "1+4 vs 2+3";
  basePenalty: number;
  partnerRepeatCount: number;
  opponentRepeatCount: number;
  pairVsPairRepeatCount: number;
  groupSpread: number;
  ratingGap: number;
  replacementReasons: string[];
};

type RankedPlayer = {
  participant: RatedParticipant;
  rank: number;
  totalPoints: number;
  pointsAgainst: number;
  pointDiff: number;
  wins: number;
  matchesPlayed: number;
  byesTotal: number;
  byesStreak: number;
};

type PlayerStat = {
  totalPoints: number;
  pointsAgainst: number;
  pointDiff: number;
  wins: number;
  losses: number;
  draws: number;
  matchesPlayed: number;
  byesTotal: number;
  byesStreak: number;
  lastCourtIndex: number | null;
};

type HeadToHeadEntry = {
  leftId: string;
  rightId: string;
  matchesPlayed: number;
  leftWins: number;
  rightWins: number;
  leftPointsFor: number;
  rightPointsFor: number;
};

type MexicanoHistoryContext = {
  statsById: Map<string, PlayerStat>;
  partnerCounts: Map<string, number>;
  opponentCounts: Map<string, number>;
  pairVsPairCounts: Map<string, number>;
  headToHeadMap: Map<string, HeadToHeadEntry>;
};

const DEFAULT_RATING = 3.5;
const DEFAULT_TOTAL_ROUNDS_MIN = 5;
const DEFAULT_TOTAL_ROUNDS_FALLBACK = 8;
const DEFAULT_MIN_ROUNDS_BEFORE_FINISH = 5;

const DEFAULT_PENALTY_WEIGHTS: MexicanoPenaltyWeights = {
  repeatedPartner: 100,
  repeatedPairVsPair: 80,
  repeatedOpponent: 30,
  groupSpread: 50,
  crossGroupSwap: 20,
  sameCourtRepeat: 5,
  consecutiveBye: 1000,
};

const clampNumber = (value: number, min: number, max: number) => Math.max(min, Math.min(max, value));
const roundTo = (value: number, digits = 2) => Number(value.toFixed(digits));

function getCourtQualityLabel(score: number) {
  if (score >= 90) return "Высокое";
  if (score >= 75) return "Хорошее";
  if (score >= 60) return "Нормальное";
  return "Риск повторов";
}

function parseInteger(value: unknown, fallback = 0) {
  const parsed = typeof value === "number" ? value : Number(value);
  return Number.isFinite(parsed) ? Math.trunc(parsed) : fallback;
}

function isRoundCompleted(round: AmericanoLabRound) {
  return round.matches.length > 0 && round.matches.every((match) => match.score1 != null && match.score2 != null);
}

function normalizeParticipants(participants: AmericanoLabParticipant[]): RatedParticipant[] {
  return participants.map((participant, index) => ({
    ...participant,
    id: String(participant.id || participant.phone || `participant-${index}`),
    name: participant.name || `Участник ${index + 1}`,
    ratingValue: parseTournamentRatingValue(participant.rating) ?? DEFAULT_RATING,
    seed: index,
  }));
}

function makePairKey(leftId: string, rightId: string) {
  return [leftId, rightId].sort().join("::");
}

function makePairVsPairKey(pair1: [string, string], pair2: [string, string]) {
  const first = makePairKey(pair1[0], pair1[1]);
  const second = makePairKey(pair2[0], pair2[1]);
  return [first, second].sort().join("||");
}

function makeHeadToHeadEntryKey(leftId: string, rightId: string) {
  return [leftId, rightId].sort().join("::");
}

function makeSeedHash(seed: string | number | undefined, suffix = "") {
  const input = `${String(seed ?? "mexicano")}:${suffix}`;
  let hash = 2166136261;
  for (let index = 0; index < input.length; index += 1) {
    hash ^= input.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return hash >>> 0;
}

function createSeededRng(seed: number) {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6D2B79F5) >>> 0;
    let mixed = Math.imul(state ^ (state >>> 15), state | 1);
    mixed ^= mixed + Math.imul(mixed ^ (mixed >>> 7), mixed | 61);
    return ((mixed ^ (mixed >>> 14)) >>> 0) / 4294967296;
  };
}

function seededShuffle<T>(list: T[], seed: string | number | undefined, suffix = "") {
  const rng = createSeededRng(makeSeedHash(seed, suffix));
  const copy = [...list];
  for (let index = copy.length - 1; index > 0; index -= 1) {
    const nextIndex = Math.floor(rng() * (index + 1));
    [copy[index], copy[nextIndex]] = [copy[nextIndex], copy[index]];
  }
  return copy;
}

function getDeterministicTieBreaker(seed: string | number | undefined, playerId: string) {
  return makeSeedHash(seed, playerId);
}

function buildEmptyStatsMap(players: RatedParticipant[]) {
  const map = new Map<string, PlayerStat>();
  players.forEach((player) => {
    map.set(player.id, {
      totalPoints: 0,
      pointsAgainst: 0,
      pointDiff: 0,
      wins: 0,
      losses: 0,
      draws: 0,
      matchesPlayed: 0,
      byesTotal: 0,
      byesStreak: 0,
      lastCourtIndex: null,
    });
  });
  return map;
}

function inferRoundByes(round: AmericanoLabRound, players: RatedParticipant[]) {
  if (Array.isArray(round.byes) && round.byes.length > 0) {
    const byesById = new Set(round.byes.map((player) => player.id));
    return players.filter((player) => byesById.has(player.id));
  }

  const activeIds = new Set<string>();
  round.matches.forEach((match) => {
    match.pair1.forEach((player) => activeIds.add(player.id));
    match.pair2.forEach((player) => activeIds.add(player.id));
  });

  return players.filter((player) => !activeIds.has(player.id));
}

function updateHeadToHeadEntry(
  headToHeadMap: Map<string, HeadToHeadEntry>,
  leftId: string,
  rightId: string,
  leftScore: number,
  rightScore: number,
) {
  const [entryLeftId, entryRightId] = leftId < rightId
    ? [leftId, rightId]
    : [rightId, leftId];
  const key = makeHeadToHeadEntryKey(entryLeftId, entryRightId);
  const entry = headToHeadMap.get(key) ?? {
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

  headToHeadMap.set(key, entry);
}

function compareByHeadToHead(
  left: RankedPlayer,
  right: RankedPlayer,
  headToHeadMap: Map<string, HeadToHeadEntry>,
) {
  const key = makeHeadToHeadEntryKey(left.participant.id, right.participant.id);
  const entry = headToHeadMap.get(key);
  if (!entry || entry.matchesPlayed === 0) return 0;

  const leftWins = left.participant.id === entry.leftId ? entry.leftWins : entry.rightWins;
  const rightWins = left.participant.id === entry.leftId ? entry.rightWins : entry.leftWins;
  if (leftWins !== rightWins) return rightWins - leftWins;

  const leftPointsFor = left.participant.id === entry.leftId ? entry.leftPointsFor : entry.rightPointsFor;
  const rightPointsFor = left.participant.id === entry.leftId ? entry.rightPointsFor : entry.leftPointsFor;
  if (leftPointsFor !== rightPointsFor) return rightPointsFor - leftPointsFor;

  return 0;
}

function buildHistoryContext(
  players: RatedParticipant[],
  sourceRounds: AmericanoLabRound[],
) {
  const statsById = buildEmptyStatsMap(players);
  const partnerCounts = new Map<string, number>();
  const opponentCounts = new Map<string, number>();
  const pairVsPairCounts = new Map<string, number>();
  const headToHeadMap = new Map<string, HeadToHeadEntry>();

  const sortedRounds = [...sourceRounds]
    .filter((round) => round && round.matches.length > 0)
    .sort((left, right) => left.index - right.index);

  sortedRounds.forEach((round) => {
    const activeIds = new Set<string>();

    round.matches.forEach((match) => {
      const pair1Ids = match.pair1.map((player) => player.id).filter(Boolean);
      const pair2Ids = match.pair2.map((player) => player.id).filter(Boolean);
      if (pair1Ids.length !== 2 || pair2Ids.length !== 2) return;

      pair1Ids.forEach((id) => activeIds.add(id));
      pair2Ids.forEach((id) => activeIds.add(id));

      const pair1Key = makePairKey(pair1Ids[0], pair1Ids[1]);
      const pair2Key = makePairKey(pair2Ids[0], pair2Ids[1]);
      partnerCounts.set(pair1Key, (partnerCounts.get(pair1Key) ?? 0) + 1);
      partnerCounts.set(pair2Key, (partnerCounts.get(pair2Key) ?? 0) + 1);

      const pairVsPairKey = makePairVsPairKey(
        [pair1Ids[0], pair1Ids[1]],
        [pair2Ids[0], pair2Ids[1]],
      );
      pairVsPairCounts.set(pairVsPairKey, (pairVsPairCounts.get(pairVsPairKey) ?? 0) + 1);

      pair1Ids.forEach((leftId) => {
        pair2Ids.forEach((rightId) => {
          const opponentKey = makePairKey(leftId, rightId);
          opponentCounts.set(opponentKey, (opponentCounts.get(opponentKey) ?? 0) + 1);
        });
      });

      [...pair1Ids, ...pair2Ids].forEach((playerId) => {
        const stat = statsById.get(playerId);
        if (!stat) return;
        stat.lastCourtIndex = match.courtIndex;
      });

      if (match.score1 == null || match.score2 == null) return;

      const score1 = parseInteger(match.score1, 0);
      const score2 = parseInteger(match.score2, 0);

      pair1Ids.forEach((playerId) => {
        const stat = statsById.get(playerId);
        if (!stat) return;
        stat.totalPoints += score1;
        stat.pointsAgainst += score2;
        stat.pointDiff += score1 - score2;
        stat.matchesPlayed += 1;
        if (score1 > score2) stat.wins += 1;
        else if (score1 < score2) stat.losses += 1;
        else stat.draws += 1;
      });

      pair2Ids.forEach((playerId) => {
        const stat = statsById.get(playerId);
        if (!stat) return;
        stat.totalPoints += score2;
        stat.pointsAgainst += score1;
        stat.pointDiff += score2 - score1;
        stat.matchesPlayed += 1;
        if (score2 > score1) stat.wins += 1;
        else if (score2 < score1) stat.losses += 1;
        else stat.draws += 1;
      });

      match.pair1.forEach((pair1Player) => {
        match.pair2.forEach((pair2Player) => {
          updateHeadToHeadEntry(
            headToHeadMap,
            pair1Player.id,
            pair2Player.id,
            score1,
            score2,
          );
        });
      });
    });

    const byeIds = new Set(inferRoundByes(round, players).map((player) => player.id));
    players.forEach((player) => {
      const stat = statsById.get(player.id);
      if (!stat) return;
      if (activeIds.has(player.id)) {
        stat.byesStreak = 0;
        return;
      }
      if (byeIds.has(player.id)) {
        stat.byesTotal += 1;
        stat.byesStreak += 1;
      }
    });
  });

  return {
    statsById,
    partnerCounts,
    opponentCounts,
    pairVsPairCounts,
    headToHeadMap,
  } satisfies MexicanoHistoryContext;
}

function rankPlayersByTable(
  players: RatedParticipant[],
  context: MexicanoHistoryContext,
  seed: string | number | undefined,
) {
  const rows: RankedPlayer[] = players.map((player) => {
    const stat = context.statsById.get(player.id);
    return {
      participant: player,
      rank: 0,
      totalPoints: stat?.totalPoints ?? 0,
      pointsAgainst: stat?.pointsAgainst ?? 0,
      pointDiff: stat?.pointDiff ?? 0,
      wins: stat?.wins ?? 0,
      matchesPlayed: stat?.matchesPlayed ?? 0,
      byesTotal: stat?.byesTotal ?? 0,
      byesStreak: stat?.byesStreak ?? 0,
    };
  });

  rows.sort((left, right) => {
    if (right.pointDiff !== left.pointDiff) return right.pointDiff - left.pointDiff;
    if (right.totalPoints !== left.totalPoints) return right.totalPoints - left.totalPoints;
    if (right.wins !== left.wins) return right.wins - left.wins;

    const headToHeadCompare = compareByHeadToHead(left, right, context.headToHeadMap);
    if (headToHeadCompare !== 0) return headToHeadCompare;

    if (right.participant.ratingValue !== left.participant.ratingValue) {
      return right.participant.ratingValue - left.participant.ratingValue;
    }
    if (left.participant.seed !== right.participant.seed) {
      return left.participant.seed - right.participant.seed;
    }
    const leftTie = getDeterministicTieBreaker(seed, left.participant.id);
    const rightTie = getDeterministicTieBreaker(seed, right.participant.id);
    if (leftTie !== rightTie) return leftTie - rightTie;
    return left.participant.id.localeCompare(right.participant.id, "ru");
  });

  return rows.map((row, index) => ({ ...row, rank: index + 1 }));
}

function resolveTotalRounds(playersCount: number, explicitRounds?: number | null) {
  void playersCount;
  const normalizedExplicit = explicitRounds == null ? null : parseInteger(explicitRounds, 0);
  if (normalizedExplicit && normalizedExplicit > 0) {
    return Math.max(normalizedExplicit, DEFAULT_TOTAL_ROUNDS_MIN);
  }

  return DEFAULT_TOTAL_ROUNDS_FALLBACK;
}

function resolvePenaltyWeights(override?: Partial<MexicanoPenaltyWeights>) {
  return {
    ...DEFAULT_PENALTY_WEIGHTS,
    ...(override ?? {}),
  };
}

function splitByesAndActivePlayers(
  rankedPlayers: RankedPlayer[],
  byeCount: number,
  byeMode: MexicanoByeMode,
  seed: string | number | undefined,
) {
  if (byeCount <= 0) {
    return {
      byes: [] as RankedPlayer[],
      active: rankedPlayers,
      byeReason: "без bye",
    };
  }

  if (byeMode === "strict") {
    throw new Error("Для strict-режима количество игроков должно делиться на 4.");
  }

  const sorted = [...rankedPlayers].sort((left, right) => {
    if (left.byesTotal !== right.byesTotal) return left.byesTotal - right.byesTotal;
    const leftConsecutive = left.byesStreak > 0 ? 1 : 0;
    const rightConsecutive = right.byesStreak > 0 ? 1 : 0;
    if (leftConsecutive !== rightConsecutive) return leftConsecutive - rightConsecutive;
    if (right.matchesPlayed !== left.matchesPlayed) return right.matchesPlayed - left.matchesPlayed;
    if (left.totalPoints !== right.totalPoints) return left.totalPoints - right.totalPoints;
    const leftTie = getDeterministicTieBreaker(seed, left.participant.id);
    const rightTie = getDeterministicTieBreaker(seed, right.participant.id);
    if (leftTie !== rightTie) return leftTie - rightTie;
    return left.participant.seed - right.participant.seed;
  });

  const withoutConsecutive = sorted.filter((player) => player.byesStreak === 0);
  const byes = withoutConsecutive.length >= byeCount
    ? withoutConsecutive.slice(0, byeCount)
    : [...withoutConsecutive, ...sorted.filter((player) => player.byesStreak > 0)].slice(0, byeCount);

  const byeIds = new Set(byes.map((player) => player.participant.id));
  const active = rankedPlayers.filter((player) => !byeIds.has(player.participant.id));
  const byeReason = byes
    .map((player) => `#${player.rank} ${player.participant.name} (bye=${player.byesTotal}, streak=${player.byesStreak})`)
    .join(", ");

  return { byes, active, byeReason };
}

function chunkPlayers(players: RankedPlayer[]) {
  const groups: RankedPlayer[][] = [];
  for (let index = 0; index < players.length; index += 4) {
    groups.push(players.slice(index, index + 4));
  }
  return groups.filter((group) => group.length === 4);
}

function evaluateGroupSpread(group: RankedPlayer[]) {
  const totals = group.map((player) => player.totalPoints);
  if (totals.length === 0) return 0;
  return Math.max(...totals) - Math.min(...totals);
}

function evaluatePairingCandidate(
  group: RankedPlayer[],
  pairIndexes: [[number, number], [number, number]],
  scheme: MatchDraft["scheme"],
  schemeLabel: MatchDraft["schemeLabel"],
  context: MexicanoHistoryContext,
  weights: MexicanoPenaltyWeights,
) {
  const pair1 = [group[pairIndexes[0][0]], group[pairIndexes[0][1]]] as [RankedPlayer, RankedPlayer];
  const pair2 = [group[pairIndexes[1][0]], group[pairIndexes[1][1]]] as [RankedPlayer, RankedPlayer];

  const partnerKey1 = makePairKey(pair1[0].participant.id, pair1[1].participant.id);
  const partnerKey2 = makePairKey(pair2[0].participant.id, pair2[1].participant.id);
  const partnerRepeatCount = (context.partnerCounts.get(partnerKey1) ?? 0) + (context.partnerCounts.get(partnerKey2) ?? 0);

  const pairVsPairKey = makePairVsPairKey(
    [pair1[0].participant.id, pair1[1].participant.id],
    [pair2[0].participant.id, pair2[1].participant.id],
  );
  const pairVsPairRepeatCount = context.pairVsPairCounts.get(pairVsPairKey) ?? 0;

  const opponentRepeatCount =
    (context.opponentCounts.get(makePairKey(pair1[0].participant.id, pair2[0].participant.id)) ?? 0)
    + (context.opponentCounts.get(makePairKey(pair1[0].participant.id, pair2[1].participant.id)) ?? 0)
    + (context.opponentCounts.get(makePairKey(pair1[1].participant.id, pair2[0].participant.id)) ?? 0)
    + (context.opponentCounts.get(makePairKey(pair1[1].participant.id, pair2[1].participant.id)) ?? 0);

  const groupSpread = evaluateGroupSpread(group);
  const pairPower1 = teamRatingPower(
    pair1[0].participant.ratingValue,
    pair1[1].participant.ratingValue,
  );
  const pairPower2 = teamRatingPower(
    pair2[0].participant.ratingValue,
    pair2[1].participant.ratingValue,
  );
  const ratingGap = Math.abs(pairPower1 - pairPower2);

  const penalty =
    partnerRepeatCount * weights.repeatedPartner
    + pairVsPairRepeatCount * weights.repeatedPairVsPair
    + opponentRepeatCount * weights.repeatedOpponent
    + groupSpread * weights.groupSpread;

  return {
    pair1,
    pair2,
    scheme,
    schemeLabel,
    basePenalty: penalty,
    partnerRepeatCount,
    opponentRepeatCount,
    pairVsPairRepeatCount,
    groupSpread,
    ratingGap,
    replacementReasons: [],
  } satisfies MatchDraft;
}

function pickBestPairingForGroup(
  group: RankedPlayer[],
  context: MexicanoHistoryContext,
  weights: MexicanoPenaltyWeights,
) {
  const selected = evaluatePairingCandidate(
    group,
    [[0, 2], [1, 3]],
    "classic_13_vs_24",
    "1+3 vs 2+4",
    context,
    weights,
  );
  return {
    ...selected,
    replacementReasons: [],
  };
}

function optimizeAdjacentGroups(
  groups: RankedPlayer[][],
  _context: MexicanoHistoryContext,
  _weights: MexicanoPenaltyWeights,
) {
  return groups.map((group) => [...group]);
}

function teamRatingPower(left: number, right: number) {
  const sum = left + right;
  if (sum <= 0) return DEFAULT_RATING;
  return (left * left + right * right) / sum;
}

function buildRoundQuality(matches: AmericanoLabRound["matches"], byes: AmericanoLabParticipant[], explanation: string) {
  const scores = matches.map((match) => match.quality.score);
  const averageCourtScore = scores.length
    ? roundTo(scores.reduce((sum, score) => sum + score, 0) / scores.length, 1)
    : 0;
  const minCourtScore = scores.length ? roundTo(Math.min(...scores), 1) : 0;
  const roundScore = roundTo(
    clampNumber(averageCourtScore * 0.78 + minCourtScore * 0.22 - byes.length, 0, 100),
    1,
  );

  return {
    score: roundScore,
    label: getCourtQualityLabel(roundScore),
    explanation,
    averageCourtScore,
    minCourtScore,
    byeCount: byes.length,
  };
}

function assignCourtsWithPenalty(
  drafts: MatchDraft[],
  courts: string[],
  context: MexicanoHistoryContext,
  weights: MexicanoPenaltyWeights,
) {
  return drafts.map((draft, draftIndex) => {
    const allPlayers = [
      draft.pair1[0].participant,
      draft.pair1[1].participant,
      draft.pair2[0].participant,
      draft.pair2[1].participant,
    ];
    const assignedCourtIndex = draftIndex;
    const assignedCourtName = courts[draftIndex] || `Корт №${draftIndex + 1}`;
    const sameCourtRepeats = allPlayers.reduce((sum, player) => {
      const stat = context.statsById.get(player.id);
      return sum + (stat?.lastCourtIndex === assignedCourtIndex ? 1 : 0);
    }, 0);
    const bestCourtPenalty = sameCourtRepeats * weights.sameCourtRepeat;

    const pairPower1 = teamRatingPower(
      draft.pair1[0].participant.ratingValue,
      draft.pair1[1].participant.ratingValue,
    );
    const pairPower2 = teamRatingPower(
      draft.pair2[0].participant.ratingValue,
      draft.pair2[1].participant.ratingValue,
    );
    const balanceGap = Math.abs(pairPower1 - pairPower2);

    const qualityPenalty =
      draft.partnerRepeatCount * 8
      + draft.opponentRepeatCount * 5
      + draft.pairVsPairRepeatCount * 10
      + draft.groupSpread * 1.2
      + bestCourtPenalty;
    const qualityScore = clampNumber(100 - qualityPenalty, 18, 100);

    const match = {
      id: "",
      court: assignedCourtName,
      courtIndex: assignedCourtIndex,
      pair1: [draft.pair1[0].participant, draft.pair1[1].participant],
      pair2: [draft.pair2[0].participant, draft.pair2[1].participant],
      score1: null,
      score2: null,
      saved: false,
      quality: {
        score: roundTo(qualityScore, 1),
        label: getCourtQualityLabel(qualityScore),
        explanation: [
          `схема: ${draft.schemeLabel}`,
          ...draft.replacementReasons,
          `позиции ${draft.pair1[0].rank}+${draft.pair1[1].rank} vs ${draft.pair2[0].rank}+${draft.pair2[1].rank}`,
          draft.partnerRepeatCount > 0 ? `повторы партнеров: ${draft.partnerRepeatCount}` : "партнеры без повторов",
          draft.opponentRepeatCount > 0 ? `повторы соперников: ${draft.opponentRepeatCount}` : "соперники без повторов",
          draft.pairVsPairRepeatCount > 0 ? `повтор пары-матча: ${draft.pairVsPairRepeatCount}` : "новая пара-дуэль",
          `разброс группы: ${roundTo(draft.groupSpread, 2)}`,
        ].join(" · "),
        partnerRepeatCount: draft.partnerRepeatCount,
        opponentRepeatCount: draft.opponentRepeatCount,
        balanceGap: roundTo(balanceGap, 3),
        courtRepeatPressure: roundTo(bestCourtPenalty, 2),
      },
      summary: {
        pairPower1: roundTo(pairPower1, 3),
        pairPower2: roundTo(pairPower2, 3),
        balanceGap: roundTo(balanceGap, 3),
        partnerRepeatCount: draft.partnerRepeatCount,
        opponentRepeatCount: draft.opponentRepeatCount,
      },
    } satisfies AmericanoLabRound["matches"][number];
    return match;
  });
}

function buildInitialRanking(
  players: RatedParticipant[],
  firstRoundMode: MexicanoFirstRoundMode,
  seed: string | number | undefined,
) {
  const ordered = firstRoundMode === "by_level"
    ? [...players].sort((left, right) => {
      if (right.ratingValue !== left.ratingValue) return right.ratingValue - left.ratingValue;
      if (left.seed !== right.seed) return left.seed - right.seed;
      return left.id.localeCompare(right.id, "ru");
    })
    : seededShuffle(players, seed, "first-round");

  return ordered.map((player, index) => ({
    participant: player,
    rank: index + 1,
    totalPoints: 0,
    pointsAgainst: 0,
    pointDiff: 0,
    wins: 0,
    matchesPlayed: 0,
    byesTotal: 0,
    byesStreak: 0,
  }));
}

function buildMexicanoRoundFromRanking(
  rankedPlayers: RankedPlayer[],
  context: MexicanoHistoryContext,
  roundIndex: number,
  courts: string[],
  byeMode: MexicanoByeMode,
  weights: MexicanoPenaltyWeights,
  seed: string | number | undefined,
  firstRound: boolean,
  firstRoundMode: MexicanoFirstRoundMode,
) {
  const matchesPerRound = Math.min(courts.length, Math.floor(rankedPlayers.length / 4));
  if (matchesPerRound < 1) {
    return null;
  }

  const activePlayersCount = matchesPerRound * 4;
  const byeCount = Math.max(0, rankedPlayers.length - activePlayersCount);
  const { byes, active, byeReason } = splitByesAndActivePlayers(rankedPlayers, byeCount, byeMode, seed);

  const initialGroups = chunkPlayers(active);
  const optimizedGroups = firstRound ? initialGroups : optimizeAdjacentGroups(initialGroups, context, weights);

  const drafts = optimizedGroups.map((group) => pickBestPairingForGroup(group, context, weights));
  const matches = assignCourtsWithPenalty(drafts, courts, context, weights)
    .map((match, matchIndex) => ({
      ...match,
      id: `round-${roundIndex + 1}-match-${matchIndex + 1}`,
    }))
    .sort((left, right) => left.courtIndex - right.courtIndex);

  const groupsSummary = optimizedGroups.map((group, groupIndex) => {
    const label = group.map((player) => `#${player.rank}`).join(", ");
    return `G${groupIndex + 1}: ${label}`;
  }).join(" | ");

  const roundExplanation = [
    firstRound
      ? `стартовый раунд (${firstRoundMode === "random" ? "детерминированная жеребьевка" : "посев по уровню"})`
      : "раунд по актуальной таблице",
    "схема внутри четверки: 1+3 vs 2+4 (строго)",
    `четверки: ${groupsSummary}`,
    byes.length > 0 ? `bye: ${byeReason}` : "bye: нет",
  ].join(" · ");

  const byesParticipants = byes.map((player) => player.participant);

  return {
    id: `round-${roundIndex + 1}`,
    index: roundIndex + 1,
    matches,
    byes: byesParticipants,
    collapsed: roundIndex !== 0,
    saved: false,
    quality: buildRoundQuality(matches, byesParticipants, roundExplanation),
  } satisfies AmericanoLabRound;
}

function sortRoundsByIndex(rounds: AmericanoLabRound[]) {
  return [...rounds]
    .filter((round) => Boolean(round))
    .sort((left, right) => left.index - right.index);
}

function resolveOptions(options?: MexicanoClassicOptions) {
  return {
    totalRounds: options?.totalRounds,
    firstRoundMode: options?.firstRoundMode ?? "random",
    byeMode: options?.byeMode ?? "rotating_bye",
    seed: options?.seed,
    penaltyWeights: resolvePenaltyWeights(options?.penaltyWeights),
  };
}

function ensureMexicanoRoundIds(rounds: AmericanoLabRound[]) {
  return rounds.map((round, roundIndex) => ({
    ...round,
    id: round.id?.trim() || `round-${roundIndex + 1}`,
    index: round.index > 0 ? round.index : roundIndex + 1,
    matches: round.matches.map((match, matchIndex) => ({
      ...match,
      id: match.id?.trim() || `round-${roundIndex + 1}-match-${matchIndex + 1}`,
    })),
  }));
}

export function createMexicanoClassicInitialRound(
  participants: AmericanoLabParticipant[],
  courts: string[],
  options?: MexicanoClassicOptions,
) {
  const players = normalizeParticipants(participants);
  if (players.length < 4 || courts.length === 0) return [] as AmericanoLabRound[];

  const resolved = resolveOptions(options);
  const context = buildHistoryContext(players, []);
  const ranking = buildInitialRanking(players, resolved.firstRoundMode, resolved.seed);

  const firstRound = buildMexicanoRoundFromRanking(
    ranking,
    context,
    0,
    courts,
    resolved.byeMode,
    resolved.penaltyWeights,
    resolved.seed,
    true,
    resolved.firstRoundMode,
  );

  return firstRound ? [firstRound] : [];
}

function buildNextRound(
  participants: AmericanoLabParticipant[],
  courts: string[],
  rounds: AmericanoLabRound[],
  options?: MexicanoClassicOptions,
) {
  const players = normalizeParticipants(participants);
  if (players.length < 4 || courts.length === 0) return null;

  const resolved = resolveOptions(options);
  const normalizedRounds = ensureMexicanoRoundIds(sortRoundsByIndex(rounds));
  const completedRounds = normalizedRounds.filter((round) => isRoundCompleted(round));

  const context = buildHistoryContext(players, completedRounds);
  const ranking = completedRounds.length === 0
    ? buildInitialRanking(players, resolved.firstRoundMode, resolved.seed)
    : rankPlayersByTable(players, context, resolved.seed);

  return buildMexicanoRoundFromRanking(
    ranking,
    context,
    completedRounds.length,
    courts,
    resolved.byeMode,
    resolved.penaltyWeights,
    resolved.seed,
    completedRounds.length === 0,
    resolved.firstRoundMode,
  );
}

export function appendMexicanoClassicRoundIfReady(
  participants: AmericanoLabParticipant[],
  courts: string[],
  rounds: AmericanoLabRound[],
  options?: MexicanoClassicOptions,
) {
  const normalizedRounds = ensureMexicanoRoundIds(sortRoundsByIndex(rounds));
  if (normalizedRounds.length === 0) {
    return createMexicanoClassicInitialRound(participants, courts, options);
  }

  const lastRound = normalizedRounds[normalizedRounds.length - 1];
  if (!isRoundCompleted(lastRound)) return normalizedRounds;

  const nextRound = buildNextRound(participants, courts, normalizedRounds, options);
  if (!nextRound) return normalizedRounds;

  const existingIds = new Set(normalizedRounds.map((round) => round.id));
  if (existingIds.has(nextRound.id)) return normalizedRounds;

  return [...normalizedRounds, nextRound];
}

export function rebuildMexicanoClassicFutureRounds(
  participants: AmericanoLabParticipant[],
  courts: string[],
  rounds: AmericanoLabRound[],
  fromRoundIndex: number,
  options?: MexicanoClassicOptions,
) {
  const normalizedRounds = ensureMexicanoRoundIds(sortRoundsByIndex(rounds));
  const cutoffIndex = Math.max(1, parseInteger(fromRoundIndex, 1));
  const preservedRounds = normalizedRounds.filter((round) => round.index <= cutoffIndex);

  let working = [...preservedRounds];
  for (;;) {
    const next = appendMexicanoClassicRoundIfReady(participants, courts, working, options);
    if (next.length === working.length) break;
    working = next;
  }

  return working;
}

export function buildMexicanoClassicParams(
  playersCount: number,
  options?: MexicanoClassicOptions,
) {
  const resolved = resolveOptions(options);
  const totalRounds = resolveTotalRounds(playersCount, resolved.totalRounds);
  return {
    mexicanoMode: "classic" as const,
    firstRoundMode: resolved.firstRoundMode,
    byeMode: resolved.byeMode,
    seed: String(resolved.seed ?? "mexicano"),
    totalRounds,
    minRoundsBeforeFinish: Math.min(DEFAULT_MIN_ROUNDS_BEFORE_FINISH, totalRounds),
    byePointsMode: "zero" as const,
  };
}
