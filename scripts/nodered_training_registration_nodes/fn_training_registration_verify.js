const verified = trVerify(msg, env, TRAINING_REGISTRATION_MODE);
bookedOperationScrubDelegation(msg);
if (!verified.ok) {
  delete msg._trainingRegistration;
  msg.statusCode = verified.statusCode;
  msg.headers = {
    'Content-Type': 'application/json',
    'Cache-Control': 'no-store',
    'Referrer-Policy': 'no-referrer',
  };
  msg.payload = { code: verified.code, error: verified.code };
  return [null, msg];
}
msg._trainingRegistration = {
  mode: TRAINING_REGISTRATION_MODE,
  step: 'start',
  claims: verified.claims,
  actorToken: verified.actorToken,
  request: verified.request,
};
msg.payload = undefined;
return [msg, null];
