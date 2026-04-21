type CalendarDateBadgeProps = {
  monthLabel: string;
  dayLabel: string | number;
  weekdayLabel?: string | null;
  onClick?: (() => void | Promise<void>) | null;
  badgeClassName?: string;
  buttonClassName?: string;
  caption?: string;
  disabled?: boolean;
  variant?: "default" | "game-card";
};

function joinClassNames(...values: Array<string | null | undefined | false>): string {
  return values.filter(Boolean).join(" ");
}

export function CalendarDateBadge({
  monthLabel,
  dayLabel,
  weekdayLabel,
  onClick,
  badgeClassName,
  buttonClassName,
  caption = "в календарь",
  disabled = false,
  variant = "default",
}: CalendarDateBadgeProps) {
  const handleClick = () => {
    if (disabled || !onClick) return;
    void onClick();
  };

  return (
    <button
      type="button"
      className={joinClassNames("calendar-date-badge-button", variant === "game-card" && "calendar-date-badge-button--game-card", buttonClassName)}
      onClick={(event) => {
        event.preventDefault();
        event.stopPropagation();
        handleClick();
      }}
      onKeyDown={(event) => {
        event.stopPropagation();
      }}
      disabled={disabled}
      aria-label="Добавить событие в календарь"
      title="Добавить в календарь"
    >
      <span className={joinClassNames("booking-date-badge", badgeClassName)}>
        <span className="booking-date-badge-month">{monthLabel}</span>
        <span className="booking-date-badge-day">{dayLabel}</span>
        {variant === "game-card" ? (
          <span className="booking-date-badge-weekday">{weekdayLabel || "—"}</span>
        ) : null}
      </span>
      {variant === "game-card" ? (
        <span className="calendar-date-badge-action" aria-hidden="true">
          <svg viewBox="0 0 24 24" className="calendar-date-badge-action-icon">
            <path d="M12 5v14M5 12h14" stroke="currentColor" strokeWidth="2.6" strokeLinecap="round" />
          </svg>
        </span>
      ) : (
        <span className="calendar-date-badge-caption">{caption}</span>
      )}
    </button>
  );
}
