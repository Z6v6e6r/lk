import { useCallback, useEffect, useId, useRef, type ReactElement } from "react";
import { createPortal } from "react-dom";
import type { AtlantyScheduleEvent } from "../../utils/atlantyScheduleModel";
import {
  buildAtlantyVivaAnchorHref,
  rememberAtlantyExercise,
} from "../../utils/atlantyVivaBridge";
import "./AtlantyEventModal.css";

export type AtlantyEventModalProps = {
  event: AtlantyScheduleEvent;
  imageUrl: string | null;
  pillLabel: string;
  vivaInstance: string;
  onClose: () => void;
};

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
    </svg>
  );
}

/** Разметка карточки события — без портала и побочных эффектов. */
export function AtlantyEventModalContent({
  event,
  imageUrl,
  pillLabel,
  vivaInstance,
  onClose,
}: AtlantyEventModalProps) {
  const titleId = useId();
  const closeButtonRef = useRef<HTMLButtonElement | null>(null);
  const metaRows: Array<{ icon: ReactElement; text: string }> = [
    { icon: <CalendarIcon />, text: event.dateTimeLabel },
  ];
  if (event.locationLabel) metaRows.push({ icon: <PinIcon />, text: event.locationLabel });
  if (event.levelLabel) metaRows.push({ icon: <LevelIcon />, text: event.levelLabel });

  const handleBook = useCallback(() => {
    rememberAtlantyExercise(event.id, vivaInstance);
    try {
      const widget = (window as unknown as Record<string, unknown>)[vivaInstance];
      if (typeof widget === "function") {
        (widget as (command: string, ...args: unknown[]) => void)("event", "open");
      }
    } catch {
      /* виджет записи может быть не подключён — останется переход по хешу */
    }
    // Закрываем после того, как браузер обработает клик по ссылке.
    window.setTimeout(onClose, 0);
  }, [event.id, onClose, vivaInstance]);

  return (
    <div
      className="atlanty-modal"
      role="presentation"
      onMouseDown={(mouseEvent) => {
        if (mouseEvent.target === mouseEvent.currentTarget) onClose();
      }}
    >
      <div
        className="atlanty-modal__dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
      >
        <button
          type="button"
          ref={closeButtonRef}
          className="atlanty-modal__close"
          onClick={onClose}
          aria-label="Закрыть карточку события"
        >
          <svg viewBox="0 0 24 24" fill="none" aria-hidden="true">
            <path
              d="M6 6l12 12M18 6 6 18"
              stroke="currentColor"
              strokeWidth="2"
              strokeLinecap="round"
            />
          </svg>
        </button>

        <div className="atlanty-modal__media">
          {imageUrl ? (
            <img src={imageUrl} alt="" loading="lazy" decoding="async" />
          ) : (
            <div className="atlanty-modal__media-fallback" aria-hidden="true">
              {event.title}
            </div>
          )}
          {event.badgeLabel && (
            <span className="atlanty-modal__badge">{event.badgeLabel}</span>
          )}
          <div className="atlanty-modal__date">
            <span className="atlanty-modal__date-day">{event.dayLabel}</span>
            <span className="atlanty-modal__date-weekday">{event.weekdayLabel}</span>
          </div>
        </div>

        <div className="atlanty-modal__body">
          <span className="atlanty-card-pill">
            <span className="atlanty-card-pill-label">{event.pillLabel || pillLabel}</span>
          </span>

          <h3 className="atlanty-modal__title" id={titleId}>
            {event.title}
          </h3>

          <ul className="atlanty-modal__meta">
            {metaRows.map((row) => (
              <li key={row.text} className="atlanty-modal__meta-row">
                {row.icon}
                <span>{row.text}</span>
              </li>
            ))}
          </ul>

          {(event.slotsLabel || event.placesLabel) && (
            <div className="atlanty-modal__slots">
              {event.slotsLabel && <span className="atlanty-card-slots-count">{event.slotsLabel}</span>}
              {event.placesLabel && (
                <span className={`atlanty-card-slots-places${event.isFull ? " is-full" : ""}`}>
                  ({event.placesLabel})
                </span>
              )}
            </div>
          )}

          {event.trainerName && (
            <p className="atlanty-modal__trainer">
              Тренер: <strong>{event.trainerName}</strong>
            </p>
          )}

          {event.description && (
            <p className="atlanty-modal__description">{event.description}</p>
          )}

          <div className="atlanty-modal__actions">
            <a
              className="atlanty-modal__cta"
              href={buildAtlantyVivaAnchorHref(event.id, vivaInstance)}
              onClick={handleBook}
            >
              Записаться
            </a>
            <button type="button" className="atlanty-modal__secondary" onClick={onClose}>
              Закрыть
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}

export function AtlantyEventModal(props: AtlantyEventModalProps) {
  const { onClose } = props;
  const restoreFocusRef = useRef<Element | null>(null);

  useEffect(() => {
    restoreFocusRef.current = typeof document !== "undefined" ? document.activeElement : null;

    const focusTimer = window.setTimeout(() => {
      document.querySelector<HTMLButtonElement>(".atlanty-modal__close")?.focus();
    }, 0);

    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";

    const handleKeyDown = (keyboardEvent: KeyboardEvent) => {
      if (keyboardEvent.key === "Escape") {
        keyboardEvent.preventDefault();
        onClose();
      }
    };
    document.addEventListener("keydown", handleKeyDown);

    return () => {
      window.clearTimeout(focusTimer);
      document.removeEventListener("keydown", handleKeyDown);
      document.body.style.overflow = previousOverflow;
      const previous = restoreFocusRef.current;
      if (previous instanceof HTMLElement && document.contains(previous)) previous.focus();
    };
  }, [onClose]);

  if (typeof document === "undefined") return null;

  return createPortal(<AtlantyEventModalContent {...props} />, document.body);
}
