#!/usr/bin/env node
// Read provider facts; change only LK sale metadata after an exact terminal-unpaid proof.
// No provider mutation, payment, refund, new purchase or subscription issuance.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { createRequire } from 'node:module';
import { checkoutDigest, expiredSubscriptionCheckoutReason, expiredSubscriptionCheckoutUpdate } from './lib/expiredSubscriptionCheckout.mjs';

const args = process.argv.slice(2);
const value = key => { const i = args.indexOf(key); return i < 0 ? null : args[i + 1]; };
if (args.includes('--help')) {
  console.log('Usage: node reconcile_expired_subscription_checkouts.mjs --flows <live flows> --mongo-config-id <owning config node> --service-env-pid <node-red pid> --evidence-dir <new private directory> [--created-since <ISO>] [--mongodb-module <path>] [--apply --plan <dry-run plan.json>]');
  process.exit(0);
}
const apply = args.includes('--apply'), planPath = value('--plan');
const directory = value('--evidence-dir'), flowsPath = value('--flows'), pid = value('--service-env-pid');
const mongoConfigId = value('--mongo-config-id');
const since = value('--created-since');
if (!directory || !path.isAbsolute(directory) || fs.existsSync(directory) || !flowsPath || !mongoConfigId
  || !/^\d+$/.test(pid || '') || (apply && !planPath) || (since && !Number.isFinite(Date.parse(since)))) throw Error('INVALID_ARGUMENTS');
if (!fs.readFileSync(`/proc/${pid}/cmdline`, 'utf8').includes('node-red')) throw Error('SERVICE_PROCESS_MISMATCH');
const env = Object.fromEntries(fs.readFileSync(`/proc/${pid}/environ`, 'utf8').split('\0').filter(x => x.includes('='))
  .map(x => [x.slice(0, x.indexOf('=')), x.slice(x.indexOf('=') + 1)]));
if (env.VIVA_SERVICE_TOKEN_URL !== 'https://kc.vivacrm.ru/realms/prod/protocol/openid-connect/token'
  || !env.VIVA_SERVICE_USERNAME || !env.VIVA_SERVICE_PASSWORD || !env.VIVA_SERVICE_CLIENT_ID) throw Error('SERVICE_AUTH_UNAVAILABLE');
