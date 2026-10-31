// Preserve the old fourth edge for every ordinary message. Only private, already verified
// owner messages may enter Mongo-capable canonical stages without an HTTP request.
if (msg._quarterCreateBridge === undefined) return [msg, null, null];
const route = msg._quarterCreateBridge, o = msg._gameCreateOwner;
delete msg._quarterCreateBridge;
if (!o || !['router', 'prepare'].includes(route)
  || (route === 'prepare' ? msg._quarterCreateCapability?.stage !== 'gateway_prepare'
    : !gcoStoredMatches(o.row, o.claims, msg._subscriptionBooking?.managedCreateBinding?.admissionRequestSha256))) {
  msg._gameCreateOwnerReply = { code: 'GAME_CREATE_OWNER_GRAPH_UNAVAILABLE' }; msg.statusCode = 503;
  return [null, msg, null];
}
for (const k of ['url', 'method', 'headers', 'payload', 'error', 'responseUrl', 'statusCode', 'requestTimeout']) delete msg[k];
return route === 'prepare' ? [null, null, msg] : [null, msg, null];
