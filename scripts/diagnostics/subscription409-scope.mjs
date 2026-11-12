import { createDiagnostics } from "./runtime.mjs";

// No middleware, credentials, business callbacks or cross-route diagnostics.
export function createScopedObserver({ sink, release, detailLimit = 600 } = {}) {
  const diagnostics = createDiagnostics({ release, detailLimit, sink(event) {
    const refusal = event.source === "node_red" && event.method === "POST"
      && event.routeTemplate === "/lk/subscription-bookings"
      && event.stage === "booking_finalize" && event.httpStatus === 409;
    // This count measures suppressed forwarded stage events, never requests/409s.
    const suppression = event.eventKind === "suppression" && event.code === "DETAIL_SUPPRESSED"
      && event.aggregate === true && event.suppressedEventKind === "stage";
    if (refusal || suppression) return sink?.(event);
  } });
  return Object.freeze({
    observe(msg, stage, fields) {
      try {
        const ctx = msg?._subscriptionBooking;
        if (msg?.req?.method !== "POST" || msg.req.path !== "/lk/subscription-bookings" || ctx?.caller !== "http"
          || ctx.trainingRegistration || ctx.managedCreateBinding || msg._gameCreateOwner
          || msg._quarterCreateCapability || msg._trainingRegistrationCapability) return;
        const capture = stage === "booking_router" && ["operation_find", "lk1_ingress_operation_find", "lk1_operation_find"].includes(ctx.step);
        const refusal = stage === "booking_finalize" && msg.statusCode === 409;
        if (capture || refusal) diagnostics.observe(msg, stage, fields);
      } catch { /* Diagnostic failure must not affect business execution. */ }
    },
    upstream() {}, transport() {}, media() {}, bindMax() {}, ingestClient() {},
    clientEnvelope() { return null; }, ref() {},
    middleware(_req, _res, next) { next(); },
    snapshot: () => diagnostics.snapshot(),
    flushSuppressed: () => diagnostics.flushSuppressed(),
    dispose: () => diagnostics.dispose(),
  });
}
