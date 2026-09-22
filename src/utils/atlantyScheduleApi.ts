import { API_BASE, TENANT_KEY } from "../consts/api_config";
import {
  ATLANTY_SCHEDULE_FALLBACK_MESSAGE,
  classifyAtlantyFetchError,
  createAtlantyFailure,
  shouldRetryAtlantyFailure,
  type AtlantyScheduleFailure,
} from "./atlantyScheduleErrors";
import {
  ATLANTY_DEFAULT_TIME_ZONE,
  buildAtlantyCategoriesSignature,
  buildAtlantyPeriodUrl,
  limitAtlantyEventsPerCategory,
  normalizeAtlantyEventList,
  resolveAtlantyCategories,
  resolveAtlantyDateFrom,
  resolveAtlantyDateTo,
  resolveAtlantyDirectionsParam,
  type AtlantyCategory,
  type AtlantyScheduleEvent,
} from "./atlantyScheduleModel";

export type AtlantyScheduleResult = {
  data: AtlantyScheduleEvent[] | null;
  error: {
    status?: number;
    message: string;
    /** Запрос отменён вызывающей стороной — показывать ошибку не нужно. */
    aborted?: boolean;
  } | null;
};

export type AtlantyScheduleFetchOptions = {
  /** Сколько дней вперёд смотреть расписание. */
  daysAhead?: number;
  /** Дата начала окна (YYYY-MM-DD); по умолчанию — сегодня в часовом поясе клуба. */
  dateFrom?: string;
  maxPages?: number;
  pageSize?: number;
  maxEvents?: number;
  /**
   * Сколько ближайших событий брать из каждой категории (0 — без квоты).
   * Нужна, когда одна категория плотнее другой и вытесняет её из витрины.
   */
  maxPerCategory?: number;
  /** Выбранные категории (направления) расписания. */
  categories?: readonly AtlantyCategory[] | null;
  timeZone?: string;
  /** Сдвиг «сейчас» для тестов и предпросмотра. */
  now?: number;
  forceRefresh?: boolean;
  signal?: AbortSignal;
};

export const ATLANTY_SCHEDULE_DAYS_AHEAD = 120;
export const ATLANTY_SCHEDULE_MAX_PAGES = 4;
export const ATLANTY_SCHEDULE_PAGE_SIZE = 500;
export const ATLANTY_SCHEDULE_MAX_EVENTS = 24;
/** 0 — без квоты: витрина берёт ближайшие maxEvents событий подряд. */
export const ATLANTY_SCHEDULE_MAX_PER_CATEGORY = 0;
export const ATLANTY_SCHEDULE_REQUEST_TIMEOUT_MS = 12_000;
export const ATLANTY_SCHEDULE_RETRY_TIMEOUT_MS = 20_000;
export const ATLANTY_SCHEDULE_REQUEST_ATTEMPTS = 2;
export const ATLANTY_SCHEDULE_RETRY_DELAY_MS = 700;
export const ATLANTY_SCHEDULE_CACHE_TTL_MS = 5 * 60 * 1000;

const CACHE_STORAGE_KEY = "atlanty-schedule-cache-v2";

type CachePayload = {
  expiresAt: number;
  events: AtlantyScheduleEvent[];
};

function buildCacheKey(categories: readonly AtlantyCategory[]) {
  return `${CACHE_STORAGE_KEY}:${buildAtlantyCategoriesSignature(categories) || "default"}`;
}

function readCache(cacheKey: string): AtlantyScheduleEvent[] | null {
  if (typeof window === "undefined") return null;
  try {
    const raw = window.sessionStorage.getItem(cacheKey);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as CachePayload;
    if (!parsed || !Array.isArray(parsed.events)) return null;
    if (typeof parsed.expiresAt !== "number" || parsed.expiresAt < Date.now()) return null;
    return parsed.events;
  } catch {
    return null;
  }
}

