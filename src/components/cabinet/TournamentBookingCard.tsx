import { useState } from "react";
import type { Booking, TournamentHistoryRecord } from "../../utils/apiClient";
import { apiCancelBooking } from "../../utils/apiClient";
import { addBookingToCalendar } from "../../utils/calendarEvent";
import { CalendarDateBadge } from "../UI/CalendarDateBadge";
import styles from "./TournamentBookingCard.module.css";

interface TournamentBookingCardProps {
  booking: Booking;
  active: boolean;
  customTournament?: TournamentHistoryRecord | null;
  loadBookings?: () => void;
  onOpenDetails?: (booking: Booking) => void;
}

function formatDate(dateStr: string) {
  const date = new Date(dateStr);
  const shortMonths = ["ЯНВ", "ФЕВ", "МАР", "АПР", "МАЙ", "ИЮН", "ИЮЛ", "АВГ", "СЕН", "ОКТ", "НОЯ", "ДЕК"];
  return {
    short: shortMonths[date.getMonth()] || "",
    day: date.getDate(),
  };
}

function formatTimeRange(timeFrom?: string, timeTo?: string) {
  const from = timeFrom?.slice(11, 16) || "";
  const to = timeTo?.slice(11, 16) || "";
  if (from && to) return `${from} • ${to}`;
  return from || to || "Время уточняется";
}

function normalizeTournamentText(...values: Array<string | null | undefined>) {
  return values
    .map((value) => String(value || "").trim())
    .filter(Boolean)
    .join(" • ");
}

function humanizeTournamentType(value: string | null | undefined): string | null {
  const normalized = String(value || "").trim();
  if (!normalized) return null;

  const lowered = normalized.toLowerCase();
  if (lowered.includes("американо") || lowered.includes("americano")) return "Американо";
  if (lowered.includes("мексикано") || lowered.includes("mexicano")) return "Мексикано";
  if (lowered.includes("round robin")) return "Round robin";
  if (lowered.includes("олимп") || lowered.includes("playoff") || lowered.includes("olympic")) return "Олимпийка";
  if (lowered.includes("сетк") || lowered.includes("bracket") || lowered.includes("grid")) return "Сетка";

  const pretty = normalized.replace(/[_-]+/g, " ").replace(/\s+/g, " ").trim();
  return pretty ? pretty[0].toUpperCase() + pretty.slice(1) : null;
}

function formatRatingRangeValue(value: string | null | undefined): string | null {
  const normalized = String(value || "").trim();
  if (!normalized) return null;
  return normalized.replace(/\s*[–-]\s*/g, "–").replace(/\s*\/\s*/g, "/");
}

function getTournamentTitle(booking: Booking, customTournament?: TournamentHistoryRecord | null) {
  const customTitle = customTournament?.title?.trim();
  if (customTitle) return customTitle;

  const directionName = booking.exercise?.direction?.name?.trim();
  const typeName = booking.exercise?.type?.name?.trim();
  return directionName || typeName || "Турнир";
}

function getTournamentTypeLabel(booking: Booking, customTournament?: TournamentHistoryRecord | null) {
  const customType = humanizeTournamentType(customTournament?.tournamentType);
  if (customType) return customType;

  const text = `${booking.exercise?.direction?.name || ""} ${booking.exercise?.type?.name || ""}`;
  if (/американо/i.test(text)) return "Американо";
  if (/мексикано/i.test(text)) return "Мексикано";
  if (/round\s*robin/i.test(text)) return "Round robin";
  if (/олимпийк/i.test(text)) return "Олимпийка";
  if (/сетк/i.test(text)) return "Сетка";

  const typeName = booking.exercise?.type?.name?.trim();
  if (typeName && !/турнир/i.test(typeName)) return typeName;
  return "Турнир";
}

