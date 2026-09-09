#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { annualHistory } from './lib/annualSubscriptionHistory.mjs';
import { buildAnnualSubscriptionOpening } from './lib/annualSubscriptionOpening.mjs';
import { buildHistoryMaintenanceMutation, assertHistoryMaintenanceCustody, assertHistoryDeployLease, historyDigest } from './lib/subscriptionHistoryMaintenanceContract.mjs';
import { verifyDeploymentLock, deferredPm2Identity, publishDeferredStartEvidence, assertDeferredPrivateDirectory } from './manage_piter_deferred_ledger.mjs';
import { readPrivateDeferredJson } from './prepare_piter_deferred_activation.mjs';
import { loadSubscriptionSalesConfiguration } from './lib/subscriptionSalesConfiguration.mjs';

const root = path.dirname(fileURLToPath(import.meta.url));
const custodyRoot = '/root/.node-red/.padlhub-annual-history';
const flowPath = '/root/.node-red/flows.json';
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const sortRows = rows => [...rows].sort((a,b) => String(a._id).localeCompare(String(b._id)));

// Discover every local static dependency independently of the descriptor. A
// descriptor cannot omit a transitive helper or silently replace its hash.
export function historyPublicationFiles(entry = 'manage_annual_subscription_history.mjs') {
  const seen = new Set();
  function visit(relative) {
    if (seen.has(relative)) return;
    if (relative.startsWith('../') || path.isAbsolute(relative)) throw Error('publication dependency escapes scripts');
    seen.add(relative);
    if (!relative.endsWith('.mjs') && !relative.endsWith('.js')) return;
    const code = fs.readFileSync(path.join(root, relative), 'utf8');
    const imports = [...code.matchAll(/(?:from\s*|import\s*\()(['"])(\.[^'"]+)\1/g)].map(m => m[2]);
    for (const imported of imports) visit(path.posix.normalize(path.posix.join(path.posix.dirname(relative), imported)));
  }
  visit(entry);
  visit('subscription_sale_opening_binding.json');
  visit('annual_subscription_history_binding.json');
  return [...seen].sort();
}
function ownedBytes(file) {
  // No symlink in the file or ancestors; no group/world write access.
  for (let p = file;; p = path.dirname(p)) {
    const s = fs.lstatSync(p);
    if (s.isSymbolicLink() || s.uid !== 0 || (s.mode & 0o022) !== 0) throw Error('protected publication custody mismatch');
    if (p === path.dirname(p)) break;
  }
  const fd = fs.openSync(file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
  try { if (!fs.fstatSync(fd).isFile()) throw Error('regular publication file required'); return fs.readFileSync(fd); }
  finally { fs.closeSync(fd); }
}
function inspectRuntime() {
  const result = spawnSync('/usr/local/bin/pm2', ['jlist'], { encoding: 'utf8', timeout: 5000,
    env: { HOME: '/root', PM2_HOME: '/root/.pm2', PATH: '/usr/local/bin:/usr/bin:/bin' }, stdio: ['ignore', 'pipe', 'pipe'] });
  if (result.status !== 0 || result.error) throw Error('Node-RED definition read failed');
  const processes = JSON.parse(result.stdout), identity = deferredPm2Identity(processes);
  const e = processes.find(p => p.name === 'node-red').pm2_env;
  const values = [e.PADLHUB_SUBSCRIPTION_SALES_CONFIGURATION, e.env?.PADLHUB_SUBSCRIPTION_SALES_CONFIGURATION].filter(v => v != null);
  if (!values.length || values.some(v => v !== values[0])) throw Error('persistent sales configuration is missing or ambiguous');
  const loaded = loadSubscriptionSalesConfiguration(values[0], { set: () => {} });
  return { ...identity, salesFlagsOff: loaded.valid === true && !loaded.configuration.common && !loaded.configuration.hub && !loaded.configuration.piter };
}
async function mongoIdentity(client) {
  const h = await client.db('admin').command({ hello: 1 }, { maxTimeMS: 5000 });
  if (!h.setName || !Array.isArray(h.hosts) || !h.hosts.length || !h.me || !h.primary) throw Error('Mongo replica identity unavailable');
  return historyDigest({ setName: h.setName, hosts: [...h.hosts].sort(), me: h.me, primary: h.primary });
}

export async function runAnnualHistoryMaintenance(options, dependencies = {}) {
  const now = dependencies.now || (() => new Date().toISOString());
  const input = options.apply ? readPrivateDeferredJson(options.packetFile, 0) : JSON.parse(fs.readFileSync(options.packetFile, 'utf8'));
  if (input.kind !== 'ANNUAL_HISTORY_MAINTENANCE_PACKET_V1') throw Error('annual maintenance packet kind mismatch');
  // Rebuild from raw evidence, never trust a caller-supplied mutation or sentinel.
  const opening = buildAnnualSubscriptionOpening({ ...input.evidence, now: input.preparedAt });
  const candidateBinding = JSON.parse(fs.readFileSync(path.join(root, 'annual_subscription_history_binding.json'), 'utf8'));
  if (opening.runtimeBinding.flowSha256 !== candidateBinding.candidateSha256) throw Error('annual opening is not bound to the reviewed runtime candidate');
  if (input.action !== options.action) throw Error('annual maintenance action mismatch');
  const packetDigest = historyDigest(input);
  if (!options.apply) {
    const documents = JSON.parse(fs.readFileSync(options.ledgerFile, 'utf8'));
    const plan = buildHistoryMaintenanceMutation({ opening, documents, action: input.action, now: now() });
    return { kind: input.kind, action: input.action, packetDigest, mutationCount: plan.mutations.length,
      summary: opening.summary, mutationPerformed: false, executionAuthorized: false };
  }
  if (process.platform !== 'linux' || process.getuid?.() !== 0
    || process.env.LK_ANNUAL_HISTORY_TARGET !== 'lk-primary-147'
    || options.confirm !== 'APPLY_ANNUAL_HISTORY_MAINTENANCE_147'
    || options.expectedPlanDigest !== packetDigest || !process.env.LK_ANNUAL_HISTORY_MONGO_URI) throw Error('annual maintenance authorization missing');
  if (!path.isAbsolute(options.backupDir || '') || !options.backupDir.startsWith(`${custodyRoot}/operations/`)) throw Error('protected operation directory required');
  assertDeferredPrivateDirectory(path.dirname(options.backupDir));
  const grantPath = `${custodyRoot}/grant.json`, publicationPath = `${custodyRoot}/release.json`, quiescencePath = `${custodyRoot}/quiescence.json`;
  const grant = readPrivateDeferredJson(grantPath, 0);
  const initialRuntime = inspectRuntime();
  const readLeaseDigest = () => {
    const file = '/root/.node-red/.padlhub-reviewed-flow-deploy.lease.json';
    return assertHistoryDeployLease(fs.existsSync(file) ? JSON.parse(ownedBytes(file)) : null, now());
  };
  const readPublication = () => {
    const descriptor = readPrivateDeferredJson(publicationPath, 0);
    const files = historyPublicationFiles();
    const installedHashes = Object.fromEntries(files.map(f => [f, hash(ownedBytes(path.join(root, f)))]));
    if (descriptor.kind !== 'ANNUAL_HISTORY_PUBLICATION_V1'
      || annualHistory.stable(installedHashes) !== annualHistory.stable(descriptor.scriptHashes)
      || descriptor.flowSha256 !== hash(ownedBytes(flowPath))) throw Error('annual publication closure mismatch');
    return historyDigest(descriptor);
  };
  const { MongoClient, BSON } = await import('mongodb');
  const client = new MongoClient(process.env.LK_ANNUAL_HISTORY_MONGO_URI, { serverSelectionTimeoutMS: 5000, socketTimeoutMS: 5000 });
  const serialize = rows => BSON.EJSON.stringify(sortRows(rows), { relaxed: false });
  const bsonDigest = rows => hash(serialize(rows));
  let session;
  try {
    await client.connect();
    const targetMongo = await mongoIdentity(client), targetHost = hash(ownedBytes('/etc/machine-id').toString().trim());
    const collection = client.db('games').collection('lk_tournament_subscription_sales');
    const readRows = async (session = undefined) => collection.find({ inventoryId: opening.inventoryId }, {
      session, maxTimeMS: 5000, ...(session ? {} : { readConcern: { level: 'majority' } }),
      promoteValues: false, promoteLongs: false,
    }).toArray();
    const before = await readRows();
    const crossQuery = input.evidence.crossInventoryEvidence.query;
    const readCross = async (session = undefined) => collection.find(crossQuery, { session, maxTimeMS: 5000,
      promoteValues: false, promoteLongs: false, ...(session ? {} : { readConcern: { level: 'majority' } }) }).toArray();
    const backupExists = fs.existsSync(options.backupDir);
    // Recovery reads exact BSON postimages before any grant renewal or retry.
    if (backupExists) {
      const saved = readPrivateDeferredJson(path.join(options.backupDir, 'intent.json'), 0);
      const savedBefore = BSON.EJSON.parse(saved.beforeEjson, { relaxed: false });
      const savedAfter = BSON.EJSON.parse(saved.afterEjson, { relaxed: false });
      const rebuilt = buildHistoryMaintenanceMutation({ opening, documents: BSON.EJSON.serialize(savedBefore, { relaxed: true }),
        action: input.action, now: input.preparedAt });
      if (saved.kind !== 'ANNUAL_HISTORY_MAINTENANCE_INTENT_V1' || saved.operationId !== input.operationId || saved.action !== input.action
        || saved.inventoryId !== opening.inventoryId || saved.packetDigest !== packetDigest
        || saved.hostIdentitySha256 !== targetHost || saved.mongoIdentitySha256 !== targetMongo
        || saved.publicationDigest !== opening.runtimeBinding.publicationDigest || saved.flowSha256 !== opening.runtimeBinding.flowSha256
        || saved.preimageDigest !== bsonDigest(savedBefore) || saved.postimageDigest !== bsonDigest(savedAfter)
        || annualHistory.stable(sortRows(BSON.EJSON.serialize(savedAfter, { relaxed: true }))) !== annualHistory.stable(sortRows(rebuilt.after))
        || saved.postimageDigest !== bsonDigest(before)) throw Error('existing operation is not the exact postimage; no retry performed');
      const receipt = { kind: 'ANNUAL_HISTORY_MAINTENANCE_RECEIPT_V1', operationId: saved.operationId,
        packetDigest, postimageDigest: saved.postimageDigest, intentDigest: historyDigest(saved) };
      const receiptPath = path.join(options.backupDir, 'receipt.json');
      if (!fs.existsSync(receiptPath)) publishDeferredStartEvidence(receiptPath, receipt);
      else if (annualHistory.stable(readPrivateDeferredJson(receiptPath, 0)) !== annualHistory.stable(receipt)) throw Error('saved annual receipt mismatch');
      return { mutationPerformed: false, exactPostimageRecovered: true, packetDigest };
    }
    const normalized = BSON.EJSON.serialize(before, { relaxed: true });
    const plan = buildHistoryMaintenanceMutation({ opening, documents: normalized, action: input.action, now: now() });
    // Preserve all untouched BSON types in both the CAS filter and postimage.
    plan.before = before;
    plan.after = BSON.EJSON.parse(serialize(before), { relaxed: false });
    for (const mutation of plan.mutations) {
      if (mutation.type === 'insertOne') plan.after.push(mutation.document);
      else {
        mutation.before = before.find(r => r._id === mutation.before._id);
        Object.assign(plan.after.find(r => r._id === mutation.before._id), mutation.set);
      }
    }
    const expected = { operationId: input.operationId, action: input.action, inventoryId: opening.inventoryId,
      packetDigest, preimageDigest: bsonDigest(plan.before), postimageDigest: bsonDigest(plan.after),
      crossInventoryDigest: bsonDigest(before.filter(r => r._id !== opening.document._id)), deployLeaseDigest: readLeaseDigest(),
      publicationDigest: opening.runtimeBinding.publicationDigest, flowSha256: opening.runtimeBinding.flowSha256,
      hostIdentitySha256: targetHost, mongoIdentitySha256: targetMongo, runtimeDefinitionDigest: initialRuntime.definitionDigest };
    const check = async () => {
      if (Date.parse(opening.expiresAt) - Date.parse(now()) < 10_000) throw Error('annual evidence window expired');
      if (await mongoIdentity(client) !== targetMongo || hash(ownedBytes('/etc/machine-id').toString().trim()) !== targetHost) throw Error('annual target identity drift');
      const currentGrant = readPrivateDeferredJson(grantPath, 0);
      if (annualHistory.stable(currentGrant) !== annualHistory.stable(grant)) throw Error('annual grant changed');
      if (readLeaseDigest() !== expected.deployLeaseDigest) throw Error('annual deploy lease drift');
      if (bsonDigest(await readCross()) !== expected.crossInventoryDigest) throw Error('annual cross-inventory preimage drift');
      const publicationDigest = readPublication(), flowSha256 = hash(ownedBytes(flowPath));
      const currentRuntime = inspectRuntime(), quiescence = readPrivateDeferredJson(quiescencePath, 0);
      assertHistoryMaintenanceCustody({ grant, expected, initialRuntime, currentRuntime,
        publicationDigest, flowSha256, quiescence, lockHeld: verifyDeploymentLock(), now: now() });
    };
    await check();
    fs.mkdirSync(options.backupDir, { mode: 0o700 });
    const intent = { ...expected, kind: 'ANNUAL_HISTORY_MAINTENANCE_INTENT_V1',
      beforeEjson: serialize(plan.before), afterEjson: serialize(plan.after) };
    publishDeferredStartEvidence(path.join(options.backupDir, 'intent.json'), intent);
    session = client.startSession(); let commitError = null;
    try {
      await session.withTransaction(async () => {
        await check();
        if (bsonDigest(await readRows(session)) !== expected.preimageDigest) throw Error('annual transactional preimage drift');
        if (bsonDigest(await readCross(session)) !== expected.crossInventoryDigest) throw Error('annual transactional cross-inventory drift');
        for (const mutation of plan.mutations) {
          await check();
          const result = mutation.type === 'insertOne'
            ? await collection.insertOne(mutation.document, { session, maxTimeMS: 5000 })
            : await collection.updateOne({ _id: mutation.before._id, $expr: { $eq: ['$$ROOT', { $literal: mutation.before }] } },
              { $set: mutation.set }, { session, upsert: false, maxTimeMS: 5000 });
          if (result.acknowledged !== true || (mutation.type === 'insertOne' ? result.insertedId !== mutation.document._id
            : result.matchedCount !== 1 || result.modifiedCount !== 1 || result.upsertedCount !== 0 || result.upsertedId != null)) throw Error('annual exact write ACK missing');
        }
        if (bsonDigest(await readRows(session)) !== expected.postimageDigest) throw Error('annual transactional postimage mismatch');
        await check();
      }, { readConcern: { level: 'snapshot' }, writeConcern: { w: 'majority', j: true }, maxCommitTimeMS: 5000,
        timeoutMS: Math.max(1, Math.min(Date.parse(grant.expiresAt), Date.parse(opening.expiresAt)) - Date.parse(now()) - 5000) });
    } catch (error) { commitError = error; }
    const after = await readRows();
    if (bsonDigest(after) !== expected.postimageDigest) throw Error(commitError ? 'annual commit unresolved; inspect preserved operation' : 'annual postimage mismatch');
    publishDeferredStartEvidence(path.join(options.backupDir, 'receipt.json'), { kind: 'ANNUAL_HISTORY_MAINTENANCE_RECEIPT_V1',
      operationId: input.operationId, packetDigest, postimageDigest: expected.postimageDigest, intentDigest: historyDigest(intent) });
    return { mutationPerformed: plan.mutations.length > 0, packetDigest, exactPostimageConfirmed: true, salesFlagsChanged: false, runtimeStarted: false };
  } finally { if (session) await session.endSession(); await client.close(); }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const flags = { '--packet': 'packetFile', '--ledger-file': 'ledgerFile', '--action': 'action',
    '--backup-dir': 'backupDir', '--expected-plan-digest': 'expectedPlanDigest', '--confirm': 'confirm' };
  const options = { apply: false };
  try {
    const args = process.argv.slice(2);
    for (let i = 0; i < args.length; i++) {
      if (args[i] === '--apply') { if (options.apply) throw Error('duplicate apply'); options.apply = true; continue; }
      const key = flags[args[i]], value = args[++i];
      if (!key || !value || value.startsWith('--') || options[key]) throw Error('invalid annual maintenance option'); options[key] = value;
    }
    console.log(JSON.stringify(await runAnnualHistoryMaintenance(options)));
  } catch { console.error('Annual history maintenance failed; inspect private evidence. No automatic retry or runtime start.'); process.exitCode = 1; }
}
