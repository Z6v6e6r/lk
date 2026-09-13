const ctx = msg._splitLeaveCtx;
const binding = ctx?.discoveredBooking;
if (!ctx || ctx.mode !== "STAFF_TARGET" || ctx.vivaTargetMode !== "DISCOVERY"
  || !ctx.bookingDiscovery?.snapshotUpdatedAt || !binding?.bookingId || !ctx.claimToken || !ctx.operationKey) {
  msg.statusCode = 409;
  msg.payload = { ok: false, state: "CONFLICT", message: "Discovery binding context missing" };
  return [null, msg];
}
// Persist the exact provider generation under the existing operation lease before
// any cancellation. A retry reads these IDs and never discovers a replacement.
msg.payload = [
  { _id: ctx.operationKey, state: "STARTED", claimToken: ctx.claimToken,
    vivaTargetMode: "DISCOVERY", bookingIds: [],
    "bookingDiscovery.snapshotUpdatedAt": ctx.bookingDiscovery.snapshotUpdatedAt },
  { $set: { vivaTargetMode: "BOOKINGS", bookingIds: [binding.bookingId],
    clientSubscriptionId: binding.clientSubscriptionId || null,
    subscriptionVisitCount: binding.subscriptionVisitCount || null,
    "bookingDiscovery.boundAt": new Date().toISOString() } },
  { upsert: false },
];
return [msg, null];
