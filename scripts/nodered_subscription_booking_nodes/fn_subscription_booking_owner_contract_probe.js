// Read-only compatibility probe. Older options/router versions cannot satisfy
// this handshake; the LK2 receiver must stop before a booking with mixed versions.
if (msg._subscriptionBooking?.step === "booked_operation_contract_probe") {
  const ownerProbeVersion = msg.req?.headers?.["x-booked-operation-owner-contract"];
  const ownerProbeAccepted = msg.req?.method === "GET" && ["1", "2"].includes(ownerProbeVersion);
  msg.statusCode = ownerProbeAccepted ? 200 : 404;
  msg.headers = { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" };
  msg.payload = ownerProbeAccepted
    ? (ownerProbeVersion === "2"
      ? { contractVersion: 2, owner: "LK1_SUBSCRIPTION_BOOKING_OWNER", policy: "MANAGED_JOIN_V2" }
      : { contractVersion: 1, owner: "LK1_SUBSCRIPTION_BOOKING_OWNER", policy: "ATOMIC_MANAGED_V1" })
    : { code: "BOOKED_OPERATION_OWNER_PROBE_NOT_FOUND" };
  delete msg._subscriptionBooking;
  return [null, null, null, null, msg, null, null];
}
