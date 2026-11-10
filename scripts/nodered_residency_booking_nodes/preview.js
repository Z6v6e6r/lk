const residencyPreviewTarget = exercise => ({resolutionSource:'SERVER',category:eventRoute?eventCategory:'GAME',
  stationId:ctx.target.stationId,externalEventTypeId:canonical.managedExternalEventTypeId(exercise),
  startsAt:new Date(ctx.target.startsAt).toISOString(),durationMinutes:ctx.target.durationMinutes});
if (ctx.step==='residency_context') {
  const pending=ctx.residencyPending;
  const config=residencyTransportConfig(key=>global.get(key));
  if (!config || !pending || msg.error || msg.statusCode!==200 || msg.method!=='POST'
    || msg.url!==config.url || msg.responseUrl!==config.url) return stop('RESIDENCY_BOOKING_CONTEXT_UNAVAILABLE');
  try {validateResidencyBookingContext(msg.payload,pending.id,Date.now(),pending.target,pending.action);}
  catch {return stop('RESIDENCY_BOOKING_CONTEXT_INVALID');}
  ctx.residencyContexts=ctx.residencyContexts || {};
  ctx.residencyContexts[pending.id]=msg.payload;
  ctx.pending.unshift(pending.id);
  delete ctx.residencyPending;
  ctx.step='next';
}
// RESIDENCY_PREVIEW_BRANCH
if (productId.toLowerCase()===RESIDENCY_PRODUCT_ID) {
  const config=residencyTransportConfig(key=>global.get(key));
  if (!config) {quote(id,'UNAVAILABLE',null,0,0,'RESIDENCY_BOOKING_NOT_CONFIGURED');continue;}
  const target=residencyPreviewTarget(exercise);
  const action=eventRoute?eventRoute.action:ctx.existingGame?'JOIN_GAME':'CREATE_GAME';
  const evidence=ctx.residencyContexts?.[id];
  if (!evidence) {
    ctx.residencyPending={id,target,action};ctx.step='residency_context';
    delete msg.error;delete msg.responseUrl;delete msg.statusCode;
    msg.method='POST';msg.url=config.url;msg.payload={clientSubscriptionId:id};
    msg.headers={Authorization:ctx.auth,'X-Subscriptions-Integration-Token':config.token,'Content-Type':'application/json',Accept:'application/json'};
    msg.requestTimeout=10000;msg.followRedirects=false;msg.maxRedirects=0;
    return out(0);
  }
  let proof;
  try {proof=validateResidencyBookingContext(evidence,id,Date.now(),target,action);}
  catch {quote(id,'UNAVAILABLE',null,0,0,'RESIDENCY_BOOKING_CONTEXT_INVALID');continue;}
  if (!Number.isSafeInteger(ctx.basePriceMinor) || ctx.basePriceMinor<=0) return stop('BASE_PRICE_UNRESOLVED');
  const percent=target.category==='GAME'?30:50;
  ctx.groupDiscountPercent=percent;
  quote(id,'AVAILABLE',ctx.basePriceMinor-Math.floor(ctx.basePriceMinor*percent/100),0,ctx.target.durationMinutes);
  ctx.quotes[ctx.quotes.length-1].expiresAt=Math.min(ctx.quotes[ctx.quotes.length-1].expiresAt,proof.validUntil);
  continue;
}
