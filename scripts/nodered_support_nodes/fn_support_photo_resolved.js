const saved = msg._supportPhoto, items = msg.payload?.items;
const safe = { _msgid: msg._msgid, req: msg.req, res: msg.res, headers: { 'Content-Type': 'application/json', 'Cache-Control': 'private, no-store' } };
if (!saved || saved.operation !== 'resolve' || msg.statusCode < 200 || msg.statusCode >= 300 ||
  !Array.isArray(items) || items.length !== saved.positions.length || items.some((x, i) =>
    x.index !== i || x.id !== saved.ids[i] || typeof x.url !== 'string' || !/^https:\/\//.test(x.url))) {
  // A committed POST is accepted even if a display grant cannot be minted. Never suggest a resend.
  return saved?.single && saved.original?.message ? { ...safe, statusCode: 200,
    payload: { ...saved.original, message: { ...saved.original.message, attachments: [] }, mediaRefreshRequired: true } }
    : { ...safe, statusCode: 503, payload: { code: 'SUPPORT_MEDIA_UNAVAILABLE' } };
}
const messages = (saved.single ? [saved.original.message] : saved.original.messages).map(m => ({ ...m, attachments: m.attachments?.map(a => ({ ...a })) }));
for (let i = 0; i < items.length; i++) {
  const [m, a] = saved.positions[i];
  messages[m].attachments[a].url = items[i].url;
  delete messages[m].attachments[a].mediaRef;
  delete messages[m].attachments[a].mediaScope;
}
const payload = { ...saved.original, ...(saved.single ? { message: messages[0] } : { messages }) };
return { ...safe, statusCode: 200, payload };
