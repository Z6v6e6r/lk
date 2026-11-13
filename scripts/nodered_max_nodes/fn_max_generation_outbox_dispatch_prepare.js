// New-only uses the legacy SDK sender/custody protocol, not the receipt-v1 runtime node.
const generation = env.get("SUPPORT_MAX_GENERATION");
const after = env.get("SUPPORT_MAX_GENERATION_AFTER");
if (generation != null || after != null) {
  const command = msg.payload;
  const marker = command?.meta?.maxGenerationAdmission;
  const connector = env.get("MAX_CONNECTOR");
  const hold = [null, { payload: { code: "MAX_GENERATION_SEND_HELD" } }];
  if (!["MAX_BOT", "MAX_ACADEMY_BOT"].includes(connector) || !env.get("SUPPORT_MAX_GENERATION_TOKEN")
    || typeof generation !== "string" || !/^[a-f0-9-]{36}$/.test(generation)
    || typeof after !== "string" || !Number.isFinite(Date.parse(after)) || new Date(after).toISOString() !== after
    || !command || command.connector !== connector || command.status !== "LEASED" || command.attempts !== 1
    || marker?.schema !== 1 || marker.generation !== generation || marker.after !== after
    || typeof command.meta?.legacyMaxLeaseId !== "string" || !/^[a-f0-9-]{36}$/.test(command.meta.legacyMaxLeaseId)
    || !Number.isFinite(Date.parse(command.leasedUntil)) || Date.parse(command.leasedUntil) <= Date.now()) return hold;
  const chatId = typeof command.targetExternalChatId === "string" && command.targetExternalChatId.trim();
  // Native contrib may prefer config.defaultChatId over userId. Until the actual sender config is attested, hold user-only commands.
  if (!chatId || typeof command.text !== "string" || !command.text.trim() || command.attachments?.length) return hold;
  return [{ supportOutbox: command, chatId, payload: command.text }, null];
}
return [null, { payload: { code: "MAX_GENERATION_SEND_HELD" } }];
