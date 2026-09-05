#!/usr/bin/env node

import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  assertPiterLegacyReconciliationPostcondition,
  assertPiterLegacyReconciliationPreconditions,
  buildPiterLegacyReconciliationMutations,
  PITER_LEGACY_RECONCILIATION,
  redactPiterLegacyReconciliationPacket,
  validatePiterLegacyReconciliationPacket,
} from "./lib/piterLegacySalesReconciliation.mjs";
import {
  digestPiterLegacyLedgerRows,
  sha256,
  stableJson,
} from "./lib/piterAtomicActivationContract.mjs";

const LIVE_FLOW_PATH = "/root/.node-red/flows.json";
const DEPLOYMENT_LOCK_PATH = "/root/.node-red/.padlhub-reviewed-flow-deploy.lock";
const DEPLOYMENT_LEASE_PATH = "/root/.node-red/.padlhub-reviewed-flow-deploy.lease.json";
const LOCK_HELD_ENV = "PADLHUB_REVIEWED_FLOW_LOCK_HELD";
const TARGET_HOST = "lk-primary-147";
const APPLY_PHRASE = "APPLY_PITER_LEGACY_RECONCILIATION_147";
const MAX_MONGO_TIME_MS = 5_000;
const MIN_AUTHORIZATION_REMAINING_MS = MAX_MONGO_TIME_MS * 2;
const SHA256_PATTERN = /^[a-f0-9]{64}$/;

const usage = `
manage_piter_legacy_reconciliation

Dry-run (default):
  node scripts/manage_piter_legacy_reconciliation.mjs \\
    --packet /absolute/private/reconciliation.packet.json \\
    --ledger-file /absolute/private/current-ledger-evidence.json \\
    [--active-flow /absolute/current/flows.json]

Live apply (future separately authorized operation only):
  LK_PITER_RECONCILIATION_TARGET=lk-primary-147 \\
  LK_PITER_RECONCILIATION_ACTION=${APPLY_PHRASE} \\
  LK_PITER_RECONCILIATION_MONGO_URI=... \\
  LK_PITER_RECONCILIATION_EXPECTED_HOST_IDENTITY_SHA256=<sha256> \\
  LK_PITER_RECONCILIATION_EXPECTED_MONGO_IDENTITY_SHA256=<sha256> \\
  node scripts/manage_piter_legacy_reconciliation.mjs \\
    --packet /absolute/private/reconciliation.packet.json \\
    --active-flow /root/.node-red/flows.json \\
    --expected-plan-digest <sha256> \\
    --backup-dir /absolute/new/private/backup \\
    --confirm ${APPLY_PHRASE} --apply
`;

const VALUE_FLAGS = new Map([
  ["--packet", "packetFile"],
  ["--ledger-file", "ledgerFile"],
  ["--active-flow", "activeFlowFile"],
  ["--expected-plan-digest", "expectedPlanDigest"],
  ["--backup-dir", "backupDir"],
  ["--confirm", "confirm"],
]);

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
  options.packetFile = toStr(options.packetFile);
  if (!options.packetFile) throw new Error("--packet is required");
  for (const key of ["packetFile", "ledgerFile", "activeFlowFile", "backupDir"]) {
    if (options[key] && !path.isAbsolute(options[key])) throw new Error(`${key} must be an absolute path`);
  }
  if (options.apply) {
    if (options.ledgerFile) throw new Error("--ledger-file is forbidden with --apply; live state is read after connecting");
    if (!options.activeFlowFile || !options.expectedPlanDigest || !options.backupDir) {
      throw new Error("--apply requires --active-flow, --expected-plan-digest and --backup-dir");
    }
    if (options.confirm !== APPLY_PHRASE) throw new Error(`--apply requires --confirm ${APPLY_PHRASE}`);
  } else if (!options.ledgerFile) {
    throw new Error("dry-run requires --ledger-file");
  }
  return options;
}

const readRegular = (filePath, label, fsImpl = fs) => {
  const stat = fsImpl.lstatSync(filePath);
  if (!stat.isFile() || stat.isSymbolicLink()) throw new Error(`${label} must be a regular non-symlink file`);
  return fsImpl.readFileSync(filePath);
};

