const c = msg._splitLeaveCtx;
if (!c) return null;
const rows = Array.isArray(msg.payload) ? msg.payload : [];
if (!msg.error && rows.length === 1) {
  const op = rows[0], count = op.lk1?.decision?.subscriptionVisitCount;
  if (op.actorClientId === c.targetClientId && op.exerciseId === c.exerciseId
    && op.bookingId === c.initialBookingIds?.[0]
    && Number.isSafeInteger(count) && count > 0 && op.clientSubscriptionId
    && !op.lk1?.visitJob) {
    c.subscriptionVisitCount = count; c.clientSubscriptionId = op.clientSubscriptionId;
  }
}
delete msg.error; msg.payload = undefined;
return msg;
