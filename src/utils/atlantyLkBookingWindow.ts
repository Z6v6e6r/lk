/**
 * Окно записи LK1 поверх витрины расписания.
 *
 * Карточка витрины раньше открывала официальный попап VivaCRM: запись создавалась
 * клиентским токеном Viva и не проходила через контур ограничений ЛК. Здесь вместо
 * попапа поднимается то же окно, что и в ЛК1, — бандл `group-schedule.js`: вход по
 * телефону, варианты записи из Viva, скидка по подписке и запись через
 * `POST /lk/subscription-bookings`.
 *
 * Витрина при этом остаётся хостом: она создаёт оверлей `#lk-overlay` (классы из
 * `MyApp.css` приходят вместе с бандлом окна), грузит бандл с версией из
 * `release.json` и передаёт событие в `mount`.
 *
 * Бандл окна инжектит в страницу глобальные стили ЛК (`index.css` + `MyApp.css`:
 * `body`, `*`, `h1…h6`). На странице-витрине это переписало бы оформление
 * лендинга, поэтому оверлей держит собственные позиционные стили, а глобальные
 * стили окна подключаются на время работы и снимаются при закрытии.
 */

import type { GroupTrainingScope } from "./groupScheduleModel";

export const ATLANTY_LK_BOOKING_OVERLAY_ID = "lk-overlay";
export const ATLANTY_LK_BOOKING_OVERLAY_CLASS = "lk-overlay";
export const ATLANTY_LK_BOOKING_OVERLAY_OPEN_CLASS = "open";
export const ATLANTY_LK_BOOKING_BODY_CLASS = "lk-overlay-open";
export const ATLANTY_LK_BOOKING_WIDGET_GLOBAL = "LKWidgetGroupSchedule";
export const ATLANTY_LK_BOOKING_SCRIPT_ID = "padlhub-atlanty-lk-booking-script";
export const ATLANTY_LK_BOOKING_PRIMARY_ORIGIN = "https://padlhub.su";
export const ATLANTY_LK_BOOKING_FALLBACK_ORIGINS = [
  "https://lk-reserve.89-108-64-209.sslip.io",
] as const;
export const ATLANTY_LK_BOOKING_SCRIPT_PATH = "/lk/group-schedule.js";
export const ATLANTY_LK_BOOKING_RELEASE_PATH = "/lk/release.json";
export const ATLANTY_LK_BOOKING_RELEASE_TIMEOUT_MS = 5_000;
export const ATLANTY_LK_BOOKING_SCRIPT_TIMEOUT_MS = 15_000;
export const ATLANTY_LK_BOOKING_LOADING_TEXT = "Открываем окно записи…";
export const ATLANTY_LK_BOOKING_ERROR_TEXT =
  "Не удалось открыть окно записи. Попробуйте ещё раз или обновите страницу.";

export type AtlantyLkBookingWidgetMountOptions = {
  targetId?: string;
  onClose?: () => void;
  data?: unknown;
};

export type AtlantyLkBookingWidget = {
  mount: (options?: AtlantyLkBookingWidgetMountOptions) => void;
  update?: (options?: AtlantyLkBookingWidgetMountOptions) => void;
  unmount?: (targetId?: string) => void;
};

export type AtlantyLkBookingRequest = {
  /** Событие Viva, которое открывается в окне записи. */
  exerciseId: string;
  /** Направления окна: список расписания остаётся в рамках витрины. */
  directionIds?: readonly number[] | null;
  directionLabel?: string | null;
  /** Типы занятий витрины: корпоративные события вне клубного списка ЛК1. */
  allowedTypeIds?: readonly number[] | null;
  /** Основной origin бандлов; по умолчанию — CDN витрины. */
  assetOrigin?: string | null;
  /** Дополнительные origin'ы на случай недоступности основного. */
  assetOrigins?: readonly string[] | null;
  /** Вызывается после закрытия окна (кнопка «Назад» или Escape). */
  onClosed?: (() => void) | null;
  /** Готовый параметр `v` для cache-bust; если не задан — берётся из release.json. */
  releaseVersion?: string | null;
};

export type AtlantyLkBookingOpenResult =
  | { ok: true }
  | { ok: false; message: string };

function trimString(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const normalized = value.trim();
  return normalized || null;
}

function normalizeOrigin(value: unknown): string | null {
  const raw = trimString(value);
  if (!raw) return null;
  try {
    const url = new URL(raw, "https://padlhub.ru");
    return url.origin.replace(/\/+$/, "");
  } catch {
    return null;
  }
}

