#!/usr/bin/env node
// Server-only dry-run and guarded backfill. Full preimages never leave the server.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
const arg = name => { const i = process.argv.indexOf(name); return i < 0 ? null : process.argv[i + 1]; };
const mode = arg('--mode') || 'prepare';
const runtime = arg('--runtime');
const operation = arg('--operation');
if (!['prepare', 'apply', 'postcheck'].includes(mode) || !runtime || !/^\/root\/\.padlhub-fpr-level-[a-z0-9-]+$/.test(operation || '')) throw Error('FPR_BACKFILL_ARGUMENTS');
if (process.getuid() !== 0 || process.env.FPR_LEVEL_SHARED_LOCK_HELD !== '1') throw Error('FPR_BACKFILL_ROOT_AND_COMMON_LOCK_REQUIRED');
const sha = value => crypto.createHash('sha256').update(value).digest('hex');
const runtimeReal = fs.realpathSync(runtime);
if (!runtimeReal.startsWith('/opt/padlhub-rating-worker/releases/')) throw Error('FPR_BACKFILL_RUNTIME_PATH');
const manifestBytes = fs.readFileSync(path.join(runtimeReal, 'release-manifest.json'));
const manifest = JSON.parse(manifestBytes);
if (manifest.dirtyWorktree !== false || manifest.composition?.kind !== 'fpr-personal-level-overlay-v1') throw Error('FPR_BACKFILL_RUNTIME_MANIFEST');
for (const file of manifest.files) {
  if (!file.path || path.isAbsolute(file.path) || file.path.split('/').includes('..')) throw Error('FPR_BACKFILL_MANIFEST_PATH');
  const target = path.join(runtimeReal, file.path);
  if (!fs.lstatSync(target).isFile() || fs.realpathSync(target) !== target || sha(fs.readFileSync(target)) !== file.sha256) throw Error('FPR_BACKFILL_RUNTIME_DRIFT');
}
const runnerSha = sha(fs.readFileSync(new URL(import.meta.url)));
const { MongoClient, BSON } = createRequire(path.join(runtimeReal, 'package.json'))('mongodb');
const ledger = await import(pathToFileURL(path.join(runtimeReal, 'scripts/lib/fprLevelLedger.mjs')).href);
const { loadFprLevelContext, buildFprPlayerPlan, applyFprPlayerPlan, fprLevelHash, assertFprPlanIdentityDisjoint } = ledger;
const flowBytes = fs.readFileSync('/root/.node-red/flows.json');
const config = JSON.parse(flowBytes).find(n => n.type === 'mongodb4-client' && typeof n.uri === 'string' && n.uri.includes('/games'));
if (!config) throw Error('FPR_BACKFILL_MONGO_CONFIG');
const client = new MongoClient(config.uri, { serverSelectionTimeoutMS: 15000 });
const now = new Date().toISOString();
const semantic = document => { const copy = { ...document }; delete copy.fprLevelLedgerFence; return fprLevelHash(copy); };
const durable = (file, value) => {
  const fd = fs.openSync(path.join(operation, file), 'wx', 0o600);
  try { fs.writeFileSync(fd, BSON.EJSON.stringify(value, { relaxed: false })); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
  const dir = fs.openSync(operation, 'r'); try { fs.fsyncSync(dir); } finally { fs.closeSync(dir); }
};
const read = file => BSON.EJSON.parse(fs.readFileSync(path.join(operation, file), 'utf8'), { relaxed: true });
const checkedOperation = () => {
  const stat = fs.lstatSync(operation);
  if (!stat.isDirectory() || stat.isSymbolicLink() || stat.uid !== 0 || (stat.mode & 0o077)) throw Error('FPR_BACKFILL_OPERATION_CUSTODY');
};
try {
  await client.connect();
  const db = client.db('games');
  const context = await loadFprLevelContext(db, { enabled: true, unratedStartLevel: 1 });
  const ids = [...new Set([...context.ratings.values()].flatMap(r => r.standings.filter(p => p.ratedMatches > 0).map(p => p.id)))].sort();
  const counts = { tournaments: context.selected.size, appearances: [...context.ratings.values()].reduce((n, r) => n + r.standings.length, 0), players: ids.length,
    ambiguousSources: context.ambiguous.length, unratedAppearances: [...context.ratings.values()].flatMap(r => r.standings).filter(p => p.unratedStartApplied).length };
  const sourceVersions = [...context.protocols, ...context.legacy].map(d => [String(d._id), semantic(d)]).sort();
  if (mode === 'prepare') {
    // This initial backfill is deliberately frozen to the audited real cohort.
    if (counts.tournaments !== 19 || counts.appearances !== 185 || counts.players !== 138 || counts.unratedAppearances !== 8 || counts.ambiguousSources !== 1) throw Error('FPR_BACKFILL_COHORT_CHANGED');
    if (await db.collection('rating_events').countDocuments({ 'source.fprProtocolId': { $exists: true } })) throw Error('FPR_BACKFILL_ALREADY_STARTED');
    const plans = [];
    for (const id of ids) plans.push(await buildFprPlayerPlan(db, id, context, now));
    assertFprPlanIdentityDisjoint(plans);
    if (plans.some(p => !p.next || !p.outbox)) throw Error('FPR_BACKFILL_INCOMPLETE_INITIAL_PLAN');
    const pending = plans.filter(p => p.outboxes.length);
    if (pending.length) throw Error('FPR_BACKFILL_PENDING_PROVIDER_PROJECTIONS');
    fs.mkdirSync(operation, { mode: 0o700 }); checkedOperation();
    const parent = fs.openSync(path.dirname(operation), 'r'); try { fs.fsyncSync(parent); } finally { fs.closeSync(parent); }
    const packet = { schemaVersion: 1, runnerSha, runtimeManifestSha: sha(manifestBytes), flowSha: sha(flowBytes), preparedAt: now,
      counts, sourceVersions, protocolBackup: context.protocols, legacyBackup: context.legacy, plans };
    durable('packet.ejson', packet);
    const packetSha = sha(fs.readFileSync(path.join(operation, 'packet.ejson')));
    durable('prepared.ejson', { packetSha, counts, preparedAt: now });
    console.log(JSON.stringify({ ok: true, mode, databaseWrites: 0, privateDataExported: false, operation, packetSha, counts,
      eventsPlanned: plans.reduce((n, p) => n + p.events.length, 0), levelsChanged: plans.filter(p => p.next?.ratingNumeric !== p.current?.ratingNumeric).length,
      projectionsPlanned: plans.filter(p => p.outbox).length }));
  } else {
    checkedOperation(); const packet = read('packet.ejson'); const prepared = read('prepared.ejson');
    if (sha(fs.readFileSync(path.join(operation, 'packet.ejson'))) !== prepared.packetSha || packet.runnerSha !== runnerSha
      || packet.runtimeManifestSha !== sha(manifestBytes) || packet.flowSha !== sha(flowBytes)) throw Error('FPR_BACKFILL_PACKET_DRIFT');
    if (mode === 'apply') {
      if (Date.parse(now) - Date.parse(packet.preparedAt) > 15 * 60000 || fprLevelHash(sourceVersions) !== fprLevelHash(packet.sourceVersions)) throw Error('FPR_BACKFILL_STALE_PREVIEW');
      if (fs.realpathSync('/opt/padlhub-rating-worker/current') !== runtimeReal) throw Error('FPR_BACKFILL_CANDIDATE_NOT_ACTIVE');
      const activation = ledger.readFprLevelActivation();
      if (activation.enabled || activation.dispatchEnabled) throw Error('FPR_BACKFILL_AUTOMATION_NOT_PAUSED');
      // Validate every identity again before the first write, then each transaction validates its own preimage.
      for (const plan of packet.plans) {
        const fresh = await buildFprPlayerPlan(db, plan.clientId, context, packet.preparedAt);
        if (fresh.fingerprint !== plan.fingerprint || fprLevelHash(fresh.events) !== fprLevelHash(plan.events)) throw Error('FPR_BACKFILL_PLAN_DRIFT');
      }
      durable('apply-intent.ejson', { packetSha: prepared.packetSha, at: now });
      let events = 0, changed = 0;
      for (let i = 0; i < packet.plans.length; i++) {
        const plan = packet.plans[i];
        const result = await applyFprPlayerPlan(db, client, plan.clientId, context, packet.preparedAt, plan.fingerprint);
        durable(`player-${String(i).padStart(3, '0')}.ejson`, { clientId: plan.clientId, ...result, at: new Date().toISOString() });
        events += result.events; changed += Number(result.changed);
      }
      durable('applied.ejson', { events, changed, players: packet.plans.length, at: new Date().toISOString() });
      console.log(JSON.stringify({ ok: true, mode, events, changed, players: packet.plans.length, privateDataExported: false }));
    } else {
      let mismatches = 0, retryEvents = 0, verifiedEvents = 0;
      for (const plan of packet.plans) {
        const state = await db.collection('player_rating_state').findOne({ clientId: plan.next.clientId });
        const compatibility = await db.collection('player_ratings').findOne({ clientId: plan.next.clientId });
        if (state?.ratingNumeric !== plan.next.ratingNumeric || state?.lastEventId !== plan.next.lastEventId
          || compatibility?.ratingNumeric !== plan.next.ratingNumeric || compatibility?.lastEventId !== plan.next.lastEventId) mismatches++;
        for (const event of plan.events) {
          const actual = await db.collection('rating_events').findOne({ _id: event._id });
          if (fprLevelHash(actual) !== fprLevelHash(event)) mismatches++; else verifiedEvents++;
        }
        retryEvents += (await buildFprPlayerPlan(db, plan.clientId, context, now)).events.length;
      }
      const sportsSourceDrift = fprLevelHash(sourceVersions) !== fprLevelHash(packet.sourceVersions);
      const queue = await db.collection('rating_projection_outbox').aggregate([{ $match: { fprProjection: true } }, { $group: { _id: '$status', count: { $sum: 1 } } }]).toArray();
      const report = { ok: mismatches === 0 && retryEvents === 0 && !sportsSourceDrift, mode, mismatches, retryEvents, sportsSourceDrift, verifiedEvents,
        counts: packet.counts, projectionStatuses: Object.fromEntries(queue.map(r => [r._id, r.count])), checkedAt: now, privateDataExported: false };
      durable(`postcheck-${Date.now()}.ejson`, report); console.log(JSON.stringify(report));
      if (!report.ok) process.exitCode = 1;
    }
  }
} catch (error) {
  // Do not print error stacks, provider bodies, URI, roster or history.
  console.log(JSON.stringify({ ok: false, mode, error: /^FPR_[A-Z0-9_]+$/.test(error.message) ? error.message : error.name,
    code: typeof error.code === 'number' ? error.code : null, privateDataExported: false })); process.exitCode = 1;
} finally { await client.close(); }
