// Embedded verbatim in the booking gateway and advisory preview. No I/O here.
export const RESIDENCY_PRODUCT_ID = '4037a3a3-e551-4f9a-a9db-1410e46b8635';
export const RESIDENCY_BOOKING_COMPATIBILITY = Object.freeze({adapterId:'LK1_RESIDENCY_BOOKING',contractVersion:1,
  capabilityDigest:'sha256:1311a8250083728a2912793d8b6f32ca2d8145920b48c3fbf64280cd0e5da42e'});

export function residencyTransportConfig(read) {
  if (![true,'true','1','yes'].includes(read('subscriptions_residency_booking_enabled'))
    || read('subscriptions_runtime_environment') !== 'PROD'
    || read('subscriptions_runtime_api_base_url') !== 'https://padlhub.su/api') return null;
  const token=read('subscriptions_runtime_context_integration_token');
  return typeof token==='string' && token.length>=32
    ? {url:'https://padlhub.su/api/internal/subscriptions/residency-booking-context',token} : null;
}

// Durable operation identity survives a lost response, entitlement expiry and flag-off.
// This is not an admission check; new provider writes still require the fresh context.
export function residencyStoredBinding(quote, clientSubscriptionId) {
  const keys=['providerProductId','subscriptionInstanceId','clientSubscriptionId','policyVersion','policyDigest','mappingId','publicationId','activeFrom','activeTo'];
  const b=quote?.residencyBinding;
  if (!b || typeof b!=='object' || Array.isArray(b) || Object.keys(b).sort().join()!==[...keys].sort().join()
    || b.providerProductId!==RESIDENCY_PRODUCT_ID || b.clientSubscriptionId!==clientSubscriptionId
    || !Number.isSafeInteger(b.policyVersion) || b.policyVersion<1
    || !/^sha256:[a-f0-9]{64}$/.test(b.policyDigest)
    || ['subscriptionInstanceId','clientSubscriptionId','mappingId','publicationId'].some(k=>typeof b[k]!=='string' || !/^[A-Za-z0-9][A-Za-z0-9._:-]{2,199}$/.test(b[k]))) return null;
  const from=Date.parse(b.activeFrom),to=Date.parse(b.activeTo);
  if (!Number.isFinite(from) || !Number.isFinite(to) || new Date(from).toISOString()!==b.activeFrom
    || new Date(to).toISOString()!==b.activeTo || ![30*86400000,30*86400000-1].includes(to-from)) return null;
  return Object.fromEntries(keys.map(k=>[k,b[k]]));
}

