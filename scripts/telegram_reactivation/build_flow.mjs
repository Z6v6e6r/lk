import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createCampaignEngine } from './engine.mjs';

export function buildFlow() {
  const z = 'tg_reactivation_v1';
  const f = 'tg_reactivation_engine_v1';
  const actions = ['preview', 'prepare', 'run', 'report'];
  const nodes = [{ id: z, type: 'tab', label: 'TG Reactivation — 4 campaigns', disabled: true,
    info: 'Standalone module. Manual buttons only. No public routes. See docs/TELEGRAM_REACTIVATION.md. Import disabled; never reuse old send-all inject.' }];
  for (const [i, action] of actions.entries()) nodes.push({ id: `tg_reactivation_${action}_v1`, z,
    type: 'inject', name: action === 'run' ? 'RUN up to 25 (requires env gate)' : action.toUpperCase(),
    props: [{ p: 'action', v: action, vt: 'str' }, { p: 'campaignId', v: 'academy', vt: 'str' }], repeat: '', crontab: '', once: false, onceDelay: 0.1,
    x: 200, y: 80 + 60 * i, wires: [[f]] });
  for (const [i, campaignId] of ['academy', 'friendship', 'group', 'return'].entries()) nodes.push({
    id: `tg_reactivation_start_${campaignId}_v1`, z, type: 'inject', name: `START ${campaignId} (full cohort)`,
    props: [{ p: 'action', v: 'start', vt: 'str' }, { p: 'campaignId', v: campaignId, vt: 'str' }],
    repeat: '', crontab: '', once: false, onceDelay: 0.1, x: 200, y: 350 + 60 * i, wires: [[f]] });
  nodes.push({ id: 'tg_reactivation_stop_v1', z, type: 'inject', name: 'STOP after current request',
    props: [{ p: 'action', v: 'stop', vt: 'str' }], repeat: '', crontab: '', once: false,
    onceDelay: 0.1, x: 200, y: 620, wires: [[f]] });
  nodes.push({ id: f, z, type: 'function', name: 'Durable campaigns (aggregate output only)', outputs: 1,
    timeout: 0, x: 590, y: 170, wires: [['tg_reactivation_totals_v1']],
    initialize: `context.set('busy', false);`,
    finalize: `const job = context.get('job'); if (job) job.stopped = true; const engine = context.get('engine'); if (engine) engine.stop();`,
    libs: [{ var: 'mongo', module: 'mongodb' }, { var: 'https', module: 'https' },
      { var: 'crypto', module: 'crypto' }, { var: 'fs', module: 'fs' }],
    func: `const createCampaignEngine = ${createCampaignEngine.toString()};
if (msg.action === 'stop') {
  const running = context.get('engine');
  const busy = context.get('busy');
  const job = context.get('job');
  if (job) job.stopped = true;
  if (running) running.stop();
  node.send({ payload: { status: running || busy ? 'stop_requested' : 'idle' } });
  done();
  return;
}
if (context.get('busy')) { node.warn('reactivation_busy'); return null; }
context.set('busy', true);
// Keep cancellation on this invocation's object, so a redeploy/new job cannot clear it.
const job = { stopped: false };
context.set('job', job);
let client;
try {
  const readPrivate = name => {
    const p = env.get(name);
    if (!p || !p.startsWith('/')) throw new Error('private_file_path_missing');
    const s = fs.lstatSync(p);
    if (!s.isFile() || s.isSymbolicLink() || (s.mode & 0o077)) throw new Error('private_file_permissions_required');
    return JSON.parse(fs.readFileSync(p, 'utf8'));
  };
  const manifest = readPrivate('TG_REACTIVATION_MANIFEST');
  const config = readPrivate('TG_REACTIVATION_CONFIG');
  let db;
  if (msg.action !== 'preview') {
    const uri = env.get('TG_REACTIVATION_MONGO_URI');
    const database = env.get('TG_REACTIVATION_MONGO_DB');
    if (!uri || !database) throw new Error('mongo_not_configured');
    client = new mongo.MongoClient(uri, { serverSelectionTimeoutMS: 10000, writeConcern: { w: 'majority' } });
    await client.connect();
    db = client.db(database);
  }
  if (job.stopped) throw new Error('operation_stopped');
  const engine = createCampaignEngine({ db, crypto, https, token: env.get('TG_REACTIVATION_BOT_TOKEN'),
    sendEnabled: env.get('TG_REACTIVATION_SEND_ENABLED') === 'true' });
  context.set('engine', engine);
  let result;
  if (msg.action === 'preview') {
    const v = engine.validate(manifest, config, true);
    result = { batchId: v.batchId, audienceHash: v.audienceHash, configHash: v.configHash,
      counts: manifest.campaigns.map(c => ({ campaignId: c.campaignId, eligible: c.recipients.length })) };
  } else if (msg.action === 'prepare') result = await engine.prepare(manifest, config);
  else if (msg.action === 'run') result = await engine.run(manifest, config, 25, msg.campaignId);
  else if (msg.action === 'start') {
    if (!['academy','friendship','group','return'].includes(msg.campaignId)) throw new Error('invalid_campaign');
    do {
      result = await engine.run(manifest, config, 25, msg.campaignId);
      node.send({ payload: result });
      const totals = result.campaigns.find(c => c.campaignId === msg.campaignId);
      if (result.pauseReason || !totals.pending || totals.unknown) break;
    } while (true);
  }
  else if (msg.action === 'report') result = await engine.report(manifest.batchId);
  else if (msg.action === 'recover') result = await engine.recover(config.botId, msg.owner, msg.workerStopped);
  else throw new Error('unknown_action');
  node.send({ payload: result });
} catch (e) {
  // Allow only our fixed codes, never driver/provider errors, URI, token, or incoming msg.
  const allowed = new Set(['private_file_path_missing','private_file_permissions_required','mongo_not_configured','operation_stopped',
    'unknown_action','reactivation_busy','invalid_manifest_or_bot_id','four_campaigns_required','invalid_campaign',
    'invalid_or_duplicate_endpoint','message_not_ready','utm_not_confirmed','utm_mismatch','unique_utm_campaigns_required',
    'mongo_ack_missing','mongo_cas_failed','telegram_token_missing','immutable_batch_mismatch','audience_count_mismatch',
    'sending_disabled','invalid_batch_limit','batch_not_prepared','telegram_rate_limit_wait','bot_identity_mismatch',
    'bot_locked','claim_not_confirmed','unresolved_send_lock_retained','lock_release_failed',
    'recovery_requires_stopped_worker','recovery_lock_mismatch','batch_missing','unknown_ledger_state']);
  const code = allowed.has(e.message) ? e.message : 'reactivation_operation_failed';
  node.send({ payload: { error: code, action: ['preview','prepare','run','start','report','recover'].includes(msg.action) ? msg.action : 'invalid' } });
} finally {
  if (client) { try { await client.close(); } catch { /* no raw driver logs */ } }
  if (context.get('job') === job) {
    context.set('busy', false);
    context.set('engine', null);
    context.set('job', null);
  }
}
done();
return;` });
  nodes.push({ id: 'tg_reactivation_totals_v1', z, type: 'debug', name: 'Campaign totals (no recipient data)',
    active: true, tosidebar: true, console: false, complete: 'payload', targetType: 'msg',
    x: 980, y: 170, wires: [] });
  return nodes;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const output = process.argv[2];
  if (!output || !path.isAbsolute(output)) throw new Error('Absolute external output path required');
  await fs.writeFile(output, JSON.stringify(buildFlow(), null, 2) + '\n', { mode: 0o600, flag: 'wx' });
  console.log('Created disabled standalone flow; 12 nodes; no credentials or recipients included.');
}
