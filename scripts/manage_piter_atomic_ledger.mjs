#!/usr/bin/env node

import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  sha256,
  stableJson,
  validatePiterAtomicActivationPacket,
} from "./lib/piterAtomicActivationContract.mjs";
import {
  buildPiterAtomicLedgerPlan,
  redactPiterAtomicLedgerPlan,
  validateAtomicLedgerCustody,
  validateAtomicLedgerShape,
} from "./lib/piterAtomicLedgerOperations.mjs";

const LIVE_FLOW_PATH = "/root/.node-red/flows.json";
const DEPLOYMENT_LOCK_PATH = "/root/.node-red/.padlhub-reviewed-flow-deploy.lock";
const DEPLOYMENT_LEASE_PATH = "/root/.node-red/.padlhub-reviewed-flow-deploy.lease.json";
const DEPLOYMENT_LOCK_WRAPPED_ENV = "PADLHUB_REVIEWED_FLOW_LOCK_WRAPPED";
const TARGET_HOST = "lk-primary-147";
const MAX_MONGO_TIME_MS = 5_000;

const usage = `
manage_piter_atomic_ledger

Fail-closed operator for the Piter atomic inventory sentinel. Dry-run is the
default and consumes a complete read-only Mongo snapshot. Live mutation is
possible only on lk-primary-147 while holding the reviewed-flow deployment
lock, reading the canonical root-owned flow, verifying the Mongo identity,
and passing exact contract/revision/action gates. Credentials stay in env.

Dry-run:
  node scripts/manage_piter_atomic_ledger.mjs \
    --action preflight|seed|activate|deactivate|rollback-check \
    --packet /absolute/private/activation.packet.json \
    --ledger-file /absolute/private/current-ledger-evidence.json \
    [--active-flow /absolute/current/flows.json] \
    [--expected-revision N] [--reason "operator reason"]

Live apply (future separately authorized operation only):
  LK_PITER_ATOMIC_TARGET=lk-primary-147 \
  LK_PITER_ATOMIC_EXPECTED_HOST_IDENTITY_SHA256=<sha256> \
  LK_PITER_ATOMIC_MONGO_URI=... \
  LK_PITER_ATOMIC_EXPECTED_MONGO_IDENTITY_SHA256=<sha256> \
  LK_PITER_ATOMIC_LEDGER_ACTION=SEED_147|ACTIVATE_147|DEACTIVATE_147 \
  node scripts/manage_piter_atomic_ledger.mjs ... --apply \
    --active-flow /root/.node-red/flows.json \
    --expected-contract-digest <sha256> --backup-dir /absolute/new/private/dir
`;

const VALUE_FLAGS = new Map([
  ["--action", "action"],
  ["--packet", "packetFile"],
  ["--ledger-file", "ledgerFile"],
  ["--active-flow", "activeFlowFile"],
  ["--expected-revision", "expectedRevision"],
  ["--expected-contract-digest", "expectedContractDigest"],
  ["--backup-dir", "backupDir"],
  ["--reason", "reason"],
]);

const APPLY_GATES = Object.freeze({
  seed: "SEED_147",
  activate: "ACTIVATE_147",
  deactivate: "DEACTIVATE_147",
});

const SHA256_PATTERN = /^[a-f0-9]{64}$/;
const toStr = (value) => value == null ? null : (String(value).trim() || null);
const freshNow = (nowFn) => {
  const value = nowFn();
  const date = value instanceof Date ? value : new Date(value);
  if (!Number.isFinite(date.getTime())) throw new Error("operator clock is invalid");
  return date;
};

