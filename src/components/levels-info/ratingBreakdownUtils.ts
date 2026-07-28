import type { RatingBreakdownMetricsPayload } from "../../types/levelsInfoOverlay";
import {
  COMMUNITY_RATING_ACTIVITY_WEIGHTS,
  COMMUNITY_RATING_GAMES_RAW_WEIGHTS,
  COMMUNITY_RATING_OVERALL_WEIGHTS,
  COMMUNITY_RATING_TOURNAMENT_RAW_WEIGHTS,
} from "../../services/community-rating/contract.ts";

export const GAMES_FACTOR_WEIGHTS = COMMUNITY_RATING_GAMES_RAW_WEIGHTS;
export const TOURNAMENT_FACTOR_WEIGHTS = COMMUNITY_RATING_TOURNAMENT_RAW_WEIGHTS;
export const ACTIVITY_FACTOR_WEIGHTS = COMMUNITY_RATING_ACTIVITY_WEIGHTS;
export const OVERALL_FACTOR_WEIGHTS = COMMUNITY_RATING_OVERALL_WEIGHTS;

export interface RatingFactorRow {
  id: "gamesWon" | "setsWon" | "gamesWonCount" | "gamesDiff" | "levelDelta";
  title: string;
  subtitle: string;
  value: number;
  multiplier: number;
  contribution: number;
}

export interface OverallFactorRow {
  id: "gamesNormalized" | "tournamentNormalized" | "activityScore";
  title: string;
  subtitle: string;
  value: number;
  multiplier: number;
  contribution: number;
}

export interface TournamentFactorRow {
  id: "placement" | "matchesWon" | "pointsScored" | "pointsDiff";
  title: string;
  subtitle: string;
  value: number;
  multiplier: number;
  contribution: number;
}

export interface ActivityFactorRow {
  id: "games" | "tournaments" | "visits";
  title: string;
  subtitle: string;
  value: number;
  multiplier: number;
  contribution: number;
}

function toFinite(value: number): number {
  return Number.isFinite(value) ? value : 0;
}

function roundTo(value: number, digits = 3): number {
  if (!Number.isFinite(value)) return 0;
  const factor = 10 ** digits;
  return Math.round(value * factor) / factor;
}

export function getExpectedGamesReliabilityFactor(gamesPlayed: number): number {
  const safeGamesPlayed = Math.max(0, Math.floor(toFinite(gamesPlayed)));
  if (safeGamesPlayed === 0) return 0;
  if (safeGamesPlayed <= 2) return 0.6;
  if (safeGamesPlayed <= 5) return 0.8;
  return 1;
}

export function getExpectedTournamentReliabilityFactor(tournamentsPlayed: number): number {
  const safeTournamentsPlayed = Math.max(0, Math.floor(toFinite(tournamentsPlayed)));
  if (safeTournamentsPlayed === 0) return 0;
  if (safeTournamentsPlayed === 1) return 0.8;
  return 1;
}

export function buildGamesFactorRows(metrics: RatingBreakdownMetricsPayload): RatingFactorRow[] {
  return [
    {
      id: "gamesWon",
      title: "Победы в играх",
      subtitle: `${metrics.gamesWon} побед`,
      value: toFinite(metrics.gamesWon),
      multiplier: GAMES_FACTOR_WEIGHTS.matchWin,
      contribution: roundTo(toFinite(metrics.gamesWon) * GAMES_FACTOR_WEIGHTS.matchWin),
    },
    {
      id: "setsWon",
      title: "Выигранные сеты",
      subtitle: `${metrics.setsWon} сетов`,
      value: toFinite(metrics.setsWon),
      multiplier: GAMES_FACTOR_WEIGHTS.setWin,
      contribution: roundTo(toFinite(metrics.setsWon) * GAMES_FACTOR_WEIGHTS.setWin),
    },
    {
      id: "gamesWonCount",
      title: "Выигранные геймы",
      subtitle: `${metrics.gamesWonCount} геймов`,
      value: toFinite(metrics.gamesWonCount),
      multiplier: GAMES_FACTOR_WEIGHTS.gameWin,
      contribution: roundTo(toFinite(metrics.gamesWonCount) * GAMES_FACTOR_WEIGHTS.gameWin),
    },
    {
      id: "gamesDiff",
      title: "Разница геймов",
      subtitle: `${roundTo(metrics.gamesDiff, 3)} разница`,
      value: toFinite(metrics.gamesDiff),
      multiplier: GAMES_FACTOR_WEIGHTS.gameDiff,
      contribution: roundTo(toFinite(metrics.gamesDiff) * GAMES_FACTOR_WEIGHTS.gameDiff),
    },
    {
      id: "levelDelta",
      title: "Изменение уровня",
      subtitle: `${roundTo(metrics.levelDelta, 3)} изменения`,
      value: toFinite(metrics.levelDelta),
      multiplier: GAMES_FACTOR_WEIGHTS.levelDelta,
      contribution: roundTo(toFinite(metrics.levelDelta) * GAMES_FACTOR_WEIGHTS.levelDelta),
    },
  ];
}

