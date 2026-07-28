const asObj = (value) => (value && typeof value === "object" && !Array.isArray(value) ? value : {});
const toStr = (value) => {
  if (value === null || value === undefined) return null;
  const text = String(value).trim();
  return text ? text : null;
};

const fail = (status, error, details) => {
  msg.statusCode = status;
  msg.headers = { "Content-Type": "application/json; charset=utf-8" };
  msg.payload = { error, details: details || null };
  return [null, msg, msg];
};

const body = asObj(msg.payload);
const query = asObj(msg.req && msg.req.query);

const compositeId = toStr(body.compositeId || body.id || query.compositeId || query.id);
const paymentRef = toStr(body.paymentRef || query.paymentRef);
const dedupeKey = toStr(body.dedupeKey || query.dedupeKey);

if (!compositeId && !paymentRef && !dedupeKey) {
  return fail(400, "compositeId, paymentRef or dedupeKey is required");
}

let queryFilter = null;
if (compositeId) {
  queryFilter = { id: compositeId };
} else if (paymentRef) {
  queryFilter = { "payment.paymentRef": paymentRef };
} else {
  queryFilter = { "compositeBooking.dedupeKey": dedupeKey };
}

msg.query = queryFilter;
msg._compositeConfirmCtx = {
  compositeId,
  paymentRef,
  dedupeKey,
  nowIso: new Date().toISOString(),
};

const debugMsg = Object.assign({}, msg, {
  payload: {
    action: "composite_confirm_query",
    query: queryFilter,
  },
});

return [msg, null, debugMsg];
