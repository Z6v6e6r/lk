import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Inbox, Dispatcher, mapUpdate, stationButtons } from './core.mjs';
import { createIngress, createStationService, persistenceConfirmer } from './server.mjs';

const botId = '333';
const secret = 'a'.repeat(64);
const timestamp = 1794654000000;
const command = (mid = 'fixture-station-command') => ({
  update_type: 'message_created', timestamp,
  message: { sender: { user_id: 111, is_bot: false },
    recipient: { chat_id: 222, user_id: 333, chat_type: 'dialog' }, body: { mid, text: '/station' } },
});
const callback = (callbackId = 'fixture-click', payload = 'station:tereh') => ({
  update_type: 'message_callback', timestamp,
  callback: { timestamp, callback_id: callbackId, payload, user: { user_id: 111, is_bot: false } },
  message: { sender: { user_id: 333, is_bot: true },
    recipient: { chat_id: 222, user_id: 111, chat_type: 'dialog' }, body: { mid: 'fixture-bot-menu' } },
});

function fixture(t) {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'max-station-test-')));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return new Inbox(dir, { minFreeBytes: 0 });
}

const identity = { connector: 'MAX_BOT', externalUserId: '111', externalChatId: '222' };
const verifiedClient = { id: 'fixture-client', authStatus: 'VERIFIED', identities: [identity] };
const stationId = 'Terehovo';
const stationName = 'Терехово';
const stationReceipt = dto => ({
  message: { id: 'fixture-selection-message', connector: 'MAX_BOT', direction: 'INBOUND', kind: 'STATION_SELECTION',
    externalMessageId: dto.externalMessageId, stationId },
  dialog: { id: 'fixture-dialog', stationId, stationName },
  client: { id: verifiedClient.id, currentStationId: stationId },
});

test('station command is opt-in, and photo captions stay on the unchanged media path', () => {
  const raw = command();
  assert.equal(mapUpdate(raw, botId).dtos[0].text, '/station');
  assert.deepEqual(mapUpdate(raw, botId, true).stationAction, { type: 'menu', userId: '111', chatId: '222' });
  raw.message.body.attachments = [{ type: 'image', payload: { url: 'https://fixture.invalid/photo.jpg' } }];
  const media = mapUpdate(raw, botId, true);
  assert.equal(media.stationAction, undefined);
  assert.deepEqual(media, mapUpdate(raw, botId));
  assert.equal(media.dtos[0].attachments[0].type, 'IMAGE');
});

test('callback uses the human actor and stable click ID with reviewed station actions only', () => {
  assert.throws(() => mapUpdate(callback(), botId), /UNSUPPORTED_UPDATE/);
  for (const [index, [button]] of stationButtons().entries()) {
    const raw = callback(`fixture-${index}`, button.payload);
    const { key, stationAction } = mapUpdate(raw, botId, true);
    assert.equal(stationAction.dto.action, button.payload.slice('station:'.length));
    assert.equal(stationAction.dto.selectedStationName, button.text);
    assert.equal(stationAction.dto.externalUserId, '111');
    assert.equal(stationAction.dto.externalChatId, '222');
    assert.equal(stationAction.dto.externalMessageId, `max-station-${key}`);
    assert.equal(stationAction.dto.text, `Клиент выбрал станцию: ${button.text}`);
  }
  assert.equal(mapUpdate(callback('legacy', 'tereh'), botId, true).stationAction.dto.action, 'tereh');
  assert.notEqual(mapUpdate(callback('a'), botId, true).key, mapUpdate(callback('b'), botId, true).key);
  const missingChat = callback('missing-chat');
  missingChat.message.recipient.chat_id = null;
  for (const raw of [callback('unknown', 'station:anywhere'), { ...callback(), message: null }, missingChat]) {
    assert.equal(mapUpdate(raw, botId, true).ignored, 'NON_STATION_CALLBACK');
  }
  const otherRecipient = callback(); otherRecipient.message.recipient.user_id = 444;
  assert.throws(() => mapUpdate(otherRecipient, botId, true), /CALLBACK_RECIPIENT_MISMATCH/);
  const otherBot = callback(); otherBot.message.sender.user_id = 444;
  assert.throws(() => mapUpdate(otherBot, botId, true), /INVALID_CALLBACK_ACTOR/);
  const botClick = callback(); botClick.callback.user.is_bot = true;
  assert.throws(() => mapUpdate(botClick, botId, true), /INVALID_CALLBACK_ACTOR/);
});

