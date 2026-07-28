const QUEUE_KEY = "lkTournamentParticipantClientQueueV2";
const MAX_CONCURRENCY = 3;
const MAX_WAIT_MS = 4_000;
const now = Date.now();
const state = flow.get(QUEUE_KEY) || { active: 0, queue: [] };
state.active = Math.max(0, Number(state.active || 0));
state.queue = Array.isArray(state.queue) ? state.queue : [];

const fallback = (queuedMsg) => {
  const participant = queuedMsg.participant || queuedMsg.payload || {};
  const client = participant.client && typeof participant.client === "object"
    ? { ...participant.client }
    : participant.client;
  if (client) {
    delete client.phone;
    delete client.phoneNorm;
    delete client.mobile;
  }
  queuedMsg.payload = {
    ...participant,
    client,
    rating: null,
    ratingSource: "unavailable",
  };
  delete queuedMsg._participantClientQueuedAt;
  delete queuedMsg._participantClientQueueSlot;
  return queuedMsg;
};

if (msg._participantClientQueueSlot) {
  state.active = Math.max(0, state.active - 1);
}
delete msg._participantClientQueueSlot;

const expired = [];
state.queue = state.queue.filter((queuedMsg) => {
  const isExpired = now - Number(queuedMsg._participantClientQueuedAt || now) > MAX_WAIT_MS;
  if (isExpired) expired.push(fallback(queuedMsg));
  return !isExpired;
});
for (const expiredMsg of expired) node.send([null, expiredMsg]);

const dispatch = [];
while (state.active < MAX_CONCURRENCY && state.queue.length > 0) {
  const next = state.queue.shift();
  delete next._participantClientQueuedAt;
  next._participantClientQueueSlot = true;
  state.active += 1;
  dispatch.push(next);
}
flow.set(QUEUE_KEY, state);
for (const next of dispatch) node.send([next, null]);
return [null, msg];
