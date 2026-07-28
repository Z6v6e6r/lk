if (!(msg.statusCode >= 200 && msg.statusCode < 300)) {
  return [null, msg, null];
}

flow.set("lkTournamentParticipantVivaCircuitV2", { failures: 0, openedUntil: 0 });
const list = Array.isArray(msg.payload) ? msg.payload : (msg.payload?.content || []);
const isCancelled = (item) => {
  const status = String(item?.status || item?.state || "").trim().toLowerCase();
  return item?.isCancelled === true
    || item?.cancelled === true
    || item?.canceled === true
    || status === "cancelled"
    || status === "canceled"
    || status === "cancel";
};

const byClientId = new Map();
list.forEach((item) => {
  const client = item?.client;
  const clientId = String(client?.id || "").trim();
  if (isCancelled(item) || !clientId || byClientId.has(clientId)) return;
  byClientId.set(clientId, {
    id: item.id,
    spot: item.spot,
    isCancelled: false,
    client: {
      id: clientId,
      firstName: client.firstName,
      lastName: client.lastName,
      middleName: client.middleName,
      photo: client.photo,
    },
  });
});

msg.payload = Array.from(byClientId.values());
if (msg.payload.length === 0) return [null, null, msg];
return [msg, null, null];
