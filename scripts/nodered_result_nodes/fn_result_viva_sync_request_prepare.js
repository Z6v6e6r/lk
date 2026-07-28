const toStr = (value) => {
  if (value === null || value === undefined) return null;
  const text = String(value).trim();
  return text ? text : null;
};

const task = msg.payload && typeof msg.payload === 'object' ? msg.payload : null;
if (!task || !task.outboxId) return [null, null, msg];

if (task.skipReason) {
  return [null, Object.assign({}, msg, {
    payload: {
      ok: false,
      statusCode: 409,
      error: task.skipReason,
      auditEventId: task.auditEventId || null,
      outboxId: task.outboxId,
      player: task.player || null,
      requestPayload: task.payload || null,
      resultId: task.resultId || null,
      resultRevision: task.resultRevision || null,
      syncSignature: task.syncSignature || null,
      batchId: task.syncSignature || null,
      attemptedAt: new Date().toISOString(),
    },
  }), null];
}

const baseUrl = (() => {
  try {
    const explicit = toStr(env.get('LK_INTERNAL_BASE_URL') || env.get('LK_BASE_URL') || env.get('LK_PUBLIC_BASE_URL'));
    if (explicit) return explicit.replace(/\/+$/, '');
  } catch {}
  return 'http://127.0.0.1:1880/lk';
})();

msg.method = 'POST';
msg.url = `${baseUrl}/onboarding/level`;
msg.headers = { "Content-Type": "application/json", Accept: "application/json" };
msg.payload = task.payload || {};
msg._resultVivaSyncTask = task;
msg._resultVivaSyncAttemptedAt = new Date().toISOString();
return [msg, null, null];