/** Список origin'ов бандла: основной первым, дубликаты убираются. */
export function normalizeAtlantyLkBookingOrigins(
  assetOrigin?: string | null,
  assetOrigins?: readonly string[] | null,
): string[] {
  const candidates = [
    normalizeOrigin(assetOrigin) ?? ATLANTY_LK_BOOKING_PRIMARY_ORIGIN,
    ...(Array.isArray(assetOrigins) ? assetOrigins : []).map((origin) => normalizeOrigin(origin)),
  ].filter((origin): origin is string => Boolean(origin));

  const seen = new Set<string>();
  const result: string[] = [];
  for (const origin of candidates) {
    if (seen.has(origin)) continue;
    seen.add(origin);
    result.push(origin);
  }
  return result.length > 0 ? result : [ATLANTY_LK_BOOKING_PRIMARY_ORIGIN];
}

function addQueryParam(src: string, key: string, value: string) {
  try {
    const url = new URL(src, typeof window !== "undefined" ? window.location.href : undefined);
    url.searchParams.set(key, value);
    return url.toString();
  } catch {
    const separator = src.includes("?") ? "&" : "?";
    return `${src}${separator}${encodeURIComponent(key)}=${encodeURIComponent(value)}`;
  }
}

/** URL бандла окна записи с версией релиза и обязательным cache-bust. */
export function buildAtlantyLkBookingScriptUrl(
  origin: string,
  options: { version?: string | null; cacheBust?: string | null } = {},
) {
  const base = `${origin.replace(/\/+$/, "")}${ATLANTY_LK_BOOKING_SCRIPT_PATH}`;
  const version = trimString(options.version);
  const cacheBust = trimString(options.cacheBust);
  const versioned = version ? addQueryParam(base, "v", version) : base;
  return cacheBust ? addQueryParam(versioned, "force_ts", cacheBust) : versioned;
}

/** URL манифеста релиза для cache-bust. */
export function buildAtlantyLkBookingReleaseUrl(origin: string, cacheBust?: string | null) {
  const base = `${origin.replace(/\/+$/, "")}${ATLANTY_LK_BOOKING_RELEASE_PATH}`;
  const normalizedBust = trimString(cacheBust);
  return normalizedBust ? addQueryParam(base, "force_ts", normalizedBust) : base;
}

/**
 * Область окна записи: типы занятий витрины и снятый фильтр по станции
 * (корпоративные события стоят на станции, которой нет в клубном списке ЛК).
 * Без типов область не сужается — окно работает как штатное.
 */
export function buildAtlantyLkBookingScope(options: {
  allowedTypeIds?: readonly number[] | null;
} = {}): GroupTrainingScope | null {
  const typeIds = Array.isArray(options.allowedTypeIds)
    ? Array.from(new Set(options.allowedTypeIds.filter((value) => Number.isInteger(value))))
    : [];
  if (typeIds.length === 0) return null;
  return { allowedTypeIds: typeIds, availableStudioIds: [] };
}

/** Данные, которые окно записи получает при монтировании. */
export function buildAtlantyLkBookingMountData(request: {
  exerciseId: string;
  directionIds?: readonly number[] | null;
  directionLabel?: string | null;
  allowedTypeIds?: readonly number[] | null;
}) {
  const directionIds = Array.isArray(request.directionIds)
    ? request.directionIds.filter((value) => Number.isInteger(value))
    : [];
  const scope = buildAtlantyLkBookingScope({ allowedTypeIds: request.allowedTypeIds });
  return {
    exerciseId: request.exerciseId,
    directionIds: directionIds.length > 0 ? directionIds : null,
    directionLabel: trimString(request.directionLabel),
    // Витрина открывает окно на конкретном событии, а не список /group: первый
    // «Назад» внутри окна должен закрывать его, а не показывать список дня.
    returnToFindGame: true,
    ...(scope ? { scope } : {}),
  };
}

let widgetPromise: Promise<AtlantyLkBookingWidget> | null = null;
let releaseVersionCache: string | null = null;
let activeWidget: AtlantyLkBookingWidget | null = null;
let activeOnClosed: (() => void) | null = null;
let escapeListenerAttached = false;
let headStyleSnapshot: Set<HTMLStyleElement> | null = null;
let lkInjectedStyles: HTMLStyleElement[] = [];

/**
 * Маркер глобальных стилей ЛК (`MyApp.css`): по нему отличаем стили окна от
 * стилей, которые Tilda добавляет на страницу во время загрузки бандла.
 */
const LK_STYLE_MARKER = "--community-primary-gradient";

/** Запоминает стили, которые уже были в документе до загрузки бандла окна. */
function snapshotHeadStyles() {
  const doc = getDocument();
  if (!doc?.head || headStyleSnapshot) return;
  headStyleSnapshot = new Set(Array.from(doc.head.querySelectorAll("style")));
}

