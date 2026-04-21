import { ChatIcon } from "./CommunityIcons";
import { getInitials } from "./feedFormatters";
import styles from "./CommunityGameCard.module.css";

export type CommunityGameCardProps = {
  month: string;
  day: string;
  weekday: string;
  title: string;
  subtitleText: string;
  timeText: string;
  levelText: string;
  players: { id: string; avatarUrl: string; name: string }[];
  waitlistPlayers?: { id: string; avatarUrl: string; name: string }[];
  confirmedPlayersCount?: number;
  totalSlots?: number;
  slotsLeft?: number;
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

function renderAvatar(player: CommunityGameCardProps["players"][number], index: number) {
  const hasAvatar = Boolean(player.avatarUrl);

  return (
    <div
      key={`${player.id}-${index}`}
      className={styles.avatarItem}
      style={{ zIndex: 10 - index }}
      title={player.name}
      aria-label={player.name}
    >
      {hasAvatar ? (
        <img src={player.avatarUrl} alt={player.name} className={styles.avatarImage} />
      ) : (
        <span>{getInitials(player.name)}</span>
      )}
    </div>
  );
}

function renderOverflowAvatar(
  player: CommunityGameCardProps["players"][number],
  index: number,
) {
  const hasAvatar = Boolean(player.avatarUrl);

  return (
    <div
      key={`${player.id}-${index}-overflow`}
      className={`${styles.avatarItem} ${styles.avatarOverflow}`}
      style={{ zIndex: Math.max(1, 4 - index) }}
      title={player.name}
      aria-label={player.name}
    >
      {hasAvatar ? (
        <img src={player.avatarUrl} alt={player.name} className={styles.avatarImage} />
      ) : (
        <span>{getInitials(player.name)}</span>
      )}
    </div>
  );
}

function renderWaitlistAvatar(
  player: CommunityGameCardProps["players"][number],
  index: number,
) {
  const hasAvatar = Boolean(player.avatarUrl);

  return (
    <div
      key={`${player.id}-${index}-waitlist`}
      className={`${styles.avatarItem} ${styles.waitlistAvatarItem}`}
      style={{ zIndex: Math.max(1, 6 - index) }}
      title={player.name}
      aria-label={player.name}
    >
      {hasAvatar ? (
        <img src={player.avatarUrl} alt={player.name} className={styles.avatarImage} />
      ) : (
        <span>{getInitials(player.name)}</span>
      )}
    </div>
  );
}

function renderResultAvatar(
  player: { id: string; avatarUrl?: string; name: string },
  index: number,
) {
  const hasAvatar = Boolean(player.avatarUrl);

  return (
    <div
      key={`${player.id}-${index}-result`}
      className={styles.resultAvatar}
      style={{ zIndex: 10 - index }}
      title={player.name}
      aria-label={player.name}
    >
      {hasAvatar ? (
        <img src={player.avatarUrl} alt={player.name} className={styles.avatarImage} />
      ) : (
        <span>{getInitials(player.name)}</span>
      )}
    </div>
  );
}

export function CommunityGameCard({
  month,
  day,
  weekday,
  title,
  subtitleText,
  timeText,
  levelText,
  players,
  waitlistPlayers = [],
  confirmedPlayersCount = players.length,
  totalSlots = 4,
  slotsLeft,
  isJoined = false,
  ctaLabel,
  showWaitlist = true,
  needsResult = false,
  hasConfirmedResult = false,
  resultScore,
  resultTeams,
  onPlay,
  onChat,
}: CommunityGameCardProps) {
  const sanitizedPlayers = hideDuplicateAvatarUrls(players);
  const sanitizedWaitlistPlayers = hideDuplicateAvatarUrls(waitlistPlayers);
  const visiblePlayers = sanitizedPlayers.slice(0, 4);
  const overflowPlayers = sanitizedPlayers.slice(4);
  const visibleWaitlistPlayers = sanitizedWaitlistPlayers.slice(0, 3);
  const waitlistOverflowCount = Math.max(waitlistPlayers.length - visibleWaitlistPlayers.length, 0);
  const isGameFull = typeof slotsLeft === "number"
    ? slotsLeft <= 0
    : confirmedPlayersCount >= totalSlots;
  const playButtonLabel = ctaLabel || (!isJoined && isGameFull ? "В лист ожидания" : "Играть");
  const visibleResultTeams = resultTeams && hasConfirmedResult
    ? resultTeams
    : null;
  const showResultBlock = Boolean(visibleResultTeams && resultScore);
  const resultSets = (resultScore || "")
    .split("·")
    .map((setItem) => setItem.trim())
    .filter(Boolean)
    .map((setItem) => {
      const [left = "", right = ""] = setItem.split(":").map((value) => value.trim());
      return { left, right };
    });
  const renderTeamNames = (teamPlayers: { id: string; avatarUrl?: string; name: string }[]) => teamPlayers
    .map((player) => player.name)
    .filter(Boolean)
    .join(" / ");

  if (showResultBlock && resultTeams) {
    return (
      <article className={`${styles.card} ${styles.resultCard}`}>
        <div className={styles.resultCardLayout}>
          <div className={styles.resultSidebar}>
            <div className={styles.resultDatePill}>
              {day} {month}
            </div>
            <div className={styles.resultMetaStack}>
              <div className={styles.resultMetaPrimary}>{subtitleText.split("•")[0]?.trim() || subtitleText}</div>
              <div className={styles.resultMetaSecondary}>
                {subtitleText.split("•").slice(1).join(" • ").trim() || "Локация уточняется"}
              </div>
              <div className={styles.resultTimeText}>{timeText}</div>
            </div>
          </div>

          <div className={styles.resultMain}>
            <div className={styles.resultHeader}>
              <h3 className={styles.resultTitle}>{title}</h3>
              <button
                type="button"
                className={styles.chatTopButton}
                onClick={onChat}
                aria-label="Открыть чат игры"
              >
                <ChatIcon className={styles.chatTopIcon} />
              </button>
            </div>

            <div className={styles.resultScoreboard}>
              <div className={styles.resultTeamRow}>
                <div className={styles.resultTeamScores}>
                  {resultSets.map((setItem, index) => (
                    <span key={`left-set-${index}`} className={styles.resultScoreValueWin}>
                      {setItem.left}
                    </span>
                  ))}
                </div>
                <div className={styles.resultTeamLine} />
                <div className={styles.resultPlayersCluster}>
                  {resultTeams.left.map(renderResultAvatar)}
                </div>
              </div>

              <div className={styles.resultTeamRow}>
                <div className={styles.resultTeamScores}>
                  {resultSets.map((setItem, index) => (
                    <span key={`right-set-${index}`} className={styles.resultScoreValueLose}>
                      {setItem.right}
                    </span>
                  ))}
                </div>
                <div className={styles.resultTeamLine} />
                <div className={styles.resultPlayersCluster}>
                  {resultTeams.right.map(renderResultAvatar)}
                </div>
              </div>
            </div>

            <div className={styles.resultTeamNames}>
              <span>{renderTeamNames(resultTeams.left)}</span>
              <span>{renderTeamNames(resultTeams.right)}</span>
            </div>
          </div>
        </div>
      </article>
    );
  }

  return (
    <article className={styles.card}>
      <div className={styles.topRow}>
        <div className={styles.calendarBadge} aria-label={`${day} ${month} ${weekday}`}>
          <div className={styles.badgeTop}>{month}</div>
          <div className={styles.badgeMiddle}>{day}</div>
          <div className={styles.badgeBottom}>{weekday}</div>
        </div>

        <div className={styles.content}>
          <div className={styles.headerRow}>
            <div className={styles.textGroup}>
              <h3 className={styles.title}>{title}</h3>
              <p className={styles.subtitleText}>{subtitleText}</p>

              <div className={styles.metaRow}>
                <span className={styles.timeText}>{timeText}</span>
                <span className={styles.metaDot} aria-hidden="true" />
                <span className={styles.levelBadge}>{levelText}</span>
              </div>
            </div>

            <button
              type="button"
              className={styles.chatTopButton}
              onClick={onChat}
              aria-label="Открыть чат игры"
            >
              <ChatIcon className={styles.chatTopIcon} />
            </button>
          </div>
        </div>
      </div>

      <div className={styles.bottomRow}>
        <div className={styles.playersWrap}>
          <div className={styles.avatarsGroup} aria-label={`Игроков: ${players.length}`}>
            {visiblePlayers.map(renderAvatar)}
            {overflowPlayers.map((player, index) => renderOverflowAvatar(player, index))}
          </div>

          {showWaitlist && waitlistPlayers.length > 0 && (
            <div className={styles.waitlistGroup} aria-label={`В листе ожидания: ${waitlistPlayers.length}`}>
              <div className={styles.waitlistAvatars}>
                {visibleWaitlistPlayers.map((player, index) => renderWaitlistAvatar(player, index))}
                {waitlistOverflowCount > 0 && (
                  <div className={`${styles.avatarItem} ${styles.waitlistAvatarItem} ${styles.waitlistAvatarMore}`}>
                    +{waitlistOverflowCount}
                  </div>
                )}
              </div>
            </div>
          )}

          {showResultBlock && visibleResultTeams && (
            <div className={styles.resultBlock} aria-label={`Счёт матча ${resultScore}`}>
              <div className={styles.resultTeams}>
                <div className={styles.resultTeam}>{renderTeamNames(visibleResultTeams.left)}</div>
                <div className={styles.resultScore}>{resultScore}</div>
                <div className={styles.resultTeam}>{renderTeamNames(visibleResultTeams.right)}</div>
              </div>
            </div>
          )}
        </div>

        <div className={styles.actionsGroup}>
          <button
            type="button"
            className={`${styles.playButton}${needsResult ? ` ${styles.playButtonAttention}` : ""}`}
            onClick={onPlay}
          >
            {playButtonLabel}
          </button>
        </div>
      </div>
    </article>
  );
}
