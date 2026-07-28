import { type KeyboardEvent, type ReactNode } from "react";
import {
  ChatIcon,
  EmptySlotAvatarIcon,
  GameDateIcon,
  GameLevelIcon,
  GameLocationIcon,
  HeartIcon,
  MoreIcon,
} from "./CommunityIcons";
import { AvatarImageOrInitials } from "./AvatarImageOrInitials";
import styles from "./CommunityGameCard.module.css";

type CardPlayer = {
  id: string;
  avatarUrl: string;
  name: string;
};

export type CommunityGameCardProps = {
  month: string;
  day: string;
  weekday: string;
  isRatingGame?: boolean | null;
  title: string;
  subtitleText: string;
  timeText: string;
  levelText: string;
  players: CardPlayer[];
  waitlistPlayers?: CardPlayer[];
  confirmedPlayersCount?: number;
  totalSlots?: number;
  slotsLeft?: number;
  splitJoinPriceText?: string | null;
  splitCancelDeadlineAt?: string | null;
  isJoined?: boolean;
  ctaLabel?: string;
  showWaitlist?: boolean;
  isPastGame?: boolean;
  needsResult?: boolean;
  hasConfirmedResult?: boolean;
  hasPendingResult?: boolean;
  isResultDisputed?: boolean;
  resultStatusLabel?: string | null;
  resultScore?: string | null;
  resultTeams?: {
    left: { id: string; avatarUrl?: string; name: string }[];
    right: { id: string; avatarUrl?: string; name: string }[];
  } | null;
  badgeLabel?: string;
  publishedText?: string;
  authorName?: string;
  authorHandle?: string;
  authorAvatarUrl?: string;
  likesCount?: number;
  commentsCount?: number;
  onPlay?: () => void;
  onChat?: () => void;
};

function normalizeAvatarUrl(value: string | undefined) {
  const normalized = (value || "").trim();
  return normalized || "";
}

function hideDuplicateAvatarUrls<T extends { avatarUrl?: string; name: string }>(players: T[]) {
  const seenAvatarUrls = new Set<string>();

  return players.map((player) => {
    const avatarUrl = normalizeAvatarUrl(player.avatarUrl);
    if (!avatarUrl) {
      return {
        ...player,
        avatarUrl: "",
      };
    }

    if (seenAvatarUrls.has(avatarUrl)) {
      return {
        ...player,
        avatarUrl: "",
      };
    }

    seenAvatarUrls.add(avatarUrl);
    return {
      ...player,
      avatarUrl,
    };
  });
}

function buildAuthorHandle(authorName?: string, providedHandle?: string) {
  const normalizedHandle = (providedHandle || "").trim();
  if (normalizedHandle) {
    return normalizedHandle.startsWith("@") ? normalizedHandle : `@${normalizedHandle}`;
  }

  const fallback = (authorName || "")
    .trim()
    .toLowerCase()
    .replace(/\s+/g, "");

  return fallback ? `@${fallback}` : "@player";
}

function formatLevelRange(levelText: string) {
  const normalized = levelText.trim();
  if (!normalized) return "Уровень уточняется";

  const rangeParts = normalized
    .split(/[/–-]/)
    .map((part) => part.trim())
    .filter(Boolean);

  if (rangeParts.length >= 2) {
    return `от ${rangeParts[0]} до ${rangeParts[1]}`;
  }

  return normalized;
}

function formatMonthInDateLine(month: string) {
  const normalized = month.trim().toUpperCase();
  const monthByCase: Record<string, string> = {
    ЯНВ: "января",
    ФЕВ: "февраля",
    МАРТ: "марта",
    АПР: "апреля",
    МАЙ: "мая",
    ИЮН: "июня",
    ИЮЛ: "июля",
    АВГ: "августа",
    СЕН: "сентября",
    ОКТ: "октября",
    НОЯ: "ноября",
    ДЕК: "декабря",
  };

  return monthByCase[normalized] || month.toLowerCase();
}

