import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

export const sha = value => crypto.createHash('sha256').update(value).digest('hex');
export const need = (condition, code) => { if (!condition) throw new Error(code); };
const object = x => x && typeof x === 'object' && !Array.isArray(x);
const stable = x => Array.isArray(x) ? x.map(stable) : object(x) ? Object.fromEntries(Object.keys(x).sort().map(k => [k, stable(x[k])])) : x;
export const canonical = x => JSON.stringify(stable(x));
const id = x => {
  if (typeof x === 'number') { need(Number.isSafeInteger(x), 'UNSAFE_ID'); return String(x); }
  need(typeof x === 'string' && x.length > 0 && x.length <= 200 && ![...x].some(char => char.charCodeAt(0) <= 0x20), 'INVALID_ID'); return x;
};
const syncDirectory = dir => { const fd = fs.openSync(dir, fs.constants.O_RDONLY | fs.constants.O_DIRECTORY); try { fs.fsyncSync(fd); } finally { fs.closeSync(fd); } };
export function privateDirectory(dir) {
  const st = fs.lstatSync(dir);
  need(st.isDirectory() && !st.isSymbolicLink() && fs.realpathSync(dir) === path.resolve(dir)
    && st.uid === process.getuid() && (st.mode & 0o777) === 0o700, 'DIRECTORY_CUSTODY');
}
export function readPrivate(file, maxBytes = 1_048_576) {
  const fd = fs.openSync(file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK);
  try { const st = fs.fstatSync(fd); need(st.isFile() && st.uid === process.getuid() && st.nlink === 1 && (st.mode & 0o777) === 0o600 && st.size <= maxBytes, 'FILE_CUSTODY'); return fs.readFileSync(fd); }
  finally { fs.closeSync(fd); }
}
export function validSecret(secret) { return typeof secret === 'string' && /^[a-f0-9]{64}$/.test(secret); }
export function authorized(rawHeaders, secret) {
  need(validSecret(secret), 'SECRET_CONFIGURATION');
  const values = [];
  for (let i = 0; i < rawHeaders.length; i += 2) if (rawHeaders[i].toLowerCase() === 'x-max-bot-api-secret') values.push(rawHeaders[i + 1]);
  if (values.length !== 1 || !validSecret(values[0])) return false;
  return crypto.timingSafeEqual(Buffer.from(values[0]), Buffer.from(secret));
}

// Provider fields supply content, never connector, credentials, phone ownership or routing overrides.
export function mapUpdate(raw, botId) {
  need(object(raw) && raw.update_type === 'message_created', 'UNSUPPORTED_UPDATE');
  const m = raw.message; need(object(m) && object(m.sender) && object(m.recipient), 'INVALID_MESSAGE');
  const user = id(m.sender.user_id), chat = id(m.recipient.chat_id);
  const mid = m.body === null ? `bodyless-${sha(canonical(raw))}` : id(m.body?.mid);
  if (m.sender.is_bot === true) return { ignored: 'BOT_ECHO', key: sha(`MAX_BOT\0${mid}`) };
  need(m.sender.is_bot === false, 'SENDER_CLASSIFICATION');
  if (m.recipient.chat_type !== 'dialog') return { ignored: 'NON_DIALOG', key: sha(`MAX_BOT\0${mid}`) };
  if (m.recipient.user_id !== undefined && m.recipient.user_id !== null) need(id(m.recipient.user_id) === botId, 'WRONG_BOT');
  if (m.body === null) return { key: sha(`MAX_BOT\0message_created\0${mid}`), hash: sha(canonical(raw)), dtos: [], review: 'BODYLESS_MESSAGE' };
  need(object(m.body), 'INVALID_MESSAGE');
  const timestamp = m.timestamp ?? raw.timestamp;
  need(Number.isSafeInteger(timestamp) && timestamp > 0 && timestamp < 8_640_000_000_000_000, 'INVALID_TIMESTAMP');
  const at = new Date(timestamp).toISOString();
  need(m.body.text === undefined || m.body.text === null || typeof m.body.text === 'string', 'INVALID_TEXT');
  need(m.body.attachments === undefined || m.body.attachments === null || Array.isArray(m.body.attachments), 'INVALID_ATTACHMENTS');
  const attachments = m.body.attachments ?? []; need(attachments.length <= 30, 'TOO_MANY_ATTACHMENTS');
  const images = [], types = [];
  for (const attachment of attachments) {
    need(object(attachment) && typeof attachment.type === 'string' && /^[a-z_]{1,40}$/.test(attachment.type), 'INVALID_ATTACHMENT');
    types.push(attachment.type);
    if (attachment.type === 'image') {
      const value = attachment.payload?.url;
      if (typeof value === 'string' && value.length <= 8000) {
        try { const u = new URL(value); if (u.protocol === 'https:' && !u.username && !u.password && !u.hash) images.push({ type: 'IMAGE', url: value }); } catch { /* raw attachment remains in metadata/inbox */ }
      }
    }
  }
  let text = (m.body.text ?? '').trim();
  if (!text) text = types.length ? `[Вложение MAX: ${types.join(', ')}]` : '[Сообщение MAX без текста]';
  // Preserve long messages in full as bounded ordered parts accepted by the current CUP DTO.
  const chunks = []; for (let i = 0; i < text.length; i += 1900) { const chunk = text.slice(i, i + 1900).trim(); if (chunk) chunks.push(chunk); }
  need(chunks.length <= 40 && images.length <= 10, 'MESSAGE_TOO_LARGE');
  const name = [m.sender.first_name, m.sender.last_name].filter(x => typeof x === 'string').join(' ').trim().slice(0, 160) || 'Клиент MAX';
  const key = sha(`MAX_BOT\0message_created\0${mid}`);
  const dtos = chunks.map((chunk, index) => ({
    connector: 'MAX_BOT', channel: 'MAX', direction: 'INBOUND', authorType: 'CLIENT', senderIsBot: false,
    deliverToClient: false, externalUserId: user, externalChatId: chat,
    externalMessageId: index === 0 ? mid : `max-part-${key}-${index + 1}`,
    displayName: name, senderName: name, timestamp: at, text: chunk,
    kind: 'TEXT',
    ...(index === 0 && images.length ? { attachments: images } : {}),
    meta: { provider: 'max', maxWebhook: { mid, part: index + 1, parts: chunks.length, raw } },
  }));
  return { key, dtos, hash: sha(canonical(raw)) };
}

