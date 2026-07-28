const update = msg._vivaFieldUpdate && typeof msg._vivaFieldUpdate === 'object'
  ? msg._vivaFieldUpdate
  : {};
const httpStatus = Number(msg.statusCode || 0) || null;
const responsePayload = msg.payload;
const explicitError = responsePayload && typeof responsePayload === 'object'
  ? (responsePayload.error || responsePayload.message || null)
  : null;
const ok = !explicitError && httpStatus !== null && httpStatus >= 200 && httpStatus < 300;

msg.payload = {
  fieldId: update.fieldId || null,
  requestedValue: update.requestedValue || null,
  httpStatus,
  ok,
  error: ok ? null : (explicitError || (httpStatus ? `Viva PUT failed with HTTP ${httpStatus}` : 'Viva PUT failed')),
  response: responsePayload ?? null,
};
delete msg._vivaFieldUpdate;
return msg;
