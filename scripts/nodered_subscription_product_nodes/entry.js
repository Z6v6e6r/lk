// HTTP ingress is rebuilt from an allowlist. Phone and forged internal fields are ignored.
const auth = msg.req?.headers?.authorization;
const subscriptionId = msg.req?.query?.subId;
delete msg._subscriptionBooking;
msg._subscriptionProduct = { caller: 'name', step: 'start', tenantKey: 'iSkq6G',
  authHeader: typeof auth === 'string' ? auth : null,
  subscriptionId: typeof subscriptionId === 'string' ? subscriptionId : null,
  requestId: msg._msgid, startedAt: Date.now() };
return msg;
