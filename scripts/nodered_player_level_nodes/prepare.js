const fail = (statusCode, error) => { msg.statusCode = statusCode; msg.headers = { 'Content-Type': 'application/json', 'Cache-Control': 'no-store', 'Access-Control-Allow-Origin': '*' }; msg.payload = { error }; return [null, msg]; };
const auth = msg.req?.headers?.authorization || msg.req?.headers?.Authorization;
if (typeof auth !== 'string' || !/^Bearer\s+\S+$/i.test(auth)) return fail(401, 'AUTH_TOKEN_REQUIRED');
const body = msg.payload && typeof msg.payload === 'object' ? msg.payload : {};
msg._cupLevel = { operation: msg._cupLevelOperation, body };
delete msg._cupLevelOperation;
msg.method = 'GET'; msg.url = 'https://api.vivacrm.ru/end-user/api/v1/iSkq6G/profile';
msg.headers = { Authorization: auth, Accept: 'application/json' }; msg.payload = undefined;
if (msg._cupLevel.operation === 'fprMirror') {
  msg.followRedirects = false;
  msg.maxRedirects = 0;
  msg.requestTimeout = 2500;
}
return [msg, null];
