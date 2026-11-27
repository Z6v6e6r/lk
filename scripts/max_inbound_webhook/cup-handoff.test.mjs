import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash, createHmac } from 'node:crypto';
import { Dispatcher, Inbox, mapUpdate } from './core.mjs';
import { createIngress } from './server.mjs';
import { CUP_PROOF_URL, cupHandoffConfig, createCupHandoffService, signCupHandoffProof } from './cup-handoff.mjs';

const botId = '199';
const proofKey = Buffer.alloc(32, 18);
const botToken = 'synthetic-max-token';
const webhookSecret = 'a'.repeat(64);
const draft = '1fbc4ce2-ddd9-4ba3-80e3-708a933e4af9';
const payload = 'cup2_' + draft;
const confirmationDigest = 'a'.repeat(64);
const acceptedProof = { status: 'accepted', confirmationDigest };
const user = { user_id: 111, is_bot: false };
const sender = { user_id: 199, is_bot: true };
const recipient = { chat_type: 'dialog', chat_id: 222, user_id: 111 };
const start = () => ({ update_type: 'bot_started', payload, chat_id: 222, user, timestamp: Date.now() });
const click = (callbackId = 'fixture-click') => ({ update_type: 'message_callback', timestamp: 1_795_700_000_000,
  callback: { user, callback_id: callbackId, payload },
  message: { sender, recipient, body: { mid: 'confirmation-prompt' } },
});
const map = raw => mapUpdate(raw, botId, true, true);
const add = (inbox, raw) => inbox.accept(raw, map(raw)).key;
const makeInbox = t => {
  const directory = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'cup-handoff-')));
  fs.chmodSync(directory, 0o700);
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  return openInbox(directory);
};
const openInbox = directory => new Inbox(directory, { minFreeBytes: 0 });
const noLegacy = async () => assert.fail('Handoff must not call legacy dispatch');
const dispatcher = (inbox, cupHandoff, legacy = {}) => new Dispatcher(inbox, {
  ready: noLegacy, post: noLegacy, confirm: noLegacy,
  station: { verifiedOwner: noLegacy, reply: noLegacy },
  cupHandoff, ...legacy,
});

test('the reserved payload is opt-in, exact, and never routes to a station', () => {
  assert.equal(mapUpdate(start(), botId, true).ignored, 'CUP_HANDOFF_DISABLED');
  assert.equal(mapUpdate(click(), botId, true).ignored, 'NON_STATION_CALLBACK');
  const station = { ...click(), callback: { ...click().callback, payload: 'station:tereh' } };
  assert.deepEqual(map(station), mapUpdate(station, botId, true));
  assert.equal(map(station).stationAction.dto.action, 'tereh');
  const textEvent = { update_type: 'message_created', timestamp: Date.now(),
    message: { sender: user, recipient: { ...recipient, user_id: Number(botId) },
      body: { mid: 'legacy-content', text: payload } } };
  assert.deepEqual(map(textEvent), mapUpdate(textEvent, botId, true));
  assert.deepEqual(map(start()).cupHandoffAction, { type: 'start', draft, userId: '111', chatId: '222' });
  assert.deepEqual(map(click()).cupHandoffAction, { type: 'confirm', draft, userId: '111', chatId: '222', promptId: 'confirmation-prompt' });

  for (const malformed of [payload + '\n', 'cup2_' + draft.toUpperCase(), 'cup2_x']) {
    assert.equal(map({ ...start(), payload: malformed }).ignored, 'INVALID_CUP_HANDOFF_START');
    assert.throws(() => map({ ...click(), callback: { ...click().callback, payload: malformed } }), /CUP_HANDOFF_PAYLOAD/);
  }
  for (const chat_id of [0, -4, '002', '111\n', '9223372036854775808', Number.MAX_SAFE_INTEGER + 1]) {
    assert.equal(map({ ...start(), chat_id }).ignored, 'INVALID_CUP_HANDOFF_START');
  }
  assert.equal(map({ ...start(), user: { user_id: 111, is_bot: true } }).ignored, 'INVALID_CUP_HANDOFF_START');
  assert.throws(() => map({ update_type: 'bot_stopped' }), /UNSUPPORTED_UPDATE/);
  assert.throws(() => map({ ...click(), message: { ...click().message, recipient: { ...recipient, chat_type: 'chat' } } }), /CUP_HANDOFF_DIALOG/);
  assert.throws(() => map({ ...click(), message: { ...click().message, recipient: { ...recipient, user_id: 123 } } }), /CUP_HANDOFF_RECIPIENT/);
  assert.throws(() => map({ ...click(), message: { ...click().message, sender: { user_id: 33, is_bot: true } } }), /CUP_HANDOFF_DIALOG/);
  assert.throws(() => map({ ...click(), message: null }), /CUP_HANDOFF_ID/);
  assert.throws(() => map(click('fixture-click\n')), /CUP_HANDOFF_MESSAGE_ID/);
  assert.equal(map({ ...start(), chat_id: '9223372036854775807' }).cupHandoffAction.chatId, '9223372036854775807');
});

