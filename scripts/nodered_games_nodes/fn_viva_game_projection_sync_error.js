const LEASE_KEY = "lk_viva_game_projection_sync_lease_until";
const KEY_REFRESH_OWNER = "vivacrm_token_refresh_owner";
const KEY_REFRESH_LOCK_UNTIL = "vivacrm_token_refresh_lock_until";
const sourceId = String(msg.error?.source?.id || msg.error?.source?.name || "").trim().slice(0, 96) || null;
const writeAck = msg._vivaProjectionSyncWriteAck && typeof msg._vivaProjectionSyncWriteAck === "object"
  ? msg._vivaProjectionSyncWriteAck
  : null;
const group = msg._vivaProjectionSyncGroup && typeof msg._vivaProjectionSyncGroup === "object"
  ? msg._vivaProjectionSyncGroup
  : null;
const runId = msg._vivaProjectionSync?.runId || writeAck?.runId || null;
const fanoutKind = writeAck ? "WRITE_DONE" : (group ? "DATE_DONE" : null);
msg.payload = {
  ok: false,
  source: "viva_game_projection_sync",
  code: "FLOW_NODE_ERROR",
  sourceId,
  runId,
  date: writeAck?.date || group?.date || null,
  gameId: writeAck?.gameId || null,
  at: new Date().toISOString(),
};
if (fanoutKind) {
  msg._vivaProjectionSyncEvent = { kind: fanoutKind, ...msg.payload };
} else {
  const refreshOwner = String(msg._vivaProjectionSyncTokenRefreshOwner || "").trim();
  if (refreshOwner && global.get(KEY_REFRESH_OWNER) === refreshOwner) {
    global.set(KEY_REFRESH_OWNER, null);
    global.set(KEY_REFRESH_LOCK_UNTIL, 0);
  }
  const lease = global.get(LEASE_KEY);
  if (lease && typeof lease === "object" && lease.runId === runId) global.set(LEASE_KEY, null);
  global.set("lk_viva_game_projection_sync_last_report", msg.payload);
}
delete msg.error;
delete msg.query;
delete msg.headers;
delete msg.url;
delete msg.vivaToken;
delete msg._vivaProjectionSyncBearer;
delete msg._vivaProjectionSyncWriteAck;
return msg;
