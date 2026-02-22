import type { CSSProperties } from "react";
import { useEffect, useMemo, useState } from "react";
import type { Studio } from "../../utils/apiClient";
import { apiFetchStudios, apiFetchProfile } from "../../utils/apiClient";
import {
  CUSTOM_FIELD_IDS,
  getCustomFieldValue,
  getLetterGrade,
  parseNumericLevel,
} from "../../utils/customFields";

interface GamesPageProps {
  onBack: () => void;
}

type Step = "create" | "place" | "time" | "details";

type PayMode = "self" | "split";

const RATING_LABELS = ["D", "D+", "C", "C+", "B", "B+", "A"];

const TIME_SLOTS = [
  "07:00",
  "07:30",
  "09:00",
  "09:30",
  "11:00",
  "11:30",
  "12:30",
  "13:00",
  "13:30",
  "15:00",
  "15:30",
  "16:00",
  "16:30",
  "17:30",
];

const COURTS = [
  { id: "court-1", name: "Корт №2 Панорамник", price: 7000 },
  { id: "court-2", name: "Корт №3 Панорамник", price: 7000 },
  { id: "court-3", name: "Корт №4 Сингл", price: 5000 },
  { id: "court-4", name: "Корт №5 Сингл", price: 5000 },
];

const PAY_MODES: { id: PayMode; label: string }[] = [
  { id: "self", label: "Я плачу" },
  { id: "split", label: "Пополам" },
];

function formatPrice(value: number): string {
  return value.toLocaleString("ru-RU");
}

