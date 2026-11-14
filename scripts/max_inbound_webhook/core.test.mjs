import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { Inbox, Dispatcher, authorized, mapUpdate, sha } from './core.mjs';
import { createIngress, persistenceConfirmer } from './server.mjs';

const secret = 'a'.repeat(64);
const event = (mid = 'synthetic-mid') => ({ update_type: 'message_created', timestamp: 1794654000000,
  message: { timestamp: 1794654000000, sender: { user_id: 111, is_bot: false, first_name: 'Synthetic' },
    recipient: { chat_id: 222, user_id: 333, chat_type: 'dialog' }, body: { mid, text: 'synthetic incoming' } } });
function fixture(t, options) { const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'max-inbox-test-'))); fs.chmodSync(dir, 0o700); t.after(() => fs.rmSync(dir, { recursive: true, force: true })); return new Inbox(dir, { minFreeBytes: 0, ...options }); }
const receipt = dto => ({ message: { id: 'synthetic-cup-id', connector: 'MAX_BOT', direction: 'INBOUND', externalMessageId: dto.externalMessageId }, dialog: { id: 'synthetic-dialog' }, client: { id: 'synthetic-client' } });

test('mandatory exact single secret; duplicate and malformed header refused', () => {
  assert.equal(authorized(['X-Max-Bot-Api-Secret', secret], secret), true);
  for (const headers of [[], ['X-Max-Bot-Api-Secret', 'b'.repeat(64)], ['X-Max-Bot-Api-Secret', secret, 'x-max-bot-api-secret', secret], ['X-Max-Bot-Api-Secret', secret + ', ' + secret]]) assert.equal(authorized(headers, secret), false);
  assert.throws(() => authorized([], ''), /SECRET_CONFIGURATION/);
});
test('mapper fixes identity/channel, preserves timestamps, does not trust contacts or overrides', () => {
  const raw = event(); raw.connector = 'MAX_ACADEMY_BOT'; raw.phone = 'synthetic-phone'; raw.url = 'https://invalid.example/';
  raw.message.body.attachments = [{ type: 'contact', payload: { phone: 'synthetic-contact' } }];
  const dto = mapUpdate(raw, '333').dtos[0]; assert.equal(dto.connector, 'MAX_BOT'); assert.equal(dto.externalUserId, '111'); assert.equal(dto.externalChatId, '222');
  assert.equal(dto.timestamp, new Date(raw.timestamp).toISOString()); assert.equal(dto.kind, 'TEXT'); assert.equal(dto.phone, undefined); assert.equal(dto.stationId, undefined); assert.equal(dto.attachments, undefined);
  assert.equal(dto.meta.maxWebhook.raw, raw); assert.equal(dto.deliverToClient, false);
});
test('images use current CUP DTO; other attachments remain intact without unsafe fetch', () => {
  const raw = event(); raw.message.body.attachments = [{ type: 'image', payload: { url: 'https://cdn.example/synthetic.jpg' } }, { type: 'file', payload: { token: 'synthetic' } }];
  const dto = mapUpdate(raw, '333').dtos[0]; assert.deepEqual(dto.attachments, [{ type: 'IMAGE', url: 'https://cdn.example/synthetic.jpg' }]); assert.equal(dto.meta.maxWebhook.raw.message.body.attachments.length, 2);
  raw.message.body.attachments[0].payload.url = 'http://127.0.0.1/private'; assert.equal(mapUpdate(raw, '333').dtos[0].attachments, undefined);
});
test('long text maps ordered bounded parts without dropping any text', () => {
  const raw = event(); raw.message.body.text = 'x'.repeat(4200); const mapped = mapUpdate(raw, '333');
  assert.equal(mapped.dtos.length, 3); assert.equal(mapped.dtos.map(x => x.text).join(''), raw.message.body.text);
  assert.equal(new Set(mapped.dtos.map(x => x.externalMessageId)).size, 3); assert.ok(mapped.dtos.every(x => x.text.length <= 2000 && x.externalMessageId.length <= 200));
});
test('unsafe IDs/wrong bot/unsupported events cannot become client messages; echoes ignored', () => {
  const raw = event(); raw.message.sender.user_id = Number.MAX_SAFE_INTEGER + 1; assert.throws(() => mapUpdate(raw, '333'), /UNSAFE_ID/);
  for (let code = 0; code <= 0x20; code++) { const bad = event(); bad.message.sender.user_id = 'id' + String.fromCharCode(code); assert.throws(() => mapUpdate(bad, '333'), /INVALID_ID/); }
  const valid = event(); valid.message.sender.user_id = '!client'; assert.equal(mapUpdate(valid, '333').dtos[0].externalUserId, '!client');
  assert.throws(() => mapUpdate(event(), '444'), /WRONG_BOT/); assert.throws(() => mapUpdate({ update_type: 'bot_started' }, '333'), /UNSUPPORTED_UPDATE/);
  const echo = event(); echo.message.sender.is_bot = true; assert.equal(mapUpdate(echo, '333').ignored, 'BOT_ECHO');
});
test('durable admission, canonical duplicate and conflict survive reconstruction', t => {
  let inbox = fixture(t); const raw = event(); const mapped = mapUpdate(raw, '333'); inbox.accept(raw, mapped);
  inbox = new Inbox(inbox.dir, { minFreeBytes: 0 }); assert.equal(inbox.counts().QUEUED, 1); assert.equal(inbox.accept(JSON.parse(JSON.stringify(raw)), mapped).duplicate, true);
  const changed = event(); changed.message.body.text = 'changed'; assert.throws(() => inbox.accept(changed, mapUpdate(changed, '333')), /DUPLICATE_CONFLICT/);
  const file = path.join(inbox.dir, mapped.key + '.json'); assert.equal(fs.statSync(file).mode & 0o777, 0o600); fs.chmodSync(file, 0o644); assert.throws(() => inbox.read(mapped.key), /FILE_CUSTODY/);
});
test('capacity failure does not acknowledge or publish a new record', t => {
  const inbox = fixture(t, { maxRecords: 0 }); const raw = event(); assert.throws(() => inbox.accept(raw, mapUpdate(raw, '333')), /INBOX_CAPACITY/); assert.deepEqual(fs.readdirSync(inbox.dir), []);
});
test('ready failure keeps queued, then ONE dispatch and persistence confirmation', async t => {
  const inbox = fixture(t); const raw = event(); inbox.accept(raw, mapUpdate(raw, '333')); let ready = false, posts = 0;
  const worker = new Dispatcher(inbox, { ready: async () => ready, post: async dto => { posts++; return receipt(dto); }, confirm: async () => true });
  await worker.tick(); assert.equal(posts, 0); assert.equal(inbox.counts().QUEUED, 1); ready = true; await Promise.all([worker.tick(), worker.tick()]);
  assert.equal(posts, 1); assert.equal(inbox.counts().DELIVERED, 1); await worker.tick(); assert.equal(posts, 1);
});
test('crash after dispatch intent and lost response never create another POST', async t => {
  let inbox = fixture(t); const raw = event(); const mapped = mapUpdate(raw, '333'); inbox.accept(raw, mapped); let r = inbox.read(mapped.key); r.phase = 'DISPATCH_INTENT'; inbox.write(r); let posts = 0;
  const worker = new Dispatcher(new Inbox(inbox.dir, { minFreeBytes: 0 }), { ready: async () => true, post: async () => { posts++; }, confirm: async () => true }); await worker.tick(); assert.equal(posts, 0); assert.equal(worker.inbox.counts().REVIEW, 1); inbox = worker.inbox;
  const raw2 = event('lost-response'); inbox.accept(raw2, mapUpdate(raw2, '333')); const lost = new Dispatcher(inbox, { ready: async () => true, post: async () => { posts++; throw Error('timeout'); }, confirm: async () => true }); await lost.tick(); await lost.tick(); assert.equal(posts, 1); assert.equal(inbox.counts().REVIEW, 2);
});
test('HTTP200 without durable persistence is REVIEW, retained and never repeated', async t => {
  const inbox = fixture(t); const raw = event(); inbox.accept(raw, mapUpdate(raw, '333')); let posts = 0;
  const worker = new Dispatcher(inbox, { ready: async () => true, post: async dto => { posts++; return receipt(dto); }, confirm: async () => false });
  await worker.tick(); await worker.tick(); assert.equal(posts, 1); assert.equal(inbox.counts().REVIEW, 1); assert.equal(inbox.read(mapUpdate(raw, '333').key).reason, 'PERSISTENCE_UNCONFIRMED');
});
test('crash after CUP receipt can confirm persistence after restart without another POST', async t => {
  const inbox = fixture(t); const raw = event(); const mapped = mapUpdate(raw, '333'); inbox.accept(raw, mapped); const r = inbox.read(mapped.key); r.phase = 'RECEIPT'; const rec = receipt(r.dtos[0]); r.receipt = { message: rec.message, clientId: rec.client.id, dialogId: rec.dialog.id }; inbox.write(r); let posts = 0;
  const worker = new Dispatcher(new Inbox(inbox.dir, { minFreeBytes: 0 }), { ready: async () => true, post: async () => { posts++; }, confirm: async () => true }); await worker.tick(); assert.equal(posts, 0); assert.equal(worker.inbox.counts().DELIVERED, 1);
});
test('Mongo confirmer uses majority reads and checks message/client/dialog links', async () => {
  const dto = mapUpdate(event(), '333').dtos[0], r = receipt(dto); r.message = { ...r.message, id: 'm', dialogId: 'd', clientId: 'c', externalUserId: dto.externalUserId, externalChatId: dto.externalChatId, text: dto.text, createdAt: dto.timestamp }; const rec = { message: r.message, dialogId: 'd', clientId: 'c' }; let correct = true; const calls = [];
  const db = { collection: name => ({ findOne: async (query, options) => { calls.push({ name, query, options }); return name === 'messages' ? { ...r.message, externalMessageId: correct ? dto.externalMessageId : 'foreign' } : { id: name === 'dialogs' ? 'd' : 'c', updatedAt: dto.timestamp, identities: [{ connector: 'MAX_BOT', externalUserId: dto.externalUserId, externalChatId: dto.externalChatId }] }; } }) };
  const confirm = persistenceConfirmer(db, { messages: 'messages', clients: 'clients', dialogs: 'dialogs' }, { waitMs: 0, sleepMs: 0 }); assert.equal(await confirm(dto, rec), true); correct = false; assert.equal(await confirm(dto, rec), false); assert.ok(calls.every(x => x.options.readConcern.level === 'majority'));
});
function request(port, body, headers) { return new Promise((resolve, reject) => { const req = http.request({ host: '127.0.0.1', port, path: '/webhook', method: 'POST', headers }, res => { const chunks = []; res.on('data', x => chunks.push(x)); res.on('end', () => resolve({ status: res.statusCode, body: Buffer.concat(chunks).toString() })); }); req.on('error', reject); req.end(body); }); }
test('real HTTP server auth rejects BEFORE disk admission; valid POST is durably accepted and deduped', async t => {
  const inbox = fixture(t); const server = createIngress({ secret, botId: '333', inbox }); await new Promise(resolve => server.listen(0, '127.0.0.1', resolve)); t.after(() => new Promise(resolve => server.close(resolve))); const port = server.address().port; const raw = event(); raw.message.body.attachments = null; const body = JSON.stringify(raw);
  for (const headers of [{ 'content-type': 'application/json' }, { 'content-type': 'application/json', 'x-max-bot-api-secret': 'b'.repeat(64) }, { 'content-type': 'application/json', 'x-max-bot-api-secret': [secret, secret] }]) assert.equal((await request(port, body, headers)).status, 401);
  assert.equal(inbox.counts().records, 0);
  const headers = { 'content-type': 'application/json', 'x-max-bot-api-secret': secret }; assert.equal((await request(port, body, headers)).status, 200); assert.equal(inbox.counts().QUEUED, 1); assert.equal((await request(port, body, headers)).status, 200); assert.equal(inbox.counts().records, 1);
  assert.equal((await request(port, '{}', { ...headers, 'content-type': 'text/plain' })).status, 415); assert.equal((await request(port, '{', headers)).status, 400); assert.equal((await request(port, 'x'.repeat(70_000), headers)).status, 413);
});

