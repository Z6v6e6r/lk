import { FeedCardWrapper } from "./FeedCardWrapper";
import { formatRelativePublishedLabel, getInitials } from "./feedFormatters";
import type { UserJoined } from "./feedTypes";

interface FeedCardUserJoinedProps {
  item: UserJoined;
  onAddFriend: () => void;
  onMessage: () => void;
}

export function FeedCardUserJoined({ item, onAddFriend, onMessage }: FeedCardUserJoinedProps) {
  return (
    <FeedCardWrapper variant="system">
      <div className="community-feed-card-head">
        <span className="community-feed-card-kicker community-feed-card-kicker--muted">👋 Новый участник</span>
      </div>

      <div className="community-feed-user-joined">
        <div className="community-feed-user-avatar">
          {item.user.avatar ? (
            <img src={item.user.avatar} alt={item.user.name} className="community-feed-user-avatar-image" />
          ) : (
            <span>{getInitials(item.user.name)}</span>
          )}
        </div>

        <div className="community-feed-user-copy">
          <div className="community-feed-card-title community-feed-card-title--compact">{item.user.name}</div>
          <div className="community-feed-card-copy community-feed-card-copy--tight">
            присоединился к сообществу • {formatRelativePublishedLabel(item.joinedAt)}
          </div>
        </div>
      </div>

      <div className="community-feed-dual-actions">
        <button type="button" className="community-feed-cta community-feed-cta--ghost" onClick={onAddFriend}>
          Добавить в друзья
        </button>
        <button type="button" className="community-feed-cta community-feed-cta--ghost" onClick={onMessage}>
          Написать
        </button>
      </div>
    </FeedCardWrapper>
  );
}
