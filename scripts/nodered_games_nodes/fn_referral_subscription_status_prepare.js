const TOKEN_URL = "https://kc.vivacrm.ru/realms/prod/protocol/openid-connect/token";

const toStr = (value) => {
  if (value === null || value === undefined) return null;
  const text = String(value).trim();
  return text ? text : null;
};

const normalizeFlowType = (value) => {
  const normalized = String(value || "").trim().toLowerCase();
  if (normalized === "renewal") return "renewal";
  return "share";
};

const normalizePhone = (value) => {
  const digits = String(value || "").replace(/\D/g, "");
  if (!digits) return null;
  if (digits.length === 10) return `7${digits}`;
  if (digits.length === 11 && digits.startsWith("8")) return `7${digits.slice(1)}`;
  return digits.length >= 11 ? digits : null;
};

const fail = (status, error, details) => {
  msg.statusCode = status;
  msg.headers = { "Content-Type": "application/json; charset=utf-8" };
  msg.payload = { error, details: details || null };
  return [null, msg, msg, null];
};

const query = msg.req && msg.req.query && typeof msg.req.query === "object" ? msg.req.query : {};
const inviteId = toStr(query.inviteId || query.referralInviteId);
const ownerPhone = normalizePhone(query.ownerPhone || query.phone || query.owner);
const ownerSubscriptionId = toStr(query.ownerSubscriptionId || query.subscriptionId || query.subId);
const flowType = normalizeFlowType(query.mode || query.flowType || query.type);

if (!inviteId && (!ownerPhone || !ownerSubscriptionId)) {
  return fail(400, "inviteId or ownerPhone and ownerSubscriptionId are required");
}

if (inviteId) {
  msg._referralSubscriptionCtx = {
    action: "status",
    step: "resolve_invite",
    postOwnerStep: "status_query",
    inviteId,
    flowType,
  };

  const dbQuery = { inviteId };
  const dbMsg = Object.assign({}, msg, {
    query: dbQuery,
    payload: dbQuery,
  });
  const debugMsg = Object.assign({}, msg, {
    payload: {
      action: "status_prepare",
      inviteId,
      flowType,
    },
  });

  return [null, null, debugMsg, dbMsg];
}

msg._referralSubscriptionCtx = {
  action: "status",
  step: "token_owner",
  postOwnerStep: "status_query",
  ownerPhone,
  ownerSubscriptionId,
  flowType,
};

msg.method = "POST";
msg.url = TOKEN_URL;
msg.headers = { "Content-Type": "application/x-www-form-urlencoded" };
msg.payload =
  "grant_type=password&client_id=React-auth-dev&username=it@citysport.pro&password=mhF-ma6-4Ju-QsJ";

const debugMsg = Object.assign({}, msg, {
  payload: {
    action: "status_prepare",
    inviteId,
    ownerPhone,
    ownerSubscriptionId,
    flowType,
  },
});

return [msg, null, debugMsg, null];
