// Wired only to a manual inject inside the authenticated Node-RED editor, never HTTP.
if (msg.req || msg.res) return null;
msg._subscriptionProduct = { caller: 'refresh', step: 'start', tenantKey: 'iSkq6G',
  productId: msg.payload, requestId: msg._msgid, startedAt: Date.now() };
delete msg._subscriptionBooking;
return msg;
