import type { UserProfileType } from "../utils/apiClient";

export type RatingBreakdownSourceTab = "overall" | "dynamics" | "games" | "tournaments";
export type RatingBreakdownDefaultTab = "games" | "tournaments" | "activity" | "overall";

export interface RatingBreakdownPlayerPayload {
  id: string | null;
  phone: string | null;
  name: string;
  avatarUrl: string | null;
  rank: number;
  isCurrentUser: boolean;
}

export interface RatingBreakdownMetricsPayload {
  currentLevel: number;
  levelDelta: number;
  lastRatingDelta: number | null;
  lastRatingChangedAt: string | null;
  gamesPlayed: number;
  gamesWon: number;
  gamesLost: number;
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
  visitsAttended: number;
  activityScore: number;
  overallScore: number;
  lastActivityAt: string | null;
}

export interface RatingBreakdownPayload {
  communityId: string;
  communityName: string;
  updatedAt: string | null;
  calculationVersion?: string | null;
  openedFromTab: RatingBreakdownSourceTab;
  defaultTab: RatingBreakdownDefaultTab;
  player: RatingBreakdownPlayerPayload;
  metrics: RatingBreakdownMetricsPayload;
}

export type OpenLevelsInfoOptions = {
  profile?: UserProfileType;
  ratingBreakdown?: RatingBreakdownPayload;
};

export type LevelsInfoMountData = OpenLevelsInfoOptions;
