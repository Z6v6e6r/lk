// Explicit retirement acknowledgement; never forward old payloads to canonical onboarding.
const task = msg.payload || {};
msg.payload = { ok: false, retired: true, outboxId: task.outboxId || null, player: task.player || null,
  resultId: task.resultId || null, syncSignature: task.syncSignature || null };
return [null, msg, null];
