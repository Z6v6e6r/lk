import { API_BASE, TENANT_KEY } from "../consts/api_config";
import {
  ATLANTY_DEFAULT_TIME_ZONE,
  buildAtlantyCategoriesSignature,
  buildAtlantyPeriodUrl,
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
  error: { status?: number; message: string } | null;
};

export type AtlantyScheduleFetchOptions = {
  /** Сколько дней вперёд смотреть расписание. */
  daysAhead?: number;
  /** Дата начала окна (YYYY-MM-DD); по умолчанию — сегодня в часовом поясе клуба. */
  dateFrom?: string;
  maxPages?: number;
  pageSize?: number;
  maxEvents?: number;
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
export const ATLANTY_SCHEDULE_REQUEST_TIMEOUT_MS = 12_000;
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

async function fetchJson(url: string, signal?: AbortSignal) {
  const controller = typeof AbortController === "function" ? new AbortController() : null;
  const timeoutId = controller
    ? setTimeout(() => controller.abort(), ATLANTY_SCHEDULE_REQUEST_TIMEOUT_MS)
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
      throw Object.assign(new Error(`Расписание недоступно (${response.status})`), {
        status: response.status,
      });
    }
    return (await response.json()) as unknown;
  } finally {
    if (timeoutId) clearTimeout(timeoutId);
    signal?.removeEventListener("abort", abortFromCaller);
  }
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
      if (collected.length >= maxEvents) break;
    }

    const events: AtlantyScheduleEvent[] = [];
    const seen = new Set<string>();
    for (const event of collected.sort(
      (left, right) => Date.parse(left.startAt) - Date.parse(right.startAt),
    )) {
      if (seen.has(event.id)) continue;
      seen.add(event.id);
      events.push(event);
      if (events.length >= maxEvents) break;
    }

    writeCache(cacheKey, events);
    return { data: events, error: null };
  } catch (error) {
    const status = (error as { status?: number } | null)?.status;
    return {
      data: null,
      error: {
        status,
        message: error instanceof Error && error.message
          ? error.message
          : "Не удалось загрузить расписание",
      },
    };
  }
}
