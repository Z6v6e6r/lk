'use strict';
const { createHash } = require('node:crypto');
const codes = new Set(['bot.blocked', 'bot.not.started', 'bot.removed', 'chat.not.found', 'dialog.not.found',
  'dialog.suspended', 'access.denied', 'forbidden', 'invalid_input', 'local_deferred', 'unclassified']);
const uuid = value => typeof value === 'string' && /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/.test(value);
function receiptBody(receipt) {
  if (!receipt || typeof receipt.id !== 'string' || !receipt.id || receipt.id.length > 200
    || !uuid(receipt.leaseToken) || !['ack', 'fail'].includes(receipt.kind)) return null;
  const body = { leaseToken: receipt.leaseToken };
  if (receipt.kind === 'fail') {
    const f = receipt.failure;
    body.failure = { status: Number.isInteger(f?.status) && f.status >= 400 && f.status <= 599 ? f.status : null,
      code: codes.has(f?.code) ? f.code : 'unclassified' };
    if (Number.isFinite(receipt.retryAfterSeconds)) body.retryAfterSeconds = Math.max(0, Math.min(300, receipt.retryAfterSeconds));
  }
  return body;
}
const wait = (ms, signal) => new Promise(resolve => {
  if (signal?.aborted) { resolve(); return; }
  const finish = () => { clearTimeout(timer); signal?.removeEventListener('abort', finish); resolve(); };
  const timer = setTimeout(finish, ms); signal?.addEventListener('abort', finish, { once: true });
});
async function boundedJson(response) {
  if (!response.body) return null;
  const reader = response.body.getReader(), chunks = []; let size = 0;
  try { while (true) { const { done, value } = await reader.read(); if (done) break;
    size += value.byteLength; if (size > 65536) return null; chunks.push(Buffer.from(value)); }
    try { return JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch { return null; }
  } finally { await reader.cancel().catch(() => {}); }
}
/** Repeats ONLY an immutable CUP receipt. This module has no MAX provider transport. */
async function persistReceipt(receipt, leasedUntil, { baseUrl, integrationToken, fetchImpl = globalThis.fetch,
  signal, now = Date.now, monotonicNow = () => performance.now(), sleep = wait, requestTimeoutMs = 7000,
  maximumAttempts = 20 } = {}) {
  const body = receiptBody(receipt), end = Date.parse(leasedUntil), start = now(), monoEnd = monotonicNow() + (end - start);
  const result = (state, code, attempts) => ({ state, code, attempts });
  if (!body || !Number.isFinite(end)) return result('UNCONFIRMED', 'INVALID_RECEIPT', 0);
  let url;
  try { url = new URL(String(baseUrl || 'http://127.0.0.1:3000/api'));
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash) throw Error();
    url.pathname = url.pathname.replace(/\/+$/, '') + '/support/outbox/' + encodeURIComponent(receipt.id) + '/' + receipt.kind;
  } catch { return result('UNCONFIRMED', 'CONFIGURATION_ERROR', 0); }
  if (typeof integrationToken !== 'string' || !integrationToken.trim()) return result('UNCONFIRMED', 'CONFIGURATION_ERROR', 0);
  const payload = JSON.stringify(body);
  const remaining = () => Math.min(end - now(), monoEnd - monotonicNow());
  const maximum = Math.max(1, Math.min(20, Math.floor(maximumAttempts) || 1));
  for (let attempt = 1; attempt <= maximum; attempt++) {
    if (signal?.aborted || remaining() <= 0) return result('UNCONFIRMED', signal?.aborted ? 'CLOSED' : 'LEASE_EXPIRED', attempt - 1);
    const controller = new AbortController(), abort = () => controller.abort();
    signal?.addEventListener('abort', abort, { once: true });
    const timeout = setTimeout(abort, Math.max(1, Math.min(7000, requestTimeoutMs, remaining())));
    let retryAfter = 0;
    try {
      const response = await fetchImpl(url, { method: 'POST', redirect: 'error', signal: controller.signal,
        headers: { 'content-type': 'application/json', Accept: 'application/json', 'x-integration-token': integrationToken }, body: payload });
      if (response.status >= 200 && response.status < 300) {
        const data = await boundedJson(response);
        if (!controller.signal.aborted && !signal?.aborted && remaining() > 0 && data?.id === receipt.id
          && data.lastReceipt?.token === receipt.leaseToken && data.lastReceipt.kind === receipt.kind
          && (receipt.kind === 'ack' ? data.status === 'SENT' : ['PENDING', 'FAILED'].includes(data.status))) {
          return result('CONFIRMED', 'DB_RECEIPT_CONFIRMED', attempt);
        }
        return result('UNCONFIRMED', 'PROTOCOL_REJECTED', attempt);
      }
      await response.body?.cancel().catch(() => {});
      if ([401, 403].includes(response.status)) return result('UNCONFIRMED', 'AUTH_REJECTED', attempt);
      if (response.status === 409) return result('UNCONFIRMED', 'LEASE_CONFLICT', attempt);
      if (response.status !== 429 && response.status < 500) return result('UNCONFIRMED', 'PROTOCOL_REJECTED', attempt);
      const raw = response.headers.get('retry-after');
      if (raw && /^\d+(?:\.\d+)?$/.test(raw)) retryAfter = Math.min(30000, Number(raw) * 1000);
    } catch { /* Unknown CUP response: retry the same idempotent receipt, never the provider send. */ }
    finally { clearTimeout(timeout); signal?.removeEventListener('abort', abort); }
    if (signal?.aborted) return result('UNCONFIRMED', 'CLOSED', attempt);
    const delay = Math.max(retryAfter, Math.min(5000, 250 * 2 ** Math.min(attempt - 1, 5)));
    if (attempt === maximum || delay >= remaining()) return result('UNCONFIRMED', 'RECEIPT_UNAVAILABLE', attempt);
    await sleep(delay, signal);
  }
  return result('UNCONFIRMED', 'RECEIPT_UNAVAILABLE', maximum);
}
function register(RED) {
  function MaxOutboxReceipt(config) {
    RED.nodes.createNode(this, config);
    const jobs = new Map(), active = new Set(); let closing = false;
    this.on('input', async (msg, send, done) => {
      const receipt = msg.maxOutboxReceipt, body = receiptBody(receipt), until = Date.parse(msg.maxOutboxLeaseUntil);
      const key = body ? receipt.id + ':' + receipt.leaseToken : null;
      try {
        if (closing || !key || !Number.isFinite(until)) { this.warn('MAX_RECEIPT_INVALID'); return; }
        const at = Date.now(); for (const [k, job] of jobs) if (job.finished && job.until <= at) jobs.delete(k);
        const fingerprint = createHash('sha256').update(JSON.stringify([receipt.kind, body, until])).digest('hex');
        if (jobs.has(key) && jobs.get(key).fingerprint !== fingerprint) { this.warn('MAX_RECEIPT_CONFLICT'); return; }
        if (!jobs.has(key)) {
          if (jobs.size >= 1000) for (const [k, job] of jobs) if (job.finished) jobs.delete(k);
          if (jobs.size >= 1000) {
            this.warn('MAX_RECEIPT_CAPACITY_UNCONFIRMED');
            send({ maxOutboxReceiptResult: { state: 'UNCONFIRMED', code: 'CAPACITY', attempts: 0 } });
            return;
          }
          const env = name => RED.util.evaluateNodeProperty(name, 'env', this);
          const baseUrl = env('SUPPORT_API_BASE_URL'), integrationToken = env('SUPPORT_INTEGRATION_TOKEN');
          const controller = new AbortController(); active.add(controller);
          const job = { fingerprint, until, finished: false };
          job.result = persistReceipt(structuredClone(receipt), msg.maxOutboxLeaseUntil,
            { baseUrl, integrationToken, signal: controller.signal })
            .finally(() => { job.finished = true; active.delete(controller); });
          jobs.set(key, job);
        }
        const result = await jobs.get(key).result;
        if (!closing) {
          if (result.state !== 'CONFIRMED') this.warn('MAX_OUTBOX_RECEIPT_UNCONFIRMED');
          send({ maxOutboxReceiptResult: result });
        }
      } catch { this.warn('MAX_OUTBOX_RECEIPT_UNCONFIRMED'); }
      finally { done(); }
    });
    this.on('close', () => { closing = true; for (const c of active) c.abort(); });
  }
  RED.nodes.registerType('max-outbox-receipt', MaxOutboxReceipt);
}
module.exports = register;
module.exports.persistReceipt = persistReceipt;
