import type { KeyboardEvent, MouseEvent } from "react";
import { CommunityFeedCardBase } from "./CommunityFeedCardBase";
import { ChatIcon, NewsIcon, ThumbsDownIcon, ThumbsUpIcon } from "./CommunityIcons";
import { communityPlaceholderImages } from "./communityMedia";
import type { CommunityNewsCard as CommunityNewsCardData, NewsReaction } from "./feedTypes";

interface CommunityNewsCardProps {
  card: CommunityNewsCardData;
  likes: number;
  dislikes: number;
  commentsCount: number;
  reaction: NewsReaction;
  onLike: () => void;
  onDislike: () => void;
  onOpen: () => void;
}

export function CommunityNewsCard({
  card,
  likes,
  dislikes,
  commentsCount,
  reaction,
  onLike,
  onDislike,
  onOpen,
}: CommunityNewsCardProps) {
  const previewText = (card.previewText || card.text).trim();

  const handleCardKeyDown = (event: KeyboardEvent<HTMLElement>) => {
    if (event.key !== "Enter" && event.key !== " ") return;
    event.preventDefault();
    onOpen();
  };

  const handleControlClick = (event: MouseEvent<HTMLButtonElement>, action: () => void) => {
    event.stopPropagation();
    action();
  };

  return (
    <CommunityFeedCardBase
      variant="news"
      className="community-feed-card--interactive"
      onClick={onOpen}
      onKeyDown={handleCardKeyDown}
      role="button"
      tabIndex={0}
      aria-label={`Открыть новость: ${card.title}`}
    >
      <div className="community-news-card-layout">
        <div className="community-news-copy">
          <div className="community-feed-card-badge community-feed-card-badge--news">
            <NewsIcon className="community-feed-card-badge-icon" />
            <span>{card.badgeLabel}</span>
          </div>

          <h3 className="community-feed-card-title community-feed-card-title--compact">{card.title}</h3>
          <p className="community-feed-card-copy community-feed-card-copy--news">{previewText}</p>

          <div className="community-feed-news-meta">
            <button
              type="button"
              className={`community-feed-news-vote community-feed-news-vote--like${reaction === "like" ? " is-active" : ""}`}
              onClick={(event) => handleControlClick(event, onLike)}
              aria-label="Поставить лайк новости"
            >
              <ThumbsUpIcon className="community-feed-news-vote-icon" />
              <span>{likes}</span>
            </button>
            <button
              type="button"
              className={`community-feed-news-vote community-feed-news-vote--dislike${reaction === "dislike" ? " is-active" : ""}`}
              onClick={(event) => handleControlClick(event, onDislike)}
              aria-label="Поставить дизлайк новости"
            >
              <ThumbsDownIcon className="community-feed-news-vote-icon" />
              <span>{dislikes}</span>
            </button>
            <button
              type="button"
              className="community-feed-news-stat community-feed-news-stat--button"
              onClick={(event) => handleControlClick(event, onOpen)}
              aria-label="Открыть обсуждение новости"
            >
              <ChatIcon className="community-feed-news-stat-icon" />
              <span>{commentsCount}</span>
              <span className="community-feed-news-stat-label">комм.</span>
            </button>
          </div>
        </div>

        <div className="community-news-media-column">
          <div className="community-feed-media community-feed-media--news">
            <img
              src={card.imageUrl || card.media || communityPlaceholderImages.news}
              alt={card.title}
              className="community-feed-media-image"
            />
          </div>
          <button
            type="button"
            className="community-feed-cta community-feed-cta--media"
            onClick={(event) => handleControlClick(event, onOpen)}
          >
            Читать
          </button>
        </div>
      </div>
    </CommunityFeedCardBase>
  );
}
