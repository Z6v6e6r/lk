const ctx = msg._subscriptionPricePreview;
if (!ctx) return null;
msg.statusCode = ctx.statusCode || 200;
if (ctx.done && ctx.error) {
  const safeCode = /^[A-Z][A-Z0-9_]{1,100}$/.test(ctx.error) ? ctx.error : 'PRICE_PREVIEW_UNAVAILABLE';
  const safeStep = /^[A-Za-z][A-Za-z0-9_]{0,60}$/.test(ctx.step || '') ? ctx.step : null;
  // `node` is always present in Node-RED, but the body is also executed by bare test
  // harnesses; the telemetry must never turn a refusal into a ReferenceError.
  if (typeof node !== 'undefined' && node && typeof node.warn === 'function') {
    node.warn(JSON.stringify({ event: 'subscription_price_preview_failed', code: safeCode, step: safeStep,
      correlationId: /^[A-Za-z0-9._:-]{1,100}$/.test(msg._msgid || '') ? msg._msgid : null }));
  }
}
msg.headers = { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', 'Access-Control-Allow-Origin': '*', 'X-Correlation-ID': msg._msgid, 'Access-Control-Expose-Headers': 'X-Correlation-ID' };
msg.payload = ctx.done && ctx.error
  ? { error: { code: ctx.error, ...(ctx.errorDetails ? { details: ctx.errorDetails } : {}) } }
  : { quotes: ctx.quotes || [] };
delete msg._subscriptionPricePreview;
delete msg.url; delete msg.method; delete msg.error;
delete msg._managedSubscriptionPolicyInput; delete msg._managedSubscriptionPolicyDecision;
delete msg._subscriptionPricePreviewInput;
delete msg._subscriptionPricePreviewDecision;
return msg;
