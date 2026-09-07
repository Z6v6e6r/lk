const identity = msg._subscriptionProduct;
const ok = msg.statusCode === 200 && msg.payload?.productId === identity?.productId;
delete msg._subscriptionProduct;
delete msg.headers; delete msg.error; delete msg.url; delete msg.method;
if (identity?.caller === 'booking') {
  const ctx = msg._subscriptionBooking;
  if (!ctx || ctx.step !== 'lk1_product_identity' || ctx.actorClientId !== identity.actorClientId
    || ctx.clientSubscriptionId !== identity.subscriptionId || ctx.tenantKey !== identity.tenantKey) return null;
  ctx.lk1ProductIdentity = ok ? { actorClientId: identity.actorClientId, subscriptionId: identity.subscriptionId,
    tenantKey: identity.tenantKey, productId: identity.productId, name: identity.catalog.name,
    purchaseDate: identity.purchaseDate, subscription: identity.subscription } : null;
  ctx.step = 'lk1_product_identity_return';
  return [msg, null, null];
}
delete msg._subscriptionBooking;
if (identity?.caller === 'refresh') {
  msg.payload = { ok, productId: identity.productId, name: ok ? identity.catalog.name : undefined,
    code: ok ? 'SUBSCRIPTION_PRODUCT_REFRESHED' : msg.payload?.code };
  return [null, null, { payload: msg.payload }];
}
// Existing clients consume only sertName; no administrative DTO or owner identity escapes.
if (ok) msg.payload = { sertName: identity.catalog.name };
msg.headers = { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store',
  'X-Correlation-ID': identity?.requestId || msg._msgid,
  'Access-Control-Expose-Headers': 'X-Correlation-ID', 'Access-Control-Allow-Origin': '*' };
return [null, msg, null];
