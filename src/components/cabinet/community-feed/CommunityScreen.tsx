import { useCallback, useMemo, useState } from "react";
import type { CommunityRecord } from "../../../utils/communityApi";
import { CommunityBottomNav } from "./CommunityBottomNav";
import { CommunityFab } from "./CommunityFab";
import { CommunityFeed } from "./CommunityFeed";
import { CommunityFilters } from "./CommunityFilters";
import { CommunityHeader } from "./CommunityHeader";
import { CommunityNewsModal } from "./CommunityNewsModal";
import { CommunitySecondaryNav, type CommunitySecondaryNavItemId } from "./CommunitySecondaryNav";
import type {
  CommunityBottomNavItemId,
  CommunityFeedFilterId,
  FeedEntry,
  FeedFabAction,
  Game,
  News,
  NewsComment,
  NewsReaction,
  NewsThreadData,
  Tournament,
  User,
} from "./feedTypes";

interface CommunityScreenProps {
  community: Pick<
    CommunityRecord,
    "name" | "logo" | "isVerified" | "visibility" | "createdAt" | "memberCount" | "city" | "minimumLevel" | "description" | "focusTags"
  >;
  entries: FeedEntry[];
  isLoading: boolean;
  hasMore: boolean;
  isLoadingMore: boolean;
  canCreate: boolean;
  chatBadgeCount?: number;
  onOpenGame: (game: Game, entry: FeedEntry) => void;
  onOpenGameChat: (game: Game, entry: FeedEntry) => void;
  onOpenTournament: (tournament: Tournament, entry: FeedEntry) => void;
  onOpenNews: (news: News, entry: FeedEntry) => void;
  onLoadNewsThread: (news: News, entry: FeedEntry) => Promise<NewsThreadData>;
  onPersistNewsReaction: (news: News, reaction: NewsReaction, entry: FeedEntry) => Promise<void>;
  onPersistNewsComment: (news: News, text: string, entry: FeedEntry) => Promise<NewsComment>;
  onEditNews?: (news: News, entry: FeedEntry) => void;
  onOpenUser: (user: User, entry: FeedEntry) => void;
  onAddFriend: (user: User, entry: FeedEntry) => void;
  onMessageUser: (user: User, entry: FeedEntry) => void;
  onLoadMore: () => void;
  onFabAction: (action: FeedFabAction) => void;
  onInvitePlayers: () => void;
  onOpenMenu: () => void;
  onClose: () => void;
  onSelectSectionNav: (itemId: CommunitySecondaryNavItemId) => void;
  onSelectBottomNav: (itemId: CommunityBottomNavItemId) => void;
}

function filterEntries(entries: FeedEntry[], activeFilter: CommunityFeedFilterId) {
  if (activeFilter === "all") {
    return entries.filter((entry) => (
      entry.item.type === "game"
      || entry.item.type === "tournament"
      || entry.item.type === "news"
    ));
  }
  if (activeFilter === "games") {
    return entries.filter((entry) => entry.item.type === "game");
  }
  if (activeFilter === "tournaments") {
    return entries.filter((entry) => entry.item.type === "tournament");
  }
  return entries.filter((entry) => entry.item.type === "news");
}

function buildBaseNewsThread(news: News): NewsThreadData {
  return {
    likes: news.likes,
    dislikes: news.dislikes,
    commentsCount: news.comments,
    reaction: news.reaction,
    comments: [],
  };
}

function toggleReaction(current: NewsReaction, next: Exclude<NewsReaction, null>): NewsReaction {
  return current === next ? null : next;
}

function getErrorMessage(error: unknown, fallback: string) {
  if (error instanceof Error) {
    const message = error.message.trim();
    return message || fallback;
  }
  return fallback;
}

const EMPTY_NEWS_THREAD: NewsThreadData = {
  likes: 0,
  dislikes: 0,
  commentsCount: 0,
  reaction: null,
  comments: [],
};

