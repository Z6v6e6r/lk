import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { createCampaignEngine } from '../telegram_reactivation/engine.mjs';
import { buildFlow } from '../telegram_reactivation/build_flow.mjs';

function matches(doc, query) {
  return Object.entries(query).every(([key, value]) => key === '$or'
    ? value.some(q => matches(doc, q))
    : value && typeof value === 'object' && '$lte' in value ? doc[key] <= value.$lte : doc[key] === value);
}
class MemoryCollection {
  docs = new Map();
  failWrite;
  async createIndex() { return 'test_index'; }
  async findOne(query) { return structuredClone([...this.docs.values()].find(d => matches(d, query)) ?? null); }
  update(doc, changes) {
    Object.assign(doc, changes.$set ?? {});
    for (const [key, value] of Object.entries(changes.$inc ?? {})) doc[key] = (doc[key] ?? 0) + value;
    for (const key of Object.keys(changes.$unset ?? {})) delete doc[key];
  }
  async insertOne(doc) {
    if (this.docs.has(doc._id)) throw Object.assign(new Error('duplicate'), { code: 11000 });
    this.docs.set(doc._id, structuredClone(doc));
    return { acknowledged: true, insertedId: doc._id };
  }
  async updateOne(query, changes, options = {}) {
    if (this.failWrite?.(changes)) throw new Error('mongo-secret-URI-driver-error');
    const doc = [...this.docs.values()].find(d => matches(d, query));
    if (!doc && options.upsert) {
      this.docs.set(query._id, structuredClone({ _id: query._id, ...changes.$setOnInsert }));
      return { acknowledged: true, matchedCount: 0, upsertedCount: 1 };
    }
    if (doc) this.update(doc, changes);
    return { acknowledged: true, matchedCount: doc ? 1 : 0 };
  }
  async updateMany(query, changes) {
    const docs = [...this.docs.values()].filter(d => matches(d, query));
    docs.forEach(d => this.update(d, changes));
    return { acknowledged: true, matchedCount: docs.length };
  }
  async findOneAndUpdate(query, changes) {
    const doc = [...this.docs.values()].find(d => matches(d, query));
    if (!doc) return null;
    this.update(doc, changes);
    return structuredClone(doc);
  }
  async countDocuments(query) { return [...this.docs.values()].filter(d => matches(d, query)).length; }
  async deleteOne(query) {
    const doc = [...this.docs.values()].find(d => matches(d, query));
    if (doc) this.docs.delete(doc._id);
    return { acknowledged: true, deletedCount: doc ? 1 : 0 };
  }
  aggregate(pipeline) {
    const counts = new Map();
    for (const doc of this.docs.values()) {
      if (!matches(doc, pipeline[0].$match)) continue;
      const key = `${doc.campaignId}:${doc.status}`;
      const row = counts.get(key) ?? { _id: { campaignId: doc.campaignId, status: doc.status }, count: 0, attempts: 0 };
      row.count++;
      row.attempts += doc.attempts;
      counts.set(key, row);
    }
    return { toArray: async () => [...counts.values()] };
  }
}
function setup() {
  const collections = new Map();
  const db = { collection: name => {
    if (!collections.has(name)) collections.set(name, new MemoryCollection());
    return collections.get(name);
  } };
  const manifest = { schemaVersion: 1, batchId: 'reactivation-20260930-test', audienceSnapshotDate: '2026-09-30',
    campaigns: ['academy', 'friendship', 'group', 'return'].map((campaignId, i) => ({ campaignId, recipients: [{ chatId: String(1001 + i) }] })) };
  const config = { schemaVersion: 1, botId: '1000', campaigns: manifest.campaigns.map(c => ({
    campaignId: c.campaignId, type: 'photo', fileId: 'synthetic_file_identifier_only',
    text: 'Test https://example.test/offer', link: 'https://example.test/offer', utmConfirmed: true,
    utm: { source: 'telegram', medium: 'bot', campaign: `test_${c.campaignId}` }
  })) };
  const calls = [];
  const result = { current: null };
  let clock = new Date('2026-10-06T20:00:00Z');
  const transport = async (method, payload) => {
    calls.push({ method, payload });
    if (method === 'getMe') return { ok: true, result: { id: 1000, is_bot: true } };
    if (result.current instanceof Error) throw result.current;
    return result.current ?? { ok: true, result: { message_id: 42, chat: { id: Number(payload.chat_id) } } };
  };
  const dependencies = { db, crypto, transport, sendEnabled: true, wait: async () => {}, now: () => clock };
  const engine = createCampaignEngine(dependencies);
  return { engine, dependencies, manifest, config, calls, result, db,
    tick: seconds => { clock = new Date(clock.getTime() + seconds * 1000); } };
}
const sends = s => s.calls.filter(c => c.method.startsWith('send'));