export function parseArgs(argv) {
  const options = { apply: false, help: false };
  const seen = new Set();
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--help" || arg === "-h") { options.help = true; continue; }
    if (arg === "--apply") { options.apply = true; continue; }
    const key = VALUE_FLAGS.get(arg);
    if (!key) throw new Error(`Unsupported option: ${arg}`);
    const value = argv[index + 1];
    if (!value || value.startsWith("--")) throw new Error(`${arg} requires a value`);
    if (seen.has(key)) throw new Error(`${arg} may be provided only once`);
    seen.add(key);
    options[key] = value;
    index += 1;
  }
  if (options.help) return options;
  options.action = toStr(options.action);
  options.packetFile = toStr(options.packetFile);
  if (!options.action || !options.packetFile) throw new Error("--action and --packet are required");
  if (!["preflight", "seed", "activate", "deactivate", "rollback-check"].includes(options.action)) {
    throw new Error("--action is unsupported");
  }
  for (const key of ["packetFile", "ledgerFile", "activeFlowFile", "backupDir"]) {
    if (options[key] && !path.isAbsolute(options[key])) throw new Error(`${key} must be an absolute path`);
  }
  if (["seed", "activate", "deactivate"].includes(options.action) && options.expectedRevision === undefined) {
    throw new Error(`${options.action} requires --expected-revision`);
  }
  const revision = Number(options.expectedRevision ?? 0);
  if (!Number.isInteger(revision) || revision < 0) throw new Error("--expected-revision must be a non-negative integer");
  options.expectedRevision = revision;
  if (!options.apply && !options.ledgerFile) throw new Error("dry-run requires --ledger-file");
  if (options.apply && options.ledgerFile) throw new Error("--ledger-file is forbidden with --apply; live state must be read after connecting");
  if ((["preflight", "seed", "activate"].includes(options.action) || options.apply) && !options.activeFlowFile) {
    throw new Error(`${options.action} requires --active-flow`);
  }
  if (options.apply && !APPLY_GATES[options.action]) throw new Error(`${options.action} is read-only and does not support --apply`);
  return options;
}

const readRegular = (filePath, label, fsImpl = fs) => {
  const stat = fsImpl.lstatSync(filePath);
  if (!stat.isFile() || stat.isSymbolicLink()) throw new Error(`${label} must be a regular non-symlink file`);
  return fsImpl.readFileSync(filePath);
};

const readJson = (filePath, label, fsImpl = fs) => JSON.parse(readRegular(filePath, label, fsImpl).toString("utf8"));

const snapshotDocuments = (payload, packet, now) => {
  const capturedAt = Date.parse(String(payload?.capturedAt || ""));
  const expectedQuery = {
    inventoryId: packet.target.inventoryId,
    counterKey: packet.target.counterKey,
    includeSentinel: true,
    includeAtomicSales: true,
  };
  if (!payload || typeof payload !== "object" || Array.isArray(payload)
    || payload.formatVersion !== 1 || payload.complete !== true
    || payload.source !== "MONGO_LK_TOURNAMENT_SUBSCRIPTION_SALES"
    || stableJson(payload.query) !== stableJson(expectedQuery)
    || !Number.isFinite(capturedAt) || new Date(capturedAt).toISOString() !== payload.capturedAt
    || capturedAt > now.getTime() + 60_000
    || now.getTime() - capturedAt > 5 * 60_000
    || !payload.pagination || payload.pagination.complete !== true
    || !Number.isInteger(payload.pagination.pages) || payload.pagination.pages < 1
    || !Array.isArray(payload.rows) || payload.pagination.rowCount !== payload.rows.length) {
    throw new Error("ledger evidence must be a complete exact Mongo v1 snapshot");
  }
  return payload.rows;
};

const activeFlowSha = (options, fsImpl) => (
  options.activeFlowFile ? sha256(readRegular(options.activeFlowFile, "active flow", fsImpl)) : null
);

const durableWriteExclusive = (target, bytes, fsImpl) => {
  const fd = fsImpl.openSync(target, "wx", 0o600);
  try {
    fsImpl.writeFileSync(fd, bytes);
    fsImpl.fsyncSync(fd);
  } finally {
    fsImpl.closeSync(fd);
  }
  const readback = fsImpl.readFileSync(target);
  if (!readback.equals(bytes)) throw new Error(`durable snapshot readback mismatch: ${path.basename(target)}`);
  return sha256(readback);
};

