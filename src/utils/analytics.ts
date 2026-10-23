import { useEffect } from "react";
import { createDiagnosticBudget } from "./diagnosticBudget.mjs";
import { clientDiagnostic } from "./errorDiagnostics";
import { sanitizeEvent } from "./errorDiagnosticsCore.mjs";
import { SERV2, SERV2_FALLBACK, TENANT_KEY } from "../consts/api_config";
import {
  identifyFirebaseAnalyticsUser,
  trackFirebaseAnalyticsEvent,
} from "./firebase";
import {
  buildProjectUrlCandidates,
  resolveLkApiBaseUrlCandidates,
} from "./lkApiBaseUrls";
import {
  installLkIdleDataGuard,
  isLkIdleRequestPaused,
} from "./lkIdleDataGuard";

type AnalyticsPayload = Record<string, unknown>;

export interface IdentifyAnalyticsUserPayload {
  clientId?: string | null;
  phone?: string | null;
  email?: string | null;
  firstName?: string | null;
  lastName?: string | null;
  middleName?: string | null;
  sex?: string | null;
  birthDate?: string | null;
  onboardingCompleted?: boolean;
  levelLetter?: string | null;
  levelNumeric?: string | number | null;
}

interface AnalyticsUserContext {
  clientId?: string;
  phone?: string;
  email?: string;
  firstName?: string;
  lastName?: string;
  middleName?: string;
  sex?: string;
  birthDate?: string;
  onboardingCompleted?: boolean;
  levelLetter?: string;
  levelNumeric?: string;
}

interface AnalyticsEnvelope {
  event: string;
  timestamp: string;
  sessionId: string;
  source: string;
  tenantKey: string;
  page: {
    href: string | null;
    path: string | null;
    search: string | null;
    referrer: string | null;
  };
  device: {
    userAgent: string | null;
    language: string | null;
    platform: string | null;
    timezone: string | null;
    viewportWidth: number | null;
    viewportHeight: number | null;
  };
  user: AnalyticsUserContext;
  payload: AnalyticsPayload;
}

declare global {
  interface Window {
    __LK_ANALYTICS_CLICK_HANDLER__?: (event: MouseEvent) => void;
    __LK_ANALYTICS_CLICK_HANDLER_REFCOUNT__?: number;
    __LK_GLOBAL_ERROR_TRACKING_INSTALLED__?: boolean;
    __LK_CONSOLE_ERROR_PATCHED__?: boolean;
    __LK_CONSOLE_ERROR_ORIGINAL__?: typeof console.error;
  }
}

const SOURCE = "lk-widget";
const USER_STORAGE_KEY = `${TENANT_KEY}_lk_analytics_user_v1`;
const VISITS_STORAGE_KEY = `${TENANT_KEY}_lk_analytics_visits_v1`;
const PENDING_STORAGE_KEY = `${TENANT_KEY}_lk_analytics_pending_v1`;
const MAX_PENDING_EVENTS = 100;
const CLICK_DEDUPE_MS = 350;
const ANALYTICS_DISABLE_TTL_MS = 10 * 60 * 1000;
const NON_RETRYABLE_HTTP_STATUSES = new Set([400, 401, 403, 404, 405, 410, 413, 415, 422]);
const ANALYTICS_ERRORS_ONLY = String(
  import.meta.env.VITE_ANALYTICS_ERRORS_ONLY ?? "true",
).toLowerCase() !== "false";
const ANALYTICS_EVENT_ALLOWLIST = new Set(["client_error", "subscription_page_opened"]);

const sessionId = makeSessionId();
let userContext: AnalyticsUserContext = restoreUserContext();
let lastClickSignature = "";
let lastClickAt = 0;
let pendingFlush: Promise<void> | null = null;
let widgetOpenTracked = false;
const clientErrorBudget = createDiagnosticBudget(120);
const clientTransportBudget = createDiagnosticBudget(180);
let clientSuppressionTimer: ReturnType<typeof setTimeout> | null = null;
const diagnosticDeliveryStats = { deferredDeliveries: 0, queueEvictions: 0 };
export function clientDiagnosticDeliveryStats() { return { ...diagnosticDeliveryStats }; }
const migratedPendingEvents = new Map<string, string>();
let analyticsDisabledUntil = 0;
let analyticsDisableNotified = false;