const readJson = (filePath, label, fsImpl = fs) => JSON.parse(readRegular(filePath, label, fsImpl).toString("utf8"));

const activeFlowSha = (options, fsImpl) => (
  options.activeFlowFile ? sha256(readRegular(options.activeFlowFile, "active flow", fsImpl)) : null
);

const snapshotRows = (payload, packet, now) => {
  const capturedAt = Date.parse(String(payload?.capturedAt || ""));
  const expectedQuery = { inventoryId: packet.target.inventoryId, counterKey: packet.target.counterKey };
  if (!payload || typeof payload !== "object" || Array.isArray(payload)
    || payload.formatVersion !== 1 || payload.complete !== true
    || payload.source !== "MONGO_LK_TOURNAMENT_SUBSCRIPTION_SALES"
    || stableJson(payload.query) !== stableJson(expectedQuery)
    || !Number.isFinite(capturedAt) || capturedAt > now.getTime() + 60_000
    || now.getTime() - capturedAt > 5 * 60_000
    || !payload.pagination || payload.pagination.complete !== true
    || !Number.isInteger(payload.pagination.pages) || payload.pagination.pages < 1
    || !Array.isArray(payload.rows) || payload.pagination.rowCount !== payload.rows.length) {
    throw new Error("ledger evidence must be a fresh complete exact Mongo v1 snapshot");
  }
  return payload.rows;
};

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

const fsyncDirectory = (directory, fsImpl) => {
  const fd = fsImpl.openSync(directory, "r");
  try {
    fsImpl.fsyncSync(fd);
  } finally {
    fsImpl.closeSync(fd);
  }
};

const fsyncRegularFile = (target, fsImpl) => {
  const stat = fsImpl.lstatSync(target);
  if (!stat.isFile() || stat.isSymbolicLink()) throw new Error("receipt must be a regular non-symlink file");
  const fd = fsImpl.openSync(target, "r");
  try {
    fsImpl.fsyncSync(fd);
  } finally {
    fsImpl.closeSync(fd);
  }
};

const durablePublishExclusive = (target, bytes, fsImpl) => {
  if (fsImpl.existsSync(target)) throw new Error(`durable target already exists: ${path.basename(target)}`);
  const temp = path.join(
    path.dirname(target),
    `.${path.basename(target)}.${process.pid}.${Date.now()}.tmp`,
  );
  const fd = fsImpl.openSync(temp, "wx", 0o600);
  try {
    fsImpl.writeFileSync(fd, bytes);
    fsImpl.fsyncSync(fd);
  } finally {
    fsImpl.closeSync(fd);
  }
  const readback = fsImpl.readFileSync(temp);
  if (!readback.equals(bytes)) throw new Error(`durable temp readback mismatch: ${path.basename(target)}`);
  fsImpl.linkSync(temp, target);
  fsyncDirectory(path.dirname(target), fsImpl);
  fsImpl.unlinkSync(temp);
  fsyncDirectory(path.dirname(target), fsImpl);
  return sha256(readback);
};

const createPrivateForensicSnapshot = (backupDir, payload, ejsonStringify, fsImpl = fs) => {
  if (fsImpl.existsSync(backupDir)) throw new Error("--backup-dir must not already exist");
  const parentStat = fsImpl.lstatSync(path.dirname(backupDir));
  if (!parentStat.isDirectory() || parentStat.isSymbolicLink() || (parentStat.mode & 0o077) !== 0) {
    throw new Error("snapshot parent must be a private regular directory");
  }
  fsImpl.mkdirSync(backupDir, { mode: 0o700 });
  fsyncDirectory(path.dirname(backupDir), fsImpl);
  const dataName = "piter-legacy-sales.preimage.ejson";
  const dataBytes = Buffer.from(`${ejsonStringify(payload)}\n`, "utf8");
  const dataSha256 = durableWriteExclusive(path.join(backupDir, dataName), dataBytes, fsImpl);
  const manifest = {
    formatVersion: 1,
    artifact: dataName,
    artifactSha256: dataSha256,
    byteLength: dataBytes.length,
    encoding: "MongoDB Extended JSON canonical",
    planDigest: payload.planDigest,
    operationId: payload.operationId,
    restoreRehearsed: false,
  };
  durableWriteExclusive(
    path.join(backupDir, "manifest.json"),
    Buffer.from(`${JSON.stringify(manifest, null, 2)}\n`, "utf8"),
    fsImpl,
  );
  fsyncDirectory(backupDir, fsImpl);
  return { dataSha256, restoreRehearsed: false };
};

