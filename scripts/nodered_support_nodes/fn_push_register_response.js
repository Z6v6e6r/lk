msg.statusCode = 200;
msg.headers = { "Content-Type": "application/json; charset=utf-8" };
msg.payload = {
  ok: true,
  id: msg._pushRegister?.id || null,
  token: msg._pushRegister?.token || null,
  tenantKey: msg._pushRegister?.tenantKey || null,
  platform: msg._pushRegister?.platform || null,
  active: true,
  identityKeys: Array.isArray(msg._pushRegister?.identityKeys) ? msg._pushRegister.identityKeys : [],
};
return [msg, msg];
