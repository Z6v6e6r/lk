const authHeader = String(msg.req?.headers?.authorization || msg.headers?.authorization || "").trim();
const guardId = String(msg.req?.params?.guardId || "").trim();
const action = String(msg.req?.params?.action || "").trim().toLowerCase();
const body = msg.payload && typeof msg.payload === "object" ? msg.payload : {};
const idempotencyKey = String(body.idempotencyKey || "").trim();

if (!authHeader.toLowerCase().startsWith("bearer ") || !guardId || !idempotencyKey || !["confirm", "release"].includes(action)) {
  msg.statusCode = !authHeader ? 401 : 400;
  msg.headers = { "content-type": "application/json; charset=utf-8", "access-control-allow-origin": "*", "cache-control": "no-store" };
  msg.payload = { ok: false, message: "Некорректное подтверждение операции" };
  return [null, msg];
}

const now = new Date();
const status = action === "confirm" ? "PAYMENT_PENDING" : "RELEASED";
msg.query = { guardId, idempotencyKey, status: { $in: ["LOCKED", "PAYMENT_PENDING"] } };
msg.payload = {
  $set: {
    status,
    transactionId: action === "confirm" ? String(body.transactionId || "").trim() || null : null,
    bookingId: action === "confirm" ? String(body.bookingId || "").trim() || null : null,
    paymentUrl: action === "confirm" ? String(body.paymentUrl || "").trim() || null : null,
    updatedAt: now,
    expiresAt: action === "confirm" ? new Date(now.getTime() + 30 * 60 * 1000) : now,
  },
};
msg.padelDay = { guardId, action };
return [msg, null];