test('the opt-in config pins the STAGING endpoint and requires a canonical proof key', () => {
  const settings = { enabled: true, proofUrl: CUP_PROOF_URL, proofKey: proofKey.toString('base64url') };
  const config = { stationBotToken: botToken, botId, cupStagingHandoff: settings };
  assert.equal(cupHandoffConfig({}), undefined);
  assert.equal(cupHandoffConfig({ cupStagingHandoff: { enabled: false } }), undefined);
  assert.deepEqual(cupHandoffConfig(config), { botId, botToken, proofKey });
  for (const wrong of [{ proofUrl: 'https://stg-support.tsup.space:18443/' },
    { proofUrl: CUP_PROOF_URL + '?redirect=true' }, { proofKey: 'a'.repeat(43) }, { proofKey: 'YWJj' }]) {
    assert.throws(() => cupHandoffConfig({ ...config, cupStagingHandoff: { ...settings, ...wrong } }), /CUP_HANDOFF_CONFIGURATION/);
  }
  assert.throws(() => cupHandoffConfig({ ...config, stationBotToken: undefined }), /CUP_HANDOFF_CONFIGURATION/);
  assert.throws(() => cupHandoffConfig({ ...config, webhookSecret: settings.proofKey }), /CUP_HANDOFF_CONFIGURATION/);
});