test('nginx patch changes one unique anchor and refuses drift/duplicate', async () => {
  const { patchNginx, LOCATION } = await import('./nginx_patch.mjs'); const source = Buffer.from('server {\n    listen 443 ssl;\n    location ^~ /api/ {\n    }\n}\n'); const output = patchNginx(source, sha(source)); assert.equal(output.toString(), source.toString().replace('    location ^~ /api/ {', LOCATION + '    location ^~ /api/ {'));
  assert.throws(() => patchNginx(source, '0'.repeat(64)), /DRIFT/); assert.throws(() => patchNginx(output, sha(output)), /SHAPE/);
  for (const indent of ['', '\t', '  ']) { const raw = Buffer.from(source.toString().replace('    location', indent + 'location')); const result = patchNginx(raw, sha(raw)); assert.equal(result.toString(), raw.toString().replace(indent + 'location ^~ /api/ {', LOCATION + indent + 'location ^~ /api/ {')); }
  for (const text of ['# location ^~ /api/ {', 'location ^~ /api/ {\nlocation ^~ /api/ {', 'location ^~ /api/ { # ambiguous']) { const raw = Buffer.from(text); assert.throws(() => patchNginx(raw, sha(raw)), /SHAPE/); }
  const commented = Buffer.from('# location ^~ /api/ {\nserver {\nlocation ^~ /api/ {\n}\n}\n'); assert.equal(patchNginx(commented, sha(commented)).toString(), '# location ^~ /api/ {\nserver {\n' + LOCATION + 'location ^~ /api/ {\n}\n}\n');
});
test('CUP redirects cannot forward integration credential to another server', async t => {
  const { jsonFetch } = await import('./server.mjs'); let reached = 0; const target = http.createServer((req, res) => { reached++; res.end('{}'); }); await new Promise(resolve => target.listen(0, '127.0.0.1', resolve)); t.after(() => new Promise(resolve => target.close(resolve)));
  const redirect = http.createServer((req, res) => { res.writeHead(307, { location: `http://127.0.0.1:${target.address().port}/` }); res.end(); }); await new Promise(resolve => redirect.listen(0, '127.0.0.1', resolve)); t.after(() => new Promise(resolve => redirect.close(resolve)));
  await assert.rejects(jsonFetch(`http://127.0.0.1:${redirect.address().port}/`, { headers: { 'x-integration-token': 'synthetic-credential' } })); assert.equal(reached, 0);
});

