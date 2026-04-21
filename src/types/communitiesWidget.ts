import type { UserProfileType, PadelGameRecord } from "../utils/apiClient";
import type { OpenGamesOptions } from "./gamesOverlay";

export type CommunitiesMountData = {
  profile: UserProfileType;
  createdGames: PadelGameRecord[];
  onOpenGames: (options?: OpenGamesOptions) => void;
  onOpenTournaments: () => void;
  onOpenHome?: () => void;
  onOpenProfile?: () => void;
  initialInviteCode?: string | null;
  initialInviteLink?: string | null;
  inviteEntryCabinetUrl?: string | null;
};
