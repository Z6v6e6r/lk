import {
  useEffect,
  useId,
  useLayoutEffect,
  useRef,
  useState,
  type CSSProperties,
  type FormEventHandler,
  type KeyboardEventHandler,
  type ReactNode,
  type RefObject,
  type UIEventHandler,
} from "react";
import type { CommunityChatMessage, CommunityRecord } from "../../../utils/communityApi";
import { MembersCountIcon } from "./CommunityIcons";
import { CommunitySecondaryNav, type CommunitySecondaryNavItemId } from "./CommunitySecondaryNav";
import { formatFeedDayLabel, formatFeedTimeLabel, getInitials } from "./feedFormatters";
import { CommunityBottomNav } from "./CommunityBottomNav";
import type { CommunityBottomNavItemId } from "./feedTypes";

interface CommunityChatScreenProps {
  community: Pick<
    CommunityRecord,
    "name" | "logo" | "memberCount" | "joinRule"
  >;
  messages: CommunityChatMessage[];
  isLoading: boolean;
  hasMore: boolean;
  isLoadingMore: boolean;
  isSending: boolean;
  error: string | null;
  draft: string;
  canSend: boolean;
  unreadCount: number;
  unreadBadgeCount: number;
  currentUserId: string | null;
  currentUserPhone: string | null;
  scrollRef: RefObject<HTMLDivElement | null>;
  onScroll: UIEventHandler<HTMLDivElement>;
  onDraftChange: (value: string) => void;
  onSubmit: FormEventHandler<HTMLFormElement>;
  onOpenMenu: () => void;
  onClose: () => void;
  onSelectSectionNav: (itemId: CommunitySecondaryNavItemId) => void;
  onSelectBottomNav: (itemId: CommunityBottomNavItemId) => void;
  navActionSlot?: ReactNode;
  joinActionLabel?: string | null;
  isJoinActionLoading?: boolean;
  onJoinAction?: (() => void) | null;
}

type ChatDisplayItem =
  | { type: "day"; key: string; label: string }
  | {
      type: "series";
      key: string;
      isMine: boolean;
      messages: Array<{ key: string; message: CommunityChatMessage }>;
    };

const COMMUNITY_CHAT_KEYBOARD_THRESHOLD = 120;

function getCommunityChatKeyboardInset() {
  if (typeof window === "undefined") return 0;

  const visualViewport = window.visualViewport;
  if (!visualViewport) return 0;

  return Math.max(
    0,
    window.innerHeight - (visualViewport.height + visualViewport.offsetTop),
  );
}

function normalizeMessageTs(message: CommunityChatMessage) {
  if (Number.isFinite(message.createdTs) && message.createdTs > 0) {
    return message.createdTs;
  }

  const parsed = Date.parse(message.createdAt);
  return Number.isFinite(parsed) ? parsed : 0;
}

function normalizeIdentity(value: string | null | undefined) {
  const normalized = String(value || "").trim();
  return normalized || null;
}

function normalizePhone(value: string | null | undefined) {
  const digits = String(value || "").replace(/\D/g, "");
  if (!digits) return null;
  if (digits.length === 10) return `7${digits}`;
  if (digits.length === 11 && digits.startsWith("8")) return `7${digits.slice(1)}`;
  return digits;
}

function isSameCalendarDay(leftTs: number, rightTs: number) {
  if (!leftTs || !rightTs) return false;

  const leftDate = new Date(leftTs);
  const rightDate = new Date(rightTs);
  return leftDate.getFullYear() === rightDate.getFullYear()
    && leftDate.getMonth() === rightDate.getMonth()
    && leftDate.getDate() === rightDate.getDate();
}

function buildNickname(name: string) {
  const compact = name
    .toLowerCase()
    .replace(/ё/g, "е")
    .replace(/[^a-zа-я0-9]+/gi, "");

  return `@${compact || "никнейм"}`;
}

function formatMemberCount(value: number) {
  const mod10 = value % 10;
  const mod100 = value % 100;

  if (mod10 === 1 && mod100 !== 11) return `${value} участник`;
  if (mod10 >= 2 && mod10 <= 4 && (mod100 < 12 || mod100 > 14)) return `${value} участника`;
  return `${value} участников`;
}

