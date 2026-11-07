// Candidate-only wrapper: preserve the pinned normalizer, suppress its early success ACK.
const result = (function () {
/* __PINNED_MAX_NORMALIZER__ */
}).call(this);
const incoming = Array.isArray(result) ? result[0] : null;
if (!incoming?.maxUpdate) {
  const status = Number(result?.[1]?.statusCode);
  return [null, msg.req ? { req: msg.req, res: msg.res,
    statusCode: status >= 400 && status <= 599 ? status : 400,
    headers: { 'Content-Type': 'application/json' },
    payload: { ok: false, code: 'MAX_HOLD_INPUT_REFUSED' } } : null];
}
return [{ maxUpdate: incoming.maxUpdate, req: msg.req, res: msg.res }, null];
