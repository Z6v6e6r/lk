// monthly_tournament_ack_guard_v1: reuse the canonical recursive acknowledgement evidence.
if (msg._tournamentGuardedUpsert && acknowledged && !hasRawError && !msg.error && hasPositiveCount('matchedCount', 'n') && !hasPositiveCount('modifiedCount', 'nModified', 'upsertedCount') && !hasUpsertedEvidence) {
  msg.statusCode = 409;
  msg.headers = { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' };
  msg.payload = { error: 'TOURNAMENT_ALREADY_FINISHED', retryable: false };
  delete msg._tournamentLegacySuccessPayload; delete msg._tournamentGuardedUpsert;
  return msg;
}
delete msg._tournamentGuardedUpsert;
