const response = msg._tournamentResponse;
const updateResult = msg.payload && typeof msg.payload === "object" ? msg.payload : null;
const acknowledged = updateResult?.acknowledged === true;
const matchedCount = Number(updateResult?.matchedCount ?? updateResult?.result?.n ?? 0);

delete msg._tournamentResponse;
delete msg.mongoQuery;
delete msg.mongoUpdate;

if (!response || typeof response !== "object") {
  msg.statusCode = 500;
  msg.payload = {
    error: "TOURNAMENT_PERSISTENCE_RESPONSE_MISSING",
    message: "Не удалось подтвердить сохранение результата турнира",
    retryable: true,
  };
  return msg;
}

if (!acknowledged) {
  msg.statusCode = 503;
  msg.payload = {
    error: "TOURNAMENT_PERSISTENCE_NOT_ACKNOWLEDGED",
    message: "Сервер не подтвердил сохранение результата турнира",
    retryable: true,
  };
  return msg;
}

if (!Number.isFinite(matchedCount) || matchedCount < 1) {
  msg.statusCode = 409;
  msg.payload = {
    error: "TOURNAMENT_PERSISTENCE_CONFLICT",
    message: "Турнир изменился до сохранения результата. Обновите турнир и повторите попытку",
    retryable: true,
  };
  return msg;
}

msg.statusCode = 200;
msg.payload = response;
return msg;
