const c = msg._splitLeaveCtx;
if (!c || !Array.isArray(c.initialBookingIds) || c.initialBookingIds.length !== 1) return [null, msg];
msg.payload = { tenantKey: 'iSkq6G', actorClientId: c.targetClientId,
  bookingId: c.initialBookingIds[0], exerciseId: c.exerciseId, state: 'CONFIRMED' };
return [msg, null];
