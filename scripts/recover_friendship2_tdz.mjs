#!/usr/bin/env node
// Incident-scoped local quote invalidation. All provider requests are GET;
// authentication uses the existing protected service binding without exporting it.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { createRequire } from 'node:module';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { planFriendship2TdzRecovery, FRIENDSHIP2_PRODUCT, TDZ_INCIDENT_START,
  hasTdzRecoveryEffects, dailyGuardKey, digest } from './lib/friendship2TdzRecovery.mjs';

export function parseRecoveryArgs(argv) {
  const allowed = new Set(['--output-dir', '--incident-end', '--expected-flow-sha256', '--approved-plan', '--approved-plan-sha256', '--operation-id']);
  const out = {};
  for (let i = 0; i < argv.length; i++) {
    const key = argv[i];
    if (!allowed.has(key) || out[key] !== undefined || !argv[i + 1] || argv[i + 1].startsWith('--')) throw Error('ARGUMENT_INVALID');
    out[key] = argv[++i];
  }
  if (!path.isAbsolute(out['--output-dir'] || '') || !Number.isFinite(Date.parse(out['--incident-end']))
    || !/^[a-f0-9]{64}$/.test(out['--expected-flow-sha256'] || '')) throw Error('ARGUMENT_REQUIRED');
  if ((out['--approved-plan'] !== undefined) !== (out['--approved-plan-sha256'] !== undefined)
    || out['--approved-plan'] && (!path.isAbsolute(out['--approved-plan']) || !/^[a-f0-9]{64}$/.test(out['--approved-plan-sha256']))) throw Error('APPROVED_PLAN_REQUIRED');
  if (out['--operation-id'] !== undefined && !/^[A-Za-z0-9:_-]{1,150}$/.test(out['--operation-id'])) throw Error('OPERATION_FILTER_INVALID');
  return out;
}
export function readApprovedRecoveryPlan(file, expectedSha) {
  const fd = fs.openSync(file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
  try {
    const st = fs.fstatSync(fd);
    if (!st.isFile() || st.nlink !== 1 || st.uid !== process.getuid() || st.mode & 0o077) throw Error('PRIVATE_FILE_REQUIRED');
    const bytes = fs.readFileSync(fd);
    if (sha(bytes) !== expectedSha) throw Error('APPROVED_PLAN_DRIFT');
    return JSON.parse(bytes);
  } finally { fs.closeSync(fd); }
}
function writeReceipt(dir, name, value) {
  const fd = fs.openSync(path.join(dir, name), fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_NOFOLLOW, 0o600);
  try { fs.writeFileSync(fd, JSON.stringify(value, null, 2) + '\n'); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
  const d = fs.openSync(dir, fs.constants.O_RDONLY); try { fs.fsyncSync(d); } finally { fs.closeSync(d); }
}
const sha = bytes => crypto.createHash('sha256').update(bytes).digest('hex');
export async function runRecovery(args) {
  const out = args['--output-dir'], end = args['--incident-end'], expectedFlow = args['--expected-flow-sha256'];
  if (process.getuid() !== 0 || fs.existsSync(out) || path.resolve(out) !== out || fs.realpathSync(path.dirname(out)) !== path.dirname(out)
    || fs.statSync(path.dirname(out)).uid !== process.getuid()
    || fs.statSync(path.dirname(out)).mode & 0o077 || Date.parse(end) > Date.now()) throw Error('PRIVATE_NEW_OUTPUT_REQUIRED');
  const flowBytes = fs.readFileSync('/root/.node-red/flows.json');
  if (sha(flowBytes) !== expectedFlow) throw Error('LIVE_FLOW_DRIFT');
  const flow = JSON.parse(flowBytes);
  const current = fs.realpathSync('/opt/padlhub-lk1-unpaid-cancel/current');
  const { lk1VivaBinding, createLk1LiveGatewayGuard } = await import(path.join(current, 'lib/lk1LiveGatewayGuard.mjs'));
  const { createLk1VivaServiceToken } = await import(path.join(current, 'lib/lk1VivaServiceToken.mjs'));
  // Guard reads the existing token path from existing worker configuration.
  const unitEnv = fs.readFileSync('/etc/padlhub/lk1-unpaid-cancel.env', 'utf8');
  const protectedEnv = Object.fromEntries(unitEnv.split('\n').filter(l => /^[A-Z][A-Z0-9_]*=/.test(l)).map(l => {
    const i = l.indexOf('='); return [l.slice(0, i), l.slice(i + 1).replace(/^"(.*)"$/, '$1')];
  }));
  const gatewayGuard = await createLk1LiveGatewayGuard({ expectedBindingSha: protectedEnv.LK1_UNPAID_CANCEL_BINDING_SHA256,
    adminTokenFile: protectedEnv.LK1_UNPAID_CANCEL_NODE_RED_ADMIN_TOKEN_FILE });
  if (gatewayGuard.check() !== 'HEALTHY') throw Error('RUNTIME_UNHEALTHY');
  const processes = JSON.parse(execFileSync('/usr/local/bin/pm2', ['jlist'], { encoding: 'utf8', maxBuffer: 10000000 }));
  const matches = processes.filter(p => p.name === 'node-red'); if (matches.length !== 1) throw Error('NODE_RED_IDENTITY');
  const binding = lk1VivaBinding(matches[0]); if (!binding) throw Error('SERVICE_BINDING_UNAVAILABLE');
  const [tokenUrl, clientId, username, password] = binding.values;
  const token = createLk1VivaServiceToken({ readConfig: async () => ({ tokenUrl, clientId, username, password }) });
  const require = createRequire(path.join(current, 'package.json')), { MongoClient } = require('mongodb');
  const client = new MongoClient(flow.find(n => n.id === '4e820638cc39c730').uri,
    { serverSelectionTimeoutMS: 5000, retryWrites: false, maxPoolSize: 1 });
  const cache = new Map(), requestCounts = { GET: 0, providerWrites: 0 };
  async function pages(route, scope, size = 200) {
    const cached = cache.get(route); if (cached && Date.now() - Date.parse(cached.observedAt) < 20000) return cached;
    const rows = [], seen = new Set(); let complete = false;
    const observedAt = new Date().toISOString();
    for (let page = 0; page < 10; page++) {
      const r = await fetch('https://api.vivacrm.ru' + route + (route.includes('?') ? '&' : '?') + `size=${size}&page=${page}`,
        { method: 'GET', redirect: 'error', signal: AbortSignal.timeout(15000),
          headers: { Authorization: 'Bearer ' + await token(), Accept: 'application/json' } });
      requestCounts.GET++;
      const value = await r.json(), list = Array.isArray(value) ? value : value?.content;
      if (r.status !== 200 || !Array.isArray(list)) throw Error('PROVIDER_READ_OR_SCHEMA');
      for (const item of list) {
        const key = item.id || item.subscriptionId;
        if (!key || seen.has(key)) throw Error('PROVIDER_PAGE_REPEATED_OR_IDENTITY');
        seen.add(key); rows.push(item);
      }
      if (Array.isArray(value) && list.length < size || !Array.isArray(value) && value.last === true) {
        if (value.totalElements !== undefined && value.totalElements !== rows.length) throw Error('PROVIDER_PAGE_COUNT');
        complete = true; break;
      }
      if (!list.length) throw Error('PROVIDER_PAGE_UNRESOLVED');
    }
    if (!complete) throw Error('PROVIDER_PAGE_CAP');
    const evidence = { complete, scope, observedAt, rows }; cache.set(route, evidence); return evidence;
  }
  fs.mkdirSync(out, { mode: 0o700 });
  let approved;
  if (args['--approved-plan']) {
    approved = readApprovedRecoveryPlan(args['--approved-plan'], args['--approved-plan-sha256']);
    if (approved.schemaVersion !== 1 || approved.expectedFlow !== expectedFlow || approved.incidentEnd !== end
      || approved.operationIdFilter !== (args['--operation-id'] || null)
      || !Array.isArray(approved.recoverable) || new Set(approved.recoverable.map(x => x.operationKey)).size !== approved.recoverable.length
      || approved.recoverable.length > 200) throw Error('APPROVED_SCOPE_DRIFT');
  }
  try {
    await client.connect(); const ops = client.db('games').collection('lk_subscription_daily_booking_ops');
    const rows = approved ? await Promise.all(approved.recoverable.map(row => ops.findOne({ _id: row.operationKey })))
      : await ops.find({ 'lk1.rule.productId': FRIENDSHIP2_PRODUCT,
        ...(args['--operation-id'] ? { operationId: args['--operation-id'] } : {}),
        createdAt: { $gte: TDZ_INCIDENT_START, $lte: end } }).maxTimeMS(5000).limit(201).toArray();
    if (rows.length > 200) throw Error('COHORT_CAP');
    writeReceipt(out, 'cohort.private.json', { at: new Date().toISOString(), rows });
    const results = [], recoverable = [];
    for (let index = 0; index < rows.length; index++) {
      const op = rows[index], approvedRow = approved?.recoverable[index], label = digest(op?._id || approvedRow?.operationKey).slice(0, 16);
      if (!op || approvedRow && digest(op) !== approvedRow.operationDigest) { results.push({ label, result: 'CONCURRENT_CHANGE_HELD' }); continue; }
      if (hasTdzRecoveryEffects(op) || !['PREPARED', 'RELEASED'].includes(op.state)
        || op.state === 'RELEASED' && op.releaseReason !== 'RECONCILE_HUNG_DAILY_CLAIM') {
        results.push({ label, result: 'OUTSIDE_NO_EFFECT_SCOPE', state: op.state }); continue;
      }
      if (gatewayGuard.check() !== 'HEALTHY' || sha(fs.readFileSync('/root/.node-red/flows.json')) !== expectedFlow) throw Error('RUNTIME_DRIFT');
      let subscription, target;
      try {
        subscription = await pages(`/api/v1/clients/${encodeURIComponent(op.actorClientId)}/subscriptions?includeFinished=true`, op.actorClientId);
        target = op.lk1?.createPayload
          ? await pages(`/api/v1/exercises?date=${op.serviceDate}&includeCanceled=true`, op.serviceDate, 1000)
          : await pages(`/api/v1/exercises/${encodeURIComponent(op.exerciseId)}/bookings?showCancelled=true`, op.exerciseId);
      } catch (e) { results.push({ label, result: 'PROVIDER_READ_HELD', errorClass: e.name }); continue; }
      const guardRows = await ops.find({ _id: dailyGuardKey(op) }).maxTimeMS(3000).limit(2).toArray();
      const guard = { complete: true, scope: dailyGuardKey(op), observedAt: new Date().toISOString(), rows: guardRows };
      const planned = planFriendship2TdzRecovery({ operation: op, subscription, target, guard, now: new Date().toISOString(), incidentEnd: end });
      if (!planned.recoverable) { results.push({ label, result: 'HELD', reason: planned.reason }); continue; }
      const entry = { operationKey: op._id, operationDigest: digest(op), outcome: planned.outcome };
      recoverable.push(entry);
      writeReceipt(out, `operation-${label}.private.json`, { operation: op, subscription, target, guard, planned });
      if (approvedRow) {
        if (approvedRow.outcome !== planned.outcome) { results.push({ label, result: 'OUTCOME_CHANGED_HELD' }); continue; }
        // All evidence and exact backup are durable before this single local CAS.
        // There is no provider mutation and no change to the daily guard document.
        if (gatewayGuard.check() !== 'HEALTHY' || sha(fs.readFileSync('/root/.node-red/flows.json')) !== expectedFlow) throw Error('RUNTIME_DRIFT');
        const ack = await ops.updateOne(planned.command.query, planned.command.update, planned.command.options);
        if (ack.acknowledged !== true || ack.matchedCount !== 1 || ack.modifiedCount !== 1) { results.push({ label, result: 'CAS_LOST_HELD' }); continue; }
        const after = await ops.findOne({ _id: op._id });
        const guardsAfter = await ops.find({ _id: dailyGuardKey(op) }).maxTimeMS(3000).limit(2).toArray();
        // A concurrent NEW request may create its own guard. This tool never alters it.
        writeReceipt(out, `postcheck-${label}.private.json`, { after, guardsAfter });
        if (after?.incidentRecovery?.operationDigest !== digest(op)) throw Error('POSTCHECK_PROOF_DRIFT');
        const unchanged = after.state === 'FAILED' && after.failure?.rawCode === 'LK1_DAILY_VISIT_CHANGED' && !hasTdzRecoveryEffects(after);
        results.push({ label, result: unchanged ? 'LOCAL_QUOTE_INVALIDATED' : 'CONCURRENT_RETRY_OBSERVED', outcome: planned.outcome });
      } else results.push({ label, result: 'DRY_RUN_RECOVERABLE', outcome: planned.outcome });
    }
    const plan = { schemaVersion: 1, expectedFlow, incidentEnd: end, operationIdFilter: args['--operation-id'] || null, at: new Date().toISOString(), recoverable };
    writeReceipt(out, 'plan.private.json', plan);
    const summary = { at: new Date().toISOString(), mode: approved ? 'apply' : 'dry-run', scanned: rows.length,
      expectedFlow, incidentEnd: end, requestCounts, results, planSha256: sha(fs.readFileSync(path.join(out, 'plan.private.json'))) };
    writeReceipt(out, 'summary.json', summary); console.log(JSON.stringify(summary)); return summary;
  } finally { await client.close(); }
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try { await runRecovery(parseRecoveryArgs(process.argv.slice(2))); }
  catch (e) { console.error(JSON.stringify({ errorClass: e.name, code: /^[A-Z_]+$/.test(e.message) ? e.message : 'RECOVERY_FAILED', providerWrites: 0 })); process.exitCode = 1; }
}