export function CommunityScreen({
  community,
  entries,
  isLoading,
  hasMore,
  isLoadingMore,
  canCreate,
  chatBadgeCount = 0,
  onOpenGame,
  onOpenGameChat,
  onOpenTournament,
  onOpenNews,
  onLoadNewsThread,
  onPersistNewsReaction,
  onPersistNewsComment,
  onEditNews,
  onOpenUser,
  onAddFriend,
  onMessageUser,
  onLoadMore,
  onFabAction,
  onInvitePlayers,
  onOpenMenu,
  onClose,
  onSelectSectionNav,
  onSelectBottomNav,
}: CommunityScreenProps) {
  const [activeFilter, setActiveFilter] = useState<CommunityFeedFilterId>("all");
  const [selectedNewsEntry, setSelectedNewsEntry] = useState<{ news: News; entry: FeedEntry } | null>(null);
  const [newsThreadById, setNewsThreadById] = useState<Record<string, NewsThreadData>>({});
  const [loadingNewsId, setLoadingNewsId] = useState<string | null>(null);
  const [newsThreadError, setNewsThreadError] = useState<string | null>(null);

  const displayEntries = entries;

  const baseNewsThreadById = useMemo(() => {
    const next: Record<string, NewsThreadData> = {};

    displayEntries.forEach((entry) => {
      if (entry.item.type !== "news") return;
      next[entry.item.data.id] = buildBaseNewsThread(entry.item.data);
    });

    return next;
  }, [displayEntries]);

  const getResolvedNewsThread = useCallback((newsId: string) => (
    newsThreadById[newsId]
    ?? baseNewsThreadById[newsId]
    ?? EMPTY_NEWS_THREAD
  ), [baseNewsThreadById, newsThreadById]);

  const applyNewsThreadPatch = useCallback((newsId: string, updater: (current: NewsThreadData) => NewsThreadData) => {
    setNewsThreadById((current) => {
      const currentThread = current[newsId] ?? baseNewsThreadById[newsId] ?? EMPTY_NEWS_THREAD;
      return {
        ...current,
        [newsId]: updater(currentThread),
      };
    });
  }, [baseNewsThreadById]);

  const newsStats = useMemo(() => {
    const likes: Record<string, number> = {};
    const dislikes: Record<string, number> = {};
    const commentsCount: Record<string, number> = {};
    const reactions: Record<string, NewsReaction> = {};

    displayEntries.forEach((entry) => {
      if (entry.item.type !== "news") return;
      const news = entry.item.data;
      const thread = getResolvedNewsThread(news.id);

      likes[news.id] = thread.likes;
      dislikes[news.id] = thread.dislikes;
      commentsCount[news.id] = thread.commentsCount;
      reactions[news.id] = thread.reaction;
    });

    return { likes, dislikes, commentsCount, reactions };
  }, [displayEntries, getResolvedNewsThread]);

  const filteredEntries = useMemo(
    () => filterEntries(displayEntries, activeFilter),
    [activeFilter, displayEntries],
  );

  const selectedNewsId = selectedNewsEntry?.news.id ?? null;
  const selectedNewsThread = selectedNewsId ? getResolvedNewsThread(selectedNewsId) : null;

  const handleOpenNews = async (news: News, entry: FeedEntry) => {
    setSelectedNewsEntry({ news, entry });
    setNewsThreadError(null);
    setLoadingNewsId(news.id);

    try {
      const thread = await onLoadNewsThread(news, entry);
      setNewsThreadById((current) => ({
        ...current,
        [news.id]: thread,
      }));
    } catch (error) {
      setNewsThreadError(getErrorMessage(error, "Не удалось загрузить обсуждение новости."));
    } finally {
      setLoadingNewsId((current) => (current === news.id ? null : current));
    }
  };

  const handleNewsReaction = async (
    news: News,
    entry: FeedEntry,
    targetReaction: Exclude<NewsReaction, null>,
  ) => {
    const previousThread = getResolvedNewsThread(news.id);
    const nextReaction = toggleReaction(previousThread.reaction, targetReaction);
    const nextThread: NewsThreadData = {
      ...previousThread,
      reaction: nextReaction,
      likes: Math.max(
        0,
        previousThread.likes
          - (previousThread.reaction === "like" ? 1 : 0)
          + (nextReaction === "like" ? 1 : 0),
      ),
      dislikes: Math.max(
        0,
        previousThread.dislikes
          - (previousThread.reaction === "dislike" ? 1 : 0)
          + (nextReaction === "dislike" ? 1 : 0),
      ),
    };

    setNewsThreadError(null);
    applyNewsThreadPatch(news.id, () => nextThread);

    try {
      await onPersistNewsReaction(news, nextReaction, entry);
    } catch (error) {
      applyNewsThreadPatch(news.id, () => previousThread);
      setNewsThreadError(getErrorMessage(error, "Не удалось сохранить реакцию новости."));
    }
  };

  const handleSubmitComment = async (text: string) => {
    if (!selectedNewsEntry) return false;

    const { news, entry } = selectedNewsEntry;
    setNewsThreadError(null);

    try {
      const comment = await onPersistNewsComment(news, text, entry);
      applyNewsThreadPatch(news.id, (current) => ({
        ...current,
        comments: [...current.comments, comment],
        commentsCount: current.commentsCount + 1,
      }));
      return true;
    } catch (error) {
      setNewsThreadError(getErrorMessage(error, "Не удалось отправить комментарий."));
      return false;
    }
  };

  const handleEditNews = (news: News, entry: FeedEntry) => {
    setSelectedNewsEntry(null);
    setNewsThreadError(null);
    onEditNews?.(news, entry);
  };

  return (
    <div className="community-feed-screen community-feed-screen--feed">
      <div className="community-feed-top-stack">
        <CommunityHeader community={community} onOpenMenu={onOpenMenu} onClose={onClose} />
        <CommunitySecondaryNav activeItem="feed" onSelect={onSelectSectionNav} />
      </div>

      <div className="community-feed-box">
        <div className="community-feed-box-header">
          <CommunityFilters activeFilter={activeFilter} onChange={setActiveFilter} />
        </div>

        <div className="community-feed-box-scroll">
          <CommunityFeed
            entries={filteredEntries}
            isLoading={isLoading && displayEntries.length === 0}
            hasMore={hasMore}
            isLoadingMore={isLoadingMore}
            onLoadMore={onLoadMore}
            onOpenGame={onOpenGame}
            onOpenGameChat={onOpenGameChat}
            onOpenTournament={onOpenTournament}
            onOpenNews={(news, entry) => {
              void handleOpenNews(news, entry);
              onOpenNews(news, entry);
            }}
            onEditNews={onEditNews ? (news, entry) => handleEditNews(news, entry) : undefined}
            onOpenUser={onOpenUser}
            onAddFriend={onAddFriend}
            onMessageUser={onMessageUser}
            newsLikes={newsStats.likes}
            newsDislikes={newsStats.dislikes}
            newsCommentsCount={newsStats.commentsCount}
            newsReactions={newsStats.reactions}
            onNewsLike={(news, entry) => {
              void handleNewsReaction(news, entry, "like");
            }}
            onNewsDislike={(news, entry) => {
              void handleNewsReaction(news, entry, "dislike");
            }}
          />
        </div>
      </div>

      <CommunityBottomNav
        activeItem="table"
        chatBadgeCount={chatBadgeCount}
        onSelect={onSelectBottomNav}
        actionSlot={canCreate ? (
          <CommunityFab
            variant="nav"
            onAddPost={() => onFabAction("news")}
            onScheduleGame={() => onFabAction("game")}
            onInvitePlayers={onInvitePlayers}
          />
        ) : null}
      />

      <CommunityNewsModal
        isOpen={Boolean(selectedNewsEntry)}
        news={selectedNewsEntry?.news ?? null}
        likes={selectedNewsThread?.likes ?? 0}
        dislikes={selectedNewsThread?.dislikes ?? 0}
        commentsCount={selectedNewsThread?.commentsCount ?? 0}
        comments={selectedNewsThread?.comments ?? []}
        reaction={selectedNewsThread?.reaction ?? null}
        isCommentsLoading={Boolean(selectedNewsId && loadingNewsId === selectedNewsId)}
        commentsError={newsThreadError}
        onClose={() => {
          setSelectedNewsEntry(null);
          setNewsThreadError(null);
        }}
        onLike={() => {
          if (!selectedNewsEntry) return;
          void handleNewsReaction(selectedNewsEntry.news, selectedNewsEntry.entry, "like");
        }}
        onDislike={() => {
          if (!selectedNewsEntry) return;
          void handleNewsReaction(selectedNewsEntry.news, selectedNewsEntry.entry, "dislike");
        }}
        onEdit={selectedNewsEntry?.news.canEdit && onEditNews
          ? () => {
            if (!selectedNewsEntry) return;
            handleEditNews(selectedNewsEntry.news, selectedNewsEntry.entry);
          }
          : undefined}
        onSubmitComment={handleSubmitComment}
      />
    </div>
  );
}