function getGameTypeBadge(isRatingGame?: boolean | null) {
  if (isRatingGame) {
    return { label: "Рейтинговая игра", tone: styles.statusBadgeRating };
  }

  return { label: "Френдли игра", tone: styles.statusBadgeFriendly };
}

function renderAvatar(player: CardPlayer, index: number) {
  return (
    <div
      key={`${player.id}-${index}`}
      className={styles.avatarItem}
      style={{ zIndex: 10 - index }}
      title={player.name}
      aria-label={player.name}
    >
      <AvatarImageOrInitials src={player.avatarUrl} name={player.name} imageClassName={styles.avatarImage} />
    </div>
  );
}

function renderEmptySlotAvatar(key: string) {
  return (
    <div key={key} className={`${styles.avatarItem} ${styles.avatarGhost}`} aria-hidden="true">
      <EmptySlotAvatarIcon className={styles.emptySlotAvatarIcon} />
    </div>
  );
}

function renderStat(
  icon: ReactNode,
  label: string,
  count?: number,
  onClick?: () => void,
  active = false,
) {
  const content = (
    <>
      <span className={styles.statIcon}>{icon}</span>
      {typeof count === "number" && count > 0 ? <span className={styles.statCount}>{count}</span> : null}
    </>
  );

  if (onClick) {
    return (
      <button
        type="button"
        className={`${styles.statButton}${active ? ` ${styles.statButtonActive}` : ""}`}
        onClick={onClick}
        aria-label={label}
      >
        {content}
      </button>
    );
  }

  return (
    <div className={`${styles.statButton}${active ? ` ${styles.statButtonActive}` : ""}`} aria-label={label}>
      {content}
    </div>
  );
}

function handleKeyboardCardOpen(
  event: KeyboardEvent<HTMLDivElement>,
  onOpen?: () => void,
) {
  if (!onOpen) return;
  if (event.key !== "Enter" && event.key !== " ") return;
  event.preventDefault();
  onOpen();
}

