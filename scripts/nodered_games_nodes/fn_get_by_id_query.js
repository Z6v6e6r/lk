const gameId = String(msg.req?.params?.gameId || "").trim();
if (!gameId) {
  msg.statusCode = 400;
  msg.headers = { "Content-Type": "application/json; charset=utf-8" };
  msg.payload = { error: "gameId is required" };
  return [null, msg];
}

msg.payload = { id: gameId, archived: { $ne: true } };
return [msg, null];