export function calculateGamesRawScoreFromFactors(metrics: RatingBreakdownMetricsPayload): number {
  return roundTo(
    toFinite(metrics.gamesWon) * GAMES_FACTOR_WEIGHTS.matchWin
      + toFinite(metrics.setsWon) * GAMES_FACTOR_WEIGHTS.setWin
      + toFinite(metrics.gamesWonCount) * GAMES_FACTOR_WEIGHTS.gameWin
      + toFinite(metrics.gamesDiff) * GAMES_FACTOR_WEIGHTS.gameDiff
      + toFinite(metrics.levelDelta) * GAMES_FACTOR_WEIGHTS.levelDelta,
  );
}

export function calculateOverallScoreFromFactors(metrics: RatingBreakdownMetricsPayload): number {
  return roundTo(
    toFinite(metrics.gamesNormalized) * OVERALL_FACTOR_WEIGHTS.games
      + toFinite(metrics.tournamentNormalized) * OVERALL_FACTOR_WEIGHTS.tournaments
      + toFinite(metrics.activityScore) * OVERALL_FACTOR_WEIGHTS.activity,
  );
}

export function buildOverallFactorRows(metrics: RatingBreakdownMetricsPayload): OverallFactorRow[] {
  return [
    {
      id: "gamesNormalized",
      title: "Нормализованный рейтинг игр",
      subtitle: `${roundTo(metrics.gamesNormalized, 3)} баллов`,
      value: toFinite(metrics.gamesNormalized),
      multiplier: OVERALL_FACTOR_WEIGHTS.games,
      contribution: roundTo(toFinite(metrics.gamesNormalized) * OVERALL_FACTOR_WEIGHTS.games),
    },
    {
      id: "tournamentNormalized",
      title: "Нормализованный рейтинг турниров",
      subtitle: `${roundTo(metrics.tournamentNormalized, 3)} баллов`,
      value: toFinite(metrics.tournamentNormalized),
      multiplier: OVERALL_FACTOR_WEIGHTS.tournaments,
      contribution: roundTo(toFinite(metrics.tournamentNormalized) * OVERALL_FACTOR_WEIGHTS.tournaments),
    },
    {
      id: "activityScore",
      title: "Активность",
      subtitle: `${roundTo(metrics.activityScore, 3)} баллов${
        toFinite(metrics.visitsAttended) > 0
          ? ` · ${Math.floor(toFinite(metrics.visitsAttended))} посещ.`
          : ""
      }`,
      value: toFinite(metrics.activityScore),
      multiplier: OVERALL_FACTOR_WEIGHTS.activity,
      contribution: roundTo(toFinite(metrics.activityScore) * OVERALL_FACTOR_WEIGHTS.activity),
    },
  ];
}

