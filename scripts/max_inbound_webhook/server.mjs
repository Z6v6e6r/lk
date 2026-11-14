import http from 'node:http';
import fs from 'node:fs';
import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
import { authorized, Inbox, Dispatcher, mapUpdate, need, validSecret, readPrivate, canonical, privateDirectory } from './core.mjs';

export const MAX_BODY = 65_536;
export function createIngress({ secret, botId, inbox, notify = () => {} }) {
  need(validSecret(secret), 'SECRET_CONFIGURATION');
  return http.createServer(async (req, res) => {
    const reply = (status, body) => { res.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store' }); res.end(JSON.stringify(body)); };
    if (req.method === 'GET' && req.url === '/health') { reply(200, { ok: true, ...inbox.counts() }); return; }
    if (req.method !== 'POST' || req.url !== '/webhook') { reply(404, { ok: false }); return; }
    if (!authorized(req.rawHeaders, secret)) { req.resume(); reply(401, { ok: false, code: 'UNAUTHORIZED' }); return; }
    if (!/^application\/json(?:\s*;|$)/i.test(req.headers['content-type'] ?? '') || req.headers['content-encoding']) { req.resume(); reply(415, { ok: false }); return; }
    const declared = Number(req.headers['content-length']);
    if (declared > MAX_BODY) { req.resume(); reply(413, { ok: false }); return; }
    const chunks = []; let bytes = 0;
    try {
      for await (const chunk of req) { bytes += chunk.length; if (bytes > MAX_BODY) { reply(413, { ok: false }); req.destroy(); return; } chunks.push(chunk); }
      const raw = JSON.parse(Buffer.concat(chunks).toString('utf8'));
      const mapped = mapUpdate(raw, botId); const result = inbox.accept(raw, mapped);
      reply(200, { ok: true, accepted: true, duplicate: result.duplicate }); notify();
    } catch (e) {
      const capacity = ['DISK_CAPACITY', 'INBOX_CAPACITY', 'ENOSPC', 'EIO'].includes(e.code ?? e.message);
      reply(capacity ? 503 : e.message === 'DUPLICATE_CONFLICT' ? 409 : 400, { ok: false, code: capacity ? 'CAPACITY' : 'INVALID_UPDATE' });
    }
  });
}

export async function jsonFetch(url, options = {}, statuses = [200]) {
  const r = await fetch(url, { ...options, redirect: 'error', signal: AbortSignal.timeout(7000) });
  need(statuses.includes(r.status), 'UPSTREAM_STATUS');
  const chunks = []; let bytes = 0;
  for await (const chunk of r.body) { bytes += chunk.length; need(bytes <= 2_097_152, 'UPSTREAM_LIMIT'); chunks.push(chunk); }
  return JSON.parse(Buffer.concat(chunks).toString('utf8'));
}

export function persistenceConfirmer(db, collections, { waitMs = 15000, sleepMs = 300 } = {}) {
  const opts = { readConcern: { level: 'majority' }, maxTimeMS: 5000 };
  return async (dto, receipt) => {
      const deadline = Date.now() + waitMs;
      do {
        const message = await db.collection(collections.messages).findOne({ id: receipt.message.id }, opts);
        if (message && message.connector === 'MAX_BOT' && message.direction === 'INBOUND'
          && message.externalMessageId === dto.externalMessageId && message.externalUserId === dto.externalUserId
          && message.externalChatId === dto.externalChatId && message.text === dto.text
          && canonical((message.attachments ?? []).map(x => ({ type: x.type, url: x.url }))) === canonical((dto.attachments ?? []).map(x => ({ type: x.type, url: x.url })))
          && message.dialogId === receipt.dialogId && message.clientId === receipt.clientId) {
          const dialog = await db.collection(collections.dialogs).findOne({ id: receipt.dialogId, clientId: receipt.clientId }, opts);
          const client = await db.collection(collections.clients).findOne({ id: receipt.clientId }, opts);
          if (dialog && client && typeof dialog.updatedAt === 'string' && dialog.updatedAt >= message.createdAt
            && Array.isArray(client.identities) && client.identities.some(x => x.connector === 'MAX_BOT' && x.externalUserId === dto.externalUserId && x.externalChatId === dto.externalChatId)) return true;
        }
        await new Promise(resolve => setTimeout(resolve, sleepMs));
      } while (Date.now() < deadline);
      return false;
  };
}

export async function main() {
  const parent = '/etc/padlhub'; const st = fs.lstatSync(parent);
  need(st.isDirectory() && !st.isSymbolicLink() && fs.realpathSync(parent) === parent && st.uid === process.getuid() && !(st.mode & 0o022), 'CONFIG_DIRECTORY');
  const config = JSON.parse(readPrivate('/etc/padlhub/max-padlhub-webhook.json', 65_536));
  need(validSecret(config.webhookSecret) && typeof config.botId === 'string', 'CONFIGURATION');
  need(config.mongo?.messages && config.mongo?.dialogs && config.mongo?.clients && config.mongo?.uri && config.mongo?.db, 'MONGO_CONFIGURATION');
  const require = createRequire(import.meta.url); const { MongoClient } = require('mongodb');
  const mongo = new MongoClient(config.mongo.uri, { serverSelectionTimeoutMS: 5000, appName: 'max-padlhub-webhook' }); await mongo.connect();
  const db = mongo.db(config.mongo.db);
  const inbox = new Inbox('/var/lib/padlhub-max-padlhub-inbound');
  const headers = { 'content-type': 'application/json', ...(config.ingressToken ? { 'x-integration-token': config.ingressToken } : {}) };
  const dispatcher = new Dispatcher(inbox, {
    ready: async () => { try { return (await jsonFetch('http://127.0.0.1:3000/api/health')).status === 'ok'; } catch { return false; } },
    post: dto => jsonFetch('http://127.0.0.1:3000/api/support/dialogs/events', { method: 'POST', headers, body: JSON.stringify(dto) }, [200, 201]),
    confirm: persistenceConfirmer(db, config.mongo),
  });
  const server = createIngress({ secret: config.webhookSecret, botId: config.botId, inbox });
  server.maxConnections = 64; server.keepAliveTimeout = 2000; server.requestTimeout = 15_000; server.headersTimeout = 10_000; server.maxHeadersCount = 32;
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(18941, '127.0.0.1', resolve); });
  let stopping = false;
  const timer = setInterval(() => { if (!stopping) dispatcher.tick().catch(() => { console.error('MAX_INGRESS_STORAGE_FAILURE'); process.exit(1); }); }, 500);
  const stop = async () => { if (stopping) return; stopping = true; dispatcher.stop(); clearInterval(timer); server.close(); while (dispatcher.running) await new Promise(resolve => setTimeout(resolve, 100)); await mongo.close(); };
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
