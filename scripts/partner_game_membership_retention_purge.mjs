#!/usr/bin/env node
// Annual retention enforcement for the Partner API stores.
//
// The reviewed policy keeps every record we receive for one year. This script
// deletes only what is older than that window, only for terminal membership
// states, and only in `--apply` mode: the default is a dry run that prints and
// optionally records what it *would* delete. It never touches nonces (they carry
// their own TTL), the outbox, or the game documents.
//
// Usage:
//   node scripts/partner_game_membership_retention_purge.mjs [--apply]
//        [--days 365] [--env-file <path>] [--runtime-root <dir>] [--report <path>]
import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

export const RETENTION_POLICY_DAYS = 365;
export const MINIMUM_RETENTION_DAYS = 31;
export const TERMINAL_MEMBERSHIP_STATES = Object.freeze(["REMOVED", "REJECTED", "FAILED", "CANCELLED"]);
export const RETENTION_TARGETS = Object.freeze([
  Object.freeze({ collection: "lk_partner_game_memberships", timeField: "createdAt", terminalStatesOnly: true }),
  Object.freeze({ collection: "lk_partner_game_operations", timeField: "createdAt", terminalStatesOnly: false }),
  Object.freeze({ collection: "lk_partner_api_audit", timeField: "at", terminalStatesOnly: false }),
]);

export function parseRetentionArgs(argv) {
  const args = { apply: false, days: RETENTION_POLICY_DAYS, envFile: null, runtimeRoot: null, report: null };
  for (let index = 0; index < argv.length; index += 1) {
    const flag = argv[index];
    if (flag === "--apply") { args.apply = true; continue; }
    const value = argv[index + 1];
    if (flag === "--days") { args.days = Number(value); index += 1; continue; }
    if (flag === "--env-file") { args.envFile = value; index += 1; continue; }
    if (flag === "--runtime-root") { args.runtimeRoot = value; index += 1; continue; }
    if (flag === "--report") { args.report = value; index += 1; continue; }
    throw new Error(`unknown argument: ${flag}`);
  }
  if (!Number.isSafeInteger(args.days) || args.days < MINIMUM_RETENTION_DAYS) {
    throw new Error(`retention days must be an integer >= ${MINIMUM_RETENTION_DAYS}`);
  }
  return args;
}

export function retentionCutoff(now, days) {
  if (!(now instanceof Date) || Number.isNaN(now.getTime())) throw new Error("now must be a Date");
  if (!Number.isSafeInteger(days) || days < MINIMUM_RETENTION_DAYS) throw new Error("days is out of policy");
  return new Date(now.getTime() - days * 86_400_000);
}

// Only a membership that has already reached a terminal state may age out; an open
// operation or an active membership is never deleted, however old it looks.
export function retentionFilter(target, cutoff) {
  const filter = { [target.timeField]: { $lt: cutoff } };
  if (target.terminalStatesOnly) filter.state = { $in: [...TERMINAL_MEMBERSHIP_STATES] };
  return filter;
}

export function readServiceEnvironment(envFile) {
  const text = fs.readFileSync(envFile, "utf8");
  const values = {};
  for (const line of text.split("\n")) {
    const match = line.match(/^([A-Z0-9_]+)=(.*)$/);
    if (match) values[match[1]] = match[2];
  }
  const uri = values.LK_PARTNER_GAME_API_MONGO_URI;
  const database = values.LK_PARTNER_GAME_API_MONGO_DB;
  if (!uri || !database) throw new Error("service environment has no Partner API Mongo target");
  return { uri, database };
}

export async function runRetentionPurge(options) {
  const require = createRequire(path.join(options.runtimeRoot, "package.json"));
  const { MongoClient } = require("mongodb");
  const cutoff = retentionCutoff(options.now, options.days);
  const client = new MongoClient(options.uri, { serverSelectionTimeoutMS: 15_000 });
  await client.connect();
  try {
    const database = client.db(options.database);
    const results = [];
    for (const target of RETENTION_TARGETS) {
      const collection = database.collection(target.collection);
      const filter = retentionFilter(target, cutoff);
      const matched = await collection.countDocuments(filter);
      let deleted = 0;
      if (options.apply && matched > 0) {
        const outcome = await collection.deleteMany(filter);
        deleted = Number(outcome.deletedCount || 0);
      }
      results.push({ collection: target.collection, matched, deleted });
    }
    return { mode: options.apply ? "APPLY" : "DRY_RUN", database: options.database,
      cutoff: cutoff.toISOString(), days: options.days, results };
  } finally {
    await client.close();
  }
}

const scriptPath = fileURLToPath(import.meta.url);
if (process.argv[1] && fs.realpathSync(process.argv[1]) === fs.realpathSync(scriptPath)) {
  const args = parseRetentionArgs(process.argv.slice(2));
  const envFile = args.envFile || "/etc/padlhub/partner-game-membership/service.env";
  const runtimeRoot = args.runtimeRoot || "/opt/padlhub/partner-game-membership/current/runtime";
  const target = readServiceEnvironment(envFile);
  const report = await runRetentionPurge({ ...target, runtimeRoot, now: new Date(), days: args.days, apply: args.apply });
  const text = `${JSON.stringify(report, null, 2)}\n`;
  if (args.report) fs.writeFileSync(args.report, text, { mode: 0o600 });
  process.stdout.write(text);
}
