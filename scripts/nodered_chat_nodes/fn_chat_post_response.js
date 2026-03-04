msg.statusCode = 200;
msg.headers = { "Content-Type": "application/json; charset=utf-8" };
msg.payload = msg._chatMessageDoc || { ok: true };
return [msg, msg];