const createPrivateForensicSnapshot = (backupDir, payload, ejsonStringify, fsImpl = fs) => {
  if (fsImpl.existsSync(backupDir)) throw new Error("--backup-dir must not already exist");
  const parentStat = fsImpl.lstatSync(path.dirname(backupDir));
  if (!parentStat.isDirectory() || parentStat.isSymbolicLink()
    || (parentStat.mode & 0o077) !== 0) throw new Error("snapshot parent must be a private regular directory");
  fsImpl.mkdirSync(backupDir, { mode: 0o700 });
  const parentFd = fsImpl.openSync(path.dirname(backupDir), "r");
  try { fsImpl.fsyncSync(parentFd); } finally { fsImpl.closeSync(parentFd); }
  const dataBytes = Buffer.from(`${ejsonStringify(payload)}\n`, "utf8");
  const dataName = "piter-atomic-ledger.preimage.ejson";
  const dataSha256 = durableWriteExclusive(path.join(backupDir, dataName), dataBytes, fsImpl);
  const manifest = {
    formatVersion: 1,
    artifact: dataName,
    artifactSha256: dataSha256,
    byteLength: dataBytes.length,
    encoding: "MongoDB Extended JSON canonical",
    restoreRehearsed: false,
  };
  durableWriteExclusive(
    path.join(backupDir, "manifest.json"),
    Buffer.from(`${JSON.stringify(manifest, null, 2)}\n`, "utf8"),
    fsImpl,
  );
  const directoryFd = fsImpl.openSync(backupDir, "r");
  try { fsImpl.fsyncSync(directoryFd); } finally { fsImpl.closeSync(directoryFd); }
  return { dataSha256, restoreRehearsed: false };
};

const assertProtectedCanonicalFlow = (options, fsImpl, liveFlowPath, expectedUid) => {
  if (options.activeFlowFile !== liveFlowPath) throw new Error(`--active-flow must equal ${liveFlowPath}`);
  const stat = fsImpl.lstatSync(liveFlowPath);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.uid !== expectedUid || (stat.mode & 0o022) !== 0) {
    throw new Error("canonical active flow ownership or mode mismatch");
  }
};

const linuxDeviceNumbers = (device) => {
  const value = BigInt(device);
  return {
    major: ((value >> 8n) & 0xfffn) | ((value >> 32n) & ~0xfffn),
    minor: (value & 0xffn) | ((value >> 12n) & ~0xffn),
  };
};

export const processOwnsExclusiveFlock = ({ procLocks, pid, lockStat, openFileStats }) => {
  const { major, minor } = linuxDeviceNumbers(lockStat.dev);
  const inode = BigInt(lockStat.ino);
  const ownsDescriptor = openFileStats.some((stat) => (
    BigInt(stat.dev) === BigInt(lockStat.dev) && BigInt(stat.ino) === inode
  ));
  if (!ownsDescriptor) return false;
  return String(procLocks).split("\n").some((line) => {
    const match = line.match(/^\d+:\s+(?:->\s+)?FLOCK\s+ADVISORY\s+WRITE\s+(\d+)\s+([0-9a-f]+):([0-9a-f]+):(\d+)\s/iu);
    return Boolean(match)
      && Number(match[1]) === pid
      && BigInt(`0x${match[2]}`) === major
      && BigInt(`0x${match[3]}`) === minor
      && BigInt(match[4]) === inode;
  });
};

export const verifyDeploymentLock = ({
  fsImpl = fs,
  lockPath = DEPLOYMENT_LOCK_PATH,
  expectedUid = 0,
  pid = process.pid,
  platform = process.platform,
} = {}) => {
  if (platform !== "linux") return false;
  const lockStat = fsImpl.lstatSync(lockPath, { bigint: true });
  if (!lockStat.isFile() || lockStat.isSymbolicLink()
    || lockStat.uid !== BigInt(expectedUid) || (lockStat.mode & 0o077n) !== 0n) return false;
  const openFileStats = [];
  for (const entry of fsImpl.readdirSync("/proc/self/fd")) {
    if (!/^\d+$/u.test(entry)) continue;
    try {
      openFileStats.push(fsImpl.statSync(`/proc/self/fd/${entry}`, { bigint: true }));
    } catch (error) {
      if (error?.code !== "ENOENT") throw error;
    }
  }
  return processOwnsExclusiveFlock({
    procLocks: fsImpl.readFileSync("/proc/locks", "utf8"),
    pid,
    lockStat,
    openFileStats,
  });
};