test('HTTP webhook ACKs accepted station clicks durably and deduplicates them before dispatch', async t => {
  const inbox = fixture(t);
  const server = createIngress({ secret, botId, inbox, stationEnabled: true });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => server.close(resolve)));
  const url = `http://127.0.0.1:${server.address().port}/webhook`;
  const send = (raw, authorized = true) => fetch(url, { method: 'POST', body: JSON.stringify(raw),
    headers: { 'content-type': 'application/json', ...(authorized ? { 'x-max-bot-api-secret': secret } : {}) } });
  assert.equal((await send(callback(), false)).status, 401);
  assert.equal(inbox.counts().records, 0);
  assert.equal((await (await send(callback())).json()).duplicate, false);
  assert.equal((await (await send(callback())).json()).duplicate, true);
  assert.equal((await send(callback('fixture-click', 'station:kuncev'))).status, 409);
  assert.equal(new Inbox(inbox.dir, { minFreeBytes: 0 }).counts().QUEUED, 1);
});

test('new station commands open menu once; a command accepted by the old receiver is not replayed', async t => {
  const inbox = fixture(t), past = command('past');
  inbox.accept(past, mapUpdate(past, botId));
  assert.equal(inbox.accept(past, mapUpdate(past, botId, true)).duplicate, true);
  const fresh = command('fresh');
  inbox.accept(fresh, mapUpdate(fresh, botId, true));
  const seen = [];
  const worker = new Dispatcher(inbox, {
    ready: async () => true, post: async dto => { seen.push(dto.text); return stationReceipt(dto); },
    confirm: async () => true,
    station: { verifiedOwner: async () => verifiedClient.id, reply: async (_, outcome) => { seen.push(outcome); } },
  });
  await worker.tick();
  assert.deepEqual(seen, ['/station', 'menu']);
  assert.equal(inbox.counts().DELIVERED, 2);
});

test('verified callback posts once, confirms before answering, and resumes after restarting', async t => {
  const inbox = fixture(t), raw = callback(), mapped = mapUpdate(raw, botId, true);
  inbox.accept(raw, mapped);
  const seen = [];
  const options = {
    ready: async () => true,
    post: async dto => { seen.push('CUP POST'); assert.deepEqual(dto, mapped.stationAction.dto); return stationReceipt(dto); },
    confirm: async (_, receipt) => { seen.push('CUP majority'); return receipt.stationId === stationId; },
    station: { verifiedOwner: async () => verifiedClient.id, reply: async (_, outcome) => { seen.push(outcome); } },
  };
  const worker = new Dispatcher(inbox, options);
  await worker.tick();
  assert.deepEqual(seen, ['CUP POST', 'CUP majority']);
  assert.equal(inbox.read(mapped.key).stationReply, 'saved');
  const onDisk = JSON.parse(fs.readFileSync(path.join(inbox.dir, mapped.key + '.json'), 'utf8'));
  assert.equal(onDisk.phase, 'REVIEW');
  assert.equal(onDisk.stationPhase, 'QUEUED');
  const reopened = new Inbox(inbox.dir, { minFreeBytes: 0 });
  const restarted = new Dispatcher(reopened, options);
  await restarted.tick();
  await restarted.tick();
  assert.deepEqual(seen, ['CUP POST', 'CUP majority', 'saved']);
  assert.equal(reopened.counts().DELIVERED, 1);
});

test('unverified callbacks never write CUP, and uncertain MAX replies never replay across restart', async t => {
  const inbox = fixture(t), raw = callback(), mapped = mapUpdate(raw, botId, true);
  inbox.accept(raw, mapped);
  const seen = [];
  const options = {
    ready: async () => true,
    post: async () => { seen.push('CUP POST'); },
    confirm: async () => { seen.push('CUP majority'); },
    station: { verifiedOwner: async () => null, reply: async (_, outcome) => { seen.push(outcome); throw Error('lost response'); } },
  };
  await new Dispatcher(inbox, options).tick();
  const reopened = new Inbox(inbox.dir, { minFreeBytes: 0 });
  await new Dispatcher(reopened, options).tick();
  assert.deepEqual(seen, ['denied']);
  assert.equal(reopened.read(mapped.key).reason, 'UNKNOWN_STATION_REPLY');

  const interrupted = callback('interrupted-reply'), stored = mapUpdate(interrupted, botId, true);
  reopened.accept(interrupted, stored);
  reopened.write({ ...reopened.read(stored.key), stationReply: 'saved', phase: 'DISPATCH_INTENT' });
  const restarted = new Inbox(inbox.dir, { minFreeBytes: 0 });
  await new Dispatcher(restarted, options).tick();
  assert.deepEqual(seen, ['denied']);
  assert.equal(restarted.read(stored.key).reason, 'UNKNOWN_STATION_REPLY');
});