function getMemberCountParts(value: number) {
  const formatted = formatMemberCount(value);
  const separatorIndex = formatted.indexOf(" ");

  if (separatorIndex === -1) {
    return { count: formatted, label: "" };
  }

  return {
    count: formatted.slice(0, separatorIndex),
    label: formatted.slice(separatorIndex + 1),
  };
}

function getJoinLabel(community: Pick<CommunityRecord, "joinRule">, joinActionLabel?: string | null) {
  if (joinActionLabel) return joinActionLabel;
  return community.joinRule === "MODERATED" ? "Подать заявку" : "Вступить";
}

function isMineMessage(
  message: CommunityChatMessage,
  currentUserId: string | null,
  currentUserPhone: string | null,
) {
  const authorId = normalizeIdentity(message.authorId);
  const authorPhone = normalizePhone(message.authorPhone);

  return Boolean(
    (authorId && currentUserId && authorId === currentUserId)
    || (authorPhone && currentUserPhone && authorPhone === currentUserPhone),
  );
}

function areMessagesFromSameAuthor(left: CommunityChatMessage | null, right: CommunityChatMessage) {
  if (!left) return false;

  const leftAuthorId = normalizeIdentity(left.authorId);
  const rightAuthorId = normalizeIdentity(right.authorId);
  if (leftAuthorId && rightAuthorId && leftAuthorId === rightAuthorId) {
    return true;
  }

  const leftAuthorPhone = normalizePhone(left.authorPhone);
  const rightAuthorPhone = normalizePhone(right.authorPhone);
  return Boolean(
    leftAuthorPhone
    && rightAuthorPhone
    && leftAuthorPhone === rightAuthorPhone,
  );
}

function buildChatDisplayItems(
  messages: CommunityChatMessage[],
  currentUserId: string | null,
  currentUserPhone: string | null,
): ChatDisplayItem[] {
  const items: ChatDisplayItem[] = [];
  const normalizedCurrentUserId = normalizeIdentity(currentUserId);
  const normalizedCurrentUserPhone = normalizePhone(currentUserPhone);
  let currentSeries: Extract<ChatDisplayItem, { type: "series" }> | null = null;

  const pushCurrentSeries = () => {
    if (!currentSeries) return;
    items.push(currentSeries);
    currentSeries = null;
  };

  messages.forEach((message, index) => {
    const previousMessage = index > 0 ? messages[index - 1] : null;
    const messageTs = normalizeMessageTs(message);
    const previousTs = previousMessage ? normalizeMessageTs(previousMessage) : 0;
    const hasDayBreak = !previousMessage || !isSameCalendarDay(messageTs, previousTs);
    const isMine = isMineMessage(message, normalizedCurrentUserId, normalizedCurrentUserPhone);

    if (hasDayBreak) {
      pushCurrentSeries();
      items.push({
        type: "day",
        key: `day:${message.id || messageTs || index}`,
        label: formatFeedDayLabel(message.createdAt),
      });
    }

    const canContinueSeries = Boolean(
      previousMessage
      && !hasDayBreak
      && currentSeries
      && currentSeries.isMine === isMine
      && areMessagesFromSameAuthor(previousMessage, message),
    );

    if (!canContinueSeries || !currentSeries) {
      pushCurrentSeries();
      currentSeries = {
        type: "series",
        key: `series:${message.id || messageTs || index}`,
        isMine,
        messages: [],
      };
    }

    currentSeries.messages.push({
      key: message.id || `message:${messageTs}:${index}`,
      message,
    });
  });

  pushCurrentSeries();
  return items;
}

