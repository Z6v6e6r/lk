const verified = smVerify(msg, env, STATION_MEMBERSHIP_MODE);
if (msg.req?.headers) delete msg.req.headers['x-station-membership-delegation'];
if (verified.code) return [null, smFailure(msg, verified.status, verified.code)];
msg._stationMembership = { mode: STATION_MEMBERSHIP_MODE, actor: verified.actor, request: verified.request, step: 'admission_read', retries: 0 };
msg.payload = [{ _id: smAdmissionKey(verified.actor, verified.request.operationId) }, { limit: 2 }];
delete msg.headers;
delete msg.error;
return [msg, null];
