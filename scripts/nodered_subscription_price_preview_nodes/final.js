const ctx = msg._subscriptionPricePreview;
if (!ctx) return null;
msg.statusCode = ctx.statusCode || 200;
if (ctx.done && ctx.error) {
  const safeCode = /^[A-Z][A-Z0-9_]{1,100}$/.test(ctx.error) ? ctx.error : 'PRICE_PREVIEW_UNAVAILABLE';
  const safeStep = /^[A-Za-z][A-Za-z0-9_]{0,60}$/.test(ctx.step || '') ? ctx.step : null;
  // Only the server-validated event UUID, a count and known refusal enums enter logs.
  // Never copy errorDetails wholesale: its observed data comes from the provider.
  const eventDiagnostics = ctx.exerciseId === undefined ? {} : {
    exerciseId: typeof ctx.exerciseId === 'string'
      && /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(ctx.exerciseId)
      ? ctx.exerciseId : null,
    tariffCount: Number.isSafeInteger(ctx.tariffCount) && ctx.tariffCount >= 0 ? ctx.tariffCount : null,
    reason: ['upstream_error', 'incomplete_tariff_list', 'empty_tariff_list', 'multiple_tariffs',
      'invalid_tariff_record', 'request_url', 'product_identity', 'product_type', 'product_amount',
      'product_trial_amount', 'amount_ceiling'].includes(ctx.errorDetails?.reason)
      ? ctx.errorDetails.reason : safeCode,
  };
  // `node` is always present in Node-RED, but the body is also executed by bare test
  // harnesses; the telemetry must never turn a refusal into a ReferenceError.
  if (typeof node !== 'undefined' && node && typeof node.warn === 'function') {
    node.warn(JSON.stringify({ event: 'subscription_price_preview_failed', code: safeCode, step: safeStep,
      ...eventDiagnostics,
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