export function CommunityGameCard({
  month,
  day,
  weekday,
  isRatingGame,
  title,
  subtitleText,
  timeText,
  levelText,
  players,
  confirmedPlayersCount = players.length,
  totalSlots = 4,
  slotsLeft,
  splitJoinPriceText,
  isJoined = false,
  ctaLabel,
  needsResult = false,
  publishedText,
  authorName,
  authorHandle,
  authorAvatarUrl,
  likesCount = 0,
  commentsCount = 0,
  onPlay,
  onChat,
}: CommunityGameCardProps) {
  const sanitizedPlayers = hideDuplicateAvatarUrls(players);
  const slotsCount = Math.max(2, Math.min(totalSlots, 4));
  const visiblePlayers = sanitizedPlayers.slice(0, slotsCount);
  const isGameFull = typeof slotsLeft === "number"
    ? slotsLeft <= 0
    : confirmedPlayersCount >= totalSlots;
  const normalizedCtaLabel = (ctaLabel || "").trim();
  const playButtonLabel = normalizedCtaLabel || (
    isJoined
      ? "Открыть игру"
      : isGameFull
        ? "В лист ожидания"
        : "Вступить в игру"
  );
  const emptySlotsCount = Math.max(slotsCount - visiblePlayers.length, 0);
  const statusBadge = getGameTypeBadge(isRatingGame);
  const primaryAuthor = authorName || players[0]?.name || "Игрок";
  const primaryAuthorAvatar = normalizeAvatarUrl(authorAvatarUrl) || normalizeAvatarUrl(players[0]?.avatarUrl);
  const primaryAuthorHandle = buildAuthorHandle(primaryAuthor, authorHandle);
  const locationText = subtitleText.trim() || "Локация уточняется";
  const dateLine = `${day} ${formatMonthInDateLine(month)}, ${timeText}`;
  const formattedLevelText = formatLevelRange(levelText);
  const secondaryAction = onChat || onPlay;
  const showSplitJoinInfo = !isGameFull && Boolean(splitJoinPriceText);

  return (
    <article className={styles.card}>
      <div className={styles.profileRow}>
        <div className={styles.profileMain}>
          <div className={styles.profileAvatar} aria-hidden="true">
            <AvatarImageOrInitials
              src={primaryAuthorAvatar}
              name={primaryAuthor}
              imageClassName={styles.avatarImage}
            />
          </div>

          <div className={styles.profileCopy}>
            <div className={styles.profileName}>{primaryAuthor}</div>
            <div className={styles.profileHandle}>{primaryAuthorHandle}</div>
          </div>
        </div>

        <button
          type="button"
          className={styles.moreButton}
          onClick={secondaryAction}
          aria-label="Открыть действия игры"
        >
          <MoreIcon className={styles.moreIcon} />
        </button>
      </div>

      <div
        className={styles.gameCard}
        role="button"
        tabIndex={0}
        onClick={onPlay}
        onKeyDown={(event) => handleKeyboardCardOpen(event, onPlay)}
        aria-label={`${playButtonLabel} ${title}`}
      >
        <div className={styles.gameHeader}>
          <div className={styles.headerMain}>
            <div className={`${styles.statusBadge} ${statusBadge.tone}`}>
              <span className={styles.statusBadgeDot} aria-hidden="true" />
              <span>{statusBadge.label}</span>
            </div>
            <h3 className={styles.title}>{title}</h3>
          </div>

          <div className={styles.dateBadge} aria-label={`${day} ${month} ${weekday}`}>
            <span className={styles.dateBadgeDay}>{day}</span>
            <span className={styles.dateBadgeWeekday}>{weekday}</span>
          </div>
        </div>

        <div className={styles.infoStack}>
          <div className={styles.infoRow}>
            <GameDateIcon className={styles.infoIcon} />
            <span className={styles.infoText}>{dateLine}</span>
          </div>

          <div className={styles.infoRow}>
            <GameLocationIcon className={styles.infoIcon} />
            <span className={styles.infoText}>{locationText}</span>
          </div>

          <div className={styles.infoRow}>
            <GameLevelIcon className={styles.infoIcon} />
            <span className={styles.infoText}>{formattedLevelText}</span>
          </div>
        </div>

        <div className={styles.footer}>
          <div className={styles.footerDivider} />

          <div className={styles.footerMain}>
            <div className={styles.avatarsGroup} aria-label={`Игроков: ${players.length}`}>
              {visiblePlayers.map(renderAvatar)}
              {Array.from({ length: emptySlotsCount }, (_, index) => (
                renderEmptySlotAvatar(`ghost-slot-${index}`)
              ))}
            </div>

            <div className={styles.footerActions}>
              {showSplitJoinInfo && (
                <div className={styles.splitJoinInfo} aria-label="Условия присоединения к сборной игре">
                  {splitJoinPriceText && (
                    <div className={styles.splitJoinInfoRow}>
                      <span>Вход</span>
                      <strong>{splitJoinPriceText}</strong>
                    </div>
                  )}
                </div>
              )}

              <button
                type="button"
                className={`${styles.playButton}${needsResult ? ` ${styles.playButtonAttention}` : ""}`}
                onClick={(event) => {
                  event.stopPropagation();
                  onPlay?.();
                }}
              >
                {playButtonLabel}
              </button>
            </div>
          </div>
        </div>
      </div>

      <div className={styles.metaBar}>
        <div className={styles.statsGroup}>
          {renderStat(<HeartIcon className={styles.inlineIcon} />, "Лайки", likesCount, undefined, likesCount > 0)}
          {renderStat(<ChatIcon className={styles.inlineIcon} />, "Чат игры", commentsCount, onChat)}
        </div>

        <span className={styles.metaText}>{publishedText || "только что"}</span>
      </div>
    </article>
  );
}