test('source-driven flow is disabled, has no auto timers/routes/credentials and compiles', () => {
  const flow = buildFlow();
  assert.equal(flow.length, 13);
  assert.equal(flow[0].disabled, true);
  assert.ok(flow.filter(n => n.type === 'inject').every(n => n.once === false && !n.repeat && !n.crontab));
  assert.ok(!flow.some(n => n.type.startsWith('http')));
  const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor;
  for (const node of flow.filter(n => n.type === 'function')) new AsyncFunction('msg', 'node', 'context', 'env', node.func);
  const ids = new Set(flow.map(n => n.id));
  assert.equal(ids.size, flow.length);
  assert.ok(flow.every(n => (n.wires ?? []).flat().every(id => ids.has(id))));
});
test('CLI actually exports its disabled flow from paths containing spaces', () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'tg campaign test '));
  try {
    const file = path.join(directory, 'new flow.json');
    const cli = fileURLToPath(new URL('../telegram_reactivation/build_flow.mjs', import.meta.url));
    const result = spawnSync(process.execPath, [cli, file], { encoding: 'utf8' });
    assert.equal(result.status, 0, result.stderr);
    const exported = JSON.parse(fs.readFileSync(file, 'utf8'));
    assert.equal(exported[0].disabled, true);
    assert.equal(exported.length, 13);
    assert.equal(fs.statSync(file).mode & 0o777, 0o600);
    assert.notEqual(spawnSync(process.execPath, [cli, file]).status, 0);
  } finally { fs.rmSync(directory, { recursive: true }); }
});
test('four disjoint cohorts, UTM and ready messages are mandatory', () => {
  const s = setup();
  s.engine.validate(s.manifest, s.config, true);
  s.manifest.campaigns[1].recipients[0].chatId = '1001';
  assert.throws(() => s.engine.validate(s.manifest, s.config, true), /duplicate_endpoint/);
  const t = setup();
  t.config.campaigns[0].utmConfirmed = false;
  assert.throws(() => t.engine.validate(t.manifest, t.config, true), /utm_not_confirmed/);
  t.config.campaigns[0].utmConfirmed = true;
  t.config.campaigns[0].fileId = '';
  assert.throws(() => t.engine.validate(t.manifest, t.config, true), /message_not_ready/);
});
test('confirmed existing UTM labels are preserved and full URL mismatches fail', () => {
  const s = setup();
  const m = s.config.campaigns[0];
  m.utm = { source: 'tg', medium: 'messenger', campaign: 'existing_academy' };
  m.link = 'https://example.test/offer?utm_source=tg&utm_medium=messenger&utm_campaign=existing_academy';
  m.text = `Test ${m.link}`;
  assert.deepEqual(s.engine.validate(s.manifest, s.config, true).messages[0].utm, m.utm);
  m.utm.campaign = 'different';
  assert.throws(() => s.engine.validate(s.manifest, s.config, true), /utm_mismatch/);
});
test('preparation is idempotent and cannot reset completed recipients', async () => {
  const s = setup();
  await s.engine.prepare(s.manifest, s.config);
  await s.engine.run(s.manifest, s.config, 25, 'friendship');
  await s.engine.prepare(s.manifest, s.config);
  await s.engine.run(s.manifest, s.config, 25, 'friendship');
  assert.equal(sends(s).length, 1);
  assert.equal((await s.engine.report(s.manifest.batchId)).campaigns[1].accepted, 1);
});
test('partial preparation is not runnable, retry completes without duplicate sends', async () => {
  const s = setup();
  const rows = s.db.collection('tg_reactivation_recipients');
  let seeded = 0;
  rows.failWrite = change => change.$setOnInsert && ++seeded === 2;
  await assert.rejects(s.engine.prepare(s.manifest, s.config));
  await assert.rejects(s.engine.run(s.manifest, s.config), /batch_not_prepared/);
  rows.failWrite = null;
  await s.engine.prepare(s.manifest, s.config);
  await s.engine.run(s.manifest, s.config);
  assert.equal(sends(s).length, 4);
});
test('exact Telegram acceptance is unique; purchases remain unavailable', async () => {
  const s = setup();
  await s.engine.prepare(s.manifest, s.config);
  const report = await s.engine.run(s.manifest, s.config);
  await s.engine.run(s.manifest, s.config);
  assert.equal(sends(s).length, 4);
  assert.ok(report.campaigns.every(c => c.accepted === 1 && c.acceptanceRate === 1 && c.purchased === null));
  assert.ok(!JSON.stringify(report).includes('chatId'));
});
test('403 blocked is distinct from deactivated, 400 chat-not-found and generic 403', () => {
  const { engine } = setup();
  assert.equal(engine.classify({ ok: false, error_code: 403, description: 'Forbidden: bot was blocked by the user' }).status, 'blocked');
  assert.equal(engine.classify({ ok: false, error_code: 403, description: 'Forbidden: user is deactivated' }).status, 'unreachable');
  assert.equal(engine.classify({ ok: false, error_code: 400, description: 'Bad Request: chat not found' }).status, 'unreachable');
  assert.equal(engine.classify({ ok: false, error_code: 403, description: 'Forbidden: other reason' }).status, 'failed');
});
test('429 halts the batch, respects retry_after, then retries once', async () => {
  const s = setup();
  await s.engine.prepare(s.manifest, s.config);
  s.result.current = { ok: false, error_code: 429, parameters: { retry_after: 60 } };
  const r = await s.engine.run(s.manifest, s.config);
  assert.equal(r.pauseReason, 'rate_limited');
  assert.equal(sends(s).length, 1);
  await assert.rejects(s.engine.run(s.manifest, s.config), /rate_limit_wait/);
  s.tick(61);
  s.result.current = null;
  await s.engine.run(s.manifest, s.config);
  assert.equal(sends(s).length, 5);
});
test('timeout and mismatched accepted chat are unknown and never requeued', async () => {
  for (const response of [new Error('secret-token-network-error'), { ok: true, result: { message_id: 42, chat: { id: 999 } } }]) {
    const s = setup();
    await s.engine.prepare(s.manifest, s.config);
    s.result.current = response;
    const r = await s.engine.run(s.manifest, s.config, 25, 'academy');
    assert.equal(r.campaigns[0].unknown, 1);
    await s.engine.run(s.manifest, s.config, 25, 'academy');
    assert.equal(sends(s).length, 1);
    assert.ok(!JSON.stringify(r).includes('secret-token'));
  }
});
test('acceptance then failed persistence fences bot; recovery marks unknown, never resends', async () => {
  const s = setup();
  await s.engine.prepare(s.manifest, s.config);
  s.db.collection('tg_reactivation_recipients').failWrite = change => change.$set?.status === 'accepted';
  await assert.rejects(s.engine.run(s.manifest, s.config, 25, 'academy'));
  const report = await s.engine.report(s.manifest.batchId);
  assert.equal(report.campaigns[0].sending, 1);
  assert.ok(report.lock);
  await assert.rejects(s.engine.run(s.manifest, s.config), /bot_locked/);
  await assert.rejects(s.engine.recover(s.config.botId, report.lock.owner, false), /stopped_worker/);
  s.db.collection('tg_reactivation_recipients').failWrite = null;
  const recovered = await s.engine.recover(s.config.botId, report.lock.owner, true);
  assert.equal(recovered.campaigns[0].unknown, 1);
  await s.engine.run(s.manifest, s.config, 25, 'academy');
  assert.equal(sends(s).length, 1);
});
test('message/audience changes and wrong bot identity cannot send', async () => {
  const s = setup();
  await s.engine.prepare(s.manifest, s.config);
  s.config.campaigns[0].text += '!';
  await assert.rejects(s.engine.run(s.manifest, s.config), /immutable_batch_mismatch/);
  const t = setup();
  await t.engine.prepare(t.manifest, t.config);
  const e = createCampaignEngine({ ...t.dependencies, transport: async () => ({ ok: true, result: { id: 999, is_bot: true } }) });
  await assert.rejects(e.run(t.manifest, t.config), /bot_identity_mismatch/);
  assert.equal(sends(s).length + sends(t).length, 0);
});
test('parallel start cannot duplicate an acknowledged claim', async () => {
  const s = setup();
  await s.engine.prepare(s.manifest, s.config);
  const second = createCampaignEngine(s.dependencies);
  const result = await Promise.allSettled([s.engine.run(s.manifest, s.config), second.run(s.manifest, s.config)]);
  assert.equal(result.filter(r => r.status === 'fulfilled').length, 1);
  assert.equal(sends(s).length, 4);
});
test('send disabled gate prevents any API call or live write', async () => {
  const s = setup();
  const e = createCampaignEngine({ ...s.dependencies, sendEnabled: false });
  await assert.rejects(e.run(s.manifest, s.config), /sending_disabled/);
  assert.equal(s.calls.length, 0);
});
test('shutdown after outstanding Mongo claim never begins a new API send', async () => {
  const s = setup();
  await s.engine.prepare(s.manifest, s.config);
  const rows = s.db.collection('tg_reactivation_recipients');
  const claim = rows.findOneAndUpdate.bind(rows);
  rows.findOneAndUpdate = async (...args) => {
    const row = await claim(...args);
    s.engine.stop();
    return row;
  };
  const result = await s.engine.run(s.manifest, s.config);
  assert.equal(sends(s).length, 0);
  assert.ok(result.campaigns.every(c => c.pending === 1 && c.attempts === 0));
  assert.equal(result.lock, null);
  assert.equal(result.pauseReason, 'stopped');
});
test('STOP remains usable while a full campaign is busy', async () => {
  const source = buildFlow().find(n => n.type === 'function').func;
  const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor;
  const fn = new AsyncFunction('msg', 'node', 'context', 'env', 'mongo', 'https', 'crypto', 'fs', source);
  const emitted = [];
  let stopped = false;
  await fn({ action: 'stop' }, { send: m => emitted.push(m) },
    { get: key => key === 'busy' ? true : { stop: () => { stopped = true; } }, set: () => {} },
    {}, {}, {}, {}, {});
  assert.equal(stopped, true);
  assert.deepEqual(emitted, [{ payload: { status: 'stop_requested' } }]);
});
test('STOP and shutdown during deferred Mongo connection cancel START before sending', async () => {
  for (const action of ['stop', 'finalize']) {
  const source = buildFlow().find(n => n.type === 'function').func;
  const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor;
  const fn = new AsyncFunction('msg', 'node', 'context', 'env', 'mongo', 'https', 'crypto', 'fs', source);
  const values = new Map();
  const context = { get: key => values.get(key), set: (key, value) => values.set(key, value) };
  const emitted = [];
  const node = { send: m => emitted.push(m) };
  let resolveConnect;
  const connecting = new Promise(resolve => { resolveConnect = resolve; });
  let closed = false;
  class Client {
    connect() { return connecting; }
    db() { return {}; }
    async close() { closed = true; }
  }
  const env = { get: () => '/private/synthetic.json' };
  const fsMock = { lstatSync: () => ({ isFile: () => true, isSymbolicLink: () => false, mode: 0o600 }), readFileSync: () => '{}' };
  const running = fn({ action: 'start', campaignId: 'academy' }, node, context, env, { MongoClient: Client }, {}, crypto, fsMock);
  assert.equal(context.get('busy'), true);
  const newEngine = { stop: () => {} };
  if (action === 'stop') {
    await fn({ action: 'stop' }, node, context, env, {}, {}, crypto, fsMock);
    assert.deepEqual(emitted, [{ payload: { status: 'stop_requested' } }]);
  } else {
    new Function('context', buildFlow().find(n => n.type === 'function').finalize)(context);
    // A new invocation registering its own job must not cancel the old cancellation.
    context.set('job', { stopped: false });
    context.set('busy', true);
    context.set('engine', newEngine);
  }
  resolveConnect();
  await running;
  assert.equal(closed, true);
  assert.equal(context.get('busy'), action === 'finalize');
  if (action === 'finalize') assert.equal(context.get('engine'), newEngine);
  assert.deepEqual(emitted.at(-1), { payload: { error: 'operation_stopped', action: 'start' } });
  }
});
test('Function emits fixed error codes, never arbitrary lowercase provider/user text', async () => {
  const source = buildFlow().find(n => n.type === 'function').func;
  const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor;
  const fn = new AsyncFunction('msg', 'node', 'context', 'env', 'mongo', 'https', 'crypto', 'fs', source);
  const context = new Map();
  const emitted = [];
  await fn({ action: 'preview', privateIncomingData: 'do_not_echo' },
    { send: message => emitted.push(message), warn: () => {} },
    { get: key => context.get(key), set: (key, value) => context.set(key, value) },
    { get: () => '/private/test-config.json' }, {}, {}, crypto,
    { lstatSync: () => { throw new Error('private_user_name'); } });
  assert.deepEqual(emitted, [{ payload: { error: 'reactivation_operation_failed', action: 'preview' } }]);
});