export function validateResidencyBookingContext(value, clientSubscriptionId, now, target = null, action = null) {
  const fail = () => { throw new Error('RESIDENCY_BOOKING_CONTEXT_INVALID'); };
  const obj = v => v !== null && typeof v === 'object' && !Array.isArray(v);
  const id = v => typeof v === 'string' && /^[A-Za-z0-9][A-Za-z0-9._:-]{2,199}$/.test(v);
  const instant = v => typeof v === 'string' && new Date(Date.parse(v)).toISOString() === v ? Date.parse(v) : NaN;
  const same = (a,b) => Array.isArray(a) && a.length === b.length && [...a].sort().every((v,i)=>v === [...b].sort()[i]);
  try {
    const c=value.context, p=c.policy, i=c.instance, e=c.evidence, compatibility=value.runtimeCompatibility;
    const observed=instant(value.observedAt), until=instant(value.validUntil), purchase=instant(value.purchasedAt);
    const expiry=purchase+30*86400000;
    if (!obj(value) || value.schemaVersion !== 1 || value.contextKind !== 'RESIDENCY_BOOKING_CONTEXT'
      || value.providerProductId !== RESIDENCY_PRODUCT_ID || c.schemaVersion !== 1
      || Object.keys(RESIDENCY_BOOKING_COMPATIBILITY).some(k=>compatibility[k]!==RESIDENCY_BOOKING_COMPATIBILITY[k])
      || !Number.isFinite(now) || observed>now || until<=now || until-observed>30000 || until<=observed
      || !Number.isFinite(observed) || !Number.isFinite(until)
      || c.clientSubscriptionId !== clientSubscriptionId || !id(c.subscriptionInstanceId)
      || i.subscriptionInstanceId !== c.subscriptionInstanceId || i.subscriptionTypeId !== p.subscriptionTypeId
      || !id(p.subscriptionTypeId) || i.policyVersion !== p.policyVersion || !Number.isSafeInteger(p.policyVersion) || p.policyVersion<1
      || !/^sha256:[a-f0-9]{64}$/.test(c.policyDigest) || p.runtimeSchemaVersion!==1 || p.status!=='PUBLISHED'
      || !Number.isFinite(instant(p.effectiveAt)) || instant(p.effectiveAt)>now
      || i.state!=='ACTIVE' || i.frozenUntil || i.noShowBlockedUntil
      || !Number.isFinite(instant(i.activeFrom)) || !Number.isFinite(instant(i.activeTo))
      || instant(i.activeFrom)>now || instant(i.activeTo)<=now || instant(i.activeTo)<=instant(i.activeFrom)
      || !Number.isFinite(purchase) || instant(i.activeFrom)!==purchase || ![expiry,expiry-1].includes(instant(i.activeTo)) || until>instant(i.activeTo)
      || !id(e.mappingId) || !id(e.publicationId) || !Number.isSafeInteger(e.mappingRevision) || e.mappingRevision<1
      || !Number.isSafeInteger(e.instanceRevision) || e.instanceRevision<1
      || ['mappingVerifiedAt','publishedAt','instanceAsOf'].some(k=>!Number.isFinite(instant(e[k])) || instant(e[k])>now)
      || p.lifecycle.validityDays!==30 || p.lifecycle.activationMode!=='PURCHASE'
      || p.lifecycle.activationWindowDays!==0 || p.lifecycle.fixedActivationAt!==null || p.lifecycle.allowBookingsAfterExpiry!==false
      || p.activeServicesLimit.enabled!==false || p.activeServicesLimit.max!==null
      || p.bookingWindow.enabled!==false || p.bookingWindow.days!==null || p.dailyUsageLimit!==0
      || ['60','90','120'].some(k=>p.usageUnitsByDuration[k]!==0)
      || p.usage.weeklyUsageLimit!==null || p.usage.monthlyUsageLimit!==null || p.usage.maxFutureBookings!==null
      || p.usage.minHoursBetweenUses!==0 || p.usage.blackoutDates.length!==0
      || !p.createGame.enabled || !same(p.createGame.durationsMinutes,[60,90,120])
      || !p.joinGame.enabled || p.joinGame.minDurationMinutes!==60 || p.joinGame.maxDurationMinutes!==120) fail();
    const access=p.stationAccessRules;
    if (access.length!==1 || access[0].enabled!==true || access[0].selector.kind!=='ALL_STATIONS'
      || access[0].selector.stationIds.length || access[0].surcharge.kind!=='NONE' || access[0].surcharge.amountMinor!==0) fail();
    const rules=p.benefitRules.filter(r=>r.enabled);
    const game=rules.find(r=>r.category==='GAME'), training=rules.find(r=>r.category==='GROUP_TRAINING');
    if (rules.length!==2 || !game || !training || !same(game.actions,['CREATE_GAME','JOIN_GAME'])
      || !same(training.actions,['BOOK_GROUP_TRAINING']) || game.percentage!==30 || training.percentage!==50
      || game.allStations!==true || training.allStations!==true || game.stationIds.length || training.stationIds.length
      || rules.some(r=>r.kind!=='PERCENT_DISCOUNT' || r.valueMinor!==null || r.partialPrice!==null
        || r.productTypeIds.length || !same(r.durationMinutes,[60,90,120]) || !r.externalEventTypeIds.length)) fail();
    if (target) {
      const category={CREATE_GAME:'GAME',JOIN_GAME:'GAME',BOOK_GROUP_TRAINING:'GROUP_TRAINING'}[action];
      const starts=instant(target.startsAt), ends=starts+target.durationMinutes*60000;
      const rule=rules.find(r=>r.category===category && r.actions.includes(action));
      if (target.resolutionSource!=='SERVER' || target.category!==category || !rule
        || !id(target.stationId) || !rule.externalEventTypeIds.includes(target.externalEventTypeId)
        || !rule.durationMinutes.includes(target.durationMinutes) || !Number.isFinite(starts) || starts<=now
        || starts<instant(i.activeFrom) || ends>instant(i.activeTo)) fail();
    }
    return {rule:{productId:RESIDENCY_PRODUCT_ID,maxActiveBookings:Number.MAX_SAFE_INTEGER,freeGameMinutesPerDay:0,
      gameOverageDiscountPercent:30,groupTrainingDiscountPercent:50,tournamentDiscountPercent:0},
      binding:{providerProductId:RESIDENCY_PRODUCT_ID,subscriptionInstanceId:c.subscriptionInstanceId,
        clientSubscriptionId,policyVersion:p.policyVersion,policyDigest:c.policyDigest,mappingId:e.mappingId,
        publicationId:e.publicationId,activeFrom:i.activeFrom,activeTo:i.activeTo},validUntil:until};
  } catch { fail(); }
}
