msg.statusCode = msg.statusCode || 200;
msg.headers = msg.headers || { "Content-Type": "application/json; charset=utf-8" };
return [msg, msg];
