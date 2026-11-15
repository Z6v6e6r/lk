'use strict';
const { createHash } = require('node:crypto');
const { validateImages, prepareImages } = require('./max-media.js');
const { setTimeout: delay } = require('node:timers/promises');
const allowedCodes = new Set(['bot.blocked', 'bot.not.started', 'bot.removed',
  'chat.not.found', 'dialog.not.found', 'dialog.suspended', 'access.denied', 'forbidden']);

// Shared by every sender instance in this Node-RED process. At most two starts
// per second for one addressed dialog, with no overlapping provider attempts.
function createRateScheduler({ intervalMs = 500, maximumPending = 1000, now = Date.now, monotonicNow = () => performance.now(),
  wait = (ms, signal) => new Promise(resolve => {
    if (signal?.aborted) { resolve(); return; }
    const stop = () => { clearTimeout(timer); signal?.removeEventListener('abort', stop); resolve(); };
    const timer = setTimeout(stop, ms);
    signal?.addEventListener('abort', stop, { once: true });
  }) } = {}) {
  const dialogs = new Map();
  let pending = 0;
  return {
    async run(key, operation, { signal, latestStart }) {
      const remainingLease = latestStart - now();
      const monotonicDeadline = monotonicNow() + remainingLease;
      if (signal?.aborted || !(remainingLease > 0) || pending >= maximumPending) return null;
      let state = dialogs.get(key);
      if (!state) {
        if (dialogs.size >= maximumPending) return null;
        state = { tail: Promise.resolve(), lastStart: -Infinity, pending: 0, cleanup: null };
        dialogs.set(key, state);
      }
      clearTimeout(state.cleanup);
      state.pending++; pending++;
      const task = state.tail.then(async () => {
        let delay = Math.max(0, state.lastStart + intervalMs - monotonicNow());
        while (delay > 0) {
          if (signal?.aborted || now() + delay >= latestStart || monotonicNow() + delay >= monotonicDeadline) return null;
          await wait(delay, signal);
          // Timers may wake early; preserve a full monotonic interval.
          delay = Math.max(0, state.lastStart + intervalMs - monotonicNow());
        }
        // Waiting consumes lease time; an expired lease can never reach POST.
        if (signal?.aborted || now() >= latestStart || monotonicNow() >= monotonicDeadline) return null;
        state.lastStart = monotonicNow();
        return operation(() => { state.lastStart = monotonicNow(); });
      });
      state.tail = task.then(() => undefined, () => undefined);
      try { return await task; }
      finally {
        state.pending--; pending--;
        if (state.pending === 0) {
          const remove = () => {
            if (state.pending !== 0 || dialogs.get(key) !== state) return;
            const left = state.lastStart + intervalMs - monotonicNow();
            if (left <= 0) dialogs.delete(key);
            else { state.cleanup = setTimeout(remove, Math.ceil(left)); state.cleanup.unref?.(); }
          };
          const remaining = Math.max(0, state.lastStart + intervalMs - monotonicNow());
          if (!remaining) remove();
          else { state.cleanup = setTimeout(remove, Math.ceil(remaining)); state.cleanup.unref?.(); }
        }
      }
    },
    snapshot: () => ({ pending, dialogs: dialogs.size }),
  };
}
const rateScheduler = createRateScheduler();
const uploadScheduler = createRateScheduler({ intervalMs: 150, maximumPending: 2 });
let activeMedia = 0;

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
  signal, now = Date.now, scheduler = rateScheduler, mediaOptions = {}, onProviderMessage = () => {},
  waitForReady = (ms, signal) => delay(ms, undefined, { signal }) } = {}) {
  if (!command || command.meta?.maxOutboxProtocol !== 'max-lease-v1'
    || Object.prototype.hasOwnProperty.call(command.meta ?? {}, 'legacyMaxRestartCustody')
    || Object.prototype.hasOwnProperty.call(command.meta ?? {}, 'legacyMaxArchive')
    || typeof command.id !== 'string'
    || typeof command.leaseToken !== 'string' || !/^[0-9a-f-]{36}$/.test(command.leaseToken)) return null;
  const receipt = { id: command.id, leaseToken: command.leaseToken, kind: 'fail',
    failure: { status: null, code: 'invalid_input' } };
  const chat = typeof command.targetExternalChatId === 'string' && command.targetExternalChatId.trim();
  const user = typeof command.targetExternalUserId === 'string' && command.targetExternalUserId.trim();
  let images;
  try { images = validateImages(command.attachments, mediaOptions.sourceHosts); } catch { return receipt; }
  if (!token || (!chat && !user) || (command.text !== undefined && typeof command.text !== 'string') ||
    (!command.text?.trim() && !images.length) || !Number.isFinite(Date.parse(command.leasedUntil))) return receipt;
  const deferred = { ...receipt, failure: { status: null, code: 'local_deferred' } };
  if (Date.parse(command.leasedUntil) <= now() + timeoutMs) return deferred;
  const key = createHash('sha256').update(JSON.stringify([chat ? 'chat' : 'user', chat || user])).digest('hex');
  const result = await scheduler.run(key, async (markMessageStart = () => {}) => {
    if (Date.parse(command.leasedUntil) <= now() + timeoutMs) return null;
    if (images.length && activeMedia >= 2) return null;
    if (images.length) activeMedia++;
    const controller = new AbortController();
    const abort = () => controller.abort();
    if (signal?.aborted) { if (images.length) activeMedia--; return null; }
    signal?.addEventListener('abort', abort, { once: true });
    const timer = setTimeout(abort, timeoutMs);
    let observedStatus = null;
    let messageStarted = false;
    try {
      const url = new URL('https://platform-api2.max.ru/messages');
      url.searchParams.set(chat ? 'chat_id' : 'user_id', chat || user);
      const attachments = images.length ? await prepareImages(images, token, { fetchImpl,
        signal: controller.signal,
        admitUpload: operation => uploadScheduler.run('uploads', operation, {
          signal: controller.signal, latestStart: Date.parse(command.leasedUntil) - 1000 }),
        ...mediaOptions }) : [];
      if (controller.signal.aborted || Date.parse(command.leasedUntil) <= now()) return deferred;
      const body = { ...(command.text?.trim() ? { text: command.text } : {}),
        ...(attachments.length ? { attachments } : {}) };
      if (['markdown', 'html'].includes(command.format)) body.format = command.format;
      // Only an explicit HTTP400 attachment.not.ready proves non-acceptance and permits a
      // bounded same-claim retry. Transport errors, late ACKs, 5xx and all other bodies never do.
      for (let attempt = 0; ; attempt++) {
      if (controller.signal.aborted || Date.parse(command.leasedUntil) <= now()) return receipt;
      messageStarted = true;
      markMessageStart();
      const response = await fetchImpl(url, { method: 'POST', redirect: 'error',
        headers: { Authorization: token, 'content-type': 'application/json' },
        body: JSON.stringify(body), signal: controller.signal });
      observedStatus = Number.isInteger(response.status) && response.status >= 400 && response.status <= 599
        ? response.status : null;
      const data = await responseJson(response);
      if (response.status === 200 && typeof data?.message?.body?.mid === 'string'
        && data.message.body.mid.length > 0 && !controller.signal.aborted) {
        onProviderMessage(data);
        return { id: command.id, leaseToken: command.leaseToken, kind: 'ack' };
      }
      if (attachments.length && response.status === 400 && data?.code === 'attachment.not.ready' &&
          (!data.message || typeof data.message === 'string') &&
          Object.keys(data).every(k => ['code', 'message'].includes(k)) && attempt < 4 && !controller.signal.aborted) {
        const backoff = 1000 * (2 ** attempt);
        if (now() + backoff + 1000 >= Date.parse(command.leasedUntil)) return receipt;
        await waitForReady(backoff, controller.signal);
        continue;
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
      }
    } catch {
      if (!messageStarted) return { ...receipt, failure: { status: null, code: 'local_deferred' } };
      // Transport error, timeout and close have ambiguous delivery; backend quarantines these.
      return { ...receipt, failure: { status: observedStatus, code: 'unclassified' } };
    } finally {
      if (images.length) activeMedia--;
      clearTimeout(timer);
      signal?.removeEventListener('abort', abort);
    }
  }, { signal, latestStart: Date.parse(command.leasedUntil) - timeoutMs });
  return result || deferred;
}

function register(RED) {
  require('./max-integration-config.js').loadIntegrationConfig({ file: RED.settings?.padlhubMaxOutboxTokenFile });
  require('./max-outbox-receipt.js')(RED);
  function MaxOutboxSend(config) {
    RED.nodes.createNode(this, config);
    const active = new Set();
    const attempts = new Map();
    // Bounded refusal tombstone: any unremembered lease at/below this expiry
    // has potentially already been released by CUP. Never send it later.
    let refusedLeaseUpperBound = -Infinity;
    let closing = false;
    this.on('input', async (msg, send, done) => {
      const controller = new AbortController();
      active.add(controller);
      try {
        const bot = RED.nodes.getNode(config.bot);
        const command = msg.supportOutbox;
        const key = command?.meta?.maxOutboxProtocol === 'max-lease-v1'
          && !Object.prototype.hasOwnProperty.call(command.meta, 'legacyMaxRestartCustody')
          && !Object.prototype.hasOwnProperty.call(command.meta, 'legacyMaxArchive')
          && typeof command?.id === 'string' && typeof command?.leaseToken === 'string'
          ? command.id + ':' + command.leaseToken : null;
        const now = Date.now();
        for (const [k, value] of attempts) if (value.finished && now >= value.until) attempts.delete(k);
        let receipt = null;
        if (!closing && key) {
          if (!attempts.has(key)) {
            const until = Date.parse(command.leasedUntil);
            if (attempts.size >= 1000 || until <= refusedLeaseUpperBound) {
              // This claim has not reached transport. Tell CUP it may retry admission safely.
              if (Number.isFinite(until)) refusedLeaseUpperBound = Math.max(refusedLeaseUpperBound, until);
              this.warn('MAX_OUTBOX_ATTEMPT_CACHE_FULL');
              send({ maxOutboxReceipt: { id: command.id, leaseToken: command.leaseToken, kind: 'fail',
                failure: { status: null, code: 'local_deferred' } }, maxOutboxLeaseUntil: command.leasedUntil });
              return;
            }
            const job = { until: Date.parse(command.leasedUntil), finished: false };
            job.result = deliver(command, bot?.token, { signal: controller.signal }).finally(() => { job.finished = true; });
            attempts.set(key, job);
          }
          receipt = await attempts.get(key).result;
        }
        if (receipt) send({ maxOutboxReceipt: receipt, maxOutboxLeaseUntil: command.leasedUntil });
        else this.warn('MAX_OUTBOX_INVALID_LEASE');
      } catch { this.warn('MAX_OUTBOX_RECEIPT_OUTPUT_FAILED'); }
      finally { active.delete(controller); done(); }
    });
    this.on('close', () => { closing = true; for (const c of active) c.abort(); });
  }
  RED.nodes.registerType('max-outbox-send', MaxOutboxSend);
  function LegacyMaxOutboxSend(config) {
    RED.nodes.createNode(this, config);
    const attempts = new Map(), active = new Set(); let closing = false;
    this.on('input', async (msg, send, done) => {
      const controller = new AbortController(); active.add(controller);
      try {
        const command = msg.supportOutbox, claim = legacyClaim(command);
        if (closing || !claim) { this.warn('MAX_LEGACY_INVALID_CLAIM'); return; }
        for (const [key, value] of attempts) if (value.finished && Date.now() >= value.until) attempts.delete(key);
        const previous = attempts.get(claim.key);
        if (previous && previous.digest !== claim.digest) { this.warn('MAX_LEGACY_CHANGED_CLAIM'); return; }
        if (!previous) {
          if (attempts.size >= 1000) { this.warn('MAX_LEGACY_ATTEMPT_CAPACITY'); return; }
          const job = { until: Date.parse(command.leasedUntil), digest: claim.digest, finished: false };
          job.result = deliverLegacy(command, RED.nodes.getNode(config.bot)?.token, { signal: controller.signal })
            .finally(() => { job.finished = true; });
          attempts.set(claim.key, job);
        }
        const result = await attempts.get(claim.key).result;
        if (!closing && result) send({ supportOutbox: command, payload: result });
        else this.warn('MAX_LEGACY_DELIVERY_UNCONFIRMED');
      } catch { this.warn('MAX_LEGACY_DELIVERY_UNCONFIRMED'); }
      finally { active.delete(controller); done(); }
    });
    this.on('close', () => { closing = true; for (const c of active) c.abort(); });
  }
  RED.nodes.registerType('max-legacy-outbox-send', LegacyMaxOutboxSend);
}

function legacyClaim(command, now = Date.now()) {
  if (!command || !['MAX_BOT', 'MAX_ACADEMY_BOT'].includes(command.connector) ||
      command.status !== 'LEASED' || command.attempts !== 1 || typeof command.id !== 'string' ||
      !/^[a-f0-9-]{36}$/.test(command.meta?.legacyMaxLeaseId ?? '') ||
      ['legacyMaxRestartCustody', 'legacyMaxArchive', 'maxOutboxProtocol'].some(k => Object.hasOwn(command.meta ?? {}, k)) ||
      !(Date.parse(command.leasedUntil) > now) || Date.parse(command.leasedUntil) > now + 300000) return null;
  return { key: command.id + ':' + command.meta.legacyMaxLeaseId,
    digest: createHash('sha256').update(JSON.stringify([command.connector, command.targetExternalChatId,
      command.targetExternalUserId, command.text, command.format, command.meta.formattedText,
      command.attachments, command.leasedUntil])).digest('hex') };
}
async function deliverLegacy(command, token, options = {}) {
  if (!legacyClaim(command, (options.now || Date.now)())) return null;
  let provider;
  const result = await deliver({ ...command,
    text: command.format && command.meta?.formattedText?.trim() ? command.meta.formattedText : command.text,
    leaseToken: command.meta.legacyMaxLeaseId,
    meta: { ...command.meta, maxOutboxProtocol: 'max-lease-v1' } }, token,
  { ...options, onProviderMessage: data => { provider = { message: { body: { mid: data.message.body.mid } } }; } });
  // The synthetic transport fence is NEVER a CUP receipt. Existing legacy ACK runs only on MID.
  // A timeout/failed send stays unacknowledged; the existing durable expiry path quarantines it.
  return result?.kind === 'ack' ? provider : null;
}
module.exports = register;
module.exports.deliver = deliver;
module.exports.createRateScheduler = createRateScheduler;
module.exports.deliverLegacy = deliverLegacy;
module.exports.legacyClaim = legacyClaim;
