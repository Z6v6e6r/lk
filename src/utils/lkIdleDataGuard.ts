export const LK_IDLE_DATA_TIMEOUT_MS = 5 * 60 * 1000;
export const LK_IDLE_REQUEST_PAUSED_CODE = "LK_IDLE_REQUEST_PAUSED";

type LkIdleDataGuardStatus = "active" | "stale" | "refreshing";

type LkIdleDataGuardRuntime = {
  version: 1;
  status: LkIdleDataGuardStatus;
  lastActivityAt: number;
  activityTimerId: number | null;
  modalElement: HTMLDivElement | null;
  refreshButton: HTMLButtonElement | null;
  activeSockets: Set<WebSocket>;
  nativeFetch: typeof window.fetch | null;
  nativeXhrSend: typeof XMLHttpRequest.prototype.send | null;
  nativeSendBeacon: typeof navigator.sendBeacon | null;
  nativeWebSocket: typeof WebSocket | null;
};

type LkIdleDataGuardWindow = Window & {
  __LK_IDLE_DATA_GUARD_V1__?: LkIdleDataGuardRuntime;
};

const ACTIVITY_THROTTLE_MS = 1000;
const IDLE_GUARD_ELEMENT_ID = "lk-idle-data-guard";
const STALE_EVENT_NAME = "lk-idle-data-stale";

export class LkIdleRequestPausedError extends Error {
  readonly code = LK_IDLE_REQUEST_PAUSED_CODE;

  constructor() {
    super("Данные ЛК устарели. Обновите страницу, чтобы продолжить.");
    this.name = "LkIdleRequestPausedError";
  }
}

export function isLkIdleRequestPausedError(value: unknown): value is LkIdleRequestPausedError {
  if (!value || typeof value !== "object") return false;
  const candidate = value as { code?: unknown; name?: unknown };
  return candidate.code === LK_IDLE_REQUEST_PAUSED_CODE
    || candidate.name === "LkIdleRequestPausedError";
}

export function isLkIdleDeadlineReached(
  lastActivityAt: number,
  now: number,
  timeoutMs = LK_IDLE_DATA_TIMEOUT_MS,
): boolean {
  if (!Number.isFinite(lastActivityAt) || !Number.isFinite(now) || !Number.isFinite(timeoutMs)) {
    return false;
  }
  if (lastActivityAt <= 0 || timeoutMs <= 0 || now < lastActivityAt) return false;
  return now - lastActivityAt >= timeoutMs;
}

function getRuntime(): LkIdleDataGuardRuntime | null {
  if (typeof window === "undefined") return null;
  return (window as LkIdleDataGuardWindow).__LK_IDLE_DATA_GUARD_V1__ ?? null;
}

export function isLkIdleRequestPaused(): boolean {
  const runtime = getRuntime();
  return runtime !== null && runtime.status !== "active";
}

function closeActiveSockets(runtime: LkIdleDataGuardRuntime) {
  const sockets = Array.from(runtime.activeSockets);
  runtime.activeSockets.clear();
  sockets.forEach((socket) => {
    try {
      socket.close(1000, "LK idle timeout");
    } catch {
      // Closing a stale transport is best-effort only.
    }
  });
}

