const toStr = (value) => {
  if (value === null || value === undefined) return null;
  const text = String(value).trim();
  return text ? text : null;
};

const parseBodyObject = (value) => {
  if (value && typeof value === "object" && !Array.isArray(value)) {
    return value;
  }
  if (typeof value === "string") {
    const trimmed = value.trim();
    if (!trimmed) return {};
    try {
      const parsed = JSON.parse(trimmed);
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
        return parsed;
      }
    } catch {
      // ignore non-JSON payload
    }
  }
  return {};
};

const gameId = toStr(msg.req?.params?.gameId);

if (!gameId) {
  msg.statusCode = 400;
  msg.headers = { "Content-Type": "application/json; charset=utf-8" };
  msg.payload = { error: "gameId is required" };
  return [null, msg];
}

msg._splitJoinGameId = gameId;
const payloadBody = parseBodyObject(msg.payload);
const requestBody = parseBodyObject(msg.req?.body);
msg._splitJoinBody = Object.keys(payloadBody).length > 0 ? payloadBody : requestBody;
msg.payload = { id: gameId, archived: { $ne: true } };
return [msg, null];