test('valid nullable attachments accepted; bodyless provider event retained for review without dispatch', t => {
 const inbox = fixture(t); const raw = event(); raw.message.body.attachments = null; assert.equal(mapUpdate(raw, '333').dtos[0].text, raw.message.body.text);
 raw.message.body = null; const mapped = mapUpdate(raw, '333'); inbox.accept(raw, mapped); assert.equal(inbox.counts().REVIEW, 1); assert.equal(inbox.pending().length, 0); assert.deepEqual(inbox.read(mapped.key).raw, raw);
});

test('trimmed chunk boundaries match CUP normalization and preserve all non-whitespace content', () => {
  const raw = event(); raw.message.body.text = 'x'.repeat(1899) + ' ' + 'y'.repeat(2000); const dtos = mapUpdate(raw, '333').dtos;
  assert.ok(dtos.every(x => x.text === x.text.trim())); assert.equal(dtos.map(x => x.text).join('').replaceAll(' ', ''), raw.message.body.text.replaceAll(' ', ''));
});
test('POST 201 receipt is confirmed and becomes delivered', async t => {
  const { jsonFetch } = await import('./server.mjs'); const mock = http.createServer(async (req, res) => { const chunks = []; for await (const chunk of req) chunks.push(chunk); const dto = JSON.parse(Buffer.concat(chunks)); res.writeHead(201, { 'content-type': 'application/json' }); res.end(JSON.stringify(receipt(dto))); });
  await new Promise(resolve => mock.listen(0, '127.0.0.1', resolve)); t.after(() => new Promise(resolve => mock.close(resolve)));
  const inbox = fixture(t), raw = event(); inbox.accept(raw, mapUpdate(raw, '333'));
  const worker = new Dispatcher(inbox, { ready: async () => true, post: dto => jsonFetch(`http://127.0.0.1:${mock.address().port}/`, { method: 'POST', body: JSON.stringify(dto) }, [200, 201]), confirm: async () => true });
  await worker.tick(); assert.equal(inbox.counts().DELIVERED, 1);
});
test('directory-fsync publication failure is reconciled on retry without overwrite/hardlinks', t => {
  const inbox = fixture(t), raw = event(), mapped = mapUpdate(raw, '333'); const original = fs.fsyncSync; let failed = false;
  fs.fsyncSync = fd => { if (!failed && fs.fstatSync(fd).isDirectory()) { failed = true; const e = new Error('synthetic'); e.code = 'EIO'; throw e; } return original(fd); };
  try { assert.throws(() => inbox.accept(raw, mapped)); } finally { fs.fsyncSync = original; }
  assert.equal(inbox.counts().records, 0); assert.equal(fs.statSync(path.join(inbox.dir, mapped.key + '.json')).nlink, 1);
  assert.equal(inbox.accept(raw, mapped).duplicate, true); assert.equal(inbox.counts().QUEUED, 1); assert.equal(inbox.pending().length, 1);
});
test('crash temporary file never becomes a committed inbox record', t => {
  const inbox = fixture(t); fs.writeFileSync(path.join(inbox.dir, '.tmp-synthetic-crash'), '{"partial":true}', { mode: 0o600 }); const restored = new Inbox(inbox.dir, { minFreeBytes: 0 }); assert.equal(restored.counts().records, 0);
  const raw = event(); restored.accept(raw, mapUpdate(raw, '333')); assert.equal(restored.counts().QUEUED, 1);
});
test('stop while ready check is pending prevents a new dispatch intent and POST', async t => {
  const inbox = fixture(t); const raw = event(); inbox.accept(raw, mapUpdate(raw, '333')); let release, posts = 0; const waiting = new Promise(resolve => { release = resolve; });
  const worker = new Dispatcher(inbox, { ready: async () => { await waiting; return true; }, post: async () => { posts++; }, confirm: async () => true }); const run = worker.tick(); worker.stop(); release(); await run;
  assert.equal(posts, 0); assert.equal(inbox.counts().QUEUED, 1);
});
test('stop drains current bounded operation but starts no next queued event', async t => {
  const inbox = fixture(t); for (const mid of ['one', 'two']) { const raw = event(mid); inbox.accept(raw, mapUpdate(raw, '333')); } let worker, posts = 0;
  worker = new Dispatcher(inbox, { ready: async () => true, post: async dto => { posts++; worker.stop(); return receipt(dto); }, confirm: async () => true }); await worker.tick(); assert.equal(posts, 1); assert.equal(inbox.counts().DELIVERED, 1); assert.equal(inbox.counts().QUEUED, 1);
});
test('FIFO is refused promptly before reading local configuration', async t => {
  const { spawnSync } = await import('node:child_process'); const inbox = fixture(t), pipe = path.join(inbox.dir, 'fixture-fifo'); assert.equal(spawnSync('mkfifo', [pipe]).status, 0);
  const source = `import {readPrivate} from ${JSON.stringify(new URL('./core.mjs', import.meta.url).href)};try{readPrivate(${JSON.stringify(pipe)})}catch{process.exit(42)}`;
  const result = spawnSync(process.execPath, ['--input-type=module', '-e', source], { timeout: 1500 }); assert.equal(result.status, 42); assert.equal(result.error, undefined);
});

