#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { MongoClient } from 'mongodb';
import { AUTO_FINISH_NODES, assertAutoFinishWriters } from './lib/tournamentAutoFinishNodes.mjs';
import { planTournamentAutoFinish, applyTournamentAutoFinish } from './lib/tournamentAutoFinish.mjs';

export async function runTournamentAutoFinish({ db, flow, nowTs = Date.now(), apply = false, backupDir, limit = 100 }) {
  if (apply) assertAutoFinishWriters(flow);
  const collection = db.collection('tournaments');
  const cursor = collection.find({ 'params.autoFinish.version': 1,
    'params.autoFinish.reason': { $exists: false },
    'params.autoFinish.deadlineAt': { $lte: new Date(nowTs).toISOString() }, archived: { $ne: true },
    $nor: [{ cancelled: true }, { canceled: true }, { 'params.finished': true },
      { 'params.fpr6x25.status': { $in: ['completed', 'incomplete'] } }],
  }).sort({ 'params.autoFinish.deadlineAt': 1 }).batchSize(limit);
  const source = flow.find(n => n.id === AUTO_FINISH_NODES.write)?.func;
  const outcomes = [];
  for await (const tournament of cursor) {
    // Never silently choose one of multiple records sharing a public ID.
    if (await collection.countDocuments({ tournamentId: tournament.tournamentId }, { limit: 2 }) !== 1) {
      outcomes.push({ tournamentId: tournament.tournamentId, applied: false, reason: 'AMBIGUOUS_ID' }); continue;
    }
    try {
      const plan = planTournamentAutoFinish(tournament, nowTs, source);
      const result = apply ? await applyTournamentAutoFinish(collection, tournament, plan, backupDir)
        : { applied: false, reason: plan.close ? 'DRY_RUN_CANDIDATE' : plan.reason };
      outcomes.push({ tournamentId: tournament.tournamentId, ...result });
    } catch {
      // Record safe identifiers only; protocol, PII and database errors stay private.
      outcomes.push({ tournamentId: tournament.tournamentId, applied: false, reason: 'FINALIZATION_FAILED' });
    }
  }
  return { ok: !outcomes.some(row => row.reason === 'FINALIZATION_FAILED'), mode: apply ? 'apply' : 'dry-run', outcomes };
}
async function main() {
  const apply = process.argv.includes('--apply');
  if (apply && process.env.TOURNAMENT_AUTO_FINISH_ENABLED !== 'true') throw new Error('AUTO_FINISH_DISABLED');
  const flow = JSON.parse(fs.readFileSync(process.env.NODERED_FLOW_PATH || '/etc/padlhub-tournament-auto-finish/writers.json', 'utf8'));
  const uri = process.env.MONGODB_URI;
  if (!uri) throw new Error('MONGODB_URI_REQUIRED');
  const client = new MongoClient(uri, { serverSelectionTimeoutMS: 10000, socketTimeoutMS: 15000 });
  try {
    await client.connect();
    const runtime = process.env.TOURNAMENT_AUTO_FINISH_RUNTIME_DIR || '/var/lib/padlhub-tournament-auto-finish';
    const backupDir = path.join(runtime, new Date().toISOString().replace(/[:.]/g, '-'));
    const report = await runTournamentAutoFinish({ db: client.db(process.env.MONGODB_DB || 'games'), flow, apply, backupDir });
    console.log(JSON.stringify(report));
    if (!report.ok) process.exitCode = 1;
  } finally { await client.close(); }
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main().catch(() => {
  console.error('TOURNAMENT_AUTO_FINISH_WORKER_FAILED'); process.exitCode = 1;
});
