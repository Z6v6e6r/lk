const toStr = (value) => {
  if (value === null || value === undefined) return null;
  const text = String(value).trim();
  return text ? text : null;
};

const gameId = toStr(msg.req?.params?.gameId);

if (!gameId) {
  msg.statusCode = 400;
  msg.headers = { "Content-Type": "application/json; charset=utf-8" };
  msg.payload = { error: "gameId is required" };
  return [null, msg];
}

msg._splitJoinGameId = gameId;
msg._splitJoinBody = msg.payload && typeof msg.payload === "object" ? msg.payload : {};
msg.payload = { id: gameId, archived: { $ne: true } };
return [msg, null];
