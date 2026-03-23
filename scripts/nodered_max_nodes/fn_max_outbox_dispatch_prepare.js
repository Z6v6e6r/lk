const isObj = (value) => value && typeof value === "object" && !Array.isArray(value);
const toStr = (value) => {
  if (value === null || value === undefined) return null;
  const normalized = String(value).trim();
  return normalized ? normalized : null;
};

const command = isObj(msg.payload) ? msg.payload : null;
if (!command) {
  return [null, msg];
}

const chatId = toStr(command.targetExternalChatId) || toStr(command.targetExternalUserId);
const content = toStr(command.text);
if (!chatId || !content) {
  return [null, Object.assign({}, msg, { payload: { error: "Missing target or text", command } })];
}

const sendMsg = Object.assign({}, msg, {
  supportOutbox: command,
  payload: {
    chatId,
    type: "message",
    content,
  },
});

return [sendMsg, null];
