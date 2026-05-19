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
      <path d="M5.23438 0C5.88459 0 6.44442 0.368244 6.71191 0.900391H6.94238C7.53498 0.900391 8 1.35255 8 1.92871C7.99995 2.50479 7.74889 2.99711 7.36621 3.40918C7.17696 3.59313 6.93847 3.75743 6.66699 3.85742C6.27576 4.79351 5.38208 5.47261 4.30762 5.58301V6.49902H5.2334C5.68595 6.49918 6.05664 6.85978 6.05664 7.2998V7.39941H6.46777C6.6363 7.39946 6.77609 7.53542 6.77637 7.69922C6.77637 7.86324 6.63646 7.99995 6.46777 8H1.5293C1.36059 7.99997 1.2207 7.86325 1.2207 7.69922C1.22098 7.53541 1.36076 7.39944 1.5293 7.39941H1.94043V7.2998C1.94043 6.85977 2.31111 6.49916 2.76367 6.49902H3.68945V5.58301C2.61632 5.47165 1.72387 4.79265 1.33301 3.85742C1.06154 3.75741 0.823027 3.59313 0.633789 3.40918C0.251107 2.99711 5.17542e-05 2.50479 0 1.92871C0 1.35256 0.465021 0.900396 1.05762 0.900391H1.28809C1.55558 0.368244 2.11541 0 2.76562 0H5.23438ZM4.24316 1.58398C4.10738 1.38014 3.89261 1.38011 3.75684 1.58398L3.53906 1.91211C3.50614 1.96412 3.43185 2.02013 3.37012 2.03613L2.97949 2.13281C2.74083 2.19284 2.67056 2.39701 2.83105 2.58105L3.08691 2.88477C3.12796 2.92885 3.15645 3.01723 3.15234 3.07715L3.12793 3.46875C3.11147 3.7088 3.28812 3.83311 3.51855 3.74512L3.89258 3.60059C3.95019 3.58058 4.04981 3.58058 4.10742 3.60059L4.48145 3.74512C4.7119 3.83314 4.88853 3.70882 4.87207 3.46875L4.84766 3.07715C4.84354 3.01713 4.87291 2.92878 4.91406 2.88477L5.16895 2.58105C5.32944 2.397 5.25919 2.19283 5.02051 2.13281L4.62988 2.03613C4.56815 2.02013 4.49386 1.96412 4.46094 1.91211L4.24316 1.58398Z" fill="currentColor" />
    </svg>
  );
}

