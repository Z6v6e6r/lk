export type CommunityRatingTab = "overall" | "games" | "tournaments" | "level";
export type CommunityRatingPeriod = "7d" | "30d" | "90d" | "all";

export interface GamesRawScoreInput {
  gamesWon: number;
  setsWon: number;
  gamesWonCount: number;
  gamesDiff: number;
  levelDelta: number;
}

export interface TournamentRawScoreInput {
  participantsCount: number;
  place: number;
  tournamentMatchesWon: number;
  tournamentPointsScored: number;
  tournamentPointsDiff: number;
}

export interface CommunityRatingItem {
  communityId: string;
  playerId: string;
  playerName: string;
  avatarUrl: string | null;
  currentLevel: number;
  levelDelta: number;
  gamesPlayed: number;
  gamesWon: number;
  gamesLost: number;
  winRate: number;
  setsWon: number;
  gamesWonCount: number;
  gamesDiff: number;
  gamesRawScore: number;
  gamesReliabilityFactor: number;
  gamesScore: number;
  gamesNormalized: number;
  tournamentsPlayed: number;
  tournamentMatchesWon: number;
  tournamentPointsScored: number;
  tournamentPointsDiff: number;
  bestPlace: number | null;
  averagePlace: number | null;
  tournamentRawScore: number;
  tournamentReliabilityFactor: number;
  tournamentScore: number;
  tournamentNormalized: number;
  activityScore: number;
  overallScore: number;
  totalEventsPlayed: number;
  lastActivityAt: string | null;
  badges: string[];
}

export interface RatingBadgesInput {
  gamesPlayed: number;
  tournamentsPlayed: number;
  totalEventsPlayed: number;
  lastActivityAt: string | null;
  levelDelta: number;
  bestPlace: number | null;
}

function toFinite(value: number, fallback = 0): number {
  return Number.isFinite(value) ? value : fallback;
}

function roundTo(value: number, digits = 3): number {
  if (!Number.isFinite(value)) return 0;
  const factor = 10 ** digits;
  return Math.round(value * factor) / factor;
}