function getTournamentRatingLabel(booking: Booking, customTournament?: TournamentHistoryRecord | null) {
  const customMin = formatRatingRangeValue(customTournament?.minRating);
  const customMax = formatRatingRangeValue(customTournament?.maxRating);
  if (customMin && customMax) {
    return customMin === customMax ? customMin : `${customMin}–${customMax}`;
  }
  if (customMin || customMax) {
    return customMin || customMax || "Рейтинг уточняется";
  }

  const text = `${booking.exercise?.direction?.name || ""} ${booking.exercise?.type?.name || ""}`;
  const prefixedMatch = text.match(
    /\b(?:рейтинг|уровень)\s*[:\-]?\s*((?:[A-D]\+?)(?:\s*[–/-]\s*(?:[A-D]\+?))?|(?:\d(?:[.,]\d+)?)(?:\s*[–/-]\s*(?:\d(?:[.,]\d+)?))?)\b/i,
  );
  if (prefixedMatch?.[1]) {
    return prefixedMatch[1].replace(/\s*[–-]\s*/g, "–").replace(/\s*\/\s*/g, "/");
  }

  const letterRangeMatch = text.match(/\b([A-D]\+?)\s*[–/-]\s*([A-D]\+?)\b/i);
  if (letterRangeMatch) {
    return `${letterRangeMatch[1].toUpperCase()}/${letterRangeMatch[2].toUpperCase()}`;
  }

  const singleLetterMatch = text.match(/\b([A-D]\+?)\b/i);
  if (singleLetterMatch?.[1]) {
    return singleLetterMatch[1].toUpperCase();
  }

  return "Рейтинг уточняется";
}

function getTournamentGenderLabel(booking: Booking, customTournament?: TournamentHistoryRecord | null) {
  const customGender = customTournament?.genderLabel?.trim();
  if (customGender) return customGender;
  if (customTournament?.girlsOnly) return "Женщины";
  if (customTournament?.mixed) return "Микст";
  if (booking.exercise?.girlsOnly) return "Женщины";

  const text = `${booking.exercise?.direction?.name || ""} ${booking.exercise?.type?.name || ""}`;
  if (/микст|mixed/i.test(text)) return "Микст";
  if (/жен/i.test(text)) return "Женщины";
  if (/муж/i.test(text)) return "Мужчины";
  return "Общий";
}

function getSlotsMeta(booking: Booking, customTournament?: TournamentHistoryRecord | null) {
  const total = customTournament?.maxParticipants ?? booking.exercise?.maxClientsCount ?? 0;
  const joined = customTournament?.participantsCount ?? booking.exercise?.clientsCount ?? 0;

  return {
    isFull: total > 0 && joined >= total,
    label: total > 0 ? `${joined}/${total} мест` : `${joined} участников`,
  };
}

function getPaymentLabel(booking: Booking, active: boolean): string {
  if (active) {
    if (booking.transactionStatus?.transactionStatus === "PAID") {
      return booking.paymentType === "SUBSCRIPTION" ? "Абонемент" : `${booking.cost / 100} ₽`;
    }
    return "Не оплачено";
  }
  if (booking.isCancelled) return "Отменено";
  return booking.paymentType === "SUBSCRIPTION" ? "Абонемент" : `${booking.cost / 100} ₽`;
}

