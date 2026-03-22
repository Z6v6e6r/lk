msg.statusCode = 200;
msg.headers = { "Content-Type": "application/json; charset=utf-8" };
msg.payload = {
  ok: true,
  client: msg._supportEvent?.client || null,
  dialog: msg._supportEvent?.dialog || null,
  message: msg._supportEvent?.message || null,
};
return [msg, msg];
