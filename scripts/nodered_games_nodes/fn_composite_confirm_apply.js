const AUDIT_MAX_EVENTS = 100;

const toStr = (value) => {
  if (value === null || value === undefined) return null;
  const text = String(value).trim();
  return text ? text : null;
};
const asObj = (value) => (value && typeof value === "object" && !Array.isArray(value) ? value : {});

const fail = (status, error, details) => {
  msg.statusCode = status;
  msg.headers = { "Content-Type": "application/json; charset=utf-8" };
  msg.payload = { error, details: details || null };
  return [null, msg, msg];
};

const buildAuditEvent = (nowIso, type, payload) => ({
  id: `composite_audit_${Date.now()}_${Math.random().toString(36).slice(2, 10)}`,
  at: nowIso,
  type,
  source: "composite_games",
  payload,
});

const rows = Array.isArray(msg.payload) ? msg.payload : [];
const ctx = asObj(msg._compositeConfirmCtx);
if (!ctx.compositeId && rows.length > 1) {
  return fail(409, "Composite confirmation query matched multiple records", {
    paymentRef: ctx.paymentRef || null,
    dedupeKey: ctx.dedupeKey || null,
    matchedCount: rows.length,
  });
}
const record = rows.find((item) => item && typeof item === "object") || null;

if (!record) {
  return fail(404, "Composite booking not found", {
    compositeId: ctx.compositeId || null,
    paymentRef: ctx.paymentRef || null,
    dedupeKey: ctx.dedupeKey || null,
  });
}

const nowIso = toStr(ctx.nowIso) || new Date().toISOString();
const currentStatus = String(record.status || "").trim().toUpperCase();
const compositeBooking = asObj(record.compositeBooking);
const payment = asObj(record.payment);

if (currentStatus === "NOT_READY_FOR_PAYMENT") {
  const responseMsg = Object.assign({}, msg, {
    statusCode: 200,
    headers: { "Content-Type": "application/json; charset=utf-8" },
    payload: record,
  });
  return [null, responseMsg, responseMsg];
}

const auditEvent = buildAuditEvent(nowIso, "COMPOSITE_CONFIRMED", {
  compositeId: toStr(record.id),
  paymentRef: toStr(payment.paymentRef),
  dedupeKey: toStr(compositeBooking.dedupeKey),
});

const updatedRecord = Object.assign({}, record, {
  status: "NOT_READY_FOR_PAYMENT",
  paymentStatus: "NOT_READY_FOR_PAYMENT",
  compositeBooking: Object.assign({}, compositeBooking, {
    status: "NOT_READY_FOR_PAYMENT",
    paymentStatus: "NOT_READY_FOR_PAYMENT",
    readyForPayment: false,
    confirmedAt: nowIso,
    notReadyReason: "composite_payment_flow_not_implemented",
  }),
  payment: Object.assign({}, payment, {
    status: "NOT_READY_FOR_PAYMENT",
    ready: false,
  }),
  updatedAt: nowIso,
});

const dbMsg = Object.assign({}, msg, {
  query: { id: record.id },
  payload: {
    $set: {
      status: updatedRecord.status,
      paymentStatus: updatedRecord.paymentStatus,
      compositeBooking: updatedRecord.compositeBooking,
      payment: updatedRecord.payment,
      updatedAt: updatedRecord.updatedAt,
      "audit.version": 1,
      "audit.updatedAt": nowIso,
      "audit.lastEvent": auditEvent,
    },
    $push: {
      "audit.events": {
        $each: [auditEvent],
        $slice: -AUDIT_MAX_EVENTS,
      },
    },
  },
});

const responseMsg = Object.assign({}, msg, {
  statusCode: 200,
  headers: { "Content-Type": "application/json; charset=utf-8" },
  payload: updatedRecord,
});

const debugMsg = Object.assign({}, msg, {
  payload: {
    compositeId: toStr(record.id),
    status: updatedRecord.status,
    paymentStatus: updatedRecord.paymentStatus,
  },
});

return [dbMsg, responseMsg, debugMsg];
