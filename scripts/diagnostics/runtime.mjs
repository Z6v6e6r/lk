import { createDiagnosticBudget } from "../../src/utils/diagnosticBudget.mjs";
import { randomUUID, createHmac } from "node:crypto";
import { performance } from "node:perf_hooks";
import { sanitizeEvent, routeTemplate, responseKind } from "../../src/utils/errorDiagnosticsCore.mjs";

// Importing this module has no timers, writes, network or registration side effects.
export function createDiagnostics({ sink, release, key, detailLimit = 600, now = () => new Date(), monotonic = () => performance.now() } = {}) {
  const contexts = new WeakMap();
  const metrics = { observed: 0, suppressed: 0, loggerFailures: 0 };
  const budget = createDiagnosticBudget(detailLimit);
  let suppressionTimer = null;
  const ref = (domain, value) => {
    try {
      if (!Buffer.isBuffer(key) || key.length < 32 || typeof value !== "string" || value.trim().length === 0 || value.length > 1024 || !["entity", "operation", "binding", "outbox"].includes(domain)) return undefined;
      return `h1:${createHmac("sha256", key).update(`lk-diagnostics-v1:${domain}\0${value}`).digest("hex").slice(0, 32)}`;
    } catch { return undefined; }
  };
  function bindMax(msg, command, connector = command?.connector) {
    try {
      if (!["MAX_BOT", "MAX_ACADEMY_BOT"].includes(connector)) return;
      msg._lkDiagnosticContext = { requestId: randomUUID(), attemptReference: randomUUID(), started: monotonic(), connector,
        outboxRef: ref("outbox", command?.id), operationRef: ref("outbox", command?.id), bindingRef: ref("binding", command?.targetExternalChatId || command?.targetExternalUserId),
        origin: ["SYSTEM", "VivaCRM"].includes(command?.origin) ? command.origin : "UNKNOWN", leaseAttempt: command?.attempts };
    } catch { metrics.loggerFailures++; }
  }
  function context(msg) {
    const owner = msg?.req || msg?.res || msg?.supportOutbox || msg;
    if (!owner || typeof owner !== "object") return null;
    let ctx = contexts.get(owner);
    if (!ctx) {
      ctx = { ...msg._lkDiagnosticContext, requestId: msg._lkDiagnosticContext?.requestId || randomUUID(), started: msg._lkDiagnosticContext?.started ?? monotonic(), stage: "ingress", outcome: "outcome_unknown", routeTemplate: routeTemplate(msg.req?.path), method: msg.req?.method ?? "UNKNOWN" };
      contexts.set(owner, ctx);
    }
    return ctx;
  }
  function deliver(event) {
    try {
      const pending = event ? sink?.(event) : undefined;
      if (pending && typeof pending.catch === "function") pending.catch(() => { metrics.loggerFailures++; });
    } catch { metrics.loggerFailures++; }
  }
  function flushSuppressed() {
    if (suppressionTimer) { clearTimeout(suppressionTimer); suppressionTimer = null; }
    for (const { kind, count } of budget.drain()) deliver(sanitizeEvent({ schemaVersion: 1, diagnosticEventId: randomUUID(),
      eventKind: "suppression", suppressedEventKind: kind, source: "node_red", stage: "collector", code: "DETAIL_SUPPRESSED",
      suppressed: true, aggregate: true, suppressedCount: count, serverTimeUtc: now().toISOString(), serverRelease: release }));
  }
  function emit(ctx, fields) {
    try {
      metrics.observed++;
      const event = sanitizeEvent({ ...ctx, ...fields, schemaVersion: 1, diagnosticEventId: randomUUID(), serverTimeUtc: now().toISOString(),
        durationMs: Math.max(0, monotonic() - ctx.started), source: "node_red", serverRelease: release, sourceRelease: release, suppressed: false });
      if (!event) return;
      if (!budget.admit(monotonic(), event.eventKind)) {
        metrics.suppressed++;
        if (!suppressionTimer) { suppressionTimer = setTimeout(flushSuppressed, 1000); suppressionTimer.unref?.(); }
        return;
      }
      deliver(event);
    } catch { metrics.loggerFailures++; }
  }
  function observe(msg, stage, fields = {}) {
    try {
      const ctx = context(msg);
      if (!ctx) return;
      ctx.stage = stage;
      if (fields.eventKind === "operation_result") ctx.outcome = fields.outcome ?? (fields.acknowledged === true ? "acknowledged" : "outcome_unknown");
      const command = msg.supportOutbox || (["MAX_BOT", "MAX_ACADEMY_BOT"].includes(msg.payload?.connector) ? msg.payload : null);
      const entity = typeof msg.req?.params?.gameId === "string" ? msg.req.params.gameId : undefined;
      const operation = msg.req?.headers?.["idempotency-key"];
      const target = command?.targetExternalChatId || command?.targetExternalUserId;
      emit(ctx, { eventKind: "stage", code: "STAGE_ENTER", entityRef: ref("entity", entity), operationRef: ref("operation", operation),
        outboxRef: ref("outbox", command?.id), bindingRef: ref("binding", target), ...fields, stage,
        operationStage: msg._referralSubscriptionCtx?.step ?? msg._subscriptionBooking?.step ?? msg._splitCtx?.step ?? msg._subscriptionPricePreview?.step,
        reqPresent: Boolean(msg.req), resPresent: Boolean(msg.res), refUnavailable: !Buffer.isBuffer(key) || key.length < 32 });
    } catch { metrics.loggerFailures++; }
  }
  function upstream(msg, stage, fields = {}) {
    const body = msg?.payload;
    observe(msg, stage, { eventKind: "stage", code: typeof msg.statusCode === "number" && msg.statusCode >= 400 ? "UPSTREAM_REFUSED" : "UPSTREAM_OBSERVED",
      upstreamStatus: msg.statusCode, responseKind: responseKind(body), errorPresent: Boolean(msg.error), dtoIdPresent: typeof body?.id === "string",
      dtoPaymentUrlPresent: typeof body?.paymentUrl === "string", dtoResultPresent: body?.result !== undefined,
      providerCode: body?.code ?? body?.error, ...fields });
  }
  function clientEnvelope(body, msg = {}) {
    if (body?.event !== "client_error") return null;
    try {
      const safe = sanitizeEvent(body.payload);
      const payload = sanitizeEvent({ ...(safe || {}), schemaVersion: 1, diagnosticEventId: safe?.diagnosticEventId || randomUUID(),
        requestId: safe?.requestId || randomUUID(), eventKind: "client_error", source: "browser",
        code: safe?.code || "CLIENT_RUNTIME_ERROR", stage: safe?.stage || "global_error", legacyEvent: !safe || safe.legacyEvent === true,
        serverTimeUtc: undefined, deviceEventTime: safe?.deviceEventTime || body.timestamp,
        serverIngestTime: now().toISOString(), serverRelease: release, serverRequestId: context(msg).requestId, deviceClockTrusted: false });
      return payload ? { event: "client_error", timestamp: payload.deviceEventTime, payload } : null;
    } catch { metrics.loggerFailures++; return null; }
  }
  function ingestClient(msg) {
    const safe = clientEnvelope(msg?.req?.body, msg);
    if (safe) msg.req.body = safe;
  }
  function media(msg, branch) {
    try {
      const rows = Array.isArray(msg.payload) ? msg.payload.filter(row => !row?.archived) : [];
      const row = rows[0];
      let originEqual;
      try { originEqual = new URL(row?.logoUrl).origin === new URL(`${msg.req?.protocol}://${msg.req?.headers?.host}`).origin; } catch { /* UNKNOWN */ }
      observe(msg, "media_lookup", { branch, dataPresent: Boolean(row), lookupCount: Math.min(rows.length, 2), originEqual,
        logoUrlPresent: typeof row?.logoUrl === "string", logoThumbPresent: typeof row?.logoThumbUrl === "string",
        logoLegacyPresent: typeof row?.logoLegacyDataUrl === "string" });
    } catch { metrics.loggerFailures++; }
  }
  function middleware(req, res, next) {
    try {
      if (routeTemplate(req.path) === "UNKNOWN") { /* unmatched requests have no diagnostics */ } else {
      const msg = { req, res };
      const ctx = context(msg);
      // Response-only correlation: no new request headers/preflight requirements or provider forwarding.
      res.setHeader("X-LK-Request-ID", ctx.requestId);
      const existing = res.getHeader("Access-Control-Expose-Headers");
      const setHeader = res.setHeader;
      res.setHeader = function(name, value) {
        if (String(name).toLowerCase() === "access-control-expose-headers") {
          const values = String(value).split(",").map(v => v.trim());
          if (!values.some(v => v.toLowerCase() === "x-lk-request-id")) values.push("X-LK-Request-ID");
          return setHeader.call(this, name, values.join(", "));
        }
        return setHeader.call(this, name, value);
      };
      res.setHeader("Access-Control-Expose-Headers", existing || "X-LK-Request-ID");
      observe(msg, "ingress");
      // Parsed-body intake is installed by addClientCollectorGate, after Node-RED body parsing.
      const end = res.end;
      res.end = function(...args) {
        emit(ctx, { eventKind: "stage", stage: "response_attempted", code: "RESPONSE_ATTEMPTED", httpStatus: res.statusCode });
        return end.apply(this, args);
      };
      let finished = false;
      res.once("finish", () => {
        finished = true;
        emit(ctx, { eventKind: "request_terminal", stage: ctx.stage, code: "HTTP_FINISH", httpStatus: res.statusCode, outcome: ctx.outcome });
      });
      res.once("close", () => {
        if (!finished) emit(ctx, { eventKind: "request_terminal", stage: ctx.stage, code: "DISCONNECT", outcome: ctx.outcome });
      });
      }
    } catch { metrics.loggerFailures++; }
    next();
  }
  function transport(msg, stage, error, diagnosticWarning = false, fields = {}) {
    try {
      observe(msg, stage, { eventKind: "transport", code: error?.code ?? "OUTCOME_UNKNOWN", sdkErrorPresent: Boolean(error),
        executionObserved: stage === "max_sdk_result", upstreamStatus: error?.status, transportCode1: error?.code, transportCode2: error?.cause?.code,
        transportCode3: error?.cause?.cause?.code, diagnosticWarning, outcome: "outcome_unknown", ...fields });
    } catch { metrics.loggerFailures++; }
  }
  return { observe, bindMax, upstream, transport, media, clientEnvelope, ingestClient, middleware, ref, flushSuppressed, dispose: flushSuppressed, snapshot: () => ({ ...metrics }) };
}