const assertProtectedCanonicalFlow = (options, runtime) => {
  if (options.activeFlowFile !== runtime.liveFlowPath) throw new Error(`--active-flow must equal ${runtime.liveFlowPath}`);
  const stat = runtime.fsImpl.lstatSync(runtime.liveFlowPath);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.uid !== runtime.expectedUid || (stat.mode & 0o022) !== 0) {
    throw new Error("canonical active flow ownership or mode mismatch");
  }
};

const assertApplyAuthorization = (options, packet, env, runtime) => {
  if (runtime.getUid() !== runtime.expectedUid) throw new Error("live reconciliation requires the canonical runtime owner");
  if (env[LOCK_HELD_ENV] !== "1") throw new Error("reviewed-flow deployment lock is not held");
  if (env.LK_PITER_RECONCILIATION_TARGET !== TARGET_HOST) {
    throw new Error(`LK_PITER_RECONCILIATION_TARGET must equal ${TARGET_HOST}`);
  }
  if (env.LK_PITER_RECONCILIATION_ACTION !== APPLY_PHRASE) {
    throw new Error(`LK_PITER_RECONCILIATION_ACTION must equal ${APPLY_PHRASE}`);
  }
  if (!SHA256_PATTERN.test(String(options.expectedPlanDigest || ""))
    || options.expectedPlanDigest !== packet.planDigest) {
    throw new Error("--expected-plan-digest must exactly match the private packet");
  }
  if (!toStr(env.LK_PITER_RECONCILIATION_MONGO_URI)) throw new Error("LK_PITER_RECONCILIATION_MONGO_URI is required");
  for (const key of [
    "LK_PITER_RECONCILIATION_EXPECTED_HOST_IDENTITY_SHA256",
    "LK_PITER_RECONCILIATION_EXPECTED_MONGO_IDENTITY_SHA256",
  ]) {
    if (!SHA256_PATTERN.test(String(env[key] || ""))) throw new Error(`${key} must be an exact SHA-256`);
  }
  assertProtectedCanonicalFlow(options, runtime);
};

const queryRows = async (collection, packet, session = null) => collection.find(
  { inventoryId: packet.target.inventoryId, counterKey: packet.target.counterKey },
  session
    ? { session, maxTimeMS: MAX_MONGO_TIME_MS }
    : { readConcern: { level: "majority" }, maxTimeMS: MAX_MONGO_TIME_MS },
).toArray();

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

const validateDeploymentLease = (lease, packet, now, minRemainingMs = 0) => {
  const earliestEvidenceAt = Math.min(
    Date.parse(packet.evidence.ledgerCapturedAt),
    Date.parse(packet.evidence.providerCapturedAt),
    Date.parse(packet.evidence.subscriptionCapturedAt),
  );
  if (!lease || lease.formatVersion !== 2 || lease.deploymentId !== packet.deployment.deploymentId
    || typeof lease.token !== "string" || !lease.token.trim()
    || lease.sourceSha256 !== packet.deployment.sourceSha256
    || lease.candidateSha256 !== packet.deployment.candidateSha256
    || lease.phase !== "soaking"
    || !Number.isInteger(lease.acquiredAtMs) || lease.acquiredAtMs > earliestEvidenceAt
    || lease.acquiredAtMs > now.getTime()
    || !Number.isInteger(lease.expiresAtMs) || lease.expiresAtMs <= lease.acquiredAtMs
    || lease.expiresAtMs - now.getTime() < minRemainingMs) {
    throw new Error("matching non-expired reviewed-flow soaking lease is required");
  }
};

