msg.statusCode = 200;
msg.headers = { "Content-Type": "application/json; charset=utf-8" };
msg.payload = {
  ok: true,
  dialog: msg._supportReplyResolved?.dialog || null,
  message: msg._supportReplyResolved?.message || null,
  dispatch: msg._supportReplyResolved?.dispatch || null,
};
return [msg, msg];