function CalendarMetaIcon() {
  return (
    <svg width="12" height="12" viewBox="0 0 12 12" fill="none" xmlns="http://www.w3.org/2000/svg" aria-hidden="true">
      <path d="M8.63881 1H7.80547H4.19436L3.36102 0.999928C1.86102 1.13882 1.13324 2.06667 1.02213 3.39445C1.01102 3.55556 1.14435 3.68889 1.29991 3.68889H10.6999C10.861 3.68889 10.9944 3.55 10.9777 3.39445C10.8666 2.06667 10.1388 1.13889 8.63881 1Z" fill="currentColor" />
      <path d="M10.4445 4.24438H1.55556C1.25 4.24438 1 4.49438 1 4.79994V8.22217C1 9.88883 1.83333 10.9999 3.77778 10.9999H8.22223C10.1667 10.9999 11 9.88883 11 8.22217V4.79994C11 4.49438 10.75 4.24438 10.4445 4.24438ZM4.45 8.89439C4.42223 8.91661 4.39445 8.94439 4.36667 8.96106C4.33334 8.98328 4.3 8.99994 4.26667 9.01106C4.23334 9.02772 4.2 9.03883 4.16667 9.04439C4.12778 9.04994 4.09445 9.0555 4.05556 9.0555C3.98334 9.0555 3.91111 9.03883 3.84445 9.01106C3.77222 8.98328 3.71667 8.94439 3.66111 8.89439C3.56111 8.78883 3.5 8.64439 3.5 8.49994C3.5 8.3555 3.56111 8.21106 3.66111 8.1055C3.71667 8.0555 3.77222 8.01661 3.84445 7.98883C3.94445 7.94439 4.05556 7.93328 4.16667 7.9555C4.2 7.96106 4.23334 7.97217 4.26667 7.98883C4.3 7.99994 4.33334 8.01661 4.36667 8.03883C4.39445 8.06105 4.42223 8.08328 4.45 8.1055C4.55 8.21106 4.61111 8.3555 4.61111 8.49994C4.61111 8.64439 4.55 8.78883 4.45 8.89439ZM4.45 6.94994C4.34445 7.04994 4.2 7.11105 4.05556 7.11105C3.91111 7.11105 3.76667 7.04994 3.66111 6.94994C3.56111 6.84439 3.5 6.69994 3.5 6.5555C3.5 6.41105 3.56111 6.26661 3.66111 6.16105C3.81667 6.0055 4.06111 5.9555 4.26667 6.04439C4.33889 6.07216 4.4 6.11105 4.45 6.16105C4.55 6.26661 4.61111 6.41105 4.61111 6.5555C4.61111 6.69994 4.55 6.84439 4.45 6.94994ZM6.39445 8.89439C6.28889 8.99439 6.14445 9.0555 6 9.0555C5.85556 9.0555 5.71112 8.99439 5.60556 8.89439C5.50556 8.78883 5.44445 8.64439 5.44445 8.49994C5.44445 8.3555 5.50556 8.21106 5.60556 8.1055C5.81112 7.89994 6.18889 7.89994 6.39445 8.1055C6.49445 8.21106 6.55556 8.3555 6.55556 8.49994C6.55556 8.64439 6.49445 8.78883 6.39445 8.89439ZM6.39445 6.94994C6.36667 6.97216 6.33889 6.99439 6.31112 7.01661C6.27778 7.03883 6.24445 7.0555 6.21112 7.06661C6.17778 7.08328 6.14445 7.09439 6.11112 7.09994C6.07223 7.1055 6.03889 7.11105 6 7.11105C5.85556 7.11105 5.71112 7.04994 5.60556 6.94994C5.50556 6.84439 5.44445 6.69994 5.44445 6.5555C5.44445 6.41105 5.50556 6.26661 5.60556 6.16105C5.65556 6.11105 5.71667 6.07216 5.78889 6.04439C5.99445 5.9555 6.23889 6.0055 6.39445 6.16105C6.49445 6.26661 6.55556 6.41105 6.55556 6.5555C6.55556 6.69994 6.49445 6.84439 6.39445 6.94994ZM8.33889 6.94994C8.31112 6.97216 8.28334 6.99439 8.25556 7.01661C8.22223 7.03883 8.1889 7.0555 8.15556 7.06661C8.12223 7.08328 8.0889 7.09439 8.05556 7.09994C8.01667 7.1055 7.97778 7.11105 7.94445 7.11105C7.80001 7.11105 7.65556 7.04994 7.55001 6.94994C7.45001 6.84439 7.38889 6.69994 7.38889 6.5555C7.38889 6.41105 7.45001 6.26661 7.55001 6.16105C7.60556 6.11105 7.66112 6.07216 7.73334 6.04439C7.83334 5.99994 7.94445 5.98883 8.05556 6.01105C8.0889 6.01661 8.12223 6.02772 8.15556 6.04439C8.1889 6.0555 8.22223 6.07216 8.25556 6.09439C8.28334 6.11661 8.31112 6.13883 8.33889 6.16105C8.4389 6.26661 8.50001 6.41105 8.50001 6.5555C8.50001 6.69994 8.4389 6.84439 8.33889 6.94994Z" fill="currentColor" />
    </svg>
  );
}