const assertApplyAuthorization = (options, packet, env, runtime) => {
  if (runtime.getUid() !== runtime.expectedUid) throw new Error("live ledger apply requires the canonical runtime owner");
  if (runtime.verifyDeploymentLock() !== true) {
    throw new Error("reviewed-flow deployment lock is not held by this process");
  }
  if (env.LK_PITER_ATOMIC_TARGET !== TARGET_HOST) throw new Error(`LK_PITER_ATOMIC_TARGET must equal ${TARGET_HOST}`);
  if (env.LK_PITER_ATOMIC_LEDGER_ACTION !== APPLY_GATES[options.action]) {
    throw new Error(`LK_PITER_ATOMIC_LEDGER_ACTION must equal ${APPLY_GATES[options.action]}`);
  }
  if (!SHA256_PATTERN.test(String(options.expectedContractDigest || ""))
    || options.expectedContractDigest !== packet.contractDigest) {
    throw new Error("--expected-contract-digest must exactly match the private packet");
  }
  if (!options.backupDir) throw new Error("--backup-dir is required with --apply");
  if (!toStr(env.LK_PITER_ATOMIC_MONGO_URI)) throw new Error("LK_PITER_ATOMIC_MONGO_URI is required with --apply");
  if (!SHA256_PATTERN.test(String(env.LK_PITER_ATOMIC_EXPECTED_MONGO_IDENTITY_SHA256 || ""))) {
    throw new Error("LK_PITER_ATOMIC_EXPECTED_MONGO_IDENTITY_SHA256 must be an exact SHA-256");
  }
  if (!SHA256_PATTERN.test(String(env.LK_PITER_ATOMIC_EXPECTED_HOST_IDENTITY_SHA256 || ""))) {
    throw new Error("LK_PITER_ATOMIC_EXPECTED_HOST_IDENTITY_SHA256 must be an exact SHA-256");
  }
  assertProtectedCanonicalFlow(options, runtime.fsImpl, runtime.liveFlowPath, runtime.expectedUid);
};

const queryDocuments = async (collection, packet) => collection.find({
  $or: [
    { _id: packet.target.ledgerId },
    { counterKey: packet.target.counterKey, inventoryId: packet.target.inventoryId },
  ],
}, { readConcern: { level: "majority" }, maxTimeMS: MAX_MONGO_TIME_MS }).toArray();

const exactWriteAck = (result, mutationType, ledgerId) => {
  if (mutationType === "insertOne") return result?.acknowledged === true && result.insertedId === ledgerId;
  return result?.acknowledged === true && result.matchedCount === 1 && result.modifiedCount === 1
    && result.upsertedCount === 0 && result.upsertedId == null;
};

const mongoIdentityDigest = async (client) => {
  const hello = await client.db("admin").command({ hello: 1 }, { maxTimeMS: MAX_MONGO_TIME_MS });
  const identity = {
    setName: toStr(hello?.setName),
    hosts: Array.isArray(hello?.hosts) ? hello.hosts.map(String).sort() : [],
    me: toStr(hello?.me),
    primary: toStr(hello?.primary),
  };
  if (!identity.setName || identity.hosts.length < 1 || !identity.me || !identity.primary) {
    throw new Error("Mongo deployment identity is incomplete");
  }
  return sha256(stableJson(identity));
};

