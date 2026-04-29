import { useEffect, useRef } from "react";
import { CommunityGameCard } from "./CommunityGameCard";
import { CommunityGameResultCard } from "./CommunityGameResultCard";
import { CommunityNewsCard } from "./CommunityNewsCard";
import { CommunityTournamentCard } from "./CommunityTournamentCard";
import { CommunityUserJoinedCard } from "./CommunityUserJoinedCard";
import type { FeedEntry, Game, News, NewsReaction, Tournament, User, UserJoined } from "./feedTypes";

interface CommunityFeedProps {
  entries: FeedEntry[];
  isLoading: boolean;
  hasMore?: boolean;
  isLoadingMore?: boolean;
  onLoadMore?: () => void;
  onOpenGame: (game: Game, entry: FeedEntry) => void;
  onOpenGameChat: (game: Game, entry: FeedEntry) => void;
  onOpenTournament: (tournament: Tournament, entry: FeedEntry) => void;
  onOpenNews: (news: News, entry: FeedEntry) => void;
  onOpenUser: (user: User, entry: FeedEntry) => void;
  onAddFriend: (user: User, entry: FeedEntry) => void;
  onMessageUser: (user: User, entry: FeedEntry) => void;
  onEditNews?: (news: News, entry: FeedEntry) => void;
  newsLikes?: Record<string, number>;
  newsDislikes?: Record<string, number>;
  newsCommentsCount?: Record<string, number>;
  newsReactions?: Record<string, NewsReaction>;
  onNewsLike?: (news: News, entry: FeedEntry) => void;
  onNewsDislike?: (news: News, entry: FeedEntry) => void;
}

function splitByBullet(value: string) {
  return value
    .split("•")
    .map((part) => part.trim())
    .filter(Boolean);
}

function extractGameLines(game: Game) {
  const dateTimeParts = splitByBullet(game.datetimeText);
  const locationParts = splitByBullet(game.location);
  const normalizedLocationParts = [...locationParts, ...dateTimeParts.slice(1)]
    .map((part) => part.trim())
    .filter(Boolean);

  const timePart = dateTimeParts.find((part) => /\d{1,2}:\d{2}/.test(part)) || dateTimeParts[0] || "Время уточняется";
  const normalizedTimeText = timePart.replace(/\s*[–-]\s*/g, "–");
  const courtPart =
    normalizedLocationParts.find((part) => /корт/i.test(part))
    || normalizedLocationParts[0]
    || "Корт уточняется";
  const locationDetail =
    normalizedLocationParts.find((part) => part !== courtPart)
    || null;
  const subtitleText = [courtPart, locationDetail].filter(Boolean).join(" • ");

  return {
    timeText: normalizedTimeText,
    subtitleText: subtitleText || "Локация уточняется",
  };
}

