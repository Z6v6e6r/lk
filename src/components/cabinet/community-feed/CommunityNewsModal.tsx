import { useEffect, useMemo, useRef, useState } from "react";
import { Modal } from "../../UI/Modal";
import type { KeyboardEvent } from "react";
import { ChatIcon, ThumbsDownIcon, ThumbsUpIcon } from "./CommunityIcons";
import { communityPlaceholderImages } from "./communityMedia";
import type { CommunityNewsCard, NewsComment, NewsReaction } from "./feedTypes";
import { renderNewsTextParagraph } from "./newsTextFormatting";

interface CommunityNewsModalProps {
  isOpen: boolean;
  news: CommunityNewsCard | null;
  likes: number;
  dislikes: number;
  commentsCount: number;
  comments: NewsComment[];
  reaction: NewsReaction;
  isCommentsLoading?: boolean;
  commentsError?: string | null;
  onClose: () => void;
  onLike: () => void;
  onDislike: () => void;
  onSubmitComment: (text: string) => Promise<boolean> | boolean;
}

function formatCommentTime(value: string) {
  const parsed = Date.parse(value);
  if (!Number.isFinite(parsed)) return "только что";
  return new Date(parsed).toLocaleString("ru-RU", {
    day: "numeric",
    month: "short",
    hour: "2-digit",
    minute: "2-digit",
  });
}

export function CommunityNewsModal({
  isOpen,
  news,
  likes,
  dislikes,
  commentsCount,
  comments,
  reaction,
  isCommentsLoading = false,
  commentsError = null,
  onClose,
  onLike,
  onDislike,
  onSubmitComment,
}: CommunityNewsModalProps) {
  const [draft, setDraft] = useState("");
  const commentsListRef = useRef<HTMLDivElement | null>(null);
  const fullText = (news?.fullText || news?.text || "").trim();

  const paragraphs = useMemo(
    () => fullText
      .split(/\n{2,}/)
      .map((part) => part.trim())
      .filter(Boolean),
    [fullText],
  );

  useEffect(() => {
    if (!isOpen) {
      setDraft("");
      return;
    }
    setDraft("");
  }, [isOpen, news?.id]);

  useEffect(() => {
    if (!isOpen) return;
    const node = commentsListRef.current;
    if (!node) return;
    node.scrollTo({ top: node.scrollHeight, behavior: "smooth" });
  }, [comments.length, isOpen]);

  if (!news) return null;

  const handleSubmit = async () => {
    const value = draft.trim();
    if (!value) return;
    const wasSubmitted = await onSubmitComment(value);
    if (wasSubmitted === false) return;
    setDraft("");
  };

  const handleDraftKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    if (event.key !== "Enter" || (!event.ctrlKey && !event.metaKey)) return;
    event.preventDefault();
    void handleSubmit();
  };

  return (
    <Modal
      isOpen={isOpen}
      onClose={onClose}
      title={news.title}
      bodyClassName="modal-body--news"
      variant="dialog"
    >
      <div className="community-news-modal">
        <div className="community-news-modal-media">
          <div className="community-news-modal-media-frame">
            <img
              src={news.imageUrl || news.media || communityPlaceholderImages.news}
              alt={news.title}
              className="community-news-modal-image"
            />
          </div>
        </div>

        <div className="community-news-modal-meta">
          <div className="community-feed-card-badge community-feed-card-badge--news">
            <span>{news.badgeLabel}</span>
          </div>
          <div className="community-news-modal-author">
            <strong>{news.author.name}</strong>
            <span>Лента сообщества</span>
          </div>
        </div>

        <div className="community-news-modal-actions">
          <button
            type="button"
            className={`community-feed-news-vote community-feed-news-vote--like${reaction === "like" ? " is-active" : ""}`}
            onClick={onLike}
            aria-label="Поставить лайк новости"
          >
            <ThumbsUpIcon className="community-feed-news-vote-icon" />
            <span>{likes}</span>
          </button>
          <button
            type="button"
            className={`community-feed-news-vote community-feed-news-vote--dislike${reaction === "dislike" ? " is-active" : ""}`}
            onClick={onDislike}
            aria-label="Поставить дизлайк новости"
          >
            <ThumbsDownIcon className="community-feed-news-vote-icon" />
            <span>{dislikes}</span>
          </button>
          <div className="community-feed-news-stat community-feed-news-stat--modal">
            <ChatIcon className="community-feed-news-stat-icon" />
            <span>{commentsCount} комментариев</span>
          </div>
        </div>

        <div className="community-news-modal-body">
          <h4 className="community-news-modal-section-title">Описание</h4>
          {(paragraphs.length > 0 ? paragraphs : [fullText]).map((paragraph, index) => (
            <p key={`${news.id}-paragraph-${index}`}>
              {renderNewsTextParagraph(paragraph, `${news.id}-paragraph-${index}`)}
            </p>
          ))}
        </div>

        <section className="community-news-comments" aria-label="Комментарии к новости">
          {(commentsError || (isCommentsLoading && comments.length === 0) || comments.length > 0) && (
            <div ref={commentsListRef} className="community-news-comments-list">
              {commentsError ? (
                <div className="community-form-error">{commentsError}</div>
              ) : isCommentsLoading && comments.length === 0 ? (
                <div className="community-loading-note">Загружаем обсуждение новости…</div>
              ) : comments.map((comment) => (
                <article
                  key={comment.id}
                  className={`community-news-comment${comment.isOwn ? " is-own" : ""}`}
                >
                  <div className="community-news-comment-top">
                    <strong>{comment.authorName}</strong>
                    <span>{formatCommentTime(comment.createdAt)}</span>
                  </div>
                  <p>{comment.text}</p>
                </article>
              ))}
            </div>
          )}

          <div className="community-news-comment-form">
            <textarea
              className="community-news-comment-input"
              value={draft}
              onChange={(event) => setDraft(event.target.value)}
              onKeyDown={handleDraftKeyDown}
              placeholder="Напишите комментарий"
              rows={3}
            />
            <div className="community-news-comment-form-footer">
              <span className="community-news-comment-hint">Ctrl/Cmd + Enter для отправки</span>
              <button
                type="button"
                className="community-feed-cta community-feed-cta--primary community-news-comment-submit"
                onClick={() => {
                  void handleSubmit();
                }}
                disabled={!draft.trim()}
              >
                Отправить
              </button>
            </div>
          </div>
        </section>
      </div>
    </Modal>
  );
}