test('proof contains only the required claims and a short independent HS256 signature', () => {
  const action = map(click()).cupHandoffAction;
  const now = 1_795_700_000_000;
  const proof = signCupHandoffProof(action, proofKey, now);
  const [header, body, signature] = proof.split('.');
  const decode = value => JSON.parse(Buffer.from(value, 'base64url'));
  const { jti, confirmation, ...claims } = decode(body);
  assert.deepEqual(decode(header), { alg: 'HS256', typ: 'JWT' });
  assert.deepEqual(claims, { iss: 'max', aud: 'cup-support-staging/intake', sub: '111', chat: '222',
    tenant: 'padlhub', draft, iat: now / 1000, exp: now / 1000 + 75 });
  assert.match(jti, /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
  assert.equal(signature, createHmac('sha256', proofKey).update(header + '.' + body).digest('base64url'));
  assert.match(confirmation, /^[A-Za-z0-9_-]{22}$/);
  assert.equal(Buffer.from(confirmation, 'base64url').toString('base64url'), confirmation);
  const retry = signCupHandoffProof(action, proofKey, now + 1_000);
  assert.notEqual(proof, retry);
  assert.equal(decode(retry.split('.')[1]).confirmation, confirmation);
  for (const change of [{ userId: '333' }, { chatId: '333' }, { draft: 'd1b75de3-ad05-4831-b82e-1a31d021ccca' }]) {
    assert.notEqual(decode(signCupHandoffProof({ ...action, ...change }, proofKey, now).split('.')[1]).confirmation, confirmation);
  }
});

test('provider verification, keyboard, and CUP proof use separate fixed destinations without leaked credentials', async () => {
  const requests = [];
  let confirmation;
  const service = createCupHandoffService({ botId, botToken, proofKey }, async (url, options) => {
    requests.push(url.href);
    assert.equal(options.headers.authorization, botToken);
    if (url.pathname === '/me') return sender;
    if (url.pathname === '/chats/222') return { type: 'dialog', status: 'active', chat_id: 222, dialog_with_user: user };
    assert.equal(url.pathname, '/messages');
    assert.equal(url.searchParams.get('chat_id'), '222');
    assert.equal(options.method, 'POST');
    const message = JSON.parse(options.body);
    const [[button], copyRow] = message.attachments[0].payload.buttons;
    if (!confirmation) assert.deepEqual(button, { type: 'callback', text: 'Подтвердить обращение', payload });
    else {
      assert.equal(button.type, 'link');
      assert.equal(button.url, 'https://stg-support.tsup.space/intake?from=max#maxDraft=' + draft + '&maxProof=' + confirmation);
      assert.deepEqual(copyRow, [{ type: 'clipboard', text: 'Скопировать код', payload: confirmation }]);
      assert.equal(message.text.split('\n').at(-1), confirmation);
    }
    return click();
  }, async (url, options) => {
    requests.push(url);
    assert.deepEqual(options.headers, { 'content-type': 'application/json' });
    assert.equal(options.redirect, 'error');
    assert.equal(options.method, 'POST');
    const body = JSON.parse(options.body);
    assert.deepEqual(Object.keys(body), ['proof']);
    confirmation = JSON.parse(Buffer.from(body.proof.split('.')[1], 'base64url')).confirmation;
    return new Response(null, { status: 204 });
  });
  assert.equal(await service.verifiedDialog(map(start()).cupHandoffAction), true);
  assert.equal(await service.prompt(map(start()).cupHandoffAction), 'confirmation-prompt');
  const result = await service.deliverProof(map(click()).cupHandoffAction);
  assert.deepEqual(result, { status: 'accepted', confirmationDigest: createHash('sha256').update(confirmation).digest('hex') });
  assert.equal(await service.deliverReturn(map(click()).cupHandoffAction), 'confirmation-prompt');
  assert.deepEqual(requests, ['https://platform-api2.max.ru/me', 'https://platform-api2.max.ru/chats/222',
    'https://platform-api2.max.ru/messages?chat_id=222', CUP_PROOF_URL, 'https://platform-api2.max.ru/messages?chat_id=222']);
});

test('webhook authentication precedes admission, with durable starts and callback idempotency', async t => {
  const inbox = makeInbox(t);
  const server = createIngress({ secret: webhookSecret, botId, inbox, stationEnabled: true, cupHandoffEnabled: true });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => server.close(resolve)));
  const url = 'http://127.0.0.1:' + server.address().port + '/webhook';
  const send = (raw, secret = webhookSecret) => fetch(url, { method: 'POST', body: JSON.stringify(raw),
    headers: { 'Content-Type': 'application/json', 'X-Max-Bot-Api-Secret': secret } });
  const kickoff = start();
  assert.equal((await send(kickoff, 'b'.repeat(64))).status, 401);
  assert.equal(inbox.counts().records, 0);
  assert.equal((await (await send(kickoff)).json()).duplicate, false);
  assert.equal((await (await send({ ...kickoff, timestamp: kickoff.timestamp + 1 })).json()).duplicate, true);
  assert.equal((await (await send(click())).json()).duplicate, false);
  assert.equal((await (await send(click())).json()).duplicate, true);
  assert.equal((await send({ ...click(), callback: { ...click().callback, payload: 'cup2_d1b75de3-ad05-4831-b82e-1a31d021ccca' } })).status, 409);
  assert.equal(openInbox(inbox.dir).counts().QUEUED, 2);
});

