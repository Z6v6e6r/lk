const mode = msg.req?.method === 'GET' ? 'read' : 'admit';
const verified = mslVerify(msg, env, mode);
const reject = (status, code) => {
  bookedOperationScrubDelegation(msg);
  delete msg._managedSelfLeave;
  msg.statusCode = status;
  msg.headers = {
    'Content-Type': 'application/json',
    'Cache-Control': 'no-store',
    'Referrer-Policy': 'no-referrer',
  };
  msg.payload = { code, error: code };
  return [null, msg];
};
if (!verified.ok) return reject(verified.statusCode, verified.code);
const body = mode === 'admit' ? mslRequest(msg.payload) : null;
if (
  mode === 'admit' &&
  (!body ||
    mslHash('managed-self-leave-admission:v1\0' + JSON.stringify(body)) !==
      verified.claims.request_sha256)
)
  return reject(400, 'MANAGED_SELF_LEAVE_REQUEST_INVALID');
if (
  mode === 'read' &&
  msg.payload !== undefined &&
  msg.payload !== null &&
  !(mslObject(msg.payload) && Object.keys(msg.payload).length === 0)
)
  return reject(400, 'MANAGED_SELF_LEAVE_REQUEST_INVALID');
msg._managedSelfLeave = {
  mode,
  step: 'find',
  claims: verified.claims,
  actorToken: verified.actorToken,
  bindingSha256: verified.bindingSha256,
  request: body,
};
bookedOperationScrubDelegation(msg);
msg.payload = {
  _id: verified.claims.operation_id,
  kind: 'MANAGED_SELF_LEAVE_ADMISSION',
  tenantId: verified.claims.tenant_id,
  userId: verified.claims.sub,
};
return [msg, null];