/**
 * Забирает стили, добавленные бандлом окна. Их приходится снимать при закрытии:
 * глобальные правила ЛК (`body *`, `h1…h6`) иначе остаются на странице-витрине.
 */
function captureInjectedStyles() {
  const doc = getDocument();
  if (!doc?.head) return;
  const snapshot = headStyleSnapshot;
  const added = Array.from(doc.head.querySelectorAll("style"))
    .filter((style) => !snapshot?.has(style))
    .filter((style) => (style.textContent ?? "").includes(LK_STYLE_MARKER))
    .filter((style) => !lkInjectedStyles.includes(style));
  if (added.length > 0) lkInjectedStyles.push(...added);
}

function attachLkStyles() {
  const doc = getDocument();
  if (!doc?.head) return;
  lkInjectedStyles.forEach((style) => {
    if (!style.parentNode) doc.head.appendChild(style);
  });
}

function detachLkStyles() {
  lkInjectedStyles.forEach((style) => style.remove());
}

function getWindow(): (Window & Record<string, unknown>) | null {
  if (typeof window === "undefined") return null;
  return window as unknown as Window & Record<string, unknown>;
}

function getDocument(): Document | null {
  if (typeof document === "undefined") return null;
  return document;
}

export function isAtlantyLkBookingWidgetReady() {
  const currentWindow = getWindow();
  const candidate = currentWindow?.[ATLANTY_LK_BOOKING_WIDGET_GLOBAL];
  return Boolean(candidate && typeof (candidate as AtlantyLkBookingWidget).mount === "function");
}

