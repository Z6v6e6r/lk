// Catch handler for booked-operation I/O and function faults.
//
// A failed or ambiguous owner store is a 503 uncertainty, never a fabricated
// PENDING/CONFIRMED outcome. The raw error is not returned to the caller.

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
return [msg];
