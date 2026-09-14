const claim = msg._paymentPollingClaim, original = msg._paymentPollingRecord;
const saved = msg.payload;
const unproven = () => {
  // Never redispatch after an ambiguous write, including a Mongo catch message.
  if (msg._summerSubscriptionCtx?.reconcile === true) return null;
  msg.statusCode = msg.error ? 503 : 409;
  msg.headers = { 'Content-Type': 'application/json; charset=utf-8' };
  msg.payload = { error: 'Payment check unavailable; retry the saved payment', code: 'PAYMENT_POLL_CLAIM_UNPROVEN' };
  return [null, msg];
};
if (msg.error || !claim || !original || !saved || saved._id == null) return unproven();
const meta = claim.history ? saved.history?.entries?.find(e => e.transactionId === claim.transactionId)?.paymentPolling : saved.paymentPolling;
if (JSON.stringify(meta) !== JSON.stringify(claim.value)) return unproven();
if (claim.history) original.pollingRow.paymentPolling = meta;
else msg._paymentPollingRecord = saved;
if (!claim.dispatch) {
  if (msg._summerSubscriptionCtx?.reconcile === true) return null;
  msg._paymentPollingStopped = true;
}
msg._paymentPollingAdmitted = true;
msg.payload = [msg._paymentPollingRecord];
delete msg._paymentPollingClaim;
delete msg._paymentPollingRecord;
return [msg, null];
