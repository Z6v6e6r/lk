import { diagnosticContract } from "../../src/utils/errorDiagnosticsCore.mjs";

// Per HTTP request, retain only comparisons. Never retain a row, ID, body or key.
export function createSubscriptionBookingConflictObserver(now = () => Date.now()) {
  const observations = new WeakMap();
  const upstream = new WeakMap();
  const known = (field, value) => diagnosticContract.enums[field].includes(value) ? value : "UNKNOWN";
  const text = value => typeof value === "string" && value.trim() ? value.trim() : undefined;
  const equal = (a, b) => text(a) !== undefined && text(b) !== undefined
    ? text(a).toLowerCase() === text(b).toLowerCase() : undefined;
  return function observeConflict(msg, stage, fields = {}) {
    const req = msg.req, ctx = msg._subscriptionBooking;
    if (!req || typeof req !== "object" || req.method !== "POST" || req.path !== "/lk/subscription-bookings") return null;
    const ordinary = ctx?.caller === "http" && !ctx.trainingRegistration && !ctx.managedCreateBinding
      && !msg._gameCreateOwner && !msg._quarterCreateCapability && !msg._trainingRegistrationCapability;
    // Entry hooks see the actual HTTP result before the router replaces it.
    // Retain only the last observed phase/status, never its body or error text.
    if (stage === "booking_router" && diagnosticContract.enums.upstreamPhase.includes(ctx?.step)
      && ctx.step !== "UNKNOWN") {
      const status = msg.statusCode;
      upstream.set(req, { upstreamPhase: ctx.step,
        ...(Number.isInteger(status) && status >= 100 && status <= 599 ? { upstreamStatus: status } : {}),
        errorPresent: Boolean(msg.error) });
    }
    const direct = ["roster_bridge_response", "roster_projection_build", "roster_projection_ack"].includes(stage)
      || (stage === "booking_prepare" && fields.code === "GAME_CREATE_OWNER_GRAPH_UNAVAILABLE");
    const status = direct ? fields.httpStatus : msg.statusCode;
    if (status === 503 && (direct || stage === "booking_finalize")) {
      const bridgeStatus = stage === "roster_bridge_response" && Number.isInteger(fields.upstreamStatus)
        && fields.upstreamStatus >= 100 && fields.upstreamStatus <= 599;
      return {
        ...upstream.get(req),
        ...(bridgeStatus ? { upstreamPhase: stage, upstreamStatus: fields.upstreamStatus } : {}),
        code: known("code", direct ? fields.code : msg.payload?.details?.code ?? msg.payload?.code),
        action: known("action", ctx?.action),
        operationStage: known("operationStage", direct ? stage : ctx?.step),
        httpStatus: 503, outcome: "outcome_unknown",
        entityRef: undefined, operationRef: undefined, bindingRef: undefined, outboxRef: undefined,
      };
    }
    if (!ordinary) return null;
    if (stage === "booking_router" && ["operation_find", "lk1_ingress_operation_find", "lk1_operation_find"].includes(ctx.step)) {
      const rows = msg.payload;
      const valid = !msg.error && Array.isArray(rows) && rows.length <= 1
        && rows.every(row => row && typeof row === "object" && !Array.isArray(row));
      const facts = { operationReadValid: Boolean(valid) };
      if (valid) {
        facts.operationFound = rows.length === 1;
        const row = rows[0];
        if (row) {
          if (text(row.operationId) && text(ctx.operationId)) facts.sameOperationKey = text(row.operationId) === text(ctx.operationId);
          const sameSubscription = equal(row.clientSubscriptionId, ctx.clientSubscriptionId);
          const sameTarget = ctx.action === "release"
            ? equal(row.bookingId || row.upstreamBookingId, ctx.releaseBookingId)
            : ctx.action === "book" ? equal(row.exerciseId, ctx.exerciseId) : undefined;
          if (sameSubscription !== undefined && sameTarget !== undefined) facts.sameOperationTarget = sameSubscription && sameTarget;
          if (["PREPARED", "PENDING_CONFIRMATION", "CONFIRMED", "FAILED", "RELEASED"].includes(row.state)) facts.operationState = row.state;
          for (const [key, field] of [["leaseUntil", "leaseExpired"], ["pendingUntil", "pendingExpired"]]) {
            const expiry = typeof row[key] === "string" ? Date.parse(row[key]) : NaN;
            if (Number.isFinite(expiry)) facts[field] = expiry <= now();
          }
        }
      }
      // An invalid/latest read replaces older facts rather than suggesting a match.
      observations.set(req, facts);
    }
    if (stage !== "booking_finalize" || msg.statusCode !== 409) return null;
    return {
      ...observations.get(req),
      code: msg.payload?.details?.code ?? msg.payload?.code ?? "UNKNOWN",
      action: ctx.action,
      idempotencyKeyPresent: text(ctx.operationId) !== undefined,
      httpStatus: 409,
      outcome: "refused",
      // Existing diagnostic correlation is request-scoped; no entity/key references.
      entityRef: undefined, operationRef: undefined, bindingRef: undefined, outboxRef: undefined,
    };
  };
}
