msg.statusCode = 200;
msg.headers = { "Content-Type": "application/json; charset=utf-8" };
msg.payload = {
  ok: true,
  token: msg._pushUnregister?.token || null,
  tenantKey: msg._pushUnregister?.tenantKey || null,
  active: false,
};
return [msg, msg];
