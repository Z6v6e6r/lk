import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
const dir = new URL('../nodered_max_nodes/', import.meta.url);
const generation = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const now = Date.now(), after = new Date(now - 60000).toISOString();
const values = { SUPPORT_MAX_GENERATION: generation, SUPPORT_MAX_GENERATION_AFTER: after,
  SUPPORT_MAX_GENERATION_TOKEN: 'synthetic-token', MAX_CONNECTOR: 'MAX_BOT' };
const run = (file, msg, overrides = {}) => new Function('msg', 'env', fs.readFileSync(new URL(file, dir), 'utf8'))(msg, { get: key => ({ ...values, ...overrides })[key] ?? null });
const message = timestamp => ({ payload: { update_type: 'message_created', timestamp,
  message: { body: { mid: 'synthetic-event', text: 'SYNTHETIC PRIVATE BODY' },
    sender: { user_id: 'synthetic-user' }, recipient: { chat_id: 'synthetic-chat' } } } });

test('old, missing, seconds, string and future timestamps never reach business effects', () => {
  for (const stamp of [now - 120000, undefined, null, Math.floor(now / 1000), String(now), now + 60000]) {
    const result = run('fn_max_webhook_prepare.js', message(stamp));
    assert.equal(result[0], null);
    assert.ok(!JSON.stringify(result[2]).includes('SYNTHETIC PRIVATE BODY'));
  }
  assert.equal(run('fn_max_webhook_prepare.js', { payload: { timestamp: now } })[0], null);
});
test('new event needs durable admission before lookup or direct service reply', () => {
  const normalized = run('fn_max_webhook_prepare.js', message(now - 1000))[0];
  assert.equal(normalized.maxUpdate.providerTimestampVerified, true);
  assert.equal(normalized.maxUpdate.generation, generation);
  assert.equal(run('fn_max_client_lookup_prepare.js', normalized), null);
  assert.equal(run('fn_max_support_route.js', normalized), null);
  const request = run('fn_max_generation_admit_prepare.js', normalized);
  assert.equal(new URL(request.url).pathname, '/api/support/max/ingress/admit');
  assert.equal(request.method, 'POST');
  assert.equal(request.payload.at, new Date(now - 1000).toISOString());
  const accepted = run('fn_max_generation_admit_response.js', { ...request, statusCode: 201,
    payload: { admissionId: `ingress:${'b'.repeat(64)}`, generation, after, connector: 'MAX_BOT' } });
  assert.ok(accepted); assert.equal(accepted.headers, undefined);
  assert.ok(run('fn_max_client_lookup_prepare.js', accepted));
  const routed = run('fn_max_support_route.js', { ...accepted, payload: {} });
  assert.equal(routed[0].payload.timestamp, new Date(now - 1000).toISOString());
  assert.equal(routed[0].payload.meta.maxIngressAdmission, `ingress:${'b'.repeat(64)}`);
});
test('duplicate, failed handler or unknown admission response never runs again', () => {
  const normalized = run('fn_max_webhook_prepare.js', message(now - 1000))[0];
  for (const statusCode of [undefined, 0, 400, 409, 500]) assert.equal(run('fn_max_generation_admit_response.js', {
    ...normalized, statusCode, payload: { admissionId: `ingress:${'b'.repeat(64)}`, generation, after, connector: 'MAX_BOT' }
  }), null);
  for (const payload of ['<html>secret</html>', {}, { admissionId: 'unknown', generation, after, connector: 'MAX_BOT' },
    { admissionId: `ingress:${'b'.repeat(64)}`, generation: 'wrong', after }]) {
    assert.equal(run('fn_max_generation_admit_response.js', { ...normalized, statusCode: 200, payload }), null);
  }
});
test('unknown bot, missing token and partial config hold rather than falling back', () => {
  const normalized = run('fn_max_webhook_prepare.js', message(now - 1000))[0];
  for (const overrides of [{ MAX_CONNECTOR: 'OTHER' }, { SUPPORT_MAX_GENERATION_TOKEN: null },
    { SUPPORT_MAX_GENERATION: null }, { SUPPORT_MAX_GENERATION_AFTER: 'invalid' }]) {
    assert.equal(run('fn_max_generation_admit_prepare.js', { ...normalized }, overrides), null);
  }
  assert.equal(run('fn_max_webhook_prepare.js', message(now), { SUPPORT_MAX_GENERATION: null })[0], null);
});
test('fresh callback uses its callback ID and event timestamp, never old message timestamp', () => {
  const payload = message(now - 1000).payload;
  payload.callback = { callback_id: 'synthetic-callback' };
  payload.message.timestamp = now - 120000;
  const update = run('fn_max_webhook_prepare.js', { payload })[0].maxUpdate;
  assert.equal(update.messageId, 'synthetic-callback');
  assert.equal(update.timestamp, now - 1000);
});
test('unset configuration preserves legacy behavior', () => {
  const result = run('fn_max_webhook_prepare.js', message(undefined), {
    SUPPORT_MAX_GENERATION: null, SUPPORT_MAX_GENERATION_AFTER: null
  });
  assert.ok(result[0]);
  assert.equal(result[0].maxUpdate.providerTimestampVerified, undefined);
});

