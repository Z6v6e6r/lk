// Diagnostic observer: optional, no-throw; sourceHash is the uninstrumented business preimage.
const lkDiagnostic = (fields = {}) => {
  try {
    if (typeof global === "undefined" || typeof global.get !== "function") return;
    const observer = global.get("lkDiagnostics");
    observer?.observe(msg, "preview_final", { sourceHash: "144bd78464f873da2d76fbfe941664faa8cf9642456a425f5d57cc9ea354edcf", ...fields });
  } catch { /* Observability cannot alter business execution. */ }
};
lkDiagnostic({ code: "STAGE_ENTER" });
const ctx = msg._subscriptionPricePreview;
if (!ctx) return null;
msg.statusCode = ctx.statusCode || 200;
if (ctx.done && ctx.error) {
  lkDiagnostic({ code: ctx.error, reason: ctx.errorDetails?.reason, tariffCount: ctx.tariffCount,
    upstreamStatus: ctx.errorDetails?.upstreamStatus, httpStatus: msg.statusCode, outcome: "refused" });
}
msg.headers = { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', 'Access-Control-Allow-Origin': '*', 'X-Correlation-ID': msg._msgid, 'Access-Control-Expose-Headers': 'X-Correlation-ID' };
msg.payload = ctx.done && ctx.error
  ? { error: { code: ctx.error, ...(ctx.errorDetails ? { details: ctx.errorDetails } : {}) } }
  : { quotes: ctx.quotes || [], serverTimeMs: Date.now() };
delete msg._subscriptionPricePreview;
delete msg.url; delete msg.method; delete msg.error;
delete msg._managedSubscriptionPolicyInput; delete msg._managedSubscriptionPolicyDecision;
delete msg._subscriptionPricePreviewInput;
delete msg._subscriptionPricePreviewDecision;
return msg;
