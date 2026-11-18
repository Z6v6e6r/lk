const auth = msg._splitCleanupAuth;
const gameId = String(msg.req?.params?.gameId || '').trim();
if (!auth?.verified || !auth.actorClientId || !gameId) {
  msg.statusCode = 401; msg.payload = { ok: false, code: 'GAME_ACCESS_DENIED' }; return [null, msg];
}
const begun = gameCancellationBegin({ gameId, actorClientId: auth.actorClientId });
msg._gameCancellationStatus = begun.state;
delete msg._splitCleanupAuth;
msg.payload = begun.effect.query;
return [msg, null];
