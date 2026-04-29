export type User = {
  id: string;
  name: string;
  avatarUrl?: string;
  avatar?: string;
  level?: string;
};

export type CommunityGameCard = {
  id: string;
  isRatingGame?: boolean | null;
  dateMonth: string;
  dateDay: string;
  dateWeekday: string;
  badgeLabel: string;
  title: string;
  datetimeText: string;
  duration: string;
  level: string;
  slotsText: string;
  players: User[];
  waitlistPlayers?: User[];
  extraPlayersCount?: number;
  confirmedPlayersCount?: number;
  isJoined: boolean;
  isFull: boolean;
  datetime: string;
  location: string;
  slotsLeft: number;
  totalSlots: number;
  splitJoinPriceText?: string | null;
  splitCancelDeadlineAt?: string | null;
  media?: string;
  ctaLabel?: string;
  showWaitlist?: boolean;
  isPastGame?: boolean;
  needsResult?: boolean;
  hasConfirmedResult?: boolean;
  hasPendingResult?: boolean;
  isResultDisputed?: boolean;
  canDisputeResult?: boolean;
  resultStatusLabel?: string | null;
  resultScore?: string | null;
  resultTeams?: {
    left: User[];
    right: User[];
  } | null;
};

export type CommunityTournamentCard = {
  id: string;
  badgeLabel: string;
  title: string;
  subtitle: string;
  metaText: string;
  progress: number;
  imageUrl: string;
  isJoined: boolean;
  isFull: boolean;
  date: string;
  level?: string;
  participants: number;
  maxParticipants: number;
  startTime: string;
  endTime?: string;
  duration?: string;
  media?: string;
  stationLabel?: string;
  tournamentTypeLabel?: string;
  ratingLabel?: string;
  genderLabel?: string;
  slotsLabel?: string;
  ctaLabel?: string;
  trainerName?: string;
  trainerAvatarUrl?: string;
  profileHandle?: string;
  publicUrl?: string;
  waitlistCount?: number;
  spotsLeft?: number | null;
};

export type CommunityNewsCard = {
  id: string;
  badgeLabel: string;
  publishedAt: string;
  title: string;
  text: string;
  previewText?: string;
  fullText?: string;
  likes: number;
  dislikes: number;
  comments: number;
  reaction: NewsReaction;
  imageUrl: string;
  media?: string;
  author: User;
  canEdit?: boolean;
};

export type NewsReaction = "like" | "dislike" | null;

export type NewsComment = {
  id: string;
  authorName: string;
  text: string;
  createdAt: string;
  isOwn?: boolean;
};

export type NewsThreadData = {
  likes: number;
  dislikes: number;
  commentsCount: number;
  reaction: NewsReaction;
  comments: NewsComment[];
};

export type CommunityUserJoinedCard = {
  id: string;
  badgeLabel: string;
  user: User;
  subtitle: string;
  joinedAt: string;
};

export type CommunityFeedItem =
  | { type: "game"; data: CommunityGameCard }
  | { type: "tournament"; data: CommunityTournamentCard }
  | { type: "news"; data: CommunityNewsCard }
  | { type: "user_joined"; data: CommunityUserJoinedCard };

export type FeedItem = CommunityFeedItem;
export type Game = CommunityGameCard;
export type Tournament = CommunityTournamentCard;
export type News = CommunityNewsCard;
export type UserJoined = CommunityUserJoinedCard;

export type FeedFabAction = "game" | "tournament" | "news";
export type CommunityFeedFilterId = "all" | "games" | "tournaments" | "news";
export type CommunityBottomNavItemId = "feed" | "chat" | "ranking" | "table";

export interface FeedEntry {
  id: string;
  item: CommunityFeedItem;
  publishedAt: string;
  author?: User;
  relatedGameId?: string | null;
  relatedTournamentId?: string | null;
}
