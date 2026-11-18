const state = global.get('supportPhotoAdmission');
if (state?.reservations) { delete state.reservations[msg._msgid]; global.set('supportPhotoAdmission', state); }
const response = { _msgid: msg._msgid, req: msg.req, res: msg.res, statusCode: 503,
  headers: { 'Content-Type': 'application/json', 'Cache-Control': 'private, no-store' }, payload: { code: 'SUPPORT_MEDIA_UNAVAILABLE' } };
const saved = msg._supportPhoto;
if (saved?.operation === 'resolve' && saved.single && saved.original?.message) {
  response.statusCode = 200;
  response.payload = { ...saved.original, message: { ...saved.original.message, attachments: [] }, mediaRefreshRequired: true };
}
return msg._supportPhoto?.operation === 'resolve' ? [null, response] : [response, null];
