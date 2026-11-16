// Authenticated request/status protocol. This controller performs no financial
// command: native worker and canonical split cleanup remain the only owners.
export function createBookingPaymentCancellationProtocol(lifecycle) {
  const object = v => v !== null && typeof v === 'object' && !Array.isArray(v);
  const text = v => typeof v === 'string' && v.trim() === v && v.length > 0 && v.length <= 512;
  const find = (s, stage, query, collection = 'ops') => ({ state: { ...s, stage },
    effect: { kind: 'find', collection, query, options: { limit: 2, readConcern: { level: 'majority' } } } });
  const write = (s, stage, query, change, upsert = false) => ({ state: { ...s, stage },
    effect: { kind: 'update', query, change, options: { ...(upsert ? { upsert: true } : {}),
      writeConcern: { w: 'majority', j: true } } } });
  const reply = (s, status, state, code, extra = {}) => ({ state: s, effect: { kind: 'reply', status, body: {
    schemaVersion: 1, ...s.binding, actorClientId: s.actorClientId || null,
    exerciseId: s.operation?.exerciseId || s.head?.payment?.exerciseId || null,
    operationId: s.operation?.operationId || s.head?.operationId || null,
    state, paymentAttemptState: state, paymentUrl: null, cancelled: state === 'CLOSED',
    limitReleased: state === 'CLOSED', accepted: s.requestAccepted === true || state === 'CLOSED', paid: state === 'PAID', ...(code ? { code } : {}), ...extra } } });
  const review = (s, code) => reply(s, 503, 'REVIEW', code);
  const nativeQuery = s => ({ tenantKey: s.tenantKey, actorClientId: s.actorClientId, bookingId: s.binding.bookingId,
    lk1: { $exists: true } });
  const key = s => lifecycle.paymentAttemptCancelKey(s.tenantKey, s.actorClientId, s.binding.bookingId, s.binding.transactionId);
  function nativeBound(s, op) {
    const l = op?.lk1, c = l?.checkout, i = l?.transactionIntent;
    return op?.tenantKey === s.tenantKey && op.actorClientId === s.actorClientId
      && op.bookingId === s.binding.bookingId && text(op.operationId) && text(op.clientSubscriptionId)
      && op._id === 'lk1-product:' + JSON.stringify([s.tenantKey, s.actorClientId, op.operationId])
      && ['CONFIRMED', 'RELEASED'].includes(op.state) && !l?.unpaidCancellation && !l?.cancelledAllowanceRelease
      && ['open_game', 'group_training', 'tournament'].includes(op.category)
      && (c?.lifecycleVersion === 1 || op.category === 'open_game')
      && c?.transactionId === s.binding.transactionId && l.transactionId === c.transactionId
      && Number.isSafeInteger(c.toPayMinor) && c.toPayMinor > 0
      && l.decision?.benefit?.finalPriceMinor === c.toPayMinor && [0, 1].includes(l.decision.subscriptionVisitCount)
      && i?.bookingId === op.bookingId && i.actorClientId === s.actorClientId && i.chargeMinor === c.toPayMinor
      && text(i.productId) && text(l.rule?.productId) && text(l.fingerprint)
      && l.target?.eventId === op.exerciseId && text(op.exerciseId)
      && l.target.category === ({ open_game: 'GAME', group_training: 'GROUP_TRAINING', tournament: 'TOURNAMENT' })[op.category]
      && i.studioId === l.target.stationId && lifecycle.paymentAttemptDeadline(c, l.transactionAttemptedAt) !== null
      && (!op.upstreamBookingId || op.upstreamBookingId === op.bookingId)
      && typeof op.createdAt === 'string' && Number.isFinite(Date.parse(op.createdAt))
      && Date.parse(op.createdAt) >= Date.parse(s.cohortFrom);
  }
  function ordinaryBound(s, h) {
    const p = h?.payment;
    return h?.kind === 'SPLIT_BOOKING_PAYMENT_HEAD_V1' && h.tenantKey === s.tenantKey
      && h.actorClientId === s.actorClientId && text(h.operationId)
      && h._id?.startsWith('booking-payment-head:')
      && typeof h.createdAt === 'string' && Number.isFinite(Date.parse(h.createdAt))
      && Date.parse(h.createdAt) >= Date.parse(s.cohortFrom) && p?.clientId === s.actorClientId
      && p.bookingId === s.binding.bookingId && p.transactionId === s.binding.transactionId
      && Number.isSafeInteger(p.amountMinor) && p.amountMinor > 0 && text(p.exerciseId)
      && (!s.binding.gameId || !p.gameId || s.binding.gameId === p.gameId);
  }
  const gameRead = s => {
    const gameId = s.binding.gameId || s.head.payment.gameId;
    return text(gameId) ? find({ ...s, binding: { ...s.binding, gameId } }, 'game',
      { tenantKey: s.tenantKey, id: gameId }, 'games') : review(s, 'PAYMENT_CANCEL_GAME_UNAVAILABLE');
  };
  function nativeAfterRead(s, op, now) {
    if (!nativeBound(s, op)) return review(s, 'PAYMENT_CANCEL_NATIVE_BINDING_UNVERIFIED');
    s = { ...s, operation: op };
    if (lifecycle.paymentAttemptReleased(op)
      && (!op.lk1.paymentAttempt.resourceJobKey || op.lk1.paymentAttempt.resourceJobCompleted === true)) {
      return s.binding.gameId ? find(s, 'native_closed_game', { tenantKey: s.tenantKey, id: s.binding.gameId }, 'games')
        : reply(s, 200, 'CLOSED');
    }
    if (op.lk1.paymentAttempt?.phase === 'PAID') return reply(s, 200, 'PAID', 'PAYMENT_ALREADY_PAID');
    if (lifecycle.paymentAttemptCancelRequested(op)) s = { ...s, requestAccepted: true };
    if (!s.post) return reply(s, 202, op.lk1.paymentAttempt ? 'CLOSING' : 'PAYMENT_REQUIRED');
    if (op.state !== 'CONFIRMED') return review(s, 'PAYMENT_CANCEL_NATIVE_NOT_ACTIVE');
    if (op.lk1.paymentAttempt?.cancelRequest && !lifecycle.paymentAttemptCancelRequested(op)) {
      return review(s, 'PAYMENT_CANCEL_REQUEST_BINDING_INVALID');
    }
    if (!lifecycle.paymentAttemptCancelRequested(op)) {
      if ((s.casAttempts || 0) >= 3) return review(s, 'PAYMENT_CANCEL_CONCURRENT_CHANGE');
      const request = { schemaVersion: 1, key: key(s), operationKey: op._id,
        tenantKey: s.tenantKey, actorClientId: s.actorClientId, bookingId: op.bookingId,
        transactionId: s.binding.transactionId, requestedAt: new Date(now).toISOString() };
      return write({ ...s, casAttempts: (s.casAttempts || 0) + 1 }, 'native_requested', { _id: op._id,
        $expr: { $eq: ['$$ROOT', { $literal: op }] } }, { $set: {
          'lk1.paymentAttempt': { ...op.lk1.paymentAttempt,
            phase: op.lk1.paymentAttempt?.phase || 'CANCEL_REQUESTED', cancelRequest: request }, updatedAt: request.requestedAt } });
    }
    s = { ...s, requestAccepted: true };
    const r = op.lk1.paymentAttempt.cancelRequest;
    const job = { _id: key(s), kind: 'BOOKING_PAYMENT_CANCEL_REQUEST_V1', tenantKey: s.tenantKey,
      actorClientId: s.actorClientId, bookingId: op.bookingId, transactionId: s.binding.transactionId,
      operationKey: op._id, requestedAt: r.requestedAt, state: 'REQUESTED', nextCheckAt: r.requestedAt };
    return write({ ...s, job }, 'job_written', { _id: job._id }, { $setOnInsert: job }, true);
  }
  function ordinaryAfterRead(s, head, now) {
    if (!ordinaryBound(s, head)) return review(s, 'PAYMENT_CANCEL_HEAD_BINDING_UNVERIFIED');
    s = { ...s, head };
    if (head.phase === 'CLOSED') return head.closure?.receiptKey
      ? find(s, 'ordinary_receipt', { _id: head.closure.receiptKey }) : review(s, 'PAYMENT_CANCEL_CLOSURE_UNVERIFIED');
    if (head.phase !== 'PAYMENT_REQUIRED') return review(s, 'PAYMENT_CANCEL_ATTEMPT_UNRESOLVED');
    if (head.cancelRequestedAt && (head.cancelRequestedBy !== s.actorClientId || head.cancelRequestKey !== key(s)
      || !Number.isFinite(Date.parse(head.cancelRequestedAt)))) return review(s, 'PAYMENT_CANCEL_REQUEST_BINDING_INVALID');
    if (head.cancelRequestedAt) s = { ...s, requestAccepted: true };
    if (!s.post || head.cancelRequestedAt) return gameRead(s);
    if ((s.casAttempts || 0) >= 3) return review(s, 'PAYMENT_CANCEL_CONCURRENT_CHANGE');
    return write({ ...s, casAttempts: (s.casAttempts || 0) + 1 }, 'ordinary_requested', { _id: head._id,
      $expr: { $eq: ['$$ROOT', { $literal: head }] } }, { $set: { cancelRequestedAt: new Date(now).toISOString(),
        cancelRequestedBy: s.actorClientId, cancelRequestKey: key(s), updatedAt: new Date(now).toISOString() } });
  }
  function begin(input, { tenantKey, enabled, cohortFrom, method = 'POST' }, now = Date.now()) {
    const s = { stage: 'profile', tenantKey, cohortFrom, post: method === 'POST', deadline: now + 15000,
      binding: { bookingId: input?.bookingId, transactionId: input?.transactionId,
        ...(input?.gameId ? { gameId: input.gameId } : {}) } };
    if (enabled !== true || !/^[A-Za-z0-9_-]{1,64}$/.test(tenantKey || '')
      || lifecycle.paymentAttemptInstant(cohortFrom) === null) return review(s, 'PAYMENT_CANCEL_UNAVAILABLE');
    if (!['POST', 'GET'].includes(method) || !object(input)
      || Object.keys(input).some(k => !['bookingId', 'transactionId', 'gameId'].includes(k))
      || !text(input.bookingId) || !text(input.transactionId) || input.gameId != null && !text(input.gameId)) {
      return reply(s, 400, 'REVIEW', 'PAYMENT_CANCEL_INPUT_INVALID');
    }
    return { state: s, effect: { kind: 'http', method: 'GET',
      path: '/end-user/api/v1/' + encodeURIComponent(tenantKey) + '/profile' } };
  }
  function step(s, event, now = Date.now()) {
    if (!s || !Number.isFinite(s.deadline) || now >= s.deadline) return review(s || { binding: {} }, 'PAYMENT_CANCEL_TIMEOUT');
    const rows = !event.error && Array.isArray(event.body) ? event.body : null;
    if (s.stage === 'profile') {
      const profile = object(event.body?.data) ? event.body.data : event.body;
      if (event.error || event.status !== 200 || !text(profile?.id || profile?.clientId)) {
        return reply(s, 401, 'REVIEW', 'PAYMENT_CANCEL_ACTOR_UNVERIFIED');
      }
      if (profile.id && profile.clientId && profile.id !== profile.clientId) return reply(s, 401, 'REVIEW', 'PAYMENT_CANCEL_ACTOR_UNVERIFIED');
      s = { ...s, actorClientId: profile.id || profile.clientId };
      return find(s, 'native', nativeQuery(s));
    }
    if (s.stage === 'native') {
      if (!rows || rows.length > 1) return review(s, 'PAYMENT_CANCEL_OWNER_UNAVAILABLE');
      return rows.length ? nativeAfterRead(s, rows[0], now) : find(s, 'ordinary', {
        kind: 'SPLIT_BOOKING_PAYMENT_HEAD_V1', tenantKey: s.tenantKey, actorClientId: s.actorClientId,
        'payment.bookingId': s.binding.bookingId });
    }
    if (s.stage === 'native_requested') return find(s, 'native', nativeQuery(s));
    if (s.stage === 'job_written') return find(s, 'job_verified', { _id: s.job._id });
    if (s.stage === 'job_verified') {
      const j = rows?.length === 1 ? rows[0] : null;
      if (!j || ['_id', 'kind', 'tenantKey', 'actorClientId', 'bookingId', 'transactionId', 'operationKey', 'requestedAt']
        .some(k => j[k] !== s.job[k])) return review(s, 'PAYMENT_CANCEL_QUEUE_UNVERIFIED');
      return reply(s, 202, 'CLOSING');
    }
    if (s.stage === 'ordinary') {
      if (!rows || rows.length > 1) return review(s, 'PAYMENT_CANCEL_OWNER_UNAVAILABLE');
      if (!rows.length) return reply(s, 404, 'REVIEW', 'PAYMENT_CANCEL_ATTEMPT_NOT_FOUND');
      return ordinaryAfterRead(s, rows[0], now);
    }
    if (s.stage === 'ordinary_requested') return find(s, 'ordinary', { _id: s.head._id });
    if (s.stage === 'ordinary_receipt') {
      const r = rows?.length === 1 ? rows[0] : null, c = s.head.closure;
      const withoutRevision = { ...c }; delete withoutRevision.rosterRevision;
      if (!r || r.kind !== 'SPLIT_BOOKING_PAYMENT_CLOSURE_V1' || r._id !== c.receiptKey
        || r._id !== 'split-booking-payment-closure:' + JSON.stringify([s.tenantKey, c.gameId, s.actorClientId, s.binding.bookingId, s.binding.transactionId])
        || JSON.stringify(r.proposal) !== JSON.stringify(withoutRevision)
        || c.headKey !== s.head._id || c.bookingId !== s.binding.bookingId || c.transactionId !== s.binding.transactionId
        || c.amountMinor !== s.head.payment.amountMinor || c.clientId !== s.actorClientId || c.tenantKey !== s.tenantKey
        || c.transactionState !== 'UNPAID_CLOSED' || c.bookingState !== 'CANCELLED'
        || !Number.isSafeInteger(c.rosterRevision) || c.rosterRevision <= c.sourceRevision) return review(s, 'PAYMENT_CANCEL_CLOSURE_UNVERIFIED');
      return reply(s, 200, 'CLOSED');
    }
    if (s.stage === 'game') {
      const g = rows?.length === 1 ? rows[0] : null, p = s.head.payment;
      const payments = g?.metadata?.splitPayment?.payments;
      const exerciseIds = [g?.booking?.exerciseId, g?.booking?.vivaExerciseId, g?.metadata?.exerciseId,
        g?.metadata?.vivaExerciseId, g?.metadata?.splitPayment?.exerciseId, g?.metadata?.splitPayment?.vivaExerciseId].filter(Boolean);
      const exact = Array.isArray(payments) ? payments.filter(r => r.clientId === s.actorClientId
        && r.bookingId === s.binding.bookingId && r.transactionId === s.binding.transactionId) : [];
      if (!g || g.id !== s.binding.gameId || g.tenantKey !== s.tenantKey || g.archived === true
        || ['CANCELLED', 'CANCELED'].includes(g.status) || !Number.isSafeInteger(g.revision)
        || !exerciseIds.length || exerciseIds.some(id => id !== p.exerciseId)
        || exact.length !== 1 || exact[0].amountMinor !== p.amountMinor) return review(s, 'PAYMENT_CANCEL_GAME_BINDING_UNVERIFIED');
      if (exact[0].status === 'PAID') return { state: { ...s, stage: 'ordinary_paid_verified' },
        effect: { kind: 'http', method: 'GET', auth: 'service',
          path: '/api/v1/transactions/' + encodeURIComponent(s.binding.transactionId) } };
      if (!s.post) return reply(s, 202, s.head.cancelRequestedAt ? 'CLOSING' : 'PAYMENT_REQUIRED');
      if (!s.head.cancelRequestedAt || !['PAYMENT_PENDING', 'EXPIRED', 'LEFT', 'CANCELLED', 'CANCELED'].includes(exact[0].status)) {
        return review(s, 'PAYMENT_CANCEL_ATTEMPT_NOT_PENDING');
      }
      return { state: s, effect: { kind: 'cleanup', game: g, request: {
        intent: 'cancel_payment', paymentCancellation: { authorized: true, headKey: s.head._id,
          operationId: s.head.operationId, bookingId: s.binding.bookingId, transactionId: s.binding.transactionId,
          actorClientId: s.actorClientId, requestedAt: s.head.cancelRequestedAt }, actorClientId: s.actorClientId,
        gameId: g.id, tenantKey: s.tenantKey, nowTs: now, nowIso: new Date(now).toISOString(),
        dryRun: false, force: false, limit: 1 } } };
    }
    if (s.stage === 'native_closed_game') {
      if (!rows || rows.length > 1) return review(s, 'PAYMENT_CANCEL_GAME_UNAVAILABLE');
      // A deleted canonical card cannot retain a local reservation.
      if (!rows.length) return reply(s, 200, 'CLOSED');
      const g = rows[0], op = s.operation;
      const payments = g?.metadata?.splitPayment?.payments;
      const exerciseIds = [g?.booking?.exerciseId, g?.booking?.vivaExerciseId, g?.metadata?.exerciseId,
        g?.metadata?.vivaExerciseId, g?.metadata?.splitPayment?.exerciseId, g?.metadata?.splitPayment?.vivaExerciseId].filter(Boolean);
      const exact = Array.isArray(payments) ? payments.filter(r => r.bookingId === s.binding.bookingId
        || r.transactionId === s.binding.transactionId) : [];
      if (g.id !== s.binding.gameId || g.tenantKey !== s.tenantKey || !Number.isSafeInteger(g.revision)
        || !exerciseIds.length || exerciseIds.some(id => id !== op.exerciseId) || !Array.isArray(payments)
        || [g.participants, g.waitlist].some(v => v != null && !Array.isArray(v))
        || exact.length > 1 || exact.some(r => r.bookingId !== s.binding.bookingId || r.transactionId !== s.binding.transactionId
          || r.clientId !== s.actorClientId || r.amountMinor !== op.lk1.checkout.toPayMinor
          || !['PAYMENT_PENDING', 'EXPIRED', 'LEFT', 'CANCELLED', 'CANCELED'].includes(r.status))) {
        return review(s, 'PAYMENT_CANCEL_GAME_BINDING_UNVERIFIED');
      }
      if (!exact.length) return reply(s, 200, 'CLOSED');
      const present = [...(g.participants || []), ...(g.waitlist || [])].some(r => r.id === s.actorClientId || r.clientId === s.actorClientId);
      const otherActive = payments.some(r => !exact.includes(r) && r.clientId === s.actorClientId
        && ['PAID', 'PAYMENT_PENDING'].includes(r.status));
      const pending = exact[0].status === 'PAYMENT_PENDING' || present && !otherActive;
      if (!pending) return reply(s, 200, 'CLOSED');
      if (!s.post) return reply(s, 202, 'CLOSING', undefined, { financiallyClosed: true, needsFinalization: true });
      if (g.archived === true || ['CANCELLED', 'CANCELED'].includes(g.status)) return review(s, 'PAYMENT_CANCEL_GAME_UNAVAILABLE');
      return { state: s, effect: { kind: 'cleanup', game: g, request: {
        intent: 'cancel_payment', paymentCancellation: { authorized: true, nativeRelease: true,
          nativeOperationKey: op._id, operationId: op.operationId, bookingId: s.binding.bookingId,
          transactionId: s.binding.transactionId, actorClientId: s.actorClientId,
          requestedAt: op.lk1.paymentAttemptRelease.verifiedAt }, actorClientId: s.actorClientId,
        gameId: g.id, tenantKey: s.tenantKey, nowTs: now, nowIso: new Date(now).toISOString(),
        dryRun: false, force: false, limit: 1 } } };
    }
    if (s.stage === 'ordinary_paid_verified') {
      const payment = s.head.payment;
      const kind = !event.error && event.status === 200 && lifecycle.ordinaryTransaction?.(event.body,
        { transactionId: s.binding.transactionId, bookingId: s.binding.bookingId, clientId: s.actorClientId,
          exerciseId: payment.exerciseId, amountMinor: payment.amountMinor, productId: payment.productId });
      return kind === 'PAID' ? reply(s, 200, 'PAID', 'PAYMENT_ALREADY_PAID')
        : review(s, 'PAYMENT_CANCEL_PAID_PROOF_UNVERIFIED');
    }
    return review(s, 'PAYMENT_CANCEL_STAGE_INVALID');
  }
  return { begin, step };
}
