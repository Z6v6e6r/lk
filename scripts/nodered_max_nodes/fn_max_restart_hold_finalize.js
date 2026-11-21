const hold = /* __MAX_HOLD_CONFIG__ */;
const claim = msg._maxRestartHold;
if (!claim || claim.windowId !== hold.windowId || claim.connector !== hold.connector
  || typeof claim.receiptId !== 'string' || typeof claim.claimToken !== 'string') return null;
let state = 'UNKNOWN', reason = 'HTTP_OUTCOME_UNCONFIRMED';
const validBody = msg.payload && typeof msg.payload === 'object' && !Array.isArray(msg.payload);
if (!msg.error && !msg._maxRestartHoldOutcome && Number.isInteger(msg.statusCode) && validBody) {
  if (msg.statusCode >= 200 && msg.statusCode < 300 && msg.payload.ok === true) {
    state = 'DELIVERED'; reason = 'HTTP_ACCEPTED_ONLY';
  } else if ([400, 401, 403, 404, 405, 410, 413, 415, 422].includes(msg.statusCode)) {
    state = 'REFUSED'; reason = 'HTTP_DEFINITIVE_REFUSAL';
  }
} else if (msg._maxRestartHoldReason === 'LOOKUP_UNCONFIRMED') reason = 'LOOKUP_UNCONFIRMED';
return { _maxRestartHoldFinal: { receiptId: claim.receiptId, state },
  payload: [{ _id: claim.receiptId, windowId: hold.windowId, connector: hold.connector,
    state: 'DELIVERING', attempts: 1, claimToken: claim.claimToken },
    { $set: { state, completedAt: new Date().toISOString(), result: reason } },
    { upsert: false, writeConcern: { w: 'majority', j: true, wtimeoutMS: 5000 } }] };
