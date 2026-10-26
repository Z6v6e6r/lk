const command = msg.payload;
if (!command || typeof command !== 'object' || Array.isArray(command)
  || typeof command.id !== 'string') {
  return [null, { payload: { code: 'MAX_OUTBOX_INVALID_COMMAND' } }];
}
// The controlled sender owns validation and emits a fail receipt for bad target/text.
const sendMsg = { supportOutbox: command };
try {
  if (typeof global !== "undefined" && typeof global.get === "function") {
    const diagnostics = global.get("lkDiagnostics");
    diagnostics?.bindMax(sendMsg, command);
    diagnostics?.observe(sendMsg, "max_send_attempt", { sourceHash: "47a6d1282bc264cc788a345a5a43e563701fe420ecc62eb15d1f7e27c4d721fe",
      connector: command.connector, targetType: command.targetExternalChatId ? "chat" : command.targetExternalUserId ? "user" : "UNKNOWN",
      targetSource: "outbox", targetPresent: Boolean(command.targetExternalChatId || command.targetExternalUserId), leaseAttempt: command.attempts,
      leasePresent: typeof command.leaseToken === "string",
      leaseExpired: Number.isFinite(Date.parse(command.leasedUntil)) ? Date.parse(command.leasedUntil) <= Date.now() : undefined,
      botIdentityKnown: false, accessEvidenceKnown: false, executionObserved: false });
  }
} catch { /* no-throw diagnostic observer */ }
return [sendMsg, null];
