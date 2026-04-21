import { communityPlaceholderImages } from "./communityMedia";
import type { CommunityGameCardProps } from "./CommunityGameCard";

export const communityGameCardMock: CommunityGameCardProps = {
  month: "АПР",
  day: "01",
  weekday: "ПН",
  title: "Игра Терехово",
  subtitleText: "Корт №9 панорамик • Зелёный",
  timeText: "09:00–10:00",
  levelText: "D+/C+",
  players: [
    { id: "player-1", name: "Алексей Миронов", avatarUrl: communityPlaceholderImages.avatars.al },
    { id: "player-2", name: "Денис Титов", avatarUrl: communityPlaceholderImages.avatars.dn },
    { id: "player-3", name: "Игорь Ким", avatarUrl: communityPlaceholderImages.avatars.ig },
    { id: "player-4", name: "Анна Котова", avatarUrl: communityPlaceholderImages.avatars.ak },
  ],
};