export function CommunityFeed({
  entries,
  isLoading,
  hasMore = false,
  isLoadingMore = false,
  onLoadMore,
  onOpenGame,
  onOpenGameChat,
  onOpenTournament,
  onOpenNews,
  onOpenUser,
  onAddFriend,
  onMessageUser,
  onEditNews,
  newsLikes = {},
  newsCommentsCount = {},
  newsReactions = {},
  onNewsLike,
}: CommunityFeedProps) {
  const loadMoreRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    if (!hasMore || isLoadingMore || !onLoadMore) return undefined;

    const node = loadMoreRef.current;
    if (!node || typeof IntersectionObserver === "undefined") return undefined;

    const observer = new IntersectionObserver((entries) => {
      const entry = entries[0];
      if (!entry?.isIntersecting) return;
      onLoadMore();
    }, {
      rootMargin: "240px 0px",
    });

    observer.observe(node);
    return () => observer.disconnect();
  }, [hasMore, isLoadingMore, onLoadMore]);

  if (isLoading) {
    return <div className="community-loading-note">Загружаем ленту сообщества…</div>;
  }

  if (entries.length === 0) {
    return (
      <div className="community-feed-list">
        <div className="community-empty-note">В ленте пока нет публикаций.</div>
        {hasMore && (
          <div ref={loadMoreRef} className="community-loading-note">
            {isLoadingMore ? "Подгружаем еще события…" : "Прокрутите ниже, чтобы подгрузить еще события"}
          </div>
        )}
      </div>
    );
  }

  return (
    <div className="community-feed-list">
      {entries.map((entry) => {
        const item = entry.item;

        if (item.type === "game") {
          const game = item.data;
          const { timeText, subtitleText } = extractGameLines(game);

          if ((game.hasConfirmedResult || game.hasPendingResult || game.isResultDisputed) && game.resultTeams && game.resultScore) {
            const leftTeam = game.resultTeams.left;
            const rightTeam = game.resultTeams.right;
            const normalizedSets = game.resultScore
              .split("·")
              .map((setItem) => setItem.trim())
              .filter(Boolean)
              .map((setItem) => {
                const [left = "", right = ""] = setItem.split(":").map((value) => value.trim());
                return { left, right };
              });
            const leftWins = normalizedSets.reduce((count, setItem) => count + (Number(setItem.left) > Number(setItem.right) ? 1 : 0), 0);
            const rightWins = normalizedSets.reduce((count, setItem) => count + (Number(setItem.right) > Number(setItem.left) ? 1 : 0), 0);

            return (
              <CommunityGameResultCard
                key={entry.id}
                month={game.dateMonth}
                day={game.dateDay}
                weekday={game.dateWeekday}
                title={game.title}
                subtitleText={subtitleText}
                timeText={timeText}
                levelText={game.level}
                teams={[
                  {
                    players: leftTeam.map((player) => ({
                      id: player.id,
                      avatarUrl: player.avatarUrl || player.avatar || "",
                      name: player.name,
                    })),
                    sets: normalizedSets.map((setItem) => setItem.left),
                    winner: leftWins >= rightWins,
                  },
                  {
                    players: rightTeam.map((player) => ({
                      id: player.id,
                      avatarUrl: player.avatarUrl || player.avatar || "",
                      name: player.name,
                    })),
                    sets: normalizedSets.map((setItem) => setItem.right),
                    winner: rightWins > leftWins,
                  },
                ]}
                statusLabel={game.resultStatusLabel ?? undefined}
                statusTone={
                  game.isResultDisputed
                    ? "disputed"
                    : game.canDisputeResult
                      ? "disputable"
                      : game.hasPendingResult
                        ? "pending"
                        : undefined
                }
                actionLabel={game.canDisputeResult ? "Оспорить" : undefined}
                onAction={game.canDisputeResult ? () => onOpenGame(game, entry) : undefined}
                onOpen={() => onOpenGame(game, entry)}
                onChat={() => onOpenGameChat(game, entry)}
              />
            );
          }

          return (
            <CommunityGameCard
              key={entry.id}
              month={game.dateMonth}
              day={game.dateDay}
              weekday={game.dateWeekday}
              isRatingGame={game.isRatingGame}
              title={game.title}
              subtitleText={subtitleText}
              timeText={timeText}
              levelText={game.level}
              players={game.players.map((player) => ({
                id: player.id,
                avatarUrl: player.avatarUrl || player.avatar || "",
                name: player.name,
              }))}
              waitlistPlayers={(game.waitlistPlayers ?? []).map((player) => ({
                id: player.id,
                avatarUrl: player.avatarUrl || player.avatar || "",
                name: player.name,
              }))}
              confirmedPlayersCount={game.confirmedPlayersCount ?? game.players.length}
              totalSlots={game.totalSlots}
              slotsLeft={game.slotsLeft}
              splitJoinPriceText={game.splitJoinPriceText}
              splitCancelDeadlineAt={game.splitCancelDeadlineAt}
              isJoined={game.isJoined}
              showWaitlist={game.showWaitlist}
              isPastGame={game.isPastGame}
              needsResult={game.needsResult}
              hasConfirmedResult={game.hasConfirmedResult}
              resultScore={game.resultScore}
              resultTeams={game.resultTeams}
              badgeLabel={game.badgeLabel}
              durationText={game.duration}
              authorName={entry.author?.name}
              authorAvatarUrl={entry.author?.avatarUrl || entry.author?.avatar}
              onPlay={() => onOpenGame(game, entry)}
              onChat={() => onOpenGameChat(game, entry)}
            />
          );
        }

        if (item.type === "tournament") {
          return (
            <CommunityTournamentCard
              key={entry.id}
              card={item.data}
              onOpen={() => onOpenTournament(item.data, entry)}
            />
          );
        }

        if (item.type === "news") {
          return (
            <CommunityNewsCard
              key={entry.id}
              card={item.data}
              likes={newsLikes[item.data.id] ?? item.data.likes}
              commentsCount={newsCommentsCount[item.data.id] ?? item.data.comments}
              reaction={newsReactions[item.data.id] ?? item.data.reaction}
              onLike={() => onNewsLike?.(item.data, entry)}
              onOpen={() => onOpenNews(item.data, entry)}
              onEdit={item.data.canEdit ? () => onEditNews?.(item.data, entry) : undefined}
            />
          );
        }

        const joinedItem: UserJoined = item.data;
        return (
          <CommunityUserJoinedCard
            key={entry.id}
            card={joinedItem}
            onOpen={() => onOpenUser(joinedItem.user, entry)}
            onAddFriend={() => onAddFriend(joinedItem.user, entry)}
            onMessage={() => onMessageUser(joinedItem.user, entry)}
          />
        );
      })}

      {hasMore && (
        <div ref={loadMoreRef} className="community-loading-note">
          {isLoadingMore ? "Подгружаем еще события…" : "Прокрутите ниже, чтобы подгрузить еще события"}
        </div>
      )}
    </div>
  );
}
