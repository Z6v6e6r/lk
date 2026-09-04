const ack = msg._vivaProjectionSyncWriteAck && typeof msg._vivaProjectionSyncWriteAck === "object"
  ? msg._vivaProjectionSyncWriteAck
  : null;
const raw = Array.isArray(msg.payload) && msg.payload.length === 1 ? msg.payload[0] : msg.payload;
const acknowledged = raw && typeof raw === "object" && !Array.isArray(raw) && raw.acknowledged === true;
const matchedCount = Number.isInteger(raw?.matchedCount) ? raw.matchedCount : null;
const modifiedCount = Number.isInteger(raw?.modifiedCount) ? raw.modifiedCount : null;
const ok = Boolean(ack && !msg.error && acknowledged && matchedCount === 1 && modifiedCount === 1);
msg.payload = {
  ok,
  source: "viva_game_projection_sync",
  code: ok
    ? "ROOM_RECONCILED"
    : (acknowledged && matchedCount === 0 && modifiedCount === 0 ? "CAS_CONFLICT" : "WRITE_NOT_ACKNOWLEDGED"),
  runId: ack?.runId || null,
  date: ack?.date || null,
  gameId: ack?.gameId || null,
  exerciseId: ack?.exerciseId || null,
  expectedRevision: ack?.expectedRevision ?? null,
  expectedNextRevision: ack?.expectedNextRevision ?? null,
  previousRoomId: ack?.previousRoomId || null,
  roomId: ack?.roomId || null,
  acknowledged,
  matchedCount: Number.isFinite(matchedCount) ? matchedCount : null,
  modifiedCount: Number.isFinite(modifiedCount) ? modifiedCount : null,
  at: new Date().toISOString(),
};
msg._vivaProjectionSyncEvent = { kind: "WRITE_DONE", ...msg.payload };
delete msg._vivaProjectionSyncWriteAck;
return msg;
