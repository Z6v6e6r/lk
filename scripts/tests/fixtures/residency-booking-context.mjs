import {RESIDENCY_PRODUCT_ID,RESIDENCY_BOOKING_COMPATIBILITY} from '../../lib/residencyBookingContext.mjs';
export function residencyFixture({now=Date.now(),clientSubscriptionId='instance:fixture',startsAt=new Date(now+3600000).toISOString()}={}) {
  const from=new Date(now-86400000).toISOString(),to=new Date(now+29*86400000).toISOString();
  const rule=(category,percentage,actions,events)=>({ruleId:'rule:'+category,enabled:true,category,percentage,actions,
    stationIds:[],allStations:true,externalEventTypeIds:events,productTypeIds:[],durationMinutes:[60,90,120],kind:'PERCENT_DISCOUNT',valueMinor:null,partialPrice:null,priority:100});
  const policy={runtimeSchemaVersion:1,subscriptionTypeId:'type:residency',policyVersion:1,status:'PUBLISHED',effectiveAt:from,timeZone:'Europe/Moscow',
    createGame:{enabled:true,durationsMinutes:[60,90,120]},joinGame:{enabled:true,minDurationMinutes:60,maxDurationMinutes:120},
    activeServicesLimit:{enabled:false,max:null,scope:'SUBSCRIPTION_BENEFIT_ONLY'},bookingWindow:{enabled:false,days:null},dailyUsageLimit:0,usageUnitsByDuration:{'60':0,'90':0,'120':0},
    stationAccessRules:[{enabled:true,selector:{kind:'ALL_STATIONS',stationIds:[]},surcharge:{kind:'NONE',amountMinor:0}}],
    benefitRules:[rule('GAME',30,['CREATE_GAME','JOIN_GAME'],['viva:direction:4588:type:1613']),rule('GROUP_TRAINING',50,['BOOK_GROUP_TRAINING'],['viva:direction:6307:type:2349'])],
    lifecycle:{validityDays:30,activationMode:'PURCHASE',activationWindowDays:0,fixedActivationAt:null,allowBookingsAfterExpiry:false},
    usage:{weeklyUsageLimit:null,monthlyUsageLimit:null,maxFutureBookings:null,minHoursBetweenUses:0,blackoutDates:[]}};
  const context={schemaVersion:1,subscriptionInstanceId:'subscription:residency',clientSubscriptionId,policyDigest:'sha256:'+'a'.repeat(64),policy,
    instance:{subscriptionInstanceId:'subscription:residency',subscriptionTypeId:'type:residency',policyVersion:1,state:'ACTIVE',activeFrom:from,activeTo:to,frozenUntil:null,noShowBlockedUntil:null},
    evidence:{mappingId:'mapping:residency',mappingRevision:1,mappingVerifiedAt:from,publicationId:'publication:residency',publishedAt:from,instanceRevision:1,instanceAsOf:new Date(now).toISOString()}};
  return {schemaVersion:1,purchasedAt:from,contextKind:'RESIDENCY_BOOKING_CONTEXT',providerProductId:RESIDENCY_PRODUCT_ID,runtimeCompatibility:{...RESIDENCY_BOOKING_COMPATIBILITY},context,
    observedAt:new Date(now).toISOString(),validUntil:new Date(now+30000).toISOString(),startsAt};
}
