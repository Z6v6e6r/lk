const toStr = (value) => {
  if (value === null || value === undefined) return null;
  const normalized = String(value).trim();
  return normalized || null;
};
const asArray = (value) => (Array.isArray(value) ? value : []);
const response = (ctx, ok, code = null, error = null) => {
  const basePayload = ctx?.summaryPayload && typeof ctx.summaryPayload === "object"
    ? ctx.summaryPayload
    : {};
  const payload = ok
    ? { ...basePayload, ok: true, cancelledInLk: true, blockLocalMutation: false }
    : {
        ...basePayload,
        ok: false,
        cancelledInLk: false,
        blockLocalMutation: true,
        blockReason: code || "mongo_write_unconfirmed",
        error,
      };
  const out = Object.assign({}, msg, {
    statusCode: ok ? 200 : (code === "SPLIT_CLEANUP_CAS_MISS" ? 409 : 503),
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      "Access-Control-Allow-Origin": "*",
      "Cache-Control": "no-store",
    },
    payload,
  });
  delete out._splitCleanupWriteAck;
  return [null, out, out];
};
const recover = (ctx, code, error) => {
  msg._splitCleanupPaymentReadbackFailure = { code, error };
  return [null, null, null, msg];
};

const ctx = msg._splitCleanupWriteAck && typeof msg._splitCleanupWriteAck === "object"
  ? msg._splitCleanupWriteAck
  : null;
if (!ctx?.gameId || !ctx?.tenantKey || !Number.isSafeInteger(ctx?.expectedNextRevision)) {
  return recover(ctx, "SPLIT_CLEANUP_ACK_CONTEXT_MISSING", "Cleanup write acknowledgement context is missing");
}

const nextPaymentHead = () => {
  const proposal = ctx.paymentAttemptHeadClosures?.[ctx.paymentHeadIndex || 0];
  if (!proposal) return response(ctx, true);
  if (!proposal.receiptKey || !proposal.headKey) return recover(ctx, 'PAYMENT_HEAD_PROOF_MISSING', 'Payment closure proof is missing');
  ctx.step = 'payment_head_receipt_read'; msg._splitCleanupWriteAck = ctx;
  delete msg.error; msg.payload = { _id: proposal.receiptKey }; msg.limit = 2;
  return [null, null, null, null, msg, null];
};
if (ctx.step === 'payment_head_receipt_read') {
  const rows = asArray(msg.payload), proposal = ctx.paymentAttemptHeadClosures?.[ctx.paymentHeadIndex || 0];
  const contract = typeof __splitBookingPaymentAttempt === 'object' ? __splitBookingPaymentAttempt : null;
  const command = !msg.error && rows.length === 1
    ? contract?.splitAttemptHeadClosure(proposal, ctx.paymentHeadCanonicalRecord, rows[0]) : null;
  if (!command) return recover(ctx, 'PAYMENT_HEAD_PROOF_UNVERIFIED', 'Payment closure proof could not be verified');
  ctx.step = 'payment_head_write_ack'; msg._splitCleanupWriteAck = ctx;
  msg.payload = command; delete msg.error;
  return [null, null, null, null, null, msg];
}
if (ctx.step === 'payment_head_write_ack') {
  // A lost update ACK and an already-closed head are both resolved by a read.
  const proposal = ctx.paymentAttemptHeadClosures[ctx.paymentHeadIndex || 0];
  ctx.step = 'payment_head_verify'; msg._splitCleanupWriteAck = ctx;
  delete msg.error; msg.payload = { _id: proposal.headKey }; msg.limit = 2;
  return [null, null, null, null, msg, null];
}
if (ctx.step === 'payment_head_verify') {
  const rows = asArray(msg.payload), head = rows.length === 1 ? rows[0] : null;
  const proposal = ctx.paymentAttemptHeadClosures[ctx.paymentHeadIndex || 0];
  if (msg.error || head?._id !== proposal.headKey || head.phase !== 'CLOSED'
    || head.actorClientId !== proposal.clientId || head.closure?.receiptKey !== proposal.receiptKey
    || head.closure.bookingId !== proposal.bookingId || head.closure.transactionId !== proposal.transactionId) {
    return recover(ctx, 'PAYMENT_HEAD_CLOSURE_UNVERIFIED', 'Payment closure readback failed');
  }
  ctx.paymentHeadIndex = (ctx.paymentHeadIndex || 0) + 1;
  return nextPaymentHead();
}

if (ctx.step === "write_ack") {
  const acknowledged = msg.payload?.acknowledged === true;
  const matchedCount = Number(msg.payload?.matchedCount);
  if (!acknowledged || matchedCount !== 1) {
    return recover(
      ctx,
      acknowledged ? "SPLIT_CLEANUP_CAS_MISS" : "SPLIT_CLEANUP_WRITE_ACK_INVALID",
      acknowledged ? "Cleanup state changed before persistence" : "Mongo did not acknowledge cleanup persistence",
    );
  }
  ctx.step = "readback";
  msg._splitCleanupWriteAck = ctx;
  msg.payload = { tenantKey: ctx.tenantKey, id: ctx.gameId, revision: ctx.expectedNextRevision };
  msg.limit = 2;
  msg.sort = { updatedAt: -1, _id: -1 };
  return [msg, null, null];
}

if (ctx.step !== "readback") {
  return recover(ctx, "SPLIT_CLEANUP_ACK_STEP_INVALID", "Unsupported cleanup acknowledgement step");
}
const records = asArray(msg.payload).filter((item) => item && typeof item === "object");
if (records.length !== 1) {
  return recover(ctx, "SPLIT_CLEANUP_READBACK_FAILED", "Cleanup readback is missing or ambiguous");
}
const record = records[0];
const exact = (
  toStr(record.id) === toStr(ctx.gameId)
  && toStr(record.tenantKey) === toStr(ctx.tenantKey)
  && Number(record.revision) === Number(ctx.expectedNextRevision)
  && toStr(record.updatedAt) === toStr(ctx.expectedUpdatedAt)
  && (!ctx.expectedStatus || toStr(record.status) === toStr(ctx.expectedStatus))
  && (ctx.expectedPaid === null || record?.payment?.paid === ctx.expectedPaid)
);
if (!exact) {
  return recover(ctx, "SPLIT_CLEANUP_READBACK_MISMATCH", "Cleanup state was not durably applied");
}
ctx.paymentHeadCanonicalRecord = record;
ctx.paymentHeadIndex = 0;
return nextPaymentHead();
