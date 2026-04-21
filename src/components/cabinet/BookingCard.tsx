import { useState } from "react";
import type { Booking } from "../../utils/apiClient";
import { apiCancelBooking } from "../../utils/apiClient";
import { CalendarDateBadge } from "../UI/CalendarDateBadge";
import { addBookingToCalendar } from "../../utils/calendarEvent";

interface BookingProps {
  booking: Booking;
  active: boolean;
  loadBookings?: () => void;
  showCreateTeamGame?: boolean;
  onCreateTeamGame?: (booking: Booking) => void;
}

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
}: BookingProps) {
  const [cancelState, setCancelState] = useState<"idle" | "confirm" | "done">("idle");
  const [cancelOk, setCancelOk] = useState(false);

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

  const handleCancel = async () => {
    const res = await apiCancelBooking(booking.id);
    const ok = res.status !== null && res.status >= 200 && res.status < 300;
    setCancelOk(ok);
    setCancelState("done");
  };

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

      {canCancel && cancelState === "idle" && (
        <div className="booking-cancel-row">
          <button className="btn-cancel danger" onClick={() => setCancelState("confirm")}>
            Отменить запись
          </button>
        </div>
      )}

      {cancelState === "confirm" && (
        <div className="booking-cancel-row">
          <button className="btn-cancel outline" onClick={() => setCancelState("idle")}>Нет</button>
          <button className="btn-cancel danger" onClick={handleCancel}>Да, отменить</button>
        </div>
      )}

      {cancelState === "done" && (
        <div className="booking-cancel-row">
          <button className="btn-cancel primary" onClick={() => { if (loadBookings) loadBookings(); }}>
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