const previous = planPath ? JSON.parse(fs.readFileSync(planPath, 'utf8')) : null;
if (apply && (previous.version !== 1 || previous.complete !== true || !Array.isArray(previous.candidates) || !previous.operationId)) throw Error('INVALID_PLAN');
const operationId = previous?.operationId || crypto.randomUUID();
fs.mkdirSync(directory, { mode: 0o700 });
const write = (name, data) => fs.writeFileSync(path.join(directory, name), JSON.stringify(data, null, 2) + '\n', { mode: 0o600, flag: 'wx' });
const mongodb = createRequire(import.meta.url)(value('--mongodb-module') || 'mongodb');
const flows = JSON.parse(fs.readFileSync(flowsPath, 'utf8'));
const mongoConfigs = flows.filter(n => n.id === mongoConfigId && typeof n.uri === 'string' && n.uri.startsWith('mongodb'));
const uri = mongoConfigs.length === 1 ? mongoConfigs[0].uri : null;
if (!uri) throw Error('MONGO_CONFIG_UNAVAILABLE');
const client = new mongodb.MongoClient(uri, { serverSelectionTimeoutMS: 10_000 });
let token;
async function authenticate() {
  const r = await fetch(env.VIVA_SERVICE_TOKEN_URL, { method: 'POST', redirect: 'error', signal: AbortSignal.timeout(10_000),
    body: new URLSearchParams({ grant_type: 'password', client_id: env.VIVA_SERVICE_CLIENT_ID, username: env.VIVA_SERVICE_USERNAME, password: env.VIVA_SERVICE_PASSWORD }) });
  if (!r.ok) throw Error('SERVICE_AUTH_FAILED');
  token = (await r.json()).access_token;
  if (typeof token !== 'string' || !token) throw Error('SERVICE_AUTH_FAILED');
}
async function readTransaction(id) {
  try {
    const r = await fetch('https://api.vivacrm.ru/api/v1/transactions/' + encodeURIComponent(id), {
      headers: { Authorization: 'Bearer ' + token }, redirect: 'error', signal: AbortSignal.timeout(10_000),
    });
    if (!r.ok) return null;
    const body = await r.json();
    return body.data || body;
  } catch { return null; }
}
const decisions = [], candidates = [], counts = {};
const count = key => { counts[key] = (counts[key] || 0) + 1; };
try {
  await client.connect();
  await authenticate();
  const collection = client.db('games').collection('lk_tournament_subscription_sales');
  const query = { status: 'PAYMENT_PENDING', ...(since ? { createdAt: { $gte: new Date(since).toISOString() } } : {}) };
  let rows = await collection.find(query).toArray();
  if (apply) {
    const allowed = new Map(previous.candidates.map(x => [x.sale, x.transaction]));
    rows = rows.filter(x => allowed.get(checkoutDigest(String(x._id))) === checkoutDigest(x.transactionId));
  }
  write('scan.json', { operationId, mode: apply ? 'apply' : 'dry-run', scannedAt: new Date().toISOString(), mongoConfigId, query, rows: mongodb.BSON.EJSON.serialize(rows, { relaxed: false }) });
  let cursor = 0, fatal = false;
  const workers = await Promise.allSettled(Array.from({ length: 3 }, async () => {
    while (!fatal && cursor < rows.length) {
      const row = rows[cursor++], label = checkoutDigest(String(row._id));
      try {
      const transaction = row.counterKey === 'friendship' ? await readTransaction(row.transactionId) : null;
      let reason = row.counterKey !== 'friendship' ? 'UNSUPPORTED_COUNTER'
        : transaction ? expiredSubscriptionCheckoutReason(row, transaction) : 'PROVIDER_READ_UNAVAILABLE';
      const decision = { sale: label, counterKey: row.counterKey, reason: reason || 'RELEASABLE' };
      if (!reason) {
        write(label + '-provider.json', transaction);
        candidates.push({ sale: label, transaction: checkoutDigest(row.transactionId) });
        if (apply) {
          // Fresh provider read immediately before a whole-document compare-and-swap.
          const fresh = await readTransaction(row.transactionId);
          reason = fresh ? expiredSubscriptionCheckoutReason(row, fresh) : 'PROVIDER_READ_UNAVAILABLE';
          if (!reason) {
            write(label + '-prewrite-provider.json', fresh);
            const update = expiredSubscriptionCheckoutUpdate(row, fresh, operationId);
            const result = await collection.updateOne({ _id: row._id, $expr: { $eq: ['$$ROOT', { $literal: row }] } }, { $set: update }, { writeConcern: { w: 'majority', j: true } });
            decision.reason = result.modifiedCount === 1 ? 'RELEASED' : 'CAS_CONFLICT';
            const after = await collection.findOne({ _id: row._id });
            write(label + '-postcheck.json', mongodb.BSON.EJSON.serialize(after, { relaxed: false }));
            if (result.modifiedCount === 1 && (after?.status !== 'FAILED' || after?.checkoutReset?.operationId !== operationId || after?.paymentUrl !== null)) throw Error('POSTCHECK_FAILED');
          } else decision.reason = reason;
        }
      }
      decisions.push(decision); count(decision.reason);
      if (decisions.length % 25 === 0) console.log(JSON.stringify({ progress: decisions.length, total: rows.length, counts }));
      } catch {
        // An uncertain database acknowledgement is never retried. In-flight rows
        // finish their own CAS/readback; no worker starts another live write.
        fatal = true;
        decisions.push({ sale: label, counterKey: row.counterKey, reason: 'ROW_FAILED_REVIEW_EVIDENCE' });
        count('ROW_FAILED_REVIEW_EVIDENCE');
      }
    }
  }));
  const complete = !fatal && workers.every(x => x.status === 'fulfilled') && decisions.length === rows.length;
  const report = { version: 1, complete, operationId, mode: apply ? 'apply' : 'dry-run', finishedAt: new Date().toISOString(), scanned: rows.length, counts, decisions };
  write('report.json', report);
  write('plan.json', { version: 1, complete, operationId, candidates });
  console.log(JSON.stringify({ mode: report.mode, scanned: rows.length, counts, evidenceDirectory: directory }));
  if (!complete) throw Error('WORKER_FAILED_REVIEW_EVIDENCE');
} finally { await client.close(); }
