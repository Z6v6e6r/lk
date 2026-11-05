msg.statusCode = 204;
msg.headers = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
  "Access-Control-Allow-Headers": "Authorization, Content-Type, X-Correlation-Id",
  "Access-Control-Max-Age": "86400",
  "Cache-Control": "no-store",
};
msg.payload = "";
return msg;
