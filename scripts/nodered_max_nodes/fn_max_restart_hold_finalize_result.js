const proof = msg._maxRestartHoldFinal, result = msg.payload;
const verified = !msg.error && proof && result?.acknowledged === true
  && result.matchedCount === 1 && result.modifiedCount === 1
  && result.upsertedCount === 0 && result.upsertedId == null;
// Status-only output. No update body, headers, request/response or provider error is emitted.
return { payload: { code: verified ? 'MAX_HOLD_TERMINAL_RECORDED' : 'MAX_HOLD_TERMINAL_UNCONFIRMED',
  state: verified ? proof.state : 'UNKNOWN', durableCupCompletion: false } };
