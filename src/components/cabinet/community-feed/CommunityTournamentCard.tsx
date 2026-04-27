import { CommunityFeedCardBase } from "./CommunityFeedCardBase";
import {
  formatDateDayLabel,
  formatDateMonthLabel,
  formatWeekdayLabel,
} from "./feedFormatters";
import type { CommunityTournamentCard as CommunityTournamentCardData } from "./feedTypes";
import styles from "./CommunityTournamentCard.module.css";

interface CommunityTournamentCardProps {
  card: CommunityTournamentCardData;
  onOpen: () => void;
}

function getTournamentCtaLabel(card: CommunityTournamentCardData) {
  if (card.ctaLabel) return card.ctaLabel;
  if (card.isJoined) return "Открыть";
  if (card.isFull) return "В лист ожидания";
  return "Участвовать";
}

function getSlotsLabel(card: CommunityTournamentCardData) {
  if (card.slotsLabel) return card.slotsLabel;
  return `${card.participants}/${card.maxParticipants} мест`;
}

function getInitials(value: string) {
  const [first = "", second = ""] = value.trim().split(/\s+/);
  return `${first[0] ?? ""}${second[0] ?? ""}`.toUpperCase() || "PH";
}

export function CommunityTournamentCard({ card, onOpen }: CommunityTournamentCardProps) {
  const monthLabel = formatDateMonthLabel(card.date);
  const dayLabel = formatDateDayLabel(card.date);
  const weekdayLabel = formatWeekdayLabel(card.date);
  const stationLabel = card.stationLabel || card.subtitle || "Станция уточняется";
  const timeLabel = [card.startTime, card.endTime].filter(Boolean).join("-");
  const typeLabel = card.tournamentTypeLabel || "Турнир";
  const ratingLabel = card.ratingLabel || card.level || "Рейтинг уточняется";
  const genderLabel = card.genderLabel || "М/Ж";
  const slotsLabel = getSlotsLabel(card);
  const trainerName = card.trainerName || "PadelHub";
  const profileHandle = card.profileHandle || stationLabel;
  const progressPercent = Math.max(0, Math.min(100, card.progress * 100));
  const spotsLabel = typeof card.spotsLeft === "number"
    ? `${card.spotsLeft} мест осталось`
    : slotsLabel;

  return (
    <CommunityFeedCardBase variant="tournament" className={styles.card}>
      <div className={styles.layout}>
        <div className={styles.author}>
          <div className={styles.avatar}>
            {card.trainerAvatarUrl ? (
              <img src={card.trainerAvatarUrl} alt="" />
            ) : (
              <span>{getInitials(trainerName)}</span>
            )}
          </div>
          <div className={styles.authorText}>
            <span className={styles.authorName}>{trainerName}</span>
            <span className={styles.authorHandle}>{profileHandle}</span>
          </div>
          <span className={styles.menuDots}>...</span>
        </div>

        <div className={styles.tournament}>
          <div className={styles.topLine}>
            <span className={styles.badge}>{typeLabel}</span>
            <div className={styles.dateWrap} aria-label={`Дата турнира ${dayLabel} ${monthLabel} ${weekdayLabel}`}>
              <div className={styles.dateBadge}>
                <span className={styles.dateDay}>{dayLabel}</span>
                <span className={styles.dateMonth}>{monthLabel}</span>
              </div>
            </div>
          </div>

          <h3 className={styles.title}>{card.title}</h3>

          <div className={styles.meta}>
            <span>{weekdayLabel}, {timeLabel || "время уточняется"}</span>
            <span>{stationLabel}</span>
            <span>{ratingLabel} · {genderLabel}</span>
          </div>

          <div className={styles.capacity}>
            <div className={styles.capacityLabels}>
              <span>{slotsLabel}</span>
              <span>{spotsLabel}</span>
            </div>
            <div className={styles.progressTrack}>
              <span style={{ width: `${progressPercent}%` }} />
            </div>
          </div>

          <div className={styles.footer}>
            <span className={styles.waitlist}>
              Лист ожидания: {card.waitlistCount ?? 0}
            </span>
            <button type="button" className={styles.action} onClick={onOpen}>
              {getTournamentCtaLabel(card)}
            </button>
          </div>
        </div>
      </div>
    </CommunityFeedCardBase>
  );
}
