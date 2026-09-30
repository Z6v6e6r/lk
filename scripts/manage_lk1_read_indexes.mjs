#!/usr/bin/env node

import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { verifyWorkspace } from './verify_nodered_source_origin.mjs';

export const LK1_READ_INDEX_SPECS = Object.freeze([
  Object.freeze({ collection: 'chat_messages', name: 'chat_game_created_ts_v1', key: Object.freeze({ gameId: 1, createdTs: -1 }) }),
  Object.freeze({ collection: 'support_messages', name: 'support_created_at_v1', key: Object.freeze({ createdAt: 1 }) }),
  Object.freeze({ collection: 'lk_community_feed', name: 'community_feed_created_ts_v1', key: Object.freeze({ communityId: 1, createdTs: -1 }) }),
]);

const EXPECTED_DB = 'games';
const MONGO_CONFIG_ID = '4e820638cc39c730';
const EXPECTED_HOST = '147.45.254.160';
const FIND_NODES = Object.freeze([
  { id: '4d967af31e8055fb', collection: 'chat_messages' },
  { id: 'f2d916bb5f84f76e', collection: 'support_messages' },
  { id: 'fa6923e3b40760c9', collection: 'lk_community_feed' },
]);
const APPLY_TOKEN = 'APPLY_LK1_READ_INDEXES_V1';

const digest = (value) => crypto.createHash('sha256').update(JSON.stringify(value)).digest('hex');
const sameKey = (left, right) => JSON.stringify(Object.entries(left || {})) === JSON.stringify(Object.entries(right || {}));
const isPlainIndex = (index) => !index.unique && !index.sparse && !index.hidden && !index.partialFilterExpression && !index.collation && !index.expireAfterSeconds;

export function classifyIndex(spec, indexes) {
  const named = indexes.find((index) => index.name === spec.name);
  if (named) return sameKey(named.key, spec.key) && isPlainIndex(named) ? 'matching' : 'name-conflict';
  const equivalent = indexes.find((index) => sameKey(index.key, spec.key));
  if (equivalent) return isPlainIndex(equivalent) ? 'equivalent' : 'equivalent-conflict';
  return 'missing';
}

export function buildPlan({ flowSha256, catalogs }) {
  const rows = LK1_READ_INDEX_SPECS.map((spec) => ({
    collection: spec.collection,
    name: spec.name,
    key: spec.key,
    status: classifyIndex(spec, catalogs[spec.collection] || []),
  }));
  const existing = Object.fromEntries(Object.entries(catalogs)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([collection, indexes]) => [collection, indexes.map((index) => ({
      name: index.name,
      key: index.key,
      unique: index.unique === true,
      sparse: index.sparse === true,
      hidden: index.hidden === true,
      partialFilterExpression: index.partialFilterExpression || null,
      collation: index.collation || null,
      expireAfterSeconds: index.expireAfterSeconds ?? null,
    })).sort((a, b) => a.name.localeCompare(b.name))]));
  return {
    namespace: EXPECTED_DB,
    flowSha256,
    rows,
    readyForApply: !rows.some((row) => row.status.endsWith('conflict')),
    planDigest: digest({ version: 1, namespace: EXPECTED_DB, flowSha256, existing, rows }),
  };
}

function arg(name) {
  const index = process.argv.indexOf(name);
  return index < 0 ? null : process.argv[index + 1] || null;
}

function readFlow(filePath) {
  const absolute = path.resolve(String(filePath || ''));
  const stat = fs.lstatSync(absolute);
  if (!stat.isFile() || stat.isSymbolicLink() || (stat.mode & 0o077)) throw new Error('FLOW_NOT_PRIVATE');
  const raw = fs.readFileSync(absolute);
  const flow = JSON.parse(raw.toString('utf8'));
  if (!Array.isArray(flow)) throw new Error('FLOW_INVALID');
  const config = flow.find((node) => node?.id === MONGO_CONFIG_ID && node?.type === 'mongodb4-client');
  if (!config?.uri || config.dbName !== EXPECTED_DB
    || config.hostname !== EXPECTED_HOST || String(config.port) !== '27017') {
    throw new Error('MONGO_BINDING_MISMATCH');
  }
  const uri = new URL(config.uri);
  if (uri.protocol !== 'mongodb:' || uri.hostname !== EXPECTED_HOST || uri.port !== '27017') {
    throw new Error('MONGO_BINDING_MISMATCH');
  }
  for (const expected of FIND_NODES) {
    const node = flow.find((item) => item?.id === expected.id);
    if (node?.type !== 'mongodb4' || node?.operation !== 'find'
      || node?.collection !== expected.collection || node?.clientNode !== MONGO_CONFIG_ID) {
      throw new Error('FIND_NODE_BINDING_MISMATCH');
    }
  }
  return { uri: config.uri, flowSha256: crypto.createHash('sha256').update(raw).digest('hex') };
}

