const single = Boolean(msg.payload?.message);
const messages = single ? [msg.payload.message] : msg.payload?.messages;
if (!Array.isArray(messages)) return [msg, null, null];
const items = [], positions = [];
for (let i = 0; i < messages.length; i++) {
  const list = Array.isArray(messages[i].attachments) ? messages[i].attachments : [];
  for (let j = 0; j < list.length; j++) if (list[j]?.mediaRef) {
    const a = list[j]; positions.push([i, j]);
    items.push({ index: items.length, id: a.id, mediaRef: a.mediaRef, mediaScope: a.mediaScope });
  }
}
if (!items.length) return [msg, null, null];
const fail = code => [null, null, { _msgid: msg._msgid, req: msg.req, res: msg.res, statusCode: single ? 200 : 503,
  headers: { 'Content-Type': 'application/json', 'Cache-Control': 'private, no-store' },
  payload: single ? { ...msg.payload, message: { ...msg.payload.message, attachments: [] }, mediaRefreshRequired: true } : { code } }];
const token = env.get('SUPPORT_MEDIA_INTEGRATION_TOKEN') || env.get('SUPPORT_INTEGRATION_TOKEN');
if (!token || items.length > 300 || Buffer.byteLength(JSON.stringify(items)) > 256000) return fail('SUPPORT_MEDIA_UNAVAILABLE');
msg._supportPhoto = { operation: 'resolve', original: msg.payload, single, positions, ids: items.map(x => x.id) };
msg.method = 'POST'; msg.requestTimeout = 7000; msg.followRedirects = false;
msg.url = String(env.get('SUPPORT_API_BASE_URL') || 'http://127.0.0.1:3000/api').replace(/\/+$/, '') + '/support/media/resolve';
msg.headers = { 'Content-Type': 'application/json', 'x-integration-token': token };
msg.payload = { items };
return [null, msg, null];