test('real lifetime flock remains held while wrapper forwards repeated stop and child drains', async t => {
  const { spawn, spawnSync } = await import('node:child_process');
  if (spawnSync('/usr/bin/flock', ['--version']).error?.code === 'ENOENT') { t.skip('Linux flock fixture runs in CI'); return; }
  const inbox = fixture(t), lock = path.join(inbox.dir, '.runtime.lock'), ready = path.join(inbox.dir, 'ready'), drained = path.join(inbox.dir, 'drained'), entry = path.join(inbox.dir, 'child.mjs'); fs.writeFileSync(lock, '', { mode: 0o600 });
  fs.writeFileSync(entry, `import fs from 'node:fs';import{memoizedStop}from ${JSON.stringify(new URL('./server.mjs', import.meta.url).href)};const stop=memoizedStop(async()=>{await new Promise(r=>setTimeout(r,250));fs.writeFileSync(${JSON.stringify(drained)},'once')});process.on('SIGTERM',()=>{stop().then(()=>process.exit(0)).catch(()=>process.exit(1))});fs.writeFileSync(${JSON.stringify(ready)},'ready');setInterval(()=>{},1000);`, { mode: 0o600 });
  const code = `import{launchLocked}from ${JSON.stringify(new URL('./server.mjs', import.meta.url).href)};launchLocked({directory:${JSON.stringify(inbox.dir)},entry:${JSON.stringify(entry)}});`;
  const parent = spawn(process.execPath, ['--input-type=module', '-e', code], { stdio: 'ignore' }); t.after(() => { if (parent.exitCode === null) parent.kill('SIGKILL'); });
  const exit = new Promise(resolve => parent.once('exit', resolve)); const deadline = Date.now() + 3000;
  while (!fs.existsSync(ready)) { assert.ok(Date.now() < deadline); await new Promise(resolve => setTimeout(resolve, 10)); }
  assert.notEqual(spawnSync('/usr/bin/flock', ['-n', lock, 'true']).status, 0); parent.kill('SIGTERM'); await new Promise(resolve => setTimeout(resolve, 20)); parent.kill('SIGTERM'); await new Promise(resolve => setTimeout(resolve, 30));
  assert.notEqual(spawnSync('/usr/bin/flock', ['-n', lock, 'true']).status, 0); assert.equal(await exit, 0); assert.equal(fs.readFileSync(drained, 'utf8'), 'once'); assert.equal(spawnSync('/usr/bin/flock', ['-n', lock, 'true']).status, 0);
  assert.match(fs.readFileSync(new URL('./padlhub-max-inbound.service', import.meta.url), 'utf8'), /^KillMode=mixed$/m);
});

test('actual production shutdown helper returns one pending promise for repeated signals', async () => {
 const { memoizedStop } = await import('./server.mjs'); let release, calls=0, finished=false; const waiting=new Promise(r=>{release=r}); const stop=memoizedStop(async()=>{calls++;await waiting;finished=true}); const first=stop(),second=stop(); assert.equal(first,second); await Promise.resolve(); assert.equal(calls,1); assert.equal(finished,false); release(); await Promise.all([first,second]); assert.equal(finished,true); assert.equal(calls,1);
});