const validateDeploymentLease = (lease, packet, now) => {
  const earliestEvidenceAt = Math.min(
    Date.parse(packet.evidence.ledgerCapturedAt),
    Date.parse(packet.evidence.providerCapturedAt),
    Date.parse(packet.evidence.productCapturedAt),
    Date.parse(packet.evidence.bindingCapturedAt),
  );
  if (!lease || lease.formatVersion !== 2 || lease.deploymentId !== packet.deployment.deploymentId
    || typeof lease.token !== "string" || !lease.token.trim()
    || lease.sourceSha256 !== packet.deployment.sourceSha256
    || lease.candidateSha256 !== packet.deployment.candidateSha256 || lease.phase !== "soaking"
    || !Number.isInteger(lease.acquiredAtMs) || lease.acquiredAtMs > earliestEvidenceAt
    || !Number.isInteger(lease.expiresAtMs) || lease.expiresAtMs <= lease.acquiredAtMs
    || lease.expiresAtMs <= now.getTime()) {
    throw new Error("matching non-expired reviewed-flow soaking lease is required");
  }
};

const exactPostcondition = ({ action, after, beforePlan, packet, expectedRevision, reason }) => {
  const sentinel = after.find((row) => row?._id === packet.target.ledgerId);
  if (!sentinel) return null;
  let shapeValid = true;
  try {
    validateAtomicLedgerShape(sentinel, packet.target.totalLimit);
  } catch {
    shapeValid = false;
    try { validateAtomicLedgerCustody(sentinel); } catch { return null; }
  }
  if (sentinel.activationContractDigest !== packet.contractDigest
    || sentinel.baselineDigest !== packet.baseline.digest
    || stableJson(sentinel.legacyPaymentRefs) !== stableJson(packet.baseline.legacyPaymentRefs)) return null;
  if (action === "seed" || action === "activate") {
    if (!shapeValid || sentinel.schemaVersion !== (packet.launchQuota ? 2 : 1)
      || (packet.launchQuota ? sentinel.quotaAdjustment !== packet.launchQuota.adjustment
        : Object.hasOwn(sentinel, "quotaAdjustment"))) return null;
  } else {
    const custody = beforePlan.preDeactivateQuotaCustody;
    if (!custody || sentinel.schemaVersion !== custody.schemaVersion
      || Object.hasOwn(sentinel, "quotaAdjustment") !== custody.hasQuotaAdjustment
      || sentinel.quotaAdjustment !== custody.quotaAdjustment) return null;
  }
  if (action === "seed") {
    return sentinel.ready === false && sentinel.revision === 0
      && sentinel.reservations.length === 0 && sentinel.reservedCount === 0
      && sentinel.paidCount === packet.baseline.paidCount
      && sentinel.takenCount === packet.baseline.paidCount ? sentinel : null;
  }
  if (action === "activate") {
    return shapeValid && sentinel.ready === true && sentinel.revision >= expectedRevision + 1
      && sentinel.activationBaseRevision === expectedRevision
      && sentinel.activationDeploymentId === packet.deployment.deploymentId ? sentinel : null;
  }
  const markerMatches = sentinel.ready === false && sentinel.revision >= expectedRevision + 1
    && sentinel.deactivationReason === toStr(reason)
    && sentinel.deactivationBaseRevision === expectedRevision;
  if (!markerMatches) return null;
  if (sentinel.revision === expectedRevision + 1) {
    const counts = beforePlan.preDeactivateCounts || {};
    return sentinel.paidCount === counts.paidCount
      && sentinel.reservedCount === counts.reservedCount
      && sentinel.takenCount === counts.takenCount ? sentinel : null;
  }
  if (!shapeValid) return null;
  const beforeReservations = Array.isArray(beforePlan.preDeactivateReservations)
    ? beforePlan.preDeactivateReservations : [];
  if (sentinel.reservations.length !== beforeReservations.length) return null;
  const afterByPaymentRef = new Map(sentinel.reservations.map((item) => [toStr(item?.paymentRef), item]));
  const validTransition = beforeReservations.every((previous) => {
    const current = afterByPaymentRef.get(toStr(previous?.paymentRef));
    if (!current || current.intentFingerprint !== previous.intentFingerprint) return false;
    if (previous.transactionId && current.transactionId !== previous.transactionId) return false;
    if (["PAID", "FAILED"].includes(previous.state) && current.state !== previous.state) return false;
    return true;
  });
  return validTransition ? sentinel : null;
};

