// Read-only compatibility probe. Older options/router versions cannot satisfy
// this handshake; the LK2 receiver must stop before a booking with mixed versions.
if (msg._subscriptionBooking?.step === "booked_operation_contract_probe") {
  if (msg.req?.headers?.["x-training-registration-owner-contract"] !== undefined) {
    const accepted = msg.req.method === "GET" && (msg.req.originalUrl || msg.req.url) === "/lk/subscription-bookings"
      && msg.req.headers["x-training-registration-owner-contract"] === "1"
      && msg.req.headers["x-booked-operation-owner-contract"] === undefined
      && (!msg.req.query || Object.keys(msg.req.query).length === 0)
      && typeof trainingOwnerRoute === "function" && typeof trainingOutput === "function"
      && msg._trainingRegistrationCapability?.version === 1 && msg._trainingRegistrationCapability.stage === "router";
    msg.statusCode = accepted ? 200 : 404;
    msg.headers = { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store", "Referrer-Policy": "no-referrer" };
    if (accepted) msg._trainingRegistrationCapability.stage = "finalize";
    msg.payload = accepted ? { code: "TRAINING_REGISTRATION_FINALIZER_REQUIRED" }
      : { code: "TRAINING_REGISTRATION_OWNER_UNAVAILABLE" };
    delete msg._subscriptionBooking;
    return [null, null, null, null, msg, null, null];
  }
  const ownerProbeVersion = msg.req?.headers?.["x-booked-operation-owner-contract"];
  const ownerProbeAccepted = msg.req?.method === "GET" && ["1", "2", "3"].includes(ownerProbeVersion);
  msg.statusCode = ownerProbeAccepted ? 200 : 404;
  msg.headers = { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" };
  msg.payload = ownerProbeAccepted
    ? (ownerProbeVersion === "3"
      ? { contractVersion: 3, owner: "LK1_SUBSCRIPTION_BOOKING_OWNER", policy: "MANAGED_SELF_LEAVE_V1" }
      : ownerProbeVersion === "2"
      ? { contractVersion: 2, owner: "LK1_SUBSCRIPTION_BOOKING_OWNER", policy: "MANAGED_JOIN_V2" }
      : { contractVersion: 1, owner: "LK1_SUBSCRIPTION_BOOKING_OWNER", policy: "ATOMIC_MANAGED_V1" })
    : { code: "BOOKED_OPERATION_OWNER_PROBE_NOT_FOUND" };
  delete msg._subscriptionBooking;
  return [null, null, null, null, msg, null, null];
}