test('new-only webhook requires the existing provider secret', () => {
  assert.equal(run('fn_max_webhook_prepare.js', { ...message(now - 1000), req: { headers: {} } })[0], null);
  const result = run('fn_max_webhook_prepare.js', { ...message(now - 1000), req: { headers: { 'x-max-bot-api-secret': 'synthetic-secret' } } }, { MAX_BOT_WEBHOOK_SECRET: 'synthetic-secret' });
  assert.ok(result[0]);
});

for (const connector of ['MAX_BOT', 'MAX_ACADEMY_BOT']) test(`${connector}: one bot scope survives normalize/admit/lookup/route`, () => {
  const overrides = { MAX_CONNECTOR: connector };
  const normalized = run('fn_max_webhook_prepare.js', message(now - 1000), overrides)[0];
  const request = run('fn_max_generation_admit_prepare.js', normalized, overrides);
  assert.equal(request.payload.connector, connector);
  const accepted = run('fn_max_generation_admit_response.js', { ...request, statusCode: 201,
    payload: { admissionId: `ingress:${'c'.repeat(64)}`, connector, generation, after } }, overrides);
  assert.ok(accepted);
  const lookup = run('fn_max_client_lookup_prepare.js', { ...accepted }, overrides);
  assert.equal(new URL(lookup.url).searchParams.get('connector'), connector);
  const route = run('fn_max_support_route.js', { ...accepted, payload: {} }, overrides);
  assert.equal(route[0].payload.connector, connector);
  assert.equal(route[0].payload.sourceConnector, connector);
  assert.equal(route[0].payload.meta.maxIngressAdmission, accepted.maxIngressAdmission.admissionId);
  assert.equal(run('fn_max_support_route.js', { ...accepted, payload: {} }, { MAX_CONNECTOR: connector === 'MAX_BOT' ? 'MAX_ACADEMY_BOT' : 'MAX_BOT' }), null);
});

test('actual contrib callback wrapper uses fresh callback.timestamp over old data.timestamp', () => {
  const payload = { callback: { callback_id: 'synthetic-contrib-click', timestamp: now - 1000 },
    data: { timestamp: now - 120000, body: { mid: 'old-message', text: 'old text' },
      sender: { user_id: 'synthetic-user' }, recipient: { chat_id: 'synthetic-chat' } } };
  const update = run('fn_max_webhook_prepare.js', { payload })[0].maxUpdate;
  assert.equal(update.timestamp, now - 1000);
  assert.equal(update.messageId, 'synthetic-contrib-click');
  delete payload.callback.timestamp;
  assert.equal(run('fn_max_webhook_prepare.js', { payload })[0], null);
});

for (const connector of ['MAX_BOT', 'MAX_ACADEMY_BOT']) test(`${connector}: legacy new-only outbox has scoped auth, target type and no credential forwarding`, () => {
  const overrides = { MAX_CONNECTOR: connector };
  const request = run('fn_max_generation_outbox_pull_prepare.js', {}, overrides);
  assert.equal(new URL(request.url).searchParams.get('connector'), connector);
  assert.equal(new URL(request.url).searchParams.has('receiptProtocol'), false);
  assert.equal(request.headers['x-max-generation-token'], 'synthetic-token');
  for (const target of [{ targetExternalChatId: 'synthetic-chat' }, { targetExternalUserId: 'synthetic-user' }]) {
    const command = { id: 'synthetic-command', connector, status: 'LEASED', attempts: 1,
      leasedUntil: new Date(Date.now() + 60000).toISOString(), text: 'synthetic body', ...target,
      meta: { legacyMaxLeaseId: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc',
        maxGenerationAdmission: { schema: 1, generation, after } } };
    const sent = run('fn_max_generation_outbox_dispatch_prepare.js', { payload: command, headers: request.headers }, overrides)[0];
    if (!target.targetExternalChatId) { assert.equal(sent, null, 'user-only requires native sender target attestation'); continue; }
    assert.ok(sent); assert.equal(sent.headers, undefined);
    assert.equal(sent.chatId, target.targetExternalChatId); assert.equal(sent.userId, target.targetExternalUserId);
    const ack = run('fn_max_generation_outbox_ack_prepare.js', sent, overrides);
    assert.equal(ack.headers['x-max-generation-token'], 'synthetic-token');
    assert.deepEqual(ack.payload, {});
    const failed = run('fn_max_generation_outbox_fail_prepare.js', { supportOutbox: command, error: { message: 'PRIVATE PROVIDER ERROR' } }, overrides);
    assert.equal(failed.headers['x-max-generation-token'], 'synthetic-token');
    assert.deepEqual(failed.payload, { error: 'DELIVERY_UNKNOWN', requeue: false });
    assert.ok(!JSON.stringify(failed).includes('PRIVATE PROVIDER ERROR'));
    assert.equal(run('fn_max_generation_outbox_dispatch_prepare.js', { payload: { ...command, attempts: 2 } }, overrides)[0], null);
    assert.equal(run('fn_max_generation_outbox_dispatch_prepare.js', { payload: { ...command, meta: {} } }, overrides)[0], null);
  }
  const normalized = run('fn_max_webhook_prepare.js', message(now - 1000), overrides)[0];
  const admitted = { ...normalized, maxIngressAdmission: { admissionId: `ingress:${'d'.repeat(64)}`, generation, after, connector } };
  const routed = run('fn_max_support_route.js', { ...admitted, headers: request.headers, payload: {} }, overrides);
  assert.equal(routed[0].headers['x-max-generation-token'], 'synthetic-token');
  assert.ok(!JSON.stringify(routed[2]).includes('synthetic-token'));
});