const assertAuthorizationWindow = (packet, lease, now, expectedLeaseToken = null) => {
  validatePiterLegacyReconciliationPacket(packet, { now });
  if (expectedLeaseToken && lease?.token !== expectedLeaseToken) {
    throw new Error("reviewed-flow soaking lease token drifted");
  }
  if (Date.parse(packet.expiresAt) - now.getTime() < MIN_AUTHORIZATION_REMAINING_MS) {
    throw new Error("reconciliation packet lacks enough time for a bounded commit");
  }
  validateDeploymentLease(lease, packet, now, MIN_AUTHORIZATION_REMAINING_MS);
};

const authorizationTimeoutMs = (packet, lease, now) => {
  assertAuthorizationWindow(packet, lease, now, lease?.token);
  const deadline = Math.min(Date.parse(packet.expiresAt), lease.expiresAtMs);
  const timeoutMs = deadline - now.getTime() - 1_000;
  if (!Number.isInteger(timeoutMs) || timeoutMs < MAX_MONGO_TIME_MS) {
    throw new Error("authorization window cannot bound the complete transaction");
  }
  return timeoutMs;
};

const exactDocumentSetDigest = (documents, ejsonStringify) => sha256(stableJson(
  documents.map((document) => ejsonStringify(document)).sort(),
));

const expectedPostimageRows = (before, packet) => {
  const changes = new Map(packet.changes.map((change) => [change.transactionId, change]));
  return before.map((row) => {
    const transactionId = toStr(row?.transactionId) || toStr(row?.paymentId)
      || toStr(row?.externalId) || toStr(row?.id) || toStr(row?.uuid);
    const change = changes.get(transactionId);
    return change ? { ...row, ...change.set } : row;
  });
};

const buildApplyReceipt = ({
  packet,
  appliedAt,
  after,
  exactPostimageDigest,
  forensicSnapshot,
  hostIdentitySha256,
  mongoIdentitySha256,
  receiptRecovered = false,
}) => {
  const unsigned = {
    formatVersion: 1,
    kind: PITER_LEGACY_RECONCILIATION.applyReceiptKind,
    appliedAt,
    mutationPerformed: true,
    receiptRecovered,
    operationId: packet.operationId,
    planDigest: packet.planDigest,
    evidenceDigest: packet.evidence.evidenceDigest,
    deployment: packet.deployment,
    target: packet.target,
    legacyLedgerDigest: digestPiterLegacyLedgerRows(after),
    exactPostimageDigest,
    forensicSnapshotSha256: forensicSnapshot.dataSha256,
    hostIdentitySha256,
    mongoIdentitySha256,
    canonicalFlowSha256: packet.deployment.candidateSha256,
    changeCount: packet.changes.length,
    providerOnlyRefundHashes: packet.providerOnlyRefunds.map((item) => item.transactionHash).sort(),
  };
  return { ...unsigned, receiptDigest: sha256(stableJson(unsigned)) };
};

const isExactApplyReceipt = (existing, expected) => {
  if (!existing || typeof existing !== "object" || Array.isArray(existing)) return false;
  const receiptDigest = existing.receiptDigest;
  const appliedAt = existing.appliedAt;
  const receiptRecovered = existing.receiptRecovered;
  const identity = { ...existing };
  const expectedIdentity = { ...expected };
  delete identity.receiptDigest;
  delete identity.appliedAt;
  delete identity.receiptRecovered;
  delete expectedIdentity.receiptDigest;
  delete expectedIdentity.appliedAt;
  delete expectedIdentity.receiptRecovered;
  return SHA256_PATTERN.test(String(receiptDigest || ""))
    && sha256(stableJson({ ...identity, appliedAt, receiptRecovered })) === receiptDigest
    && Number.isFinite(Date.parse(String(appliedAt || "")))
    && stableJson(identity) === stableJson(expectedIdentity);
};