function writeCache(cacheKey: string, events: AtlantyScheduleEvent[]) {
  if (typeof window === "undefined") return;
  try {
    const payload: CachePayload = {
      expiresAt: Date.now() + ATLANTY_SCHEDULE_CACHE_TTL_MS,
      events,
    };
    window.sessionStorage.setItem(cacheKey, JSON.stringify(payload));
  } catch {
    /* приватный режим — кеш недоступен, работаем без него */
  }
}

export function clearAtlantyScheduleCache() {
  if (typeof window === "undefined") return;
  try {
    const keys: string[] = [];
    for (let index = 0; index < window.sessionStorage.length; index += 1) {
      const key = window.sessionStorage.key(index);
      if (key && key.startsWith(CACHE_STORAGE_KEY)) keys.push(key);
    }
    keys.forEach((key) => window.sessionStorage.removeItem(key));
  } catch {
    /* noop */
  }
}

export function buildAtlantyScheduleUrl(params: {
  dateFrom: string;
  dateTo: string;
  page?: number;
  size?: number;
  categories?: readonly AtlantyCategory[] | null;
}) {
  const categories = resolveAtlantyCategories(params.categories);
  return buildAtlantyPeriodUrl({
    apiBase: API_BASE,
    tenantKey: TENANT_KEY,
    dateFrom: params.dateFrom,
    dateTo: params.dateTo,
    page: params.page,
    size: params.size,
    directionIds: resolveAtlantyDirectionsParam(categories),
  });
}

function delay(ms: number, signal?: AbortSignal) {
  return new Promise<void>((resolve) => {
    const timeoutId = setTimeout(resolve, ms);
    signal?.addEventListener("abort", () => {
      clearTimeout(timeoutId);
      resolve();
    }, { once: true });
  });
}

async function fetchJsonOnce(
  url: string,
  signal: AbortSignal | undefined,
  timeoutMs: number,
): Promise<unknown> {
  if (signal?.aborted) {
    throw createAtlantyFailure("aborted", "caller signal already aborted");
  }

  const controller = typeof AbortController === "function" ? new AbortController() : null;
  let timedOut = false;
  const timeoutId = controller
    ? setTimeout(() => {
      timedOut = true;
      controller.abort();
    }, timeoutMs)
    : null;
  const abortFromCaller = () => controller?.abort();
  signal?.addEventListener("abort", abortFromCaller, { once: true });

  try {
    const response = await fetch(url, {
      method: "GET",
      headers: { Accept: "application/json" },
      cache: "no-store",
      signal: controller?.signal,
    });
    if (!response.ok) {
      throw createAtlantyFailure("http", `http ${response.status}`, response.status);
    }
    return (await response.json()) as unknown;
  } catch (error) {
    throw classifyAtlantyFetchError(error, {
      timedOut,
      callerAborted: Boolean(signal?.aborted),
    });
  } finally {
    if (timeoutId) clearTimeout(timeoutId);
    signal?.removeEventListener("abort", abortFromCaller);
  }
}

/**
 * Загружает JSON с одной повторной попыткой: короткий обрыв связи или
 * задумавшийся сервер не должны оставлять витрину пустой.
 */
async function fetchJson(url: string, signal?: AbortSignal): Promise<unknown> {
  let lastFailure: AtlantyScheduleFailure = createAtlantyFailure("network", "no attempts made");

  for (let attempt = 0; attempt < ATLANTY_SCHEDULE_REQUEST_ATTEMPTS; attempt += 1) {
    const timeoutMs = attempt === 0
      ? ATLANTY_SCHEDULE_REQUEST_TIMEOUT_MS
      : ATLANTY_SCHEDULE_RETRY_TIMEOUT_MS;
    try {
      return await fetchJsonOnce(url, signal, timeoutMs);
    } catch (error) {
      const failure = classifyAtlantyFetchError(error);
      lastFailure = failure;
      const isLastAttempt = attempt + 1 >= ATLANTY_SCHEDULE_REQUEST_ATTEMPTS;
      if (failure.kind === "aborted" || isLastAttempt || !shouldRetryAtlantyFailure(failure.kind)) {
        throw failure;
      }
      try {
        console.warn("[atlanty-schedule] повтор запроса расписания:", failure.reason);
      } catch {
        /* консоль может быть недоступна */
      }
      await delay(ATLANTY_SCHEDULE_RETRY_DELAY_MS * (attempt + 1), signal);
    }
  }

  throw lastFailure;
}

