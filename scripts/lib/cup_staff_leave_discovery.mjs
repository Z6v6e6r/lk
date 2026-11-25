// Rendered inside the installed split-leave router. Only staff requests that
// have a matching LK snapshot and no locally linked booking use this branch.
export function routeCupBookingDiscovery(ctx, msg, helpers) {
  if (!ctx.bookingDiscovery || ctx.mode !== 'STAFF_TARGET') return null;
  const {
    completeBookingPage, responseRows, rowBookingId, rowClientId, rowExerciseId, isCancelled,
    normalizeId, isOk, fail, resolveOptions,
    cancelProbeUrl, upstream, toOperationStart,
  } = helpers;
  const conflict = () => ctx.step === 'verify_history' && ctx.operationState === 'STARTED'
    ? fail(ctx, 422, 'VIVA_UNVERIFIED', 'Отмена записи не подтверждена историей Viva')
    : fail(ctx, 409, 'CONFLICT', 'Не удалось подтвердить единственную текущую запись участника в Viva');
  const clientId = normalizeId(ctx.targetClientId);
  const exerciseId = normalizeId(ctx.exerciseId);
  const bookingId = normalizeId(ctx.bookingDiscovery.bookingId);
  const clientMatches = row => [row.client?.id, row.clientId, row.playerId, row.userId]
    .some(value => normalizeId(value) === clientId);
  const cancellationFlags = row => [row.isCancelled, row.cancelled, row.canceled]
    .filter(value => value != null);
  const definitelyCancelled = row => {
    const flags = cancellationFlags(row);
    return flags.length > 0 && flags.every(value => value === true);
  };
  const cancellationEvidenceConsistent = row => {
    const flags = cancellationFlags(row);
    const cancelled = isCancelled(row);
    return flags.every(value => value === cancelled) && (!cancelled || definitelyCancelled(row));
  };
  const exactRow = row => cancellationEvidenceConsistent(row) && rowClientId(row) === clientId
    && [row.client?.id, row.clientId, row.playerId, row.userId]
      .every(value => value == null || normalizeId(value) === clientId)
    && (!rowExerciseId(row) || rowExerciseId(row) === exerciseId)
    && [row.exercise?.id, row.exercise?.uuid, row.exerciseId, row.vivaExerciseId, row.timetable?.exerciseId]
      .every(value => value == null || normalizeId(value) === exerciseId)
    && [row.id, row.bookingId, row.uuid].every(value => value == null || normalizeId(value) === rowBookingId(row));

  if (ctx.step === 'staff_discovery_options') {
    if (ctx.preOperationDiscovery !== true || !bookingId || !isOk(msg.statusCode)
      || normalizeId(msg.payload?.bookingId) !== bookingId) return conflict();
    if (ctx.requestedRefundMethod !== 'NONE' || !resolveOptions(msg.payload, 'NONE')) {
      return fail(ctx, 409, 'CONFLICT', 'Для записи без привязки в ЛК доступна только отмена без возврата, если её разрешает Viva.');
    }
    ctx.preOperationDiscovery = false;
    ctx.vivaTargetMode = 'BOOKINGS';
    ctx.step = 'start_cancel';
    // The exact booking and the accepted choice go into the existing durable operation before any PUT.
    return toOperationStart(ctx);
  }
  if (ctx.step === 'cancel_probe') {
    if (ctx.requestedRefundMethod !== 'NONE' || !ctx.bookingDiscoveryLockClaim
      || !(Date.parse(ctx.bookingDiscoveryLeaseUntil) > Date.now())) {
      return fail(ctx, 409, 'CONFLICT', 'Истёк срок проверки записи. Повторите отмену.');
    }
    if (!bookingId || normalizeId(ctx.currentBookingId) !== bookingId || normalizeId(ctx.currentClientId) !== clientId
      || (isOk(msg.statusCode) && normalizeId(msg.payload?.bookingId) !== bookingId)) return conflict();
  }
  if (ctx.step !== 'verify_active' && ctx.step !== 'verify_history') return null;
  if (!clientId || !exerciseId || !isOk(msg.statusCode) || !completeBookingPage(msg.payload, 200)) return conflict();
  const rows = responseRows(msg.payload);
  if (rows.some(row => !rowClientId(row) || !rowBookingId(row))) return conflict();

  if (ctx.step === 'verify_history') {
    const exact = rows.filter(row => rowBookingId(row) === bookingId);
    if (!bookingId || exact.length !== 1 || !exactRow(exact[0]) || !definitelyCancelled(exact[0])
      || rows.some(row => clientMatches(row) && !isCancelled(row))) return conflict();
    return null;
  }

  if (rows.some(row => (clientMatches(row) || rowBookingId(row) === bookingId)
    && !cancellationEvidenceConsistent(row))) return conflict();
  const active = rows.filter(row => !isCancelled(row));
  const playerRows = active.filter(clientMatches);
  if (ctx.preOperationDiscovery === true) {
    const [row] = playerRows;
    if (playerRows.length !== 1 || !exactRow(row)) return conflict();
    const currentId = rowBookingId(row);
    if (active.filter(candidate => rowBookingId(candidate) === currentId).length !== 1) return conflict();
    ctx.bookingDiscovery.bookingId = currentId;
    ctx.initialBookingIds = [currentId];
    ctx.bookingQueue = [{ bookingId: currentId, clientId: ctx.targetClientId }];
    ctx.clientSubscriptionId = null;
    ctx.subscriptionVisitCount = null;
    ctx.step = 'staff_discovery_options';
    return upstream(ctx, 'GET', cancelProbeUrl(ctx, currentId, ctx.targetClientId), undefined);
  }

  const activeBookingRows = active.filter(row => rowBookingId(row) === bookingId);
  if (!bookingId || ctx.initialBookingIds?.length !== 1 || ctx.initialBookingIds[0] !== bookingId
    || playerRows.length > 1 || activeBookingRows.length !== playerRows.length
    || (playerRows.length === 1 && (rowBookingId(playerRows[0]) !== bookingId || !exactRow(playerRows[0])))) {
    return conflict();
  }
  return null;
}
