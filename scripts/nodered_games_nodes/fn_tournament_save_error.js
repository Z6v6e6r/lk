delete msg.error;
delete msg._tournamentLegacySuccessPayload;

msg.statusCode = 503;
msg.headers = {
  "Content-Type": "application/json; charset=utf-8",
  "Cache-Control": "no-store",
};
msg.payload = {
  error: "TOURNAMENT_PERSISTENCE_FAILED",
  message: "Не удалось сохранить турнир. Повторите попытку",
  retryable: true,
};
return msg;
