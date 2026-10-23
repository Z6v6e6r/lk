'use strict';
const allowedCodes = new Set(['bot.blocked', 'bot.not.started', 'bot.removed',
  'chat.not.found', 'dialog.not.found', 'access.denied', 'forbidden']);

async function responseJson(response) {
  // Provider bodies stay in memory; bound them and never copy descriptions into receipts/logs.
  if (!response.body) return null;
  const reader = response.body.getReader();
  let size = 0;
  const chunks = [];
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > 65536) return null;
      chunks.push(Buffer.from(value));
    }
    try { return JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch { return null; }
  } finally { await reader.cancel().catch(() => {}); }
}

async function deliver(command, token, { fetchImpl = globalThis.fetch, timeoutMs = 20000,
  signal, now = Date.now } = {}) {
  if (!command || typeof command.id !== 'string'
    || typeof command.leaseToken !== 'string' || !/^[0-9a-f-]{36}$/.test(command.leaseToken)) return null;
  const receipt = { id: command.id, leaseToken: command.leaseToken, kind: 'fail',
    failure: { status: null, code: 'invalid_input' } };
  const chat = typeof command.targetExternalChatId === 'string' && command.targetExternalChatId.trim();
  const user = typeof command.targetExternalUserId === 'string' && command.targetExternalUserId.trim();
  if (!token || (!chat && !user) || typeof command.text !== 'string' || !command.text.trim()
    || command.attachments?.length || !Number.isFinite(Date.parse(command.leasedUntil))
    || Date.parse(command.leasedUntil) <= now() + timeoutMs) return receipt;
  const controller = new AbortController();
  const abort = () => controller.abort();
  if (signal?.aborted) return { ...receipt, failure: { status: null, code: 'unclassified' } };
  signal?.addEventListener('abort', abort, { once: true });
  const timer = setTimeout(abort, timeoutMs);
  let observedStatus = null;
  try {
    const url = new URL('https://platform-api.max.ru/messages');
    url.searchParams.set(chat ? 'chat_id' : 'user_id', chat || user);
    const body = { text: command.text };
    if (['markdown', 'html'].includes(command.format)) body.format = command.format;
    // Exactly one transport call. No SDK attachment.not.ready recursion or automatic retry.
    const response = await fetchImpl(url, { method: 'POST', redirect: 'error',
      headers: { Authorization: token, 'content-type': 'application/json' },
      body: JSON.stringify(body), signal: controller.signal });
    observedStatus = Number.isInteger(response.status) && response.status >= 400 && response.status <= 599
      ? response.status : null;
    const data = await responseJson(response);
    if (response.status === 200 && typeof data?.message?.body?.mid === 'string'
      && data.message.body.mid.length > 0 && !controller.signal.aborted) {
      return { id: command.id, leaseToken: command.leaseToken, kind: 'ack' };
    }
    const status = Number.isInteger(response.status) && response.status >= 400 && response.status <= 599
      ? response.status : null;
    const code = allowedCodes.has(data?.code) ? data.code : 'unclassified';
    const result = { ...receipt, failure: { status, code } };
    const retryAfter = response.headers.get('retry-after');
    if (status === 429 && retryAfter && /^\d+(?:\.\d+)?$/.test(retryAfter)) {
      result.retryAfterSeconds = Math.min(300, Number(retryAfter));
    }
    return result;
  } catch {
    // Transport error, timeout and close have ambiguous delivery; backend quarantines these.
    return { ...receipt, failure: { status: observedStatus, code: 'unclassified' } };
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener('abort', abort);
  }
}

function register(RED) {
  function MaxOutboxSend(config) {
    RED.nodes.createNode(this, config);
    const active = new Set();
    const attempts = new Map();
    let closing = false;
    this.on('input', async (msg, send, done) => {
      const controller = new AbortController();
      active.add(controller);
      try {
        const bot = RED.nodes.getNode(config.bot);
        const command = msg.supportOutbox;
        const key = typeof command?.id === 'string' && typeof command?.leaseToken === 'string'
          ? command.id + ':' + command.leaseToken : null;
        const now = Date.now();
        for (const [k, value] of attempts) if (now - value.at > 600000) attempts.delete(k);
        let receipt = null;
        if (!closing && key) {
          if (!attempts.has(key)) {
            if (attempts.size >= 1000) { this.warn('MAX_OUTBOX_ATTEMPT_CACHE_FULL'); return; }
            attempts.set(key, { at: now, result: deliver(command, bot?.token, { signal: controller.signal }) });
          }
          receipt = await attempts.get(key).result;
        }
        if (receipt) send({ maxOutboxReceipt: receipt });
        else this.warn('MAX_OUTBOX_INVALID_LEASE');
      } catch { this.warn('MAX_OUTBOX_RECEIPT_OUTPUT_FAILED'); }
      finally { active.delete(controller); done(); }
    });
    this.on('close', () => { closing = true; for (const c of active) c.abort(); });
  }
  RED.nodes.registerType('max-outbox-send', MaxOutboxSend);
}
module.exports = register;
module.exports.deliver = deliver;
