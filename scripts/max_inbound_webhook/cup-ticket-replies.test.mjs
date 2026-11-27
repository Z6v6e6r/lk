import assert from 'node:assert/strict';
import { randomBytes, randomUUID } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { Dispatcher, Inbox, mapUpdate } from './core.mjs';
import { createCupTicketReplies, cupTicketReplyKey } from './cup-ticket-replies.mjs';

const bot = '333';
const chat = '222';
const subject = '111';
const event = (mid, text, parent, user = subject) => ({
  update_type: 'message_created',
  message: {
    timestamp: Date.now(),
    sender: { user_id: user, is_bot: false },
    recipient: { chat_id: chat, user_id: bot, chat_type: 'dialog' },
    body: { mid, text },
    ...(parent && { link: { type: 'reply', message: { mid: parent } } }),
  },
});

function inboxFixture(t) {
  const directory = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'max-cup-ticket-')));
  fs.chmodSync(directory, 0o700);
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  return new Inbox(directory, { minFreeBytes: 0 });
}

function confirmContact(inbox) {
  const raw = {
    update_type: 'message_callback',
    message: { sender: { user_id: bot, is_bot: true }, recipient: { chat_id: chat, user_id: subject, chat_type: 'dialog' }, body: { mid: 'confirmed-prompt' } },
    callback: { callback_id: 'confirmed-callback', user: { user_id: subject, is_bot: false }, payload: 'cup2_' + randomUUID() },
  };
  const { key } = inbox.accept(raw, mapUpdate(raw, bot, true, true, true));
  const record = inbox.read(key);
  record.cupHandoffConfirmationDigest = randomBytes(32).toString('hex');
  record.phase = 'DELIVERED';
  inbox.write(record);
}

const accept = (inbox, raw) => inbox.accept(raw, mapUpdate(raw, bot, true, true, true)).key;

function bridge(overrides = {}) {
  return { receive: async () => 'stored', hasHint: () => false, hint: async () => {}, flush: async () => {}, ...overrides };
}

function dispatch(inbox, cupTickets, legacy) {
  return new Dispatcher(inbox, {
    cupTickets,
    ready: async () => true,
    post: async dto => {
      legacy.push(dto.externalMessageId);
      return { message: { id: randomUUID(), connector: 'MAX_BOT', direction: 'INBOUND', externalMessageId: dto.externalMessageId },
        client: { id: randomUUID() }, dialog: { id: randomUUID() } };
    },
    confirm: async () => true,
  });
}

test('only persisted confirmed chats use the ticket bridge; commands and other chat traffic stay on their routes', async t => {
  const inbox = inboxFixture(t);
  const old = accept(inbox, event('before', 'Before confirmation'));
  assert.equal(inbox.read(old).cupTicketMessage, undefined);
  confirmContact(inbox);
  const reopened = new Inbox(inbox.dir, { minFreeBytes: 0 });
  const quoted = accept(reopened, event('mid.quoted', 'Follow up', 'mid.staff'));
  const other = accept(reopened, event('other', 'Separate client', undefined, '114'));
  assert.equal(reopened.read(quoted).cupTicketMessage.parentId, 'mid.staff');
  assert.equal(reopened.read(other).cupTicketMessage, undefined);
  assert.equal(mapUpdate(event('station', '/station'), bot, true, true, true).stationAction.type, 'menu');
  assert.equal(mapUpdate(event('unsafe-mid', 'Malformed quote', 123), bot, true, true, true).cupTicketMessage, undefined);
  const legacy = [];
  const received = [];
  const botDispatch = dispatch(reopened, bridge({
    receive: async message => { received.push(message); return 'stored'; },
  }), legacy);
  await botDispatch.tick();
  assert.deepEqual(legacy, ['before', 'other']);
  assert.deepEqual(received.map(message => [message.subject, message.chat, message.messageId, message.parentId]),
    [[subject, chat, 'mid.quoted', 'mid.staff']]);
  assert.equal(reopened.read(quoted).phase, 'DELIVERED');
});