export function buildTournamentFactorRows(metrics: RatingBreakdownMetricsPayload): TournamentFactorRow[] {
  const matchesWonContribution = roundTo(
    toFinite(metrics.tournamentMatchesWon) * TOURNAMENT_FACTOR_WEIGHTS.matchWin,
  );
  const pointsScoredContribution = roundTo(
    toFinite(metrics.tournamentPointsScored) * TOURNAMENT_FACTOR_WEIGHTS.pointScored,
  );
  const pointsDiffContribution = roundTo(
    toFinite(metrics.tournamentPointsDiff) * TOURNAMENT_FACTOR_WEIGHTS.pointDiff,
  );
  const placementContribution = roundTo(
    toFinite(metrics.tournamentRawScore)
      - matchesWonContribution
      - pointsScoredContribution
      - pointsDiffContribution,
  );
  const placeDetails = [
    metrics.bestPlace != null ? `лучшее место: ${Math.max(1, Math.floor(toFinite(metrics.bestPlace)))}` : null,
    metrics.averagePlace != null ? `среднее: ${roundTo(metrics.averagePlace, 1)}` : null,
  ].filter(Boolean).join(" · ");

  return [
    {
      id: "placement",
      title: "Места и призовые бонусы",
      subtitle: placeDetails || "Нет завершенных турниров",
      value: placementContribution,
      multiplier: 1,
      contribution: placementContribution,
    },
    {
      id: "matchesWon",
      title: "Победы в матчах",
      subtitle: `${Math.max(0, Math.floor(toFinite(metrics.tournamentMatchesWon)))} побед`,
      value: toFinite(metrics.tournamentMatchesWon),
      multiplier: TOURNAMENT_FACTOR_WEIGHTS.matchWin,
      contribution: matchesWonContribution,
    },
    {
      id: "pointsScored",
      title: "Набранные очки",
      subtitle: `${roundTo(metrics.tournamentPointsScored, 1)} очков`,
      value: toFinite(metrics.tournamentPointsScored),
      multiplier: TOURNAMENT_FACTOR_WEIGHTS.pointScored,
      contribution: pointsScoredContribution,
    },
    {
      id: "pointsDiff",
      title: "Разница очков",
      subtitle: `${roundTo(metrics.tournamentPointsDiff, 1)} разница`,
      value: toFinite(metrics.tournamentPointsDiff),
      multiplier: TOURNAMENT_FACTOR_WEIGHTS.pointDiff,
      contribution: pointsDiffContribution,
    },
  ];
}

export function calculateTournamentRawScoreFromFactors(metrics: RatingBreakdownMetricsPayload): number {
  return roundTo(buildTournamentFactorRows(metrics).reduce((sum, row) => sum + row.contribution, 0));
}

export function buildActivityFactorRows(metrics: RatingBreakdownMetricsPayload): ActivityFactorRow[] {
  return [
    {
      id: "games",
      title: "Завершенные игры",
      subtitle: `${Math.max(0, Math.floor(toFinite(metrics.gamesPlayed)))} игр`,
      value: toFinite(metrics.gamesPlayed),
      multiplier: ACTIVITY_FACTOR_WEIGHTS.game,
      contribution: roundTo(toFinite(metrics.gamesPlayed) * ACTIVITY_FACTOR_WEIGHTS.game),
    },
    {
      id: "tournaments",
      title: "Завершенные турниры",
      subtitle: `${Math.max(0, Math.floor(toFinite(metrics.tournamentsPlayed)))} турниров`,
      value: toFinite(metrics.tournamentsPlayed),
      multiplier: ACTIVITY_FACTOR_WEIGHTS.tournament,
      contribution: roundTo(toFinite(metrics.tournamentsPlayed) * ACTIVITY_FACTOR_WEIGHTS.tournament),
    },
    {
      id: "visits",
      title: "Подтвержденные посещения",
      subtitle: `${Math.max(0, Math.floor(toFinite(metrics.visitsAttended)))} посещений`,
      value: toFinite(metrics.visitsAttended),
      multiplier: ACTIVITY_FACTOR_WEIGHTS.visit,
      contribution: roundTo(toFinite(metrics.visitsAttended) * ACTIVITY_FACTOR_WEIGHTS.visit),
    },
  ];
}

export function calculateActivityScoreFromFactors(metrics: RatingBreakdownMetricsPayload): number {
  const rawScore = buildActivityFactorRows(metrics).reduce((sum, row) => sum + row.contribution, 0);
  return roundTo(Math.min(ACTIVITY_FACTOR_WEIGHTS.max, rawScore));
}

export function getGamesReliabilityHint(gamesPlayed: number): string {
  const safeGamesPlayed = Math.max(0, Math.floor(toFinite(gamesPlayed)));
  if (safeGamesPlayed >= 6) return "При 6 и более сыгранных играх коэффициент = 1";
  if (safeGamesPlayed >= 3) return "При 3–5 сыгранных играх коэффициент = 0,8";
  if (safeGamesPlayed >= 1) return "При 1–2 сыгранных играх коэффициент = 0,6";
  return "Без сыгранных игр коэффициент = 0";
}

export function getTournamentReliabilityHint(tournamentsPlayed: number): string {
  const safeTournamentsPlayed = Math.max(0, Math.floor(toFinite(tournamentsPlayed)));
  if (safeTournamentsPlayed >= 2) return "При 2 и более завершенных турнирах коэффициент = 1";
  if (safeTournamentsPlayed === 1) return "При 1 завершенном турнире коэффициент = 0,8";
  return "Без завершенных турниров коэффициент = 0";
}
