// A version probe is answered by the SAME canonical router that owns policy and
// booking. Normal browser CORS retains its original 204 response on output 0.
if (msg.req?.headers?.["x-booked-operation-owner-contract"] === "1") {
  msg._subscriptionBooking = { step: "booked_operation_contract_probe" };
  return [null, msg];
}
msg.statusCode = 204;
msg.headers = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Access-Control-Allow-Headers": "Authorization, Content-Type",
  "Access-Control-Max-Age": "600",
  "Cache-Control": "no-store",
};
msg.payload = "";
return [msg, null];
