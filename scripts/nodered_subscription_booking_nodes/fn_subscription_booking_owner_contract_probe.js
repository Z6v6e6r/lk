// Read-only compatibility probe. Older options/router versions cannot satisfy
// this handshake; the LK2 receiver must stop before a booking with mixed versions.
if (msg._subscriptionBooking?.step === "booked_operation_contract_probe"
  && msg.req?.method === "OPTIONS"
  && msg.req?.headers?.["x-booked-operation-owner-contract"] === "1") {
  msg.statusCode = 200;
  msg.headers = { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" };
  msg.payload = { contractVersion: 1, owner: "LK1_SUBSCRIPTION_BOOKING_OWNER", policy: "ATOMIC_MANAGED_V1" };
  delete msg._subscriptionBooking;
  return [null, null, null, null, msg, null, null];
}
