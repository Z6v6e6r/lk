// A server-owned marker is minted only after the durable no-provider-write
// refusal. Public error codes alone cannot turn unknown/paid results into409.
const lk1SplitVisitRefusal = ctx?.caller === 'split' && (ctx.action === undefined || ctx.action === 'book')
  && ctx.managedAction === 'JOIN_GAME' && msg._splitCtx?.action === 'join'
  && msg._splitCtx.operationId === ctx.operationId
  && msg._splitCtx.exerciseId === ctx.exerciseId
  && msg._splitCtx.clientId === ctx.actorClientId
  && msg._splitCtx.clientSubscriptionId === ctx.clientSubscriptionId;
if (ctx?.lk1 && ((ctx.caller === 'http' && ctx.action === 'book') || lk1SplitVisitRefusal)
  && ctx.step === 'lk1_daily_visit_conflict_saved' && responseStatus === 409
  && payload.details?.code === 'LK1_DAILY_VISIT_CHANGED'
  && payload.error === 'Дневное посещение уже занято. Обновите стоимость записи.'
  && ctx.lk1DailyVisitRefusal === JSON.stringify([ctx.operationKey, ctx.operationId,
    ctx.actorClientId, ctx.clientSubscriptionId, ctx.exerciseId, ctx.lk1.fingerprint])
  && !ctx.upstreamAttemptedAt && !ctx.confirmedBookingId && !ctx.immediateBookingId
  && !ctx.lk1.createAttemptedAt && !ctx.lk1.bookingAttemptedAt
  && !ctx.lk1.transactionAttemptedAt && !ctx.lk1.transactionId && !ctx.lk1.transactionIntent
  && !ctx.lk1.checkout && !ctx.lk1.visitJob && !ctx.precreatedEntitlementReserved
  && !ctx.managedEntitlementOperationId && !msg._splitCtx?.ownsExercise) return [null, msg];
