import { CommunityFeedCardBase } from "./CommunityFeedCardBase";
import { ChevronRightIcon } from "./CommunityIcons";
import { getInitials } from "./feedFormatters";
import type { CommunityUserJoinedCard as CommunityUserJoinedCardData } from "./feedTypes";

interface CommunityUserJoinedCardProps {
  card: CommunityUserJoinedCardData;
  onOpen: () => void;
  onAddFriend: () => void;
  onMessage: () => void;
}

export function CommunityUserJoinedCard({
  card,
  onOpen,
  onAddFriend,
  onMessage,
}: CommunityUserJoinedCardProps) {
  return (
    <CommunityFeedCardBase variant="system">
      <div className="community-user-card-top">
        <div className="community-feed-user-joined">
          <div className="community-feed-user-avatar">
            {card.user.avatarUrl || card.user.avatar ? (
              <img
                src={card.user.avatarUrl || card.user.avatar}
                alt={card.user.name}
                className="community-feed-user-avatar-image"
              />
            ) : (
              <span>{getInitials(card.user.name)}</span>
            )}
            <span className="community-feed-user-avatar-badge" aria-hidden="true">◉</span>
          </div>

          <div className="community-feed-user-copy">
            <div className="community-feed-card-badge community-feed-card-badge--muted">{card.badgeLabel}</div>
            <h3 className="community-feed-card-title community-feed-card-title--compact">{card.user.name}</h3>
            <p className="community-feed-card-copy community-feed-card-copy--tight">{card.subtitle}</p>
          </div>
        </div>

        <button type="button" className="community-feed-cta community-feed-cta--primary" onClick={onOpen}>
          <span>Открыть</span>
          <ChevronRightIcon className="community-feed-cta-arrow" />
        </button>
      </div>

      <div className="community-feed-dual-actions">
        <button type="button" className="community-feed-cta community-feed-cta--secondary" onClick={onAddFriend}>
          Добавить в друзья
        </button>
        <button type="button" className="community-feed-cta community-feed-cta--secondary" onClick={onMessage}>
          Написать
        </button>
      </div>
    </CommunityFeedCardBase>
  );
}