function StationMetaIcon() {
  return (
    <svg width="9" height="11" viewBox="0 0 9 11" fill="none" xmlns="http://www.w3.org/2000/svg" aria-hidden="true">
      <path d="M8.74856 3.34945C8.22365 1.03983 6.20898 0 4.43927 0C4.43927 0 4.43927 0 4.43427 0C2.66955 0 0.649883 1.03483 0.124969 3.34446C-0.459936 5.92404 1.11981 8.10868 2.54957 9.48346C3.07949 9.99337 3.75938 10.2483 4.43927 10.2483C5.11916 10.2483 5.79905 9.99337 6.32396 9.48346C7.75373 8.10868 9.33347 5.92903 8.74856 3.34945ZM4.43927 5.85405C3.56941 5.85405 2.86452 5.14916 2.86452 4.2793C2.86452 3.40945 3.56941 2.70456 4.43927 2.70456C5.30912 2.70456 6.01401 3.40945 6.01401 4.2793C6.01401 5.14916 5.30912 5.85405 4.43927 5.85405Z" fill="currentColor" />
    </svg>
  );
}

function LevelMetaIcon() {
  return (
    <svg width="12" height="12" viewBox="0 0 12 12" fill="none" xmlns="http://www.w3.org/2000/svg" aria-hidden="true">
      <path d="M6.55664 3.24951C6.93865 3.24951 7.25195 3.5576 7.25195 3.83643V9.66162C7.2517 9.94036 6.9385 10.2505 6.55664 10.2505H5.44531C5.06365 10.2503 4.75122 9.94026 4.75098 9.66162V3.83643C4.75098 3.5577 5.06349 3.24973 5.44531 3.24951H6.55664ZM10.0566 1.74951C10.4386 1.74951 10.751 2.06236 10.751 2.3374V9.64209C10.751 9.91713 10.4386 10.2505 10.0566 10.2505H8.94531C8.56335 10.2504 8.251 9.91711 8.25098 9.64209V2.3374C8.25098 2.06237 8.56334 1.74955 8.94531 1.74951H10.0566ZM3.05566 4.74951C3.43752 4.74951 3.74977 5.09234 3.75 5.38232V9.63037C3.75 9.91525 3.43766 10.2495 3.05566 10.2495H1.94434C1.56246 10.2494 1.25 9.91518 1.25 9.63037V5.38232C1.25023 5.09757 1.5626 4.74966 1.94434 4.74951H3.05566Z" fill="currentColor" />
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
  const levelLabel = card.level || card.ratingLabel || "Уровень уточняется";
  const genderLabel = card.genderLabel || "М/Ж";
  const trainerName = card.trainerName || "PadelHub";
  const profileHandle = card.profileHandle || stationLabel;
  const priceLabel = card.priceLabel?.trim() || "энергия";
  const canOpenEnergyPopover = isEnergyPriceLabel(priceLabel);
  const totalSlots = Math.max(0, card.maxParticipants);
  const filledSlots = Math.max(0, Math.min(totalSlots, card.participants));
  const spotsLeft = typeof card.spotsLeft === "number"
    ? Math.max(0, card.spotsLeft)
    : Math.max(0, totalSlots - filledSlots);
  const spotsLeftLabel = `осталось: ${spotsLeft} ${spotsLeft === 1 ? "место" : spotsLeft >= 2 && spotsLeft <= 4 ? "места" : "мест"}`;

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
            <span className={styles.metaRow}>
              <span className={styles.metaIcon}><CalendarMetaIcon /></span>
              <span>{weekdayLabel}, {timeLabel || "время уточняется"}</span>
            </span>
            <span className={styles.metaRow}>
              <span className={styles.metaIcon}><StationMetaIcon /></span>
              <span>{stationLabel}</span>
            </span>
            <span className={styles.metaRow}>
              <span className={styles.metaIcon}><LevelMetaIcon /></span>
              <span>{levelLabel} · {genderLabel}</span>
            </span>
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
            <div className={styles.progressTrack}>
              {Array.from({ length: totalSlots }).map((_, index) => (
                <span
                  key={`${card.id}-slot-${index}`}
                  className={`${styles.progressSegment}${index < filledSlots ? ` ${styles.progressSegmentFilled}` : ""}`}
                />
              ))}
            </div>
            <div className={styles.capacityLabels}>
              <div className={styles.capacityLabel}>
                <span className={styles.capacityLabelAccent}>{card.participants}</span>
                <span className={styles.capacityLabelMuted}>/{card.maxParticipants} участников</span>
              </div>
              <div className={styles.capacityRemaining}>{spotsLeftLabel}</div>
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
