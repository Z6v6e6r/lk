const statusCode = Number(msg.statusCode);

if (Number.isFinite(statusCode) && statusCode >= 400) {
  delete msg._tournamentResponse;
  return [null, msg];
}

if (
  !msg.mongoQuery
  || typeof msg.mongoQuery !== "object"
  || !msg.mongoUpdate
  || typeof msg.mongoUpdate !== "object"
) {
  msg.statusCode = 500;
  msg.payload = {
    error: "TOURNAMENT_PERSISTENCE_PREPARE_FAILED",
    message: "Не удалось подготовить сохранение результата турнира",
    retryable: true,
  };
  delete msg._tournamentResponse;
  return [null, msg];
}

msg._tournamentResponse = msg.payload;
return [msg, null];
