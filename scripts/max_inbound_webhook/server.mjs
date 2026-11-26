import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
import { createCupHandoffService, cupHandoffConfig } from './cup-handoff.mjs';
import { authorized, Inbox, Dispatcher, mapUpdate, need, validSecret, readPrivate, canonical, privateDirectory, sha, stationButtons } from './core.mjs';

export const DISPATCH_PAUSE_FILE = '/etc/padlhub/max-padlhub-dispatch.pause.json';
/** Pauses dispatch only; webhook admission remains durable. No automatic expiry or unpause. */
export function readDispatchPause(file = DISPATCH_PAUSE_FILE) {
  try {
    const parent = path.dirname(file), st = fs.lstatSync(parent);
    need(st.isDirectory() && !st.isSymbolicLink() && fs.realpathSync(parent) === parent
      && st.uid === process.getuid() && !(st.mode & 0o022), 'PAUSE_DIRECTORY_CUSTODY');
    let raw;
    try { raw = readPrivate(file, 4096); } catch (error) {
      if (error.code === 'ENOENT') return { paused: false, state: 'absent', epoch: null, sha256: null };
      throw error;
    }
    const value = JSON.parse(raw);
    need(value && typeof value === 'object' && !Array.isArray(value)
      && Object.keys(value).sort().join(',') === 'deploymentId,epoch,schema'
      && value.schema === 'MAX_INBOUND_DISPATCH_PAUSE_V1'
      && typeof value.deploymentId === 'string' && /^[a-z0-9][a-z0-9-]{1,79}$/.test(value.deploymentId)
      && typeof value.epoch === 'string' && /^[a-f0-9]{64}$/.test(value.epoch), 'PAUSE_FILE_SHAPE');
    return { paused: true, state: 'owned', epoch: value.epoch, sha256: sha(raw) };
  } catch { return { paused: true, state: 'invalid', epoch: null, sha256: null }; }
}
export function dispatchHealth(dispatcher, pauseReader = readDispatchPause) {
  const pause = pauseReader();
  return { dispatchPaused: pause.paused, dispatchPauseState: pause.state,
    dispatchPauseEpoch: pause.epoch, dispatchPauseSha256: pause.sha256, dispatcherBusy: dispatcher.running };
}