function lastActivityTs(value: string | null): number {
  if (!value) return 0;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

export function calculateGamesRawScore(input: GamesRawScoreInput): number {
  const gamesWon = toFinite(input.gamesWon);
  const setsWon = toFinite(input.setsWon);
  const gamesWonCount = toFinite(input.gamesWonCount);
  const gamesDiff = toFinite(input.gamesDiff);
  const levelDelta = toFinite(input.levelDelta);

  return roundTo(
    gamesWon * 10
      + setsWon * 3
      + gamesWonCount * 0.5
      + gamesDiff
      + levelDelta * 100,
  );
}

export function getGamesReliabilityFactor(gamesPlayed: number): number {
  const value = Math.max(0, Math.floor(toFinite(gamesPlayed)));
  if (value === 0) return 0;
  if (value <= 2) return 0.6;
  if (value <= 5) return 0.8;
  return 1;
}

export function calculateGamesScore(input: GamesRawScoreInput & { gamesPlayed: number }) {
  const gamesRawScore = calculateGamesRawScore(input);
  const gamesReliabilityFactor = getGamesReliabilityFactor(input.gamesPlayed);
  const gamesScore = roundTo(gamesRawScore * gamesReliabilityFactor);
  return { gamesRawScore, gamesReliabilityFactor, gamesScore };
}

export function calculatePlaceScore(place: number, participantsCount: number): number {
  const n = Math.max(0, Math.floor(toFinite(participantsCount)));
  const p = Math.max(1, Math.floor(toFinite(place, 1)));
  if (n <= 0) return 0;
  const boundedPlace = Math.min(p, n);
  return roundTo(((n - boundedPlace + 1) / n) * 100);
}

export function getPlaceBonus(place: number): number {
  const normalized = Math.max(1, Math.floor(toFinite(place, 1)));
  if (normalized === 1) return 30;
  if (normalized === 2) return 20;
  if (normalized === 3) return 10;
  return 0;
}

export function calculateTournamentRawScore(input: TournamentRawScoreInput): number {
  const placeScore = calculatePlaceScore(input.place, input.participantsCount);
  const matchesWon = toFinite(input.tournamentMatchesWon);
  const pointsScored = toFinite(input.tournamentPointsScored);
  const pointsDiff = toFinite(input.tournamentPointsDiff);
  const bonus = getPlaceBonus(input.place);

  return roundTo(placeScore + matchesWon * 8 + pointsScored * 0.5 + pointsDiff + bonus);
}

export function getTournamentReliabilityFactor(tournamentsPlayed: number): number {
  const value = Math.max(0, Math.floor(toFinite(tournamentsPlayed)));
  if (value === 0) return 0;
  if (value === 1) return 0.8;
  return 1;
}

export function calculateTournamentScore(rawScore: number, tournamentsPlayed: number) {
  const tournamentRawScore = roundTo(toFinite(rawScore));
  const tournamentReliabilityFactor = getTournamentReliabilityFactor(tournamentsPlayed);
  const tournamentScore = roundTo(tournamentRawScore * tournamentReliabilityFactor);
  return { tournamentRawScore, tournamentReliabilityFactor, tournamentScore };
}

export function normalizeScore(score: number, maxScore: number): number {
  const safeScore = Math.max(0, toFinite(score));
  const safeMaxScore = Math.max(0, toFinite(maxScore));
  if (safeMaxScore <= 0) return 0;
  return roundTo((safeScore / safeMaxScore) * 100);
}

export function calculateActivityScore(gamesPlayed: number, tournamentsPlayed: number): number {
  const safeGamesPlayed = Math.max(0, Math.floor(toFinite(gamesPlayed)));
  const safeTournamentsPlayed = Math.max(0, Math.floor(toFinite(tournamentsPlayed)));
  return Math.min(100, safeGamesPlayed * 4 + safeTournamentsPlayed * 12);
}

export function calculateOverallScore(
  gamesNormalized: number,
  tournamentNormalized: number,
  activityScore: number,
): number {
  return roundTo(
    toFinite(gamesNormalized) * 0.55
      + toFinite(tournamentNormalized) * 0.35
      + toFinite(activityScore) * 0.1,
  );
}

export function buildRatingBadges(
  input: RatingBadgesInput,
  options?: { nowTs?: number },
): string[] {
  const badges: string[] = [];
  const gamesPlayed = Math.max(0, Math.floor(toFinite(input.gamesPlayed)));
  const tournamentsPlayed = Math.max(0, Math.floor(toFinite(input.tournamentsPlayed)));
  const totalEventsPlayed = Math.max(0, Math.floor(toFinite(input.totalEventsPlayed)));
  const levelDelta = toFinite(input.levelDelta);
  const bestPlace = input.bestPlace ?? null;
  const activityTs = lastActivityTs(input.lastActivityAt);
  const nowTs = Number.isFinite(options?.nowTs) ? Number(options?.nowTs) : Date.now();

  if (totalEventsPlayed === 0) badges.push("no_activity");
  if (gamesPlayed > 0 && gamesPlayed < 3) badges.push("low_games_data");
  if (tournamentsPlayed === 1) badges.push("low_tournament_data");
  if (totalEventsPlayed >= 6) badges.push("reliable");
  if (activityTs > 0 && activityTs >= nowTs - (14 * 24 * 60 * 60 * 1000)) badges.push("active");
  if (levelDelta > 0) badges.push("growing");
  if (bestPlace === 1) badges.push("tournament_winner");
  return badges;
}

export function sortRatingItems(items: CommunityRatingItem[], tab: CommunityRatingTab): CommunityRatingItem[] {
  const sorted = [...items];
  sorted.sort((left, right) => {
    if (tab === "games") {
      if (right.gamesScore !== left.gamesScore) return right.gamesScore - left.gamesScore;
      if (right.winRate !== left.winRate) return right.winRate - left.winRate;
      if (right.gamesDiff !== left.gamesDiff) return right.gamesDiff - left.gamesDiff;
      if (right.levelDelta !== left.levelDelta) return right.levelDelta - left.levelDelta;
      if (right.gamesPlayed !== left.gamesPlayed) return right.gamesPlayed - left.gamesPlayed;
      if (lastActivityTs(right.lastActivityAt) !== lastActivityTs(left.lastActivityAt)) {
        return lastActivityTs(right.lastActivityAt) - lastActivityTs(left.lastActivityAt);
      }
      return left.playerName.localeCompare(right.playerName, "ru");
    }

    if (tab === "tournaments") {
      if (right.tournamentScore !== left.tournamentScore) return right.tournamentScore - left.tournamentScore;
      const leftBest = left.bestPlace ?? Number.POSITIVE_INFINITY;
      const rightBest = right.bestPlace ?? Number.POSITIVE_INFINITY;
      if (leftBest !== rightBest) return leftBest - rightBest;
      if (right.tournamentMatchesWon !== left.tournamentMatchesWon) {
        return right.tournamentMatchesWon - left.tournamentMatchesWon;
      }
      if (right.tournamentPointsDiff !== left.tournamentPointsDiff) {
        return right.tournamentPointsDiff - left.tournamentPointsDiff;
      }
      if (right.tournamentsPlayed !== left.tournamentsPlayed) return right.tournamentsPlayed - left.tournamentsPlayed;
      if (lastActivityTs(right.lastActivityAt) !== lastActivityTs(left.lastActivityAt)) {
        return lastActivityTs(right.lastActivityAt) - lastActivityTs(left.lastActivityAt);
      }
      return left.playerName.localeCompare(right.playerName, "ru");
    }

    if (tab === "level") {
      if (right.currentLevel !== left.currentLevel) return right.currentLevel - left.currentLevel;
      if (right.levelDelta !== left.levelDelta) return right.levelDelta - left.levelDelta;
      if (right.totalEventsPlayed !== left.totalEventsPlayed) return right.totalEventsPlayed - left.totalEventsPlayed;
      if (lastActivityTs(right.lastActivityAt) !== lastActivityTs(left.lastActivityAt)) {
        return lastActivityTs(right.lastActivityAt) - lastActivityTs(left.lastActivityAt);
      }
      return left.playerName.localeCompare(right.playerName, "ru");
    }

    if (right.overallScore !== left.overallScore) return right.overallScore - left.overallScore;
    if (right.gamesScore !== left.gamesScore) return right.gamesScore - left.gamesScore;
    if (right.tournamentScore !== left.tournamentScore) return right.tournamentScore - left.tournamentScore;
    if (right.activityScore !== left.activityScore) return right.activityScore - left.activityScore;
    if (lastActivityTs(right.lastActivityAt) !== lastActivityTs(left.lastActivityAt)) {
      return lastActivityTs(right.lastActivityAt) - lastActivityTs(left.lastActivityAt);
    }
    return left.playerName.localeCompare(right.playerName, "ru");
  });
  return sorted;
}
