import test from 'node:test';
import assert from 'node:assert/strict';
import { persistenceConfirmer, postSupportEvent, MEDIA_INGEST_BUDGET_MS } from '../max_inbound_webhook/server.mjs';
import http from 'node:http';
import fs from 'node:fs';
test('durable receiver confirms original provider photo URL with additional S3 refs; rejects URL substitution', async () => {
  const at = '2026-01-01T00:00:00.000Z';
  const dto = { connector: 'MAX_BOT', externalUserId: 'synthetic-user', externalChatId: 'synthetic-chat',
    externalMessageId: 'synthetic-mid', timestamp: at, text: 'caption', kind: 'TEXT',
    attachments: [{ type: 'IMAGE', url: 'https://i.oneme.ru/synthetic-source' }] };
  const message = { ...dto, direction: 'INBOUND', id: 'message', dialogId: 'dialog', clientId: 'client', createdAt: at,
    attachments: [{ ...dto.attachments[0], mediaRef: 'cup-media:v1:synthetic', mediaScope: 'a'.repeat(64) }] };
  const receipt = { message, dialogId: 'dialog', clientId: 'client' };
  const db = { collection: name => ({ findOne: async (_query, opts) => {
    assert.equal(opts.readConcern.level, 'majority');
    return name === 'messages' ? message : { id: name === 'dialogs' ? 'dialog' : 'client', updatedAt: at,
      identities: [{ connector: 'MAX_BOT', externalUserId: dto.externalUserId, externalChatId: dto.externalChatId }] };
  } }) };
  const confirm = persistenceConfirmer(db, { messages: 'messages', dialogs: 'dialogs', clients: 'clients' }, { waitMs: 0, sleepMs: 0 });
  assert.equal(await confirm(dto, receipt), true);
  message.attachments[0].url = 'https://synthetic-storage.invalid/changed';
  assert.equal(await confirm(dto, receipt), false);
});
test('text and photo ingestion allow a slow photo-template stage; stop budget includes response and majority confirmation', async t => {
  let calls = 0;
  const server = http.createServer(async (req, res) => {
    calls++; req.resume();
    await new Promise(resolve => setTimeout(resolve, 7500));
    res.writeHead(201, { 'content-type': 'application/json' }); res.end(JSON.stringify({ ok: true, message: { id: 'committed' } }));
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve)); t.after(() => new Promise(resolve => server.close(resolve)));
  const url = `http://127.0.0.1:${server.address().port}/`;
  const config = { mediaIngressToken: 'synthetic-media-token-over-thirty-two-bytes' };
  const result = await postSupportEvent(config, { text: 'text that triggers a photo-template' }, url);
  assert.equal(result.message.id, 'committed'); assert.equal(calls, 1);
  assert.equal(MEDIA_INGEST_BUDGET_MS, 90000);
  const service = fs.readFileSync(new URL('../max_inbound_webhook/padlhub-max-inbound.service', import.meta.url), 'utf8');
  assert(Number(service.match(/TimeoutStopSec=(\d+)/)[1]) * 1000 > MEDIA_INGEST_BUDGET_MS + 15000);
});
test('majority confirmation shares one client-side timeout budget across all sequential reads', async () => {
  const at = new Date().toISOString(), timeouts = [];
  const dto = { externalMessageId: 'synthetic-mid', externalUserId: 'synthetic-user', externalChatId: 'synthetic-chat', text: 'synthetic' };
  const message = { ...dto, id: 'm', dialogId: 'd', clientId: 'c', connector: 'MAX_BOT', direction: 'INBOUND', createdAt: at };
  const db = { collection: name => ({ findOne: async (_query, opts) => {
    timeouts.push(opts.timeoutMS); assert.equal(opts.timeoutMS, opts.maxTimeMS); assert(opts.timeoutMS > 0);
    if (name === 'messages') { await new Promise(r => setTimeout(r, 60)); return message; }
    // Model the Mongo driver's timeoutMS: the second read exhausts remaining shared budget.
    await new Promise(r => setTimeout(r, opts.timeoutMS)); throw Error('synthetic CSOT deadline');
  } }) };
  const begin = performance.now();
  const confirm = persistenceConfirmer(db, { messages: 'messages', dialogs: 'dialogs', clients: 'clients' }, { waitMs: 100, sleepMs: 0 });
  const result = await confirm(dto, { message, dialogId: 'd', clientId: 'c' });
  assert.equal(result, false); assert.equal(timeouts.length, 2); assert(timeouts[1] < timeouts[0]);
  assert(performance.now() - begin < 500, 'No extra third full-duration read or unconditional poll sleep');
});
