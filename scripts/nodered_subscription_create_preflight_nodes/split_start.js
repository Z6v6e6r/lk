// Read-only preflight is advisory. Never skip the real-exercise booking gateway.
if (resolveBookingPaymentType(ctx) === "SUBSCRIPTION" && ctx.subscriptionCreatePreflightDone !== true) {
  if (!toStr(ctx.clientSubscriptionId)) {
    return fail(400, "Выберите абонемент для создания игры", { code: "SUBSCRIPTION_SELECTION_REQUIRED" });
  }
  const outputs = startSubscriptionBookingGateway(ctx);
  if (!outputs[3]) return outputs;
  const gateway = outputs[3]._subscriptionBooking;
  gateway.caller = "split_create_readonly_preflight";
  gateway.exerciseId = `preflight:${gateway.operationId}`;
  gateway.prospectiveTarget = {
    source: "SPLIT_SERVER_CREATE_CONTEXT",
    roomId: ctx.roomId,
    studioId: ctx.studioId,
    directionId: toNumber(ctx.vivaDirectionId) ?? SPLIT_DIRECTION_ID,
    typeId: toNumber(ctx.vivaExerciseTypeId) ?? SPLIT_EXERCISE_TYPE_ID,
    timeFrom: `${ctx.date}T${ctx.fromTime}+03:00`,
    timeTo: `${ctx.date}T${ctx.toTime}+03:00`,
  };
  return outputs;
}
