// tournament_auto_finish_ack_v1: a duplicate create cannot acknowledge stale data.
if (msg._tournamentAutoFinishCreateGuard && msg.payload?.acknowledged === true
    && Number(msg.payload.modifiedCount || 0) === 0 && Number(msg.payload.upsertedCount || 0) === 0 && !msg.payload.upsertedId) {
  delete msg._tournamentLegacySuccessPayload;
  msg.statusCode = 409;
  msg.payload = { error: 'TOURNAMENT_ALREADY_EXISTS', message: 'Турнир уже запущен. Откройте сохранённый протокол.', retryable: false };
  return msg;
}
return (() => { AUTO_FINISH_LEGACY_SOURCE })();
