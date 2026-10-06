// Only the verified owner HTTP entry builds padlHubAdmission. Legacy/public ingress
// rebuilds its own allowlist and cannot select this mode.
const admissionBinding = ctx => ctx.padlHubAdmission;
const admissionMatches = (ctx, row) => row?.admissionOnly === true
  && row._id === ctx.operationKey && row.operationId === ctx.operationId
  && row.actorClientId === ctx.padlHubAdmission.providerClientId
  && row.tenantKey === ctx.tenantKey
  && JSON.stringify(row.padlHubAdmission) === JSON.stringify(admissionBinding(ctx));
const admissionSubscriptionId = row => {
  if(!isObj(row)) return null;
  const ids=[row.clientSubscriptionId,row.subscriptionId,row.clientSubId,row.clientSubscription?.id,
    row.clientSubscription?.clientSubscriptionId,row.clientSub?.id,row.id,row.uuid].filter(v=>v!==undefined);
  return ids.length && ids.every(v=>typeof v==='string'&&/^[A-Za-z0-9][A-Za-z0-9._:-]{2,199}$/.test(v))
    && new Set(ids).size===1 ? ids[0] : null;
};
const admissionOwned = (row, actor) => {
  const owners=[row.clientId,row.client?.id,row.clientSubscription?.clientId,row.clientSubscription?.client?.id,
    row.clientSub?.clientId,row.clientSub?.client?.id].filter(v=>v!==undefined);
  return owners.length>0 && owners.every(v=>typeof v==='string'&&v===actor);
};
const admissionIso = v => typeof v==='string' && Number.isFinite(Date.parse(v)) && new Date(v).toISOString()===v;
const admissionFinish = (ctx, row) => {
  const b=ctx.padlHubAdmission, association=row?.padlHubOperation, target=row?.padlHubAdmissionTarget, quote=row?.lk1;
  const expected={contractVersion:1,operationId:b.operationId,tenantId:b.tenantId,userId:b.userId,
    providerMappingId:b.providerMappingId,issuer:b.issuer,caller:b.caller};
  const audit=row?.padlHubAdmissionAudit;
  if (!admissionMatches(ctx, row) || JSON.stringify(association)!==JSON.stringify(expected) || row.state !== 'PREPARED'
    || row.category!=='open_game' || !/^[A-Za-z0-9][A-Za-z0-9._:-]{2,199}$/.test(row.clientSubscriptionId||'')
    || !admissionIso(row.createdAt) || !admissionIso(row.updatedAt) || row.updatedAt<row.createdAt
    || !admissionIso(audit?.admittedAt) || audit.admittedAt>row.createdAt
    || !/^[A-Za-z0-9][A-Za-z0-9._:-]{7,127}$/.test(audit?.correlationId||'') || !/^[a-f0-9]{64}$/.test(audit?.sourceSha256||'')
    || !isObj(target) || target.admissible!==true || target.capacity!==4 || !admissionIso(target.startsAt)
    || !Number.isSafeInteger(target.durationMinutes) || target.durationMinutes<1 || target.durationMinutes>1440
    || !isObj(quote?.target) || !isObj(quote.rule) || row.exerciseId!==ctx.exerciseId || quote.target.eventId !== ctx.exerciseId
    || quote.target.category!=='GAME' || quote.target.startsAt!==target.startsAt || quote.target.durationMinutes!==target.durationMinutes
    || quote.decision?.eligible !== true || ![0,1].includes(quote.decision.subscriptionVisitCount)
    || !Number.isSafeInteger(quote.decision?.benefit?.finalPriceMinor) || quote.decision.benefit.finalPriceMinor<0 || quote.decision.benefit.finalPriceMinor>1000000
    || quote.fingerprint!==lk1Fingerprint({...ctx,actorClientId:row.actorClientId,clientSubscriptionId:row.clientSubscriptionId},quote)
    || row.attempts !== 0 || row.bookingId || row.upstreamBookingId || row.transactionId
    || ['createAttemptedAt','bookingAttemptedAt','transactionAttemptedAt','transactionId','transactionIntent','checkout','visitJob'].some(k=>quote[k]!==undefined)) {
    return finishError(ctx, 409, 'Admission binding conflict', {code:'BOOKED_OPERATION_ADMISSION_CONFLICT'});
  }
  msg.statusCode = 202;
  msg.payload = { contractVersion:1, operationId:row.operationId, status:'PENDING', asOf:row.updatedAt, reason:'OWNER_PENDING' };
  delete msg.error;
  return emit(OUTPUT_FINAL);
};
// ADMISSION_STEPS
if (ctx.padlHubAdmission && ctx.step === 'admission_start') return lk1Find(ctx,'admission_lookup',{_id:ctx.operationKey});
if (ctx.padlHubAdmission && ctx.step === 'admission_lookup') {
  if (msg.error || !Array.isArray(msg.payload) || msg.payload.length > 1) {
    return finishError(ctx, 503, 'Admission owner read unavailable', {code:'BOOKED_OPERATION_ADMISSION_UNAVAILABLE'});
  }
  if (msg.payload.length) return admissionFinish(ctx,msg.payload[0]);
  if (ctx.admissionInsertAttempted) return finishError(ctx,503,'Admission outcome unavailable',{code:'BOOKED_OPERATION_ADMISSION_UNAVAILABLE'});
  if(ctx.padlHubAdmissionTarget.admissible!==true||ctx.padlHubAdmissionTarget.capacity!==4) return finishError(ctx,409,'Admission target conflict',{code:'BOOKED_OPERATION_ADMISSION_CONFLICT'});
  return prepareUserGet(ctx,'profile',`/end-user/api/v1/${ctx.tenantKey}/profile`);
}
if (ctx.padlHubAdmission && ctx.step === 'admission_exercise') {
  const exercise = isHttpOk(msg.statusCode) && unwrapRecord(msg.payload);
  const b = ctx.padlHubAdmissionTarget;
  if (!isObj(exercise) || toStr(exercise.id) !== ctx.exerciseId || resolveCategory(exercise) !== 'open_game'
    || finiteDate(eventStartsAt(exercise))?.toISOString() !== b.startsAt
    || eventDurationMinutes(exercise) !== b.durationMinutes
    || exercise.maxClientsCount !== b.capacity || b.capacity !== 4
    || !Array.isArray(exercise.availableClientSubscriptions)) {
    return finishError(ctx,409,'Admission target unavailable',{code:'BOOKED_OPERATION_ADMISSION_CONFLICT'});
  }
  const candidates=[];
  for (const row of exercise.availableClientSubscriptions) {
    if (!isObj(row)) return finishError(ctx,409,'Subscription identity unavailable',{code:'BOOKED_OPERATION_ADMISSION_CONFLICT'});
    const id=admissionSubscriptionId(row);
    if(!id||!admissionOwned(row,ctx.padlHubAdmission.providerClientId)) return finishError(ctx,409,'Subscription identity unavailable',{code:'BOOKED_OPERATION_ADMISSION_CONFLICT'});
    const rule=lk1Config([row],exercise.studio?.id||exercise.studioId);
    if (rule.matched && !rule.legacy && !rule.code) candidates.push({row,id});
  }
  if (candidates.length!==1) return finishError(ctx,409,'Exactly one eligible subscription required',{code:'BOOKED_OPERATION_ADMISSION_CONFLICT'});
  ctx.clientSubscriptionId=candidates[0].id;
  ctx.admissionExercise=exercise;
  return prepareUserGet(ctx,'admission_subscriptions',`/end-user/api/v1/${ctx.tenantKey}/subscriptions?includeFinished=true&size=1000`);
}
if (ctx.padlHubAdmission && ctx.step === 'admission_subscriptions') {
  if (!isHttpOk(msg.statusCode) || !hasCompleteBookingList(msg.payload)) return finishError(ctx,503,'Owned subscription read unavailable',{code:'BOOKED_OPERATION_ADMISSION_UNAVAILABLE'});
  const rows=extractItems(msg.payload);
  if(rows.some(row=>!admissionSubscriptionId(row))) return finishError(ctx,409,'Subscription identity unavailable',{code:'BOOKED_OPERATION_ADMISSION_CONFLICT'});
  const selected=rows.filter(row=>admissionSubscriptionId(row)===ctx.clientSubscriptionId);
  if (selected.length!==1 || !admissionOwned(selected[0],ctx.actorClientId) || selected[0].status!=='ACTIVE') return finishError(ctx,409,'Owned subscription changed',{code:'BOOKED_OPERATION_ADMISSION_CONFLICT'});
  ctx.admissionExercise.availableClientSubscriptions=selected;
  ctx.lk1MoneyExercise=ctx.admissionExercise;
  ctx.lk1MoneyReturnStep='admission_tariff';
  ctx.step='lk1_money_owned_subscriptions';
  // Execute the existing lifecycle/rule/owner proof with this fresh provider page.
  return emit(OUTPUT_DEBUG);
}
if (ctx.padlHubAdmission && ctx.step === 'admission_tariff') {
  const exercise=ctx.admissionExercise;
  const service=lk1CourtWindowService(exercise.studio?.id||exercise.studioId,exerciseRoomId(exercise));
  const url=lk1CourtWindowUrl(service,exercise.studio?.id||exercise.studioId,exerciseRoomId(exercise),exercise);
  if (!url) return finishError(ctx,409,'Exact tariff unavailable',{code:'BOOKED_OPERATION_ADMISSION_CONFLICT'});
  return prepareHttp(ctx,'admission_tariff_result','GET',url,undefined,{Authorization:ctx.authHeader,Accept:'application/json'});
}
if (ctx.padlHubAdmission && ctx.step === 'admission_tariff_result') {
  const total=isHttpOk(msg.statusCode)?lk1CourtWindowTotal(msg.payload):null;
  if (!Number.isSafeInteger(total)||total<=0) return finishError(ctx,409,'Exact tariff unavailable',{code:'BOOKED_OPERATION_ADMISSION_CONFLICT'});
  const e=ctx.admissionExercise;
  // Same existing split share calculation, after the owner proved the whole court window.
  ctx.lk1TariffProof={source:'VIVA_EXISTING_TARIFF',amountMinor:admissionSplitShareMinor(total,ctx.padlHubAdmissionTarget.capacity),windowTotalMinor:total,
    stationId:toStr(e.studio?.id||e.studioId),roomId:exerciseRoomId(e),durationMinutes:eventDurationMinutes(e),startsAt:finiteDate(eventStartsAt(e)).toISOString(),observedAt:Date.now()};
  ctx.step='exercise';msg.payload=e;msg.statusCode=200;
  return emit(OUTPUT_DEBUG);
}
