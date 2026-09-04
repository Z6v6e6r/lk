#!/usr/bin/env node

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { BSON, MongoClient } from "mongodb";

import { canonicalJson, sha256 } from "./lib/vivaGameProjectionCutoverContract.mjs";
import { hashFullCollectionDocuments, hashLiveFullCollection } from "./lib/vivaGameProjectionMongoWriteBarrier.mjs";
import { ensurePrivateDirectory, readPrivateBytes, readPrivateJson } from "./run_viva_game_projection_tenant_migration.mjs";
import { writeFileExclusiveAtomicDurable } from "./nodered_reviewed_flow_deploy/runtime_contract.mjs";

const SCRIPT_PATH = fileURLToPath(import.meta.url);
const CONFIRMATION = "REHEARSE_VIVA_GAME_PROJECTION_FULL_RESTORE_V1";
const HASH_RE = /^[a-f0-9]{64}$/;
const DB_RE = /^viva_projection_restore_rehearsal_[a-z0-9_]{8,48}$/;
const fail = (message) => { throw new Error(message); };

const parseArgs = (argv) => {
  const values = new Map();
  for (let index = 0; index < argv.length; index += 2) {
    const key = argv[index];
    const value = argv[index + 1];
    if (!key?.startsWith("--") || !value || value.startsWith("--") || values.has(key)) fail("Invalid restore-rehearsal argument");
    values.set(key, value);
  }
  for (const key of [
    "--backup", "--backup-manifest", "--expected-backup-sha256", "--expected-manifest-sha256",
    "--mongo-connection-file", "--isolated-database", "--output-directory",
  ]) if (!values.get(key)) fail(`Missing ${key}`);
  return values;
};

const writePrivate = (filePath, bytes) => {
  writeFileExclusiveAtomicDurable(filePath, bytes, {
    uid: typeof process.getuid === "function" ? process.getuid() : 0,
    gid: typeof process.getgid === "function" ? process.getgid() : 0,
    mode: 0o600,
  });
};

