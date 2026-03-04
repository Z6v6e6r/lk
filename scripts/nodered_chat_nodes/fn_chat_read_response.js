msg.statusCode = 200;
msg.headers = { "Content-Type": "application/json; charset=utf-8" };
msg.payload = {
  ok: true,
  read: msg._chatReadDoc || null,
};
return [msg, msg];
