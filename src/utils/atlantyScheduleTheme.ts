/**
 * Настройки внешнего вида витрины расписания.
 *
 * Все цвета, шрифты, размеры и отступы заданы CSS-переменными в
 * `AtlantySchedulePage.css`, поэтому хост-страница может переопределить их
 * своими правилами. Здесь — только то, что меняет разметку карточки.
 */

export type AtlantyPillIcon = "infinity" | "users" | "none";
export type AtlantyAvatarMode = "photo" | "none";
export type AtlantySeatsStyle = "segmented" | "plain";
export type AtlantyLevelStyle = "meta" | "chip";

export type AtlantyDisplayOptions = {
  /** Иконка в пилюле категории. */
  pillIcon: AtlantyPillIcon;
  /** Показывать ли фото тренера в футере карточки. */
  avatarMode: AtlantyAvatarMode;
  /** `segmented` — чип «1/8 | (+7 МЕСТ)», `plain` — строка «1/8 (+7 мест)». */
  seatsStyle: AtlantySeatsStyle;
  /** `meta` — уровень строкой с иконкой, `chip` — отдельной плашкой. */
  levelStyle: AtlantyLevelStyle;
  /** Сколько карточек показывать в ряд; 0 — фиксированная ширина карточки. */
  cardsPerView: number;
};

export type AtlantyDisplayOptionsInput = Partial<{
  pillIcon: string | null;
  avatarMode: string | null;
  seatsStyle: string | null;
  levelStyle: string | null;
  cardsPerView: number | string | null;
}>;

export const ATLANTY_DEFAULT_DISPLAY_OPTIONS: AtlantyDisplayOptions = {
  pillIcon: "infinity",
  avatarMode: "photo",
  seatsStyle: "segmented",
  levelStyle: "meta",
  cardsPerView: 0,
};

function normalizeEnum<T extends string>(
  value: string | null | undefined,
  allowed: readonly T[],
  fallback: T,
): T {
  const raw = String(value ?? "").trim().toLowerCase();
  return (allowed as readonly string[]).includes(raw) ? (raw as T) : fallback;
}

function normalizeCardsPerView(value: number | string | null | undefined) {
  if (value === null || value === undefined || value === "") return 0;
  const parsed = typeof value === "number" ? value : Number(String(value).trim());
  if (!Number.isFinite(parsed)) return 0;
  const floored = Math.trunc(parsed);
  return floored > 1 ? Math.min(floored, 6) : 0;
}

export function normalizeAtlantyDisplayOptions(
  input: AtlantyDisplayOptionsInput | null | undefined,
): AtlantyDisplayOptions {
  if (!input) return { ...ATLANTY_DEFAULT_DISPLAY_OPTIONS };
  return {
    pillIcon: normalizeEnum(input.pillIcon, ["infinity", "users", "none"], ATLANTY_DEFAULT_DISPLAY_OPTIONS.pillIcon),
    avatarMode: normalizeEnum(input.avatarMode, ["photo", "none"], ATLANTY_DEFAULT_DISPLAY_OPTIONS.avatarMode),
    seatsStyle: normalizeEnum(input.seatsStyle, ["segmented", "plain"], ATLANTY_DEFAULT_DISPLAY_OPTIONS.seatsStyle),
    levelStyle: normalizeEnum(input.levelStyle, ["meta", "chip"], ATLANTY_DEFAULT_DISPLAY_OPTIONS.levelStyle),
    cardsPerView: normalizeCardsPerView(input.cardsPerView),
  };
}

/**
 * Ширина карточки для режима «N в ряд» (как в макете лендинга).
 * Gap берём из CSS-переменной, чтобы шаг слайдера и вёрстка не расходились.
 */
export function buildAtlantyCardWidth(cardsPerView: number) {
  if (!Number.isFinite(cardsPerView) || cardsPerView <= 1) return null;
  const gaps = cardsPerView - 1;
  return `calc((100% - ${gaps} * var(--atlanty-gap)) / ${cardsPerView})`;
}