function readPageState(payload: unknown) {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
    return { last: true };
  }
  const record = payload as Record<string, unknown>;
  return { last: record.last === true };
}

/**
 * Загружает события выбранных категорий VivaCRM.
 *
 * Фильтр `directions` серверный, поэтому первая страница обычно уже содержит
 * весь список; остальные страницы добираются только при необходимости.
 * Категории входят в ключ кеша, поэтому смена набора не отдаёт старые данные.
 */
export async function apiFetchAtlantyEvents(
  options: AtlantyScheduleFetchOptions = {},
): Promise<AtlantyScheduleResult> {
  const timeZone = options.timeZone || ATLANTY_DEFAULT_TIME_ZONE;
  const daysAhead = options.daysAhead ?? ATLANTY_SCHEDULE_DAYS_AHEAD;
  const maxPages = Math.max(1, options.maxPages ?? ATLANTY_SCHEDULE_MAX_PAGES);
  const pageSize = Math.max(1, options.pageSize ?? ATLANTY_SCHEDULE_PAGE_SIZE);
  const maxEvents = Math.max(1, options.maxEvents ?? ATLANTY_SCHEDULE_MAX_EVENTS);
  const maxPerCategory = Math.max(
    0,
    options.maxPerCategory ?? ATLANTY_SCHEDULE_MAX_PER_CATEGORY,
  );
  const now = options.now ?? Date.now();
  const categories = resolveAtlantyCategories(options.categories);
  const cacheKey = buildCacheKey(categories);

  if (!options.forceRefresh) {
    const cached = readCache(cacheKey);
    if (cached) return { data: cached, error: null };
  }

  const dateFrom = options.dateFrom || resolveAtlantyDateFrom(now, timeZone);
  const dateTo = resolveAtlantyDateTo(dateFrom, daysAhead);

  try {
    const collected: AtlantyScheduleEvent[] = [];
    for (let page = 0; page < maxPages; page += 1) {
      const payload = await fetchJson(
        buildAtlantyScheduleUrl({ dateFrom, dateTo, page, size: pageSize, categories }),
        options.signal,
      );
      collected.push(
        ...normalizeAtlantyEventList(payload, {
          timeZone,
          now,
          categories,
        }),
      );
      if (readPageState(payload).last) break;
      // С активной квотой нужно дойти до конца окна, иначе редкая категория
      // может не попасть в выборку.
      if (maxPerCategory === 0 && collected.length >= maxEvents) break;
    }

    const sorted: AtlantyScheduleEvent[] = [];
    const seen = new Set<string>();
    for (const event of collected.sort(
      (left, right) => Date.parse(left.startAt) - Date.parse(right.startAt),
    )) {
      if (seen.has(event.id)) continue;
      seen.add(event.id);
      sorted.push(event);
    }
    const events = limitAtlantyEventsPerCategory(sorted, maxPerCategory, maxEvents);

    writeCache(cacheKey, events);
    return { data: events, error: null };
  } catch (error) {
    const failure = classifyAtlantyFetchError(error);
    if (failure.kind !== "aborted") {
      try {
        console.warn("[atlanty-schedule] не удалось загрузить расписание:", failure.reason);
      } catch {
        /* консоль может быть недоступна */
      }
    }
    return {
      data: null,
      error: {
        status: failure.status,
        message: failure.kind === "aborted"
          ? ""
          : failure.message || ATLANTY_SCHEDULE_FALLBACK_MESSAGE,
        ...(failure.kind === "aborted" ? { aborted: true } : {}),
      },
    };
  }
}
