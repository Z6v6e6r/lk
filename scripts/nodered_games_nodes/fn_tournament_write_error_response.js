const source = msg._error?.source && typeof msg._error.source === "object"
  ? msg._error.source
  : {};

delete msg._tournamentResponse;
delete msg.mongoQuery;
delete msg.mongoUpdate;

msg.statusCode = 503;
msg.payload = {
  error: "TOURNAMENT_PERSISTENCE_FAILED",
  message: "Не удалось сохранить результат турнира. Повторите попытку",
  retryable: true,
  source: source.name || source.id || null,
};

return msg;
