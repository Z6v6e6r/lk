import { AvatarImage } from "../UI/AvatarImage";
import { GameDateIcon, GameLevelIcon, GameLocationIcon, MembersCountIcon } from "../cabinet/community-feed/CommunityIcons";
import type { GroupTrainingSummary } from "../../utils/groupScheduleModel";

export function GroupTrainingInfo({ training }: { training: GroupTrainingSummary }) {
  const date = training.date ? new Date(`${training.date}T00:00:00`) : null;
  const validDate = date && !Number.isNaN(date.getTime()) ? date : null;
  const dateLabel = validDate?.toLocaleDateString("ru-RU", { day: "numeric", month: "long" }) ?? "Дата уточняется";
  const timeLabel = training.timeLabel?.replace(/\s*[-–—]\s*/, "—");
  const location = [training.studioName, training.studioAddress].filter(Boolean).join(", ") || "Станция уточняется";
  const mapQuery = [training.studioName, training.studioAddress].filter(Boolean).join(", ");
  const capacity = Math.max(0, Math.floor(training.maxClientsCount));
  const count = Math.max(0, Math.floor(training.clientsCount));
  // Very large capacities stay legible without creating thousands of DOM nodes.
  const segments = Math.min(capacity, 100);
  const filled = capacity ? Math.round(Math.min(count / capacity, 1) * segments) : 0;

  return (
    <>
      <div className="group-schedule-trainer-info-card" aria-label="Основная информация">
        <div className="group-schedule-trainer-info-content">
          <div className="group-schedule-trainer-info-row">
            <GameDateIcon />
            <span>{dateLabel}{timeLabel ? `, ${timeLabel}` : ""}</span>
          </div>
          <div className="group-schedule-trainer-info-row group-schedule-trainer-location">
            <GameLocationIcon />
            <span>{location}{mapQuery && <> <a href={`https://yandex.ru/maps/?text=${encodeURIComponent(mapQuery)}`} target="_blank" rel="noopener noreferrer">на карте</a></>}</span>
          </div>
          <div className="group-schedule-trainer-info-row">
            <GameLevelIcon />
            <span>{training.levelLabel || "Уровень уточняется"}</span>
          </div>
          <div className="group-schedule-trainer-info-row">
            <MembersCountIcon />
            <span>{training.girlsOnly ? "Женская" : "Микст"}</span>
          </div>
        </div>
        {validDate && (
          <div className="group-schedule-date-badge" aria-hidden="true">
            <strong>{validDate.getDate()}</strong>
            <span>{validDate.toLocaleDateString("ru-RU", { weekday: "short" })}</span>
          </div>
        )}
      </div>

      <div className="group-schedule-capacity" aria-label={capacity ? `Участники: ${count} из ${capacity}` : `Участники: ${count}`}>
        {segments > 0 && (
          <div className="group-schedule-capacity-track" aria-hidden="true">
            {Array.from({ length: segments }, (_, index) => <span key={index} className={index < filled ? "is-filled" : undefined} />)}
          </div>
        )}
        <div className="group-schedule-capacity-labels">
          <span><MembersCountIcon />{capacity ? `${count} из ${capacity}` : count}</span>
          {(training.status === "CANCELLED" || training.status === "FULL") && (
            <span>{training.status === "CANCELLED" ? "Отменено" : "Мест нет"}</span>
          )}
        </div>
      </div>

      <div className="group-schedule-trainer-person-card" aria-label="Тренер">
        <span className="group-schedule-trainer-avatar">
          <AvatarImage name={training.trainerName} src={training.trainerAvatarUrl} alt="" />
        </span>
        <span className="group-schedule-trainer-person-copy">
          <strong>{training.trainerName || "Уточняется"}</strong>
        </span>
        <span className="group-schedule-trainer-role">Тренер</span>
      </div>
    </>
  );
}
