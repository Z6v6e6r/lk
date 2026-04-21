const player = msg.payload && typeof msg.payload === "object" ? msg.payload : {};
msg._livePlayer = player;

if (!player.clientId) {
  msg.payload = {
    clientId: null,
    phoneNorm: player.phoneNorm || null,
    name: player.name || null,
    rating: player.rating || null,
    ratingNumeric:
      Number.isFinite(Number(player.ratingNumeric)) ? Number(player.ratingNumeric) : null,
    source: "NO_CLIENT_ID",
  };
  return [null, msg, msg];
}

msg.method = "GET";
msg.url = `https://api.vivacrm.ru/api/v1/clients/${encodeURIComponent(player.clientId)}`;
msg.headers = { Authorization: `Bearer ${msg.vivaToken}` };
return [msg, null, msg];