function cohortSizes(s, sizes) {
  let endpoint = 2001;
  for (const campaign of s.manifest.campaigns) {
    campaign.recipients = Array.from({ length: sizes[campaign.campaignId] ?? 1 }, () => ({ chatId: String(endpoint++) }));
  }
}

function orchestrationHarness(s, { sendEnabled = true, afterRun } = {}) {
  const original = buildFlow().find(n => n.type === 'function').func;
  const factorySource = `const createCampaignEngine = ${createCampaignEngine.toString()};`;
  assert.ok(original.includes(factorySource));
  const source = original.replace(factorySource, 'const createCampaignEngine = injectedEngineFactory;');
  const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor;
  const fn = new AsyncFunction('msg', 'node', 'context', 'env', 'mongo', 'https', 'crypto', 'fs', 'injectedEngineFactory', source);
  const state = new Map();
  const context = { get: key => state.get(key), set: (key, value) => state.set(key, value) };
  const emitted = [];
  const runs = [];
  let closedClients = 0;
  class Client {
    async connect() {}
    db() { return s.db; }
    async close() { closedClients++; }
  }
  const settings = {
    TG_REACTIVATION_MANIFEST: '/private/synthetic-manifest.json',
    TG_REACTIVATION_CONFIG: '/private/synthetic-config.json',
    TG_REACTIVATION_MONGO_URI: 'mongodb://synthetic.invalid',
    TG_REACTIVATION_MONGO_DB: 'synthetic',
    TG_REACTIVATION_SEND_ENABLED: sendEnabled ? 'true' : 'false',
  };
  const privateFiles = {
    lstatSync: () => ({ isFile: () => true, isSymbolicLink: () => false, mode: 0o600 }),
    readFileSync: file => JSON.stringify(file === settings.TG_REACTIVATION_CONFIG ? s.config : s.manifest),
  };
  const injectedEngineFactory = options => {
    const engine = createCampaignEngine({ ...s.dependencies, ...options, transport: s.dependencies.transport });
    return { ...engine, run: async (...args) => {
      runs.push({ campaignId: args[3], limit: args[2] });
      const report = await engine.run(...args);
      return afterRun ? afterRun(report, args[3]) : report;
    } };
  };
  return {
    state, emitted, runs, closedClients: () => closedClients,
    execute: msg => fn(msg, { send: m => emitted.push(structuredClone(m)), warn: () => {} }, context,
      { get: key => settings[key] }, { MongoClient: Client }, {}, crypto, privateFiles, injectedEngineFactory),
  };
}

