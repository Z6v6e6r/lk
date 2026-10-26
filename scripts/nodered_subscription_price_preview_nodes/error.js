// Diagnostic observer: optional, no-throw; sourceHash is the uninstrumented business preimage.
const lkDiagnostic = (fields = {}) => {
  try {
    if (typeof global === "undefined" || typeof global.get !== "function") return;
    const observer = global.get("lkDiagnostics");
    observer?.observe(msg, "preview_error", { sourceHash: "b29321c7e1a9802f13839582c2aeae36018e7a70ed6886079f826c3887e915aa", ...fields });
  } catch { /* Observability cannot alter business execution. */ }
};
lkDiagnostic({ code: "STAGE_ENTER" });
// Keep only the calculation stage; never copy upstream error messages, URLs or payloads.
const ctx = msg._subscriptionPricePreview || {};
ctx.done = true;
ctx.statusCode = 503;
ctx.error = 'PRICE_PREVIEW_UNAVAILABLE';
msg._subscriptionPricePreview = ctx;
return msg;
