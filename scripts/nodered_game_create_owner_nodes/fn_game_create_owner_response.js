// No diagnostics, transport credentials, signed claims, provider response or raw storage on replies.
const body = msg._gameCreateOwnerReply;
for (const key of Object.keys(msg)) {
  if (!['_msgid', 'req', 'res', 'statusCode'].includes(key)) delete msg[key];
}
if (msg.req) {
  msg.req.body = undefined;
  if (msg.req.headers) for (const key of Object.keys(msg.req.headers)) {
    if (/authorization|token|delegation|evidence|cookie/i.test(key)) delete msg.req.headers[key];
  }
}
msg.headers = { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', 'Referrer-Policy': 'no-referrer' };
msg.payload = body || { code: 'GAME_CREATE_OWNER_UNAVAILABLE' };
if (!body) msg.statusCode = 503;
return msg;