export function TournamentBookingCard({
  booking,
  active,
  customTournament = null,
  loadBookings,
  onOpenDetails,
}: TournamentBookingCardProps) {
  const [cancelState, setCancelState] = useState<"idle" | "confirm" | "done">("idle");
  const [cancelOk, setCancelOk] = useState(false);

  const dateStr = booking.exercise?.timeFrom;
  const date = dateStr ? formatDate(dateStr) : null;
  const timeLabel = formatTimeRange(booking.exercise?.timeFrom, booking.exercise?.timeTo);
  const title = getTournamentTitle(booking, customTournament);
  const stationLabel = normalizeTournamentText(
    booking.exercise?.studio?.name,
    booking.exercise?.room?.name,
  ) || "Станция уточняется";
  const slotsMeta = getSlotsMeta(booking, customTournament);
  const canAddToCalendar = Boolean(booking.exercise?.timeFrom && booking.exercise?.timeTo);
  const canCancel = active && Boolean(
    booking.cancellationDeadline && new Date(booking.cancellationDeadline) > new Date(),
  );

  const handleCancel = async () => {
    const res = await apiCancelBooking(booking.id);
    const ok = res.status !== null && res.status >= 200 && res.status < 300;
    setCancelOk(ok);
    setCancelState("done");
  };

  const handleOpenDetails = () => {
    onOpenDetails?.(booking);
  };

  return (
    <div
      className={`game-created-card ${styles.card}${onOpenDetails ? " game-created-card-clickable" : ""}`}
      onClick={onOpenDetails ? handleOpenDetails : undefined}
      role={onOpenDetails ? "button" : undefined}
      tabIndex={onOpenDetails ? 0 : undefined}
      onKeyDown={onOpenDetails
        ? (event) => {
            if (event.key === "Enter" || event.key === " ") {
              event.preventDefault();
              handleOpenDetails();
            }
          }
        : undefined}
    >
      <div className="game-created-head">
        <div className="game-created-head-main">
          <div className={`game-created-date ${styles.title}`}>{title}</div>
          <div className={`game-created-court ${styles.subtitle}`}>{stationLabel}</div>
          <div className="game-created-time">{timeLabel}</div>
          <div className="game-created-tags">
            <span className="game-created-tag game-created-tag-level">
              {getTournamentTypeLabel(booking, customTournament)}
            </span>
            <span
              className={`game-created-tag ${styles.slotTag}${
                slotsMeta.isFull
                  ? ` ${styles.slotTagFull}`
                  : ""
              }`}
            >
              {slotsMeta.label}
            </span>
            <span className="game-created-tag game-created-tag-range">
              {getTournamentRatingLabel(booking, customTournament)}
            </span>
            <span className="game-created-tag game-created-tag-neutral">
              {getTournamentGenderLabel(booking, customTournament)}
            </span>
            {!active && (
              <span className="game-created-tag game-created-tag-neutral">{getPaymentLabel(booking, active)}</span>
            )}
          </div>
        </div>

        <div
          className="game-created-head-right"
          onClick={onOpenDetails ? (event) => event.stopPropagation() : undefined}
        >
          {date && (
            <CalendarDateBadge
              monthLabel={date.short}
              dayLabel={date.day}
              badgeClassName="game-created-date-badge"
              disabled={!canAddToCalendar}
              onClick={() => addBookingToCalendar(booking)}
            />
          )}
        </div>
      </div>

      {canCancel && cancelState === "idle" && (
        <div className={`booking-cancel-row ${styles.actionRow}`}>
          <button
            className="btn-cancel danger"
            onClick={(event) => {
              event.stopPropagation();
              setCancelState("confirm");
            }}
          >
            Отменить запись
          </button>
        </div>
      )}

      {cancelState === "confirm" && (
        <div className={`booking-cancel-row ${styles.actionRow}`}>
          <button
            className="btn-cancel outline"
            onClick={(event) => {
              event.stopPropagation();
              setCancelState("idle");
            }}
          >
            Нет
          </button>
          <button
            className="btn-cancel danger"
            onClick={(event) => {
              event.stopPropagation();
              void handleCancel();
            }}
          >
            Да, отменить
          </button>
        </div>
      )}

      {cancelState === "done" && (
        <div className={`booking-cancel-row ${styles.actionRow}`}>
          <button
            className="btn-cancel primary"
            onClick={(event) => {
              event.stopPropagation();
              if (loadBookings) loadBookings();
            }}
          >
            {cancelOk ? "Запись отменена, продолжить" : "Ошибка — закрыть"}
          </button>
        </div>
      )}

      {active && !canCancel && (
        <div className="booking-status-text">Отмена возможна только за 24 часа</div>
      )}
    </div>
  );
}
