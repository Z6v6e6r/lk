// Node-RED 4.0.9 HTTP In does not register OPTIONS handlers. The inert GET
// capability route reaches the SAME canonical router; ordinary CORS stays 204.
if (msg.req?.method === "GET") {
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
