#!/usr/bin/env node

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { MongoClient } from "mongodb";

import { canonicalJson, sha256 } from "./lib/vivaGameProjectionCutoverContract.mjs";
import { restorePreviousMongoWriteBarrier } from "./lib/vivaGameProjectionMongoWriteBarrier.mjs";
import {
  ensurePrivateDirectory,
  readPrivateJson,
  readPrivateMongoConnection,
} from "./run_viva_game_projection_tenant_migration.mjs";
import { writeFileExclusiveAtomicDurable } from "./nodered_reviewed_flow_deploy/runtime_contract.mjs";

const SCRIPT_PATH = fileURLToPath(import.meta.url);
const CONFIRMATION = "RECOVER_VIVA_GAME_PROJECTION_MONGO_WRITE_BARRIER_V1";
const HASH_RE = /^[a-f0-9]{64}$/;
const fail = (message) => { throw new Error(message); };

const parseArgs = (argv) => {
  const values = new Map();
  for (let index = 0; index < argv.length; index += 2) {
    const key = argv[index];
    const value = argv[index + 1];
    if (!key?.startsWith("--") || !value || value.startsWith("--") || values.has(key)) fail("Invalid recovery argument");
    values.set(key, value);
  }
  for (const key of [
    "--barrier-artifact", "--expected-barrier-artifact-sha256", "--cutover-plan",
    "--expected-cutover-plan-sha256", "--migration-connection-file", "--report",
  ]) if (!values.get(key)) fail(`Missing ${key}`);
  return values;
};

export async function recoverVivaGameProjectionMongoWriteBarrier(options, dependencies = {}) {
  if ((dependencies.getUid ? dependencies.getUid() : process.getuid?.()) !== 0) fail("Mongo barrier recovery requires root");
  if (process.env.VIVA_GAME_PROJECTION_MONGO_BARRIER_RECOVER !== CONFIRMATION) fail("Mongo barrier recovery confirmation is absent");
  for (const [value, label] of [
    [options.expectedBarrierArtifactSha256, "Barrier artifact digest"],
    [options.expectedCutoverPlanSha256, "Cutover-plan digest"],
  ]) if (!HASH_RE.test(String(value || ""))) fail(`${label} is invalid`);
  const artifactRead = readPrivateJson(options.barrierArtifact, "Mongo barrier artifact", 16 * 1024 * 1024);
  const cutoverRead = readPrivateJson(options.cutoverPlan, "Cutover plan", 64 * 1024 * 1024);
  if (sha256(artifactRead.bytes) !== options.expectedBarrierArtifactSha256
    || sha256(cutoverRead.bytes) !== options.expectedCutoverPlanSha256
    || cutoverRead.value?.kind !== "viva-game-projection-tenant-cutover-plan"
    || artifactRead.value?.cutoverPlanSha256 !== options.expectedCutoverPlanSha256) {
    fail("Mongo barrier recovery inputs do not bind one exact cutover");
  }
  const connection = readPrivateMongoConnection(
    options.migrationConnectionFile, cutoverRead.value.mongoTarget?.migrationConnectionFingerprint,
  );
  if (!path.isAbsolute(String(options.report || "")) || path.resolve(options.report) !== options.report) {
    fail("Mongo barrier recovery report path must be absolute and canonical");
  }
  ensurePrivateDirectory(path.dirname(options.report), "Mongo barrier recovery report directory");
  if (fs.existsSync(options.report)) fail("Mongo barrier recovery report must be new");
  const client = dependencies.migrationClient || new MongoClient(connection.uri, {
    appName: "PadlHubVivaGameProjectionMongoBarrierRecovery",
    maxPoolSize: 1, serverSelectionTimeoutMS: 20_000, connectTimeoutMS: 20_000,
    socketTimeoutMS: 20_000, timeoutMS: 20_000,
  });
  try {
    if (!dependencies.migrationClient) await client.connect();
    const hello = await client.db("admin").command({ hello: 1 });
    if (hello.setName !== cutoverRead.value.mongoTarget?.replicaSetName) fail("Mongo barrier recovery replica set mismatch");
    const recovery = await restorePreviousMongoWriteBarrier(client, artifactRead.value, {
      fenceTokenSha256: cutoverRead.value.writerFence?.fenceTokenSha256,
      cutoverPlanSha256: options.expectedCutoverPlanSha256,
      mongoTargetIdentitySha256: cutoverRead.value.mongoTarget?.targetIdentitySha256,
    });
    const report = {
      ...recovery,
      barrierArtifactSha256: options.expectedBarrierArtifactSha256,
      migrationConnectionFingerprint: connection.connectionFingerprint,
    };
    writeFileExclusiveAtomicDurable(options.report, Buffer.from(canonicalJson(report)), {
      uid: typeof process.getuid === "function" ? process.getuid() : 0,
      gid: typeof process.getgid === "function" ? process.getgid() : 0,
      mode: 0o600,
    });
    return report;
  } finally {
    if (!dependencies.migrationClient) await client.close().catch(() => {});
  }
}

export async function main(argv = process.argv.slice(2), dependencies = {}) {
  const values = parseArgs(argv);
  const result = await recoverVivaGameProjectionMongoWriteBarrier({
    barrierArtifact: values.get("--barrier-artifact"),
    expectedBarrierArtifactSha256: values.get("--expected-barrier-artifact-sha256"),
    cutoverPlan: values.get("--cutover-plan"),
    expectedCutoverPlanSha256: values.get("--expected-cutover-plan-sha256"),
    migrationConnectionFile: values.get("--migration-connection-file"),
    report: values.get("--report"),
  }, dependencies);
  process.stdout.write(`${JSON.stringify({ state: result.state })}\n`);
  return result;
}

if (process.argv[1] && fs.realpathSync(process.argv[1]) === SCRIPT_PATH) {
  if (process.argv.slice(2).includes("--help")) {
    process.stdout.write("Usage: node scripts/recover_viva_game_projection_mongo_write_barrier.mjs --barrier-artifact /private/barrier.json.prepared --expected-barrier-artifact-sha256 SHA256 --cutover-plan /private/packet/cutover-plan.json --expected-cutover-plan-sha256 SHA256 --migration-connection-file /private/migration-mongo.json --report /private/new-recovery-report.json\n");
  } else main().catch((error) => {
    process.stderr.write(`${String(error?.message || error).replace(/mongodb(?:\+srv)?:\/\/[^\s]+/gi, "[REDACTED_MONGO_URI]").slice(0, 500)}\n`);
    process.exitCode = 1;
  });
}
