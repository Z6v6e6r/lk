// Catch handler for booked-operation I/O and function faults.
//
// A failed or ambiguous owner store is a 503 uncertainty, never a fabricated
// PENDING/CONFIRMED outcome. The raw error is not returned to the caller and no
// credential header survives into the response.

msg.statusCode = 503;
msg.headers = {
  "Content-Type": "application/json; charset=utf-8",
  "Cache-Control": "no-store",
};
msg.payload = {
  error: "BOOKED_OPERATION_STORE_UNAVAILABLE",
  code: "BOOKED_OPERATION_STORE_UNAVAILABLE",
};
delete msg._bookedOperation;
delete msg.error;
if (msg.req && typeof msg.req === "object" && msg.req.headers && typeof msg.req.headers === "object") {
  delete msg.req.headers["x-subscription-actor-delegation"];
  delete msg.req.headers["X-Subscription-Actor-Delegation"];
  delete msg.req.headers["x-subscription-actor-token"];
  delete msg.req.headers["X-Subscription-Actor-Token"];
}
return [msg];
