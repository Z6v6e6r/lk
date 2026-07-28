import { useMemo } from "react";
import { COMMUNITIES_BUNDLE_URL } from "../../consts/api_config";
import type { PadelGameRecord, UserProfileType } from "../../utils/apiClient";
import type { OpenGamesOptions } from "../../types/gamesOverlay";
import type { OpenLevelsInfoOptions } from "../../types/levelsInfoOverlay";
import type { OpenTournamentsOptions } from "../../types/tournamentsOverlay";
import type { CommunitiesMountData } from "../../types/communitiesWidget";
import { RemoteWidgetHost } from "../UI/RemoteWidgetHost";

interface CommunitiesSectionLoaderProps {
  profile: UserProfileType;
  createdGames: PadelGameRecord[];
  activeBookingExerciseIds: string[];
  onOpenGames: (options?: OpenGamesOptions) => void;
  onOpenTournaments: (options?: OpenTournamentsOptions) => void;
  onOpenLevelsInfo?: (options?: OpenLevelsInfoOptions) => void;
  onOpenHome?: () => void;
  onOpenProfile?: () => void;
  initialInviteCode?: string | null;
  initialInviteLink?: string | null;
  inviteEntryCabinetUrl?: string | null;
}

export function CommunitiesSectionLoader({
  profile,
  createdGames,
  activeBookingExerciseIds,
  onOpenGames,
  onOpenTournaments,
  onOpenLevelsInfo,
  onOpenHome,
  onOpenProfile,
  initialInviteCode,
  initialInviteLink,
  inviteEntryCabinetUrl,
}: CommunitiesSectionLoaderProps) {
  const data = useMemo<CommunitiesMountData>(() => ({
    profile,
    createdGames,
    activeBookingExerciseIds,
    onOpenGames,
    onOpenTournaments,
    onOpenLevelsInfo,
    onOpenHome,
    onOpenProfile,
    initialInviteCode,
    initialInviteLink,
    inviteEntryCabinetUrl,
  }), [
    activeBookingExerciseIds,
    createdGames,
    initialInviteCode,
    initialInviteLink,
    inviteEntryCabinetUrl,
    onOpenGames,
    onOpenHome,
    onOpenLevelsInfo,
    onOpenProfile,
    onOpenTournaments,
    profile,
  ]);

  return (
    <RemoteWidgetHost
      src={COMMUNITIES_BUNDLE_URL}
      globalName="LKWidgetCommunities"
      data={data}
      loadingText="Загружаем сообщества..."
      errorTitle="Не удалось загрузить сообщества"
      className="communities-widget-host"
    />
  );
}
