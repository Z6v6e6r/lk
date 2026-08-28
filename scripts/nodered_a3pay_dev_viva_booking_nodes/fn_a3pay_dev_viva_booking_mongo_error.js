const ctx = msg._a3payDevViva && typeof msg._a3payDevViva === "object" ? msg._a3payDevViva : {};
msg.statusCode = 503;
msg.headers = {
  "Content-Type": "application/json; charset=utf-8",
  "Cache-Control": "no-store",
  "Access-Control-Allow-Origin": ctx.corsOrigin || "https://padlhub.ru",
  Vary: "Origin",
};
msg.payload = {
  ok: false,
  error: "Хранилище идемпотентности недоступно; запрос в Viva не отправлен повторно",
  code: "A3PAY_DEV_PERSISTENCE_UNAVAILABLE",
  operationId: ctx.operationId || null,
};
delete msg.error;
return msg;
