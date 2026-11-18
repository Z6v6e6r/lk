#!/usr/bin/env node
// Explicit, single-booking recovery. No scan, booking creation or money refund.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { createRequire } from 'node:module';
import { execFileSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import { repairCancelledVisit, repairDigest, repairJobKey } from './lib/lk1CancelledVisitRepair.mjs';
import { planDailyGuardRepair, applyDailyGuardRepair } from './lib/lk1DailyGuardRepair.mjs';
const sha = b => crypto.createHash('sha256').update(b).digest('hex');
export function parseCancelledVisitRepairArgs(argv) {
  const out = {}, allowed = new Set(['--operation-key-file', '--output-dir', '--expected-flow-sha256', '--approved-plan-digest', '--handoff-target-key-file']);
  for (let i = 0; i < argv.length; i++) {
    const key = argv[i];
    if (!allowed.has(key) || out[key] !== undefined || !argv[i + 1] || argv[i + 1].startsWith('--')) throw Error('ARGUMENT_INVALID');
    out[key] = argv[++i];
  }
  if (!path.isAbsolute(out['--operation-key-file'] || '') || !path.isAbsolute(out['--output-dir'] || '')
    || !/^[a-f0-9]{64}$/.test(out['--expected-flow-sha256'] || '')
    || out['--approved-plan-digest'] !== undefined && !/^[a-f0-9]{64}$/.test(out['--approved-plan-digest'])
    || out['--handoff-target-key-file'] !== undefined && !path.isAbsolute(out['--handoff-target-key-file'])) throw Error('ARGUMENT_REQUIRED');
  return out;
}
export async function runCancelledVisitRepair(args) {
  if (process.getuid() !== 0) throw Error('SERVER_ROOT_REQUIRED');
  const out = args['--output-dir'], input = args['--operation-key-file'];
  const st = fs.lstatSync(input), parent = fs.statSync(path.dirname(out));
  if (!st.isFile() || st.isSymbolicLink() || st.nlink !== 1 || st.mode & 0o077 || st.uid !== process.getuid()
    || fs.existsSync(out) || path.resolve(out) !== out || fs.realpathSync(path.dirname(out)) !== path.dirname(out)
    || parent.uid !== process.getuid() || parent.mode & 0o077) throw Error('PRIVATE_FILES_REQUIRED');
  const target = JSON.parse(fs.readFileSync(input, 'utf8'));
  if (Object.keys(target).sort().join(',') !== 'actorClientId,operationKey' || typeof target.actorClientId !== 'string'
    || typeof target.operationKey !== 'string' || !target.operationKey.startsWith('lk1-product:')) throw Error('EXACT_TARGET_REQUIRED');
  const expected = args['--expected-flow-sha256'], bytes = fs.readFileSync('/root/.node-red/flows.json');
  if (sha(bytes) !== expected) throw Error('FLOW_DRIFT');
  const flow = JSON.parse(bytes), current = fs.realpathSync('/opt/padlhub-lk1-unpaid-cancel/current');
  const { lk1VivaBinding, createLk1LiveGatewayGuard } = await import(path.join(current, 'lib/lk1LiveGatewayGuard.mjs'));
  const { createLk1VivaServiceToken } = await import(path.join(current, 'lib/lk1VivaServiceToken.mjs'));
  const env = Object.fromEntries(fs.readFileSync('/etc/padlhub/lk1-unpaid-cancel.env', 'utf8').split('\n')
    .filter(l => /^[A-Z][A-Z0-9_]*=/.test(l)).map(l => { const i = l.indexOf('='); return [l.slice(0, i), l.slice(i + 1).replace(/^"(.*)"$/, '$1')]; }));
  const gateway = flow.find(n => n.id === 'lk_subscription_booking_router_20260804');
  const guard = await createLk1LiveGatewayGuard({ expectedFlowSha: expected, expectedGatewaySha: sha(gateway.func),
    expectedBindingSha: env.LK1_UNPAID_CANCEL_BINDING_SHA256, adminTokenFile: env.LK1_UNPAID_CANCEL_NODE_RED_ADMIN_TOKEN_FILE });
  if (guard.check() !== 'HEALTHY') throw Error('RUNTIME_UNHEALTHY');
  const processes = JSON.parse(execFileSync('/usr/local/bin/pm2', ['jlist'], { maxBuffer: 10_000_000, timeout: 15000 }));
  const matches = processes.filter(p => p.name === 'node-red');
  if (matches.length !== 1) throw Error('PROCESS_IDENTITY');
  const binding = lk1VivaBinding(matches[0]);
  if (!binding) throw Error('SERVICE_BINDING_UNAVAILABLE');
  const [tokenUrl, clientId, username, password] = binding.values;
  const token = createLk1VivaServiceToken({ readConfig: async () => ({ tokenUrl, clientId, username, password }) });
  const require = createRequire(path.join(current, 'package.json')), { MongoClient } = require('mongodb');
  const mongo = new MongoClient(flow.find(n => n.id === '4e820638cc39c730').uri,
    { serverSelectionTimeoutMS: 5000, retryWrites: false, maxPoolSize: 1 });
  fs.mkdirSync(out, { mode: 0o700 });
  const writeReceipt = async (name, value) => {
    const fd = fs.openSync(path.join(out, name + '.private.json'), fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL, 0o600);
    try { fs.writeFileSync(fd, JSON.stringify(value, null, 2) + '\n'); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
    const d = fs.openSync(out, fs.constants.O_RDONLY); try { fs.fsyncSync(d); } finally { fs.closeSync(d); }
  };
  const counts = { GET: 0, SERVICE: 0, moneyWrites: 0, bookingCreates: 0 };
  try {
    await mongo.connect(); const ops = mongo.db('games').collection('lk_subscription_daily_booking_ops');
    const op = await ops.findOne({ _id: target.operationKey });
    if (!op || op.actorClientId !== target.actorClientId) throw Error('EXACT_TARGET_DRIFT');
    await writeReceipt('preimage', op);
    const route = `/api/v1/clients/${encodeURIComponent(op.actorClientId)}`;
    const request = async (method, suffix, body) => {
      if (method === 'PUT') counts.SERVICE++; else counts.GET++;
      const startedAt = new Date().toISOString();
      const response = await fetch('https://api.vivacrm.ru' + suffix, { method, redirect: 'error', signal: AbortSignal.timeout(15000),
        headers: { Authorization: 'Bearer ' + await token(), Accept: 'application/json', ...(body ? { 'Content-Type': 'application/json' } : {}) },
        ...(body ? { body: JSON.stringify(body) } : {}) });
      let value; try { value = await response.json(); } catch { value = null; }
      await writeReceipt(`http-${counts.GET + counts.SERVICE}`, { method, suffix, startedAt, observedAt: new Date().toISOString(), status: response.status, value });
      if (method === 'GET' && response.status !== 200) throw Error('PROVIDER_READ_UNAVAILABLE');
      return { status: response.status, value };
    };
    const beforeApply = async () => {
      if (guard.check() !== 'HEALTHY' || sha(fs.readFileSync('/root/.node-red/flows.json')) !== expected) throw Error('RUNTIME_DRIFT');
      if (repairDigest(await ops.findOne({ _id: op._id })) !== repairDigest(op)) throw Error('OWNER_DRIFT');
      const peers = await ops.find({ tenantKey: op.tenantKey, clientSubscriptionId: op.clientSubscriptionId }).maxTimeMS(5000).limit(1001).toArray();
      if (peers.length > 1000 || peers.some(p => p._id !== op._id && p._id !== repairJobKey(op)
        && (p.kind === 'LK1_FREE_CANCEL_JOB_V1' && !['DONE', 'DECLINED'].includes(p.phase)
          || p.actorClientId && !['CONFIRMED', 'FAILED', 'RELEASED'].includes(p.state)
          || p.lk1?.visitJob && !['RETURN_CONFIRMED', 'DEBIT_REJECTED', 'CANCELLED_BEFORE_DEBIT'].includes(p.lk1.visitJob.phase)
          || p.state === 'FAILED' && p.upstreamAttemptedAt && !(p.failure?.statusCode >= 400 && p.failure.statusCode < 500)))) {
        throw Error('OTHER_VISIT_OPERATION_IN_FLIGHT');
      }
    };
    const provider = {
      booking: async () => (await request('GET', `${route}/bookings/${encodeURIComponent(op.bookingId)}`)).value,
      transaction: async () => (await request('GET', `/api/v1/transactions/${encodeURIComponent(op.lk1.transactionId)}`)).value,
      subscriptions: async () => (await request('GET', `${route}/subscriptions?includeFinished=true&size=200&page=0`)).value,
      cancelOptions: async () => (await request('GET', `/api/v2/clients/${encodeURIComponent(op.actorClientId)}/bookings/${encodeURIComponent(op.bookingId)}/cancel`)).value,
      returnVisit: () => request('PUT', `${route}/bookings/${encodeURIComponent(op.bookingId)}/cancel`, { refundMethod: 'SERVICE', cancelExercise: false }),
    };
    if (args['--handoff-target-key-file']) {
      const f = args['--handoff-target-key-file'], st = fs.lstatSync(f);
      if (!st.isFile() || st.isSymbolicLink() || st.nlink !== 1 || st.uid !== process.getuid() || st.mode & 0o077) throw Error('PRIVATE_TARGET_REQUIRED');
      const targetKey = JSON.parse(fs.readFileSync(f, 'utf8'));
      if (typeof targetKey !== 'string' || !targetKey.startsWith('lk1-product:')) throw Error('EXACT_TARGET_REQUIRED');
      await beforeApply();
      const observedAt = new Date().toISOString();
      const providerEvidence = { booking: await provider.booking(), transaction: await provider.transaction(),
        subscriptions: await provider.subscriptions(), observedAt };
      const target = await ops.findOne({ _id: targetKey }), job = await ops.findOne({ _id: repairJobKey(op) });
      const guardKey = 'lk1-daily-visit:' + JSON.stringify([op.tenantKey, op.clientSubscriptionId.toLowerCase(), op.serviceDate]);
      const guardRow = await ops.findOne({ _id: guardKey });
      const plan = planDailyGuardRepair({ owner: op, target, guard: guardRow, job, ...providerEvidence, now: new Date().toISOString() });
      await writeReceipt('handoff-preimage', { op, target, guard: guardRow, job, providerEvidence, plan });
      if (!plan.recoverable) {
        const summary = { result: 'HELD', reason: plan.reason, counts, guardChanged: false };
        await writeReceipt('summary', summary); console.log(JSON.stringify(summary)); return summary;
      }
      const digest = repairDigest(plan);
      if (!args['--approved-plan-digest']) {
        const summary = { result: 'DRY_RUN_HANDOFF_RECOVERABLE', planDigest: digest, counts, guardChanged: false };
        await writeReceipt('summary', summary); console.log(JSON.stringify(summary)); return summary;
      }
      if (args['--approved-plan-digest'] !== digest) throw Error('HANDOFF_APPROVED_PLAN_DRIFT');
      await beforeApply();
      const hello = await mongo.db('admin').command({ hello: 1 });
      if (!hello.setName) throw Error('HANDOFF_REQUIRES_TRANSACTIONS');
      const session = mongo.startSession();
      let result;
      try { result = await applyDailyGuardRepair({ operations: ops, session, expectedPlan: plan, providerEvidence }); }
      finally { await session.endSession(); }
      await writeReceipt('handoff-result', result);
      const after = { owner: await ops.findOne({ _id: op._id }), target: await ops.findOne({ _id: targetKey }),
        guard: await ops.findOne({ _id: guardKey }), job: await ops.findOne({ _id: job._id }) };
      await writeReceipt('handoff-postcheck', after);
      if (after.guard?.ownerOperationKey !== targetKey || after.target?.state !== 'FAILED'
        || after.target.bookingId || after.target.upstreamAttemptedAt || after.owner?.lk1.transactionId !== op.lk1.transactionId) {
        throw Error('HANDOFF_POSTCHECK_UNKNOWN_NO_RETRY');
      }
      const summary = { result: result.result, counts, guardChanged: true };
      await writeReceipt('summary', summary); console.log(JSON.stringify(summary)); return summary;
    }
    const result = await repairCancelledVisit({ op, operations: ops, provider, writeReceipt, beforeApply,
      approvedPlanDigest: args['--approved-plan-digest'] || null });
    await writeReceipt('result', result);
    const summary = { result: result.result, reason: result.reason || null, phase: result.phase || null,
      planDigest: result.planDigest || null, counts, guardChanged: false };
    await writeReceipt('summary', summary); console.log(JSON.stringify(summary)); return summary;
  } finally { await mongo.close(); }
}
if (import.meta.url === pathToFileURL(process.argv[1] || '').href) {
  try { await runCancelledVisitRepair(parseCancelledVisitRepairArgs(process.argv.slice(2))); }
  catch (e) { console.error(JSON.stringify({ errorClass: e.name, code: /^[A-Z_]+$/.test(e.message) ? e.message : 'REPAIR_FAILED_NO_RETRY' })); process.exitCode = 1; }
}