test('START ALL drains larger cohorts in sequential 25-recipient chunks without duplicates', async () => {
  const s = setup();
  cohortSizes(s, { friendship: 52, group: 2, return: 26, academy: 27 });
  await s.engine.prepare(s.manifest, s.config);
  const h = orchestrationHarness(s);
  await h.execute({ action: 'start_all' });
  assert.deepEqual(h.runs.map(r => r.campaignId), ['friendship', 'friendship', 'friendship', 'group', 'return', 'return', 'academy', 'academy']);
  assert.ok(h.runs.every(r => r.limit === 25));
  assert.equal(sends(s).length, 107);
  assert.equal(new Set(sends(s).map(c => c.payload.chat_id)).size, 107);
  const final = h.emitted.at(-1).payload;
  assert.ok(final.campaigns.every(c => c.pending === 0 && c.accepted === c.eligible));
  assert.equal(final.lock, null);
  assert.equal(h.state.get('busy'), false);
  assert.equal(h.closedClients(), 1);
});

test('START ALL skips completed campaigns and a second invocation cannot resend them', async () => {
  const s = setup();
  await s.engine.prepare(s.manifest, s.config);
  await s.engine.run(s.manifest, s.config, 25, 'group');
  s.calls.length = 0;
  const h = orchestrationHarness(s);
  await h.execute({ action: 'start_all' });
  assert.deepEqual(h.runs.map(r => r.campaignId), ['friendship', 'return', 'academy']);
  assert.equal(sends(s).length, 3);
  await h.execute({ action: 'start_all' });
  assert.equal(h.runs.length, 3);
  assert.equal(sends(s).length, 3);
  assert.ok(h.emitted.at(-1).payload.campaigns.every(c => c.accepted === 1));
});

