// Never persist headers, tokens, request/response objects or arbitrary provider bodies.
const ctx = msg._splitCleanupCtx || msg._splitLeaveCtx || {};
const scalar = value => typeof value === 'string' && value.length <= 200 ? value : null;
const ids = value => Array.isArray(value) ? value.map(scalar).filter(Boolean).slice(0, 100) : [];
const status = Number(msg.statusCode);
const prior = flow.get('gamesMaintenanceCapture') || { sequence: 0, pending: 0, unhealthy: false };
const sequence = prior.sequence + 1;
if (!Number.isSafeInteger(sequence)) { node.error('Maintenance capture sequence exhausted'); return null; }
flow.set('gamesMaintenanceCapture', { ...prior, sequence, pending: prior.pending + 1 });
const originalIds = ctx.initialBookingIds || ctx.bookingIds;
const capturedIds = ids(originalIds);
const incomplete = (Array.isArray(originalIds) && capturedIds.length !== originalIds.length)
  || ['gameId', 'operationId', 'operationKey', 'step', 'exerciseId'].some(key => ctx[key] != null && scalar(ctx[key]) === null);

const event = {
  _id: `${POINT}:${PHASE}:${scalar(msg._msgid) || 'missing'}:${Date.now()}:${sequence}:${Math.random().toString(36).slice(2)}`,
  phase: PHASE,
  point: POINT,
  observedAt: new Date().toISOString(),
  gameId: scalar(ctx.gameId),
  operationId: scalar(ctx.operationId),
  operationKey: scalar(ctx.operationKey),
  step: scalar(ctx.step),
  bookingIds: capturedIds,
  originalBookingIdCount: Array.isArray(originalIds) ? originalIds.length : null,
  evidenceIncomplete: incomplete,
  exerciseId: scalar(ctx.exerciseId),
  providerStatus: Number.isInteger(status) && status >= 100 && status <= 599 ? status : null,
  errorObserved: Boolean(msg.error),
  // Capturing a response is not evidence that cancellation or local persistence succeeded.
  state: 'RECONCILIATION_REQUIRED',
};
msg.payload = [event];
delete msg.query;
return msg;
