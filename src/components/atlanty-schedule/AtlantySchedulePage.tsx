import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { apiFetchAtlantyEvents } from "../../utils/atlantyScheduleApi";
import {
  ATLANTY_DEFAULT_PILL_LABEL,
  normalizeAtlantyCategories,
  type AtlantyScheduleEvent,
} from "../../utils/atlantyScheduleModel";
import {
  ATLANTY_VIVA_INSTANCE,
  buildAtlantyVivaAnchorHref,
  rememberAtlantyExercise,
} from "../../utils/atlantyVivaBridge";
import "./AtlantySchedulePage.css";

export type AtlantyScheduleConfig = {
  /** Текст пилюли по умолчанию, если у категории нет своего label. */
  pillLabel?: string;
  /** Необязательный заголовок над слайдером. */
  title?: string | null;
  vivaInstance?: string;
  daysAhead?: number;
  /** Сколько ближайших событий показывать. */
  maxEvents?: number;
  /**
   * Выбранные категории расписания: имена пресетов ("atlanty", "friends")
   * или объекты `{ directionId, typeId, label }`.
   */
  categories?: ReadonlyArray<string | AtlantyCategoryInput> | null;
};

export type AtlantyCategoryInput = {
  directionId?: number | string | null;
  typeId?: number | string | null;
  label?: string | null;
  preset?: string | null;
  enabled?: boolean;
};

type LoadStatus = "loading" | "ready" | "error";

function InfinityIcon() {
  return (
    <svg viewBox="0 0 24 24" fill="none" aria-hidden="true">
      <path
        d="M7.2 15.6c1.9 0 3-1.6 4.8-3.6 1.8-2 2.9-3.6 4.8-3.6a3.6 3.6 0 0 1 0 7.2c-1.9 0-3-1.6-4.8-3.6-1.8-2-2.9-3.6-4.8-3.6a3.6 3.6 0 0 0 0 7.2Z"
        stroke="currentColor"
        strokeWidth="2.1"
        strokeLinecap="round"
      />
    </svg>
  );
}

function CalendarIcon() {
  return (
    <svg viewBox="0 0 24 24" fill="none" aria-hidden="true">
      <rect x="3" y="4.5" width="18" height="16" rx="4" fill="currentColor" opacity="0.9" />
      <rect x="6.5" y="9.5" width="11" height="8" rx="2" fill="#fff" />
      <path d="M8 3v3M16 3v3" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
    </svg>
  );
}

function PinIcon() {
  return (
    <svg viewBox="0 0 24 24" fill="none" aria-hidden="true">
      <path
        d="M12 2.8c-3.9 0-7 3-7 6.9 0 4.9 5.9 10.6 6.6 11.2.2.2.6.2.8 0 .7-.6 6.6-6.3 6.6-11.2 0-3.9-3.1-6.9-7-6.9Z"
        fill="currentColor"
      />
      <circle cx="12" cy="9.7" r="2.6" fill="#fff" />
    </svg>
  );
}

function LevelIcon() {
  return (
    <svg viewBox="0 0 24 24" fill="none" aria-hidden="true">
      <rect x="3" y="14" width="3.4" height="6.4" rx="1.4" fill="currentColor" opacity="0.45" />
      <rect x="8.8" y="10" width="3.4" height="10.4" rx="1.4" fill="currentColor" opacity="0.7" />
      <rect x="14.6" y="6" width="3.4" height="14.4" rx="1.4" fill="currentColor" />
      <rect x="20.2" y="3" width="1.4" height="17.4" rx="0.7" fill="currentColor" opacity="0.25" />
    </svg>
  );
}

