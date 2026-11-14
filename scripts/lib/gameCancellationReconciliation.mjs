// Authenticated truth reconciliation. Provider effects are GET-only; payment
// receipts and booking/participant history are retained by the local CAS.
export function gameCancellationBegin({ gameId, actorClientId }) {
  return { state: { gameId, actorClientId, stage: 'game' }, effect: { kind: 'find', query: { id: gameId } } };
}
export function gameCancellationStep(s, input, at = new Date().toISOString()) {
  const reply = (status, state, code) => ({ kind: 'reply', status, payload: {
    ok: status < 400, gameId: s.gameId, state, ...(code ? { code } : {}) } });
  const get = (stage, path) => { s.stage = stage; return { kind: 'http', method: 'GET', path }; };
  const same = (values, expected) => values.filter(v => v != null && v !== '').length > 0
    && values.every(v => v == null || v === '' || v === expected);
  const cancelled = b => {
    const flags = [b?.isCancelled, b?.cancelled, b?.canceled].filter(v => v != null);
    return flags.length > 0 && flags.every(v => v === true)
      && [b?.status, b?.bookingStatus].every(v => v == null || ['CANCELLED', 'CANCELED'].includes(v));
  };
  if (s.stage === 'ack') { s.stage = 'readback'; return { kind: 'find', query: { id: s.gameId } }; }
  if (input.error || input.status != null && input.status !== 200) return reply(503, 'UNVERIFIED', 'CANCELLATION_READ_UNAVAILABLE');
  const v = input.payload;
  if (s.stage === 'game') {
    if (!Array.isArray(v) || v.length !== 1) return reply(404, 'UNVERIFIED', 'GAME_NOT_FOUND');
    const game = v[0], member = r => (r?.clientId || r?.playerId || r?.userId || r?.id) === s.actorClientId;
    if (![game.organizer, ...(game.participants || []), ...(game.waitlist || []),
      ...(game.metadata?.splitPayment?.payments || [])].some(member)) return reply(403, 'UNVERIFIED', 'GAME_ACCESS_DENIED');
    if (['CANCELLED', 'CANCELED'].includes(game.status)) return reply(200, 'CANCELLED');
    if (game.membershipMutation || ['FINISHED', 'COMPLETED'].includes(game.status)) return reply(409, 'UNVERIFIED', 'GAME_CHANGED');
    const split = game.metadata?.splitPayment;
    const organizerId = game.organizer?.id;
    const booking = split?.organizerBookingId || game.booking?.bookingId
      || (game.booking?.bookingIds?.length === 1 ? game.booking.bookingIds[0] : null);
    const exercise = split?.vivaExerciseId || game.booking?.vivaExerciseId || game.booking?.exerciseId;
    if (![organizerId, booking, exercise].every(x => typeof x === 'string' && x)
      || !same([game.metadata?.organizerId, organizerId], organizerId)
      || !same([split?.vivaExerciseId, game.booking?.vivaExerciseId, game.booking?.exerciseId], exercise)) {
      return reply(409, 'UNVERIFIED', 'GAME_BOOKING_BINDING_UNVERIFIED');
    }
    s.game = game; s.binding = { organizerId, booking, exercise }; s.startedAt = at;
    return get('booking', `/api/v1/clients/${encodeURIComponent(organizerId)}/bookings/${encodeURIComponent(booking)}`);
  }
  if (s.stage === 'booking') {
    const b = s.binding;
    if (!same([v?.id, v?.bookingId], b.booking) || !same([v?.clientId, v?.client?.id], b.organizerId)
      || !same([v?.exerciseId, v?.exercise?.id], b.exercise)) return reply(409, 'UNVERIFIED', 'PROVIDER_BINDING_UNVERIFIED');
    if (!cancelled(v)) return reply(200, 'ACTIVE');
    s.page = 0; s.count = 0; s.bookingIds = [];
    return get('bookings', `/api/v1/exercises/${encodeURIComponent(b.exercise)}/bookings?showCancelled=true&size=200&page=0`);
  }
  if (s.stage === 'bookings') {
    if (!Array.isArray(v?.content) || typeof v.last !== 'boolean' || v.content.length > 200
      || !Number.isSafeInteger(v.totalElements) || v.totalElements < 0
      || (v.pageable?.pageNumber != null && v.pageable.pageNumber !== s.page)
      || (s.page > 0 && v.totalElements !== s.totalElements)
      || !v.last && v.content.length !== 200) return reply(503, 'UNVERIFIED', 'PROVIDER_PAGE_INCOMPLETE');
    s.totalElements = v.totalElements;
    for (const row of v.content) {
      if (!cancelled(row)) return reply(200, 'ACTIVE_REPLACEMENT');
      if (!row.id || s.bookingIds.includes(row.id)
        || !same([row.id, row.bookingId], row.id)
        || [row.exerciseId, row.exercise?.id].some(id => id != null && id !== s.binding.exercise)
        || row.id === s.binding.booking && !same([row.clientId, row.client?.id], s.binding.organizerId)) {
        return reply(503, 'UNVERIFIED', 'PROVIDER_PAGE_AMBIGUOUS');
      }
      s.bookingIds.push(row.id);
    }
    s.count += v.content.length;
    if (!v.last) {
      if (++s.page >= 10) return reply(503, 'UNVERIFIED', 'PROVIDER_PAGE_LIMIT');
      return get('bookings', `/api/v1/exercises/${encodeURIComponent(s.binding.exercise)}/bookings?showCancelled=true&size=200&page=${s.page}`);
    }
    if (v.totalElements !== s.count || !s.bookingIds.includes(s.binding.booking)
      || Date.parse(at) - Date.parse(s.startedAt) > 30000) return reply(409, 'UNVERIFIED', 'PROVIDER_EVIDENCE_STALE');
    const g = s.game;
    s.proof = { schemaVersion: 1, source: 'EXACT_CANCELLED_BOOKINGS', ...s.binding, verifiedAt: at };
    s.stage = 'ack';
    return { kind: 'update', query: { id: s.gameId, updatedAt: g.updatedAt ?? { $exists: false },
      organizer: g.organizer, booking: g.booking, metadata: g.metadata,
      participants: g.participants || [], membershipMutation: { $exists: false },
      ...(g.revision == null ? {} : { revision: g.revision }) }, change: { $set: {
      status: 'CANCELLED', archived: true, updatedAt: at, 'metadata.cancelledInViva': true,
      'metadata.cancellationReconciliation': s.proof }, ...(Number.isSafeInteger(g.revision) ? { $inc: { revision: 1 } } : {}) },
      options: { upsert: false, writeConcern: { w: 'majority', j: true } } };
  }
  if (s.stage === 'readback') {
    const game = Array.isArray(v) && v.length === 1 ? v[0] : null;
    return game?.status === 'CANCELLED' && game.archived === true
      && JSON.stringify(game.metadata?.cancellationReconciliation) === JSON.stringify(s.proof)
      ? reply(200, 'CANCELLED') : reply(409, 'UNVERIFIED', 'GAME_CAS_CHANGED');
  }
  return reply(409, 'UNVERIFIED', 'RECONCILIATION_STATE_INVALID');
}
