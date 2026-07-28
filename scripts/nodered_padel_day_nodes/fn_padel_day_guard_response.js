const context = msg.padelDay || {};
msg.statusCode = 201;
msg.headers = { "content-type": "application/json; charset=utf-8", "access-control-allow-origin": "*", "cache-control": "no-store" };
msg.payload = { ok: true, guardId: context.guardId, expiresAt: context.expiresAt };
return msg;
