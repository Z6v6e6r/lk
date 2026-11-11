const result = msg.payload, saved = msg._maxRestartHold;
const inserted = result?.acknowledged === true && result.matchedCount === 0 && result.modifiedCount === 0
  && result.upsertedCount === 1 && result.upsertedId === saved?.receiptId;
const duplicate = result?.acknowledged === true && result.matchedCount === 1 && result.modifiedCount === 0
  && result.upsertedCount === 0 && (result.upsertedId == null);
const accepted = !msg.error && saved && (inserted || duplicate);
if (!msg.req) return null;
return { req: msg.req, res: msg.res, statusCode: accepted ? 200 : 503,
  headers: { 'Content-Type': 'application/json' }, payload: accepted
    ? { ok: true, accepted: true, custody: 'HELD_FOR_CUP_RESTART' }
    : { ok: false, code: 'MAX_HOLD_PERSISTENCE_UNCONFIRMED' } };
