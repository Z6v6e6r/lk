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

export function CommunityTournamentCard({ card, onOpen }: CommunityTournamentCardProps) {
  const monthLabel = formatDateMonthLabel(card.date);
  const dayLabel = formatDateDayLabel(card.date);
  const weekdayLabel = formatWeekdayLabel(card.date);
  const stationLabel = card.stationLabel || card.subtitle || "Станция уточняется";
  const timeLabel = card.startTime || "Время уточняется";
  const typeLabel = card.tournamentTypeLabel || "Турнир";
  const ratingLabel = card.ratingLabel || card.level || "Рейтинг уточняется";
  const genderLabel = card.genderLabel || "Любой пол";
  const slotsLabel = getSlotsLabel(card);

  return (
    <CommunityFeedCardBase variant="tournament" className={styles.card}>
      <div className={styles.layout}>
        <div className={styles.head}>
          <div className={styles.headMain}>
            <h3 className={styles.title}>{card.title}</h3>
            <p className={styles.station}>{stationLabel}</p>
            <p className={styles.time}>{timeLabel}</p>
          </div>

          <div className={styles.dateWrap} aria-label={`Дата турнира ${dayLabel} ${monthLabel} ${weekdayLabel}`}>
            <div className={`booking-date-badge ${styles.dateBadge}`}>
              <span className="booking-date-badge-month">{monthLabel}</span>
              <span className="booking-date-badge-day">{dayLabel}</span>
            </div>
            <span className={`calendar-date-badge-caption ${styles.dateCaption}`}>
              {weekdayLabel}
            </span>
          </div>
        </div>

        <div className={styles.tags}>
          <span className={`${styles.tag} ${styles.tagType}`}>{typeLabel}</span>
          <span className={`${styles.tag} ${styles.tagSlots}${card.isFull ? ` ${styles.tagSlotsFull}` : ""}`}>
            {slotsLabel}
          </span>
          <span className={`${styles.tag} ${styles.tagRating}`}>{ratingLabel}</span>
          <span className={`${styles.tag} ${styles.tagGender}`}>{genderLabel}</span>
        </div>

        <button type="button" className={styles.action} onClick={onOpen}>
          {getTournamentCtaLabel(card)}
        </button>
      </div>
    </CommunityFeedCardBase>
  );
}