test('pause raised during owner lookup prevents both a CUP write and a MAX reply', async t => {
  const inbox = fixture(t), raw = callback(), mapped = mapUpdate(raw, botId, true);
  inbox.accept(raw, mapped);
  let paused = false, effects = 0;
  const worker = new Dispatcher(inbox, {
    ready: async () => true, paused: () => paused,
    post: async () => { effects++; }, confirm: async () => true,
    station: { verifiedOwner: async () => { paused = true; return verifiedClient.id; }, reply: async () => { effects++; } },
  });
  await worker.tick();
  assert.equal(inbox.read(mapped.key).phase, 'QUEUED');
  assert.equal(effects, 0);
});

test('station service validates the exact verified pair and uses fixed MAX endpoints', async () => {
  const config = { botId, stationBotToken: 'fixture-station-token', ingressToken: 'fixture-cup-token', mongo: { clients: 'clients' } };
  const calls = [];
  let client = verifiedClient, persisted = verifiedClient, providerBot = botId;
  const db = { collection(name) {
    assert.equal(name, 'clients');
    return { findOne: async (query, options) => {
      assert.deepEqual(query, { id: verifiedClient.id, authStatus: 'VERIFIED', identities: { $elemMatch: identity } });
      assert.equal(options.readConcern.level, 'majority');
      return persisted;
    } };
  } };
  const request = async (url, options) => {
    calls.push([url, options]);
    if (url.pathname.endsWith('/resolve')) return { client };
    if (url.pathname === '/me') return { is_bot: true, user_id: providerBot };
    if (url.pathname === '/messages') return { message: { body: { mid: 'fixture-sent-mid' } } };
    return { success: true };
  };
  const service = createStationService(config, db, request);
  const menu = mapUpdate(command(), botId, true).stationAction;
  const selection = mapUpdate(callback(), botId, true).stationAction;
  client = { ...verifiedClient, identities: [{ ...identity, externalChatId: 'other' }] };
  assert.equal(await service.verifiedOwner(selection), null);
  client = verifiedClient;
  persisted = null;
  await assert.rejects(service.verifiedOwner(selection), /STATION_OWNER_PERSISTENCE/);
  persisted = verifiedClient;
  providerBot = '444';
  await assert.rejects(service.verifiedOwner(selection), /STATION_BOT_IDENTITY/);
  providerBot = botId;
  assert.equal(await service.verifiedOwner(selection), verifiedClient.id);
  await service.reply(menu, 'menu');
  await service.reply(selection, 'saved');
  const [lookup, lookupOptions] = calls[0];
  assert.equal(lookup.origin, 'http://127.0.0.1:3000');
  assert.equal(lookup.searchParams.get('connector'), 'MAX_BOT');
  assert.deepEqual(lookupOptions.headers, { 'x-integration-token': config.ingressToken });
  const [[send, sendOptions], [answer, answerOptions]] = calls.slice(-2);
  assert.equal(send.href, 'https://platform-api2.max.ru/messages?chat_id=222');
  assert.equal(sendOptions.headers.authorization, config.stationBotToken);
  assert.deepEqual(JSON.parse(sendOptions.body).attachments[0].payload.buttons, stationButtons());
  assert.equal(answer.href, 'https://platform-api2.max.ru/answers?callback_id=fixture-click');
  assert.deepEqual(JSON.parse(answerOptions.body).message.attachments, []);
  assert.match(JSON.parse(answerOptions.body).message.text, /Станция Терехово сохранена/);
});

test('persistence proof requires the canonical station on the CUP message, dialog and verified profile', async () => {
  const { dto } = mapUpdate(callback(), botId, true).stationAction;
  const receipt = { message: { id: 'message' }, dialogId: 'dialog', clientId: verifiedClient.id, stationId };
  const rows = {
    serviceMessages: { ...dto, kind: 'STATION_SELECTION', stationId, dialogId: 'dialog', clientId: verifiedClient.id, createdAt: dto.timestamp },
    dialogs: { stationId, updatedAt: dto.timestamp },
    clients: { ...verifiedClient, currentStationId: stationId },
  };
  const db = { collection: name => ({ findOne: async () => rows[name] }) };
  const confirm = persistenceConfirmer(db, { messages: 'messages', serviceMessages: 'serviceMessages', dialogs: 'dialogs', clients: 'clients' }, { waitMs: 0, sleepMs: 0 });
  assert.equal(await confirm(dto, receipt), true);
  for (const [row, field] of [['serviceMessages', 'stationId'], ['serviceMessages', 'kind'], ['dialogs', 'stationId'], ['clients', 'currentStationId'], ['clients', 'authStatus']]) {
    const value = rows[row][field];
    rows[row][field] = 'wrong';
    assert.equal(await confirm(dto, receipt), false);
    rows[row][field] = value;
  }
});
