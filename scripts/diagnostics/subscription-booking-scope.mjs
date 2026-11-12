import { createDiagnostics } from "./runtime.mjs";
import { diagnosticContract } from "../../src/utils/errorDiagnosticsCore.mjs";

export const SUBSCRIPTION_BOOKING_SCOPE = "SUBSCRIPTION_BOOKING_409_503_V1";
const direct = new Set(["roster_bridge_response", "roster_projection_build", "roster_projection_ack"]);
const operationReads = new Set(["operation_find", "lk1_ingress_operation_find", "lk1_operation_find"]);
const route = event => event.method === "POST" && event.routeTemplate === "/lk/subscription-bookings";
// Activation facade: only snapshots needed for 409/503 and their final safe events.
// No middleware/header changes, keys, cross-route diagnostics or business callbacks.
export function createScopedBookingObserver({ sink, release, detailLimit = 600 } = {}) {
  const diagnostics = createDiagnostics({ release, detailLimit, sink(event) {
    const final = event.stage === "booking_finalize" && [409, 503].includes(event.httpStatus);
    const direct503 = event.httpStatus === 503 && (direct.has(event.stage)
      || (event.stage === "booking_prepare" && event.code === "GAME_CREATE_OWNER_GRAPH_UNAVAILABLE"));
    const suppression = event.eventKind === "suppression" && event.code === "DETAIL_SUPPRESSED"
      && event.aggregate === true && event.suppressedEventKind === "stage";
    if ((event.source === "node_red" && route(event) && (final || direct503)) || suppression) return sink?.(event);
  } });
  return Object.freeze({ scope: SUBSCRIPTION_BOOKING_SCOPE,
    observe(msg, stage, fields) {
      try {
        if (msg?.req?.method !== "POST" || msg.req.path !== "/lk/subscription-bookings") return;
        const ctx = msg._subscriptionBooking;
        const ordinary = ctx?.caller === "http" && !ctx.trainingRegistration && !ctx.managedCreateBinding
          && !msg._gameCreateOwner && !msg._quarterCreateCapability && !msg._trainingRegistrationCapability;
        const capture = stage === "booking_router" && ((ordinary && operationReads.has(ctx.step))
          || (ctx?.step !== "UNKNOWN" && diagnosticContract.enums.upstreamPhase.includes(ctx?.step)));
        const final = stage === "booking_finalize" && (msg.statusCode === 503 || (ordinary && msg.statusCode === 409));
        const direct503 = fields?.httpStatus === 503 && (direct.has(stage)
          || (stage === "booking_prepare" && fields.code === "GAME_CREATE_OWNER_GRAPH_UNAVAILABLE"));
        if (capture || final || direct503) diagnostics.observe(msg, stage, fields);
      } catch { /* No observer failure can alter a business operation. */ }
    },
    upstream() {}, transport() {}, media() {}, bindMax() {}, ingestClient() {},
    clientEnvelope() { return null; }, ref() {},
    middleware(_req, _res, next) { next(); },
    snapshot: () => diagnostics.snapshot(), flushSuppressed: () => diagnostics.flushSuppressed(),
    dispose: () => diagnostics.dispose(),
  });
}