function createCacheBust() {
  return `${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

function fetchWithTimeout(src: string, timeoutMs: number, cacheBust: string) {
  const controller = typeof AbortController === "function" ? new AbortController() : null;
  const timeoutId = controller ? setTimeout(() => controller.abort(), timeoutMs) : null;
  return fetch(addQueryParam(src, "force_ts", cacheBust), {
    cache: "no-store",
    ...(controller ? { signal: controller.signal } : {}),
  }).finally(() => {
    if (timeoutId) clearTimeout(timeoutId);
  });
}

async function fetchReleaseVersion(origin: string): Promise<string | null> {
  if (releaseVersionCache) return releaseVersionCache;
  if (typeof fetch !== "function") return null;
  const globalVersion = trimString(getWindow()?.__LK_RELEASE_VERSION__);
  if (globalVersion) {
    releaseVersionCache = globalVersion;
    return globalVersion;
  }
  try {
    const response = await fetchWithTimeout(
      buildAtlantyLkBookingReleaseUrl(origin),
      ATLANTY_LK_BOOKING_RELEASE_TIMEOUT_MS,
      createCacheBust(),
    );
    if (!response.ok) return null;
    const payload = (await response.json()) as { version?: unknown } | null;
    const version = trimString(payload?.version);
    if (version) releaseVersionCache = version;
    return version;
  } catch {
    return null;
  }
}

function loadScriptFromOrigin(origin: string, version: string | null): Promise<AtlantyLkBookingWidget> {
  return new Promise<AtlantyLkBookingWidget>((resolve, reject) => {
    const doc = getDocument();
    if (!doc) {
      reject(new Error("document недоступен"));
      return;
    }

    const script = doc.createElement("script");
    let settled = false;
    // Снимок делается прямо перед вставкой тега: всё, что появится позже и несёт
    // маркер стилей ЛК, — это стили загружаемого окна.
    snapshotHeadStyles();
    const timeoutId = setTimeout(() => {
      if (settled) return;
      settled = true;
      script.remove();
      reject(new Error(`Таймаут загрузки бандла записи (${origin})`));
    }, ATLANTY_LK_BOOKING_SCRIPT_TIMEOUT_MS);

    script.id = ATLANTY_LK_BOOKING_SCRIPT_ID;
    script.src = buildAtlantyLkBookingScriptUrl(origin, { version, cacheBust: createCacheBust() });
    script.async = true;
    script.crossOrigin = "anonymous";
    script.onload = () => {
      if (settled) return;
      settled = true;
      clearTimeout(timeoutId);
      if (!isAtlantyLkBookingWidgetReady()) {
        script.remove();
        reject(new Error("Бандл записи не зарегистрировал окно LK"));
        return;
      }
      resolve(getWindow()?.[ATLANTY_LK_BOOKING_WIDGET_GLOBAL] as AtlantyLkBookingWidget);
    };
    script.onerror = () => {
      if (settled) return;
      settled = true;
      clearTimeout(timeoutId);
      script.remove();
      reject(new Error(`Не удалось загрузить бандл записи (${origin})`));
    };

    (doc.head || doc.body || doc.documentElement).appendChild(script);
  });
}

/** Загружает бандл окна записи один раз и переиспользует его дальше. */
export function loadAtlantyLkBookingWidget(
  options: Pick<AtlantyLkBookingRequest, "assetOrigin" | "assetOrigins" | "releaseVersion"> = {},
): Promise<AtlantyLkBookingWidget> {
  if (widgetPromise) return widgetPromise;

  const origins = normalizeAtlantyLkBookingOrigins(options.assetOrigin, options.assetOrigins);
  const request = (async () => {
    if (isAtlantyLkBookingWidgetReady()) {
      return getWindow()?.[ATLANTY_LK_BOOKING_WIDGET_GLOBAL] as AtlantyLkBookingWidget;
    }

    const errors: string[] = [];
    for (const origin of origins) {
      const version = trimString(options.releaseVersion) ?? (await fetchReleaseVersion(origin));
      try {
        const widget = await loadScriptFromOrigin(origin, version);
        captureInjectedStyles();
        headStyleSnapshot = null;
        return widget;
      } catch (error) {
        captureInjectedStyles();
        errors.push(error instanceof Error ? error.message : String(error));
      }
    }
    headStyleSnapshot = null;
    widgetPromise = null;
    throw new Error(errors.join(" | ") || "Не удалось загрузить окно записи");
  })();

  widgetPromise = request;
  return request;
}

/**
 * Позиционные стили оверлея задаются напрямую: глобальные стили ЛК подключены
 * только пока окно открыто, а класс `.lk-overlay` живёт именно там.
 */
function styleOverlay(container: HTMLElement, open: boolean) {
  container.style.position = "fixed";
  container.style.inset = "0";
  container.style.zIndex = "10040";
  container.style.background = "#f5f5f7";
  container.style.overflowY = "auto";
  container.style.display = open ? "block" : "none";
}

function ensureOverlay(): HTMLElement | null {
  const doc = getDocument();
  if (!doc) return null;
  let container = doc.getElementById(ATLANTY_LK_BOOKING_OVERLAY_ID);
  if (!container) {
    container = doc.createElement("div");
    container.id = ATLANTY_LK_BOOKING_OVERLAY_ID;
    (doc.body || doc.documentElement).appendChild(container);
  }
  container.className = ATLANTY_LK_BOOKING_OVERLAY_CLASS;
  styleOverlay(container, true);
  return container;
}

function showOverlayPlaceholder(container: HTMLElement, text: string) {
  container.innerHTML = "";
  const placeholder = getDocument()?.createElement("div");
  if (!placeholder) return;
  placeholder.className = "overlay-loading";
  placeholder.setAttribute(
    "style",
    "min-height:100vh;display:flex;align-items:center;justify-content:center;font-size:15px;color:#6b7280;",
  );
  placeholder.textContent = text;
  container.appendChild(placeholder);
}

function hideOverlay() {
  const doc = getDocument();
  if (!doc) return;
  const container = doc.getElementById(ATLANTY_LK_BOOKING_OVERLAY_ID);
  if (container) {
    container.classList.remove(ATLANTY_LK_BOOKING_OVERLAY_OPEN_CLASS);
    container.textContent = "";
    styleOverlay(container, false);
  }
  doc.body?.classList.remove(ATLANTY_LK_BOOKING_BODY_CLASS);
}

function handleEscape(event: KeyboardEvent) {
  if (event.key !== "Escape") return;
  event.preventDefault();
  closeAtlantyLkBookingWindow();
}

function attachEscapeListener() {
  const doc = getDocument();
  if (!doc || escapeListenerAttached) return;
  doc.addEventListener("keydown", handleEscape);
  escapeListenerAttached = true;
}

function detachEscapeListener() {
  const doc = getDocument();
  if (!doc || !escapeListenerAttached) return;
  doc.removeEventListener("keydown", handleEscape);
  escapeListenerAttached = false;
}

export function isAtlantyLkBookingWindowOpen() {
  const doc = getDocument();
  const container = doc?.getElementById(ATLANTY_LK_BOOKING_OVERLAY_ID);
  return Boolean(container?.classList.contains(ATLANTY_LK_BOOKING_OVERLAY_OPEN_CLASS));
}

/** Закрывает окно записи: размонтирует виджет и убирает оверлей. */
export function closeAtlantyLkBookingWindow() {
  const onClosed = activeOnClosed;
  activeOnClosed = null;
  const widget = activeWidget;
  activeWidget = null;
  detachEscapeListener();

  try {
    widget?.unmount?.(ATLANTY_LK_BOOKING_OVERLAY_ID);
  } catch {
    /* виджет уже мог размонтироваться сам */
  }
  hideOverlay();
  detachLkStyles();
  if (onClosed) onClosed();
}

/** Открывает окно записи LK1 на выбранном событии витрины. */
export async function openAtlantyLkBookingWindow(
  request: AtlantyLkBookingRequest,
): Promise<AtlantyLkBookingOpenResult> {
  const exerciseId = trimString(request.exerciseId);
  if (!exerciseId) return { ok: false, message: "Событие не выбрано." };

  const doc = getDocument();
  if (!doc) return { ok: false, message: ATLANTY_LK_BOOKING_ERROR_TEXT };

  // Повторный вызов не должен оставлять смонтированный предыдущий виджет.
  if (activeWidget) closeAtlantyLkBookingWindow();

  const container = ensureOverlay();
  if (!container) return { ok: false, message: ATLANTY_LK_BOOKING_ERROR_TEXT };
  container.classList.add(ATLANTY_LK_BOOKING_OVERLAY_OPEN_CLASS);
  doc.body?.classList.add(ATLANTY_LK_BOOKING_BODY_CLASS);
  showOverlayPlaceholder(container, ATLANTY_LK_BOOKING_LOADING_TEXT);

  try {
    const widget = await loadAtlantyLkBookingWidget(request);
    activeWidget = widget;
    activeOnClosed = typeof request.onClosed === "function" ? request.onClosed : null;
    attachEscapeListener();
    attachLkStyles();
    widget.mount({
      targetId: ATLANTY_LK_BOOKING_OVERLAY_ID,
      onClose: () => closeAtlantyLkBookingWindow(),
      data: buildAtlantyLkBookingMountData({
        exerciseId,
        directionIds: request.directionIds,
        directionLabel: request.directionLabel,
        allowedTypeIds: request.allowedTypeIds,
      }),
    });
    return { ok: true };
  } catch {
    activeWidget = null;
    activeOnClosed = null;
    detachEscapeListener();
    hideOverlay();
    detachLkStyles();
    return { ok: false, message: ATLANTY_LK_BOOKING_ERROR_TEXT };
  }
}

/** Сброс состояния загрузки — для тестов и повторного использования на странице. */
export function resetAtlantyLkBookingWindowState() {
  widgetPromise = null;
  releaseVersionCache = null;
  activeWidget = null;
  activeOnClosed = null;
  headStyleSnapshot = null;
  lkInjectedStyles = [];
  detachEscapeListener();
}

export const ATLANTY_LK_BOOKING_RETURN_EXERCISE_PARAM = "groupExerciseId";
export const ATLANTY_LK_BOOKING_RETURN_SUCCESS_PARAM = "groupPaymentSuccess";
export const ATLANTY_LK_BOOKING_RETURN_FAILED_PARAM = "groupPaymentFailed";

export type AtlantyLkBookingReturn = {
  exerciseId: string;
  status: "success" | "failed";
};

/**
 * Возврат из оплаты: ЛК1 дописывает к адресу витрины `groupExerciseId` и статус,
 * поэтому окно записи можно открыть снова и показать состояние записи.
 */
export function readAtlantyLkBookingReturn(href: string): AtlantyLkBookingReturn | null {
  try {
    const url = new URL(href, "https://padlhub.ru");
    const exerciseId = trimString(url.searchParams.get(ATLANTY_LK_BOOKING_RETURN_EXERCISE_PARAM));
    if (!exerciseId) return null;
    const status = url.searchParams.get(ATLANTY_LK_BOOKING_RETURN_SUCCESS_PARAM) === "true"
      ? "success" as const
      : url.searchParams.get(ATLANTY_LK_BOOKING_RETURN_FAILED_PARAM) === "true"
        ? "failed" as const
        : null;
    return status ? { exerciseId, status } : null;
  } catch {
    return null;
  }
}

/** Тот же адрес без параметров оплаты: окно не должно открываться при перезагрузке. */
export function clearAtlantyLkBookingReturn(href: string): string {
  try {
    const url = new URL(href);
    [
      ATLANTY_LK_BOOKING_RETURN_EXERCISE_PARAM,
      ATLANTY_LK_BOOKING_RETURN_SUCCESS_PARAM,
      ATLANTY_LK_BOOKING_RETURN_FAILED_PARAM,
    ].forEach((param) => url.searchParams.delete(param));
    return `${url.pathname}${url.search}${url.hash}`;
  } catch {
    return href;
  }
}
