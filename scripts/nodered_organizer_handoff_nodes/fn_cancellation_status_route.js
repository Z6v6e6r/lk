const s = msg._gameCancellationStatus;
const expected = s?.expectedUrl;
const invalid = expected && (msg.method !== 'GET' || msg.url !== expected || msg.responseUrl !== expected);
if (s) delete s.expectedUrl;
const effect = s ? gameCancellationStep(s, { payload: msg.payload, status: expected ? msg.statusCode : undefined,
  error: !!msg.error || !!invalid }) : { kind: 'reply', status: 503, payload: { ok: false, state: 'UNVERIFIED' } };
if (effect.kind === 'reply') {
  msg.statusCode = effect.status; msg.payload = effect.payload;
  msg.headers = { 'Content-Type': 'application/json', 'Cache-Control': 'no-store', 'Access-Control-Allow-Origin': '*' };
  delete msg._gameCancellationStatus; return [null, null, msg, null];
}
if (effect.kind === 'find') { msg.payload = effect.query; delete msg.error; return [null, null, null, msg]; }
if (effect.kind === 'update') { msg.payload = [effect.query, effect.change, effect.options]; delete msg.error; return [null, msg, null, null]; }
if (effect.kind === 'http' && effect.method === 'GET') {
  let token;
  try {
    token = global.get('vivacrm_access_token');
    const claims = JSON.parse(Buffer.from(token.split('.')[1], 'base64').toString('utf8'));
    if (claims.exp * 1000 <= Date.now() + 60000) token = null;
  } catch { token = null; }
  if (!token) { msg.statusCode = 503; msg.headers = { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' }; msg.payload = { ok: false, state: 'UNVERIFIED' }; return [null, null, msg, null]; }
  msg.method = 'GET'; msg.url = 'https://api.vivacrm.ru' + effect.path;
  s.expectedUrl = msg.url; msg.headers = { Authorization: 'Bearer ' + token, Accept: 'application/json' };
  msg.payload = undefined; msg.followRedirects = false; msg.requestTimeout = 10000;
  return [msg, null, null, null];
}
msg.statusCode = 503; msg.headers = { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' }; msg.payload = { ok: false, state: 'UNVERIFIED' }; return [null, null, msg, null];
