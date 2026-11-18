// Embedded in a dedicated Node-RED GET reader. Effects are GET/find/reply only.
export function createSplitCreateResultProtocol() {
  const tenant = 'iSkq6G';
  const uuid = value => typeof value === 'string' && /^[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i.test(value);
  const record = value => !!value && typeof value === 'object' && !Array.isArray(value);
  const text = value => typeof value === 'string' && value.trim() === value && value.length > 0 && value.length <= 200 && !/[\r\n]/.test(value);
  const instant = value => typeof value === 'string' && Number.isFinite(Date.parse(value)) ? Date.parse(value) : NaN;
  const moscow = value => Number.isFinite(instant(value))
    ? new Date(instant(value) + 3 * 60 * 60_000).toISOString().slice(0, 19) + '+03:00' : null;
  const cancelled = row => [row?.isCancelled, row?.cancelled, row?.canceled, row?.archived].some(v => v === true)
    || /CANCEL|FAIL|REFUND|REJECT|VOID|EXPIRE|ARCHIVE/i.test(String(row?.status || ''));
  const matches = (values, expected) => values.filter(v => v != null).length > 0
    && values.filter(v => v != null).every(v => v === expected);
  const reply = (s, state, code, status = 202) => ({ state: null, effect: { kind: 'reply', status,
    body: { schemaVersion: 1, recovery: 'SPLIT_CREATE_RESULT_V1', operationId: s?.binding?.operationId || null,
      state, code } } });
  const pending = (s, code) => reply(s, 'PENDING_CONFIRMATION', code);
  const http = (s, stage, path, auth = 'service') => ({ state: { ...s, stage }, effect: { kind: 'http', method: 'GET', path, auth } });
  const find = (s, stage) => ({ state: { ...s, stage }, effect: { kind: 'find',
    query: { _id: `lk1-product:${JSON.stringify([tenant, s.actor, s.binding.operationId])}`,
      tenantKey: tenant, actorClientId: s.actor, operationId: s.binding.operationId },
    options: { limit: 2, readConcern: { level: 'majority' }, maxTimeMS: 2000 } } });
  const operationIdValid = value => typeof value === 'string' && /^lk-split-create-[a-z0-9]{1,100}$/.test(value);
  const bindingValid = b => record(b) && operationIdValid(b.operationId)
    && uuid(b.clientSubscriptionId) && uuid(b.studioId) && uuid(b.roomId)
    && /^\d{4}-\d\d-\d\dT\d\d:\d\d:00\+03:00$/.test(b.fromTime)
    && /^\d{4}-\d\d-\d\dT\d\d:\d\d:00\+03:00$/.test(b.toTime)
    && instant(b.toTime) > instant(b.fromTime) && instant(b.toTime) - instant(b.fromTime) <= 4 * 60 * 60_000;
  function validOperation(s, op) {
    const b = s.binding, q = op?.lk1, t = q?.target, p = q?.createPayload, d = q?.decision;
    if (!record(op) || op._id !== `lk1-product:${JSON.stringify([tenant, s.actor, b.operationId])}`
      || op.tenantKey !== tenant || op.actorClientId !== s.actor || op.operationId !== b.operationId
      || op.clientSubscriptionId !== b.clientSubscriptionId || op.category !== 'open_game'
      || op.state !== 'CONFIRMED' || !uuid(op.exerciseId) || !uuid(op.bookingId)
      || (op.upstreamBookingId && op.upstreamBookingId !== op.bookingId)
      || !text(op.updatedAt) || !Number.isFinite(instant(op.confirmedAt))
      || !record(q) || !record(q.rule) || !record(t) || !record(p)
      || t.category !== 'GAME' || t.eventId !== op.exerciseId || t.stationId !== b.studioId || t.roomId !== b.roomId
      || instant(t.startsAt) !== instant(b.fromTime) || !Number.isFinite(instant(t.startsAt))
      || t.durationMinutes !== (instant(b.toTime) - instant(b.fromTime)) / 60_000
      || !Number.isSafeInteger(t.basePriceMinor) || t.basePriceMinor < 0 || t.basePriceMinor > 1_000_000
      || instant(p.timeFrom) !== instant(b.fromTime) || instant(p.timeTo) !== instant(b.toTime)
      || p.roomId !== b.roomId || ![2, 4].includes(p.maxClientsCount)
      || !record(d) || d.eligible !== true || ![0, 1].includes(d.subscriptionVisitCount)
      || !Number.isSafeInteger(d.benefit?.finalPriceMinor) || d.benefit.finalPriceMinor < 0
      || d.benefit.finalPriceMinor > 1_000_000 || q.unpaidCancellation || q.freeCancellationReturn
      || q.cancelledAllowanceRelease || op.releasedAt || op.releaseSource) return false;
    const receipt = op.createReceipt;
    if (receipt && (!record(receipt) || receipt.schemaVersion !== 1 || !text(receipt.paymentRef)
      || !Number.isFinite(instant(receipt.deadlineAt))
      || instant(receipt.assembleDeadlineAt) !== instant(b.fromTime) - 24 * 60 * 60_000)) return false;
    const fingerprint = JSON.stringify({ tenantKey: tenant, actorClientId: s.actor,
      clientSubscriptionId: b.clientSubscriptionId, action: 'CREATE_GAME', rule: q.rule,
      purchaseDate: q.purchaseDate, createPayload: p, target: { ...t, eventId: `preflight:${b.operationId}` } });
    if (q.fingerprint !== fingerprint) return false;
    const amount = d.benefit.finalPriceMinor, checkout = q.checkout, intent = q.transactionIntent;
    if (amount === 0) return !checkout && !q.transactionId && !q.transactionAttemptedAt && !q.visitJob;
    if (!receipt) return false; // Legacy paid rows do not preserve the original payment window.
    const safeUrl = typeof checkout?.paymentUrl === 'string' && checkout.paymentUrl.length <= 2048
      && /^https:\/\/[a-z0-9](?:[a-z0-9.-]*[a-z0-9])?(?::443)?(?:[/?#][^\s]*)?$/i.test(checkout.paymentUrl);
    return record(checkout) && record(intent) && safeUrl
      && checkout.toPayMinor === amount && uuid(checkout.transactionId)
      && checkout.transactionId === q.transactionId && Number.isFinite(instant(q.transactionAttemptedAt))
      && intent.bookingId === op.bookingId && intent.actorClientId === s.actor
      && intent.studioId === t.stationId && intent.chargeMinor === amount;
  }
  const bookingPage = s => http(s, 'bookings', `/api/v1/exercises/${encodeURIComponent(s.op.exerciseId)}/bookings?showCancelled=true&page=${s.page}&size=200`);
  function begin(input, now) {
    const s = { binding: { operationId: input?.operationId }, deadline: now + 8000, stage: 'profile' };
    if (!Number.isSafeInteger(now) || !record(input) || Object.keys(input).join(',') !== 'operationId'
      || !operationIdValid(input.operationId)) return reply(s, 'INVALID', 'SPLIT_CREATE_RESULT_REQUEST_INVALID', 400);
    return http(s, 'profile', `/end-user/api/v1/${tenant}/profile`, 'actor');
  }
  function step(s, event, now) {
    if (!record(s) || !operationIdValid(s.binding?.operationId) || !Number.isSafeInteger(now) || now >= s.deadline) return pending(s, 'SPLIT_CREATE_RESULT_READ_TIMEOUT');
    if (event.error) return pending(s, 'SPLIT_CREATE_RESULT_READ_UNAVAILABLE');
    if (s.stage === 'profile') {
      if (event.status === 401 || event.status === 403) return reply(s, 'UNAUTHORIZED', 'SPLIT_CREATE_RESULT_AUTH_REQUIRED', event.status);
      if (event.status !== 200 || !uuid(event.body?.id)) return pending(s, 'SPLIT_CREATE_RESULT_PROFILE_UNAVAILABLE');
      return find({ ...s, actor: event.body.id }, 'operation');
    }
    if (s.stage === 'operation' || s.stage === 'operation_recheck') {
      if (!Array.isArray(event.body) || event.body.length !== 1) return pending(s, 'SPLIT_CREATE_RESULT_NOT_CONFIRMED');
      const op = event.body[0];
      if (s.stage === 'operation') s = { ...s, binding: { operationId: s.binding.operationId,
        clientSubscriptionId: op?.clientSubscriptionId, studioId: op?.lk1?.target?.stationId,
        roomId: op?.lk1?.target?.roomId, fromTime: moscow(op?.lk1?.createPayload?.timeFrom),
        toTime: moscow(op?.lk1?.createPayload?.timeTo) } };
      if (!bindingValid(s.binding) || !validOperation(s, op)) return pending(s, 'SPLIT_CREATE_RESULT_NOT_CONFIRMED');
      if (s.stage === 'operation') return http({ ...s, op }, 'exercise', `/api/v1/exercises/${encodeURIComponent(op.exerciseId)}`);
      if (op.updatedAt !== s.op.updatedAt || op.bookingId !== s.op.bookingId || op.exerciseId !== s.op.exerciseId
        || JSON.stringify(op.lk1) !== JSON.stringify(s.op.lk1)
        || JSON.stringify(op.createReceipt) !== JSON.stringify(s.op.createReceipt)) return pending(s, 'SPLIT_CREATE_RESULT_CHANGED');
      const amount = op.lk1.decision.benefit.finalPriceMinor;
      const checkout = op.lk1.checkout;
      // Whitelist only. No actor data, quote, credentials, raw provider row or headers.
      return { state: null, effect: { kind: 'reply', status: 200, body: {
        schemaVersion: 1, recovery: 'SPLIT_CREATE_RESULT_V1', state: 'CONFIRMED', mode: 'create',
        operationId: s.binding.operationId, paymentRef: op.createReceipt?.paymentRef || null,
        referenceSource: op.createReceipt ? 'STORED_RECEIPT' : 'LEGACY_OPERATION',
        clientSubscriptionId: s.binding.clientSubscriptionId, studioId: s.binding.studioId, roomId: s.binding.roomId,
        fromTime: s.binding.fromTime, toTime: s.binding.toTime,
        exerciseId: op.exerciseId, bookingId: op.bookingId, spot: s.booking.spot || null,
        selectedPaymentMode: 'subscription', settlementState: amount ? 'PAYMENT_REQUIRED' : 'CONFIRMED',
        toPayMinor: amount, toPay: amount / 100,
        // Nominal participant share is the stored target tariff, never the organizer's benefit/surcharge.
        shareAmountMinor: op.lk1.target.basePriceMinor, shareAmount: op.lk1.target.basePriceMinor / 100,
        paymentUrl: checkout?.paymentUrl || null, transactionId: checkout?.transactionId || null,
        subscriptionVisitCount: op.lk1.decision.subscriptionVisitCount,
        deadlineAt: op.createReceipt?.deadlineAt || null,
        assembleDeadlineAt: new Date(instant(s.binding.fromTime) - 24 * 60 * 60_000).toISOString(),
        directionId: op.lk1.createPayload.directionId, exerciseTypeId: op.lk1.createPayload.typeId,
      } } };
    }
    if (s.stage === 'exercise') {
      const x = event.body, b = s.binding;
      if (event.status !== 200 || !record(x) || x.id !== s.op.exerciseId || cancelled(x)
        || ![x.isCancelled, x.cancelled, x.canceled].includes(false)
        || !matches([x.studioId, x.studio?.id], b.studioId) || !matches([x.roomId, x.room?.id], b.roomId)
        || instant(x.timeFrom) !== instant(b.fromTime) || instant(x.timeTo) !== instant(b.toTime)) return pending(s, 'SPLIT_CREATE_RESULT_EXERCISE_UNVERIFIED');
      return bookingPage({ ...s, page: 0, rows: [] });
    }
    if (s.stage === 'bookings') {
      const b = event.body, rows = Array.isArray(b) ? b : b?.content;
      if (event.status !== 200 || !Array.isArray(rows) || rows.length > 200) return pending(s, 'SPLIT_CREATE_RESULT_BOOKINGS_UNAVAILABLE');
      const combined = [...s.rows, ...rows];
      const last = Array.isArray(b) ? rows.length < 200 : b.last;
      if (typeof last !== 'boolean' || (!Array.isArray(b) && (b.number !== s.page
        || !Number.isSafeInteger(b.totalElements) || b.totalElements < combined.length
        || (last && b.totalElements !== combined.length)))) return pending(s, 'SPLIT_CREATE_RESULT_BOOKINGS_INCOMPLETE');
      if (!last) return s.page < 4 ? bookingPage({ ...s, page: s.page + 1, rows: combined }) : pending(s, 'SPLIT_CREATE_RESULT_BOOKINGS_INCOMPLETE');
      const exact = combined.filter(x => x?.id === s.op.bookingId || x?.bookingId === s.op.bookingId);
      const x = exact[0];
      if (exact.length !== 1 || cancelled(x) || x.isCancelled !== false
        || !matches([x.id, x.bookingId], s.op.bookingId)
        || !matches([x.clientId, x.client?.id, x.client?.clientId], s.actor)
        || (x.exerciseId && x.exerciseId !== s.op.exerciseId)
        || (x.exercise?.id && x.exercise.id !== s.op.exerciseId)
        || (s.op.lk1.decision.benefit.finalPriceMinor === 0 && s.op.lk1.decision.subscriptionVisitCount === 1
          && (x.clientSubscriptionId !== s.binding.clientSubscriptionId || x.paymentType !== 'SUBSCRIPTION'))
        || (s.op.lk1.decision.benefit.finalPriceMinor > 0 && (x.clientSubscriptionId || x.paymentType !== 'ON_PLACE'))
        || (x.clientSubscriptionId && x.clientSubscriptionId !== s.binding.clientSubscriptionId)) return pending(s, 'SPLIT_CREATE_RESULT_BOOKING_UNVERIFIED');
      return find({ ...s, booking: { spot: Number.isSafeInteger(x.spot) ? x.spot : null }, rows: undefined }, 'operation_recheck');
    }
    return pending(s, 'SPLIT_CREATE_RESULT_STAGE_INVALID');
  }
  return { begin, step };
}
