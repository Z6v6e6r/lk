const retainLk1TariffProof = (ctx, amountMinor) => {
  const startsAt = Date.parse(`${ctx.date}T${ctx.fromTime}+03:00`);
  const durationMinutes = Math.floor(toNumber(ctx.durationMinutes) ?? 0);
  if (!Number.isSafeInteger(amountMinor) || amountMinor < 0 || !Number.isFinite(startsAt)
    || durationMinutes <= 0 || !toStr(ctx.studioId) || !toStr(ctx.roomId)) {
    delete ctx.lk1TariffProof;
    return;
  }
  ctx.lk1TariffProof = { source: "VIVA_EXISTING_TARIFF", amountMinor,
    stationId: toStr(ctx.studioId), roomId: toStr(ctx.roomId), durationMinutes,
    startsAt: new Date(startsAt).toISOString(), observedAt: Date.now() };
};

const lk1CreatePayload = (ctx) => ({
  directionId: toNumber(ctx.vivaDirectionId) ?? SPLIT_DIRECTION_ID,
  typeId: toNumber(ctx.vivaExerciseTypeId) ?? SPLIT_EXERCISE_TYPE_ID,
  timeFrom: `${ctx.date}T${ctx.fromTime}+03:00`,
  timeTo: `${ctx.date}T${ctx.toTime}+03:00`,
  maxClientsCount: ctx.maxClientsCount, roomId: ctx.roomId, trainers: [], requirements: [],
});
const startLk1CreateAttempt = (ctx) => {
  const approved = ctx.lk1ReadOnlyApproval;
  if (!approved || approved.operationId !== ctx.operationId
    || approved.clientSubscriptionId !== ctx.clientSubscriptionId
    || JSON.stringify(approved.createPayload) !== JSON.stringify(lk1CreatePayload(ctx))) {
    return fail(409, "Предварительная цель HUB изменилась", { code: "LK1_CREATE_TARGET_CHANGED" });
  }
  const outputs = startSubscriptionBookingGateway(ctx);
  if (!outputs[3]) return outputs;
  const gateway = outputs[3]._subscriptionBooking;
  gateway.action = "book";
  gateway.lk1BeforeCreate = true;
  gateway.lk1ApprovedActor = approved.actorClientId;
  gateway.exerciseId = `preflight:${gateway.operationId}`;
  gateway.lk1CreatePayload = lk1CreatePayload(ctx);
  gateway.prospectiveTarget = { source: "SPLIT_SERVER_CREATE_CONTEXT",
    ...gateway.lk1CreatePayload, studioId: ctx.studioId };
  return outputs;
};
const lk1CreateDispatchBound = (ctx) => {
  const gateway = msg._subscriptionBooking;
  const ack = gateway?.lk1CreateAck;
  const approved = ctx.lk1ReadOnlyApproval;
  const binding = ctx.lk1CreateBinding;
  return gateway?.caller === "split" && gateway.lk1BeforeCreate === true
    && gateway.step === "lk1_create_attempt_saved" && msg.statusCode === 200
    && msg.payload?.state === "LK1_CREATE_ATTEMPT_BOUND"
    && ack && binding && approved && ctx.lk1CreateDispatchUsed !== true
    && ack.actorClientId === approved.actorClientId
    && ack.operationId === ctx.operationId && msg.payload.operationId === ctx.operationId
    && gateway.clientSubscriptionId === ctx.clientSubscriptionId
    && ack.operationKey === `lk1-product:${JSON.stringify([gateway.tenantKey, ack.actorClientId, ctx.operationId])}`
    && ack.operationKey === binding.operationKey && ack.fingerprint === binding.fingerprint
    && ack.fingerprint === gateway.lk1?.fingerprint
    && ack.createAttemptedAt === gateway.lk1?.createAttemptedAt
    && Number.isFinite(Date.parse(ack.createAttemptedAt))
    && JSON.stringify(ack.createPayload) === JSON.stringify(lk1CreatePayload(ctx))
    && JSON.stringify(approved.createPayload) === JSON.stringify(ack.createPayload);
};
