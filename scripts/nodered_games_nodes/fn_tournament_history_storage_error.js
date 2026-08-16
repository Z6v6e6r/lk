msg.statusCode = 503;
msg.headers = {
  "Content-Type": "application/json; charset=utf-8",
  "Cache-Control": "no-store",
  "Retry-After": "5",
};
msg.payload = {
  error: "История турнира временно недоступна",
  code: "TOURNAMENT_HISTORY_STORAGE_UNAVAILABLE",
};
delete msg.error;
return msg;
