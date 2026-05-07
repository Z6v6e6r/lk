import { useEffect, useRef, useState } from "react";
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

const ENERGY_PRICE_TIERS = [
  { label: "Энергия 1", price: "5500" },
  { label: "Энергия 5", price: "19800" },
  { label: "Энергия 25", price: "97000" },
];

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

function isEnergyPriceLabel(value: string) {
  return value.trim().toLowerCase() === "энергия";
}

function TournamentIcon() {
  return (
    <svg width="8" height="8" viewBox="0 0 8 8" fill="none" xmlns="http://www.w3.org/2000/svg" aria-hidden="true">
      <path d="M5.23438 0C5.88459 0 6.44442 0.368244 6.71191 0.900391H6.94238C7.53498 0.900391 8 1.35255 8 1.92871C7.99995 2.50479 7.74889 2.99711 7.36621 3.40918C7.17696 3.59313 6.93847 3.75743 6.66699 3.85742C6.27576 4.79351 5.38208 5.47261 4.30762 5.58301V6.49902H5.2334C5.68595 6.49918 6.05664 6.85978 6.05664 7.2998V7.39941H6.46777C6.6363 7.39946 6.77609 7.53542 6.77637 7.69922C6.77637 7.86324 6.63646 7.99995 6.46777 8H1.5293C1.36059 7.99997 1.2207 7.86325 1.2207 7.69922C1.22098 7.53541 1.36076 7.39944 1.5293 7.39941H1.94043V7.2998C1.94043 6.85977 2.31111 6.49916 2.76367 6.49902H3.68945V5.58301C2.61632 5.47165 1.72387 4.79265 1.33301 3.85742C1.06154 3.75741 0.823027 3.59313 0.633789 3.40918C0.251107 2.99711 5.17542e-05 2.50479 0 1.92871C0 1.35256 0.465021 0.900396 1.05762 0.900391H1.28809C1.55558 0.368244 2.11541 0 2.76562 0H5.23438ZM4.24316 1.58398C4.10738 1.38014 3.89261 1.38011 3.75684 1.58398L3.53906 1.91211C3.50614 1.96412 3.43185 2.02013 3.37012 2.03613L2.97949 2.13281C2.74083 2.19284 2.67056 2.39701 2.83105 2.58105L3.08691 2.88477C3.12796 2.92885 3.15645 3.01723 3.15234 3.07715L3.12793 3.46875C3.11147 3.7088 3.28812 3.83311 3.51855 3.74512L3.89258 3.60059C3.95019 3.58058 4.04981 3.58058 4.10742 3.60059L4.48145 3.74512C4.7119 3.83314 4.88853 3.70882 4.87207 3.46875L4.84766 3.07715C4.84354 3.01713 4.87291 2.92878 4.91406 2.88477L5.16895 2.58105C5.32944 2.397 5.25919 2.19283 5.02051 2.13281L4.62988 2.03613C4.56815 2.02013 4.49386 1.96412 4.46094 1.91211L4.24316 1.58398Z" fill="#5FC0F0" />
    </svg>
  );
}

export function CommunityTournamentCard({ card, onOpen }: CommunityTournamentCardProps) {
  const [isEnergyPopoverOpen, setIsEnergyPopoverOpen] = useState(false);
  const energyPriceRef = useRef<HTMLDivElement | null>(null);
  const monthLabel = formatDateMonthLabel(card.date);
  const dayLabel = formatDateDayLabel(card.date);
  const weekdayLabel = formatWeekdayLabel(card.date);
  const stationLabel = card.stationLabel || card.subtitle || "Станция уточняется";
  const timeLabel = [card.startTime, card.endTime].filter(Boolean).join("-");
  const typeLabel = card.tournamentTypeLabel || "Турнир";
  const isMexicano = typeLabel.trim().toLowerCase().includes("мексикано");
  const ratingLabel = card.ratingLabel || card.level || "Рейтинг уточняется";
  const genderLabel = card.genderLabel || "М/Ж";
  const slotsLabel = getSlotsLabel(card);
  const trainerName = card.trainerName || "PadelHub";
  const profileHandle = card.profileHandle || stationLabel;
  const progressPercent = Math.max(0, Math.min(100, card.progress * 100));
  const spotsLabel = typeof card.spotsLeft === "number"
    ? `${card.spotsLeft} мест осталось`
    : slotsLabel;
  const priceLabel = card.priceLabel?.trim() || "энергия";
  const canOpenEnergyPopover = isEnergyPriceLabel(priceLabel);

  useEffect(() => {
    if (!isEnergyPopoverOpen) return undefined;

    const handlePointerDown = (event: PointerEvent) => {
      const target = event.target;
      if (target instanceof Node && energyPriceRef.current?.contains(target)) return;
      setIsEnergyPopoverOpen(false);
    };

    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        setIsEnergyPopoverOpen(false);
      }
    };

    document.addEventListener("pointerdown", handlePointerDown);
    document.addEventListener("keydown", handleKeyDown);

    return () => {
      document.removeEventListener("pointerdown", handlePointerDown);
      document.removeEventListener("keydown", handleKeyDown);
    };
  }, [isEnergyPopoverOpen]);

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
            <span className={`${styles.badge}${isMexicano ? ` ${styles.badgeMexicano}` : ""}`}>
              <TournamentIcon />
              {typeLabel}
            </span>
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

          <div className={styles.priceWrap} ref={energyPriceRef}>
            {canOpenEnergyPopover ? (
              <button
                className={`${styles.price}${isEnergyPopoverOpen ? ` ${styles.priceActive}` : ""}`}
                type="button"
                onClick={(event) => {
                  event.stopPropagation();
                  setIsEnergyPopoverOpen((isOpen) => !isOpen);
                }}
                aria-expanded={isEnergyPopoverOpen}
                aria-haspopup="dialog"
                aria-label="Стоимость энергии"
              >
                {priceLabel}
              </button>
            ) : (
              <div className={styles.price}>{priceLabel}</div>
            )}
            {canOpenEnergyPopover && isEnergyPopoverOpen && (
              <div
                className={styles.energyPopover}
                role="dialog"
                aria-label="Стоимость энергии"
                onClick={(event) => event.stopPropagation()}
              >
                {ENERGY_PRICE_TIERS.map((tier) => (
                  <div className={styles.energyPopoverRow} key={tier.label}>
                    <span>{tier.label}</span>
                    <strong>{tier.price}</strong>
                  </div>
                ))}
              </div>
            )}
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