async function catalogsFrom(db) {
  const names = [...new Set(LK1_READ_INDEX_SPECS.map((spec) => spec.collection))];
  const catalogs = {};
  for (const name of names) catalogs[name] = await db.collection(name).listIndexes().toArray();
  return catalogs;
}

function journal(filePath) {
  if (!filePath || !path.isAbsolute(filePath)) throw new Error('RECEIPT_PATH_INVALID');
  const parent = fs.realpathSync(path.dirname(filePath));
  const absolute = path.join(parent, path.basename(filePath));
  const parentStat = fs.statSync(parent);
  if (absolute !== filePath || !absolute.startsWith('/private/tmp/')
    || !parentStat.isDirectory() || (parentStat.mode & 0o077)) {
    throw new Error('RECEIPT_PATH_INVALID');
  }
  const descriptor = fs.openSync(absolute, 'wx', 0o600);
  return {
    write(value) {
      const bytes = Buffer.from(`${JSON.stringify(value)}\n`);
      let offset = 0;
      while (offset < bytes.length) {
        const count = fs.writeSync(descriptor, bytes, offset, bytes.length - offset);
        if (count <= 0) throw new Error('RECEIPT_WRITE_FAILED');
        offset += count;
      }
      fs.fsyncSync(descriptor);
    },
    close() { fs.closeSync(descriptor); },
  };
}

async function main() {
  const mode = process.argv[2];
  if (!['plan', 'verify', 'apply'].includes(mode)) throw new Error('MODE_INVALID');
  const workspace = arg('--workspace');
  if (mode === 'apply' && !workspace) throw new Error('FRESH_WORKSPACE_REQUIRED');
  const verified = workspace ? verifyWorkspace(workspace, { quiet: true }) : null;
  const flowPath = verified?.sourcePath || arg('--flow-path');
  if (!flowPath) throw new Error('FLOW_PATH_REQUIRED');
  const { uri, flowSha256 } = readFlow(flowPath);
  if (verified && verified.sourceSha256 !== flowSha256) throw new Error('FLOW_HASH_MISMATCH');
  const { MongoClient } = await import('mongodb');
  const client = new MongoClient(uri, { serverSelectionTimeoutMS: 5_000, connectTimeoutMS: 5_000 });
  try {
    await client.connect();
    const db = client.db(EXPECTED_DB);
    const plan = buildPlan({ flowSha256, catalogs: await catalogsFrom(db) });
    if (mode !== 'apply') {
      console.log(JSON.stringify({ mode, ...plan }));
      return;
    }
    if (process.env.LK1_READ_INDEX_APPLY !== APPLY_TOKEN
      || arg('--expected-plan-digest') !== plan.planDigest || !plan.readyForApply) {
      throw new Error('APPLY_GUARD_FAILED');
    }
    const output = arg('--out');
    if (!output) throw new Error('RECEIPT_REQUIRED');
    const receipt = journal(output);
    try {
      receipt.write({ phase: 'PREFLIGHT', planDigest: plan.planDigest, rows: plan.rows });
      for (const row of plan.rows.filter((item) => item.status === 'missing')) {
        receipt.write({ phase: 'MUTATION_PENDING', collection: row.collection, name: row.name });
        await db.collection(row.collection).createIndex(row.key, { name: row.name, maxTimeMS: 120_000 });
        const indexes = await db.collection(row.collection).listIndexes().toArray();
        if (classifyIndex(row, indexes) !== 'matching') throw new Error('INDEX_READBACK_FAILED');
        receipt.write({ phase: 'INDEX_VERIFIED', collection: row.collection, name: row.name });
      }
      const post = buildPlan({ flowSha256, catalogs: await catalogsFrom(db) });
      if (post.rows.some((row) => row.status !== 'matching' && row.status !== 'equivalent')) {
        throw new Error('POSTCHECK_FAILED');
      }
      receipt.write({ phase: 'SUCCEEDED', beforePlanDigest: plan.planDigest, afterPlanDigest: post.planDigest, rows: post.rows });
      console.log(JSON.stringify({ mode, outcome: 'SUCCEEDED', rows: post.rows }));
    } finally { receipt.close(); }
  } finally { await client.close(); }
}

const invoked = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (invoked) main().catch((error) => {
  const safe = new Set(['MODE_INVALID', 'FLOW_NOT_PRIVATE', 'FLOW_INVALID', 'MONGO_BINDING_MISMATCH', 'FIND_NODE_BINDING_MISMATCH', 'FLOW_PATH_REQUIRED', 'FRESH_WORKSPACE_REQUIRED', 'FLOW_HASH_MISMATCH', 'APPLY_GUARD_FAILED', 'RECEIPT_REQUIRED', 'INDEX_READBACK_FAILED', 'POSTCHECK_FAILED']);
  safe.add('RECEIPT_PATH_INVALID');
  console.error(safe.has(error.message) ? error.message : 'LK1_READ_INDEX_OPERATION_FAILED');
  process.exitCode = 1;
});
