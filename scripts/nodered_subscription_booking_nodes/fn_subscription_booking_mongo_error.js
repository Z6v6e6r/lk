// Diagnostic observer: optional, no-throw; sourceHash is the uninstrumented business preimage.
const lkDiagnostic = (fields = {}) => {
  try {
    if (typeof global === "undefined" || typeof global.get !== "function") return;
    global.get("lkDiagnostics")?.observe(msg, "booking_error", { sourceHash: "1c786def280a91c684dae8a71d56ac903ad1912f059145aa85d1dab0944f3a56", ...fields });
  } catch { /* Observability cannot alter business execution. */ }
};
lkDiagnostic({ code: "STAGE_ENTER" });
const ctx = msg._subscriptionBooking && typeof msg._subscriptionBooking === "object"
  ? msg._subscriptionBooking
  : {};
const afterUpstream = ctx.precreatedEntitlementReserved === true || [
  "operation_precreated_attempt",
  "operation_precreated_promote",
  "operation_precreated_reconciliation",
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
      message: "Исход операции требует сверки; автоматический повтор заблокирован",
      details: {
        code: "SUBSCRIPTION_BOOKING_PERSISTENCE_RECONCILIATION_REQUIRED",
        localBindingConfirmed: false,
      },
    }
  : {
      error: "Не удалось атомарно зарезервировать дневной лимит",
      details: {
        code: "SUBSCRIPTION_BOOKING_PERSISTENCE_UNAVAILABLE",
      },
    };
delete msg.error;
return msg;