const recoverApplyReceipt = ({
  backupDir,
  packet,
  currentRows,
  appliedAt,
  hostIdentitySha256,
  mongoIdentitySha256,
  ejsonStringify,
  ejsonParse,
  fsImpl,
}) => {
  const backupStat = fsImpl.lstatSync(backupDir);
  if (!backupStat.isDirectory() || backupStat.isSymbolicLink() || (backupStat.mode & 0o077) !== 0) {
    throw new Error("receipt recovery requires the exact private backup directory");
  }
  const storedPacket = readJson(
    path.join(backupDir, "reviewed-reconciliation.packet.json"),
    "stored reconciliation packet",
    fsImpl,
  );
  if (stableJson(storedPacket) !== stableJson(packet)) {
    throw new Error("stored reconciliation packet does not match --packet");
  }
  const manifest = readJson(path.join(backupDir, "manifest.json"), "forensic manifest", fsImpl);
  const preimageBytes = readRegular(
    path.join(backupDir, "piter-legacy-sales.preimage.ejson"),
    "forensic preimage",
    fsImpl,
  );
  if (manifest?.formatVersion !== 1
    || manifest.artifact !== "piter-legacy-sales.preimage.ejson"
    || manifest.artifactSha256 !== sha256(preimageBytes)
    || manifest.planDigest !== packet.planDigest
    || manifest.operationId !== packet.operationId) {
    throw new Error("forensic preimage manifest mismatch");
  }
  const preimage = ejsonParse(preimageBytes.toString("utf8"));
  if (!preimage || preimage.planDigest !== packet.planDigest
    || preimage.operationId !== packet.operationId || !Array.isArray(preimage.documents)) {
    throw new Error("forensic preimage payload mismatch");
  }
  const expectedAfter = expectedPostimageRows(preimage.documents, packet);
  const exactPostimageDigest = exactDocumentSetDigest(expectedAfter, ejsonStringify);
  const postcondition = assertPiterLegacyReconciliationPostcondition(packet, currentRows, {
    expectedRows: expectedAfter,
    serialize: ejsonStringify,
  });
  const applyReceipt = buildApplyReceipt({
    packet,
    appliedAt,
    after: currentRows,
    exactPostimageDigest,
    forensicSnapshot: { dataSha256: manifest.artifactSha256 },
    hostIdentitySha256,
    mongoIdentitySha256,
    receiptRecovered: true,
  });
  const receiptPath = path.join(backupDir, "apply-receipt.json");
  if (fsImpl.existsSync(receiptPath)) {
    let existing = null;
    try {
      existing = readJson(receiptPath, "existing apply receipt", fsImpl);
    } catch {
      existing = null;
    }
    if (isExactApplyReceipt(existing, applyReceipt)) {
      fsyncRegularFile(receiptPath, fsImpl);
      fsyncDirectory(backupDir, fsImpl);
      return { applyReceipt: existing, postcondition, receiptRecoveryPerformed: false };
    }
    const receiptStat = fsImpl.lstatSync(receiptPath);
    if (!receiptStat.isFile() || receiptStat.isSymbolicLink()) {
      throw new Error("invalid existing apply receipt is not a regular file");
    }
    const quarantinePath = path.join(
      backupDir,
      `apply-receipt.invalid.${process.pid}.${Date.now()}.json`,
    );
    fsImpl.renameSync(receiptPath, quarantinePath);
    fsyncDirectory(backupDir, fsImpl);
  }
  durablePublishExclusive(
    receiptPath,
    Buffer.from(`${JSON.stringify(applyReceipt, null, 2)}\n`, "utf8"),
    fsImpl,
  );
  fsyncDirectory(backupDir, fsImpl);
  return { applyReceipt, postcondition, receiptRecoveryPerformed: true };
};