function ensureModal(runtime: LkIdleDataGuardRuntime): HTMLDivElement | null {
  if (typeof document === "undefined") return null;
  if (runtime.modalElement?.isConnected) return runtime.modalElement;

  const existing = document.getElementById(IDLE_GUARD_ELEMENT_ID);
  if (existing instanceof HTMLDivElement) {
    runtime.modalElement = existing;
    const existingButton = existing.querySelector("button");
    runtime.refreshButton = existingButton instanceof HTMLButtonElement ? existingButton : null;
    return existing;
  }

  const modal = document.createElement("div");
  modal.id = IDLE_GUARD_ELEMENT_ID;
  modal.className = "lk-idle-data-guard";
  modal.hidden = true;
  modal.setAttribute("role", "dialog");
  modal.setAttribute("aria-modal", "true");
  modal.setAttribute("aria-labelledby", "lk-idle-data-guard-title");
  modal.setAttribute("aria-describedby", "lk-idle-data-guard-description");

  const panel = document.createElement("div");
  panel.className = "lk-idle-data-guard__panel";

  const title = document.createElement("h2");
  title.id = "lk-idle-data-guard-title";
  title.className = "lk-idle-data-guard__title";
  title.textContent = "Данные ЛК устарели";

  const description = document.createElement("p");
  description.id = "lk-idle-data-guard-description";
  description.className = "lk-idle-data-guard__description";
  description.textContent = "Вы не пользовались личным кабинетом продолжительное время, обновите страницу, чтобы продолжить.";

  const refreshButton = document.createElement("button");
  refreshButton.type = "button";
  refreshButton.className = "lk-idle-data-guard__refresh";
  refreshButton.textContent = "Обновить";
  refreshButton.setAttribute("data-analytics-ignore", "true");
  refreshButton.addEventListener("click", () => {
    if (runtime.status !== "stale") return;
    runtime.status = "refreshing";
    refreshButton.disabled = true;
    refreshButton.textContent = "Обновляем…";
    window.location.reload();
  });

  panel.append(title, description, refreshButton);
  modal.append(panel);
  (document.body ?? document.documentElement).append(modal);

  runtime.modalElement = modal;
  runtime.refreshButton = refreshButton;
  return modal;
}

function pauseForIdle(runtime: LkIdleDataGuardRuntime) {
  if (runtime.status !== "active") return;
  runtime.status = "stale";
  if (runtime.activityTimerId !== null) {
    window.clearTimeout(runtime.activityTimerId);
    runtime.activityTimerId = null;
  }

  closeActiveSockets(runtime);
  const modal = ensureModal(runtime);
  if (modal) {
    modal.hidden = false;
    document.body?.classList.add("lk-idle-data-stale");
    window.requestAnimationFrame(() => runtime.refreshButton?.focus());
  }

  window.dispatchEvent(new CustomEvent(STALE_EVENT_NAME, {
    detail: {
      idleForMs: Math.max(0, Date.now() - runtime.lastActivityAt),
      timeoutMs: LK_IDLE_DATA_TIMEOUT_MS,
    },
  }));
}

function scheduleIdleDeadline(runtime: LkIdleDataGuardRuntime) {
  if (runtime.status !== "active") return;
  if (runtime.activityTimerId !== null) {
    window.clearTimeout(runtime.activityTimerId);
  }
  const remainingMs = Math.max(
    0,
    LK_IDLE_DATA_TIMEOUT_MS - (Date.now() - runtime.lastActivityAt),
  );
  runtime.activityTimerId = window.setTimeout(() => {
    runtime.activityTimerId = null;
    if (isLkIdleDeadlineReached(runtime.lastActivityAt, Date.now())) {
      pauseForIdle(runtime);
      return;
    }
    scheduleIdleDeadline(runtime);
  }, remainingMs);
}

function markActivity(runtime: LkIdleDataGuardRuntime) {
  if (runtime.status !== "active") return;
  const now = Date.now();
  if (isLkIdleDeadlineReached(runtime.lastActivityAt, now)) {
    pauseForIdle(runtime);
    return;
  }
  if (now - runtime.lastActivityAt < ACTIVITY_THROTTLE_MS) return;
  runtime.lastActivityAt = now;
  scheduleIdleDeadline(runtime);
}

function installFetchGuard(runtime: LkIdleDataGuardRuntime) {
  if (typeof window.fetch !== "function") return;
  const nativeFetch = window.fetch.bind(window);
  runtime.nativeFetch = nativeFetch;
  window.fetch = ((input: RequestInfo | URL, init?: RequestInit) => {
    if (runtime.status !== "active") {
      return Promise.reject(new LkIdleRequestPausedError());
    }
    return nativeFetch(input, init);
  }) as typeof window.fetch;
}

