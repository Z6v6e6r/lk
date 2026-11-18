// Media-only gate before the existing support writer. Text requests keep the original path.
const original = msg.payload;
const attachments = original && Array.isArray(original.attachments) ? original.attachments : [];
if (!attachments.length) return [msg, null, null];
const fail = (status, code) => [null, null, { _msgid: msg._msgid, req: msg.req, res: msg.res,
  statusCode: status, headers: { 'Content-Type': 'application/json' }, payload: { code } }];
if (!/^[a-f0-9]{16,64}$/.test(String(msg._msgid)) || attachments.length > 10) return fail(400, 'SUPPORT_MEDIA_INPUT_INVALID');
let encoded = 0;
for (const a of attachments) {
  if (!a || a.type !== 'IMAGE' || a.mediaRef || a.mediaScope || typeof a.url !== 'string' ||
    !/^data:image\/(jpeg|png|webp);base64,[A-Za-z0-9+/]*={0,2}$/.test(a.url)) return fail(400, 'SUPPORT_MEDIA_INPUT_INVALID');
  encoded += a.url.length;
}
// Bounded before contacting CUP. This also fits the existing Node-RED JSON body budget.
if (encoded > 2800000) return fail(413, 'SUPPORT_MEDIA_TOO_LARGE');
const token = env.get('SUPPORT_MEDIA_INTEGRATION_TOKEN') || env.get('SUPPORT_INTEGRATION_TOKEN');
if (!token) return fail(503, 'SUPPORT_MEDIA_UNCONFIGURED');
const now = Date.now(), state = global.get('supportPhotoAdmission') || { reservations: {}, window: now, total: 0, ips: {} };
for (const [key, expiry] of Object.entries(state.reservations)) if (expiry <= now) delete state.reservations[key];
if (now - state.window >= 60000) { state.window = now; state.total = 0; state.ips = {}; }
// Use the socket address, never a caller-controlled X-Forwarded-For/body identity.
const ip = String(msg.req?.socket?.remoteAddress || 'unknown');
if (Object.keys(state.reservations).length >= 2 || state.total >= 30 || (state.ips[ip] || 0) >= 12) return fail(429, 'SUPPORT_MEDIA_BUSY');
state.total++; state.ips[ip] = (state.ips[ip] || 0) + 1; state.reservations[msg._msgid] = now + 35000;
global.set('supportPhotoAdmission', state);
msg._supportPhoto = { operation: 'prepare', original, count: attachments.length, ids: attachments.map(a => a.id) };
msg.method = 'POST'; msg.requestTimeout = 30000; msg.followRedirects = false;
msg.url = String(env.get('SUPPORT_API_BASE_URL') || 'http://127.0.0.1:3000/api').replace(/\/+$/, '') + '/support/media/prepare';
msg.headers = { 'Content-Type': 'application/json', 'x-integration-token': token };
msg.payload = { owner: 'WEB_LK:' + msg._msgid, attachments };
return [null, msg, null];
