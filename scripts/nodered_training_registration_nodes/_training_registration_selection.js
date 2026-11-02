// Reuse exact canonical selectors; the new restrictive caller requires explicit config.
const trSelection = (exercise, subscriptionId, actorId) => {
  try {
    const values = [
      'subscriptions_managed_enforcement_product_ids',
      'subscriptions_lk1_plan_rules',
      'subscriptions_lk1_station_exclusions',
    ].map((k) => global.get(k));
    if (values.some((v) => v === undefined || v === null || v === '')) return null;
    // JSON null/empty also remains unresolved, unlike existing ordinary LK1 defaults.
    const decoded = values.map((v) => (typeof v === 'string' ? JSON.parse(v) : v));
    if (decoded.some((v) => v === undefined || v === null || v === '')) return null;
    if (!normalizePlanRules(decoded[1]).ok || !normalizeStationExclusions(decoded[2]).ok)
      return null;
    const owned = ownerSelection.findOwnedSubscriptions(exercise, subscriptionId);
    if (owned.length !== 1) return null;
    const record = owned[0];
    const owners = [record.clientId, record.client?.id, record.clientSubscription?.clientId].filter(
      (v) => v !== undefined && v !== null,
    );
    if (owners.length && trAlias(owners) !== actorId) return null;
    const explicit = [
      record.clientSubscriptionId,
      record.subscriptionId,
      record.clientSubId,
      record.clientSubscription?.id,
      record.clientSubscription?.clientSubscriptionId,
      record.clientSub?.id,
    ].filter((v) => v !== undefined && v !== null);
    if (trAlias(explicit.length ? explicit : [record.id, record.uuid]) !== subscriptionId)
      return null;
    if (isProTrainingExercise(exercise) && !isProTrainingEnergyPack(record)) return null;
    if (isTopokratyExercise(exercise) && !isTopokratyClubPack(record)) return null;
    const identity = lk1ResolveProductIdentity(null, owned);
    if (!identity.productId || identity.extraProductIds.length) return null;
    const cup = ownerSelection.resolveManagedEnforcementDecision(owned, subscriptionId);
    if (
      !cup.ok ||
      cup.enabled !== false ||
      !cup.exactProductId ||
      cup.exactProductId !== identity.productId
    )
      return null;
    const lk1 = resolveLk1Rule({
      owned,
      planRules: decoded[1],
      stationExclusions: decoded[2],
      stationId: trAlias([exercise.studioId, exercise.studio?.id]),
      hubPolicy: global.get('subscriptions_lk1_product_policy'),
    });
    if (lk1.code || !(lk1.matched === false || (lk1.matched === true && lk1.legacy === true)))
      return null;
    return {
      management: 'LEGACY',
      authority: 'LK1_SUBSCRIPTION',
      cupSelection: 'EXPLICIT_UNMANAGED',
      lk1Selection: lk1.matched ? 'LEGACY' : 'UNMATCHED',
      chargeMode: 'SUBSCRIPTION_ONLY',
    };
  } catch {
    return null;
  }
};
const trExerciseTarget = (exercise, id, dateHint) => {
  if (!trNotCancelled(exercise)) return null;
  if (
    !trObject(exercise) ||
    trAlias([exercise.id, exercise.exerciseId]) !== id ||
    !Array.isArray(exercise.availableClientSubscriptions) ||
    ownerSelection.resolveCategory(exercise) !== 'group_training'
  )
    return null;
  const type = trAlias([exercise.typeId, exercise.type?.id], trPositive);
  const direction = trAlias([exercise.directionId, exercise.direction?.id], trPositive);
  if (
    !type ||
    !direction ||
    !(
      [605, 847, 963, 1208].includes(type) ||
      direction === 6233 ||
      (type === 2349 && direction === 6307)
    )
  )
    return null;
  const starts = ownerSelection.eventStartsAt(exercise),
    duration = ownerSelection.eventDurationMinutes(exercise);
  const startsAliases = [exercise.timeFrom, exercise.startsAt, exercise.startAt, exercise.fromTime]
    .filter((v) => v !== undefined && v !== null)
    .map((v) => {
      const parsed = Date.parse(v);
      return Number.isFinite(parsed) ? new Date(parsed).toISOString() : null;
    });
  if (trAlias(startsAliases, trIso) !== starts) return null;
  const ends = [exercise.timeTo, exercise.endsAt, exercise.endAt]
    .filter((v) => v !== undefined && v !== null)
    .map((v) => {
      const parsed = Date.parse(v);
      return Number.isFinite(parsed) ? new Date(parsed).toISOString() : null;
    });
  const end = trAlias(ends, trIso),
    capacity = trAlias(
      [exercise.maxClientsCount, exercise.maxClients, exercise.capacity],
      trPositive,
    );
  const studio = trAlias([exercise.studioId, exercise.studio?.id]),
    room = trAlias([exercise.roomId, exercise.room?.id]);
  if (
    !starts ||
    !end ||
    !duration ||
    !capacity ||
    !studio ||
    !room ||
    Date.parse(end) - Date.parse(starts) !== duration * 60000 ||
    [exercise.status, exercise.state].some(
      (v) => v !== undefined && !['ACTIVE', 'SCHEDULED', 'CONFIRMED', 'BOOKED'].includes(v),
    )
  )
    return null;
  const target = {
    id: trPublicId(id),
    dateHint,
    providerExerciseId: id,
    providerStudioId: studio,
    providerRoomId: room,
    providerTypeId: type,
    providerDirectionId: direction,
    category: 'GROUP_TRAINING',
    startsAt: starts,
    endsAt: end,
    durationMinutes: duration,
    capacity,
  };
  return trTarget({
    ...target,
    fingerprint: trHash('training-registration-target:v1\0' + JSON.stringify(target)),
  });
};