function installXhrGuard(runtime: LkIdleDataGuardRuntime) {
  if (typeof XMLHttpRequest === "undefined") return;
  const prototype = XMLHttpRequest.prototype;
  const nativeSend = prototype.send;
  runtime.nativeXhrSend = nativeSend;
  prototype.send = function guardedLkXhrSend(
    this: XMLHttpRequest,
    body?: Document | XMLHttpRequestBodyInit | null,
  ) {
    if (runtime.status !== "active") {
      throw new LkIdleRequestPausedError();
    }
    return nativeSend.call(this, body ?? null);
  } as typeof XMLHttpRequest.prototype.send;
}

function installSendBeaconGuard(runtime: LkIdleDataGuardRuntime) {
  if (typeof navigator === "undefined" || typeof navigator.sendBeacon !== "function") return;
  const nativeSendBeacon = navigator.sendBeacon.bind(navigator);
  runtime.nativeSendBeacon = nativeSendBeacon;
  try {
    navigator.sendBeacon = ((url: string | URL, data?: BodyInit | null) => {
      if (runtime.status !== "active") return false;
      return nativeSendBeacon(url, data);
    }) as typeof navigator.sendBeacon;
  } catch {
    // Some WebViews expose sendBeacon as read-only. Analytics also checks the guard directly.
  }
}

function installWebSocketGuard(runtime: LkIdleDataGuardRuntime) {
  if (typeof window.WebSocket !== "function") return;
  const NativeWebSocket = window.WebSocket;
  runtime.nativeWebSocket = NativeWebSocket;

  class GuardedLkWebSocket extends NativeWebSocket {
    constructor(url: string | URL, protocols?: string | string[]) {
      if (runtime.status !== "active") {
        throw new LkIdleRequestPausedError();
      }
      if (protocols === undefined) {
        super(url);
      } else {
        super(url, protocols);
      }
      runtime.activeSockets.add(this);
      this.addEventListener("close", () => runtime.activeSockets.delete(this), { once: true });
    }
  }

  window.WebSocket = GuardedLkWebSocket as typeof WebSocket;
}

function installActivityListeners(runtime: LkIdleDataGuardRuntime) {
  const onActivity = () => markActivity(runtime);
  const onVisibility = () => {
    if (document.visibilityState === "visible") markActivity(runtime);
  };

  window.addEventListener("pointerdown", onActivity, { capture: true, passive: true });
  window.addEventListener("pointermove", onActivity, { capture: true, passive: true });
  window.addEventListener("keydown", onActivity, true);
  window.addEventListener("wheel", onActivity, { capture: true, passive: true });
  window.addEventListener("touchstart", onActivity, { capture: true, passive: true });
  window.addEventListener("focus", onActivity, true);
  window.addEventListener("pageshow", onActivity, true);
  document.addEventListener("visibilitychange", onVisibility, true);
}

export function installLkIdleDataGuard(): void {
  if (typeof window === "undefined" || typeof document === "undefined") return;
  const guardWindow = window as LkIdleDataGuardWindow;
  if (guardWindow.__LK_IDLE_DATA_GUARD_V1__) return;

  const runtime: LkIdleDataGuardRuntime = {
    version: 1,
    status: "active",
    lastActivityAt: Date.now(),
    activityTimerId: null,
    modalElement: null,
    refreshButton: null,
    activeSockets: new Set<WebSocket>(),
    nativeFetch: null,
    nativeXhrSend: null,
    nativeSendBeacon: null,
    nativeWebSocket: null,
  };
  guardWindow.__LK_IDLE_DATA_GUARD_V1__ = runtime;

  installFetchGuard(runtime);
  installXhrGuard(runtime);
  installSendBeaconGuard(runtime);
  installWebSocketGuard(runtime);
  installActivityListeners(runtime);
  scheduleIdleDeadline(runtime);
}
