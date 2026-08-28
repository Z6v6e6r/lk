const origin = String(msg.req?.headers?.origin || "").trim();
const allowed = origin === "https://padlhub.ru"
  || /^http:\/\/(127\.0\.0\.1|localhost)(:\d+)?$/.test(origin);
msg.statusCode = allowed ? 204 : 403;
msg.headers = {
  "Access-Control-Allow-Origin": allowed ? origin : "https://padlhub.ru",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Access-Control-Allow-Headers": "Authorization, Content-Type, X-PadlHub-Release-Channel",
  "Access-Control-Max-Age": "600",
  "Cache-Control": "no-store",
  Vary: "Origin",
};
msg.payload = "";
return msg;