test('START ALL initial unknown, sending or bot lock fences every campaign before an API call', async () => {
  for (const fence of ['unknown', 'sending', 'lock']) {
    const s = setup();
    await s.engine.prepare(s.manifest, s.config);
    if (fence === 'lock') {
      await s.db.collection('tg_reactivation_batches').insertOne({ _id: `lock:${s.config.botId}`,
        botId: s.config.botId, batchId: s.manifest.batchId, owner: 'another-worker', startedAt: s.dependencies.now() });
    } else {
      await s.db.collection('tg_reactivation_recipients').updateOne({ _id: `${s.manifest.batchId}:1001` },
        { $set: { status: fence } });
    }
    const h = orchestrationHarness(s);
    await h.execute({ action: 'start_all' });
    assert.deepEqual(h.emitted, [{ payload: { error: 'campaign_requires_review', action: 'start_all' } }]);
    assert.equal(h.runs.length, 0);
    assert.equal(s.calls.length, 0);
    assert.equal(h.state.get('busy'), false);
  }
});

test('START ALL aborts all remaining campaigns after a 429 or uncertain send', async () => {
  for (const response of [{ ok: false, error_code: 429, parameters: { retry_after: 60 } }, new Error('synthetic-network-failure')]) {
    const s = setup();
    await s.engine.prepare(s.manifest, s.config);
    s.result.current = response;
    const h = orchestrationHarness(s);
    await h.execute({ action: 'start_all' });
    assert.deepEqual(h.runs.map(r => r.campaignId), ['friendship']);
    assert.equal(sends(s).length, 1);
    const final = h.emitted.at(-1).payload;
    assert.equal(final.pauseReason, response instanceof Error ? 'send_requires_review' : 'rate_limited');
    assert.ok(final.campaigns.filter(c => c.campaignId !== 'friendship').every(c => c.pending === 1 && c.attempts === 0));
    assert.equal(final.lock, null);
  }
});

