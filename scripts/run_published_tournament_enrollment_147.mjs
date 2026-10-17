#!/usr/bin/env node
import fs from "node:fs";
import { MongoClient } from "mongodb";
import { runPublishedTournamentEnrollment } from "./lib/publishedTournamentEnrollment.mjs";

const arg = (key) => { const i = process.argv.indexOf(key); return i < 0 ? null : process.argv[i + 1]; };
const fromIso = arg("--from"), toIso = arg("--to"), out = arg("--out");
if (!fromIso || !toIso || !out) throw new Error("Required: --from ISO --to ISO --out /private/report.json; optional --apply --provider-limit N");
if (fs.existsSync(out)) throw new Error("Report path already exists");
const flow = process.env.MONGODB_URI ? [] : JSON.parse(fs.readFileSync(process.env.NODERED_FLOW_PATH || "/root/.node-red/flows.json", "utf8"));
const uri = process.env.MONGODB_URI || flow.find((n) => n.type === "mongodb4-client" && typeof n.uri === "string" && n.uri.includes("/games"))?.uri;
if (!uri) throw new Error("Mongo configuration unavailable");
const client = new MongoClient(uri, { serverSelectionTimeoutMS: 10000, socketTimeoutMS: 120000 });
try {
  await client.connect();
  const report = await runPublishedTournamentEnrollment({ client, db: client.db("games"), fromIso, toIso,
    dryRun: !process.argv.includes("--apply"), providerLimit: Math.max(0, Math.min(500, Number(arg("--provider-limit") || 20))) });
  fs.writeFileSync(out, `${JSON.stringify(report, null, 2)}\n`, { mode: 0o600, flag: "wx" });
  const { issues, affectedCommunityIds, ...summary } = report;
  console.log(JSON.stringify({ ...summary, issues: issues.length, affectedCommunities: affectedCommunityIds.length, reportPath: out }));
} finally { await client.close(); }
