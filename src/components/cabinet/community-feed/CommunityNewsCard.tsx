import type { KeyboardEvent, MouseEvent } from "react";
import { CommunityFeedCardBase } from "./CommunityFeedCardBase";
import { ChatIcon, HeartIcon, MoreIcon } from "./CommunityIcons";
import type { CommunityNewsCard as CommunityNewsCardData, NewsReaction } from "./feedTypes";
import { AvatarImageOrInitials } from "./AvatarImageOrInitials";

interface CommunityNewsCardProps {
  card: CommunityNewsCardData;
  likes: number;
  commentsCount: number;
  reaction: NewsReaction;
  onLike: () => void;
  onOpen: () => void;
  onEdit?: () => void;
}

function buildAuthorHandle(name: string) {
  const normalizedName = name.trim();
  if (!normalizedName) return "@community";
  if (normalizedName.startsWith("@")) return normalizedName;

  const slug = normalizedName
    .toLowerCase()
    .replace(/[’'"]/g, "")
    .replace(/\s+/g, "_")
    .replace(/[^\p{L}\p{N}_]+/gu, "")
    .replace(/^_+|_+$/g, "");

  return `@${slug || "community"}`;
}

function getBadgeText(value: string) {
  const [label = "новость"] = value.split("•");
  return (label.trim() || "новость").toLowerCase();
}

function formatPublishedLabel(value: string) {
  const parsed = Date.parse(value);
  if (!Number.isFinite(parsed)) return "";

  const targetDate = new Date(parsed);
  const now = new Date();
  const startOfToday = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const startOfTarget = new Date(targetDate.getFullYear(), targetDate.getMonth(), targetDate.getDate());
  const diffDays = Math.round((startOfToday.getTime() - startOfTarget.getTime()) / (1000 * 60 * 60 * 24));

  if (diffDays === 0) return "сегодня";
  if (diffDays > 0 && diffDays < 7) return `${diffDays} д.`;

  return targetDate
    .toLocaleDateString("ru-RU", {
      day: "numeric",
      month: "short",
    })
    .replace(/\.$/, "");
}

export function CommunityNewsCard({
  card,
  likes,
  commentsCount,
  reaction,
  onLike,
  onOpen,
  onEdit,
}: CommunityNewsCardProps) {
  const previewText = (card.previewText || card.text || card.title).trim();
  const authorName = (card.author.name || "Сообщество").trim() || "Сообщество";
  const authorHandle = buildAuthorHandle(authorName);
  const badgeText = getBadgeText(card.badgeLabel);
  const publishedLabel = formatPublishedLabel(card.publishedAt);
  const avatarSrc = card.author.avatarUrl || card.author.avatar || "";
  const titleLabel = card.title.trim() || "Новость сообщества";
  const mediaSrc = (card.imageUrl || card.media || "").trim();
  const hasMedia = Boolean(mediaSrc);

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
      className={`community-feed-card--interactive community-feed-card--news-feed${hasMedia ? "" : " community-feed-card--news-feed-no-media"}`}
      onClick={onOpen}
      onKeyDown={handleCardKeyDown}
      role="button"
      tabIndex={0}
      aria-label={`Открыть новость: ${titleLabel}`}
    >
      <div className="community-news-feed-header">
        <div className="community-news-feed-author">
          <div className="community-news-feed-avatar">
            <AvatarImageOrInitials src={avatarSrc} name={authorName} imageClassName="community-news-feed-avatar-image" fallbackClassName="community-news-feed-avatar-fallback" />
          </div>

          <div className="community-news-feed-author-copy">
            <div className="community-news-feed-author-line">
              <span className="community-news-feed-author-name">{authorName}</span>
              <span className="community-news-feed-badge">{badgeText}</span>
            </div>
            <span className="community-news-feed-handle">{authorHandle}</span>
          </div>
        </div>

        {card.canEdit && onEdit ? (
          <button
            type="button"
            className="community-news-feed-edit"
            onClick={(event) => handleControlClick(event, onEdit)}
            aria-label="Редактировать новость"
          >
            Редактировать
          </button>
        ) : (
          <div className="community-news-feed-more" aria-hidden="true">
            <MoreIcon className="community-news-feed-more-icon" />
          </div>
        )}
      </div>

      <div className="community-news-feed-body">
        <p className="community-news-feed-text">{previewText}</p>

        {hasMedia ? (
          <div className="community-news-feed-media">
            <div className="community-feed-media community-feed-media--news">
              <img
                src={mediaSrc}
                alt={titleLabel}
                className="community-news-feed-media-image"
              />
            </div>
          </div>
        ) : null}

        <div className="community-news-feed-footer">
          <div className="community-news-feed-actions">
            <button
              type="button"
              className={`community-news-feed-action community-news-feed-action--like${reaction === "like" ? " is-active" : ""}`}
              onClick={(event) => handleControlClick(event, onLike)}
              aria-label={reaction === "like" ? "Убрать лайк у новости" : "Поставить лайк новости"}
            >
              <HeartIcon className="community-news-feed-action-icon" />
              <span>{likes}</span>
            </button>
            <button
              type="button"
              className="community-news-feed-action community-news-feed-action--comments"
              onClick={(event) => handleControlClick(event, onOpen)}
              aria-label="Открыть обсуждение новости"
            >
              <ChatIcon className="community-news-feed-action-icon" />
              <span>{commentsCount}</span>
            </button>
          </div>

          {publishedLabel ? <span className="community-news-feed-age">{publishedLabel}</span> : null}
        </div>
      </div>
    </CommunityFeedCardBase>
  );
}
