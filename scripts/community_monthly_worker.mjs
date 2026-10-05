#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { MongoClient } from "mongodb";
import { collectCommunityRatingSourceData } from "../src/services/community-rating/recalculation.ts";
import { buildCommunityMonthlyReport } from "../src/services/community-rating/monthly.ts";
import { COMMUNITY_MONTHLY_COLLECTION, publicationEventId, publicationIsPublic, communityMonthWindow } from "../src/services/community-rating/monthlyContract.ts";
import { planCommunityTournamentClose, applyCommunityTournamentClose, assertTournamentWritersGuarded } from "./lib/communityMonthlyFinalization.mjs";

export async function runCommunityMonthlyJob({ db, nowTs = Date.now(), apply = false, backupDir, flow = [] }) {
  const window = communityMonthWindow(nowTs);
  if (apply) assertTournamentWritersGuarded(flow);
  const communities = await db.collection("lk_communities").find({ archived: { $ne: true } }).toArray();
  const posts = await db.collection("lk_community_feed").find({ communityId: { $in: communities.map(c => c.id) }, archived: { $ne: true }, kind: "TOURNAMENT" }).toArray();
  const publications = posts.filter(publicationIsPublic);
  const ids = [...new Set(publications.map(publicationEventId).filter(Boolean))];
  const tournaments = await db.collection("tournaments").find({ archived: { $ne: true }, $or: ["tournamentId", "id", "exerciseId", "sourceTournamentId"].map(key => ({ [key]: { $in: ids } })) }).toArray();
  const reasons = {}, finalizations = [], reports = [], projectedTournaments = new Map();
  const ambiguousAliases = new Set(ids.filter(id => tournaments.filter(tournament => [tournament.tournamentId, tournament.id, tournament.exerciseId, tournament.sourceTournamentId].includes(id)).length > 1));
  const duplicateIds = new Set(tournaments.filter(t => tournaments.filter(other => other.tournamentId === t.tournamentId).length > 1).map(t => t.tournamentId));
  for (const tournament of tournaments) {
    // Validate timing/results first: most historical publications are already finished.
    const aliases = [tournament.tournamentId, tournament.id, tournament.exerciseId, tournament.sourceTournamentId].filter(Boolean);
    const linked = publications.filter(post => aliases.includes(publicationEventId(post)));
    const preliminary = planCommunityTournamentClose({ tournament, publications: linked, nowTs });
    if (!preliminary.close || duplicateIds.has(tournament.tournamentId) || aliases.some(id => ambiguousAliases.has(id))) {
      const reason = duplicateIds.has(tournament.tournamentId) || aliases.some(id => ambiguousAliases.has(id)) ? "AMBIGUOUS_TOURNAMENT_ID" : preliminary.reason;
      reasons[reason] = (reasons[reason] || 0) + 1;
      finalizations.push({ tournamentId: tournament.tournamentId, applied: false, reason });
      continue;
    }
    const events = await db.collection("rating_events").find({ "source.domain": "TOURNAMENT", "source.sourceId": { $in: aliases } }).toArray();
    const playerIds = (tournament.participants || []).flatMap(player => [player.clientId, player.id]).filter(Boolean);
    const phones = (tournament.participants || []).map(player => {
      let digits = String(player.phoneNorm || player.phone || "").replace(/\D/g, "");
      if (digits.length === 10) digits = "7" + digits;
      if (digits.length === 11 && digits.startsWith("8")) digits = "7" + digits.slice(1);
      return digits;
    }).filter(Boolean);
    const states = await db.collection("player_rating_state").find({ $or: [{ clientId: { $in: playerIds } }, { "identityAliases.clientIds": { $in: playerIds } }, { phoneNorm: { $in: phones } }, { "identityAliases.phoneNorms": { $in: phones } }] }).toArray();
    let plan = duplicateIds.has(tournament.tournamentId) ? { close: false, reason: "AMBIGUOUS_TOURNAMENT_ID" } : planCommunityTournamentClose({ tournament, publications: linked, ratingEvents: events, ratingStates: states, nowTs });
    if (plan.close) {
      const recalcSource = flow.find(node => node.id === "2e70b2e547e77c00")?.func;
      if (!recalcSource) plan = { close: false, reason: "RECALCULATION_FUNCTION_MISSING" };
      else {
        const result = new Function("msg", recalcSource)({ payload: [structuredClone(tournament)], req: { body: { results: [], params: { finished: true, manualFinish: true, finishedAt: plan.finishedAt, completedAt: plan.finishedAt } } } });
        const update = result?.mongoUpdate?.$set;
        if (!update || JSON.stringify(update.rounds) !== JSON.stringify(tournament.rounds)) plan = { close: false, reason: "RECALCULATION_CHANGED_SOURCE_ROUNDS" };
        else plan.patch = { ...update, params: { ...update.params, administrativeClosedAt: new Date(nowTs).toISOString() }, updatedAt: new Date(nowTs).toISOString() };
      }
    }
    let result = { applied: false, reason: plan.reason };
    if (plan.close) {
      if (apply) result = await applyCommunityTournamentClose(db, tournament, plan, backupDir);
      else {
        result = { applied: false, reason: "DRY_RUN_CANDIDATE", finishedAt: plan.finishedAt, matches: plan.matches };
        projectedTournaments.set(tournament.tournamentId, { ...tournament, ...plan.patch });
      }
    }
    reasons[result.reason] = (reasons[result.reason] || 0) + 1;
    finalizations.push({ tournamentId: tournament.tournamentId, ...result });
  }
  for (const community of communities) {
    const source = await collectCommunityRatingSourceData({ lk_communities: db.collection("lk_communities"), lk_community_feed: db.collection("lk_community_feed"), lk_games: db.collection("lk_games"), tournaments: db.collection("tournaments"), lk_training_visits: db.collection("lk_training_visits"), rating_events: db.collection("rating_events"), player_rating_state: db.collection("player_rating_state") }, community.id);
    if (!source) continue;
    if (!apply) source.tournaments = source.tournaments.map(tournament => projectedTournaments.get(tournament.tournamentId) || tournament);
    const report = buildCommunityMonthlyReport(source, nowTs);
    if (apply) {
      // One atomic public document per community+month; no partial delete/rebuild read window.
      await db.collection(COMMUNITY_MONTHLY_COLLECTION).replaceOne({ _id: report._id }, report, { upsert: true });
      const persisted = await db.collection(COMMUNITY_MONTHLY_COLLECTION).findOne({ _id: report._id });
      if (!persisted || JSON.stringify(persisted.items) !== JSON.stringify(report.items)) throw new Error("MONTHLY_SNAPSHOT_POSTCHECK_FAILED");
    }
    reports.push({ communityId: community.id, month: report.month, totalMembers: report.totalMembers, topRows: report.items.length, tournamentsCount: report.tournamentsCount });
  }
  return { ok: true, schemaVersion: "community-monthly-v1", mode: apply ? "apply" : "dry-run", month: window.month, updatedAt: new Date(nowTs).toISOString(), communities: reports.length, reports, finalizations, reasons, finalized: finalizations.filter(item => item.applied).length };
}

