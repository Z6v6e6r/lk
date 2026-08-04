msg.statusCode = 204;
msg.headers = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "POST,OPTIONS",
  "Access-Control-Allow-Headers": "Authorization,Content-Type",
  "Access-Control-Max-Age": "600",
  "Cache-Control": "no-store",
};
msg.payload = "";
return msg;