export async function prepareVivaGameProjectionRestoreRehearsal(options, dependencies = {}) {
  if (process.env.VIVA_GAME_PROJECTION_RESTORE_REHEARSAL !== CONFIRMATION) fail("Restore rehearsal confirmation is absent");
  if (!DB_RE.test(String(options.isolatedDatabase || "")) || options.isolatedDatabase === "games") {
    fail("Restore rehearsal database is not an isolated disposable target");
  }
  for (const [value, label] of [
    [options.expectedBackupSha256, "Backup digest"], [options.expectedManifestSha256, "Manifest digest"],
  ]) if (!HASH_RE.test(String(value || ""))) fail(`${label} is invalid`);
  const backupBytes = readPrivateBytes(options.backup, "Full backup", 1024 * 1024 * 1024);
  const manifestRead = readPrivateJson(options.backupManifest, "Full backup manifest", 16 * 1024 * 1024);
  if (sha256(backupBytes) !== options.expectedBackupSha256
    || sha256(manifestRead.bytes) !== options.expectedManifestSha256
    || manifestRead.value?.backupSha256 !== options.expectedBackupSha256
    || manifestRead.value?.database !== "games" || manifestRead.value?.collection !== "lk_games") {
    fail("Restore rehearsal input does not match the pinned full backup");
  }
  let documents;
  try { documents = BSON.EJSON.parse(backupBytes.toString("utf8"), { relaxed: false }); } catch { fail("Full backup is invalid canonical EJSON"); }
  const backupState = hashFullCollectionDocuments(documents);
  if (backupState.documentCount !== manifestRead.value.documentCount
    || backupState.fullCollectionStateSha256 !== manifestRead.value.fullCollectionStateSha256) {
    fail("Full backup bytes do not match the backup manifest");
  }
  const connectionRead = readPrivateJson(options.mongoConnectionFile, "Restore rehearsal Mongo connection", 1024 * 1024);
  const uri = String(connectionRead.value?.uri || "").trim();
  if (connectionRead.value?.formatVersion !== 1
    || connectionRead.value?.kind !== "viva-game-projection-restore-rehearsal-mongo-connection" || !uri) {
    fail("Restore rehearsal Mongo connection contract mismatch");
  }
  const outputDirectory = ensurePrivateDirectory(options.outputDirectory, "Restore rehearsal output directory");
  if (fs.readdirSync(outputDirectory).length !== 0) fail("Restore rehearsal output directory must be empty");
  const client = dependencies.mongoClient || new MongoClient(uri, {
    appName: "PadlHubVivaGameProjectionRestoreRehearsal", maxPoolSize: 1,
    serverSelectionTimeoutMS: 20_000, connectTimeoutMS: 20_000, socketTimeoutMS: 20_000, timeoutMS: 20_000,
  });
  let databaseCreated = false;
  try {
    if (!dependencies.mongoClient) await client.connect();
    const hello = await client.db("admin").command({ hello: 1 });
    if (!hello.setName) fail("Restore rehearsal requires a replica-set target");
    const db = client.db(options.isolatedDatabase);
    const existing = await db.listCollections({ name: "lk_games" }, { nameOnly: true }).toArray();
    if (existing.length !== 0) fail("Restore rehearsal target collection already exists");
    databaseCreated = true;
    await db.createCollection("lk_games");
    if (documents.length > 0) {
      const result = await db.collection("lk_games").insertMany(documents, { ordered: true, bypassDocumentValidation: true });
      if (result?.acknowledged !== true || result.insertedCount !== documents.length) fail("Restore rehearsal did not restore every document");
    }
    const restoredState = await hashLiveFullCollection(db.collection("lk_games"));
    if (restoredState.documentCount !== backupState.documentCount
      || restoredState.fullCollectionStateSha256 !== backupState.fullCollectionStateSha256) {
      fail("Restore rehearsal live state differs from the full backup");
    }
    const restoredDocuments = await db.collection("lk_games").find({}).sort({ _id: 1 }).toArray();
    const restoredBytes = Buffer.from(`${BSON.EJSON.stringify(restoredDocuments, null, 2, { relaxed: false })}\n`);
    const restoredArtifactPath = path.join(outputDirectory, "full-backup.restored.ejson");
    writePrivate(restoredArtifactPath, restoredBytes);
    const isolatedIdentity = {
      connectionFingerprint: sha256(uri), replicaSetName: hello.setName,
      database: options.isolatedDatabase, collection: "lk_games",
    };
    const receipt = {
      formatVersion: 1,
      kind: "viva-game-projection-full-backup-restore-rehearsal",
      backupSha256: options.expectedBackupSha256,
      manifestSha256: options.expectedManifestSha256,
      fullCollectionStateSha256: backupState.fullCollectionStateSha256,
      mongoTargetIdentitySha256: manifestRead.value.mongoTargetIdentitySha256,
      isolatedTargetIdentitySha256: sha256(canonicalJson(isolatedIdentity)),
      restoredArtifactPath,
      restoredArtifactSha256: sha256(restoredBytes),
      restoredDocumentCount: restoredState.documentCount,
      isolatedTarget: true,
      postRestoreHashMatch: true,
      rehearsedAt: new Date(dependencies.nowMs ?? Date.now()).toISOString(),
    };
    const receiptPath = path.join(outputDirectory, "restore-rehearsal.receipt.json");
    writePrivate(receiptPath, Buffer.from(canonicalJson(receipt)));
    return { receipt, receiptPath, receiptSha256: sha256(fs.readFileSync(receiptPath)) };
  } finally {
    if (databaseCreated) await client.db(options.isolatedDatabase).dropDatabase().catch(() => {});
    if (!dependencies.mongoClient) await client.close().catch(() => {});
  }
}

export async function main(argv = process.argv.slice(2), dependencies = {}) {
  const values = parseArgs(argv);
  return prepareVivaGameProjectionRestoreRehearsal({
    backup: values.get("--backup"), backupManifest: values.get("--backup-manifest"),
    expectedBackupSha256: values.get("--expected-backup-sha256"),
    expectedManifestSha256: values.get("--expected-manifest-sha256"),
    mongoConnectionFile: values.get("--mongo-connection-file"), isolatedDatabase: values.get("--isolated-database"),
    outputDirectory: values.get("--output-directory"),
  }, dependencies);
}

if (process.argv[1] && fs.realpathSync(process.argv[1]) === SCRIPT_PATH) {
  if (process.argv.slice(2).includes("--help")) {
    process.stdout.write("Usage: node scripts/prepare_viva_game_projection_restore_rehearsal.mjs --backup /private/full-backup.ejson --backup-manifest /private/full-backup.manifest.json --expected-backup-sha256 SHA256 --expected-manifest-sha256 SHA256 --mongo-connection-file /private/isolated-mongo.json --isolated-database viva_projection_restore_rehearsal_<id> --output-directory /private/new-rehearsal\n");
  } else main().then((result) => process.stdout.write(`${JSON.stringify({ state: "PASS", receiptSha256: result.receiptSha256 })}\n`))
    .catch((error) => { process.stderr.write(`${String(error?.message || error).replace(/mongodb(?:\+srv)?:\/\/[^\s]+/gi, "[REDACTED_MONGO_URI]").slice(0, 500)}\n`); process.exitCode = 1; });
}
