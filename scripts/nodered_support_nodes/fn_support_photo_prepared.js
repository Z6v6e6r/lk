const saved = msg._supportPhoto;
const state = global.get('supportPhotoAdmission');
if (state?.reservations) { delete state.reservations[msg._msgid]; global.set('supportPhotoAdmission', state); }
const safe = { _msgid: msg._msgid, req: msg.req, res: msg.res };
const attachments = msg.payload?.attachments;
if (!saved || saved.operation !== 'prepare' || msg.statusCode < 200 || msg.statusCode >= 300 ||
  !Array.isArray(attachments) || attachments.length !== saved.count || attachments.some((a, i) =>
    (saved.ids[i] && a.id !== saved.ids[i]) || a.type !== 'IMAGE' || !/^cup-media:v1:/.test(a.url || '') || a.mediaRef !== a.url ||
    !/^[a-f0-9]{64}$/.test(a.mediaScope || '') || a.mediaScope !== attachments[0].mediaScope)) {
  return [null, { ...safe, statusCode: 503, headers: { 'Content-Type': 'application/json' }, payload: { code: 'SUPPORT_MEDIA_UNAVAILABLE' } }];
}
// Do not pass integration headers, service request/response or source bytes into debug/catch paths.
return [{ ...safe, payload: { ...saved.original, attachments } }, null];