test('ordinary and malformed bot starts receive bounded durable ACKs without dispatch', async t => {
  const inbox = new Inbox(makeInbox(t).dir, { minFreeBytes: 0, maxRecords: 3 });
  const server = createIngress({ secret: webhookSecret, botId, inbox, stationEnabled: true, cupHandoffEnabled: true });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => server.close(resolve)));
  const url = 'http://127.0.0.1:' + server.address().port + '/webhook';
  const send = (raw, secret = webhookSecret) => fetch(url, { method: 'POST', body: JSON.stringify(raw),
    headers: { 'Content-Type': 'application/json', 'X-Max-Bot-Api-Secret': secret } });
  const ordinary = { update_type: 'bot_started', user: { ...user, first_name: 'Fixture name' }, chat_id: 222,
    timestamp: 1_795_700_000_000 };
  const reordered = { timestamp: ordinary.timestamp, chat_id: ordinary.chat_id,
    user: { first_name: 'Fixture name', is_bot: false, user_id: 111 }, update_type: 'bot_started' };
  const unrecognized = { ...ordinary, payload: 'a-different-product' };
  const malformed = { ...ordinary, payload: 'cup2_' + 'x'.repeat(60_000) };

  assert.equal((await send(ordinary, 'b'.repeat(64))).status, 401);
  assert.equal(inbox.counts().records, 0);
  for (const raw of [ordinary, unrecognized, malformed]) {
    const response = await send(raw);
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), { ok: true, accepted: true, duplicate: false });
  }
  for (const raw of [reordered, unrecognized, malformed]) {
    const response = await send(raw);
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), { ok: true, accepted: true, duplicate: true });
  }
  assert.equal((await send({ ...ordinary, timestamp: ordinary.timestamp + 1 })).status, 503);
  assert.equal((await send({ update_type: 'bot_stopped' })).status, 400);

  const reopened = openInbox(inbox.dir);
  assert.equal(reopened.counts().IGNORED, 3);
  assert.ok(reopened.counts().bytes < 1_500);
  for (const raw of [ordinary, unrecognized, malformed]) {
    const record = reopened.read(map(raw).key);
    assert.deepEqual(Object.keys(record.raw).sort(), ['eventDigest', 'update_type']);
    assert.match(record.raw.eventDigest, /^[0-9a-f]{64}$/);
    assert.equal(record.raw.update_type, 'bot_started');
    assert.deepEqual(record.dtos, []);
  }
  assert.deepEqual(reopened.pending(), []);
  await dispatcher(reopened, { verifiedDialog: noLegacy, prompt: noLegacy, deliverProof: noLegacy }).tick();
});

test('first start admission survives flag changes without activating an ignored start', t => {
  const inbox = makeInbox(t);
  const disabled = raw => mapUpdate(raw, botId, true);
  const kickoff = start();
  const retry = { ...kickoff, timestamp: kickoff.timestamp + 1 };
  const inactiveKey = inbox.accept(kickoff, disabled(kickoff)).key;
  const reopened = openInbox(inbox.dir);
  assert.equal(reopened.accept(retry, disabled(retry)).duplicate, true);
  assert.equal(reopened.accept(retry, map(retry)).duplicate, true);
  assert.equal(reopened.read(inactiveKey).ignored, 'CUP_HANDOFF_DISABLED');
  assert.deepEqual(reopened.pending(), []);

  const fresh = { ...kickoff, payload: 'cup2_d1b75de3-ad05-4831-b82e-1a31d021ccca' };
  const activeKey = reopened.accept(fresh, map(fresh)).key;
  const afterRollback = openInbox(inbox.dir);
  assert.equal(afterRollback.accept(fresh, disabled(fresh)).duplicate, true);
  assert.deepEqual(afterRollback.pending(), [activeKey]);
  assert.equal(afterRollback.read(activeKey).cupHandoffAction.type, 'start');
});

test('only the delivered prompt in the same verified dialog authorizes the callback', async t => {
  const inbox = makeInbox(t);
  const sent = [];
  const service = {
    verifiedDialog: async action => { sent.push(action.userId + ':verified'); return true; },
    prompt: async () => { sent.push('prompt'); return 'confirmation-prompt'; },
    deliverProof: async action => { sent.push(action.userId + ':proof'); return acceptedProof; },
    confirmationDigest: () => confirmationDigest,
    deliverReturn: async action => { sent.push(action.chatId + ':return'); },
  };
  const unprompted = add(inbox, click('early'));
  await dispatcher(inbox, service).tick();
  assert.equal(inbox.read(unprompted).reason, 'CUP_HANDOFF_PROMPT_UNPROVEN');

  const startKey = add(inbox, start());
  assert.equal(JSON.parse(fs.readFileSync(path.join(inbox.dir, startKey + '.json'), 'utf8')).phase, 'REVIEW');
  await dispatcher(inbox, undefined).tick();
  assert.deepEqual(sent, []);
  await dispatcher(inbox, service).tick();
  assert.equal(inbox.read(startKey).cupHandoffPromptId, 'confirmation-prompt');

  const otherChat = click('other');
  otherChat.message = { ...otherChat.message, recipient: { ...recipient, chat_id: 333 } };
  const swapped = add(inbox, otherChat);
  const success = add(inbox, click('clicked'));
  const reopened = openInbox(inbox.dir);
  await dispatcher(reopened, service).tick();
  await dispatcher(reopened, service).tick();
  assert.equal(reopened.read(swapped).reason, 'CUP_HANDOFF_PROMPT_UNPROVEN');
  assert.equal(reopened.read(success).phase, 'QUEUED');
  assert.equal(reopened.read(success).cupHandoffConfirmationDigest, confirmationDigest);
  const afterReceipt = openInbox(inbox.dir);
  await dispatcher(afterReceipt, service).tick();
  assert.equal(afterReceipt.read(success).phase, 'DELIVERED');
  assert.deepEqual(sent, ['111:verified', 'prompt', '111:proof', '111:verified', '222:return']);
});

