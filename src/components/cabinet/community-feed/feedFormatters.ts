export function getInitials(name: string) {
  return name
    .split(" ")
    .filter(Boolean)
    .slice(0, 2)
    .map((part) => part[0] ?? "")
    .join("")
    .toUpperCase();
}

function parseDate(value: string) {
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? new Date(parsed) : null;
}

export function formatFeedDayLabel(value: string) {
  const parsed = parseDate(value);
  if (!parsed) return "Скоро";

  const now = new Date();
  const startOfToday = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const startOfTarget = new Date(parsed.getFullYear(), parsed.getMonth(), parsed.getDate());
  const diffDays = Math.round((startOfTarget.getTime() - startOfToday.getTime()) / (1000 * 60 * 60 * 24));

  if (diffDays === 0) return "Сегодня";
  if (diffDays === 1) return "Завтра";
  if (diffDays === -1) return "Вчера";

  return parsed.toLocaleDateString("ru-RU", {
    day: "numeric",
    month: "long",
  });
}

export function formatFeedDateLabel(value: string) {
  const parsed = parseDate(value);
  if (!parsed) return "Скоро";
  return parsed.toLocaleDateString("ru-RU", {
    day: "numeric",
    month: "long",
  });
}

export function formatFeedShortDateLabel(value: string) {
  const parsed = parseDate(value);
  if (!parsed) return "Скоро";
  return parsed.toLocaleDateString("ru-RU", {
    day: "numeric",
    month: "short",
  });
}

export function formatFeedTimeLabel(value: string) {
  const parsed = parseDate(value);
  if (!parsed) return "Время уточняется";
  return parsed.toLocaleTimeString("ru-RU", {
    hour: "2-digit",
    minute: "2-digit",
  });
}

export function formatRelativePublishedLabel(value: string) {
  const parsed = parseDate(value);
  if (!parsed) return "только что";

  const diffMs = Date.now() - parsed.getTime();
  const diffMinutes = Math.max(0, Math.round(diffMs / (1000 * 60)));

  if (diffMinutes < 1) return "только что";
  if (diffMinutes < 60) return `${diffMinutes} мин назад`;

  const diffHours = Math.round(diffMinutes / 60);
  if (diffHours < 24) return `${diffHours} ч назад`;

  const diffDays = Math.round(diffHours / 24);
  if (diffDays < 7) return `${diffDays} дн назад`;

  return formatFeedShortDateLabel(value);
}

const MONTH_LABELS = ["ЯНВ", "ФЕВ", "МАРТ", "АПР", "МАЙ", "ИЮН", "ИЮЛ", "АВГ", "СЕН", "ОКТ", "НОЯ", "ДЕК"];
const WEEKDAY_LABELS = ["ВС", "ПН", "ВТ", "СР", "ЧТ", "ПТ", "СБ"];

function getParsedOrFallback(value: string) {
  return parseDate(value) ?? new Date();
}

function formatShortMonth(value: string) {
  const parsed = getParsedOrFallback(value);
  return parsed.toLocaleDateString("ru-RU", {
    day: "numeric",
    month: "short",
  });
}

export function formatDateMonthLabel(value: string) {
  const parsed = getParsedOrFallback(value);
  return MONTH_LABELS[parsed.getMonth()] ?? "МАРТ";
}

export function formatDateDayLabel(value: string) {
  const parsed = getParsedOrFallback(value);
  return String(parsed.getDate());
}

export function formatWeekdayLabel(value: string) {
  const parsed = getParsedOrFallback(value);
  return WEEKDAY_LABELS[parsed.getDay()] ?? "СБ";
}

export function formatRelativeDayCaption(value: string) {
  const label = formatFeedDayLabel(value).toLowerCase();
  return label === "скоро" ? formatShortMonth(value) : label;
}

export function formatGameBadgeLabel(value: string) {
  const label = formatFeedDayLabel(value);
  return `Игра • ${label}`;
}

export function formatTournamentBadgeLabel(value: string) {
  return `Турнир • ${formatFeedDateLabel(value)}`;
}

export function formatNewsBadgeLabel(value: string) {
  return `Новость • ${formatRelativeDayCaption(value)}`;
}

export function formatCommunityCreatedLabel(value: string) {
  return `с ${formatFeedShortDateLabel(value)}`;
}

export function formatCommunityMembersShortLabel(count: number) {
  if (count === 1) return "1 участник";
  return `${count} участника`;
}

export function formatCommunityMembersMetaLabel(count: number) {
  const mod10 = count % 10;
  const mod100 = count % 100;
  if (mod10 === 1 && mod100 !== 11) return `${count} участник`;
  if (mod10 >= 2 && mod10 <= 4 && (mod100 < 12 || mod100 > 14)) return `${count} участника`;
  return `${count} участников`;
}

export function formatSlotsLabel(count: number) {
  if (count === 1) return "1 место";
  if (count >= 2 && count <= 4) return `${count} места`;
  return `${count} мест`;
}