test('STOP during START ALL finishes its in-flight send and aborts the remaining queue', async () => {
  const s = setup();
  cohortSizes(s, { friendship: 26 });
  await s.engine.prepare(s.manifest, s.config);
  let releaseSend;
  let beganSend;
  const pendingSend = new Promise(resolve => { releaseSend = resolve; });
  const sendStarted = new Promise(resolve => { beganSend = resolve; });
  const transport = s.dependencies.transport;
  s.dependencies.transport = async (method, payload) => {
    if (method.startsWith('send')) { beganSend(); await pendingSend; }
    return transport(method, payload);
  };
  const h = orchestrationHarness(s);
  const running = h.execute({ action: 'start_all' });
  await sendStarted;
  await h.execute({ action: 'stop' });
  releaseSend();
  await running;
  assert.deepEqual(h.runs.map(r => r.campaignId), ['friendship']);
  assert.equal(sends(s).length, 1);
  assert.ok(h.emitted.some(m => m.payload.status === 'stop_requested'));
  const final = h.emitted.at(-1).payload;
  assert.equal(final.pauseReason, 'stopped');
  assert.equal(final.campaigns.find(c => c.campaignId === 'friendship').pending, 25);
  assert.ok(final.campaigns.filter(c => c.campaignId !== 'friendship').every(c => c.pending === 1 && c.attempts === 0));
  assert.equal(final.lock, null);
  assert.equal(h.state.get('busy'), false);
});

