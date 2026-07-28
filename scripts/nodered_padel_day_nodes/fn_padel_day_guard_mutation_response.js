msg.statusCode = 200;
msg.headers = { "content-type": "application/json; charset=utf-8", "access-control-allow-origin": "*", "cache-control": "no-store" };
msg.payload = { ok: true, status: msg.padelDay?.action === "confirm" ? "PAYMENT_PENDING" : "RELEASED" };
return msg;