interface SendEventResult {
  delivered: boolean;
  retryable: boolean;
  status: number | null;
  paused: boolean;
}

function makeSessionId(): string {
  if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") {
    return crypto.randomUUID();
  }
  return `lk-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
}

function trimString(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

function normalizePhone(value: string | null | undefined): string | null {
  const raw = trimString(value);
  if (!raw) return null;

  const digits = raw.replace(/\D/g, "");
  if (!digits) return null;

  if (digits.length === 11 && digits.startsWith("8")) {
    return `+7${digits.slice(1)}`;
  }
  if (digits.length === 11 && digits.startsWith("7")) {
    return `+${digits}`;
  }
  return `+${digits}`;
}

function cutText(value: string, maxLength = 120): string {
  if (value.length <= maxLength) return value;
  return `${value.slice(0, maxLength)}...`;
}

function normalizeSpaces(value: string): string {
  return value.replace(/\s+/g, " ").trim();
}

function safeToString(value: unknown): string {
  if (typeof value === "string") return value;
  if (typeof value === "number" || typeof value === "boolean" || typeof value === "bigint") {
    return String(value);
  }
  if (value === null) return "null";
  if (value === undefined) return "undefined";
  try {
    return JSON.stringify(value);
  } catch {
    return Object.prototype.toString.call(value);
  }
}



function parseJson<T>(raw: string | null, fallback: T): T {
  if (!raw) return fallback;
  try {
    return JSON.parse(raw) as T;
  } catch {
    return fallback;
  }
}

function canUseStorage() {
  return typeof window !== "undefined" && typeof window.localStorage !== "undefined";
}

function getFromStorage(key: string): string | null {
  if (!canUseStorage()) return null;
  try {
    return window.localStorage.getItem(key);
  } catch {
    return null;
  }
}

function saveToStorage(key: string, value: string) {
  if (!canUseStorage()) return;
  try {
    window.localStorage.setItem(key, value);
  } catch {
    // ignored
  }
}

function restoreUserContext(): AnalyticsUserContext {
  const raw = getFromStorage(USER_STORAGE_KEY);
  return parseJson<AnalyticsUserContext>(raw, {});
}

function saveUserContext() {
  saveToStorage(USER_STORAGE_KEY, JSON.stringify(userContext));
}

function dedupeEndpoints(values: Array<string | null | undefined>) {
  return Array.from(new Set(values.filter((value): value is string => Boolean(value))));
}

function resolveAnalyticsEndpoints(): string[] {
  const explicit = trimString(import.meta.env.VITE_ANALYTICS_URL as string | undefined);
  const explicitFallback = trimString(
    import.meta.env.VITE_ANALYTICS_FALLBACK_URL as string | undefined,
  );

  const configured = [explicit, explicitFallback].filter((value): value is string => Boolean(value));
  if (configured.length > 0) {
    return dedupeEndpoints(
      configured.flatMap((value) => buildProjectUrlCandidates(value, SERV2, SERV2_FALLBACK)),
    );
  }

  const analyticsOrigins = resolveLkApiBaseUrlCandidates(
    trimString(SERV2) ?? trimString(import.meta.env.VITE_SERV2 as string | undefined),
    SERV2_FALLBACK,
  );
  if (analyticsOrigins.length === 0) return [];

  const primaryPath = normalizePath(
    trimString(import.meta.env.VITE_ANALYTICS_PATH as string | undefined) ?? "/lk/analytics/events",
  );
  const fallbackPath = normalizePath(
    trimString(import.meta.env.VITE_ANALYTICS_FALLBACK_PATH as string | undefined) ?? "/lk/analytics/event",
  );

  return dedupeEndpoints(
    analyticsOrigins.flatMap((origin) => {
      const analyticsBase = origin.replace(/\/+$/, "");
      return fallbackPath === primaryPath
        ? [`${analyticsBase}${primaryPath}`]
        : [`${analyticsBase}${primaryPath}`, `${analyticsBase}${fallbackPath}`];
    }),
  );
}

function normalizePath(path: string): string {
  const clean = path.trim();
  if (!clean) return "/lk/analytics/events";
  return clean.startsWith("/") ? clean : `/${clean}`;
}

function readVisitCounters(): Record<string, number> {
  const raw = getFromStorage(VISITS_STORAGE_KEY);
  return parseJson<Record<string, number>>(raw, {});
}

function writeVisitCounters(value: Record<string, number>) {
  saveToStorage(VISITS_STORAGE_KEY, JSON.stringify(value));
}

function getVisitorKey(): { key: string; type: "client" | "phone" | "session" } {
  if (userContext.clientId) {
    return { key: `client:${userContext.clientId}`, type: "client" };
  }
  if (userContext.phone) {
    return { key: `phone:${userContext.phone}`, type: "phone" };
  }
  return { key: `session:${sessionId}`, type: "session" };
}

function readPendingEvents(): string[] {
  const restored = parseJson<unknown>(getFromStorage(PENDING_STORAGE_KEY), []);
  if (!Array.isArray(restored)) return [];
  const safe: string[] = [];
  for (const serialized of restored.slice(-MAX_PENDING_EVENTS)) {
    if (typeof serialized !== "string" || serialized.length > 65536) continue;
    try {
      const event = JSON.parse(serialized);
      if (event.event !== "client_error") { safe.push(serialized); continue; }
      // Legacy pending records never replay raw URL/user/device/message/stack data.
      let migrated = migratedPendingEvents.get(serialized);
      if (!migrated) {
        const diagnostic = sanitizeEvent(event.payload) ?? clientDiagnostic({ legacyEvent: true, deviceEventTime: event.timestamp });
        if (diagnostic) {
          migrated = JSON.stringify({ event: "client_error", timestamp: diagnostic.deviceEventTime, payload: diagnostic });
          migratedPendingEvents.set(serialized, migrated);
          while (migratedPendingEvents.size > MAX_PENDING_EVENTS) migratedPendingEvents.delete(migratedPendingEvents.keys().next().value!);
        }
      }
      if (migrated) safe.push(migrated);
    } catch { /* corrupt pending envelope */ }
  }
  writePendingEvents(safe); // A migrated event gets its ID once, before any resend.
  return safe;
}

function writePendingEvents(events: string[]) {
  diagnosticDeliveryStats.queueEvictions += Math.max(0, events.length - MAX_PENDING_EVENTS);
  saveToStorage(PENDING_STORAGE_KEY, JSON.stringify(events.slice(-MAX_PENDING_EVENTS)));
}

function queuePendingEvent(serializedEvent: string) {
  const queue = readPendingEvents();
  queue.push(serializedEvent);
  writePendingEvents(queue);
}

function buildEnvelope(event: string, payload: AnalyticsPayload): AnalyticsEnvelope | { event: string; timestamp: unknown; payload: AnalyticsPayload } {
  if (event === "client_error") return { event, timestamp: payload.deviceEventTime, payload };

  const href = typeof window !== "undefined" ? window.location.href : null;
  const path = typeof window !== "undefined" ? window.location.pathname : null;
  const search = typeof window !== "undefined" ? window.location.search : null;
  const referrer = typeof document !== "undefined" ? document.referrer : null;

  const userAgent = typeof navigator !== "undefined" ? navigator.userAgent : null;
  const language = typeof navigator !== "undefined" ? navigator.language : null;
  const platform = typeof navigator !== "undefined" ? navigator.platform : null;
  const timezone = Intl.DateTimeFormat().resolvedOptions().timeZone ?? null;
  const viewportWidth = typeof window !== "undefined" ? window.innerWidth : null;
  const viewportHeight = typeof window !== "undefined" ? window.innerHeight : null;

  return {
    event,
    timestamp: new Date().toISOString(),
    sessionId,
    source: SOURCE,
    tenantKey: TENANT_KEY,
    page: {
      href,
      path,
      search,
      referrer,
    },
    device: {
      userAgent,
      language,
      platform,
      timezone,
      viewportWidth,
      viewportHeight,
    },
    user: userContext,
    payload,
  };
}

function isAnalyticsTemporarilyDisabled() {
  if (analyticsDisabledUntil <= 0) return false;
  if (Date.now() < analyticsDisabledUntil) return true;
  analyticsDisabledUntil = 0;
  analyticsDisableNotified = false;
  return false;
}

function disableAnalyticsTransport(reason: string) {
  analyticsDisabledUntil = Date.now() + ANALYTICS_DISABLE_TTL_MS;
  if (analyticsDisableNotified) return;
  analyticsDisableNotified = true;
  if (typeof console !== "undefined" && typeof console.warn === "function") {
    console.warn(`[LK analytics] temporarily disabled: ${reason}`);
  }
}

async function sendEvent(
  serializedEvent: string,
): Promise<SendEventResult> {
  if (isLkIdleRequestPaused()) {
    return {
      delivered: false,
      retryable: false,
      status: null,
      paused: true,
    };
  }

  const endpoints = resolveAnalyticsEndpoints();
  if (endpoints.length === 0) {
    return {
      delivered: false,
      retryable: false,
      status: null,
      paused: false,
    };
  }

  // JSON beacons include credentials and fail against the public wildcard-CORS
  // collector. Keepalive fetch reports the HTTP result, not just queue admission.
  let hasRetryableFailure = false;
  let lastStatus: number | null = null;

  let diagnostic = false;
  try { diagnostic = JSON.parse(serializedEvent).event === "client_error"; } catch { /* existing non-diagnostic transport */ }
  for (const endpoint of endpoints) {
    if (diagnostic && !clientTransportBudget.admit(performance.now(), "client_error")) {
      diagnosticDeliveryStats.deferredDeliveries++;
      return { delivered: false, retryable: true, status: null, paused: false };
    }
    try {
      const response = await fetch(endpoint, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: serializedEvent,
        keepalive: true,
        credentials: "omit",
      });
      if (response.ok) {
        return {
          delivered: true,
          retryable: true,
          status: response.status,
          paused: false,
        };
      }
      lastStatus = response.status;
      if (!NON_RETRYABLE_HTTP_STATUSES.has(response.status)) {
        hasRetryableFailure = true;
      }
    } catch {
      hasRetryableFailure = true;
    }
  }

  return {
    delivered: false,
    retryable: hasRetryableFailure,
    status: lastStatus,
    paused: isLkIdleRequestPaused(),
  };
}

async function flushPendingEvents() {
  if (isLkIdleRequestPaused()) return;
  if (isAnalyticsTemporarilyDisabled()) return;
  if (pendingFlush) {
    await pendingFlush;
    return;
  }

  pendingFlush = (async () => {
    const queue = readPendingEvents();
    if (queue.length === 0) return;

    const nextQueue: string[] = [];
    for (const eventPayload of queue) {
      if (isLkIdleRequestPaused()) return;
      const result = await sendEvent(eventPayload);
      if (result.delivered) {
        continue;
      }

      if (result.paused) return;

      if (result.retryable) {
        nextQueue.push(eventPayload);
        continue;
      }

      writePendingEvents([]);
      disableAnalyticsTransport(
        `non-retryable response while flushing queue (status=${result.status ?? "n/a"})`,
      );
      return;
    }
    writePendingEvents(nextQueue);
  })().finally(() => {
    pendingFlush = null;
  });

  await pendingFlush;
}

export function identifyAnalyticsUser(payload: IdentifyAnalyticsUserPayload) {
  if (isLkIdleRequestPaused()) return;
  let changed = false;
  const nextContext: AnalyticsUserContext = { ...userContext };

  const clientId = trimString(payload.clientId);
  if (clientId && nextContext.clientId !== clientId) {
    nextContext.clientId = clientId;
    changed = true;
  }

  const phone = normalizePhone(payload.phone);
  if (phone && nextContext.phone !== phone) {
    nextContext.phone = phone;
    changed = true;
  }

  const email = trimString(payload.email);
  if (email && nextContext.email !== email) {
    nextContext.email = email;
    changed = true;
  }

  const firstName = trimString(payload.firstName);
  if (firstName && nextContext.firstName !== firstName) {
    nextContext.firstName = firstName;
    changed = true;
  }

  const lastName = trimString(payload.lastName);
  if (lastName && nextContext.lastName !== lastName) {
    nextContext.lastName = lastName;
    changed = true;
  }

  const middleName = trimString(payload.middleName);
  if (middleName && nextContext.middleName !== middleName) {
    nextContext.middleName = middleName;
    changed = true;
  }

  const sex = trimString(payload.sex);
  if (sex && nextContext.sex !== sex) {
    nextContext.sex = sex;
    changed = true;
  }

  const birthDate = trimString(payload.birthDate);
  if (birthDate && nextContext.birthDate !== birthDate) {
    nextContext.birthDate = birthDate;
    changed = true;
  }

  if (
    typeof payload.onboardingCompleted === "boolean"
    && nextContext.onboardingCompleted !== payload.onboardingCompleted
  ) {
    nextContext.onboardingCompleted = payload.onboardingCompleted;
    changed = true;
  }

  const levelLetter = trimString(payload.levelLetter);
  if (levelLetter && nextContext.levelLetter !== levelLetter) {
    nextContext.levelLetter = levelLetter;
    changed = true;
  }

  if (payload.levelNumeric !== null && payload.levelNumeric !== undefined) {
    const levelNumeric = String(payload.levelNumeric).trim();
    if (levelNumeric && nextContext.levelNumeric !== levelNumeric) {
      nextContext.levelNumeric = levelNumeric;
      changed = true;
    }
  }

  identifyFirebaseAnalyticsUser(payload);

  if (!changed) return;
  userContext = nextContext;
  saveUserContext();
}

export function trackAnalyticsEvent(
  event: string,
  payload: AnalyticsPayload = {},
  _options?: { preferBeacon?: boolean },
) {
  if (isLkIdleRequestPaused()) return;
  const eventName = trimString(event);
  if (!eventName) return;

  if (eventName === "client_error") {
    const safe = sanitizeEvent(payload);
    if (!safe) return;
    payload = safe;
  } else {
    trackFirebaseAnalyticsEvent(eventName, payload);
  }

  if (ANALYTICS_ERRORS_ONLY && !ANALYTICS_EVENT_ALLOWLIST.has(eventName)) return;
  if (isAnalyticsTemporarilyDisabled()) return;

  const serializedEvent = JSON.stringify(buildEnvelope(eventName, payload));

  void (async () => {
    if (isAnalyticsTemporarilyDisabled()) return;
    await flushPendingEvents();
    if (isAnalyticsTemporarilyDisabled()) return;

    const result = await sendEvent(serializedEvent);
    if (result.delivered) {
      return;
    }

    if (result.paused) return;

    if (result.retryable) {
      queuePendingEvent(serializedEvent);
      return;
    }

    disableAnalyticsTransport(
      `non-retryable analytics endpoint response (status=${result.status ?? "n/a"})`,
    );
    writePendingEvents([]);
  })();
}

export function trackWidgetOpenOnce(payload: AnalyticsPayload = {}) {
  if (widgetOpenTracked) return;
  widgetOpenTracked = true;
  trackAnalyticsEvent("widget_opened", payload);
}

export function trackCabinetVisit(payload: AnalyticsPayload = {}) {
  const counters = readVisitCounters();
  const { key, type } = getVisitorKey();
  const nextVisitCount = (counters[key] ?? 0) + 1;
  counters[key] = nextVisitCount;
  writeVisitCounters(counters);

  trackAnalyticsEvent("cabinet_visit", {
    visitCount: nextVisitCount,
    visitorType: type,
    ...payload,
  });
  return nextVisitCount;
}

export function trackClientError(
  source: string,
  _error: unknown,
  context: AnalyticsPayload = {},
  _options?: { handled?: boolean; severity?: "error" | "warning" },
) {
  try {
    const stage = source.startsWith("api.") ? "api_request"
      : source === "window.resource_error" ? "asset_load"
      : source.includes("profile") ? "profile_request"
      : source.includes("mount") ? "module_mount"
      : source.includes("load") ? "module_registration" : "global_error";
    const diagnostic = clientDiagnostic({ ...context, stage: context.stage ?? stage,
      code: context.code ?? (source === "api.request_http_error" ? "CLIENT_HTTP_ERROR"
        : source === "api.request_network_error" ? "CLIENT_NETWORK_ERROR" : "CLIENT_RUNTIME_ERROR") });
    if (!diagnostic) return;
    if (clientErrorBudget.admit(performance.now(), "client_error")) {
      trackAnalyticsEvent("client_error", { ...diagnostic, suppressed: false });
    } else if (!clientSuppressionTimer) {
      clientSuppressionTimer = setTimeout(flushClientDiagnosticSuppression, 1000);
    }
  } catch { /* Diagnostics must not change a request or UI lifecycle. */ }
}

export function flushClientDiagnosticSuppression() {
  if (clientSuppressionTimer) { clearTimeout(clientSuppressionTimer); clientSuppressionTimer = null; }
  try {
    for (const { kind, count } of clientErrorBudget.drain()) {
      const event = clientDiagnostic({ stage: "collector", code: "DETAIL_SUPPRESSED" });
      if (event) trackAnalyticsEvent("client_error", { ...event, requestId: undefined, eventKind: "suppression",
        aggregate: true, suppressed: true, suppressedEventKind: kind, suppressedCount: count, ...diagnosticDeliveryStats });
    }
  } catch { /* best-effort diagnostics */ }
}

function extractResourceErrorPayload(target: EventTarget | null): AnalyticsPayload | null {
  if (!(target instanceof Element)) return null;

  const tagName = target.tagName.toLowerCase();
  if (!["script", "link", "img", "video", "audio"].includes(tagName)) return null;

  const resourceUrl =
    trimString((target as HTMLScriptElement).src)
    ?? trimString((target as HTMLLinkElement).href)
    ?? trimString(target.getAttribute("src"))
    ?? trimString(target.getAttribute("href"));

  return {
    tagName,
    resourceUrl,
  };
}

function shouldIgnoreResourceError(payload: AnalyticsPayload): boolean {
  const tagName = trimString(payload.tagName)?.toLowerCase() ?? "";
  const resourceUrlRaw = trimString(payload.resourceUrl);
  if (!tagName || !resourceUrlRaw) return false;

  try {
    const baseHref = typeof window !== "undefined" ? window.location.href : undefined;
    const parsed = new URL(resourceUrlRaw, baseHref);
    const hostname = parsed.hostname.toLowerCase();
    const pathname = parsed.pathname.toLowerCase();

    // Ignore noisy Yandex Metrica click-map pixel failures (often blocked by browser/privacy tools).
    if (tagName === "img" && hostname === "mc.yandex.com" && pathname.startsWith("/clmap/")) {
      return true;
    }
    // Ignore Yandex Metrica bootstrap script failures (often blocked by privacy tools).
    if (
      tagName === "script"
      && (hostname === "mc.yandex.ru" || hostname === "mc.yandex.com")
      && (pathname === "/metrika/tag.js" || pathname === "/tag.js")
    ) {
      return true;
    }
  } catch {
    const normalized = resourceUrlRaw.toLowerCase();
    if (tagName === "img" && normalized.includes("mc.yandex.com/clmap/")) {
      return true;
    }
    if (
      tagName === "script"
      && (
        normalized.includes("mc.yandex.ru/metrika/tag.js")
        || normalized.includes("mc.yandex.com/metrika/tag.js")
        || normalized.includes("mc.yandex.ru/tag.js")
        || normalized.includes("mc.yandex.com/tag.js")
      )
    ) {
      return true;
    }
  }

  return false;
}

function shouldIgnoreConsoleError(args: unknown[]): boolean {
  if (args.length === 0) return false;
  const normalized = args
    .slice(0, 3)
    .map((arg) => safeToString(arg).toLowerCase())
    .join(" | ");

  if (normalized.includes("tildastat: fail pageview")) {
    return true;
  }

  return false;
}

function installConsoleErrorTracking() {
  if (typeof window === "undefined") return;
  if (window.__LK_CONSOLE_ERROR_PATCHED__) return;

  const original = console.error.bind(console);
  window.__LK_CONSOLE_ERROR_ORIGINAL__ = original;
  window.__LK_CONSOLE_ERROR_PATCHED__ = true;

  console.error = (...args: unknown[]) => {
    try {
      if (shouldIgnoreConsoleError(args)) {
        original(...args);
        return;
      }
      const maybeError = args.find((arg) => arg instanceof Error) ?? args[0];
      const serializedArgs = args
        .map((arg) => cutText(normalizeSpaces(safeToString(arg)), 600))
        .slice(0, 5);
      trackClientError(
        "console.error",
        maybeError,
        { args: serializedArgs },
        { handled: true, severity: "error" },
      );
    } catch {
      // ignored
    }

    original(...args);
  };
}

export function installGlobalErrorTracking() {
  if (typeof window === "undefined") return;
  // Every LK entrypoint calls this during bootstrap. The idle guard itself is
  // shared through window, so separately bundled overlays install it only once.
  installLkIdleDataGuard();
  if (window.__LK_GLOBAL_ERROR_TRACKING_INSTALLED__) return;

  window.__LK_GLOBAL_ERROR_TRACKING_INSTALLED__ = true;

  window.addEventListener(
    "error",
    (event) => {
      const resourceErrorPayload = extractResourceErrorPayload(event.target);
      if (resourceErrorPayload) {
        if (shouldIgnoreResourceError(resourceErrorPayload)) {
          return;
        }
        const resourceTag = trimString(resourceErrorPayload.tagName)?.toLowerCase() ?? "";
        const resourceSeverity: "error" | "warning" =
          resourceTag === "script" || resourceTag === "link" ? "error" : "warning";
        trackClientError(
          "window.resource_error",
          new Error("Resource failed to load"),
          resourceErrorPayload,
          { handled: false, severity: resourceSeverity },
        );
        return;
      }

      const errorEvent = event as ErrorEvent;
      const fallbackMessage = trimString(errorEvent.message) ?? "Unhandled runtime error";
      const errorPayload = errorEvent.error ?? new Error(fallbackMessage);
      trackClientError(
        "window.error",
        errorPayload,
        {
          filename: trimString(errorEvent.filename),
          lineno: errorEvent.lineno || null,
          colno: errorEvent.colno || null,
        },
        { handled: false, severity: "error" },
      );
    },
    true,
  );

  window.addEventListener("unhandledrejection", (event) => {
    trackClientError(
      "window.unhandledrejection",
      event.reason,
      {},
      { handled: false, severity: "error" },
    );
  });

  installConsoleErrorTracking();

  trackAnalyticsEvent("error_tracking_installed", {
    source: SOURCE,
  });
}

function pickClickable(target: EventTarget | null): HTMLElement | null {
  if (!(target instanceof Element)) return null;
  const clickable = target.closest("button, a, [role='button']");
  if (!(clickable instanceof HTMLElement)) return null;
  if (clickable.hasAttribute("data-analytics-ignore")) return null;
  return clickable;
}

function extractClickableLabel(element: HTMLElement): string {
  const explicit = trimString(element.getAttribute("data-analytics-label"));
  if (explicit) return explicit;

  const aria = trimString(element.getAttribute("aria-label"));
  if (aria) return aria;

  const title = trimString(element.getAttribute("title"));
  if (title) return title;

  const text = normalizeSpaces(element.textContent ?? "");
  if (text) return cutText(text);

  return element.tagName.toLowerCase();
}

function buildClickPayload(element: HTMLElement, event: MouseEvent): AnalyticsPayload {
  const elementTag = element.tagName.toLowerCase();
  const elementId = trimString(element.id);
  const className = typeof element.className === "string"
    ? cutText(normalizeSpaces(element.className), 180)
    : null;

  let href: string | null = null;
  let isExternal = false;
  let linkTarget: string | null = null;

  if (element instanceof HTMLAnchorElement) {
    href = trimString(element.getAttribute("href")) ?? trimString(element.href);
    linkTarget = trimString(element.target);
    if (href) {
      try {
        const parsedUrl = new URL(element.href, window.location.href);
        isExternal = parsedUrl.origin !== window.location.origin;
      } catch {
        isExternal = false;
      }
    }
  }

  const buttonType = element instanceof HTMLButtonElement
    ? trimString(element.type) ?? "button"
    : null;

  return {
    label: extractClickableLabel(element),
    elementTag,
    elementId,
    className,
    href,
    linkTarget,
    isExternal,
    buttonType,
    x: Math.round(event.clientX),
    y: Math.round(event.clientY),
  };
}

function trackClick(event: MouseEvent) {
  const clickable = pickClickable(event.target);
  if (!clickable) return;

  const payload = buildClickPayload(clickable, event);
  const signature = [
    String(payload.elementTag ?? ""),
    String(payload.label ?? ""),
    String(payload.href ?? ""),
    String(payload.x ?? ""),
    String(payload.y ?? ""),
  ].join("|");
  const now = Date.now();

  if (signature === lastClickSignature && now - lastClickAt < CLICK_DEDUPE_MS) {
    return;
  }
  lastClickSignature = signature;
  lastClickAt = now;

  trackAnalyticsEvent("ui_click", payload);
}

export function useGlobalClickAnalytics() {
  useEffect(() => {
    if (typeof document === "undefined" || typeof window === "undefined") {
      return;
    }

    if (!window.__LK_ANALYTICS_CLICK_HANDLER__) {
      window.__LK_ANALYTICS_CLICK_HANDLER__ = trackClick;
      window.__LK_ANALYTICS_CLICK_HANDLER_REFCOUNT__ = 0;
      document.addEventListener("click", trackClick, true);
    }

    window.__LK_ANALYTICS_CLICK_HANDLER_REFCOUNT__ =
      (window.__LK_ANALYTICS_CLICK_HANDLER_REFCOUNT__ ?? 0) + 1;

    return () => {
      const nextRefCount = (window.__LK_ANALYTICS_CLICK_HANDLER_REFCOUNT__ ?? 1) - 1;
      window.__LK_ANALYTICS_CLICK_HANDLER_REFCOUNT__ = nextRefCount;
      if (nextRefCount <= 0 && window.__LK_ANALYTICS_CLICK_HANDLER__) {
        document.removeEventListener("click", window.__LK_ANALYTICS_CLICK_HANDLER__, true);
        delete window.__LK_ANALYTICS_CLICK_HANDLER__;
        delete window.__LK_ANALYTICS_CLICK_HANDLER_REFCOUNT__;
      }
    };
  }, []);
}
