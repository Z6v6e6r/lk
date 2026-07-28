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

const normalizeFlowType = (value) => {
  const normalized = String(value || "").trim().toLowerCase();
  if (normalized === "renewal") return "renewal";
  return "share";
};

const buildInviteId = () => `refinvite-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;

const fail = (status, error, details) => {
  msg.statusCode = status;
  msg.headers = { "Content-Type": "application/json; charset=utf-8" };
  msg.payload = { error, details: details || null };
  return [null, msg, msg];
};

const body = msg.payload && typeof msg.payload === "object" ? msg.payload : {};
const ownerPhone = normalizePhone(body.ownerPhone || body.phone || body.owner);
const ownerSubscriptionId = toStr(body.ownerSubscriptionId || body.subscriptionId || body.ownerSubId);
const flowType = normalizeFlowType(body.mode || body.flowType || body.type);

if (!ownerPhone || !ownerSubscriptionId) {
  return fail(400, "ownerPhone and ownerSubscriptionId are required");
}

const inviteId = buildInviteId();
const nowIso = new Date().toISOString();

msg._referralSubscriptionInviteCtx = {
  inviteId,
  flowType,
  ownerPhone,
  ownerSubscriptionId,
  responsePayload: {
    ok: true,
    inviteId,
    flowType,
    ownerSubscriptionId,
  },
};

const dbMsg = Object.assign({}, msg, {
  query: { inviteId },
  payload: {
    $set: {
      inviteId,
      flowType,
      ownerPhone,
      ownerSubscriptionId,
      updatedAt: nowIso,
    },
    $setOnInsert: {
      createdAt: nowIso,
    },
  },
});

const debugMsg = Object.assign({}, msg, {
  payload: {
    action: "invite_prepare",
    inviteId,
    flowType,
    ownerSubscriptionId,
  },
});

return [dbMsg, null, debugMsg];
