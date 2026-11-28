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
  const agrees = (values, expected) => values.every(v => v == null || v === expected);
  const matches = (values, expected) => values.some(v => v != null) && agrees(values, expected);
  const openGame = { directionId: 4588, typeId: 1613 };
  const isSubscriptionSurcharge = op => op.lk1?.decision.subscriptionVisitCount === 1
    && op.lk1.decision.benefit.finalPriceMinor > 0;
  const isActive = row => !cancelled(row)
    && !row.cancelledAt && !row.cancellationDate
    && agrees([row.isCancelled, row.cancelled, row.canceled, row.archived], false)
    && ![row.state, row.bookingStatus].some(status => /CANCEL|FAIL|REFUND|REJECT|VOID|EXPIRE|ARCHIVE/i.test(String(status || '')));
  const reply = (s, state, code, status = 202) => ({ state: null, effect: { kind: 'reply', status,
    body: { schemaVersion: 1, recovery: 'SPLIT_CREATE_RESULT_V1', operationId: s?.binding?.operationId || null,
      state, code } } });
  const pending = (s, code) => reply(s, 'PENDING_CONFIRMATION', code);
  const http = (s, stage, path, auth = 'service') => ({ state: { ...s, stage }, effect: { kind: 'http', method: 'GET', path, auth } });
  const managedKey = s => `lk1-product:${JSON.stringify([tenant, s.actor, s.binding.operationId])}`;
  const find = (s, stage) => ({ state: { ...s, stage }, effect: { kind: 'find',
    query: { _id: s.legacyKeys ? { $in: [managedKey(s), ...s.legacyKeys] } : managedKey(s),
      tenantKey: tenant, actorClientId: s.actor, operationId: s.binding.operationId },
    options: { limit: 2, readConcern: { level: 'majority' }, maxTimeMS: 2000 } } });
  const operationIdValid = value => typeof value === 'string' && /^lk-split-create-[a-z0-9]{1,100}$/.test(value);
  const bindingValid = b => record(b) && operationIdValid(b.operationId)
    && uuid(b.clientSubscriptionId) && uuid(b.studioId) && uuid(b.roomId)
    && /^\d{4}-\d\d-\d\dT\d\d:\d\d:00\+03:00$/.test(b.fromTime)
    && /^\d{4}-\d\d-\d\dT\d\d:\d\d:00\+03:00$/.test(b.toTime)
    && instant(b.toTime) > instant(b.fromTime) && instant(b.toTime) - instant(b.fromTime) <= 4 * 60 * 60_000;
  function legacyKeysFor(booking) {
    const daily = `${tenant}:${booking.subscriptionId}:${booking.fromTime.slice(0, 10)}`;
    return { shared_day: daily, category_day: `${daily}:open_game`, event: `${daily}:${booking.exerciseId}` };
  }

  // Use the caller's own completed Viva page to derive bounded indexed keys.
  // The opaque operation ID alone is not indexed on the legacy collection.
  function legacyBookingCandidates(body, actor, now) {
    if (!record(body) || !Array.isArray(body.content) || body.content.length > 1000
      || body.totalElements !== body.content.length || body.last !== true
      || !agrees([body.number, body.pageable?.pageNumber], 0)
      || body.content.some(row => !record(row))) return null;
    const bookings = [];
    for (const row of body.content) {
      const x = row.exercise;
      const subscriptionId = row.clientSubscriptionId;
      const fromTime = moscow(x?.timeFrom);
      if (!record(x) || !isActive(row) || row.isCancelled !== false || !isActive(x)
        || row.paymentType !== 'SUBSCRIPTION' || !agrees([row.detailedPaymentType], 'SUBSCRIPTION')
        || !agrees([row.clientId, row.client?.id, row.client?.clientId], actor)
        || !uuid(row.id) || !uuid(subscriptionId) || !uuid(x.id)
        || !agrees([row.bookingId, row.uuid], row.id) || !agrees([row.exerciseId, row.vivaExerciseId, x.uuid], x.id)
        || !agrees([row.subscriptionId, row.clientSubscription?.id], subscriptionId)
        || !agrees([x.studio?.id, x.studioId], x.studio?.id ?? x.studioId)
        || !agrees([x.room?.id, x.roomId], x.room?.id ?? x.roomId)
        || !fromTime || instant(fromTime) <= now) continue;
      bookings.push({ bookingId: row.id, exerciseId: x.id, subscriptionId, fromTime,
        toTime: moscow(x.timeTo), studioId: x.studio?.id ?? x.studioId ?? null,
        roomId: x.room?.id ?? x.roomId ?? null });
    }
    return bookings;
  }

  function legacyOperationBooking(s, op) {
    if (!record(op) || op.tenantKey !== tenant || op.actorClientId !== s.actor
      || op.operationId !== s.binding.operationId || op.category !== 'open_game' || op.state !== 'CONFIRMED'
      || !agrees([op.upstreamBookingId], op.bookingId)
      || !Number.isFinite(instant(op.confirmedAt)) || !Number.isFinite(instant(op.updatedAt))
      || instant(op.updatedAt) < instant(op.confirmedAt)
      || [op.lk1, op.createReceipt, op.managedEnvironment, op.managedDecision, op.managedEntitlementOperationId,
        op.managedJoinV2, op.lk2LegacyJoin, op.releasedAt, op.releaseSource,
        op.releaseBookingId, op.failure, op.failedAt, op.transactionId].some(value => value != null)
      || (op.releasedBookingIds != null && (!Array.isArray(op.releasedBookingIds) || op.releasedBookingIds.includes(op.bookingId)))) return null;
    const matches = s.legacyBookings.filter(row => row.bookingId === op.bookingId
      && row.exerciseId === op.exerciseId && row.subscriptionId === op.clientSubscriptionId
      && row.fromTime.slice(0, 10) === op.serviceDate);
    if (matches.length !== 1 || !['shared_day', 'category_day', 'event'].includes(op.limitMode)) return null;
    const booking = matches[0];
    return op._id === legacyKeysFor(booking)[op.limitMode] ? booking : null;
  }

  function legacyExerciseBinding(s, x) {
    const original = s.legacyBooking;
    const binding = { operationId: s.binding.operationId, clientSubscriptionId: original.subscriptionId,
      studioId: x.studio?.id ?? x.studioId, roomId: x.room?.id ?? x.roomId,
      fromTime: moscow(x.timeFrom), toTime: moscow(x.timeTo) };
    if (!bindingValid(binding) || !isActive(x) || ![2, 4].includes(x.maxClientsCount)
      || !matches([x.direction?.id, x.directionId], openGame.directionId)
      || !matches([x.type?.id, x.typeId], openGame.typeId)
      || !agrees([original.studioId], binding.studioId) || !agrees([original.roomId], binding.roomId)
      || binding.fromTime !== original.fromTime || !agrees([original.toTime], binding.toTime)) return null;
    return binding;
  }

  function validLegacyCreateProof(s, binding, maxClientsCount) {
    const proof = s.op.legacySplitCreate;
    if (proof == null) return true; // Historical rows can only reconnect an existing LK card.
    return record(proof) && proof.schemaVersion === 1 && proof.actorClientId === s.actor
      && proof.exerciseId === s.op.exerciseId && proof.maxClientsCount === maxClientsCount
      && Object.entries(binding).every(([key, value]) => proof[key] === value)
      && /^[A-Za-z0-9._:-]{1,200}$/.test(typeof proof.paymentRef === 'string' ? proof.paymentRef : '')
      && [1, 2].includes(proof.subscriptionVisitCount);
  }

  function legacyReply(s) {
    const proof = s.op.legacySplitCreate;
    return { state: null, effect: { kind: 'reply', status: 200, body: {
      schemaVersion: 1, recovery: 'SPLIT_CREATE_RESULT_V1', state: 'CONFIRMED', mode: 'create',
      ...s.binding, exerciseId: s.op.exerciseId, bookingId: s.op.bookingId, spot: s.booking.spot,
      referenceSource: proof ? 'LEGACY_DAILY_RECEIPT' : 'LEGACY_DAILY_OPERATION',
      paymentRef: proof?.paymentRef ?? null, existingCardOnly: !proof,
      ...(proof ? { subscriptionVisitCount: proof.subscriptionVisitCount } : {}),
      selectedPaymentMode: 'subscription', settlementState: 'CONFIRMED', toPayMinor: 0, toPay: 0,
      shareAmountMinor: null, shareAmount: null, transactionId: null, paymentUrl: null, deadlineAt: null,
      assembleDeadlineAt: new Date(instant(s.binding.fromTime) - 24 * 60 * 60_000).toISOString(),
      maxClientsCount: s.maxClientsCount, directionId: openGame.directionId, exerciseTypeId: openGame.typeId,
    } } };
  }

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
    if (isSubscriptionSurcharge(op) && (!uuid(intent?.productId)
      || t.currency !== 'RUB' || d.benefit.currency !== 'RUB')) return false;
    const safeUrl = typeof checkout?.paymentUrl === 'string' && checkout.paymentUrl.length <= 2048
      && /^https:\/\/[a-z0-9](?:[a-z0-9.-]*[a-z0-9])?(?::443)?(?:[/?#][^\s]*)?$/i.test(checkout.paymentUrl);
    return record(checkout) && record(intent) && safeUrl
      && checkout.toPayMinor === amount && uuid(checkout.transactionId)
      && checkout.transactionId === q.transactionId && Number.isFinite(instant(q.transactionAttemptedAt))
      && intent.bookingId === op.bookingId && intent.actorClientId === s.actor
      && intent.studioId === t.stationId && intent.chargeMinor === amount;
  }
  // A subscription booking can carry the subscription purchase transaction.
  // The surcharge is a different transaction bound to that booking via its product.
  function surchargeSettlement(s, event, now) {
    const tx = event.body, op = s.op, intent = op.lk1.transactionIntent;
    const product = Array.isArray(tx?.products) && tx.products.length === 1 ? tx.products[0] : null;
    const exactBookingList = ids => Array.isArray(ids) && ids.length === 1 && ids[0] === op.bookingId;
    if (event.status !== 200 || !record(tx) || !record(product)
      || tx.id !== op.lk1.transactionId || tx.client?.id !== s.actor || tx.toPay !== intent.chargeMinor
      || product.id !== intent.productId || !exactBookingList(product.paymentBookingIds)
      || !agrees([tx.transactionId], op.lk1.transactionId)
      || !agrees([tx.clientId, tx.client?.uuid], s.actor)
      || !agrees([tx.bookingId, product.bookingId, product.clientBookingId], op.bookingId)
      || !agrees([tx.exerciseId, tx.exercise?.id, product.linkedExerciseId, product.originalExerciseId], op.exerciseId)
      || !agrees([tx.toPayMinor], intent.chargeMinor) || !agrees([tx.currency], 'RUB')
      || ![tx.bookingIds, tx.paymentBookingIds, product.bookingIds].every(ids => ids == null || exactBookingList(ids))
      || (product.pricingDetails != null && (!Array.isArray(product.pricingDetails)
        || !product.pricingDetails.every(row => record(row) && agrees([row.bookingId, row.clientBookingId], op.bookingId))))
      || !agrees([tx.state, tx.paymentStatus, tx.transactionStatus?.transactionStatus ?? tx.transactionStatus], tx.status)
      || tx.possibleDoublePayment || product.refunded
      || (tx.transactionRefunds != null && (!Array.isArray(tx.transactionRefunds) || tx.transactionRefunds.length > 0))) return null;
    const cards = [tx.cardPaymentInfo, tx.cardPaymentStatus, tx.transactionStatus?.cardPaymentStatus].filter(v => v != null);
    const noRefund = v => !v.refund && !v.refundedAt && !v.refundDate
      && agrees([v.refundSum, v.refundedAmountMinor], 0);
    if (!cards.every(record) || ![tx, ...cards].every(noRefund)) return null;
    const paidAt = instant(tx.paymentDate);
    if (tx.status === 'PAID' && paidAt >= instant(op.lk1.transactionAttemptedAt) && paidAt <= now
      && cards.every(card => card.status == null || ['CONFIRMED', 'PAID'].includes(card.status))) {
      return { state: 'PAID', paidAt: new Date(paidAt).toISOString() };
    }
    const due = tx.paymentDueDate == null ? Infinity : instant(tx.paymentDueDate);
    const urls = [tx.paymentUrl, tx.paymentLink, ...cards.flatMap(card => [card.paymentUrl, card.paymentLink])];
    if (tx.status === 'UNPAID' && tx.processingStatus == null && tx.receiptPending !== true
      && [tx, ...cards].every(v => v.paid !== true && v.isPaid !== true && !v.paymentDate && !v.paidAt
        && agrees([v.deposit, v.paidAmount, v.paidAmountMinor, v.paidAmountKopecks], 0)
        && (v.receipts == null || (Array.isArray(v.receipts) && v.receipts.length === 0)))
      && cards.every(card => card.status == null || ['NEW', 'UNPAID'].includes(card.status))
      && matches(urls, op.lk1.checkout.paymentUrl)
      && now < Math.min(instant(op.createReceipt.deadlineAt), due)) return { state: 'PAYMENT_REQUIRED', paidAt: null };
    return null;
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
    if (s.stage === 'operation' && Array.isArray(event.body) && event.body.length === 0) {
      return http(s, 'legacy_self_bookings', `/end-user/api/v2/${tenant}/bookings?size=1000`, 'actor');
    }
    if (s.stage === 'legacy_self_bookings') {
      const legacyBookings = event.status === 200 ? legacyBookingCandidates(event.body, s.actor, now) : null;
      if (!legacyBookings?.length) return pending(s, 'SPLIT_CREATE_RESULT_NOT_CONFIRMED');
      const legacyKeys = [...new Set(legacyBookings.flatMap(row => Object.values(legacyKeysFor(row))))];
      return find({ ...s, legacyBookings, legacyKeys }, 'legacy_operation');
    }
    if (s.stage === 'legacy_operation' || s.stage === 'legacy_recheck') {
      if (!Array.isArray(event.body) || event.body.length !== 1) return pending(s, 'SPLIT_CREATE_RESULT_NOT_CONFIRMED');
      const op = event.body[0], legacyBooking = legacyOperationBooking(s, op);
      if (!legacyBooking) return pending(s, 'SPLIT_CREATE_RESULT_NOT_CONFIRMED');
      if (s.stage === 'legacy_recheck') {
        return JSON.stringify(s.op) === JSON.stringify(op) ? legacyReply(s) : pending(s, 'SPLIT_CREATE_RESULT_CHANGED');
      }
      return http({ ...s, op, legacyBooking }, 'exercise', `/api/v1/exercises/${encodeURIComponent(op.exerciseId)}`);
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
      const settlementState = s.settlement?.state ?? (amount ? 'PAYMENT_REQUIRED' : 'CONFIRMED');
      // Whitelist only. No actor data, quote, credentials, raw provider row or headers.
      return { state: null, effect: { kind: 'reply', status: 200, body: {
        schemaVersion: 1, recovery: 'SPLIT_CREATE_RESULT_V1', state: 'CONFIRMED', mode: 'create',
        operationId: s.binding.operationId, paymentRef: op.createReceipt?.paymentRef || null,
        referenceSource: op.createReceipt ? 'STORED_RECEIPT' : 'LEGACY_OPERATION',
        clientSubscriptionId: s.binding.clientSubscriptionId, studioId: s.binding.studioId, roomId: s.binding.roomId,
        fromTime: s.binding.fromTime, toTime: s.binding.toTime,
        exerciseId: op.exerciseId, bookingId: op.bookingId, spot: s.booking.spot || null,
        selectedPaymentMode: 'subscription', settlementState,
        ...(settlementState === 'PAID' ? { paidAt: s.settlement.paidAt } : {}),
        toPayMinor: amount, toPay: amount / 100,
        // Nominal participant share is the stored target tariff, never the organizer's benefit/surcharge.
        shareAmountMinor: op.lk1.target.basePriceMinor, shareAmount: op.lk1.target.basePriceMinor / 100,
        paymentUrl: settlementState === 'PAID' ? null : checkout?.paymentUrl || null,
        transactionId: checkout?.transactionId || null,
        ...(isSubscriptionSurcharge(op) ? {
          clientId: s.actor, productId: op.lk1.transactionIntent.productId,
          maxClientsCount: op.lk1.createPayload.maxClientsCount,
          totalAmount: op.lk1.target.basePriceMinor * op.lk1.createPayload.maxClientsCount / 100,
        } : {}),
        subscriptionVisitCount: op.lk1.decision.subscriptionVisitCount,
        deadlineAt: op.createReceipt?.deadlineAt || null,
        assembleDeadlineAt: new Date(instant(s.binding.fromTime) - 24 * 60 * 60_000).toISOString(),
        directionId: op.lk1.createPayload.directionId, exerciseTypeId: op.lk1.createPayload.typeId,
      } } };
    }
    if (s.stage === 'exercise') {
      const x = event.body;
      if (s.legacyBooking && event.status === 200 && record(x) && x.id === s.op.exerciseId) {
        const binding = legacyExerciseBinding(s, x);
        if (!binding || !validLegacyCreateProof(s, binding, x.maxClientsCount)) return pending(s, 'SPLIT_CREATE_RESULT_EXERCISE_UNVERIFIED');
        s = { ...s, binding, maxClientsCount: x.maxClientsCount };
      }
      const b = s.binding;
      if (event.status !== 200 || !record(x) || x.id !== s.op.exerciseId || cancelled(x)
        || ![x.isCancelled, x.cancelled, x.canceled].includes(false)
        || !matches([x.studioId, x.studio?.id], b.studioId) || !matches([x.roomId, x.room?.id], b.roomId)
        || instant(x.timeFrom) !== instant(b.fromTime) || instant(x.timeTo) !== instant(b.toTime)
        || (isSubscriptionSurcharge(s.op) && x.maxClientsCount !== s.op.lk1.createPayload.maxClientsCount)) {
        return pending(s, 'SPLIT_CREATE_RESULT_EXERCISE_UNVERIFIED');
      }
      return bookingPage({ ...s, page: 0, rows: [] });
    }
    if (s.stage === 'surcharge') {
      const settlement = surchargeSettlement(s, event, now);
      return settlement ? find({ ...s, settlement }, 'operation_recheck') : pending(s, 'SPLIT_CREATE_RESULT_SURCHARGE_UNVERIFIED');
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
        || ((s.legacyBooking || s.op.lk1.decision.subscriptionVisitCount === 1)
          && (x.clientSubscriptionId !== s.binding.clientSubscriptionId || x.paymentType !== 'SUBSCRIPTION'))
        || (!s.legacyBooking && s.op.lk1.decision.benefit.finalPriceMinor > 0 && s.op.lk1.decision.subscriptionVisitCount === 0
          && (x.clientSubscriptionId || x.paymentType !== 'ON_PLACE'))
        || (x.clientSubscriptionId && x.clientSubscriptionId !== s.binding.clientSubscriptionId)) return pending(s, 'SPLIT_CREATE_RESULT_BOOKING_UNVERIFIED');
      const verified = { ...s, booking: { spot: Number.isSafeInteger(x.spot) ? x.spot : null }, rows: undefined };
      if (s.legacyBooking) {
        if (!isActive(x) || !agrees([x.detailedPaymentType], 'SUBSCRIPTION')
          || (x.spot != null && (!Number.isSafeInteger(x.spot) || x.spot < 1 || x.spot > s.maxClientsCount || (s.op.legacySplitCreate && x.spot !== 1)))) {
          return pending(s, 'SPLIT_CREATE_RESULT_BOOKING_UNVERIFIED');
        }
        return find(verified, 'legacy_recheck');
      }
      return isSubscriptionSurcharge(s.op)
        ? http(verified, 'surcharge', `/api/v1/transactions/${encodeURIComponent(s.op.lk1.transactionId)}`)
        : find(verified, 'operation_recheck');
    }
    return pending(s, 'SPLIT_CREATE_RESULT_STAGE_INVALID');
  }
  return { begin, step };
}
