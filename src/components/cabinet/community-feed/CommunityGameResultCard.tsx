import { ChatIcon } from "./CommunityIcons";
import { AvatarImageOrInitials } from "./AvatarImageOrInitials";
import styles from "./CommunityGameResultCard.module.css";

type ResultPlayer = {
  id: string;
  avatarUrl?: string;
  name: string;
};

type ResultTeam = {
  players: ResultPlayer[];
  sets: string[];
  winner: boolean;
};

function normalizeAvatarUrl(value: string | undefined) {
  const normalized = (value || "").trim();
  return normalized || "";
}

function hideDuplicateAvatarUrls(players: ResultPlayer[]) {
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

export type CommunityGameResultCardProps = {
  month: string;
  day: string;
  weekday: string;
  title: string;
  subtitleText: string;
  timeText: string;
  levelText: string;
  teams: [ResultTeam, ResultTeam];
  statusLabel?: string;
  statusTone?: "pending" | "disputable" | "disputed";
  actionLabel?: string;
  onAction?: () => void;
  onChat?: () => void;
  onOpen?: () => void;
};

function renderAvatar(player: ResultPlayer, index: number) {
  return (
    <div
      key={`${player.id}-${index}`}
      className={styles.resultAvatar}
      style={{ zIndex: 10 - index }}
      title={player.name}
      aria-label={player.name}
    >
      <AvatarImageOrInitials src={player.avatarUrl} name={player.name} imageClassName={styles.avatarImage} />
    </div>
  );
}

function renderTeamNames(players: ResultPlayer[]) {
  return players.map((player) => player.name).filter(Boolean).join(" / ");
}

export function CommunityGameResultCard({
  month,
  day,
  weekday,
  title,
  subtitleText,
  timeText,
  levelText,
  teams,
  statusLabel,
  statusTone,
  actionLabel,
  onAction,
  onChat,
  onOpen,
}: CommunityGameResultCardProps) {
  const sanitizedTeams: [ResultTeam, ResultTeam] = [
    {
      ...teams[0],
      players: hideDuplicateAvatarUrls(teams[0].players),
    },
    {
      ...teams[1],
      players: hideDuplicateAvatarUrls(teams[1].players),
    },
  ];

  return (
    <article
      className={`${styles.card}${onOpen ? ` ${styles.cardInteractive}` : ""}`}
      onClick={onOpen}
      role={onOpen ? "button" : undefined}
      tabIndex={onOpen ? 0 : undefined}
      onKeyDown={onOpen
        ? (event) => {
            if (event.key === "Enter" || event.key === " ") {
              event.preventDefault();
              onOpen();
            }
          }
        : undefined}
    >
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
              onClick={(event) => {
                event.stopPropagation();
                onChat?.();
              }}
              aria-label="Открыть чат игры"
            >
              <ChatIcon className={styles.chatTopIcon} />
            </button>
          </div>

          <div className={styles.resultsBlock}>
            {sanitizedTeams.map((team, index) => (
              <div key={`team-${index}`} className={styles.teamRow}>
                <div className={styles.teamRowTop}>
                  <div className={styles.teamAvatars}>
                    {team.players.map(renderAvatar)}
                  </div>

                  <div className={styles.teamSets} aria-label={`Сеты: ${team.sets.join(" ")}`}>
                    {team.sets.map((setValue, setIndex) => (
                      <span
                        key={`team-${index}-set-${setIndex}`}
                        className={team.winner ? styles.setValueWinner : styles.setValueLoser}
                      >
                        {setValue}
                      </span>
                    ))}
                  </div>
                </div>

                <div className={styles.teamNames}>{renderTeamNames(team.players)}</div>
              </div>
            ))}
          </div>

          {(statusLabel || (actionLabel && onAction)) && (
            <div className={styles.footerRow}>
              {statusLabel && (
                <span
                  className={[
                    styles.statusPill,
                    statusTone === "disputable"
                      ? styles.statusPillDisputable
                      : statusTone === "disputed"
                        ? styles.statusPillDisputed
                        : styles.statusPillPending,
                  ].join(" ")}
                >
                  {statusLabel}
                </span>
              )}

              {actionLabel && onAction && (
                <button
                  type="button"
                  className={styles.actionButton}
                  onClick={(event) => {
                    event.stopPropagation();
                    onAction();
                  }}
                >
                  {actionLabel}
                </button>
              )}
            </div>
          )}
        </div>
      </div>
    </article>
  );
}