export const MAX_BODY = 65_536;
export function createIngress({ secret, botId, inbox, stationEnabled = false, cupHandoffEnabled = false, notify = () => {}, health = () => ({}) }) {
  need(validSecret(secret), 'SECRET_CONFIGURATION');
  return http.createServer(async (req, res) => {
    const reply = (status, body) => { res.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store' }); res.end(JSON.stringify(body)); };
    if (req.method === 'GET' && req.url === '/health') { reply(200, { ok: true, ...inbox.counts(), ...health() }); return; }
    if (req.method !== 'POST' || req.url !== '/webhook') { reply(404, { ok: false }); return; }
    if (!authorized(req.rawHeaders, secret)) { req.resume(); reply(401, { ok: false, code: 'UNAUTHORIZED' }); return; }
    if (!/^application\/json(?:\s*;|$)/i.test(req.headers['content-type'] ?? '') || req.headers['content-encoding']) { req.resume(); reply(415, { ok: false }); return; }
    const declared = Number(req.headers['content-length']);
    if (declared > MAX_BODY) { req.resume(); reply(413, { ok: false }); return; }
    const chunks = []; let bytes = 0;
    try {
      for await (const chunk of req) { bytes += chunk.length; if (bytes > MAX_BODY) { reply(413, { ok: false }); req.destroy(); return; } chunks.push(chunk); }
      const raw = JSON.parse(Buffer.concat(chunks).toString('utf8'));
      const mapped = mapUpdate(raw, botId, stationEnabled, cupHandoffEnabled); const result = inbox.accept(raw, mapped);
      reply(200, { ok: true, accepted: true, duplicate: result.duplicate }); notify();
    } catch (e) {
      const capacity = ['DISK_CAPACITY', 'INBOX_CAPACITY', 'ENOSPC', 'EIO'].includes(e.code ?? e.message);
      reply(capacity ? 503 : e.message === 'DUPLICATE_CONFLICT' ? 409 : 400, { ok: false, code: capacity ? 'CAPACITY' : 'INVALID_UPDATE' });
    }
  });
}

export async function jsonFetch(url, options = {}, statuses = [200], timeoutMs = 7000) {
  const r = await fetch(url, { ...options, redirect: 'error', signal: AbortSignal.timeout(timeoutMs) });
  need(statuses.includes(r.status), 'UPSTREAM_STATUS');
  const chunks = []; let bytes = 0;
  for await (const chunk of r.body) { bytes += chunk.length; need(bytes <= 2_097_152, 'UPSTREAM_LIMIT'); chunks.push(chunk); }
  return JSON.parse(Buffer.concat(chunks).toString('utf8'));
}

export const MEDIA_INGEST_BUDGET_MS = 90000;
export function postSupportEvent(config, dto, url = 'http://127.0.0.1:3000/api/support/dialogs/events') {
  // An accepted text can trigger a photo auto-reply too. Budget both media stages, bounded DB
  // reads and durable queue acceptance; the independent webhook ACK still returns immediately.
  const mediaAware = Boolean(config.mediaIngressToken);
  const headers = { 'content-type': 'application/json',
    ...(config.ingressToken ? { 'x-integration-token': config.ingressToken } : {}),
    ...(dto.attachments?.length && config.mediaIngressToken ? { 'x-support-media-token': config.mediaIngressToken } : {}) };
  return jsonFetch(url, { method: 'POST', headers, body: JSON.stringify(dto) }, [200, 201], mediaAware ? MEDIA_INGEST_BUDGET_MS : 7000);
}

const maxApiOrigin = 'https://platform-api2.max.ru';
const integrationHeaders = config => config.ingressToken ? { 'x-integration-token': config.ingressToken } : {};

export function createStationService(config, db, request = jsonFetch) {
  const maxHeaders = { authorization: config.stationBotToken, 'content-type': 'application/json' };
  let botIdentityChecked = false;
  async function verifyBotIdentity() {
    if (botIdentityChecked) return;
    const bot = await request(new URL('/me', maxApiOrigin), { headers: maxHeaders });
    need(bot?.is_bot === true && String(bot.user_id) === config.botId, 'STATION_BOT_IDENTITY');
    botIdentityChecked = true;
  }
  return {
    async verifiedOwner({ userId, chatId }) {
      const url = new URL('http://127.0.0.1:3000/api/support/clients/resolve');
      url.search = new URLSearchParams({ connector: 'MAX_BOT', externalUserId: userId, externalChatId: chatId });
      const { client } = await request(url, { headers: integrationHeaders(config) });
      if (client === null) return null;
      need(typeof client?.id === 'string' && client.id.length > 0 && Array.isArray(client.identities), 'STATION_OWNER_RESPONSE');
      if (client.authStatus !== 'VERIFIED') return null;
      const identity = { connector: 'MAX_BOT', externalUserId: userId, externalChatId: chatId };
      if (!client.identities.some(item =>
        item.connector === identity.connector && item.externalUserId === userId && item.externalChatId === chatId
      )) return null;
      const persisted = await db.collection(config.mongo.clients).findOne({
        id: client.id, authStatus: 'VERIFIED', identities: { $elemMatch: identity },
      }, { projection: { id: 1 }, readConcern: { level: 'majority' }, timeoutMS: 5000 });
      need(persisted?.id === client.id, 'STATION_OWNER_PERSISTENCE');
      await verifyBotIdentity();
      return persisted.id;
    },
    async reply(action, outcome) {
      await verifyBotIdentity();
      const url = new URL(action.type === 'menu' ? '/messages' : '/answers', maxApiOrigin);
      const text = outcome === 'denied'
        ? 'Чтобы сменить станцию, сначала подтвердите номер телефона в поддержке.'
        : outcome === 'saved'
          ? `Станция ${action.dto.selectedStationName} сохранена. Теперь можете написать сообщение для администратора.`
          : 'Выберите станцию, чтобы мы направили обращение нужному администратору.';
      const attachments = outcome === 'menu' ? [{ type: 'inline_keyboard', payload: { buttons: stationButtons() } }] : [];
      const message = { text, attachments };
      if (action.type === 'menu') url.searchParams.set('chat_id', action.chatId);
      else url.searchParams.set('callback_id', action.callbackId);
      const response = await request(url, { method: 'POST', headers: maxHeaders,
        body: JSON.stringify(action.type === 'menu' ? message : { message }) });
      need(action.type === 'menu'
        ? typeof response?.message?.body?.mid === 'string' && response.message.body.mid.length > 0
        : response?.success === true,
      'STATION_REPLY_REFUSED');
    },
  };
}

export function persistenceConfirmer(db, collections, { waitMs = 15000, sleepMs = 300 } = {}) {
  return async (dto, receipt) => {
      const selection = dto.kind === 'STATION_SELECTION';
      const messageCollection = selection ? collections.serviceMessages : collections.messages;
      if (!messageCollection) return false;
      const start = performance.now(), deadline = start + (waitMs || 15000);
      const opts = () => {
        const remaining = Math.ceil(deadline - performance.now());
        need(remaining > 0, 'PERSISTENCE_CONFIRM_TIMEOUT');
        const timeoutMS = Math.min(5000, remaining);
        return { readConcern: { level: 'majority' }, maxTimeMS: timeoutMS, timeoutMS };
      };
      try {
      do {
        const message = await db.collection(messageCollection).findOne({ id: receipt.message.id }, opts());
        if (message && message.connector === 'MAX_BOT' && message.direction === 'INBOUND'
          && message.externalMessageId === dto.externalMessageId && message.externalUserId === dto.externalUserId
          && message.externalChatId === dto.externalChatId && message.text === dto.text
          && canonical((message.attachments ?? []).map(x => ({ type: x.type, url: x.url }))) === canonical((dto.attachments ?? []).map(x => ({ type: x.type, url: x.url })))
          && message.dialogId === receipt.dialogId && message.clientId === receipt.clientId) {
          const dialog = await db.collection(collections.dialogs).findOne({ id: receipt.dialogId, clientId: receipt.clientId }, opts());
          const client = await db.collection(collections.clients).findOne({ id: receipt.clientId }, opts());
          const stationMatches = !selection || (receipt.stationId
            && message.kind === dto.kind && message.stationId === receipt.stationId && dialog?.stationId === receipt.stationId
            && client?.currentStationId === receipt.stationId && client.authStatus === 'VERIFIED');
          if (dialog && client && typeof dialog.updatedAt === 'string' && dialog.updatedAt >= message.createdAt
            && stationMatches && Array.isArray(client.identities) && client.identities.some(x => x.connector === 'MAX_BOT' && x.externalUserId === dto.externalUserId && x.externalChatId === dto.externalChatId)) return true;
        }
        if (!waitMs) break;
        await new Promise(resolve => setTimeout(resolve, Math.min(sleepMs, Math.max(0, deadline - performance.now()))));
      } while (performance.now() < deadline);
      } catch { return false; }
      return false;
  };
}

export function memoizedStop(operation) {
  let pending; return () => { pending ??= Promise.resolve().then(operation); return pending; };
}

export async function main() {
  const parent = '/etc/padlhub'; const st = fs.lstatSync(parent);
  need(st.isDirectory() && !st.isSymbolicLink() && fs.realpathSync(parent) === parent && st.uid === process.getuid() && !(st.mode & 0o022), 'CONFIG_DIRECTORY');
  const config = JSON.parse(readPrivate('/etc/padlhub/max-padlhub-webhook.json', 65_536));
  need(validSecret(config.webhookSecret) && typeof config.botId === 'string', 'CONFIGURATION');
  need(config.mediaIngressToken === undefined || (typeof config.mediaIngressToken === 'string' &&
    /^[A-Za-z0-9_-]{32,2048}$/.test(config.mediaIngressToken)), 'MEDIA_TOKEN_CONFIGURATION');
  need(config.stationBotToken === undefined || (typeof config.stationBotToken === 'string'
    && /^[\x21-\x7e]{16,2048}$/.test(config.stationBotToken)), 'STATION_TOKEN_CONFIGURATION');
  need(config.mongo?.messages && config.mongo?.dialogs && config.mongo?.clients && config.mongo?.uri && config.mongo?.db, 'MONGO_CONFIGURATION');
  need(!config.stationBotToken || (typeof config.mongo.serviceMessages === 'string' && config.mongo.serviceMessages.length > 0
    && config.mongo.serviceMessages !== config.mongo.messages), 'STATION_COLLECTION_CONFIGURATION');
  const cupHandoffSettings = cupHandoffConfig(config);
  const cupHandoff = cupHandoffSettings ? createCupHandoffService(cupHandoffSettings, jsonFetch) : undefined;
  const require = createRequire(import.meta.url); const { MongoClient } = require('mongodb');
  const mongo = new MongoClient(config.mongo.uri, { serverSelectionTimeoutMS: 5000, appName: 'max-padlhub-webhook' }); await mongo.connect();
  const db = mongo.db(config.mongo.db);
  const inbox = new Inbox('/var/lib/padlhub-max-padlhub-inbound');
  const station = config.stationBotToken ? createStationService(config, db) : undefined;
  const dispatcher = new Dispatcher(inbox, {
    paused: () => readDispatchPause().paused,
    ready: async () => { try { return (await jsonFetch('http://127.0.0.1:3000/api/health')).status === 'ok'; } catch { return false; } },
    post: dto => postSupportEvent(config, dto),
    confirm: persistenceConfirmer(db, config.mongo),
    station,
    cupHandoff,
  });
  const server = createIngress({ secret: config.webhookSecret, botId: config.botId, inbox,
    stationEnabled: Boolean(station), cupHandoffEnabled: Boolean(cupHandoff),
    health: () => ({ ...dispatchHealth(dispatcher), stationEnabled: Boolean(station), cupHandoffEnabled: Boolean(cupHandoff) }) });
  server.maxConnections = 64; server.keepAliveTimeout = 2000; server.requestTimeout = 15_000; server.headersTimeout = 10_000; server.maxHeadersCount = 32;
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(18941, '127.0.0.1', resolve); });
  let stopping = false;
  const timer = setInterval(() => { if (!stopping) dispatcher.tick().catch(() => { console.error('MAX_INGRESS_STORAGE_FAILURE'); process.exit(1); }); }, 500);
  const stop = memoizedStop(async () => { stopping = true; dispatcher.stop(); clearInterval(timer); server.close(); while (dispatcher.running) await new Promise(resolve => setTimeout(resolve, 100)); await mongo.close(); });
  process.on('SIGTERM', () => { stop().then(() => process.exit(0)).catch(() => process.exit(1)); });
  process.on('SIGINT', () => { stop().then(() => process.exit(0)).catch(() => process.exit(1)); });
  console.log(JSON.stringify({ event: 'MAX_INGRESS_READY', port: 18941, connector: 'MAX_BOT' }));
}
export function launchLocked({ directory = '/var/lib/padlhub-max-padlhub-inbound', entry = process.argv[1] } = {}) {
  const lock = directory + '/.runtime.lock';
  privateDirectory(directory); readPrivate(lock, 1024);
  const child = spawn('/usr/bin/flock', ['-E', '75', '-n', '--no-fork', lock, process.execPath, entry], {
    stdio: 'inherit', env: { ...process.env, PADLHUB_MAX_INBOUND_LOCK_HELD: '1' },
  });
  for (const signal of ['SIGTERM', 'SIGINT']) process.on(signal, () => child.kill(signal));
  child.once('error', () => { console.error('MAX_INGRESS_LOCK_FAILED'); process.exit(1); });
  child.once('exit', code => process.exit(Number.isInteger(code) ? code : 1));
}
if (process.argv[1] && import.meta.url === pathToFileURL(fs.realpathSync(process.argv[1])).href) {
  if (process.env.PADLHUB_MAX_INBOUND_LOCK_HELD === '1') main().catch(() => { console.error('MAX_INGRESS_START_FAILED'); process.exit(1); });
  else { try { launchLocked(); } catch { console.error('MAX_INGRESS_LOCK_FAILED'); process.exit(1); } }
}
