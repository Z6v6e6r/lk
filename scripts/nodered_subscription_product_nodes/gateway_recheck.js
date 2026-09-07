if (ctx.step === 'product_owned_recheck') {
  const row = identitySelected(msg.payload, ctx);
  if (!isHttpOk(msg.statusCode) || !row || !identityBound(ctx)) return lk1Stop(ctx, 'LK1_PREWRITE_OWNERSHIP_UNAVAILABLE');
  ctx.lk1ProductIdentity.subscription = row;
  ctx.lk1ProductIdentity.purchaseDate = row.purchaseDate;
  msg.payload = ctx.productRecheckExercise;
  delete ctx.productRecheckExercise;
  ctx.productRecheckReady = true;
  ctx.step = 'exercise_recheck';
}
if (ctx.step === 'exercise_recheck' && ctx.lk1 && !ctx.productRecheckReady) {
  if (!isHttpOk(msg.statusCode)) return lk1Stop(ctx, 'LK1_PREWRITE_READ_UNAVAILABLE');
  ctx.productRecheckExercise = msg.payload;
  return prepareUserGet(ctx, 'product_owned_recheck',
    `/end-user/api/v1/${ctx.tenantKey}/subscriptions?includeFinished=true&size=1000`);
}
