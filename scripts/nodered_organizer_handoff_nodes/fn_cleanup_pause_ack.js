const summary = msg._organizerCleanupPausedSummary;
if (!summary) return null;
if (msg.error || msg.payload?.acknowledged !== true || msg.payload?.matchedCount !== 1) {
  summary.blockReason = "cancellation_fence_reconciliation_required";
}
msg.payload = summary;
return msg;