async function main() {
  const apply = process.argv.includes("--apply");
  if (apply && process.env.COMMUNITY_MONTHLY_WORKER_ENABLED !== "true") throw new Error("COMMUNITY_MONTHLY_WORKER_DISABLED");
  if (apply && process.env.RATING_WORKER_SHARED_LOCK_HELD !== "1") throw new Error("SHARED_WORKER_LOCK_REQUIRED");
  const flowPath = process.env.NODERED_FLOW_PATH || "/root/.node-red/flows.json";
  const flow = JSON.parse(fs.readFileSync(flowPath, "utf8"));
  const uri = process.env.MONGODB_URI || flow.find(node => node.type === "mongodb4-client" && typeof node.uri === "string" && node.uri.includes("/games"))?.uri;
  if (!uri) throw new Error("MONGODB_URI_NOT_CONFIGURED");
  const dbName = process.env.MONGODB_DB || "games";
  const client = new MongoClient(uri, { serverSelectionTimeoutMS: 10000, socketTimeoutMS: 120000 });
  const runtimeDir = process.env.RATING_WORKER_RUNTIME_DIR || "/var/lib/padlhub-rating-worker";
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const runDir = path.join(runtimeDir, "monthly", stamp);
  fs.mkdirSync(runDir, { recursive: true, mode: 0o700 });
  await client.connect();
  try {
    const report = await runCommunityMonthlyJob({ db: client.db(dbName), apply, flow, backupDir: path.join(runDir, "backups") });
    fs.writeFileSync(path.join(runDir, "report.json"), JSON.stringify(report, null, 2) + "\n", { mode: 0o600 });
    console.log(JSON.stringify({ ok: true, mode: report.mode, month: report.month, communities: report.communities, finalized: report.finalized, reasons: report.reasons }));
  } finally { await client.close(); }
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main().catch(error => {
  // Never log the Mongo URI, driver payload, or provider credentials.
  console.error(JSON.stringify({ ok: false, error: /^[A-Z_]+$/.test(String(error?.message)) ? error.message : "MONTHLY_WORKER_FAILED" })); process.exitCode = 1;
});
