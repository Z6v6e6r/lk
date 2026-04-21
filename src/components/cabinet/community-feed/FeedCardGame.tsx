import { FeedCardWrapper } from "./FeedCardWrapper";
import { formatFeedDayLabel, formatFeedTimeLabel, formatRelativePublishedLabel, getInitials } from "./feedFormatters";
import type { Game, User } from "./feedTypes";

interface FeedCardGameProps {
  game: Game;
  author?: User;
  publishedAt: string;
  onOpen: () => void;
}

function renderAvatar(user: User, index: number) {
  return (
    <div
      key={`${user.id}-${index}`}
      className="community-feed-avatar-stack-item"
      style={{ zIndex: 10 - index }}
      title={user.name}
    >
      {user.avatar ? (
        <img src={user.avatar} alt={user.name} className="community-feed-avatar-stack-image" />
      ) : (
        <span>{getInitials(user.name)}</span>
      )}
    </div>
  );
}

function getGameCtaLabel(game: Game) {
  if (game.isJoined) return "Открыть игру";
  if (game.slotsLeft === 0) return "В лист ожидания";
  return "Присоединиться";
}

export function FeedCardGame({ game, author, publishedAt, onOpen }: FeedCardGameProps) {
  const visiblePlayers = game.players.slice(0, 4);
  const hiddenPlayersCount = Math.max(game.players.length - visiblePlayers.length, 0);

  return (
    <FeedCardWrapper variant="game">
      <div className="community-feed-card-head">
        <span className="community-feed-card-kicker">🎾 Игра • {formatFeedDayLabel(game.datetime)}</span>
      </div>

      <div className="community-feed-card-title community-feed-card-title--game">{game.title}</div>
      <div className="community-feed-card-meta">
        {formatFeedTimeLabel(game.datetime)} • {game.location}
      </div>

      <div className={`community-feed-media community-feed-media--game${game.media ? "" : " is-placeholder"}`}>
        {game.media ? (
          <img src={game.media} alt={game.title} className="community-feed-media-image" />
        ) : (
          <div className="community-feed-media-placeholder">
            <span>Матч сообщества</span>
          </div>
        )}
        <span className={`community-feed-chip community-feed-chip--slots${game.slotsLeft === 0 ? " is-full" : ""}`}>
          Осталось {game.slotsLeft} {game.slotsLeft === 1 ? "место" : game.slotsLeft < 5 ? "места" : "мест"}
        </span>
      </div>

      <div className="community-feed-card-foot">
        <div className="community-feed-avatar-stack" aria-label={`Игроков: ${game.players.length}`}>
          {visiblePlayers.map(renderAvatar)}
          {hiddenPlayersCount > 0 && (
            <div className="community-feed-avatar-stack-item community-feed-avatar-stack-item--more">
              +{hiddenPlayersCount}
            </div>
          )}
        </div>

        <div className="community-feed-author-row">
          <div className="community-feed-author-avatar">
            {author?.avatar ? (
              <img src={author.avatar} alt={author.name} className="community-feed-author-avatar-image" />
            ) : (
              <span>{getInitials(author?.name || "Сообщество")}</span>
            )}
          </div>
          <div className="community-feed-author-copy">
            <span className="community-feed-author-name">{author?.name || "Сообщество"}</span>
            <span className="community-feed-author-time">{formatRelativePublishedLabel(publishedAt)}</span>
          </div>
        </div>
      </div>

      <button type="button" className="community-feed-cta community-feed-cta--primary" onClick={onOpen}>
        {getGameCtaLabel(game)}
      </button>
    </FeedCardWrapper>
  );
}