function ChevronIcon({ direction }: { direction: "left" | "right" }) {
  return (
    <svg viewBox="0 0 24 24" fill="none" aria-hidden="true">
      <path
        d={direction === "left" ? "M14.5 5.5 8 12l6.5 6.5" : "M9.5 5.5 16 12l-6.5 6.5"}
        stroke="currentColor"
        strokeWidth="2"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

export function AtlantyCard({
  event,
  pillLabel,
  vivaInstance,
}: {
  event: AtlantyScheduleEvent;
  pillLabel: string;
  vivaInstance: string;
}) {
  return (
    <li className="atlanty-slide">
      <a
        className="atlanty-card"
        href={buildAtlantyVivaAnchorHref(event.id, vivaInstance)}
        aria-label={`${event.title}, ${event.dateTimeLabel}`}
        onClick={() => rememberAtlantyExercise(event.id, vivaInstance)}
      >
        <div className="atlanty-card-media">
          {event.photoUrl ? (
            <img src={event.photoUrl} alt="" loading="lazy" decoding="async" />
          ) : (
            <div className="atlanty-card-media-fallback" aria-hidden="true">
              {event.title}
            </div>
          )}
          <div className="atlanty-card-date">
            <span className="atlanty-card-date-day">{event.dayLabel}</span>
            <span className="atlanty-card-date-weekday">{event.weekdayLabel}</span>
          </div>
        </div>

        <div className="atlanty-card-body">
          <span className="atlanty-card-pill">
            <span className="atlanty-card-pill-icon">
              <InfinityIcon />
            </span>
            <span className="atlanty-card-pill-label">{event.pillLabel || pillLabel}</span>
          </span>

          <h3 className="atlanty-card-title">{event.title}</h3>

          <ul className="atlanty-card-meta">
            <li className="atlanty-card-meta-row">
              <CalendarIcon />
              <span className="atlanty-card-meta-text">{event.dateTimeLabel}</span>
            </li>
            {event.locationLabel && (
              <li className="atlanty-card-meta-row">
                <PinIcon />
                <span className="atlanty-card-meta-text">{event.locationLabel}</span>
              </li>
            )}
            {event.levelLabel && (
              <li className="atlanty-card-meta-row">
                <LevelIcon />
                <span className="atlanty-card-meta-text">{event.levelLabel}</span>
              </li>
            )}
          </ul>

          {(event.slotsLabel || event.placesLabel) && (
            <div className="atlanty-card-footer">
              {event.trainerAvatarUrl && (
                <img
                  className="atlanty-card-avatar"
                  src={event.trainerAvatarUrl}
                  alt={event.trainerName ? `Тренер ${event.trainerName}` : ""}
                  loading="lazy"
                  decoding="async"
                />
              )}
              <div className="atlanty-card-slots">
                {event.slotsLabel && (
                  <span className="atlanty-card-slots-count">{event.slotsLabel}</span>
                )}
                {event.placesLabel && (
                  <span
                    className={`atlanty-card-slots-places${event.isFull ? " is-full" : ""}`}
                  >
                    ({event.placesLabel})
                  </span>
                )}
              </div>
            </div>
          )}
        </div>
      </a>
    </li>
  );
}

function AtlantySkeletonCard() {
  return (
    <li className="atlanty-slide">
      <div className="atlanty-card atlanty-schedule-skeleton" aria-hidden="true">
        <div className="atlanty-card-media" />
        <div className="atlanty-card-body">
          <span className="atlanty-skeleton-pill" />
          <span className="atlanty-skeleton-title" />
          <span className="atlanty-skeleton-title" />
          <span className="atlanty-skeleton-line" />
          <span className="atlanty-skeleton-line is-short" />
          <div className="atlanty-card-footer">
            <span className="atlanty-skeleton-slot" />
          </div>
        </div>
      </div>
    </li>
  );
}

export default function AtlantySchedulePage({ config = {} }: { config?: AtlantyScheduleConfig }) {
  const pillLabel = config.pillLabel?.trim() || ATLANTY_DEFAULT_PILL_LABEL;
  const title = config.title?.trim() || "";
  const vivaInstance = config.vivaInstance?.trim() || ATLANTY_VIVA_INSTANCE;
  const daysAhead = config.daysAhead;
  const maxEvents = config.maxEvents;
  const categories = useMemo(
    () => normalizeAtlantyCategories(config.categories),
    [config.categories],
  );

  const trackRef = useRef<HTMLUListElement | null>(null);
  const [status, setStatus] = useState<LoadStatus>("loading");
  const [events, setEvents] = useState<AtlantyScheduleEvent[]>([]);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [reloadToken, setReloadToken] = useState(0);
  const [nav, setNav] = useState({ left: false, right: false });

  useEffect(() => {
    let active = true;
    const controller = typeof AbortController === "function" ? new AbortController() : null;
    setStatus("loading");
    setErrorMessage(null);

    apiFetchAtlantyEvents({
      daysAhead,
      maxEvents,
      categories,
      forceRefresh: reloadToken > 0,
      signal: controller?.signal,
    }).then((result) => {
      if (!active) return;
      if (result.error || !result.data) {
        setStatus("error");
        setErrorMessage(result.error?.message || "Не удалось загрузить расписание");
        setEvents([]);
        return;
      }
      setEvents(result.data);
      setStatus("ready");
    });

    return () => {
      active = false;
      controller?.abort();
    };
  }, [daysAhead, maxEvents, categories, reloadToken]);

  const updateNav = useCallback(() => {
    const element = trackRef.current;
    if (!element) return;
    const maxScroll = element.scrollWidth - element.clientWidth;
    setNav({
      left: element.scrollLeft > 4,
      right: maxScroll - element.scrollLeft > 4,
    });
  }, []);

  useEffect(() => {
    updateNav();
  }, [updateNav, events, status]);

  useEffect(() => {
    const element = trackRef.current;
    if (!element) return;
    element.addEventListener("scroll", updateNav, { passive: true });
    window.addEventListener("resize", updateNav);
    const observer =
      typeof ResizeObserver === "function" ? new ResizeObserver(updateNav) : null;
    observer?.observe(element);
    return () => {
      element.removeEventListener("scroll", updateNav);
      window.removeEventListener("resize", updateNav);
      observer?.disconnect();
    };
  }, [updateNav, status]);

  const scrollByCards = (direction: 1 | -1) => {
    const element = trackRef.current;
    if (!element) return;
    const slide = element.querySelector<HTMLElement>(".atlanty-slide");
    const step = slide ? slide.offsetWidth + 12 : element.clientWidth * 0.8;
    element.scrollBy({ left: step * direction, behavior: "smooth" });
  };

  const showNav = status === "ready" && events.length > 1;
  const hasEvents = status === "ready" && events.length > 0;

  return (
    <div className="atlanty-schedule">
      {(title || showNav) && (
        <div className="atlanty-schedule-head">
          {title ? <h2 className="atlanty-schedule-heading">{title}</h2> : <span />}
          {showNav && (
            <div className="atlanty-schedule-nav">
              <button
                type="button"
                className="atlanty-nav-button"
                onClick={() => scrollByCards(-1)}
                disabled={!nav.left}
                aria-label="Предыдущие события"
              >
                <ChevronIcon direction="left" />
              </button>
              <button
                type="button"
                className="atlanty-nav-button"
                onClick={() => scrollByCards(1)}
                disabled={!nav.right}
                aria-label="Следующие события"
              >
                <ChevronIcon direction="right" />
              </button>
            </div>
          )}
        </div>
      )}

      {status === "loading" && (
        <div className="atlanty-slider">
          <ul className="atlanty-track">
            <AtlantySkeletonCard />
            <AtlantySkeletonCard />
          </ul>
        </div>
      )}

      {status === "error" && (
        <div className="atlanty-schedule-state" role="alert">
          <span>{errorMessage || "Не удалось загрузить расписание"}</span>
          <button
            type="button"
            className="atlanty-schedule-retry"
            onClick={() => setReloadToken((value) => value + 1)}
          >
            Обновить
          </button>
        </div>
      )}

      {status === "ready" && !hasEvents && (
        <div className="atlanty-schedule-state">
          <span>Расписание корпоративных игр скоро появится</span>
        </div>
      )}

      {hasEvents && (
        <div className="atlanty-slider">
          <ul className="atlanty-track" ref={trackRef}>
            {events.map((event) => (
              <AtlantyCard
                key={event.id}
                event={event}
                pillLabel={pillLabel}
                vivaInstance={vivaInstance}
              />
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}
