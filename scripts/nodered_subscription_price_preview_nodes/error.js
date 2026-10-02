// Keep only the calculation stage; never copy upstream error messages, URLs or payloads.
const ctx = msg._subscriptionPricePreview || {};
ctx.done = true;
ctx.statusCode = 503;
ctx.error = 'PRICE_PREVIEW_UNAVAILABLE';
msg._subscriptionPricePreview = ctx;
return msg;
