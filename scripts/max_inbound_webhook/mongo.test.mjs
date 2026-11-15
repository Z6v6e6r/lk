import { test } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { persistenceConfirmer } from './server.mjs';
import { mapUpdate } from './core.mjs';
const uri = process.env.MAX_WEBHOOK_TEST_MONGO_URI;
test('real disposable Mongo: majority persistence requires exact IDs, content, identity and links', { skip: !uri }, async () => {
  const u = new URL(uri); assert.equal(u.protocol, 'mongodb:'); assert.ok(['127.0.0.1', 'localhost', '[::1]'].includes(u.hostname)); assert.equal(u.username, ''); assert.equal(u.password, '');
  const { MongoClient } = await import('mongodb'); const c = new MongoClient(uri); await c.connect(); const db = c.db('max_webhook_fixture_' + crypto.randomUUID().replaceAll('-', ''));
  try {
    const raw = { update_type: 'message_created', timestamp: 1794654000000, message: { sender: { user_id: 111, is_bot: false }, recipient: { chat_id: 222, user_id: 333, chat_type: 'dialog' }, body: { mid: 'synthetic-mongo', text: 'synthetic persisted' } } };
    const dto = mapUpdate(raw, '333').dtos[0]; const message = { id: 'm', dialogId: 'd', clientId: 'c', connector: 'MAX_BOT', direction: 'INBOUND', externalUserId: dto.externalUserId, externalChatId: dto.externalChatId, externalMessageId: dto.externalMessageId, text: dto.text, createdAt: dto.timestamp };
    const receipt = { message, dialogId: 'd', clientId: 'c' }, names = { messages: 'messages', dialogs: 'dialogs', clients: 'clients' }; const confirm = persistenceConfirmer(db, names, { waitMs: 0, sleepMs: 0 });
    assert.equal(await confirm(dto, receipt), false);
    await db.collection('messages').insertOne(message); assert.equal(await confirm(dto, receipt), false);
    await db.collection('dialogs').insertOne({ id: 'd', clientId: 'c', updatedAt: dto.timestamp });
    await db.collection('clients').insertOne({ id: 'c', identities: [{ connector: 'MAX_BOT', externalUserId: '111', externalChatId: '222' }] }); assert.equal(await confirm(dto, receipt), true);
    await db.collection('messages').updateOne({ id: 'm' }, { $set: { externalMessageId: 'wrong' } }); assert.equal(await confirm(dto, receipt), false);
    await db.collection('messages').updateOne({ id: 'm' }, { $set: { externalMessageId: dto.externalMessageId } }); await db.collection('clients').updateOne({ id: 'c' }, { $set: { identities: [] } }); assert.equal(await confirm(dto, receipt), false);
  } finally { await db.dropDatabase(); await c.close(); }
});
