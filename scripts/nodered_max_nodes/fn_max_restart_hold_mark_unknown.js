const hold = /* __MAX_HOLD_CONFIG__ */;
const input = msg.payload;
if (!input || input.windowId !== hold.windowId || input.connector !== hold.connector
  || input.confirmation !== 'MARK_EXACT_INTERRUPTED_CLAIM_UNKNOWN_NO_REPLAY'
  || typeof input.receiptId !== 'string' || !/^(?:[0-9a-f]{64}|[0-9a-f-]{36})$/.test(input.receiptId)
  || typeof input.claimToken !== 'string' || !/^[0-9a-f-]{36}$/.test(input.claimToken)) return null;
return { _maxRestartHoldFinal: { receiptId: input.receiptId, state: 'UNKNOWN' },
  payload: [{ _id: input.receiptId, windowId: hold.windowId, connector: hold.connector,
    state: 'DELIVERING', attempts: 1, claimToken: input.claimToken },
    { $set: { state: 'UNKNOWN', completedAt: new Date().toISOString(), result: 'MANUAL_INTERRUPTED_CLAIM_NO_REPLAY' } },
    { upsert: false, writeConcern: { w: 'majority', j: true, wtimeoutMS: 5000 } }] };
