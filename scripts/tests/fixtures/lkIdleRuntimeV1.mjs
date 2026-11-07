// Frozen activity/timer callbacks from the pre-tournament-hold V1 runtime
// (1a9d7a3a). Cached cabinet bundles retain these closures when a newer
// tournament overlay arrives; do not replace them with the current guard.
export function installLegacyIdleRuntimeV1() {
  const { window } = globalThis;
  const runtime = { version: 1, status: "active", lastActivityAt: Date.now(), activityTimerId: null,
    modalElement: { isConnected: true, hidden: true }, refreshButton: null, activeSockets: new Set(),
    nativeFetch: window.fetch, nativeXhrSend: null, nativeSendBeacon: null, nativeWebSocket: null };
  const deadlineReached = (last, now) => last > 0 && now >= last && now - last >= 300000;
  const pause = () => {
    if (runtime.status !== "active") return;
    runtime.status = "stale";
    if (runtime.activityTimerId !== null) { window.clearTimeout(runtime.activityTimerId); runtime.activityTimerId = null; }
    runtime.modalElement.hidden = false;
  };
  const schedule = () => {
    if (runtime.status !== "active") return;
    if (runtime.activityTimerId !== null) window.clearTimeout(runtime.activityTimerId);
    const remaining = Math.max(0, 300000 - (Date.now() - runtime.lastActivityAt));
    runtime.activityTimerId = window.setTimeout(() => {
      runtime.activityTimerId = null;
      if (deadlineReached(runtime.lastActivityAt, Date.now())) { pause(); return; }
      schedule();
    }, remaining);
  };
  const activity = () => {
    if (runtime.status !== "active") return;
    const now = Date.now();
    if (deadlineReached(runtime.lastActivityAt, now)) { pause(); return; }
    if (now - runtime.lastActivityAt < 1000) return;
    runtime.lastActivityAt = now; schedule();
  };
  window.__LK_IDLE_DATA_GUARD_V1__ = runtime;
  window.addEventListener("pointerdown", activity, { capture: true, passive: true });
  window.addEventListener("focus", activity, true);
  window.fetch = (...args) => runtime.status === "active" ? runtime.nativeFetch(...args)
    : Promise.reject(Object.assign(new Error("Paused"), { code: "LK_IDLE_REQUEST_PAUSED" }));
  schedule();
}
