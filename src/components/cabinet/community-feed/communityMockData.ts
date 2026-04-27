import { communityPlaceholderImages } from "./communityMedia";
import type { FeedEntry, User } from "./feedTypes";

const mockPlayers: User[] = [
  {
    id: "mock-player-1",
    name: "Алексей Миронов",
    avatarUrl: communityPlaceholderImages.avatars.al,
    avatar: communityPlaceholderImages.avatars.al,
    level: "D+",
  },
  {
    id: "mock-player-2",
    name: "Денис Титов",
    avatarUrl: communityPlaceholderImages.avatars.dn,
    avatar: communityPlaceholderImages.avatars.dn,
    level: "D+",
  },
  {
    id: "mock-player-3",
    name: "Игорь Ким",
    avatarUrl: communityPlaceholderImages.avatars.ig,
    avatar: communityPlaceholderImages.avatars.ig,
    level: "D+",
  },
  {
    id: "mock-player-4",
    name: "Анна Котова",
    level: "D+",
  },
];

export function buildCommunityMockFeedEntries(): FeedEntry[] {
  return [
    {
      id: "mock-game",
      publishedAt: "2026-03-29T10:30:00.000Z",
      relatedGameId: "mock-game",
      item: {
        type: "game",
        data: {
          id: "mock-game",
          dateMonth: "АПР",
          dateDay: "01",
          dateWeekday: "ПН",
          badgeLabel: "Игра • Сегодня",
          title: "Игра Терехово",
          datetimeText: "09:00–10:00",
          duration: "60 мин",
          level: "D+/C+",
          slotsText: "2 места",
          players: mockPlayers,
          extraPlayersCount: 2,
          isJoined: false,
          isFull: false,
          datetime: "2026-04-01T09:00:00.000Z",
          location: "Корт №9 панорамик • Зелёный",
          slotsLeft: 2,
          totalSlots: 4,
        },
      },
    },
    {
      id: "mock-tournament",
      publishedAt: "2026-03-27T08:00:00.000Z",
      relatedTournamentId: "mock-tournament",
      item: {
        type: "tournament",
        data: {
          id: "mock-tournament",
          badgeLabel: "Турнир • 18 апреля",
          title: "Кубок Терехово",
          subtitle: "Станция Терехово",
          metaText: "Американо • Старт 10:00 • 12/16 мест",
          progress: 12 / 16,
          imageUrl: communityPlaceholderImages.tournament,
          isJoined: false,
          isFull: false,
          date: "2026-04-18T10:00:00",
          level: "B+/A",
          participants: 12,
          maxParticipants: 16,
          startTime: "10:00",
          media: communityPlaceholderImages.tournament,
          stationLabel: "Станция Терехово",
          tournamentTypeLabel: "Американо",
          ratingLabel: "B+/A",
          genderLabel: "Мужчины",
          slotsLabel: "12/16 мест",
        },
      },
    },
    {
      id: "mock-news",
      publishedAt: "2026-04-20T18:30:00.000Z",
      item: {
        type: "news",
        data: {
          id: "mock-news",
          badgeLabel: "Новость • 20 апреля",
          publishedAt: "2026-04-20T18:30:00.000Z",
          title: "Открытие нового корта",
          text: "В эту пятницу открываем новый панорамный корт и делаем вечерний мини-фестиваль для участников сообщества.\n\nБудет пробная игра, музыка, welcome-напитки и короткий разбор форматов для новичков. Если хотите прийти компанией, напишите в комментариях: соберём отдельный слот и поможем с парами.",
          previewText: "В эту пятницу открываем новый панорамный корт и делаем вечерний мини-фестиваль для участников сообщества.",
          fullText: "В эту пятницу открываем новый панорамный корт и делаем вечерний мини-фестиваль для участников сообщества.\n\nБудет пробная игра, музыка, welcome-напитки и короткий разбор форматов для новичков. Если хотите прийти компанией, напишите в комментариях: соберём отдельный слот и поможем с парами.",
          likes: 8,
          dislikes: 1,
          comments: 3,
          reaction: null,
          imageUrl: communityPlaceholderImages.news,
          media: communityPlaceholderImages.news,
          author: {
            id: "mock-author",
            name: "Хаб Селигерская",
            avatarUrl: communityPlaceholderImages.avatars.ak,
            avatar: communityPlaceholderImages.avatars.ak,
          },
        },
      },
    },
    {
      id: "mock-user-joined",
      publishedAt: "2026-03-28T09:00:00.000Z",
      item: {
        type: "user_joined",
        data: {
          id: "mock-user-joined",
          badgeLabel: "Новый участник",
          user: {
            id: "mock-user",
            name: "Денис Титов",
            avatarUrl: communityPlaceholderImages.avatars.dn,
            avatar: communityPlaceholderImages.avatars.dn,
          },
          subtitle: "Денис присоединился к сообществу",
          joinedAt: "2026-03-28T09:00:00.000Z",
        },
      },
    },
  ];
}
