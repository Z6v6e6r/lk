// Diagnostic observer: optional, no-throw; sourceHash is the uninstrumented business preimage.
const lkDiagnostic = (fields = {}) => {
  try {
    if (typeof global === "undefined" || typeof global.get !== "function") return;
    const observer = global.get("lkDiagnostics");
    observer?.observe(msg, "max_send_attempt", { sourceHash: "5038108794d33386a95a08bce5bdf9ee2b3ba367f97e54002906b1e5358a2512", ...fields });
  } catch { /* Observability cannot alter business execution. */ }
};
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
  chatId,
  payload: content,
});

try {
  if (typeof global !== "undefined") {
    const diagnostics = global.get("lkDiagnostics");
    diagnostics?.bindMax(sendMsg, command);
    diagnostics?.observe(sendMsg, "max_send_attempt", { connector: command.connector, targetType: command.targetExternalChatId ? "chat" : command.targetExternalUserId ? "user" : "UNKNOWN",
      targetSource: "outbox", targetPresent: Boolean(chatId), leaseAttempt: command.attempts, leasePresent: Boolean(command.leasedUntil),
      leaseExpired: Number.isFinite(Date.parse(command.leasedUntil)) ? Date.parse(command.leasedUntil) <= Date.now() : undefined,
      botIdentityKnown: false, accessEvidenceKnown: false, executionObserved: false });
  }
} catch { /* no-throw diagnostic observer */ }
return [sendMsg, null];
