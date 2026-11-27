// Only the internal split CREATE path can attest organizer provenance for a
// legacy daily booking. A client-supplied operation ID is not such evidence.
export function legacySplitCreateProof(ctx, msg) {
  const split = msg._splitCtx;
  const requestPath = String(msg.req?.originalUrl || msg.req?.url || '').split('?')[0];
  const uuid = value => typeof value === 'string' && /^[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i.test(value);
  const date = split?.date;
  const time = value => typeof value === 'string' && /^([01]\d|2[0-3]):[0-5]\d(?::00)?$/.test(value);
  if (ctx.caller !== 'split' || ctx.managedAction !== 'CREATE_GAME' || ctx.category !== 'open_game'
    || ctx.managedEnforcement?.enabled === true
    || msg.req?.method !== 'POST' || requestPath !== '/lk/games/split/create'
    || split?.action !== 'create' || split.ownsExercise !== true || split.bookingPaymentType !== 'SUBSCRIPTION'
    || split.selectedPaymentMode !== 'subscription' || split.spot !== 1
    || split.exerciseId !== ctx.exerciseId || split.operationId !== ctx.operationId
    || split.clientSubscriptionId !== ctx.clientSubscriptionId
    || ![ctx.actorClientId, ctx.exerciseId, ctx.clientSubscriptionId, split.verifiedStudioId, split.verifiedRoomId].every(uuid)
    || split.studioId !== split.verifiedStudioId || split.roomId !== split.verifiedRoomId
    || ![2, 4].includes(split.maxClientsCount) || ![1, 2].includes(ctx.subscriptionVisitCount)
    || typeof split.paymentRef !== 'string' || !/^[A-Za-z0-9._:-]{1,200}$/.test(split.paymentRef)
    || typeof date !== 'string' || !/^\d{4}-\d\d-\d\d$/.test(date) || ctx.serviceDate !== date
    || !time(split.fromTime) || !time(split.toTime)) return {};
  const fromTime = `${date}T${split.fromTime.slice(0, 5)}:00+03:00`;
  const toSameDay = `${date}T${split.toTime.slice(0, 5)}:00+03:00`;
  const start = Date.parse(fromTime);
  let end = Date.parse(toSameDay);
  if (end <= start) end += 86400000;
  if (!Number.isFinite(start) || !Number.isFinite(end) || end - start > 4 * 60 * 60000) return {};
  const toTime = new Date(end + 3 * 60 * 60000).toISOString().slice(0, 19) + '+03:00';
  return { legacySplitCreate: {
    schemaVersion: 1, operationId: ctx.operationId, actorClientId: ctx.actorClientId,
    exerciseId: ctx.exerciseId, clientSubscriptionId: ctx.clientSubscriptionId, paymentRef: split.paymentRef,
    studioId: split.verifiedStudioId, roomId: split.verifiedRoomId, fromTime, toTime,
    maxClientsCount: split.maxClientsCount, subscriptionVisitCount: ctx.subscriptionVisitCount,
  } };
}

export function addLegacySplitCreateProof(source) {
  const insert = '      _id: ctx.operationKey,\n      tenantKey: ctx.tenantKey,\n      clientSubscriptionId: ctx.clientSubscriptionId,\n      serviceDate: ctx.serviceDate,\n      operationId: ctx.operationId,';
  const reclaim = 'const prepareOperationReclaim = (ctx, operation, now = new Date()) => prepareMongoUpdate(ctx, "operation_reclaim", {';
  const reclaimSet = '  $set: {\n    operationId: ctx.operationId,\n    actorClientId: ctx.actorClientId,\n    exerciseId: ctx.exerciseId,\n    category: ctx.category,';
  if (source.includes('const legacySplitCreateProof =') || [insert, reclaim, reclaimSet].some(anchor => source.split(anchor).length !== 2)) {
    throw Error('Legacy split CREATE proof source drift');
  }
  return source.replace(reclaim, `const legacySplitCreateProof = ${legacySplitCreateProof.toString()};\n${reclaim}`)
    .replace(insert, insert + '\n      ...legacySplitCreateProof(ctx, msg),')
    .replace(reclaimSet, reclaimSet + '\n    ...(operation.legacySplitCreate != null ? { legacySplitCreate: null } : {}),\n    ...legacySplitCreateProof(ctx, msg),');
}
