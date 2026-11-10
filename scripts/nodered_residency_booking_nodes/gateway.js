const residencyIdentity = ctx => String(ctx.lk1ProductIdentity?.productId || '').toLowerCase() === RESIDENCY_PRODUCT_ID
  && identityBound(ctx);
const residencyTarget = (ctx,exercise) => ({resolutionSource:'SERVER',category:managedTargetCategory(resolveCategory(exercise)),
  stationId:toStr(exercise.studio?.id || exercise.studioId),externalEventTypeId:managedExternalEventTypeId(exercise),
  startsAt:finiteDate(eventStartsAt(exercise))?.toISOString(),durationMinutes:eventDurationMinutes(exercise)});
const residencyConfig = (ctx) => {
  try {
    const enabled = global.get('subscriptions_residency_booking_enabled');
    if (![true,'true','1','yes'].includes(enabled)) return null;
    const config=readManagedRuntimeApiConfig(), token=readGlobal('subscriptions_runtime_context_integration_token');
    return config.ok && Buffer.byteLength(token || '', 'utf8')>=32 ? {url:config.apiBase+'/internal/subscriptions/residency-booking-context',token} : null;
  } catch {return null;}
};
const residencyEnsure = (ctx,exercise,phase) => {
  if (!residencyIdentity(ctx)) return null;
  const config=residencyConfig(ctx);
  if (!config || !isObj(exercise)) return lk1Stop(ctx,'RESIDENCY_BOOKING_NOT_CONFIGURED');
  if (ctx.residencyContinuePhase===phase) {
    delete ctx.residencyContinuePhase;
    try {validateResidencyBookingContext(ctx.residencyContext,ctx.clientSubscriptionId,Date.now(),residencyTarget(ctx,exercise),managedActionForTarget({...ctx,category:resolveCategory(exercise)}));}
    catch {return lk1Stop(ctx,'RESIDENCY_BOOKING_CONTEXT_INVALID');}
    return null;
  }
  ctx.residencyExercise=exercise;
  ctx.residencyReturnPhase=phase;
  ctx.residencyRequestUrl=config.url;
  return prepareManagedHttp(ctx,'residency_context','POST',config.url,{clientSubscriptionId:ctx.clientSubscriptionId},
    {Authorization:ctx.authHeader,'X-Subscriptions-Integration-Token':config.token,'Content-Type':'application/json',Accept:'application/json'});
};
// RESIDENCY_STEPS
if (ctx.step==='residency_context') {
  const exercise=ctx.residencyExercise, phase=ctx.residencyReturnPhase;
  if (!residencyIdentity(ctx) || !['exercise','exercise_recheck'].includes(phase)
    || msg.error || msg.statusCode!==200 || msg.responseUrl!==ctx.residencyRequestUrl
    || msg.url!==ctx.residencyRequestUrl || msg.method!=='POST') return lk1Stop(ctx,'RESIDENCY_BOOKING_CONTEXT_UNAVAILABLE');
  try {validateResidencyBookingContext(msg.payload,ctx.clientSubscriptionId,Date.now(),residencyTarget(ctx,exercise),managedActionForTarget({...ctx,category:resolveCategory(exercise)}));}
  catch {return lk1Stop(ctx,'RESIDENCY_BOOKING_CONTEXT_INVALID');}
  ctx.residencyContext=msg.payload;
  ctx.residencyContinuePhase=phase;
  delete ctx.residencyExercise;
  delete ctx.residencyReturnPhase;
  delete ctx.residencyRequestUrl;
  ctx.step=phase;
  msg.payload=exercise;
  msg.statusCode=200;
}