test('START ALL with sending disabled cannot call Telegram or claim a recipient', async () => {
  const s = setup();
  await s.engine.prepare(s.manifest, s.config);
  const h = orchestrationHarness(s, { sendEnabled: false });
  await h.execute({ action: 'start_all' });
  assert.deepEqual(h.emitted, [{ payload: { error: 'sending_disabled', action: 'start_all' } }]);
  assert.equal(s.calls.length, 0);
  const report = await s.engine.report(s.manifest.batchId);
  assert.ok(report.campaigns.every(c => c.pending === 1 && c.attempts === 0));
  assert.equal(report.lock, null);
});

test('START ALL fences a future retry_wait with no claim instead of spinning', async () => {
  const s = setup();
  await s.engine.prepare(s.manifest, s.config);
  await s.db.collection('tg_reactivation_recipients').updateOne({ _id: `${s.manifest.batchId}:1002` },
    { $set: { status: 'retry_wait', nextAttemptAt: new Date(s.dependencies.now().getTime() + 60000) } });
  const h = orchestrationHarness(s);
  await h.execute({ action: 'start_all' });
  assert.deepEqual(h.runs.map(r => r.campaignId), ['friendship']);
  assert.equal(sends(s).length, 0);
  assert.deepEqual(h.emitted.at(-1), { payload: { error: 'campaign_no_progress', action: 'start_all' } });
  assert.equal(h.state.get('busy'), false);
});

test('START ALL aborts a chunk report with unresolved sending before a further chunk or campaign', async () => {
  const s = setup();
  cohortSizes(s, { friendship: 26 });
  await s.engine.prepare(s.manifest, s.config);
  const h = orchestrationHarness(s, { afterRun: report => ({ ...report,
    campaigns: report.campaigns.map(c => c.campaignId === 'friendship' ? { ...c, sending: 1 } : c) }) });
  await h.execute({ action: 'start_all' });
  assert.deepEqual(h.runs.map(r => r.campaignId), ['friendship']);
  assert.equal(sends(s).length, 25);
  assert.ok(h.emitted.at(-1).payload.campaigns.filter(c => c.campaignId !== 'friendship').every(c => c.pending === 1));
});
