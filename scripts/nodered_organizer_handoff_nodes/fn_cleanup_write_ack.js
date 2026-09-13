const summary = msg._organizerCleanupSummary;
if (!summary) return null;
if (msg.error || msg.payload?.acknowledged !== true || msg.payload.matchedCount !== 1) {
  summary.payload = { ...summary.payload, cancelledInLk: false, withVivaErrors: true,
    blockLocalMutation: true, blockReason: "mongo_confirmation_required" };
}
return summary;
