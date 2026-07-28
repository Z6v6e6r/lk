const fail = (status, error, details) => {
  const response = Object.assign({}, msg, {
    statusCode: status,
    headers: { "Content-Type": "application/json; charset=utf-8" },
    payload: { error, details: details || null },
  });
  return [response, response];
};

const ctx = msg._referralSubscriptionInviteCtx && typeof msg._referralSubscriptionInviteCtx === "object"
  ? msg._referralSubscriptionInviteCtx
  : null;

if (!ctx || !ctx.responsePayload || typeof ctx.responsePayload !== "object") {
  return fail(500, "Referral subscription invite context is missing");
}

const response = Object.assign({}, msg, {
  statusCode: 201,
  headers: { "Content-Type": "application/json; charset=utf-8" },
  payload: ctx.responsePayload,
});

const debugMsg = Object.assign({}, msg, {
  payload: {
    action: "invite_response",
    inviteId: ctx.responsePayload.inviteId || null,
    flowType: ctx.responsePayload.flowType || null,
  },
});

return [response, debugMsg];