function CircleBackIcon() {
  return (
    <svg viewBox="0 0 24 24" className="community-chat-figma-circle-icon" aria-hidden="true">
      <path d="M14.75 6.5 9.25 12l5.5 5.5" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

function CircleMoreIcon() {
  return (
    <svg viewBox="0 0 24 24" className="community-chat-figma-circle-icon" aria-hidden="true">
      <circle cx="6" cy="12" r="1.4" fill="currentColor" />
      <circle cx="12" cy="12" r="1.4" fill="currentColor" />
      <circle cx="18" cy="12" r="1.4" fill="currentColor" />
    </svg>
  );
}

function AttachPlusIcon({ className }: { className?: string }) {
  const clipId = useId().replace(/:/g, "");

  return (
    <svg viewBox="0 0 32 32" className={className} aria-hidden="true" fill="none">
      <defs>
        <clipPath id={clipId}>
          <circle cx="16" cy="16" r="16" />
        </clipPath>
      </defs>

      <g clipPath={`url(#${clipId})`}>
        <foreignObject x="0" y="0" width="32" height="32">
          <div
            style={{
              width: "100%",
              height: "100%",
              background:
                "conic-gradient(from 90deg, rgba(255, 255, 255, 1) 0deg, rgba(241, 241, 241, 1) 86.8865deg, rgba(255, 255, 255, 1) 174.792deg, rgba(241, 241, 241, 1) 271.789deg, rgba(255, 255, 255, 1) 360deg)",
            }}
          />
        </foreignObject>
      </g>

      <circle cx="16" cy="16" r="15.5" fill="#FAFAFA" />
      <path d="M14 16.6666H10.6667C10.2985 16.6666 10 16.3681 10 15.9999C10 15.6317 10.2985 15.3333 10.6667 15.3333H14V16.6666Z" fill="#353436" />
      <path d="M21.3333 15.3333C21.7015 15.3333 22 15.6317 22 15.9999C22 16.3681 21.7015 16.6666 21.3333 16.6666H15.3333V15.3333H21.3333Z" fill="#353436" />
      <path d="M16.6678 21.3333C16.6678 21.7015 16.3693 22 16.0011 22C15.6329 22 15.3345 21.7015 15.3345 21.3333V15.3333H16.6678V21.3333Z" fill="#353436" />
      <path d="M16.0011 10C16.3693 10 16.6678 10.2985 16.6678 10.6667V14H15.3345V10.6667C15.3345 10.2985 15.6329 10 16.0011 10Z" fill="#353436" />
    </svg>
  );
}

function SendIcon() {
  return (
    <svg viewBox="0 0 32 32" className="community-chat-figma-send-icon" aria-hidden="true" fill="none">
      <circle cx="16" cy="16" r="16" fill="#8766EB" />
      <path
        d="M16 24V8"
        fill="none"
        stroke="#FAFAFA"
        strokeWidth="1.5"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
      <path
        d="M12 12L16 8L20 12"
        fill="none"
        stroke="#FAFAFA"
        strokeWidth="1.5"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

function DoubleCheckIcon() {
  return (
    <svg viewBox="0 0 12 12" className="community-chat-figma-double-check" aria-hidden="true">
      <path d="M1.65 6.25 3.2 7.8l2.8-2.8" fill="none" stroke="currentColor" strokeWidth="0.85" strokeLinecap="round" strokeLinejoin="round" />
      <path d="M5.1 6.25 6.65 7.8l3.1-3.1" fill="none" stroke="currentColor" strokeWidth="0.85" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

function ChatHeader({
  community,
  unreadCount,
  onClose,
  onOpenMenu,
  onSelectSection,
}: {
  community: Pick<CommunityRecord, "name" | "logo" | "memberCount">;
  unreadCount: number;
  onClose: () => void;
  onOpenMenu: () => void;
  onSelectSection: (itemId: CommunitySecondaryNavItemId) => void;
}) {
  const memberCountParts = getMemberCountParts(community.memberCount);

  return (
    <header className="community-chat-figma-header">
      <div className="community-chat-figma-topbar">
        <button
          type="button"
          className="community-chat-figma-circle-button"
          onClick={onClose}
          aria-label="Назад"
        >
          <CircleBackIcon />
        </button>

        <div
          className="community-chat-figma-summary"
          aria-label={`${community.name}, ${formatMemberCount(community.memberCount)}${unreadCount > 0 ? `, новых сообщений ${unreadCount}` : ""}`}
        >
          <div className="community-chat-figma-avatar">
            {community.logo ? (
              <img src={community.logo} alt={community.name} className="community-chat-figma-avatar-image" />
            ) : (
              <span className="community-chat-figma-avatar-fallback">{getInitials(community.name)}</span>
            )}
          </div>

          <div className="community-chat-figma-summary-copy">
            <h1 className="community-chat-figma-summary-title">{community.name}</h1>
            <div className="community-chat-figma-summary-count-row">
              <span className="community-chat-figma-summary-count">{memberCountParts.count}</span>
              <MembersCountIcon className="community-chat-figma-summary-members-icon" />
              <span className="community-chat-figma-summary-count-label">{memberCountParts.label}</span>
            </div>
          </div>
        </div>

        <button
          type="button"
          className="community-chat-figma-circle-button"
          onClick={onOpenMenu}
          aria-label="Открыть меню сообщества"
        >
          <CircleMoreIcon />
        </button>
      </div>

      <CommunitySecondaryNav activeItem="chat" onSelect={onSelectSection} />
    </header>
  );
}

function DayDivider({ label }: { label: string }) {
  return (
    <div className="community-chat-figma-day-row">
      <div className="community-chat-figma-day-chip">{label}</div>
    </div>
  );
}

function IncomingMessageBubble({
  message,
  showAvatar,
  showAuthorMeta,
  showTail,
}: {
  message: CommunityChatMessage;
  showAvatar: boolean;
  showAuthorMeta: boolean;
  showTail: boolean;
}) {
  return (
    <div className="community-chat-figma-row">
      <div className="community-chat-figma-message-avatar-slot" aria-hidden={showAvatar ? undefined : "true"}>
        {showAvatar ? (
          <div className="community-chat-figma-message-avatar">
            {message.authorAvatar ? (
              <img
                src={message.authorAvatar}
                alt={message.authorName}
                className="community-chat-figma-message-avatar-image"
              />
            ) : (
              getInitials(message.authorName)
            )}
          </div>
        ) : null}
      </div>

      <div className="community-chat-figma-bubble community-chat-figma-bubble--other">
        {showAuthorMeta ? (
          <div className="community-chat-figma-author-row">
            <span className="community-chat-figma-author-name">{message.authorName}</span>
            <span className="community-chat-figma-author-handle">{buildNickname(message.authorName)}</span>
          </div>
        ) : null}

        <div className="community-chat-figma-message-text">{message.text}</div>

        <div className="community-chat-figma-bubble-meta">
          <span className="community-chat-figma-bubble-time">{formatFeedTimeLabel(message.createdAt)}</span>
        </div>

        {showTail ? <div className="community-chat-figma-bubble-tail" aria-hidden="true" /> : null}
      </div>
    </div>
  );
}

function OutgoingMessageBubble({
  message,
  showTail,
}: {
  message: CommunityChatMessage;
  showTail: boolean;
}) {
  return (
    <div className="community-chat-figma-row community-chat-figma-row--mine">
      <div className="community-chat-figma-bubble community-chat-figma-bubble--mine">
        <div className="community-chat-figma-message-text">{message.text}</div>

        <div className="community-chat-figma-delivery">
          <span className="community-chat-figma-delivery-time">
            {formatFeedTimeLabel(message.createdAt)}
          </span>
          <DoubleCheckIcon />
        </div>

        {showTail ? (
          <div className="community-chat-figma-bubble-tail community-chat-figma-bubble-tail--mine" aria-hidden="true" />
        ) : null}
      </div>
    </div>
  );
}

function ChatSeries({
  isMine,
  messages,
}: {
  isMine: boolean;
  messages: Array<{ key: string; message: CommunityChatMessage }>;
}) {
  return (
    <div className={`community-chat-figma-series${isMine ? " community-chat-figma-series--mine" : ""}`}>
      {messages.map((item, index) => {
        const isFirstInSeries = index === 0;
        const isLastInSeries = index === messages.length - 1;

        if (isMine) {
          return (
            <OutgoingMessageBubble
              key={item.key}
              message={item.message}
              showTail={isLastInSeries}
            />
          );
        }

        return (
          <IncomingMessageBubble
            key={item.key}
            message={item.message}
            showAvatar={isFirstInSeries}
            showAuthorMeta={isFirstInSeries}
            showTail={isLastInSeries}
          />
        );
      })}
    </div>
  );
}

function ChatMessageList({
  messages,
  isLoading,
  hasMore,
  isLoadingMore,
  error,
  currentUserId,
  currentUserPhone,
  scrollRef,
  onScroll,
}: {
  messages: CommunityChatMessage[];
  isLoading: boolean;
  hasMore: boolean;
  isLoadingMore: boolean;
  error: string | null;
  currentUserId: string | null;
  currentUserPhone: string | null;
  scrollRef: RefObject<HTMLDivElement | null>;
  onScroll: UIEventHandler<HTMLDivElement>;
}) {
  const displayItems = buildChatDisplayItems(messages, currentUserId, currentUserPhone);

  return (
    <section className="community-chat-figma-feed-shell">
      {error ? <div className="community-form-error community-chat-figma-error">{error}</div> : null}

      <div className="community-chat-figma-feed">
        <div className="community-chat-figma-scroll" ref={scrollRef} onScroll={onScroll}>
          {(hasMore || isLoadingMore) && (
            <div className="community-chat-figma-status">
              {isLoadingMore
                ? "Загружаем предыдущие сообщения..."
                : "Прокрути вверх, чтобы загрузить предыдущие сообщения"}
            </div>
          )}

          {isLoading && messages.length === 0 ? (
            <div className="community-loading-note">Загружаем сообщения чата...</div>
          ) : messages.length === 0 ? (
            <div className="community-empty-note">В чате пока нет сообщений.</div>
          ) : (
            <div className="community-chat-figma-list">
              {displayItems.map((item) => {
                if (item.type === "day") {
                  return <DayDivider key={item.key} label={item.label} />;
                }

                return (
                  <ChatSeries
                    key={item.key}
                    isMine={item.isMine}
                    messages={item.messages}
                  />
                );
              })}
            </div>
          )}
        </div>

        <div className="community-chat-figma-scroll-fade" aria-hidden="true" />
      </div>
    </section>
  );
}

function ChatComposer({
  community,
  draft,
  canSend,
  isSending,
  onDraftChange,
  onSubmit,
  onFocusChange,
  joinActionLabel,
  isJoinActionLoading,
  onJoinAction,
}: {
  community: Pick<CommunityRecord, "joinRule">;
  draft: string;
  canSend: boolean;
  isSending: boolean;
  onDraftChange: (value: string) => void;
  onSubmit: FormEventHandler<HTMLFormElement>;
  onFocusChange?: (isFocused: boolean) => void;
  joinActionLabel?: string | null;
  isJoinActionLoading: boolean;
  onJoinAction?: (() => void) | null;
}) {
  const textareaRef = useRef<HTMLTextAreaElement | null>(null);
  const hasDraft = draft.trim().length > 0;

  useLayoutEffect(() => {
    const textarea = textareaRef.current;
    if (!textarea) return;

    textarea.style.height = "0px";
    const styles = window.getComputedStyle(textarea);
    const lineHeight = Number.parseFloat(styles.lineHeight) || 20;
    const paddingTop = Number.parseFloat(styles.paddingTop) || 0;
    const paddingBottom = Number.parseFloat(styles.paddingBottom) || 0;
    const borderTop = Number.parseFloat(styles.borderTopWidth) || 0;
    const borderBottom = Number.parseFloat(styles.borderBottomWidth) || 0;
    const maxHeight = (lineHeight * 4) + paddingTop + paddingBottom + borderTop + borderBottom;
    const nextHeight = Math.min(textarea.scrollHeight, maxHeight);

    textarea.style.height = `${nextHeight}px`;
    textarea.style.overflowY = textarea.scrollHeight > maxHeight ? "auto" : "hidden";
  }, [draft]);

  const handleInputKeyDown: KeyboardEventHandler<HTMLTextAreaElement> = (event) => {
    if (event.key !== "Enter" || event.shiftKey) return;
    event.preventDefault();
    event.currentTarget.form?.requestSubmit();
  };

  return (
    <section
      className={`community-chat-figma-compose-section${hasDraft ? " community-chat-figma-compose-section--with-value" : ""}`}
    >
      {!canSend ? (
        <div className="community-chat-figma-join-notice">
          <div className="community-chat-figma-join-copy">
            Чтобы писать в чат, нужно вступить в сообщество.
          </div>

          {onJoinAction ? (
            <button
              type="button"
              className="community-chat-figma-join-action"
              onClick={onJoinAction}
              disabled={isJoinActionLoading}
            >
              {isJoinActionLoading ? "Подключаем..." : getJoinLabel(community, joinActionLabel)}
            </button>
          ) : null}
        </div>
      ) : null}

      <form
        className={`community-chat-figma-compose${!canSend ? " is-disabled" : ""}`}
        onSubmit={onSubmit}
      >
        <div className={`community-chat-figma-compose-shell${hasDraft ? " has-value" : ""}`}>
          <button
            type="button"
            className="community-chat-figma-attach-button"
            aria-label="Добавить файл"
            disabled
          >
            <AttachPlusIcon className="community-chat-figma-attach-icon" />
          </button>

          <textarea
            ref={textareaRef}
            className="community-chat-figma-input"
            value={draft}
            onChange={(event) => onDraftChange(event.target.value)}
            onFocus={() => onFocusChange?.(true)}
            onBlur={() => onFocusChange?.(false)}
            onKeyDown={handleInputKeyDown}
            placeholder="Введите сообщение"
            disabled={!canSend || isSending}
            rows={1}
          />

          {hasDraft ? (
            <button
              type="submit"
              className="community-chat-figma-send-button"
              aria-label="Отправить сообщение"
              disabled={!canSend || isSending}
            >
              <SendIcon />
            </button>
          ) : null}
        </div>
      </form>
    </section>
  );
}

function ChatBottomNav({
  unreadBadgeCount,
  onSelectBottomNav,
  navActionSlot,
}: {
  unreadBadgeCount: number;
  onSelectBottomNav: (itemId: CommunityBottomNavItemId) => void;
  navActionSlot?: ReactNode;
}) {
  return (
    <div className="community-chat-figma-nav-shell">
      <CommunityBottomNav
        activeItem="chat"
        chatBadgeCount={unreadBadgeCount}
        onSelect={onSelectBottomNav}
        actionSlot={navActionSlot}
        layout="static"
      />
    </div>
  );
}

export function CommunityChatScreen({
  community,
  messages,
  isLoading,
  hasMore,
  isLoadingMore,
  isSending,
  error,
  draft,
  canSend,
  unreadCount,
  unreadBadgeCount,
  currentUserId,
  currentUserPhone,
  scrollRef,
  onScroll,
  onDraftChange,
  onSubmit,
  onOpenMenu,
  onClose,
  onSelectSectionNav,
  onSelectBottomNav,
  navActionSlot,
  joinActionLabel,
  isJoinActionLoading = false,
  onJoinAction,
}: CommunityChatScreenProps) {
  const [keyboardInset, setKeyboardInset] = useState(0);
  const [isComposerFocused, setIsComposerFocused] = useState(false);

  useEffect(() => {
    if (typeof window === "undefined") return undefined;

    const visualViewport = window.visualViewport;

    const updateKeyboardInset = () => {
      const nextInset = getCommunityChatKeyboardInset();
      setKeyboardInset(nextInset >= COMMUNITY_CHAT_KEYBOARD_THRESHOLD ? nextInset : 0);
    };

    updateKeyboardInset();

    visualViewport?.addEventListener("resize", updateKeyboardInset);
    visualViewport?.addEventListener("scroll", updateKeyboardInset);
    window.addEventListener("resize", updateKeyboardInset);
    window.addEventListener("orientationchange", updateKeyboardInset);

    return () => {
      visualViewport?.removeEventListener("resize", updateKeyboardInset);
      visualViewport?.removeEventListener("scroll", updateKeyboardInset);
      window.removeEventListener("resize", updateKeyboardInset);
      window.removeEventListener("orientationchange", updateKeyboardInset);
    };
  }, []);

  const isKeyboardOpen = keyboardInset > 0 || isComposerFocused;
  const chatScreenStyle = {
    "--community-chat-keyboard-offset": `${keyboardInset}px`,
  } as CSSProperties;

  return (
    <div
      className={`community-feed-screen community-chat-screen community-chat-figma-screen${isKeyboardOpen ? " community-chat-figma-screen--keyboard-open" : ""}`}
      style={chatScreenStyle}
    >
      <div className="community-feed-screen-glow" aria-hidden="true" />

      <ChatHeader
        community={community}
        unreadCount={unreadCount}
        onClose={onClose}
        onOpenMenu={onOpenMenu}
        onSelectSection={onSelectSectionNav}
      />

      <ChatMessageList
        messages={messages}
        isLoading={isLoading}
        hasMore={hasMore}
        isLoadingMore={isLoadingMore}
        error={error}
        currentUserId={currentUserId}
        currentUserPhone={currentUserPhone}
        scrollRef={scrollRef}
        onScroll={onScroll}
      />

      <ChatComposer
        community={community}
        draft={draft}
        canSend={canSend}
        isSending={isSending}
        onDraftChange={onDraftChange}
        onSubmit={onSubmit}
        onFocusChange={setIsComposerFocused}
        joinActionLabel={joinActionLabel}
        isJoinActionLoading={isJoinActionLoading}
        onJoinAction={onJoinAction}
      />

      <ChatBottomNav
        unreadBadgeCount={unreadBadgeCount}
        onSelectBottomNav={onSelectBottomNav}
        navActionSlot={navActionSlot}
      />
    </div>
  );
}
