#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { fileURLToPath } from "node:url";
import { isDeepStrictEqual } from "node:util";
import { MongoClient } from "mongodb";
import { collectCommunityRatingSourceData } from "../src/services/community-rating/recalculation.ts";
import { buildCommunityMonthlyReport } from "../src/services/community-rating/monthly.ts";
import { COMMUNITY_MONTHLY_COLLECTION, COMMUNITY_MONTHLY_SCHEMA, communityMonthWindow } from "../src/services/community-rating/monthlyContract.ts";
import { COMMUNITY_RATING_CALCULATION_VERSION } from "../src/services/community-rating/contract.ts";

const hash = value => crypto.createHash("sha256").update(value).digest("hex");
const safeError = error => /^[A-Z_]+$/.test(String(error?.message)) ? error.message : error?.code === 11000 ? "REPORT_INSERT_CONFLICT" : "REPORT_PUBLICATION_FAILED";
function assertReport(report, communityId, nowTs) {
  if (report.schemaVersion !== COMMUNITY_MONTHLY_SCHEMA || report.calculationVersion !== COMMUNITY_RATING_CALCULATION_VERSION
    || report.communityId !== communityId || report.month !== communityMonthWindow(nowTs).month
    || !Array.isArray(report.items) || report.items.length > 20 || report.items.some((row, i) => row.rank !== i + 1)) throw new Error("INVALID_MONTHLY_REPORT");
}
async function preservePreimage(backupDir, id, before, after) {
  const { BSON } = await import("mongodb");
  const file = path.join(backupDir, hash(id) + ".ejson");
  const fd = fs.openSync(file, "wx", 0o600);
  try { fs.writeFileSync(fd, BSON.EJSON.stringify({ id, before, after }, { relaxed: false })); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
  const directory = fs.openSync(backupDir, "r");
  try { fs.fsyncSync(directory); } finally { fs.closeSync(directory); }
  return hash(fs.readFileSync(file));
}

// The only writable collection in this publisher is the derived public report cache.
// Sources remain unchanged, including unfinished tournaments and canonical player ratings.
export async function publishCommunityMonthlyReports({ db, nowTs = Date.now(), apply = false, backupDir }) {
  const window = communityMonthWindow(nowTs);
  if (apply) {
    if (!backupDir) throw new Error("REPORT_BACKUP_DIRECTORY_REQUIRED");
    fs.mkdirSync(backupDir, { mode: 0o700 });
    const parent = fs.openSync(path.dirname(backupDir), "r");
    try { fs.fsyncSync(parent); } finally { fs.closeSync(parent); }
  }
  const communities = await db.collection("lk_communities").find({ archived: { $ne: true } }).toArray();
  const counts = new Map();
  for (const community of communities) counts.set(community.id, (counts.get(community.id) || 0) + 1);
  const sourceNames = ["lk_communities", "lk_community_feed", "lk_games", "tournaments", "lk_training_visits", "rating_events", "player_rating_state"];
  // Do not pass writable source collection handles to the report builder.
  const sources = Object.fromEntries(sourceNames.map(name => [name, { find: query => db.collection(name).find(query) }]));
  const target = db.collection(COMMUNITY_MONTHLY_COLLECTION), reports = [], failures = [];
  for (const community of communities) {
    const communityId = typeof community.id === "string" ? community.id.trim() : "";
    let writeAttempted = false, writeAcknowledged = false;
    try {
      if (!communityId || counts.get(community.id) !== 1) throw new Error("AMBIGUOUS_COMMUNITY_ID");
      const source = await collectCommunityRatingSourceData(sources, communityId);
      if (!source) throw new Error("COMMUNITY_NOT_FOUND");
      const report = buildCommunityMonthlyReport(source, nowTs);
      assertReport(report, communityId, nowTs);
      let preimageSha256 = null, postimageSha256 = null;
      if (apply) {
        const before = await target.findOne({ _id: report._id });
        preimageSha256 = await preservePreimage(backupDir, report._id, before, report);
        writeAttempted = true;
        if (before) {
          const result = await target.replaceOne({ _id: report._id, $expr: { $eq: ["$$ROOT", { $literal: before }] } }, report, { upsert: false });
          if (result.acknowledged !== true) throw new Error("REPORT_WRITE_UNACKNOWLEDGED");
          if (result.matchedCount !== 1) throw new Error("REPORT_SOURCE_CHANGED");
        } else {
          const result = await target.insertOne(report);
          if (result.acknowledged !== true) throw new Error("REPORT_WRITE_UNACKNOWLEDGED");
        }
        writeAcknowledged = true;
        const saved = await target.findOne({ _id: report._id });
        if (!isDeepStrictEqual(saved, report)) throw new Error("REPORT_POSTCHECK_FAILED");
        assertReport(saved, communityId, nowTs);
        const { BSON } = await import("mongodb");
        postimageSha256 = hash(BSON.EJSON.stringify(saved, { relaxed: false }));
      }
      reports.push({ communityId, month: report.month, rows: report.items.length, totalMembers: report.totalMembers, tournamentsCount: report.tournamentsCount, applied: apply, preimageSha256, postimageSha256 });
    } catch (error) { failures.push({ communityId, error: safeError(error), writeAttempted, writeAcknowledged }); }
  }
  const published = reports.filter(row => row.applied).length;
  return { ok: failures.length === 0, mode: apply ? "apply-reports-only" : "dry-run", month: window.month, updatedAt: new Date(nowTs).toISOString(), communities: communities.length, published, writesAcknowledged: published + failures.filter(row => row.writeAcknowledged).length, tournamentWrites: 0, canonicalRatingWrites: 0, reports, failures };
}

function assertSharedLock() {
  if (process.env.RATING_WORKER_SHARED_LOCK_HELD !== "1") throw new Error("SHARED_WORKER_LOCK_REQUIRED");
  const expected = fs.statSync(process.env.RATING_WORKER_LOCK_FILE || "/var/lock/padlhub-rating-worker.lock");
  let held;
  try { held = fs.fstatSync(9); } catch { throw new Error("SHARED_WORKER_LOCK_FD_REQUIRED"); }
  if (held.ino !== expected.ino || held.dev !== expected.dev) throw new Error("SHARED_WORKER_LOCK_FD_MISMATCH");
}
export function monthlyReportMongoUri(flow) {
  const enabled = new Set(flow.filter(node => node.type === "tab" && node.disabled !== true).map(node => node.id));
  const routes = flow.filter(node => node.type === "http in" && node.method === "get" && node.url === "/lk/communities/:communityId/rating" && enabled.has(node.z));
  if (routes.length !== 1) throw new Error("CANONICAL_COMMUNITY_RATING_ROUTE_REQUIRED");
  const clients = [...new Set(flow.filter(node => node.z === routes[0].z && node.type === "mongodb4" && ["lk_communities", "community_rating_snapshots"].includes(node.collection)).map(node => node.clientNode))];
  if (clients.length !== 1) throw new Error("COMMUNITY_MONGO_CLIENT_REQUIRED");
  const uri = flow.find(node => node.type === "mongodb4-client" && node.id === clients[0])?.uri;
  if (typeof uri !== "string" || !uri.includes("/games")) throw new Error("MONGODB_URI_NOT_CONFIGURED");
  return uri;
}
async function main() {
  const apply = process.argv.includes("--apply");
  if (process.argv.slice(2).some(arg => arg !== "--apply")) throw new Error("INVALID_REPORT_ARGUMENTS");
  if (apply) assertSharedLock();
  const flow = JSON.parse(fs.readFileSync(process.env.NODERED_FLOW_PATH || "/root/.node-red/flows.json", "utf8"));
  const uri = monthlyReportMongoUri(flow);
  const runtime = process.env.COMMUNITY_MONTHLY_REPORTS_RUNTIME_DIR || "/var/lib/padlhub-community-monthly";
  fs.mkdirSync(runtime, { recursive: true, mode: 0o700 });
  const stat = fs.lstatSync(runtime);
  if (!stat.isDirectory() || stat.isSymbolicLink() || (stat.mode & 0o077)) throw new Error("REPORT_RUNTIME_DIRECTORY_NOT_PRIVATE");
  const runDir = fs.mkdtempSync(path.join(runtime, new Date().toISOString().replace(/[:.]/g, "-") + "-"));
  fs.chmodSync(runDir, 0o700);
  const runtimeFd = fs.openSync(runtime, "r");
  try { fs.fsyncSync(runtimeFd); } finally { fs.closeSync(runtimeFd); }
  const client = new MongoClient(uri, { serverSelectionTimeoutMS: 10000, socketTimeoutMS: 120000 });
  await client.connect();
  try {
    const result = await publishCommunityMonthlyReports({ db: client.db("games"), apply, backupDir: path.join(runDir, "preimages") });
    const fd = fs.openSync(path.join(runDir, "report.json"), "wx", 0o600);
    try { fs.writeFileSync(fd, JSON.stringify(result, null, 2) + "\n"); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
    const directory = fs.openSync(runDir, "r");
    try { fs.fsyncSync(directory); } finally { fs.closeSync(directory); }
    console.log(JSON.stringify({ ok: result.ok, mode: result.mode, month: result.month, communities: result.communities, published: result.published, writesAcknowledged: result.writesAcknowledged, failed: result.failures.length, tournamentWrites: 0, canonicalRatingWrites: 0, runDir }));
    if (!result.ok) process.exitCode = 1;
  } finally { await client.close(); }
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main().catch(error => { console.error(JSON.stringify({ ok: false, error: safeError(error) })); process.exitCode = 1; });
