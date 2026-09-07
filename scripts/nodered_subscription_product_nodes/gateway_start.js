if (ctx.step === 'lk1_product_identity_return') {
  if (msg.statusCode !== 200 || !identityBound(ctx)) {
    return finishError(ctx, 503, 'Не удалось подтвердить продукт абонемента', {
      code: 'SUBSCRIPTION_PRODUCT_UNRESOLVED',
    });
  }
  ctx.step = 'lk1_profile_continue';
}
