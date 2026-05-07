import type { UserProfileType, PadelGameRecord } from "../utils/apiClient";
import type { OpenGamesOptions } from "./gamesOverlay";
import type { OpenTournamentsOptions } from "./tournamentsOverlay";

export type CommunitiesMountData = {
  profile: UserProfileType;
  createdGames: PadelGameRecord[];
  onOpenGames: (options?: OpenGamesOptions) => void;
  onOpenTournaments: (options?: OpenTournamentsOptions) => void;
  onOpenHome?: () => void;
  onOpenProfile?: () => void;
  initialInviteCode?: string | null;
  initialInviteLink?: string | null;
  inviteEntryCabinetUrl?: string | null;
};
