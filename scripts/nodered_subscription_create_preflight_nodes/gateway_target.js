// This is a prospective target, not an existing Viva exercise or eligibility proof.
// Only authenticated subscription ownership + existing read-only policy checks run here.
if (ctx.step === "prospective_subscriptions") {
  const body = msg.payload;
  const rows = Array.isArray(body) ? body : body?.content;
  const complete = Array.isArray(rows) && (Array.isArray(body) || (
    Number.isInteger(body.totalElements) && body.totalElements === rows.length
    && (!Object.hasOwn(body, "number") || body.number === 0)
    && (!Object.hasOwn(body, "totalPages") || [0, 1].includes(body.totalPages))
    && body.last !== false && body.hasNext !== true
  ));
  if (!isHttpOk(msg.statusCode) || !complete || rows.some((item) => !isObj(item))) {
    return finishError(ctx, 502, "Не удалось проверить полный список абонементов до создания игры", {
      code: "SUBSCRIPTION_CREATE_PREFLIGHT_LIST_UNAVAILABLE",
    });
  }
  const selected = rows.filter((item) => findOwnedSubscription(
    { availableClientSubscriptions: [item] }, ctx.clientSubscriptionId,
  ));
  const target = ctx.prospectiveTarget;
  const from = Date.parse(target?.timeFrom);
  const to = Date.parse(target?.timeTo);
  if (selected.length !== 1 || !isObj(target) || target.source !== "SPLIT_SERVER_CREATE_CONTEXT"
    || !toStr(target.roomId) || !toStr(target.studioId)
    || !Number.isInteger(target.directionId) || target.directionId < 1
    || !Number.isInteger(target.typeId) || target.typeId < 1
    || !Number.isFinite(from) || !Number.isFinite(to) || to <= from || to - from > 1440 * 60000) {
    return finishError(ctx, 409, "Не удалось подтвердить выбранный абонемент и параметры игры", {
      code: "SUBSCRIPTION_CREATE_PREFLIGHT_TARGET_UNRESOLVED",
    });
  }
  const subscription = selected[0];
  const listFields = ["availableStudios", "availableTypes", "availableDirections"];
  const malformedRestrictions = listFields.some((key) => (
    subscription[key] != null && !Array.isArray(subscription[key])
  ));
  if (malformedRestrictions || preflightAvailability.filterSplitEligibleSubscriptions(
    selected, new Set([String(target.typeId)]), new Set([String(target.directionId)]),
    target.studioId, ctx.subscriptionVisitCount, (to - from) / 60000, target.timeFrom.slice(0, 10),
  ).length !== 1) {
    return finishError(ctx, 409, "Абонемент не подходит для выбранной даты и формата игры", {
      code: "SUBSCRIPTION_NOT_OWNED_OR_UNAVAILABLE",
    });
  }
  // Adapt the explicit server target for the shared read-only rule evaluator.
  // The real Viva exercise and its available subscriptions are re-read after CREATE.
  msg.payload = { ...target, id: ctx.exerciseId, availableClientSubscriptions: selected };
  ctx.step = "exercise";
}
