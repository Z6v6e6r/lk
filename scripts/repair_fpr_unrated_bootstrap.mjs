// Private root-only incident recovery. Full preimages stay on the server.
/* global __FPR_RECOVERY_WORKER_HASHES__ */
import fs from 'node:fs';
import crypto from 'node:crypto';
import { createRequire } from 'node:module';
import { spawnSync } from 'node:child_process';
import { planFprBootstrapRecovery } from './lib/fprBootstrapRecovery.mjs';
import { readFprLevelIdentityHistory } from './lib/fprLevelIdentity.mjs';
import { fprLevelHash, loadFprLevelContext, buildFprPlayerPlan } from './lib/fprLevelLedger.mjs';

const args = {};
for (let i = 2; i < process.argv.length; i += 2) {
  if (!['--mode', '--operation', '--request'].includes(process.argv[i]) || !process.argv[i + 1] || args[process.argv[i]]) throw Error('FPR_BOOTSTRAP_RECOVERY_ARGUMENTS');
  args[process.argv[i]] = process.argv[i + 1];
}
const mode = args['--mode'], operation = args['--operation'];
const sha = bytes => crypto.createHash('sha256').update(bytes).digest('hex');
const requireThat = (ok, code = 'PRECONDITION') => { if (!ok) throw Error('FPR_BOOTSTRAP_RECOVERY_' + code); };
const privateRead = file => {
  const stat = fs.lstatSync(file);
  requireThat(stat.uid === 0 && (stat.mode & 0o077) === 0 && !stat.isSymbolicLink() && stat.isFile() && stat.nlink === 1, 'CUSTODY');
  return fs.readFileSync(file);
};
const exact = d => ({ ...Object.fromEntries(Object.entries(d).map(([k, v]) => [k, { $eq: v, $exists: true }])),
  $expr: { $eq: [{ $size: { $objectToArray: '$$ROOT' } }, Object.keys(d).length] } });