export async function runLedgerOperation(options, dependencies = {}) {
  const fsImpl = dependencies.fsImpl || fs;
  const env = dependencies.env || process.env;
  const nowFn = dependencies.now || (() => new Date());
  const runtime = {
    fsImpl,
    liveFlowPath: dependencies.liveFlowPath || LIVE_FLOW_PATH,
    expectedUid: dependencies.expectedUid ?? 0,
    getUid: dependencies.getUid || (() => process.getuid?.()),
    verifyDeploymentLock: dependencies.verifyDeploymentLock || (() => verifyDeploymentLock({
      fsImpl,
      expectedUid: dependencies.expectedUid ?? 0,
    })),
  };
  const startedAt = freshNow(nowFn);
  const packet = readJson(options.packetFile, "activation packet", fsImpl);
  validatePiterAtomicActivationPacket(packet, {
    now: startedAt,
    allowExpired: options.action === "deactivate" || options.action === "rollback-check",
  });
  const flowSha256 = activeFlowSha(options, fsImpl);
  if (!options.apply) {
    const plan = buildPiterAtomicLedgerPlan({
      action: options.action,
      packet,
      documents: snapshotDocuments(readJson(options.ledgerFile, "ledger evidence", fsImpl), packet, startedAt),
      activeFlowSha256: flowSha256,
      expectedRevision: options.expectedRevision,
      now: startedAt,
      reason: options.reason,
    });
    return redactPiterAtomicLedgerPlan(plan);
  }

  assertApplyAuthorization(options, packet, env, runtime);
  const mongodb = dependencies.client ? dependencies.mongodb : (dependencies.mongodb || await import("mongodb"));
  const client = dependencies.client || new mongodb.MongoClient(env.LK_PITER_ATOMIC_MONGO_URI, {
    serverSelectionTimeoutMS: 10_000,
    socketTimeoutMS: 10_000,
  });
  const ownsClient = !dependencies.client;
  const readLease = dependencies.readDeploymentLease
    || (() => readJson(DEPLOYMENT_LEASE_PATH, "reviewed-flow deployment lease", fsImpl));
  const readHostIdentitySha256 = dependencies.readHostIdentitySha256
    || (() => sha256(readRegular("/etc/machine-id", "host machine identity", fsImpl).toString("utf8").trim()));
  const ejsonStringify = dependencies.ejsonStringify
    || ((value) => mongodb.BSON.EJSON.stringify(value, null, 2, { relaxed: false }));
  try {
    if (ownsClient) await client.connect();
    const actualHostIdentitySha256 = readHostIdentitySha256();
    if (actualHostIdentitySha256 !== env.LK_PITER_ATOMIC_EXPECTED_HOST_IDENTITY_SHA256) {
      throw new Error("runtime host identity does not match the authorized target");
    }
    const actualMongoIdentitySha256 = await mongoIdentityDigest(client);
    if (actualMongoIdentitySha256 !== env.LK_PITER_ATOMIC_EXPECTED_MONGO_IDENTITY_SHA256) {
      throw new Error("Mongo deployment identity does not match the authorized target");
    }
    const collection = client.db("games").collection(packet.target.collection);
    const before = await queryDocuments(collection, packet);
    const plan = buildPiterAtomicLedgerPlan({
      action: options.action,
      packet,
      documents: before,
      activeFlowSha256: flowSha256,
      expectedRevision: options.expectedRevision,
      now: startedAt,
      reason: options.reason,
    });
    if (!plan.mutation) {
      return {
        ...redactPiterAtomicLedgerPlan(plan),
        mutationPerformed: false,
        alreadyApplied: plan.outcome === "ALREADY_APPLIED",
        hostIdentitySha256: actualHostIdentitySha256,
        mongoIdentitySha256: actualMongoIdentitySha256,
      };
    }

    const commitAt = freshNow(nowFn);
    validatePiterAtomicActivationPacket(packet, { now: commitAt, allowExpired: options.action === "deactivate" });
    const finalFlowSha256 = activeFlowSha(options, fsImpl);
    if (["seed", "activate"].includes(options.action)) {
      if (finalFlowSha256 !== packet.deployment.candidateSha256) throw new Error("canonical active flow drifted before mutation");
      validateDeploymentLease(readLease(), packet, commitAt);
    }
    const forensicSnapshot = createPrivateForensicSnapshot(options.backupDir, {
      formatVersion: 1,
      capturedAt: commitAt.toISOString(),
      contractDigest: packet.contractDigest,
      action: options.action,
      documents: before,
    }, ejsonStringify, fsImpl);
    const writeAt = freshNow(nowFn);
    validatePiterAtomicActivationPacket(packet, { now: writeAt, allowExpired: options.action === "deactivate" });
    const writeFlowSha256 = activeFlowSha(options, fsImpl);
    if (["seed", "activate"].includes(options.action)) {
      if (writeFlowSha256 !== packet.deployment.candidateSha256) throw new Error("canonical active flow drifted before write");
      validateDeploymentLease(readLease(), packet, writeAt);
    }
    const mutation = plan.mutation;
    let writeResult = null;
    let writeError = null;
    try {
      writeResult = mutation.type === "insertOne"
        ? await collection.insertOne(mutation.document, {
          writeConcern: { w: "majority", j: true }, maxTimeMS: MAX_MONGO_TIME_MS,
        })
        : await collection.updateOne(mutation.filter, mutation.update, {
          upsert: false, writeConcern: { w: "majority", j: true }, maxTimeMS: MAX_MONGO_TIME_MS,
        });
    } catch (error) {
      writeError = error;
    }
    const after = await queryDocuments(collection, packet);
    const sentinel = exactPostcondition({
      action: options.action,
      after,
      beforePlan: plan,
      packet,
      expectedRevision: options.expectedRevision,
      reason: options.reason,
    });
    if (!sentinel) {
      if (writeError) throw new Error(`Mongo write outcome is unresolved after readback: ${writeError.message || writeError}`);
      if (!exactWriteAck(writeResult, mutation.type, packet.target.ledgerId)) {
        throw new Error("exact Mongo write acknowledgement and postcondition were not received");
      }
      throw new Error("post-write sentinel readback mismatch");
    }
    const acknowledged = exactWriteAck(writeResult, mutation.type, packet.target.ledgerId);
    return {
      ...redactPiterAtomicLedgerPlan(plan),
      mutationPerformed: true,
      ambiguousWriteRecovered: Boolean(writeError || !acknowledged),
      postRevision: sentinel.revision,
      postReady: sentinel.ready,
      canonicalFlowSha256: writeFlowSha256,
      runtimeStopProven: options.action !== "deactivate" || writeFlowSha256 === packet.deployment.candidateSha256,
      hostIdentitySha256: actualHostIdentitySha256,
      mongoIdentitySha256: actualMongoIdentitySha256,
      forensicSnapshotCreated: true,
      forensicSnapshotSha256: forensicSnapshot.dataSha256,
      restoreRehearsed: false,
    };
  } finally {
    if (ownsClient) await client.close();
  }
}

async function main() {
  try {
    const options = parseArgs(process.argv.slice(2));
    if (options.help) { process.stdout.write(usage); return; }
    if (options.apply && process.env[DEPLOYMENT_LOCK_WRAPPED_ENV] !== "1") {
      const result = spawnSync("flock", [
        "-n", "-E", "75", "-F", DEPLOYMENT_LOCK_PATH,
        "env", `${DEPLOYMENT_LOCK_WRAPPED_ENV}=1`, process.execPath, fileURLToPath(import.meta.url),
        ...process.argv.slice(2),
      ], { stdio: "inherit", env: process.env });
      if (result.error) throw result.error;
      process.exitCode = result.status ?? 1;
      return;
    }
    process.stdout.write(`${JSON.stringify(await runLedgerOperation(options), null, 2)}\n`);
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) await main();