test('proof timeout retries durably while ambiguous prompts do not replay', async t => {
  const inbox = makeInbox(t);
  let proofs = 0;
  const service = {
    verifiedDialog: async () => true,
    prompt: async () => 'confirmation-prompt',
    deliverProof: async () => { proofs += 1; if (proofs === 1) throw Error('lost response'); return acceptedProof; },
    confirmationDigest: () => confirmationDigest,
    deliverReturn: async () => 'returned',
  };
  const startKey = add(inbox, start());
  await dispatcher(inbox, service).tick();
  const clickKey = add(inbox, click());
  await dispatcher(inbox, service).tick();
  const reopened = openInbox(inbox.dir);
  assert.equal(reopened.read(clickKey).cupHandoffAttempts, 1);
  await dispatcher(reopened, service).tick();
  assert.equal(proofs, 1);
  const retryAt = reopened.read(clickKey).cupHandoffRetryAt;
  t.mock.method(Date, 'now', () => retryAt + 1);
  const ambiguous = reopened.read(clickKey);
  ambiguous.phase = 'DISPATCH_INTENT';
  reopened.write(ambiguous);
  await dispatcher(openInbox(inbox.dir), service).tick();
  assert.equal(proofs, 2);
  assert.equal(openInbox(inbox.dir).read(clickKey).phase, 'QUEUED');
  await dispatcher(openInbox(inbox.dir), service).tick();
  assert.equal(openInbox(inbox.dir).read(clickKey).phase, 'DELIVERED');

  const lostPrompt = inbox.read(startKey);
  lostPrompt.phase = 'DISPATCH_INTENT';
  inbox.write(lostPrompt);
  await dispatcher(openInbox(inbox.dir), {
    ...service,
    prompt: async () => assert.fail('Ambiguous MAX prompt must not be resent'),
  }).tick();
  assert.equal(openInbox(inbox.dir).read(startKey).reason, 'CUP_HANDOFF_UNKNOWN_PROMPT');
});

test('ambiguous MAX return sends never replay, even after an interrupted intent or key rotation', async t => {
  const inbox = makeInbox(t);
  let returns = 0;
  let proofs = 0;
  const service = {
    verifiedDialog: async () => true,
    prompt: async () => 'confirmation-prompt',
    deliverProof: async () => { proofs += 1; return acceptedProof; },
    confirmationDigest: () => confirmationDigest,
    deliverReturn: async () => { returns += 1; throw Error('lost response'); },
  };
  await dispatcher(inbox, service).tick();
  add(inbox, start());
  await dispatcher(inbox, service).tick();

  const unknownSend = add(inbox, click('unknown-send'));
  await dispatcher(inbox, service).tick();
  assert.equal(returns, 0);
  await dispatcher(openInbox(inbox.dir), service).tick();
  const reopened = openInbox(inbox.dir);
  await dispatcher(reopened, service).tick();
  assert.equal(reopened.read(unknownSend).reason, 'CUP_HANDOFF_UNKNOWN_RETURN');
  assert.equal(returns, 1);
  assert.equal(proofs, 1);

  const interrupted = add(reopened, click('interrupted-return'));
  await dispatcher(reopened, service).tick();
  const intent = reopened.read(interrupted);
  intent.phase = 'DISPATCH_INTENT';
  reopened.write(intent);
  await dispatcher(openInbox(inbox.dir), service).tick();
  assert.equal(openInbox(inbox.dir).read(interrupted).reason, 'CUP_HANDOFF_UNKNOWN_RETURN');

  const rotated = openInbox(inbox.dir);
  const wrongKey = add(rotated, click('rotated-after-proof'));
  await dispatcher(rotated, service).tick();
  await dispatcher(openInbox(inbox.dir), { ...service, confirmationDigest: () => 'b'.repeat(64) }).tick();
  assert.equal(openInbox(inbox.dir).read(wrongKey).reason, 'CUP_HANDOFF_CONFIRMATION_KEY_CHANGED');
  assert.equal(returns, 1);
  assert.equal(proofs, 3);
});
