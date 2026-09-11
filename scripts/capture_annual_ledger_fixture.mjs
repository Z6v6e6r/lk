#!/usr/bin/env node
// Write a sanitized production annual-ledger snapshot as a test fixture.
//
// Reads the ledger from the production Mongo instance through an SSH hop to the
// Node-RED host and redacts every client identifier, phone and provider
// reference consistently, then writes a JSON fixture whose structure matches
// production exactly and which still passes the ledger's own validation.
//
// Read-only against production. Run from the repository root:
//   node scripts/capture_annual_ledger_fixture.mjs
// Optional env: PADLHUB_LEDGER_SSH_HOST, PADLHUB_LEDGER_FLOWS, PADLHUB_LEDGER_MONGO_MODULE.

import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { annualHistory } from './lib/annualSubscriptionHistory.mjs';

const LEDGER_ID = 'inventory:network_friendship_12m_20260910_epoch';
const SSH_HOST = process.env.PADLHUB_LEDGER_SSH_HOST || 'lk-primary-147';
const FLOWS_PATH = process.env.PADLHUB_LEDGER_FLOWS || '/root/.node-red/flows.json';
const MONGO_MODULE = process.env.PADLHUB_LEDGER_MONGO_MODULE || '/root/.node-red/node_modules/mongodb';
const OUT = fileURLToPath(new URL('./tests/fixtures/annualHubLedger.networkFriendshipEpoch.json', import.meta.url));

const remote = [
  'const fs=require("fs");',
  `const flows=JSON.parse(fs.readFileSync(${JSON.stringify(FLOWS_PATH)},"utf8"));`,
  'const node=flows.find(n=>typeof n.uri==="string"&&n.uri.startsWith("mongodb"));',
  `const {MongoClient}=require(${JSON.stringify(MONGO_MODULE)});`,
  '(async()=>{',
  ' const c=new MongoClient(node.uri,{serverSelectionTimeoutMS:8000});',
  ' await c.connect();',
  ` const doc=await c.db(node.database||"games").collection("lk_tournament_subscription_sales").findOne({_id:${JSON.stringify(LEDGER_ID)}});`,
  ' await c.close();',
  ' if(!doc){console.error("ledger not found");process.exit(2)}',
  ' process.stdout.write(JSON.stringify(doc));',
  '})().catch(e=>{console.error(e.message);process.exit(1)});',
].join('');

const raw = execFileSync('ssh', ['-o', 'ConnectTimeout=15', '-o', 'BatchMode=yes', SSH_HOST, `node -e ${JSON.stringify(remote)}`],
  { encoding: 'utf8', maxBuffer: 32 * 1024 * 1024 });
const ledger = JSON.parse(raw);

// --- consistent redaction ------------------------------------------------------
// Every redacted slot maps original -> fixture token through its own counter, so
// distinct fields never collapse into the same token and every cross-reference
// that the ledger's own validate() compares survives JSON.stringify equality.
const counters = new Map();
const maps = new Map();
const token = (slot, value) => {
  if (!maps.has(slot)) maps.set(slot, new Map());
  const slotMap = maps.get(slot);
  if (!slotMap.has(value)) {
    counters.set(slot, (counters.get(slot) || 0) + 1);
    slotMap.set(value, `fixture-${slot}-${counters.get(slot)}`);
  }
  return slotMap.get(value);
};

const NULLED_KEYS = new Set(['clientPhone', 'phone', 'email', 'skudId', 'skudKeyHex']);
const TOKEN_SLOTS = new Map([
  ['paymentRef', 'payment-ref'],
  ['transactionId', 'transaction'],
  ['orderId', 'transaction'],
  ['clientId', 'client'],
  ['localRowId', 'row'],
  ['requestFingerprint', 'fingerprint'],
  ['intentFingerprint', 'fingerprint'],
  ['repairFingerprint', 'fingerprint'],
  ['ref', 'ref'],
]);
const URL_KEYS = new Set(['paymentUrl', 'successUrl', 'failUrl', 'baseRedirectUrl', 'redirectUrl', 'returnUrl',
  'successRedirectUrl', 'failRedirectUrl', 'failureRedirectUrl']);
const FIXTURE_URL = 'https://padlhub.example.invalid/subsription';

const walk = (node, key = null) => {
  if (Array.isArray(node)) return node.map((item) => walk(item));
  if (node && typeof node === 'object') {
    const out = {};
    for (const [childKey, childValue] of Object.entries(node)) out[childKey] = walk(childValue, childKey);
    return out;
  }
  if (typeof node !== 'string' || !node) return node;
  if (NULLED_KEYS.has(key)) return null;
  if (URL_KEYS.has(key)) return FIXTURE_URL;
  if (TOKEN_SLOTS.has(key)) return token(TOKEN_SLOTS.get(key), node);
  return node;
};

const sanitized = walk(ledger);
if (!annualHistory.validate(sanitized)) {
  console.error('sanitized ledger fails its own validation; refusing to write the fixture');
  process.exit(3);
}

fs.mkdirSync(path.dirname(OUT), { recursive: true });
fs.writeFileSync(OUT, `${JSON.stringify(sanitized, null, 2)}\n`);
console.log(JSON.stringify({
  wrote: path.relative(process.cwd(), OUT),
  bytes: fs.statSync(OUT).size,
  reservations: (sanitized.reservations || []).map((item) => ({ paymentRef: item.paymentRef, state: item.state, expiresAt: item.expiresAt })),
  valid: true,
}, null, 2));