let client;
try {
  requireThat(process.getuid() === 0 && process.env.FPR_LEVEL_SHARED_LOCK_HELD === '1'
    && ['prepare', 'rehearse', 'apply', 'postcheck'].includes(mode)
    && /^\/root\/\.padlhub-fpr-bootstrap-recovery-[a-z0-9-]+$/.test(operation || ''), 'BOUNDARY');
  const lock = fs.fstatSync(9), actual = fs.statSync('/var/lock/padlhub-rating-worker.lock');
  requireThat(lock.dev === actual.dev && lock.ino === actual.ino && lock.isFile()
    && spawnSync('flock', ['-n', '9'], { stdio: ['ignore', 'ignore', 'ignore', 'ignore', 'ignore', 'ignore', 'ignore', 'ignore', 'ignore', 9] }).status === 0
    && spawnSync('flock', ['-n', '/var/lock/padlhub-rating-worker.lock', 'true'], { stdio: 'ignore' }).status === 1, 'LOCK');
  const runtime = fs.realpathSync('/opt/padlhub-rating-worker/current');
  requireThat(runtime.startsWith('/opt/padlhub-rating-worker/releases/'), 'RUNTIME');
  const hashes = typeof __FPR_RECOVERY_WORKER_HASHES__ === 'undefined' ? null : __FPR_RECOVERY_WORKER_HASHES__;
  requireThat(hashes && Object.keys(hashes).length === 9, 'SOURCE_PIN');
  for (const [file, hash] of Object.entries(hashes)) requireThat(sha(fs.readFileSync(runtime + '/' + file)) === hash, 'RUNTIME_DRIFT');
  const runnerSha = sha(fs.readFileSync(process.argv[1]));
  const { MongoClient, BSON } = createRequire(runtime + '/package.json')('mongodb');
  const read = name => BSON.EJSON.parse(privateRead(operation + '/' + name).toString(), { relaxed: true });
  const durable = (name, value) => {
    const fd = fs.openSync(operation + '/' + name, 'wx', 0o600);
    try { fs.writeFileSync(fd, BSON.EJSON.stringify(value, { relaxed: false })); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
    const dir = fs.openSync(operation, 'r'); try { fs.fsyncSync(dir); } finally { fs.closeSync(dir); }
  };
  const flow = fs.readFileSync('/root/.node-red/flows.json');
  const cfg = JSON.parse(flow).filter(n => n.id === '4e820638cc39c730' && n.type === 'mongodb4-client' && n.dbName === 'games');
  requireThat(cfg.length === 1 && typeof cfg[0].uri === 'string', 'DB_CONFIG');
  client = new MongoClient(cfg[0].uri, { serverSelectionTimeoutMS: 10000, socketTimeoutMS: 30000 });
  await client.connect(); const db = client.db('games');
  const capture = async (request, session) => {
    const options = { session, maxTimeMS: 20000 };
    const { current, events, aliases, keys } = await readFprLevelIdentityHistory(db, request.clientId, session);
    requireThat(aliases.length === 1 && keys.every(k => k === 'client:' + request.clientId), 'IDENTITY');
    const identity = { $or: [{ clientId: request.clientId }, { playerKey: 'client:' + request.clientId }] };
    const compatibility = await db.collection('player_ratings').find(identity, options).limit(3).toArray();
    const tournaments = await db.collection('tournaments').find({ $or: [{ 'params.fpr6x25.players.id': request.clientId },
      { 'participants.id': request.clientId }, { 'standings.id': request.clientId }] }, options).limit(3).toArray();
    const communities = await db.collection('lk_communities').find({ id: request.communityId }, options).limit(3).toArray();
    const outboxes = await db.collection('rating_projection_outbox').find({ clientId: request.clientId }, options).toArray();
    const awards = await db.collection('rating_events').countDocuments({ $or: [
      { 'source.sourceId': request.tournamentId }, { 'source.fprProtocolId': request.tournamentId }] }, options);
    requireThat(compatibility.length === 1 && tournaments.length === 1 && tournaments[0].tournamentId === request.tournamentId
      && communities.length === 1 && awards === 0, 'COHORT_CHANGED');
    return { ...request, tournament: tournaments[0], state: current, compatibility: compatibility[0], events, outboxes, community: communities[0] };
  };
  if (mode === 'prepare') {
    const request = JSON.parse(privateRead(args['--request']).toString());
    requireThat(Object.keys(request).sort().join(',') === 'clientId,communityId,operationId,targetLevel,tournamentId'
      && Object.values(request).every(v => typeof v === 'string' || typeof v === 'number'), 'ARGUMENTS');
    const inputs = await capture(request), recordedAt = new Date().toISOString();
    const plan = planFprBootstrapRecovery({ ...inputs, recordedAt });
    fs.mkdirSync(operation, { mode: 0o700 });
    const packet = { version: 1, request, inputs, plan, recordedAt, runtime, runnerSha, flowSha: sha(flow) };
    durable('packet.ejson', packet);
    const packetSha = sha(privateRead(operation + '/packet.ejson'));
    durable('prepared.ejson', { packetSha, at: recordedAt });
    console.log(JSON.stringify({ ok: true, mode, packetSha, before: inputs.state.ratingNumeric, after: plan.next.ratingNumeric,
      correctionDelta: plan.event.change.delta, playersChanged: 1, awardsChanged: 0, protocolRevision: plan.tournament.params.fpr6x25.revision, databaseWrites: 0 }));
  } else {
    const stat = fs.lstatSync(operation);
    requireThat(stat.isDirectory() && !stat.isSymbolicLink() && stat.uid === 0 && !(stat.mode & 0o077), 'CUSTODY');
    const packet = read('packet.ejson'), prepared = read('prepared.ejson');
    requireThat(sha(privateRead(operation + '/packet.ejson')) === prepared.packetSha && packet.runnerSha === runnerSha
      && packet.runtime === runtime && packet.flowSha === sha(flow), 'PACKET_DRIFT');
    if (mode === 'postcheck') {
      const fresh = await capture(packet.request), plan = packet.plan;
      requireThat(fprLevelHash(fresh.tournament) === fprLevelHash(plan.tournament)
        && fresh.state.ratingNumeric === plan.next.ratingNumeric && fresh.state.lastEventId === plan.event.id
        && fresh.compatibility.ratingNumeric === plan.next.ratingNumeric && fresh.compatibility.lastEventId === plan.event.id
        && fresh.events.length === packet.inputs.events.length + 1
        && fresh.events.every(e => fprLevelHash(e) === fprLevelHash(e.id === plan.event.id ? plan.event : packet.inputs.events.find(old => old.id === e.id))), 'POSTCHECK');
      const context = await loadFprLevelContext(db, { enabled: true, unratedStartLevel: 1 });
      const replan = await buildFprPlayerPlan(db, packet.request.clientId, context, new Date().toISOString());
      requireThat(replan.events.length === 0, 'RETRY_NOT_STABLE');
      const result = { ok: true, mode, ratingNumeric: fresh.state.ratingNumeric, immutableEventsPreserved: true,
        pendingEvents: replan.events.length, outboxStatuses: fresh.outboxes.map(o => o.status), at: new Date().toISOString() };
      durable('postcheck-' + Date.now() + '.ejson', result); console.log(JSON.stringify(result));
    } else {
      requireThat(Date.now() - Date.parse(packet.recordedAt) < 15 * 60000, 'STALE_PACKET');
      if (mode === 'apply') requireThat(read('rehearsed.ejson').packetSha === prepared.packetSha, 'REHEARSAL_REQUIRED');
      const session = client.startSession();
      durable(mode + '-intent.ejson', { packetSha: prepared.packetSha, at: new Date().toISOString() });
      try {
        session.startTransaction({ readConcern: { level: 'snapshot' }, writeConcern: { w: 'majority' }, readPreference: 'primary' });
        const inputs = await capture(packet.request, session);
        requireThat(fprLevelHash(inputs) === fprLevelHash(packet.inputs), 'PREIMAGE_CHANGED');
        const plan = planFprBootstrapRecovery({ ...inputs, recordedAt: packet.recordedAt });
        requireThat(fprLevelHash(plan) === fprLevelHash(packet.plan), 'PLAN_DRIFT');
        // A real write fences this exact evidence document; member data is untouched.
        const fence = await db.collection('lk_communities').updateOne(exact(inputs.community),
          { $set: { fprBootstrapRecoveryFence: { operationId: packet.request.operationId, packetSha: prepared.packetSha } } }, { session });
        requireThat(fence.modifiedCount === 1, 'EVIDENCE_CHANGED');
        await db.collection('rating_events').insertOne(plan.event, { session });
        for (const [collection, before, after] of [['player_rating_state', inputs.state, plan.next],
          ['player_ratings', inputs.compatibility, plan.nextCompatibility], ['tournaments', inputs.tournament, plan.tournament]]) {
          const result = await db.collection(collection).replaceOne(exact(before), after, { session });
          requireThat(result.modifiedCount === 1, 'CAS');
        }
        await db.collection('rating_projection_outbox').insertOne(plan.outbox, { session });
        if (mode === 'rehearse') await session.abortTransaction(); else await session.commitTransaction();
      } catch (error) { if (session.inTransaction()) await session.abortTransaction(); throw error; }
      finally { await session.endSession(); }
      const result = { ok: true, mode, packetSha: prepared.packetSha, committed: mode === 'apply', eventsAdded: 1,
        playersChanged: 1, sportsResultsChanged: false, at: new Date().toISOString() };
      durable(mode === 'rehearse' ? 'rehearsed.ejson' : 'applied.ejson', result); console.log(JSON.stringify(result));
    }
  }
} catch (error) {
  console.log(JSON.stringify({ ok: false, mode, error: /^FPR_[A-Z0-9_]+$/.test(error.message) ? error.message : error.name }));
  process.exitCode = 1;
} finally { await client?.close(); }
