// Final HTTP response guard for the booked-operation receiver.
//
// It drops the internal operation context and any delegation header, enforces
// no-store JSON, and turns a server-side fault into a stable fail-closed 503
// instead of an empty or optimistic response.

const isObject = (value) => Boolean(value)
  && typeof value === "object"
  && !Array.isArray(value);

delete msg._bookedOperation;
delete msg._bookedOperationPreflight;
if (isObject(msg.req) && isObject(msg.req.headers)) {
  delete msg.req.headers["x-subscription-actor-delegation"];
  delete msg.req.headers["X-Subscription-Actor-Delegation"];
  delete msg.req.headers["x-subscription-actor-token"];
  delete msg.req.headers["X-Subscription-Actor-Token"];
}
// A failed provider transport keeps the request headers on the message; never
// echo an Authorization or actor-token header into the HTTP reply.
if (isObject(msg.headers)) {
  delete msg.headers.authorization;
  delete msg.headers.Authorization;
  delete msg.headers["x-subscription-actor-token"];
  delete msg.headers["X-Subscription-Actor-Token"];
}
if (!Number.isInteger(msg.statusCode) || msg.statusCode < 200 || msg.statusCode > 599) {
  msg.statusCode = 503;
  msg.payload = {
    error: "BOOKED_OPERATION_RESPONSE_INVALID",
    code: "BOOKED_OPERATION_RESPONSE_INVALID",
  };
}
if (!isObject(msg.payload)) {
  msg.statusCode = 503;
  msg.payload = {
    error: "BOOKED_OPERATION_RESPONSE_INVALID",
    code: "BOOKED_OPERATION_RESPONSE_INVALID",
  };
}
msg.headers = {
  ...(isObject(msg.headers) ? msg.headers : {}),
  "Content-Type": "application/json; charset=utf-8",
  "Cache-Control": "no-store",
};
delete msg.error;
return [msg];