export default function GamesPage({ onBack }: GamesPageProps) {
  const [step, setStep] = useState<Step>("create");
  const [studios, setStudios] = useState<Studio[]>([]);
  const [studiosQuery, setStudiosQuery] = useState("");
  const [studio, setStudio] = useState<Studio | null>(null);
  const [duration, setDuration] = useState(60);
  const [dateIndex, setDateIndex] = useState(0);
  const [time, setTime] = useState<string | null>(null);
  const [courtId, setCourtId] = useState<string | null>(null);
  const [ratingGame, setRatingGame] = useState(true);
  const [minRating, setMinRating] = useState(1);
  const [maxRating, setMaxRating] = useState(4);
  const [isPrivate, setIsPrivate] = useState(false);
  const [inviteLink, setInviteLink] = useState<string | null>(null);
  const [loadingStudios, setLoadingStudios] = useState(false);
  const [profileName, setProfileName] = useState("Организатор");
  const [profileGrade, setProfileGrade] = useState("D+");
  const [profilePhoto, setProfilePhoto] = useState<string | null>(null);
  const [ringFraction, setRingFraction] = useState(0);
  const [inviteCopied, setInviteCopied] = useState(false);
  const [payMode, setPayMode] = useState<PayMode>("self");
  const [mapOpen, setMapOpen] = useState(false);
  const [avatarError, setAvatarError] = useState(false);

  const dates = useMemo(() => {
    const base = new Date();
    return Array.from({ length: 7 }).map((_, i) => {
      const d = new Date(base);
      d.setDate(base.getDate() + i);
      return d;
    });
  }, []);

  useEffect(() => {
    setLoadingStudios(true);
    apiFetchStudios()
      .then((res) => {
        if (Array.isArray(res.data)) {
          setStudios(res.data);
        } else if (res.data && Array.isArray((res.data as { content?: Studio[] }).content)) {
          setStudios((res.data as { content: Studio[] }).content);
        } else {
          setStudios([]);
        }
      })
      .finally(() => setLoadingStudios(false));

    apiFetchProfile().then((res) => {
      if (!res.data) return;
      const fullName = [res.data.firstName, res.data.lastName]
        .filter(Boolean)
        .join(" ");
      setProfileName(fullName || "Организатор");
      setProfilePhoto(res.data.photo ?? null);

      const numeric = parseNumericLevel(
        getCustomFieldValue(res.data, CUSTOM_FIELD_IDS.lkPadelLevelNumeric),
      );
      const fraction =
        numeric != null
          ? Math.max(0, Math.min(1, numeric - Math.floor(numeric)))
          : 0;
      setRingFraction(fraction);
      const explicitGrade = getCustomFieldValue(
        res.data,
        CUSTOM_FIELD_IDS.lkPadelLevel,
      );
      if (explicitGrade) {
        setProfileGrade(explicitGrade);
      } else if (numeric !== null) {
        setProfileGrade(getLetterGrade(numeric));
      }
    });
  }, []);

  const filteredStudios = studios.filter((s) => {
    if (!studiosQuery.trim()) return true;
    const q = studiosQuery.toLowerCase();
    return s.name.toLowerCase().includes(q) || s.address.toLowerCase().includes(q);
  });

  const favoriteStudios = studiosQuery.trim()
    ? []
    : filteredStudios.slice(0, 2);
  const otherStudios = studiosQuery.trim()
    ? filteredStudios
    : filteredStudios.slice(2);

  const selectedCourt = COURTS.find((c) => c.id === courtId);
  const selectedDate = dates[dateIndex];
  const dateLabel = selectedDate
    ? selectedDate.toLocaleDateString("ru-RU", { day: "numeric", month: "long" })
    : "";
  const dateLabelLong = selectedDate
    ? selectedDate.toLocaleDateString("ru-RU", {
        weekday: "long",
        day: "2-digit",
        month: "long",
      })
    : "";
  const dateLabelLongCaps = dateLabelLong
    ? dateLabelLong.charAt(0).toUpperCase() + dateLabelLong.slice(1)
    : "";
  const badgeMonth = selectedDate
    ? selectedDate
        .toLocaleDateString("ru-RU", { month: "short" })
        .replace(".", "")
        .toUpperCase()
    : "";
  const badgeDay = selectedDate
    ? selectedDate.toLocaleDateString("ru-RU", { day: "2-digit" })
    : "";

  const canCreate = Boolean(studio && time && courtId);
  const ratingRangeLabel = `${RATING_LABELS[minRating]} - ${RATING_LABELS[maxRating]}`;
  const basePrice = selectedCourt?.price ?? 0;
  const payAmount = payMode === "split" ? Math.ceil(basePrice / 2) : basePrice;
  const ratingSubLabel = ratingGame
    ? "Игра влияет на рейтинг участников"
    : "Игра не влияет на рейтинг участников";
  const minPercent = (minRating / (RATING_LABELS.length - 1)) * 100;
  const maxPercent = (maxRating / (RATING_LABELS.length - 1)) * 100;

  const initials = profileName
    .split(" ")
    .filter(Boolean)
    .map((part) => part[0])
    .slice(0, 2)
    .join("")
    .toUpperCase();

  const ringSegments = 135;
  const filledSegments = Math.round(ringFraction * ringSegments);

  const handleCreateGame = () => {
    if (!canCreate) return;
    const base = window.location.origin;
    const link = `${base}/game/${Math.random().toString(36).slice(2, 10)}`;
    setInviteLink(link);
    setStep("details");
  };

  const handleCopyInvite = async () => {
    const base = window.location.origin;
    const link = inviteLink ?? `${base}/game/${Math.random().toString(36).slice(2, 10)}`;
    setInviteLink(link);
    try {
      await navigator.clipboard?.writeText(link);
      setInviteCopied(true);
      window.setTimeout(() => setInviteCopied(false), 1600);
    } catch {
      setInviteCopied(false);
    }
  };

  if (step === "place") {
    return (
      <div className="app-container game-container">
        <div className="page-header">
          <button className="page-back" onClick={() => setStep("create")} type="button">
            ← Назад
          </button>
          <div className="page-title">Выберите место</div>
        </div>

        <div className="game-search">
          <input
            className="game-input"
            placeholder="Найти клуб"
            value={studiosQuery}
            onChange={(e) => setStudiosQuery(e.target.value)}
          />
        </div>

        <div className="game-stack">
          <button
            className="game-card"
            onClick={() => setMapOpen((prev) => !prev)}
            type="button"
          >
            <div className="game-card-row">
              <div>
                <div className="game-card-title">Найти на карте</div>
                <div className="game-card-sub">Клубы рядом с вами</div>
              </div>
              <span className="game-card-arrow">›</span>
            </div>
          </button>
          {mapOpen && (
            <div className="game-map-placeholder">Карта будет доступна позже</div>
          )}
        </div>

        {favoriteStudios.length > 0 && (
          <div className="game-section">
            <div className="game-section-title">Избранные клубы</div>
            <div className="game-stack">
              {favoriteStudios.map((s) => (
                <button
                  key={s.id}
                  className={`game-card ${studio?.id === s.id ? "selected" : ""}`}
                  onClick={() => {
                    setStudio(s);
                    setStep("create");
                  }}
                  type="button"
                >
                  <div className="game-card-title">{s.name}</div>
                  <div className="game-card-sub">{s.address}</div>
                </button>
              ))}
            </div>
          </div>
        )}

        <div className="game-section">
          <div className="game-section-title">
            {studiosQuery.trim() ? "Результаты" : "Все клубы"}
          </div>
          <div className="game-stack">
            {loadingStudios && <div className="game-empty">Загрузка...</div>}
            {!loadingStudios && otherStudios.length === 0 && (
              <div className="game-empty">Ничего не найдено</div>
            )}
            {!loadingStudios &&
              otherStudios.map((s) => (
                <button
                  key={s.id}
                  className={`game-card ${studio?.id === s.id ? "selected" : ""}`}
                  onClick={() => {
                    setStudio(s);
                    setStep("create");
                  }}
                  type="button"
                >
                  <div className="game-card-title">{s.name}</div>
                  <div className="game-card-sub">{s.address}</div>
                </button>
              ))}
          </div>
        </div>
      </div>
    );
  }

  if (step === "time") {
    return (
      <div className="app-container game-container">
        <div className="page-header">
          <button className="page-back" onClick={() => setStep("create")} type="button">
            ← Назад
          </button>
          <div className="page-title">Дата и время</div>
        </div>

        <div className="game-section">
          <div className="game-section-title">Продолжительность</div>
          <div className="duration-row">
            {[60, 90, 120].map((d) => (
              <button
                key={d}
                className={`duration-chip ${duration === d ? "active" : ""}`}
                onClick={() => setDuration(d)}
                type="button"
              >
                {d} мин
              </button>
            ))}
          </div>
        </div>

        <div className="game-section">
          <div className="game-section-title">Дата и время начала игры</div>
          <div className="date-row">
            {dates.map((d, i) => {
              const monthLabel = d
                .toLocaleDateString("ru-RU", { month: "short" })
                .replace(".", "")
                .trim()
                .slice(0, 3)
                .toUpperCase();
              const weekdayLabel = d
                .toLocaleDateString("ru-RU", { weekday: "short" })
                .replace(".", "")
                .toUpperCase();
              const dayLabel = d.toLocaleDateString("ru-RU", { day: "2-digit" });

              return (
                <div key={d.toISOString()} className="date-item">
                  <div className="date-weekday">{weekdayLabel}</div>
                  <button
                    className={`date-chip ${dateIndex === i ? "active" : ""}`}
                    onClick={() => {
                      setDateIndex(i);
                      setTime(null);
                    }}
                    type="button"
                  >
                    <div className="booking-date-badge">
                      <div className="booking-date-badge-month">{monthLabel}</div>
                      <div className="booking-date-badge-day">{dayLabel}</div>
                    </div>
                  </button>
                </div>
              );
            })}
          </div>
          <div className="time-grid">
            {TIME_SLOTS.map((slot) => (
              <button
                key={slot}
                className={`time-chip ${time === slot ? "active" : ""}`}
                onClick={() => setTime(slot)}
                type="button"
              >
                {slot}
              </button>
            ))}
          </div>
        </div>

        <div className="game-section">
          <div className="game-section-title">Корты</div>
          <div className="game-stack">
            {COURTS.map((court) => (
              <button
                key={court.id}
                className={`game-card ${courtId === court.id ? "selected" : ""}`}
                onClick={() => {
                  setCourtId(court.id);
                  setStep("create");
                }}
                type="button"
              >
                <div className="game-card-title">{court.name}</div>
                <div className="game-card-sub">{formatPrice(court.price)} ₽</div>
              </button>
            ))}
          </div>
        </div>
      </div>
    );
  }

  if (step === "details") {
    return (
      <div className="app-container game-container">
        <div className="page-header">
          <button className="page-back" onClick={() => setStep("create")} type="button">
            ← Назад
          </button>
          <div className="page-title">Детали матча</div>
        </div>

        <div className="game-section">
          <div className="game-section-title">Требуется оплата</div>
          <div className="payment-toggle">
            {PAY_MODES.map((mode) => (
              <button
                key={mode.id}
                className={`payment-pill ${payMode === mode.id ? "active" : ""}`}
                onClick={() => setPayMode(mode.id)}
                type="button"
              >
                {mode.label}
              </button>
            ))}
          </div>
          <div className="payment-amount">{formatPrice(payAmount)} ₽</div>
        </div>

        <div className="game-section">
          <div className="details-card">
            <div className="details-row">
              <div>
                <div className="details-date">{dateLabelLongCaps}</div>
                <div className="details-time">
                  {time} · {duration} мин
                </div>
                <div className="details-tags">
                  <span className="details-tag">
                    {ratingGame ? "Рейтинговый" : "Нерейтинговый"}
                  </span>
                  <span className="details-tag">{duration} мин</span>
                  <span className="details-tag">{ratingRangeLabel}</span>
                </div>
              </div>
              <div className="details-date-badge">
                <span className="details-date-month">{badgeMonth}</span>
                <span className="details-date-day">{badgeDay}</span>
              </div>
            </div>
          </div>
        </div>

        {studio && (
          <div className="game-section">
            <button className="game-card" type="button">
              <div className="game-card-row">
                <div>
                  <div className="game-card-title">{studio.name}</div>
                  <div className="game-card-sub">{studio.address}</div>
                </div>
                <span className="game-card-arrow">›</span>
              </div>
            </button>
          </div>
        )}

        <div className="game-section">
          <button className="section-cta" type="button">
            Оплатить
          </button>
          <button
            className="section-cta section-cta-secondary"
            onClick={handleCopyInvite}
            type="button"
          >
            Скопировать ссылку
          </button>
          {inviteLink && (
            <div className="invite-status">
              {inviteCopied ? "Ссылка скопирована" : inviteLink}
            </div>
          )}
        </div>
      </div>
    );
  }

  return (
    <div className="app-container game-container">
      <div className="page-header">
        <button className="page-back" onClick={onBack} type="button">
          Закрыть
        </button>
        <div className="page-title">Создание игры</div>
      </div>

      <div className="game-stack">
        <button className="game-card" onClick={() => setStep("place")} type="button">
          <div className="game-card-row">
            <div>
              <div className="game-card-title">
                {studio ? studio.name : "Выберите станцию"}
              </div>
              <div className="game-card-sub">
                {studio ? studio.address : "Клуб"}
              </div>
            </div>
            <span className="game-card-arrow">›</span>
          </div>
        </button>

        <button
          className={`game-card ${studio ? "" : "disabled"}`}
          onClick={() => {
            if (!studio) return;
            setStep("time");
          }}
          type="button"
          disabled={!studio}
        >
          <div className="game-card-row">
            <div>
              <div className="game-card-title">
                {time && selectedDate ? `Забронировано на ${dateLabel}` : "Выбери корт и время"}
              </div>
              <div className="game-card-sub">
                {time && selectedCourt
                  ? `${time}, ${duration} мин · ${selectedCourt.name}`
                  : "Корт и время"}
              </div>
            </div>
            <span className="game-card-arrow">›</span>
          </div>
        </button>

        <div className="game-toggle-row">
          <div>
            <div className="game-toggle-title">Игра на рейтинг</div>
            <div className="game-toggle-sub">{ratingSubLabel}</div>
          </div>
          <button
            className={`switch ${ratingGame ? "on" : ""}`}
            onClick={() => setRatingGame((v) => !v)}
            type="button"
            aria-label="toggle rating"
          >
            <span />
          </button>
        </div>

        <div className="rating-card">
          <div className="game-card-title">Допустимый рейтинг соперников</div>
          <div className="rating-range">{ratingRangeLabel}</div>
          <div className="rating-slider">
            <div
              className="rating-rail"
              style={
                {
                  "--min": `${minPercent}%`,
                  "--max": `${maxPercent}%`,
                } as CSSProperties
              }
            />
            <input
              className="rating-range rating-range-min"
              type="range"
              min={0}
              max={RATING_LABELS.length - 1}
              value={minRating}
              onChange={(e) =>
                setMinRating(Math.min(Number(e.target.value), maxRating))
              }
            />
            <input
              className="rating-range rating-range-max"
              type="range"
              min={0}
              max={RATING_LABELS.length - 1}
              value={maxRating}
              onChange={(e) =>
                setMaxRating(Math.max(Number(e.target.value), minRating))
              }
            />
            <div className="rating-labels">
              {RATING_LABELS.map((label, idx) => (
                <span
                  key={label}
                  className={idx >= minRating && idx <= maxRating ? "active" : ""}
                >
                  {label}
                </span>
              ))}
            </div>
          </div>
        </div>

        <div className="team-card">
          <div className="game-card-title">Команда</div>
          <div className="team-row">
            <div className="team-member">
              <div className="team-avatar-wrapper">
                <svg className="team-avatar-ring" viewBox="0 0 60 60">
                  <circle
                    cx="30"
                    cy="30"
                    r="27"
                    fill="none"
                    stroke="#e5e7eb"
                    strokeWidth="4"
                  />
                  {Array.from({ length: ringSegments }, (_, idx) => {
                    const i = idx + 1;
                    const t = i / ringSegments;
                    const power = Math.pow(t, 3);
                    const segmentLength = 127 / ringSegments;
                    const start = idx * segmentLength;
                    const r = Math.round(180 + power * (53 - 180));
                    const g = Math.round(150 + power * (63 - 150));
                    const b = Math.round(255 + power * (185 - 255));
                    const isActive = idx < filledSegments;
                    return (
                      <circle
                        key={i}
                        cx="30"
                        cy="30"
                        r="27"
                        fill="none"
                        stroke={isActive ? `rgb(${r},${g},${b})` : "transparent"}
                        strokeWidth={isActive ? 0.3 + power * 10 : 0}
                        strokeDasharray={`${segmentLength} 169`}
                        strokeDashoffset={-start}
                        strokeLinecap="butt"
                        transform="rotate(90 30 30)"
                      />
                    );
                  })}
                </svg>
                {profilePhoto && !avatarError ? (
                  <img
                    src={profilePhoto}
                    alt="Аватар"
                    className="team-avatar-img"
                    onError={() => setAvatarError(true)}
                  />
                ) : (
                  <div className="team-avatar-fallback">
                    {initials || "Вы"}
                  </div>
                )}
                <div className="team-avatar-badge">{profileGrade}</div>
              </div>
              <div className="team-name">{profileName}</div>
              <span className="team-badge">Вы</span>
            </div>
            {[1, 2, 3].map((i) => (
              <div key={i} className="team-member empty">
                <div className="team-avatar">+</div>
                <div className="team-name">Слот</div>
              </div>
            ))}
          </div>
          <div className="invite-row">
            <button
              className="section-cta section-cta-secondary"
              onClick={handleCopyInvite}
              type="button"
            >
              Пригласить в игру
            </button>
            {inviteLink && (
              <div className="invite-status">
                {inviteCopied ? "Ссылка скопирована" : inviteLink}
              </div>
            )}
          </div>
        </div>

        <div className="game-toggle-row">
          <div>
            <div className="game-toggle-title">Приватная</div>
            <div className="game-toggle-sub">
              Присоединиться смогут только те, у кого есть ссылка
            </div>
          </div>
          <button
            className={`switch ${isPrivate ? "on" : ""}`}
            onClick={() => setIsPrivate((v) => !v)}
            type="button"
            aria-label="toggle private"
          >
            <span />
          </button>
        </div>
      </div>

      <button
        className={`game-submit ${canCreate ? "active" : ""}`}
        onClick={handleCreateGame}
        type="button"
      >
        Создать игру
      </button>
    </div>
  );
}
