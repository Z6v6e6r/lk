  if (ctx.action !== 'release' && !identityBound(ctx)) {
    ctx.step = 'lk1_product_identity';
    msg._subscriptionProduct = { caller: 'booking', step: 'start',
      tenantKey: ctx.tenantKey, actorClientId: ctx.actorClientId,
      subscriptionId: ctx.clientSubscriptionId, authHeader: ctx.authHeader,
      requestId: msg._msgid, startedAt: Date.now() };
    return emit(7);
  }
