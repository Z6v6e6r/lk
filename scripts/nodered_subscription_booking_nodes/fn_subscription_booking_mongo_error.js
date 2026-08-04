const ctx = msg._subscriptionBooking && typeof msg._subscriptionBooking === "object"
  ? msg._subscriptionBooking
  : {};
const afterUpstream = [
  "operation_accept",
  "operation_confirm",
].includes(String(ctx.step || ""));

msg.statusCode = afterUpstream ? 202 : 503;
msg.headers = {
  "Content-Type": "application/json; charset=utf-8",
  "Cache-Control": "no-store",
  "Access-Control-Allow-Origin": "*",
};
msg.payload = afterUpstream
  ? {
      ok: true,
      state: "PENDING_CONFIRMATION",
      operationId: ctx.operationId || null,
      message: "Viva приняла запрос; подтверждение записи ещё выполняется",
    }
  : {
      error: "Не удалось атомарно зарезервировать дневной лимит",
      details: {
        code: "SUBSCRIPTION_BOOKING_PERSISTENCE_UNAVAILABLE",
      },
    };
delete msg.error;
return msg;
