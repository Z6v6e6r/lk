const sourceId = String(msg.error?.source?.id || msg.error?.source?.name || "unknown").trim();
const errorMessage = String(msg.error?.message || msg.error || "unknown error").trim();
if (typeof node !== "undefined" && typeof node.warn === "function") {
  node.warn(`[tournament-broadcast] source=${sourceId} error=${errorMessage}`);
}

msg.statusCode = 503;
msg.headers = {
  "Content-Type": "application/json; charset=utf-8",
  "Access-Control-Allow-Origin": "*",
  "Cache-Control": "no-store",
};
msg.payload = {
  ok: false,
  code: "TOURNAMENT_BROADCAST_UNAVAILABLE",
  message: "Сервис трансляции временно недоступен",
};
return msg;