test('an uncertain bridge response stays in custody and a definite unmatched result only uses legacy once', async t => {
  const inbox = inboxFixture(t);
  confirmContact(inbox);
  const pending = accept(inbox, event('pending', 'Pending ticket lookup'));
  const immediatelyLegacy = accept(inbox, event('legacy', 'Independent legacy chat', undefined, '115'));
  const legacy = [];
  await dispatch(inbox, bridge({ receive: async () => { throw Error('timeout'); } }), legacy).tick();
  assert.equal(inbox.read(pending).phase, 'QUEUED');
  assert.equal(inbox.read(immediatelyLegacy).phase, 'DELIVERED');
  assert.equal(JSON.parse(fs.readFileSync(path.join(inbox.dir, pending + '.json'))).phase, 'REVIEW');
  const reopened = new Inbox(inbox.dir, { minFreeBytes: 0 });
  const record = reopened.read(pending);
  record.cupTicketRetryAt = 0;
  reopened.write(record);
  const calls = [];
  const worker = dispatch(reopened, bridge({
    receive: async message => { calls.push(message.messageId); return 'unmatched'; },
  }), legacy);
  await worker.tick();
  await worker.tick();
  assert.deepEqual(calls, ['pending']);
  assert.deepEqual(legacy, ['legacy', 'pending']);
  assert.equal(reopened.read(pending).cupTicketOutcome, 'legacy');
});

test('an ambiguous provider send is recorded once and the service requires a separate key', async () => {
  const key = randomBytes(32).toString('base64url');
  const handoff = { verifiedDialog: async () => true, sendMessage: async () => { throw Error('provider lost response'); } };
  assert.equal(cupTicketReplyKey({}, handoff), undefined);
  assert.throws(() => cupTicketReplyKey({ cupStagingTicketReplies: { enabled: true, key }, stationBotToken: key }, handoff), /CONFIGURATION/);
  const claim = { id: randomUUID(), lease: randomUUID(), chat, subject, number: 'PDH-12', body: 'Staff reply' };
  const calls = [];
  const worker = createCupTicketReplies(key, handoff, async (url, init) => {
    const action = url.pathname.split('/').at(-1);
    assert.equal(url.origin, 'https://cup-replies-private.tsup.space:19445');
    assert.equal(init.headers['x-cup-max-reply-key'], key);
    assert.equal(init.redirect, 'error');
    calls.push([action, JSON.parse(init.body)]);
    return action === 'claim' && calls.length === 1 ? Response.json(claim) : new Response(null, { status: 204 });
  });
  await worker.flush(() => false);
  await worker.flush(() => false);
  assert.deepEqual(calls, [['claim', {}], ['finish', { id: claim.id, lease: claim.lease, outcome: 'ambiguous' }], ['claim', {}]]);
});

test('a lost CUP receipt response retries only the finish call with the same lease and provider ID', async () => {
  const claim = { id: randomUUID(), lease: randomUUID(), chat, subject, number: 'PDH-12', body: 'а'.repeat(4000) };
  const finishCalls = [];
  let sends = 0;
  const worker = createCupTicketReplies(randomBytes(32).toString('base64url'), {
    verifiedDialog: async () => true,
    sendMessage: async (_dialogue, { text }) => {
      sends++;
      assert.equal(text, claim.body);
      return 'mid.staff';
    },
  }, async (url, init) => {
    if (url.pathname.endsWith('/claim')) return Response.json(claim);
    finishCalls.push(JSON.parse(init.body));
    if (finishCalls.length === 1) throw Error('timeout');
    return new Response(null, { status: 204 });
  });
  await worker.flush(() => false);
  const expected = { id: claim.id, lease: claim.lease, outcome: 'delivered', providerId: 'mid.staff' };
  assert.deepEqual(finishCalls, [expected, expected]);
  assert.equal(sends, 1);
});
