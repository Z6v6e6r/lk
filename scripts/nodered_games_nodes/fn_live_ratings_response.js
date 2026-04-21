const asArray = (v) => (Array.isArray(v) ? v : []);

msg.statusCode = 200;
msg.headers = { "Content-Type": "application/json; charset=utf-8" };
msg.payload = {
  items: asArray(msg.payload),
  fetchedAt: new Date().toISOString(),
};
return [msg, msg];
