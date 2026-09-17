// BEGIN generated subscriptionPaymentPolling
function createSubscriptionPaymentPolling() {
  const lifetimeMs = 20 * 60_000, maxChecks = 10, intervalMs = 120_000, recoveryMs = 3_600_000,
    maxRecoveryChecks = 24;
  const timestamp = value => typeof value === 'string' && /(?:Z|[+-]\d\d:\d\d)$/.test(value)
    && Number.isFinite(Date.parse(value)) ? Date.parse(value) : null;
  const pending = row => ['PAYMENT_PENDING', 'PROVIDER_UNKNOWN', 'UNPAID'].includes(row?.status);
  const state = (row, now = Date.now()) => {
    const saved = row?.paymentPolling || {};
    const created = timestamp(row?.createdAt);
    const checks = Number.isSafeInteger(saved.checks) && saved.checks >= 0 ? saved.checks : 0;
    const invalid = created === null || created > now || (saved.checks != null && saved.checks !== checks);
    const reason = saved.reason || (invalid ? 'INVALID_CREATED_AT' : now >= created + lifetimeMs
      ? 'PAYMENT_LINK_EXPIRED' : checks >= maxChecks ? 'PAYMENT_CHECK_LIMIT' : null);
    return { checks, reason, closed: saved.status === 'FAILED' || !!reason,
      deadlineAt: created === null ? null : new Date(created + lifetimeMs).toISOString() };
  };
  const response = (body, row, now = Date.now()) => {
    // Explicitly verified paid/binding outcomes always win over a local timeout.
    if (!pending(row) || ['PAID', 'PAID_PENDING_INSTANCE_BINDING'].includes(body?.status) || body?.paid === true) return body;
    const local = state(row, now);
    if (!local.closed) return body;
    // Do not propagate cached nested responses containing a checkout URL.
    return { ok: true, paymentRef: row.paymentRef || body?.paymentRef || null,
      transactionId: row.transactionId || body?.transactionId || null,
      counterKey: row.counterKey || body?.counterKey || null,
      status: 'FAILED', paid: false, failed: true, archived: true,
      paymentUrl: null, reason: local.reason || 'PAYMENT_LINK_ARCHIVED',
      paymentDeadlineAt: local.deadlineAt };
  };
  const plan = (row, { now = Date.now(), recovery = false } = {}) => {
    const saved = row.paymentPolling || {}, local = state(row, now);
    const nowIso = new Date(now).toISOString();
    const isLink = pending(row) && !!row.transactionId;
    // An explicit local archive also survives a missing provider transaction.
    // Recovery may still find the transaction; it must not reopen checkout.
    const closed = pending(row) && (isLink && local.closed || saved.status === 'FAILED');
    const due = timestamp(saved.nextCheckAt);
    const recoveryChecks = Number.isSafeInteger(saved.recoveryChecks) ? saved.recoveryChecks : 0;
    // Recovery is bounded. A locally archived checkout used to be re-read from the
    // provider every hour forever: on 2026-09-17 that kept 1 644 sale documents per hour
    // in a re-check loop (2 495 PAYMENT_PENDING, 2 304 past their deadline, one row at 60
    // recovery checks) without ever turning one of them paid. After maxRecoveryChecks
    // attempts the polling closes for good; the sale itself keeps its PAYMENT_PENDING
    // status, its archive record and its deadline, so the financial state is untouched and
    // the periodic provider reconciliation (`subscriptions:reconcile-viva`) stays the way
    // to settle a late payment of this class.
    if (closed && saved.recoveryClosedAt) return { dispatch: false, value: null };
    // Archive is a local write even when a previous request has a cooldown.
    if (closed && saved.status !== 'FAILED') return { dispatch: false, value: {
      ...saved, checks: local.checks, status: 'FAILED', reason: local.reason,
      deadlineAt: local.deadlineAt, archivedAt: nowIso,
      nextCheckAt: new Date(now + recoveryMs).toISOString(),
    } };
    if (due !== null && due > now) return { dispatch: false, value: null };
    if (closed && !recovery) return { dispatch: false, value: null };
    if (closed && recoveryChecks >= maxRecoveryChecks) return { dispatch: false, value: {
      ...saved, checks: local.checks, recoveryChecks, recoveryClosedAt: nowIso,
      recoveryClosedReason: 'RECOVERY_CHECK_LIMIT', nextCheckAt: null,
    } };
    const checks = isLink && !closed ? local.checks + 1 : local.checks;
    const exhausted = isLink && checks >= maxChecks;
    const value = { ...saved, checks, status: closed || exhausted ? 'FAILED' : 'ACTIVE',
      lastAttemptAt: nowIso, nextCheckAt: new Date(now + (closed || exhausted || row.status === 'PAID' || row.status === 'REFUNDED' ? recoveryMs : intervalMs)).toISOString() };
    if (isLink) value.deadlineAt = local.deadlineAt;
    if (exhausted && !closed) Object.assign(value, { archivedAt: nowIso, reason: 'PAYMENT_CHECK_LIMIT' });
    if (closed || !isLink) value.recoveryChecks = recoveryChecks + 1;
    return { dispatch: true, value };
  };
  return { lifetimeMs, maxChecks, intervalMs, recoveryMs, maxRecoveryChecks, timestamp, pending, state, response, plan };
}
const paymentPolling = createSubscriptionPaymentPolling();
// END generated subscriptionPaymentPolling
const record = msg._paymentPollingRecord;
const ctx = msg._summerSubscriptionCtx;
if (!record || !ctx) return null;
const isHistory = record.documentType === 'ANNUAL_HISTORY_RECONCILIATION_JOB_V1';
const isLedger = record.schemaVersion === 3 && record.history?.version === 1;
// Paid confirmations need no checkout poll; repair/binding/projection work still
// claims a durable cooldown so permanently failing recoveries cannot starve sales.
if (!isHistory && !isLedger && ['PAID', 'FAILED', 'REFUNDED'].includes(record.status)) {
  msg._paymentPollingAdmitted = true;
  msg.payload = [record];
  delete msg._paymentPollingRecord;
  return [null, msg];
}
const row = isHistory ? record.pollingRow : isLedger ? { ...record, status: 'PROJECTION_RECOVERY' } : record;
if (!row || record._id == null || (isHistory && !record.transactionId)) {
  if (ctx.reconcile === true) return null;
  msg.statusCode = 503;
  msg.payload = { error: 'Saved payment requires reconciliation', code: 'PAYMENT_POLL_IDENTITY_MISSING' };
  return [null, null, msg];
}
const decision = paymentPolling.plan(row, { recovery: ctx.reconcile === true });
const stopped = () => {
  if (ctx.reconcile === true) return null;
  msg._paymentPollingStopped = true;
  msg._paymentPollingAdmitted = true;
  msg.payload = [record];
  delete msg._paymentPollingRecord;
  return [null, msg];
};
if (!decision.value) return stopped();
const filter = { _id: record._id };
let field = 'paymentPolling';
if (isHistory) {
  filter['history.entries'] = { $elemMatch: { transactionId: record.transactionId,
    paymentPolling: row.paymentPolling === undefined ? { $exists: false } : row.paymentPolling,
    fact: record.pollingFact } };
  field = 'history.entries.$.paymentPolling';
} else {
  if (isLedger) { filter.schemaVersion = 3; filter.revision = record.revision; }
  else {
    filter.status = record.status;
    if (record.transactionId !== undefined) filter.transactionId = record.transactionId;
  }
  filter.paymentPolling = record.paymentPolling === undefined ? { $exists: false } : record.paymentPolling;
}
msg._paymentPollingClaim = { dispatch: decision.dispatch, history: isHistory,
  transactionId: record.transactionId, value: decision.value };
// Acknowledged, no-upsert CAS: a lost race or failed write never sends a provider request.
msg.payload = [filter, { $set: { [field]: decision.value } },
  { upsert: false, returnDocument: 'after', includeResultMetadata: false }];
return [msg, null];
