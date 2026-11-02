const smPath = (operationId, mode) => '/lk/integrations/v1/station-memberships/operations/' + operationId + '/' + mode;
const smResponse = (msg, status, body) => {
  delete msg._stationMembership;
  delete msg.error;
  msg.statusCode = status;
  msg.headers = { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' };
  msg.payload = body;
  return msg;
};
const smFailure = (msg, status, code) => smResponse(msg, status, { code });