export class Inbox {
  constructor(dir, { maxRecords = 20_000, maxBytes = 1_073_741_824, minFreeBytes = 268_435_456 } = {}) {
    privateDirectory(dir); this.dir = dir; this.maxRecords = maxRecords; this.maxBytes = maxBytes; this.minFreeBytes = minFreeBytes;
    this.index = new Map(); this.bytes = 0;
    for (const name of fs.readdirSync(dir)) {
      if (!/^[a-f0-9]{64}\.json$/.test(name)) { need(name.startsWith('.tmp-') || name === '.runtime.lock', 'UNKNOWN_INBOX_FILE'); if (name === '.runtime.lock') readPrivate(path.join(dir, name), 1024); continue; }
      const record = this.read(name.slice(0, 64)); this.index.set(record.key, this.summary(record)); this.bytes += fs.statSync(path.join(dir, name)).size;
    }
  }
  summary(r) { return { phase: r.phase, acceptedAt: r.acceptedAt }; }
  read(key) {
    need(/^[a-f0-9]{64}$/.test(key), 'INVALID_KEY');
    const r = JSON.parse(readPrivate(path.join(this.dir, key + '.json'), 4_194_304));
    need(r.version === 1 && r.key === key && r.hash === sha(canonical(r.raw)) && Array.isArray(r.dtos) && r.dtoHash === sha(canonical(r.dtos))
      && Number.isSafeInteger(r.nextPart) && r.nextPart >= 0 && r.nextPart <= r.dtos.length
      && ['QUEUED', 'DISPATCH_INTENT', 'RECEIPT', 'DELIVERED', 'REVIEW', 'IGNORED'].includes(r.phase), 'INBOX_CORRUPT');
    return r;
  }
  write(record, exclusive = false) {
    privateDirectory(this.dir); const target = path.join(this.dir, record.key + '.json');
    const oldSize = exclusive ? 0 : readPrivate(target, 4_194_304).length;
    const body = Buffer.from(JSON.stringify(record) + '\n'); need(body.length <= 4_194_304, 'RECORD_TOO_LARGE');
    need(this.bytes - oldSize + body.length <= this.maxBytes, 'INBOX_CAPACITY');
    const tmp = path.join(this.dir, '.tmp-' + crypto.randomUUID());
    const fd = fs.openSync(tmp, fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_NOFOLLOW, 0o600);
    try { fs.writeFileSync(fd, body); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
    try { if (exclusive) need(!fs.existsSync(target), 'EXISTING_RECORD'); fs.renameSync(tmp, target); syncDirectory(this.dir); }
    catch (e) { if (fs.existsSync(tmp)) fs.unlinkSync(tmp); throw e; }
    this.bytes += body.length - oldSize; this.index.set(record.key, this.summary(record));
  }
  accept(raw, mapped) {
    if (this.index.has(mapped.key) || fs.existsSync(path.join(this.dir, mapped.key + '.json'))) {
      const prior = this.read(mapped.key); need(prior.hash === sha(canonical(raw)), 'DUPLICATE_CONFLICT');
      // Reconcile a published file after a directory-fsync error; never overwrite or POST here.
      const fd = fs.openSync(path.join(this.dir, mapped.key + '.json'), fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK);
      try { fs.fsyncSync(fd); } finally { fs.closeSync(fd); } syncDirectory(this.dir);
      if (!this.index.has(mapped.key)) { this.bytes += fs.statSync(path.join(this.dir, mapped.key + '.json')).size; this.index.set(mapped.key, this.summary(prior)); }
      return { duplicate: true, key: mapped.key };
    }
    const capacity = fs.statfsSync(this.dir); need(Number(capacity.bavail) * Number(capacity.bsize) >= this.minFreeBytes, 'DISK_CAPACITY');
    need(this.index.size < this.maxRecords, 'INBOX_CAPACITY');
    const record = { version: 1, key: mapped.key, hash: sha(canonical(raw)), raw, dtos: mapped.dtos ?? [],
      dtoHash: sha(canonical(mapped.dtos ?? [])), phase: mapped.ignored ? 'IGNORED' : mapped.review ? 'REVIEW' : 'QUEUED', ignored: mapped.ignored, reason: mapped.review, nextPart: 0, acceptedAt: new Date().toISOString() };
    this.write(record, true); return { duplicate: false, key: mapped.key };
  }
  counts() { const counts = { records: this.index.size, bytes: this.bytes }; for (const r of this.index.values()) counts[r.phase] = (counts[r.phase] ?? 0) + 1; return counts; }
  pending() { return [...this.index].filter(([, x]) => ['QUEUED', 'DISPATCH_INTENT', 'RECEIPT'].includes(x.phase)).sort((a, b) => a[1].acceptedAt.localeCompare(b[1].acceptedAt)).map(([key]) => key); }
}

export class Dispatcher {
  constructor(inbox, { ready, post, confirm }) { Object.assign(this, { inbox, ready, post, confirm }); this.running = false; this.stopping = false; }
  stop() { this.stopping = true; }
  async tick() {
    if (this.running || this.stopping) return; this.running = true;
    try { for (const key of this.inbox.pending()) { if (this.stopping) break; await this.process(key); } }
    finally { this.running = false; }
  }
  async process(key) {
    let r = this.inbox.read(key);
    // An intent surviving a crash is uncertain. It must never become a second POST.
    if (r.phase === 'DISPATCH_INTENT') { r.phase = 'REVIEW'; r.reason = 'UNKNOWN_DISPATCH'; this.inbox.write(r); return; }
    if (r.phase === 'RECEIPT') { await this.verify(r); return; }
    if (r.phase !== 'QUEUED' || this.stopping || !await this.ready() || this.stopping) return;
    r.phase = 'DISPATCH_INTENT'; this.inbox.write(r);
    let receipt;
    try { receipt = await this.post(r.dtos[r.nextPart]); }
    catch { r.phase = 'REVIEW'; r.reason = 'UNKNOWN_DISPATCH'; this.inbox.write(r); return; }
    if (!receipt || !object(receipt.message) || !object(receipt.dialog) || !object(receipt.client)
      || typeof receipt.message.id !== 'string' || receipt.message.externalMessageId !== r.dtos[r.nextPart].externalMessageId
      || receipt.message.connector !== 'MAX_BOT' || receipt.message.direction !== 'INBOUND') {
      r.phase = 'REVIEW'; r.reason = 'INVALID_RECEIPT'; this.inbox.write(r); return;
    }
    r.phase = 'RECEIPT'; r.receipt = { message: receipt.message, dialogId: receipt.dialog.id, clientId: receipt.client.id };
    this.inbox.write(r); await this.verify(r);
  }
  async verify(r) {
    let confirmed = false; try { confirmed = await this.confirm(r.dtos[r.nextPart], r.receipt); } catch { /* no provider/CUP replay */ }
    if (!confirmed) { r.phase = 'REVIEW'; r.reason = 'PERSISTENCE_UNCONFIRMED'; this.inbox.write(r); return; }
    r.nextPart += 1; delete r.receipt;
    r.phase = r.nextPart < r.dtos.length ? 'QUEUED' : 'DELIVERED'; this.inbox.write(r);
  }
}
