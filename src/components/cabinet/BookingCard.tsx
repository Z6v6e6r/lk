import { useState } from "react";
import {
  apiLeavePadelGameAsCurrentUser,
  type Booking,
} from "../../utils/apiClient";
import { CalendarDateBadge } from "../UI/CalendarDateBadge";
import { addBookingToCalendar } from "../../utils/calendarEvent";
import { BookingCancellationDialog } from "./BookingCancellationDialog";
import type { BookingCancellationExecutionResult } from "./BookingCancellationDialog";
import type { BookingCancellationAction } from "../../utils/bookingCancellation";

interface BookingProps {
  booking: Booking;
  active: boolean;
  loadBookings?: () => void;
  showCreateTeamGame?: boolean;
  onCreateTeamGame?: (booking: Booking) => void;
  linkedGameId?: string | null;
  linkedGameAmbiguous?: boolean;
  executeCancellation?: (
    action: BookingCancellationAction,
  ) => Promise<BookingCancellationExecutionResult>;
}

const LINKED_GAME_LEAVE_PENDING_MESSAGE =
  "Бронирование отменено, обновляем состав игры. Это может занять несколько минут.";
const AMBIGUOUS_LINKED_GAME_MESSAGE =
  "Не удалось безопасно подтвердить связь записи с игрой. Отмена остановлена — повторите позже или обратитесь в поддержку.";

function formatDate(dateStr: string) {
  const d = new Date(dateStr);
  const days = ["Воскресенье","Понедельник","Вторник","Среда","Четверг","Пятница","Суббота"];
  const months = ["Января","Февраля","Марта","Апреля","Мая","Июня","Июля","Августа","Сентября","Октября","Ноября","Декабря"];
  const shortMonths = ["ЯНВ","ФЕВ","МАР","АПР","МАЙ","ИЮН","ИЮЛ","АВГ","СЕН","ОКТ","НОЯ","ДЕК"];
  return {
    full: `${days[d.getDay()]}, ${d.getDate()} ${months[d.getMonth()]}`,
    short: shortMonths[d.getMonth()],
    day: d.getDate(),
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

export function BookingCard({
  booking,
  active,
  loadBookings,
  showCreateTeamGame = false,
  onCreateTeamGame,
  linkedGameId = null,
  linkedGameAmbiguous = false,
  executeCancellation,
}: BookingProps) {
  const [cancelDialogOpen, setCancelDialogOpen] = useState(false);

  const dateStr = booking.exercise?.timeFrom;
  const date = dateStr ? formatDate(dateStr) : null;
  const timeFrom = booking.exercise?.timeFrom.slice(11, 16);
  const timeTo = booking.exercise?.timeTo.slice(11, 16);
  const canCancel = active && new Date(booking.cancellationDeadline) > new Date();
  const roomName = booking.exercise?.room?.name || "";
  const courtNumber = roomName.match(/\d+/)?.[0];
  const courtLabel = roomName
    ? courtNumber
      ? `Корт №${courtNumber}`
      : roomName
    : "";

  const studioName = booking.exercise?.studio?.name || "";
  const studioAddr = booking.exercise?.studio?.address || "";
  const mapsUrl = studioName === "Селигерская"
    ? "https://yandex.ru/maps/213/moscow/?ll=37.523554%2C55.867424&mode=routes&rtext=~55.867046%2C37.523758&rtt=auto&ruri=~ymapsbm1%3A%2F%2Forg%3Foid%3D190285749872"
    : "https://yandex.ru/maps/?text=" + encodeURIComponent(studioAddr);
  const canAddToCalendar = Boolean(booking.exercise?.timeFrom && booking.exercise?.timeTo);

  return (
    <div className="booking-card-new">
      <div className="booking-date-row">
        <span className="booking-date-text">{date?.full}</span>
        {date && (
          <CalendarDateBadge
            monthLabel={date.short}
            dayLabel={date.day}
            disabled={!canAddToCalendar}
            onClick={() => addBookingToCalendar(booking)}
          />
        )}
      </div>

      <div className="booking-time">{timeFrom} → {timeTo}</div>

      <div className="booking-tags">
        {booking.exercise?.direction.name && (
          <span className="booking-tag">{booking.exercise.direction.name}</span>
        )}
        {active && courtLabel && (
          <span className="booking-tag">{courtLabel}</span>
        )}
        <span className="booking-tag">{getPaymentLabel(booking, active)}</span>
      </div>

      {booking.exercise?.trainers[0] && (
        <div style={{ fontSize: 13, color: "var(--text-secondary)", marginBottom: 6 }}>
          Тренер: {booking.exercise.trainers[0].firstName} {booking.exercise.trainers[0].lastName}
        </div>
      )}

      {booking.exercise?.studio && (
        <a href={mapsUrl} target="_blank" rel="noopener noreferrer" className="booking-studio-row" style={{ textDecoration: "none" }}>
          <div>
            <div className="booking-studio-name">{studioName}</div>
            <div className="booking-studio-addr">{studioAddr}</div>
          </div>
          <span style={{ color: "var(--text-secondary)" }}>›</span>
        </a>
      )}

      {showCreateTeamGame && onCreateTeamGame && (
        <div className="booking-cancel-row">
          <button type="button" className="btn-cancel primary" onClick={() => onCreateTeamGame(booking)}>
            Собрать друзей
          </button>
        </div>
      )}

      {canCancel && (
        <div className="booking-cancel-row">
          <button className="btn-cancel danger" onClick={() => setCancelDialogOpen(true)}>
            Отменить запись
          </button>
        </div>
      )}

      {active && !canCancel && (
        <div className="booking-status-text">Отмена возможна только за 24 часа</div>
      )}

      <BookingCancellationDialog
        bookingId={booking.id}
        isOpen={cancelDialogOpen}
        onClose={() => setCancelDialogOpen(false)}
        onSuccessClose={() => {
          loadBookings?.();
        }}
        executeAction={async (action) => {
          if (executeCancellation) return executeCancellation(action);
          if (linkedGameAmbiguous || !linkedGameId) {
            return {
              ok: false,
              message: AMBIGUOUS_LINKED_GAME_MESSAGE,
            };
          }
          const result = await apiLeavePadelGameAsCurrentUser(linkedGameId, {
            refundMethod: action.refundMethod,
          });
          if (result.error || !result.data) {
            return {
              ok: false,
              message: result.error?.message || "Не удалось покинуть игру",
            };
          }
          if (result.data.state === "RETRY_REQUIRED" || result.data.state === "IN_PROGRESS") {
            return {
              ok: true,
              state: "RETRY_REQUIRED",
              message: result.data.message || LINKED_GAME_LEAVE_PENDING_MESSAGE,
            };
          }
          if (result.data.state !== "DONE") {
            return {
              ok: false,
              message: result.data.message || "Не удалось подтвердить выход из игры",
            };
          }
          return {
            ok: true,
            state: "DONE",
            message: action.successMessage,
          };
        }}
      />
    </div>
  );
}
