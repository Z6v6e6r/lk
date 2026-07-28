const toStr = (value) => {
  if (value === null || value === undefined) return null;
  const text = String(value).trim();
  return text ? text : null;
};

const normalizePhone = (value) => {
  const digits = String(value || "").replace(/\D/g, "");
  if (!digits) return null;
  if (digits.length === 10) return `7${digits}`;
  if (digits.length === 11 && digits.startsWith("8")) return `7${digits.slice(1)}`;
  return digits.length >= 11 ? digits : null;
};

const normalizePlanKey = (value) => {
  const normalized = String(value || "").trim().toLowerCase();
  if (normalized === "academy" || normalized === "friendship" || normalized === "ra" || normalized === "sport") {
    return normalized;
  }
  return null;
};

const normalizeFlowType = (value) => {
  const normalized = String(value || "").trim().toLowerCase();
  if (normalized === "renewal") return "renewal";
  return "share";
};

const fail = (status, error, details) => {
  msg.statusCode = status;
  msg.headers = { "Content-Type": "application/json; charset=utf-8" };
  msg.payload = { error, details: details || null };
  return [null, msg, msg];
};

const body = msg.payload && typeof msg.payload === "object" ? msg.payload : {};
const query = msg.req && msg.req.query && typeof msg.req.query === "object" ? msg.req.query : {};
const paymentRef = toStr(body.paymentRef || body.ref || query.paymentRef || query.ref || query.referralPaymentRef);
const inviteId = toStr(body.inviteId || body.referralInviteId || query.inviteId || query.referralInviteId);
const ownerPhone = normalizePhone(body.ownerPhone || body.phone || query.ownerPhone || query.phone || query.owner);
const ownerSubscriptionId = toStr(
  body.ownerSubscriptionId
  || body.subscriptionId
  || query.ownerSubscriptionId
  || query.subscriptionId
  || query.subId,
);
const planKey = normalizePlanKey(body.planKey || body.planType || query.planKey || query.planType);
const flowType = normalizeFlowType(body.mode || body.flowType || query.mode || query.flowType || query.type);

if (!paymentRef || (!inviteId && (!ownerPhone || !ownerSubscriptionId))) {
  return fail(400, "paymentRef and inviteId or ownerPhone/ownerSubscriptionId are required");
}

msg._referralSubscriptionCtx = {
  action: "confirm",
  step: "resolve_record",
  paymentRef,
  inviteId,
  ownerPhone,
  ownerSubscriptionId,
  planKey,
  flowType,
};

const dbQuery = inviteId
  ? { inviteId, paymentRef }
  : { ownerPhone, ownerSubscriptionId, paymentRef };
if (planKey) {
  dbQuery.planKey = planKey;
}

const dbMsg = Object.assign({}, msg, {
  query: dbQuery,
  payload: dbQuery,
});
const debugMsg = Object.assign({}, msg, {
  payload: {
    action: "confirm_prepare",
    inviteId,
    ownerPhone,
    ownerSubscriptionId,
    paymentRef,
    planKey,
    flowType,
  },
});

return [dbMsg, null, debugMsg];
