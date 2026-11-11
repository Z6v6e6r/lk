const residencyPreviewTarget = exercise => ({resolutionSource:'SERVER',category:eventRoute?eventCategory:'GAME',
  stationId:ctx.target.stationId,externalEventTypeId:canonical.managedExternalEventTypeId(exercise),
  startsAt:new Date(ctx.target.startsAt).toISOString(),durationMinutes:ctx.target.durationMinutes});
if (ctx.step==='residency_context') {
  const pending=ctx.residencyPending;
  // A failed optional benefit can only be attributed to an already owned instance.
  if (!pending || typeof pending.id!=='string' || !Array.isArray(ctx.requestedIds) || !ctx.requestedIds.includes(pending.id)
    || !ctx.subscriptions?.[pending.id] || typeof ctx.metadata?.[pending.id]?.productId!=='string'
    || ctx.metadata[pending.id].productId.toLowerCase()!==RESIDENCY_PRODUCT_ID
    || !Array.isArray(ctx.pending) || ctx.pending.includes(pending.id)) return stop('RESIDENCY_BOOKING_CONTEXT_UNAVAILABLE');
  let failure=null;
  try {
    const config=residencyTransportConfig(key=>residencySetting(key,k=>global.get(k),k=>typeof env!=='undefined'?env.get(k):undefined),'preview');
    if (!config || msg.error || msg.statusCode!==200 || msg.method!=='POST'
      || msg.url!==config.url || msg.responseUrl!==config.url) failure='RESIDENCY_BOOKING_CONTEXT_UNAVAILABLE';
    else {
      try {validateResidencyBookingContext(msg.payload,pending.id,Date.now(),pending.target,pending.action);}
      catch {failure='RESIDENCY_BOOKING_CONTEXT_INVALID';}
    }
  } catch {failure='RESIDENCY_BOOKING_CONTEXT_UNAVAILABLE';}
  if (failure) {
    delete ctx.residencyContexts?.[pending.id];
    quote(pending.id,'UNAVAILABLE',null,0,0,failure);
  } else {
    ctx.residencyContexts=ctx.residencyContexts || {};
    ctx.residencyContexts[pending.id]=msg.payload;
    ctx.pending.unshift(pending.id);
  }
  delete ctx.residencyPending;
  delete msg.error;delete msg.statusCode;delete msg.responseUrl;
  delete msg.url;delete msg.method;delete msg.headers;delete msg.payload;
  ctx.step='next';
}
// RESIDENCY_PREVIEW_BRANCH
if (productId.toLowerCase()===RESIDENCY_PRODUCT_ID) {
  // Residency covers games and group training only; tournaments have no such benefit.
  if (eventCategory==='TOURNAMENT') {quote(id,'UNAVAILABLE',null,0,0,'EVENT_NOT_INCLUDED');continue;}
  const config=residencyTransportConfig(key=>residencySetting(key,k=>global.get(k),k=>typeof env!=='undefined'?env.get(k):undefined),'preview');
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