export async function runPiterLegacyReconciliation(options, dependencies = {}) {
  const fsImpl = dependencies.fsImpl || fs;
  const env = dependencies.env || process.env;
  const nowFn = dependencies.now || (() => new Date());
  const runtime = {
    fsImpl,
    liveFlowPath: dependencies.liveFlowPath || LIVE_FLOW_PATH,
    expectedUid: dependencies.expectedUid ?? 0,
    getUid: dependencies.getUid || (() => process.getuid?.()),
  };
  const startedAt = freshNow(nowFn);
  const packet = readJson(options.packetFile, "reconciliation packet", fsImpl);
  const backupExists = Boolean(options.apply && options.backupDir && fsImpl.existsSync(options.backupDir));
  validatePiterLegacyReconciliationPacket(packet, { now: startedAt, allowExpired: backupExists });
  const flowSha256 = activeFlowSha(options, fsImpl);
  if (flowSha256 && flowSha256 !== packet.deployment.candidateSha256) {
    throw new Error("active flow SHA does not match the reviewed candidate");
  }
  if (!options.apply) {
    const rows = snapshotRows(readJson(options.ledgerFile, "ledger evidence", fsImpl), packet, startedAt);
    assertPiterLegacyReconciliationPreconditions(packet, rows, { now: startedAt });
    return redactPiterLegacyReconciliationPacket(packet);
  }

  assertApplyAuthorization(options, packet, env, runtime);
  if (flowSha256 !== packet.deployment.candidateSha256) throw new Error("canonical active flow mismatch");
  const mongodb = dependencies.client ? dependencies.mongodb : (dependencies.mongodb || await import("mongodb"));
  const client = dependencies.client || new mongodb.MongoClient(env.LK_PITER_RECONCILIATION_MONGO_URI, {
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
  const ejsonParse = dependencies.ejsonParse
    || ((value) => mongodb.BSON.EJSON.parse(value, { relaxed: false }));
  let session = null;
  try {
    if (ownsClient) await client.connect();
    const hostIdentitySha256 = readHostIdentitySha256();
    if (hostIdentitySha256 !== env.LK_PITER_RECONCILIATION_EXPECTED_HOST_IDENTITY_SHA256) {
      throw new Error("runtime host identity does not match the authorized target");
    }
    const mongoIdentitySha256 = await mongoIdentityDigest(client);
    if (mongoIdentitySha256 !== env.LK_PITER_RECONCILIATION_EXPECTED_MONGO_IDENTITY_SHA256) {
      throw new Error("Mongo deployment identity does not match the authorized target");
    }
    const collection = client.db("games").collection(packet.target.collection);
    const before = await queryRows(collection, packet);
    try {
      assertPiterLegacyReconciliationPreconditions(packet, before, { now: startedAt });
    } catch (preconditionError) {
      if (!backupExists) throw preconditionError;
      const recovery = recoverApplyReceipt({
        backupDir: options.backupDir,
        packet,
        currentRows: before,
        appliedAt: freshNow(nowFn).toISOString(),
        hostIdentitySha256,
        mongoIdentitySha256,
        ejsonStringify,
        ejsonParse,
        fsImpl,
      });
      return {
        ...redactPiterLegacyReconciliationPacket(packet),
        mutationPerformed: false,
        reconciliationPreviouslyApplied: true,
        receiptRecoveryPerformed: recovery.receiptRecoveryPerformed,
        postcondition: recovery.postcondition,
        applyReceiptDigest: recovery.applyReceipt.receiptDigest,
        legacyLedgerDigest: recovery.applyReceipt.legacyLedgerDigest,
        hostIdentitySha256,
        mongoIdentitySha256,
        canonicalFlowSha256: packet.deployment.candidateSha256,
      };
    }
    const commitAt = freshNow(nowFn);
    validatePiterLegacyReconciliationPacket(packet, { now: commitAt });
    if (activeFlowSha(options, fsImpl) !== packet.deployment.candidateSha256) {
      throw new Error("canonical active flow drifted before backup");
    }
    assertAuthorizationWindow(packet, readLease(), commitAt);
    const exactPreimageDigest = exactDocumentSetDigest(before, ejsonStringify);
    const forensicSnapshot = createPrivateForensicSnapshot(options.backupDir, {
      formatVersion: 1,
      capturedAt: commitAt.toISOString(),
      planDigest: packet.planDigest,
      operationId: packet.operationId,
      documents: before,
    }, ejsonStringify, fsImpl);
    durableWriteExclusive(
      path.join(options.backupDir, "reviewed-reconciliation.packet.json"),
      Buffer.from(`${JSON.stringify(packet, null, 2)}\n`, "utf8"),
      fsImpl,
    );
    fsyncDirectory(options.backupDir, fsImpl);
    session = client.startSession();
    const transactionStartAt = freshNow(nowFn);
    const transactionLease = readLease();
    const transactionLeaseToken = transactionLease?.token;
    const transactionTimeoutMS = authorizationTimeoutMs(packet, transactionLease, transactionStartAt);
    let writeError = null;
    try {
      await session.withTransaction(async () => {
        const writeAt = freshNow(nowFn);
        assertAuthorizationWindow(packet, readLease(), writeAt, transactionLeaseToken);
        if (activeFlowSha(options, fsImpl) !== packet.deployment.candidateSha256) {
          throw new Error("canonical active flow drifted before write");
        }
        const transactionalRows = await queryRows(collection, packet, session);
        assertPiterLegacyReconciliationPreconditions(packet, transactionalRows, { now: writeAt });
        if (exactDocumentSetDigest(transactionalRows, ejsonStringify) !== exactPreimageDigest) {
          throw new Error("transactional ledger preimage differs from the forensic backup");
        }
        for (const mutation of buildPiterLegacyReconciliationMutations(packet)) {
          assertAuthorizationWindow(packet, readLease(), freshNow(nowFn), transactionLeaseToken);
          const result = await collection.updateOne(mutation.filter, mutation.update, {
            session,
            upsert: false,
            maxTimeMS: MAX_MONGO_TIME_MS,
          });
          if (result?.acknowledged !== true || result.matchedCount !== 1 || result.modifiedCount !== 1
            || result.upsertedCount !== 0 || result.upsertedId != null) {
            throw new Error(`exact CAS acknowledgement missing for ${mutation.transactionHash}`);
          }
        }
        assertAuthorizationWindow(packet, readLease(), freshNow(nowFn), transactionLeaseToken);
      }, {
        readConcern: { level: "snapshot" },
        writeConcern: { w: "majority", j: true },
        maxCommitTimeMS: MAX_MONGO_TIME_MS,
        timeoutMS: transactionTimeoutMS,
      });
    } catch (error) {
      writeError = error;
    }
    const after = await queryRows(collection, packet);
    let post = null;
    const expectedAfter = expectedPostimageRows(before, packet);
    const exactPostimageDigest = exactDocumentSetDigest(expectedAfter, ejsonStringify);
    try {
      post = assertPiterLegacyReconciliationPostcondition(packet, after, {
        expectedRows: expectedAfter,
        serialize: ejsonStringify,
      });
    } catch { post = null; }
    if (!post) {
      if (writeError) throw writeError;
      throw new Error("post-write ledger readback mismatch");
    }
    const appliedAt = freshNow(nowFn).toISOString();
    const applyReceipt = buildApplyReceipt({
      packet,
      appliedAt,
      after,
      exactPostimageDigest,
      forensicSnapshot,
      hostIdentitySha256,
      mongoIdentitySha256,
      receiptRecovered: false,
    });
    durablePublishExclusive(
      path.join(options.backupDir, "apply-receipt.json"),
      Buffer.from(`${JSON.stringify(applyReceipt, null, 2)}\n`, "utf8"),
      fsImpl,
    );
    fsyncDirectory(options.backupDir, fsImpl);
    return {
      ...redactPiterLegacyReconciliationPacket(packet),
      mutationPerformed: true,
      ambiguousCommitRecovered: Boolean(writeError),
      postcondition: post,
      hostIdentitySha256,
      mongoIdentitySha256,
      canonicalFlowSha256: packet.deployment.candidateSha256,
      forensicSnapshotCreated: true,
      forensicSnapshotSha256: forensicSnapshot.dataSha256,
      applyReceiptDigest: applyReceipt.receiptDigest,
      legacyLedgerDigest: applyReceipt.legacyLedgerDigest,
      restoreRehearsed: false,
    };
  } finally {
    if (session) await session.endSession();
    if (ownsClient) await client.close();
  }
}

async function main() {
  try {
    const options = parseArgs(process.argv.slice(2));
    if (options.help) { process.stdout.write(usage); return; }
    if (options.apply && process.env[LOCK_HELD_ENV] !== "1") {
      const result = spawnSync("flock", [
        "-n", "-E", "75", DEPLOYMENT_LOCK_PATH,
        "env", `${LOCK_HELD_ENV}=1`, process.execPath, fileURLToPath(import.meta.url),
        ...process.argv.slice(2),
      ], { stdio: "inherit", env: process.env });
      if (result.error) throw result.error;
      process.exitCode = result.status ?? 1;
      return;
    }
    process.stdout.write(`${JSON.stringify(await runPiterLegacyReconciliation(options), null, 2)}\n`);
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) await main();
