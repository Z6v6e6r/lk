import { FeedCardWrapper } from "./FeedCardWrapper";
import type { News } from "./feedTypes";

interface FeedCardNewsProps {
  news: News;
  onOpen: () => void;
}

export function FeedCardNews({ news, onOpen }: FeedCardNewsProps) {
  const previewText = (news.previewText || news.text).trim();

  return (
    <FeedCardWrapper variant="news">
      <div className="community-feed-card-head">
        <span className="community-feed-card-kicker community-feed-card-kicker--muted">📰 Новость</span>
      </div>

      <div className="community-feed-card-title community-feed-card-title--compact">{news.title}</div>
      {previewText && (
        <div className="community-feed-card-copy community-feed-card-copy--news">
          {previewText}
        </div>
      )}

      {news.media && (
        <div className="community-feed-media community-feed-media--news">
          <img src={news.media} alt={news.title} className="community-feed-media-image" />
        </div>
      )}

      <div className="community-feed-news-meta">
        <span>❤ {news.likes}</span>
        <span>💬 {news.comments}</span>
        <span>{news.author.name}</span>
      </div>

      <button type="button" className="community-feed-cta community-feed-cta--secondary" onClick={onOpen}>
        Открыть
      </button>
    </FeedCardWrapper>
  );
}
