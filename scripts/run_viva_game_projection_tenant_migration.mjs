#!/usr/bin/env node

import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { BSON, MongoClient } from "mongodb";

import {
  applyTenantMigrationPlan,
  captureTenantMigrationPreimages,
  reconcileTenantMigrationOutcome,
  reconcileTenantRestoreOutcome,
  restoreTenantMigrationBackup,
  sha256,
  validateApplyReceipt,
  validateExecutableTenantMigrationPlan,
  validateMigrationBackup,
} from "./lib/vivaGameProjectionTenantMigrationExecution.mjs";
import { buildMongoTargetIdentity, canonicalJson } from "./lib/vivaGameProjectionCutoverContract.mjs";
import {
  assertMongoWriteBarrier,
  normalizeMongoAuthenticationRestrictions,
} from "./lib/vivaGameProjectionMongoWriteBarrier.mjs";
import { assertExactExecutorSources } from "./lib/vivaGameProjectionExecutorSource.mjs";
import { validateExactCutoverPacket } from "./lib/vivaGameProjectionCutoverPacketValidation.mjs";
import {
  recoverAtomicExclusivePublication,
  writeFileExclusiveAtomicDurable,
} from "./nodered_reviewed_flow_deploy/runtime_contract.mjs";

const SCRIPT_PATH = fileURLToPath(import.meta.url);
const REPO_ROOT = fs.realpathSync(path.resolve(path.dirname(SCRIPT_PATH), ".."));
const APPLY_CONFIRMATION = "APPLY_VIVA_GAME_PROJECTION_TENANT_MIGRATION_V1";
const RESTORE_CONFIRMATION = "RESTORE_VIVA_GAME_PROJECTION_TENANT_MIGRATION_V1";
const MONGO_CONFIG_ID = "4e820638cc39c730";
const PRODUCTION_FLOW_PATH = "/root/.node-red/flows.json";
const PRODUCTION_LOCK_PATH = "/run/lock/padlhub-viva-game-projection-cutover.lock";
const WRITE_COMMANDS = new Set([
  "insert", "update", "delete", "findAndModify", "createIndexes", "drop", "dropDatabase", "renameCollection", "collMod",
]);
const MAX_PLAN_BYTES = 64 * 1024 * 1024;
const MAX_BACKUP_BYTES = 512 * 1024 * 1024;
const MAX_PACKET_BYTES = 16 * 1024 * 1024;
const MAX_CONNECTION_BYTES = 1024 * 1024;

const fail = (message) => { throw new Error(message); };
const isObject = (value) => Boolean(value) && typeof value === "object" && !Array.isArray(value);
const safeError = (error) => String(error instanceof Error ? error.message : error)
  .replace(/mongodb(?:\+srv)?:\/\/[^\s]+/gi, "[REDACTED_MONGO_URI]")
  .slice(0, 500);

function parseArgs(argv) {
  const values = new Map();
  for (let index = 0; index < argv.length; index += 2) {
    const key = argv[index];
    const value = argv[index + 1];
    if (!key?.startsWith("--") || value === undefined || value.startsWith("--") || values.has(key)) {
      fail(`Invalid argument: ${key || ""}`);
    }
    values.set(key, value);
  }
  const mode = values.get("--mode");
  if (!new Set(["verify", "apply", "restore", "reconcile", "reconcile-restore"]).has(mode)) {
    fail("--mode must be verify, apply, restore, reconcile, or reconcile-restore");
  }
  for (const key of [
    "--plan", "--cutover-plan", "--packet-manifest", "--expected-plan-sha256",
    "--expected-cutover-plan-sha256", "--expected-packet-manifest-sha256",
    "--expected-source-flow-sha256", "--expected-runtime-flow-sha256", "--flow-path",
    "--fence-receipt", "--mongo-write-barrier-receipt", "--migration-connection-file", "--report",
  ]) {
    if (!values.get(key)) fail(`Missing ${key}`);
  }
  if (mode === "apply" && !values.get("--backup-dir")) fail("Apply requires --backup-dir");
  if (new Set(["restore", "reconcile-restore"]).has(mode) && (!values.get("--backup") || !values.get("--apply-receipt")
    || !values.get("--expected-backup-sha256") || !values.get("--expected-apply-report-sha256"))) {
    fail("Restore and reconcile-restore require --backup, --apply-receipt and their expected SHA-256 digests");
  }
  if (mode === "reconcile" && (!values.get("--backup") || !values.get("--expected-backup-sha256"))) {
    fail("Reconcile requires --backup and --expected-backup-sha256");
  }
  return { mode, values };
}

export function readPrivateBytes(filePath, label, maximumSize) {
  if (!path.isAbsolute(String(filePath || ""))) fail(`${label} path must be absolute`);
  const requested = path.resolve(filePath);
  if (fs.realpathSync(requested) !== requested) fail(`${label} path must be canonical`);
  const descriptor = fs.openSync(requested, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
  try {
    const stat = fs.fstatSync(descriptor);
    const currentUid = typeof process.getuid === "function" ? process.getuid() : stat.uid;
    if (!stat.isFile() || stat.nlink !== 1 || stat.uid !== currentUid || (stat.mode & 0o077) !== 0
      || stat.size === 0 || stat.size > maximumSize) {
      fail(`${label} must be an owned private single-link regular file`);
    }
    return fs.readFileSync(descriptor);
  } finally {
    fs.closeSync(descriptor);
  }
}

export function readPrivateJson(filePath, label, maximumSize) {
  const bytes = readPrivateBytes(filePath, label, maximumSize);
  let value;
  try { value = JSON.parse(bytes.toString("utf8")); } catch { fail(`${label} must contain valid JSON`); }
  return { bytes, value };
}

function readPrivateEjson(filePath, label, maximumSize) {
  const bytes = readPrivateBytes(filePath, label, maximumSize);
  let value;
  try { value = BSON.EJSON.parse(bytes.toString("utf8"), { relaxed: false }); } catch { fail(`${label} must contain valid canonical EJSON`); }
  return { bytes, value };
}

const isWithin = (parent, candidate) => {
  const relative = path.relative(parent, candidate);
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
};

export function ensurePrivateDirectory(directoryPath, label) {
  if (!path.isAbsolute(String(directoryPath || ""))) fail(`${label} must be absolute`);
  const requested = path.resolve(directoryPath);
  if (isWithin(REPO_ROOT, requested)) fail(`${label} must be outside the repository`);
  const probeRoot = fs.existsSync(requested) ? requested : path.dirname(requested);
  const gitProbe = spawnSync("git", ["-C", probeRoot, "rev-parse", "--show-toplevel"], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "ignore"],
  });
  if (gitProbe.status === 0 && gitProbe.stdout.trim()) fail(`${label} must be outside every Git worktree`);
  if (fs.existsSync(requested)) {
    const stat = fs.lstatSync(requested);
    const currentUid = typeof process.getuid === "function" ? process.getuid() : stat.uid;
    if (!stat.isDirectory() || stat.isSymbolicLink() || fs.realpathSync(requested) !== requested
      || stat.uid !== currentUid || (stat.mode & 0o077) !== 0) {
      fail(`${label} must be an owned private canonical directory`);
    }
  } else {
    const parent = path.dirname(requested);
    const parentStat = fs.lstatSync(parent);
    const currentUid = typeof process.getuid === "function" ? process.getuid() : parentStat.uid;
    if (!parentStat.isDirectory() || parentStat.isSymbolicLink() || fs.realpathSync(parent) !== parent
      || parentStat.uid !== currentUid || (parentStat.mode & 0o077) !== 0) {
      fail(`${label} parent must be an owned private canonical directory`);
    }
    fs.mkdirSync(requested, { mode: 0o700 });
    fs.chmodSync(requested, 0o700);
  }
  return requested;
}

function syncDirectory(directory) {
  const descriptor = fs.openSync(directory, fs.constants.O_RDONLY);
  try { fs.fsyncSync(descriptor); } finally { fs.closeSync(descriptor); }
}

function writeDurableExclusive(filePath, bytes) {
  const descriptor = fs.openSync(filePath, fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_WRONLY, 0o600);
  try {
    fs.fchmodSync(descriptor, 0o600);
    fs.writeFileSync(descriptor, bytes);
    fs.fsyncSync(descriptor);
  } finally {
    fs.closeSync(descriptor);
  }
  syncDirectory(path.dirname(filePath));
  const readback = readPrivateBytes(filePath, "Durable output", Math.max(bytes.length + 1, 1024));
  if (!readback.equals(bytes)) fail("Durable output readback mismatch");
  return sha256(readback);
}

export function recoverDurableTerminalReport(reportPath, mode, expectedReportSha256 = null, preparedReport = null) {
  if (!path.isAbsolute(String(reportPath || ""))) fail("Report path must be absolute");
  const requested = path.resolve(reportPath);
  const parent = ensurePrivateDirectory(path.dirname(requested), "Report directory");
  const journalDirectory = `${requested}.journal`;
  const journalRoot = fs.realpathSync(journalDirectory);
  const journalStat = fs.lstatSync(journalRoot);
  if (journalRoot !== path.resolve(journalDirectory) || !journalStat.isDirectory() || journalStat.isSymbolicLink()
    || (journalStat.mode & 0o077) !== 0
    || (typeof process.getuid === "function" && journalStat.uid !== process.getuid())) {
    fail("Report journal is not private and canonical");
  }
  let allNames = fs.readdirSync(journalRoot).sort();
  for (const name of allNames.filter((entry) => !entry.startsWith("."))) {
    recoverAtomicExclusivePublication(path.join(journalRoot, name), {
      uid: typeof process.getuid === "function" ? process.getuid() : 0,
      gid: typeof process.getgid === "function" ? process.getgid() : 0,
      mode: 0o600,
    });
  }
  allNames = fs.readdirSync(journalRoot).sort();
  const names = allNames.filter((name) => !name.startsWith("."));
  const entries = [];
  let partialTerminalPath = null;
  let partialIntentPath = null;
  for (let index = 0; index < names.length; index += 1) {
    const name = names[index];
    if (!new RegExp(`^${String(index).padStart(4, "0")}-[a-z0-9-]+\\.json$`).test(name)) {
      fail("Report journal sequence is incomplete");
    }
    try {
      entries.push(readPrivateJson(path.join(journalRoot, name), "Report journal", MAX_PLAN_BYTES).value);
    } catch (error) {
      if (index !== names.length - 1) throw error;
      if (name.endsWith("-terminal-result.json")) partialTerminalPath = path.join(journalRoot, name);
      else if (preparedReport && name.endsWith("-terminal-result-intent.json")) {
        partialIntentPath = path.join(journalRoot, name);
      } else throw error;
    }
  }
  let terminalIntent = entries.at(-1)?.phase === "TERMINAL_RESULT_INTENT" ? entries.at(-1) : null;
  if (!terminalIntent && preparedReport) {
    const terminalSequence = entries.length;
    const intentName = `${String(terminalSequence).padStart(4, "0")}-terminal-result-intent.json`;
    const intentPath = path.join(journalRoot, intentName);
    const hiddenNames = allNames.filter((name) => name.startsWith("."));
    const orphanPattern = new RegExp(`^\\.${intentName.replace(/[.*+?^${}()|[\\]\\]/g, "\\$&")}\\.[^.]+\\.[^.]+\\.tmp$`);
    const orphanNames = hiddenNames.filter((name) => orphanPattern.test(name));
    if ((partialIntentPath && partialIntentPath !== intentPath) || partialTerminalPath
      || orphanNames.length > 1 || hiddenNames.length !== orphanNames.length) {
      fail("Report journal terminal intent cannot be resumed uniquely");
    }
    for (const candidate of [partialIntentPath, ...orphanNames.map((name) => path.join(journalRoot, name))].filter(Boolean)) {
      const candidateStat = fs.lstatSync(candidate);
      if (!candidateStat.isFile() || candidateStat.isSymbolicLink() || candidateStat.nlink !== 1
        || (candidateStat.mode & 0o077) !== 0
        || (typeof process.getuid === "function" && candidateStat.uid !== process.getuid())) {
        fail("Report journal terminal intent artifact is not private");
      }
      fs.unlinkSync(candidate);
    }
    if (partialIntentPath || orphanNames.length > 0) syncDirectory(journalRoot);
    const attemptId = entries[0]?.attemptId;
    if (!attemptId || entries.length < 1 || entries.some((entry, index) => entry?.formatVersion !== 1
      || entry?.attemptId !== attemptId || entry?.mode !== String(mode || "").toUpperCase() || entry?.sequence !== index)
      || entries.some((entry) => new Set(["TERMINAL_RESULT_INTENT", "TERMINAL_RESULT"]).has(entry?.phase))) {
      fail("Report journal preterminal state cannot accept a prepared report");
    }
    const reportBytes = Buffer.from(`${JSON.stringify(preparedReport, null, 2)}\n`);
    if (expectedReportSha256 !== null && sha256(reportBytes) !== expectedReportSha256) {
      fail("Prepared terminal report digest mismatch");
    }
    terminalIntent = {
      formatVersion: 1,
      attemptId,
      mode: String(mode || "").toUpperCase(),
      sequence: terminalSequence,
      at: new Date().toISOString(),
      phase: "TERMINAL_RESULT_INTENT",
      state: preparedReport.state || null,
      outcome: preparedReport.outcome || preparedReport.state || null,
      mutationAttempted: preparedReport.mutationAttempted === true,
      reportSha256: sha256(reportBytes),
      reportBytesBase64: reportBytes.toString("base64"),
      report: preparedReport,
    };
    writeFileExclusiveAtomicDurable(intentPath, Buffer.from(canonicalJson(terminalIntent)), {
      uid: typeof process.getuid === "function" ? process.getuid() : 0,
      gid: typeof process.getgid === "function" ? process.getgid() : 0,
      mode: 0o600,
    });
    entries.push(terminalIntent);
    allNames = fs.readdirSync(journalRoot).sort();
  }
  if (terminalIntent) {
    const terminalSequence = terminalIntent.sequence + 1;
    const terminalName = `${String(terminalSequence).padStart(4, "0")}-terminal-result.json`;
    const terminalPath = path.join(journalRoot, terminalName);
    const orphanPattern = new RegExp(`^\\.${terminalName.replace(/[.*+?^${}()|[\\]\\]/g, "\\$&")}\\.[^.]+\\.[^.]+\\.tmp$`);
    const orphanNames = allNames.filter((name) => orphanPattern.test(name));
    const hiddenNames = allNames.filter((name) => name.startsWith("."));
    if ((partialTerminalPath && partialTerminalPath !== terminalPath) || orphanNames.length > 1
      || hiddenNames.length !== orphanNames.length) {
      fail("Report journal terminal publication cannot be reconciled uniquely");
    }
    if (partialTerminalPath) {
      const partialStat = fs.lstatSync(partialTerminalPath);
      if (!partialStat.isFile() || partialStat.isSymbolicLink() || partialStat.nlink !== 1
        || (partialStat.mode & 0o077) !== 0
        || (typeof process.getuid === "function" && partialStat.uid !== process.getuid())) {
        fail("Report journal partial terminal is not private");
      }
      fs.unlinkSync(partialTerminalPath);
    }
    for (const orphanName of orphanNames) {
      const orphanPath = path.join(journalRoot, orphanName);
      const orphanStat = fs.lstatSync(orphanPath);
      if (!orphanStat.isFile() || orphanStat.isSymbolicLink() || orphanStat.nlink !== 1
        || (orphanStat.mode & 0o077) !== 0
        || (typeof process.getuid === "function" && orphanStat.uid !== process.getuid())) {
        fail("Report journal terminal temporary is not private");
      }
      fs.unlinkSync(orphanPath);
    }
    if (partialTerminalPath || orphanNames.length > 0) syncDirectory(journalRoot);
    const terminal = {
      ...terminalIntent,
      sequence: terminalSequence,
      phase: "TERMINAL_RESULT",
    };
    writeFileExclusiveAtomicDurable(terminalPath, Buffer.from(canonicalJson(terminal)), {
      uid: typeof process.getuid === "function" ? process.getuid() : 0,
      gid: typeof process.getgid === "function" ? process.getgid() : 0,
      mode: 0o600,
    });
    entries.push(terminal);
  }
  const attemptId = entries[0]?.attemptId;
  const terminal = entries.at(-1);
  if (!attemptId || entries.length < 2 || entries.some((entry, index) => entry?.formatVersion !== 1
    || entry?.attemptId !== attemptId || entry?.mode !== String(mode || "").toUpperCase() || entry?.sequence !== index)
    || entries.filter((entry) => entry?.phase === "TERMINAL_RESULT_INTENT").length !== 1
    || entries.at(-2)?.phase !== "TERMINAL_RESULT_INTENT"
    || entries.filter((entry) => entry?.phase === "TERMINAL_RESULT").length !== 1
    || terminal?.phase !== "TERMINAL_RESULT" || !terminal?.report || typeof terminal.report !== "object") {
    fail("Report journal lacks one exact terminal result");
  }
  const intent = entries.at(-2);
  if (intent.reportSha256 !== terminal.reportSha256
    || intent.reportBytesBase64 !== terminal.reportBytesBase64
    || canonicalJson(intent.report) !== canonicalJson(terminal.report)) {
    fail("Report journal terminal result differs from its durable intent");
  }
  const decodedReportBytes = typeof terminal.reportBytesBase64 === "string"
    ? Buffer.from(terminal.reportBytesBase64, "base64") : null;
  const fallbackCandidates = [
    Buffer.from(`${JSON.stringify(terminal.report, null, 2)}\n`),
    Buffer.from(canonicalJson(terminal.report)),
  ];
  const reportBytes = decodedReportBytes && decodedReportBytes.toString("base64") === terminal.reportBytesBase64
    ? decodedReportBytes
    : fallbackCandidates.find((candidate) => sha256(candidate) === terminal.reportSha256);
  if (!reportBytes) fail("Terminal report bytes cannot be reconstructed from the journal");
  let decodedReport;
  try { decodedReport = JSON.parse(reportBytes.toString("utf8")); } catch { fail("Terminal report bytes are invalid"); }
  if (canonicalJson(decodedReport) !== canonicalJson(terminal.report)) {
    fail("Terminal report bytes differ from the embedded journal report");
  }
  const reportSha256 = sha256(reportBytes);
  if (terminal.reportSha256 !== reportSha256
    || (expectedReportSha256 !== null && expectedReportSha256 !== reportSha256)) {
    fail("Terminal report digest does not match the journal");
  }
  recoverAtomicExclusivePublication(requested, {
    uid: typeof process.getuid === "function" ? process.getuid() : 0,
    gid: typeof process.getgid === "function" ? process.getgid() : 0,
    mode: 0o600,
  });
  if (fs.existsSync(requested)) {
    const stat = fs.lstatSync(requested);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1 || (stat.mode & 0o077) !== 0
      || (typeof process.getuid === "function" && stat.uid !== process.getuid()) || stat.size > reportBytes.length) {
      fail("Terminal report output is not private or recoverable");
    }
    const existing = fs.readFileSync(requested);
    if (!existing.equals(reportBytes)) {
      if (existing.length >= reportBytes.length || !reportBytes.subarray(0, existing.length).equals(existing)) {
        fail("Terminal report output differs from its journal");
      }
      fs.unlinkSync(requested);
      syncDirectory(parent);
    }
  }
  if (!fs.existsSync(requested)) {
    writeFileExclusiveAtomicDurable(requested, reportBytes, {
      uid: typeof process.getuid === "function" ? process.getuid() : 0,
      gid: typeof process.getgid === "function" ? process.getgid() : 0,
      mode: 0o600,
    });
  }
  const readback = readPrivateBytes(requested, "Recovered terminal report", Math.max(reportBytes.length + 1, 1024));
  if (!readback.equals(reportBytes)) fail("Recovered terminal report readback mismatch");
  return { attemptId, journalDirectory, terminal, report: terminal.report, bytes: readback, sha256: reportSha256 };
}

export function createDurableReportJournal(reportPath, mode, attemptId = crypto.randomUUID()) {
  if (!path.isAbsolute(String(reportPath || ""))) fail("Report path must be absolute");
  const requested = path.resolve(reportPath);
  const parent = ensurePrivateDirectory(path.dirname(requested), "Report directory");
  const journalDirectory = `${requested}.journal`;
  if (fs.existsSync(requested) || fs.existsSync(journalDirectory)) fail("Report and journal paths must not already exist");
  fs.mkdirSync(journalDirectory, { mode: 0o700 });
  fs.chmodSync(journalDirectory, 0o700);
  syncDirectory(parent);
  let sequence = 0;
  let closed = false;
  const append = (phase, detail = {}) => {
    if (closed) fail("Migration report journal is already finalized");
    const entry = { formatVersion: 1, attemptId, mode: mode.toUpperCase(), sequence, at: new Date().toISOString(), phase, ...detail };
    const fileName = `${String(sequence).padStart(4, "0")}-${String(phase).toLowerCase().replace(/[^a-z0-9]+/g, "-")}.json`;
    writeFileExclusiveAtomicDurable(path.join(journalDirectory, fileName), Buffer.from(canonicalJson(entry)), {
      uid: typeof process.getuid === "function" ? process.getuid() : 0,
      gid: typeof process.getgid === "function" ? process.getgid() : 0,
      mode: 0o600,
    });
    sequence += 1;
    return entry;
  };
  append("ATTEMPT_STARTED");
  return {
    attemptId,
    journalDirectory,
    append,
    finalize(value) {
      const reportBytes = Buffer.from(`${JSON.stringify(value, null, 2)}\n`);
      const terminalDetail = {
        state: value.state || null,
        outcome: value.outcome || value.state || null,
        mutationAttempted: value.mutationAttempted === true,
        reportSha256: sha256(reportBytes),
        reportBytesBase64: reportBytes.toString("base64"),
        report: value,
      };
      append("TERMINAL_RESULT_INTENT", terminalDetail);
      append("TERMINAL_RESULT", terminalDetail);
      closed = true;
      writeFileExclusiveAtomicDurable(requested, reportBytes, {
        uid: typeof process.getuid === "function" ? process.getuid() : 0,
        gid: typeof process.getgid === "function" ? process.getgid() : 0,
        mode: 0o600,
      });
    },
  };
}

function writePrivateEjson(filePath, value, validator) {
  const body = Buffer.from(`${BSON.EJSON.stringify(value, null, 2, { relaxed: false })}\n`);
  const digest = writeDurableExclusive(filePath, body);
  const readback = readPrivateEjson(filePath, "Migration backup readback", MAX_BACKUP_BYTES);
  if (sha256(readback.bytes) !== digest) fail("Migration backup durable digest mismatch");
  validator(readback.value);
  return { path: filePath, sha256: digest };
}

export function readFlowConnection(flowPath, expectedRuntimeFlowSha256) {
  const bytes = readPrivateBytes(flowPath, "Node-RED flow", 256 * 1024 * 1024);
  if (sha256(bytes) !== expectedRuntimeFlowSha256) fail("Node-RED flow digest differs from the expected runtime flow");
  let flow;
  try { flow = JSON.parse(bytes.toString("utf8")); } catch { fail("Node-RED flow must contain valid JSON"); }
  const configs = Array.isArray(flow) ? flow.filter((node) => node?.id === MONGO_CONFIG_ID) : [];
  if (configs.length !== 1 || configs[0].dbName !== "games" || typeof configs[0].uri !== "string" || !configs[0].uri.trim()) {
    fail("Node-RED games Mongo binding mismatch");
  }
  return { uri: configs[0].uri.trim(), dbName: "games", connectionFingerprint: sha256(configs[0].uri.trim()) };
}

export function readPrivateMongoConnection(filePath, expectedFingerprint) {
  const { value } = readPrivateJson(filePath, "Migration Mongo connection", MAX_CONNECTION_BYTES);
  if (!isObject(value) || value.formatVersion !== 1
    || value.kind !== "viva-game-projection-migration-mongo-connection"
    || typeof value.uri !== "string" || !value.uri.trim()
    || !Array.isArray(value.authenticationRestrictions)
    || sha256(value.uri.trim()) !== expectedFingerprint) {
    fail("Migration Mongo connection file does not match the pinned principal");
  }
  return {
    uri: value.uri.trim(),
    dbName: "games",
    connectionFingerprint: expectedFingerprint,
    authenticationRestrictions: normalizeMongoAuthenticationRestrictions(value.authenticationRestrictions),
  };
}

function assertManifestEntry(manifest, packetRoot, absolutePath, expectedSha256, expectedRelativePath) {
  const resolved = path.resolve(absolutePath);
  if (!isWithin(packetRoot, resolved)) fail("Cutover input is outside the pinned packet");
  const relative = path.relative(packetRoot, resolved);
  if (expectedRelativePath && relative !== expectedRelativePath) fail("Cutover input path differs from the packet contract");
  const entries = manifest.files.filter((entry) => entry?.path === relative);
  if (entries.length !== 1 || entries[0].sha256 !== expectedSha256) fail("Cutover packet manifest entry mismatch");
}

function validatePacketBinding({ values, planBytes, plan, cutoverPlanBytes, cutoverPlan, manifestBytes, manifest }) {
  const expectedManifestSha256 = values.get("--expected-packet-manifest-sha256");
  const expectedCutoverPlanSha256 = values.get("--expected-cutover-plan-sha256");
  if (sha256(manifestBytes) !== expectedManifestSha256 || sha256(cutoverPlanBytes) !== expectedCutoverPlanSha256) {
    fail("Pinned packet or cutover-plan digest mismatch");
  }
  if (!isObject(manifest) || manifest.formatVersion !== 1
    || manifest.kind !== "viva-game-projection-cutover-packet-manifest"
    || !Array.isArray(manifest.files) || new Set(manifest.files.map((entry) => entry?.path)).size !== manifest.files.length
    || manifest.repository?.commit !== cutoverPlan.repository?.commit
    || manifest.repository?.branch !== cutoverPlan.repository?.branch
    || manifest.sourceFlowSha256 !== cutoverPlan.sourceFlowSha256
    || manifest.candidateSha256 !== cutoverPlan.candidateSha256
    || manifest.state !== cutoverPlan.state) {
    fail("Cutover packet manifest contract mismatch");
  }
  const packetRoot = path.dirname(path.resolve(values.get("--packet-manifest")));
  assertManifestEntry(manifest, packetRoot, values.get("--cutover-plan"), expectedCutoverPlanSha256, "cutover-plan.json");
  assertManifestEntry(manifest, packetRoot, values.get("--plan"), sha256(planBytes));
  assertManifestEntry(manifest, packetRoot, path.join(packetRoot, "source.flow.json"), cutoverPlan.sourceFlowSha256, "source.flow.json");
  assertManifestEntry(manifest, packetRoot, path.join(packetRoot, "candidate.flow.json"), cutoverPlan.candidateSha256, "candidate.flow.json");
  assertManifestEntry(manifest, packetRoot, path.join(packetRoot, "cutover-controls.json"), cutoverPlan.controlsSha256, "cutover-controls.json");
  assertManifestEntry(manifest, packetRoot, path.join(packetRoot, "reviewed-flow.contract.json"), cutoverPlan.reviewedFlowContractSha256, "reviewed-flow.contract.json");
  assertManifestEntry(manifest, packetRoot, path.join(packetRoot, "evidence/external-writer-proof.json"), cutoverPlan.evidence.externalWriterProofSha256, "evidence/external-writer-proof.json");
  assertManifestEntry(manifest, packetRoot, path.join(packetRoot, "evidence/full-backup.manifest.json"), cutoverPlan.evidence.backupManifestSha256, "evidence/full-backup.manifest.json");
  assertManifestEntry(manifest, packetRoot, path.join(packetRoot, "evidence/full-backup.ejson"), cutoverPlan.evidence.backupSha256, "evidence/full-backup.ejson");
  if (plan.scope.tenantKey && cutoverPlan.tenantKeySha256 !== sha256(plan.scope.tenantKey)) fail("Cutover packet tenant binding mismatch");
}

export function validateHeldWriterFence(receipt, {
  sourceFlowSha256,
  candidateSha256,
  tenantKey,
  expectedOperationIds,
  expectedWriterNodeIds,
  writerInventorySha256,
  externalWriterProofSha256,
  fenceTokenSha256,
  lockPath,
  nowMs = Date.now(),
}) {
  if (!isObject(receipt) || receipt.formatVersion !== 1 || receipt.kind !== "viva-game-projection-writer-fence-receipt"
    || receipt.state !== "HELD" || receipt.sourceFlowSha256 !== sourceFlowSha256
    || (candidateSha256 && receipt.candidateSha256 !== candidateSha256)
    || receipt.tenantKey !== tenantKey
    || JSON.stringify([...(receipt.operationIds || [])].sort()) !== JSON.stringify([...(expectedOperationIds || [])].sort())
    || sha256(String(receipt.fenceToken || "")) !== fenceTokenSha256
    || receipt.writerInventorySha256 !== writerInventorySha256
    || receipt.externalWriterProofSha256 !== externalWriterProofSha256
    || receipt.lockPath !== lockPath || receipt.lockPath !== PRODUCTION_LOCK_PATH
    || receipt.host !== "lk-primary-147" || !String(receipt.hostname || "").trim()
    || receipt.processName !== "node-red" || !Number.isSafeInteger(receipt.pm2ProcessId)
    || receipt.nodeRedProcessState !== "STOPPED" || receipt.ingressWriteRoutesBlocked !== true
    || receipt.internalSchedulersStopped !== true || receipt.allLkGamesWritersQuiescent !== true
    || receipt.externalMongoWritersBlocked !== true
    || !Array.isArray(receipt.writerNodeIds) || receipt.writerNodeIds.length === 0
    || new Set(receipt.writerNodeIds).size !== receipt.writerNodeIds.length) {
    fail("Writer fence receipt does not prove a complete held fence");
  }
  if (expectedWriterNodeIds
    && JSON.stringify([...receipt.writerNodeIds].sort()) !== JSON.stringify([...expectedWriterNodeIds].sort())) {
    fail("Writer fence receipt does not cover the cutover writer inventory");
  }
  const observedAt = Date.parse(receipt.observedAt);
  const expiresAt = Date.parse(receipt.expiresAt);
  if (!Number.isFinite(observedAt) || !Number.isFinite(expiresAt)
    || observedAt > nowMs + 60_000 || nowMs - observedAt > 5 * 60_000 || expiresAt - nowMs < 2 * 60_000) {
    fail("Writer fence receipt is stale, expired, or lacks a two-minute execution lease");
  }
  return true;
}

function assertProductionHost(values, cutoverPlan, receipt) {
  if (typeof process.getuid !== "function" || process.getuid() !== 0) fail("Production migration executor requires root");
  if (path.resolve(values.get("--flow-path")) !== PRODUCTION_FLOW_PATH) fail("Production migration requires the canonical live flow path");
  if (os.hostname() !== receipt.hostname || cutoverPlan.production?.hostname !== receipt.hostname
    || cutoverPlan.production?.hostAlias !== "lk-primary-147") fail("Production host identity mismatch");
}

export function assertInheritedFenceLease(receipt) {
  const fd = Number(process.env.PADLHUB_CUTOVER_FENCE_FD);
  const token = String(process.env.PADLHUB_CUTOVER_FENCE_TOKEN || "");
  const lockPath = String(process.env.PADLHUB_CUTOVER_FENCE_LOCK_PATH || "");
  if (!Number.isSafeInteger(fd) || fd < 3 || token !== receipt.fenceToken || lockPath !== receipt.lockPath) {
    fail("Inherited writer-fence lease is absent or does not match the receipt");
  }
  const descriptorStat = fs.fstatSync(fd);
  const lockStat = fs.statSync(lockPath);
  if (!descriptorStat.isFile() || descriptorStat.dev !== lockStat.dev || descriptorStat.ino !== lockStat.ino) {
    fail("Inherited writer-fence descriptor does not bind the lock path");
  }
}

export function assertExclusiveFenceLease(receipt) {
  assertInheritedFenceLease(receipt);
  const lockProbe = spawnSync("flock", ["-n", receipt.lockPath, "-c", "true"], { stdio: "ignore" });
  if (lockProbe.error || lockProbe.status === 0) fail("Writer-fence flock is not held exclusively");
  return true;
}

function assertSystemFenceLease(receipt, cutoverPlan) {
  assertExclusiveFenceLease(receipt);
  const pm2 = spawnSync("pm2", ["jlist"], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] });
  let processes;
  try { processes = JSON.parse(pm2.stdout); } catch { fail("Unable to read live PM2 state under the writer fence"); }
  const matches = Array.isArray(processes) ? processes.filter((item) => item?.name === receipt.processName) : [];
  const processEntry = matches[0];
  if (pm2.status !== 0 || matches.length !== 1 || processEntry?.pm_id !== receipt.pm2ProcessId
    || String(processEntry?.pm2_env?.status || "").toLowerCase() !== "stopped"
    || sha256(String(processEntry?.pm2_env?.PADLHUB_PLATFORM_TENANT_KEY || "")) !== cutoverPlan.tenantKeySha256) {
    fail("Live PM2 process or tenant state no longer matches the held fence");
  }
}

const writeStageNamespace = (stage, defaultDatabase) => {
  if (typeof stage === "string") return `${defaultDatabase}.${stage}`;
  const target = stage?.into ?? stage;
  if (typeof target === "string") return `${defaultDatabase}.${target}`;
  if (!isObject(target)) return "";
  const database = String(target.db || defaultDatabase || "");
  const collection = String(target.coll || "");
  return database && collection ? `${database}.${collection}` : "";
};

export function mongoCurrentOpTouchesLkGames(row) {
  const command = isObject(row?.command) ? row.command : {};
  const database = String(command.$db || "");
  if (["insert", "update", "delete", "findAndModify"].some((name) => command[name] === "lk_games")
    && database === "games") return true;
  if (["createIndexes", "drop", "collMod"].some((name) => command[name] === "lk_games")
    && database === "games") return true;
  if (Object.hasOwn(command, "dropDatabase") && database === "games") return true;
  if (typeof command.renameCollection === "string"
    && [command.renameCollection, command.to].includes("games.lk_games")) return true;
  if (Object.hasOwn(command, "aggregate") && Array.isArray(command.pipeline)) {
    return command.pipeline.some((stage) => (
      Object.hasOwn(stage || {}, "$out") && writeStageNamespace(stage.$out, database) === "games.lk_games"
    ) || (
      Object.hasOwn(stage || {}, "$merge") && writeStageNamespace(stage.$merge, database) === "games.lk_games"
    ));
  }
  return ["insert", "update", "remove"].includes(row?.op) && row?.ns === "games.lk_games";
}

export async function assertNoConcurrentMongoWrites(client) {
  const rows = await client.db("admin").aggregate([{ $currentOp: { allUsers: true, localOps: true } }]).toArray();
  const conflicting = rows.filter(mongoCurrentOpTouchesLkGames);
  if (conflicting.length !== 0) fail("Concurrent games.lk_games writer observed while the fence is held");
}

async function run({ mode, values }, dependencies = {}) {
  const clockNow = () => (typeof dependencies.nowMs === "function" ? dependencies.nowMs() : (dependencies.nowMs ?? Date.now()));
  const expectedPlanSha256 = values.get("--expected-plan-sha256");
  const expectedSourceFlowSha256 = values.get("--expected-source-flow-sha256");
  const expectedRuntimeFlowSha256 = values.get("--expected-runtime-flow-sha256");
  const { bytes: planBytes, value: plan } = readPrivateJson(values.get("--plan"), "Migration plan", MAX_PLAN_BYTES);
  validateExecutableTenantMigrationPlan(plan, {
    expectedPlanSha256,
    planBytes,
    expectedSourceFlowSha256,
    nowMs: clockNow(),
  });
  const cutoverRead = readPrivateJson(values.get("--cutover-plan"), "Cutover plan", MAX_PACKET_BYTES);
  const manifestRead = readPrivateJson(values.get("--packet-manifest"), "Packet manifest", MAX_PACKET_BYTES);
  const cutoverPlan = cutoverRead.value;
  if (!isObject(cutoverPlan) || cutoverPlan.formatVersion !== 1
    || cutoverPlan.kind !== "viva-game-projection-tenant-cutover-plan"
    || cutoverPlan.state !== "READY_FOR_SEPARATE_LIVE_APPROVAL"
    || cutoverPlan.sourceFlowSha256 !== expectedSourceFlowSha256
    || cutoverPlan.tenantKeySha256 !== sha256(plan.scope.tenantKey)
    || !cutoverPlan.migration?.planSha256s?.includes(expectedPlanSha256)
    || !Array.isArray(cutoverPlan.writerFence?.exactWriterNodeIds)
    || cutoverPlan.writerFence.exactWriterNodeIds.length === 0
    || cutoverPlan.liveMutationAuthorized !== false) {
    fail("Cutover plan is not ready or does not bind this migration plan");
  }
  if (dependencies.assertExecutorSources) await dependencies.assertExecutorSources(cutoverPlan);
  else assertExactExecutorSources(cutoverPlan);
  validatePacketBinding({ values, planBytes, plan, cutoverPlanBytes: cutoverRead.bytes, cutoverPlan, manifestBytes: manifestRead.bytes, manifest: manifestRead.value });
  const packetRoot = fs.realpathSync(path.dirname(values.get("--packet-manifest")));
  if (dependencies.validateExactCutoverPacket) await dependencies.validateExactCutoverPacket({ packetRoot, plan: cutoverPlan, manifest: manifestRead.value });
  else validateExactCutoverPacket({ packetRoot, plan: cutoverPlan, manifest: manifestRead.value, nowMs: clockNow() });
  if ((mode === "verify" || mode === "apply" || mode === "reconcile")
    && expectedRuntimeFlowSha256 !== expectedSourceFlowSha256) fail("Verify/apply/reconcile require the frozen source flow to remain active on disk");
  if (new Set(["restore", "reconcile-restore"]).has(mode)
    && ![expectedSourceFlowSha256, cutoverPlan.candidateSha256].includes(expectedRuntimeFlowSha256)) {
    fail("Restore and reconcile-restore runtime flow must be the frozen source or exact candidate");
  }
  const applicationConnection = readFlowConnection(values.get("--flow-path"), expectedRuntimeFlowSha256);
  if (applicationConnection.connectionFingerprint !== cutoverPlan.mongoTarget?.connectionFingerprint) fail("Mongo connection binding differs from the cutover plan");
  const connection = readPrivateMongoConnection(
    values.get("--migration-connection-file"), cutoverPlan.mongoTarget?.migrationConnectionFingerprint,
  );
  const fencePath = values.get("--fence-receipt");
  const fenceExpected = {
    sourceFlowSha256: expectedSourceFlowSha256,
    candidateSha256: cutoverPlan.candidateSha256,
    tenantKey: plan.scope.tenantKey,
    expectedOperationIds: cutoverPlan.writerFence.exactMigrationOperationIds,
    expectedWriterNodeIds: cutoverPlan.writerFence.exactWriterNodeIds,
    writerInventorySha256: cutoverPlan.writerFence.writerInventorySha256,
    externalWriterProofSha256: cutoverPlan.writerFence.externalWriterProofSha256,
    fenceTokenSha256: cutoverPlan.writerFence.fenceTokenSha256,
    lockPath: cutoverPlan.writerFence.lockPath,
  };
  const readFence = (expensive) => {
    const receipt = readPrivateJson(fencePath, "Writer fence receipt", 1024 * 1024).value;
    validateHeldWriterFence(receipt, { ...fenceExpected, nowMs: clockNow() });
    if (expensive && dependencies.assertSystemFenceLease) dependencies.assertSystemFenceLease(receipt, cutoverPlan);
    else if (expensive) {
      assertProductionHost(values, cutoverPlan, receipt);
      assertSystemFenceLease(receipt, cutoverPlan);
    } else if (dependencies.assertCheapFenceLease) dependencies.assertCheapFenceLease(receipt);
    else assertInheritedFenceLease(receipt);
    return receipt;
  };
  readFence(true);
  if (mode === "apply" && process.env.VIVA_GAME_PROJECTION_MIGRATION_APPLY !== APPLY_CONFIRMATION) fail("Apply confirmation is absent");
  if (mode === "restore" && process.env.VIVA_GAME_PROJECTION_MIGRATION_RESTORE !== RESTORE_CONFIRMATION) fail("Restore confirmation is absent");

  const journal = createDurableReportJournal(values.get("--report"), mode, dependencies.attemptId);
  const client = new MongoClient(connection.uri, {
    appName: `PadlHubVivaGameTenantMigration:${mode}`,
    maxPoolSize: 1,
    serverSelectionTimeoutMS: 20_000,
    connectTimeoutMS: 20_000,
    socketTimeoutMS: 20_000,
    timeoutMS: 20_000,
    monitorCommands: true,
  });
  let writeCommandCount = 0;
  let mutationAttempted = false;
  let backupPath = null;
  let backupSha256 = null;
  let phase = "CONNECTING";
  client.on("commandStarted", (event) => { if (WRITE_COMMANDS.has(event.commandName)) writeCommandCount += 1; });
  try {
    await client.connect();
    const hello = await client.db("admin").command({ hello: 1 });
    const mongoTarget = buildMongoTargetIdentity({
      connectionFingerprint: applicationConnection.connectionFingerprint,
      replicaSetName: hello.setName,
      database: "games",
      collection: "lk_games",
    });
    if (mongoTarget.targetIdentitySha256 !== cutoverPlan.mongoTarget?.targetIdentitySha256
      || mongoTarget.replicaSetName !== cutoverPlan.mongoTarget?.replicaSetName) fail("Connected Mongo replica set differs from the pinned cutover target");
    const db = client.db(connection.dbName);
    const collection = db.collection("lk_games");
    const barrierRead = readPrivateJson(values.get("--mongo-write-barrier-receipt"), "Mongo write-barrier receipt", MAX_PACKET_BYTES);
    const barrierReceiptSha256 = sha256(barrierRead.bytes);
    const assertBarrier = async () => {
      const current = readPrivateJson(values.get("--mongo-write-barrier-receipt"), "Mongo write-barrier receipt", MAX_PACKET_BYTES);
      if (sha256(current.bytes) !== barrierReceiptSha256) fail("Mongo write-barrier receipt changed during execution");
      await assertMongoWriteBarrier(client, current.value, {
        fenceTokenSha256: cutoverPlan.writerFence.fenceTokenSha256,
        cutoverPlanSha256: values.get("--expected-cutover-plan-sha256"),
        mongoTargetIdentitySha256: mongoTarget.targetIdentitySha256,
        migrationAuthenticationRestrictions: connection.authenticationRestrictions,
      });
    };
    const assertFenceAndWriters = async () => {
      readFence(true);
      await assertBarrier();
      await assertNoConcurrentMongoWrites(client);
    };
    let watchdogError = null;
    let watchdog = null;
    const startFenceWatchdog = () => {
      watchdog = setInterval(() => {
        try { readFence(true); } catch (error) { watchdogError = error; }
      }, 1000);
      watchdog.unref();
    };
    const stopFenceWatchdog = () => {
      if (watchdog) clearInterval(watchdog);
      watchdog = null;
    };
    const assertTransactionLease = async () => {
      if (watchdogError) throw watchdogError;
      readFence(false);
    };
    await assertFenceAndWriters();
    journal.append("TARGET_AND_FENCE_VERIFIED", { mongoTargetIdentitySha256: mongoTarget.targetIdentitySha256 });

    if (mode === "verify") {
      const backup = await captureTenantMigrationPreimages(collection, plan, expectedPlanSha256, new Date().toISOString());
      await assertFenceAndWriters();
      if (writeCommandCount !== 0) fail("Verify mode attempted a Mongo write command");
      const result = {
        formatVersion: 1, mode: "VERIFY", outcome: "SUCCEEDED", mutationAttempted: false,
        planSha256: expectedPlanSha256, sourceFlowSha256: expectedSourceFlowSha256,
        operationId: plan.scope.operationId, tenantKey: plan.scope.tenantKey,
        eligibleCount: plan.eligibleCount, skipped: plan.skipped, preimageCount: backup.recordCount,
        mongoTargetIdentitySha256: mongoTarget.targetIdentitySha256, writeCommandCount, liveMutationPerformed: false,
      };
      journal.finalize(result);
      return result;
    }

    if (mode === "reconcile" || mode === "reconcile-restore") {
      const backupRead = readPrivateEjson(values.get("--backup"), "Migration backup", MAX_BACKUP_BYTES);
      backupSha256 = sha256(backupRead.bytes);
      if (backupSha256 !== values.get("--expected-backup-sha256")) fail("Reconcile backup digest mismatch");
      let reconciliation;
      if (mode === "reconcile-restore") {
        const applyReportRead = readPrivateJson(values.get("--apply-receipt"), "Apply report", MAX_PACKET_BYTES);
        const applyReportSha256 = sha256(applyReportRead.bytes);
        if (applyReportSha256 !== values.get("--expected-apply-report-sha256")
          || applyReportRead.value?.backupSha256 !== backupSha256) fail("Restore reconciliation apply-report binding mismatch");
        validateApplyReceipt(applyReportRead.value?.applyReceipt, plan, expectedPlanSha256);
        reconciliation = await reconcileTenantRestoreOutcome(
          collection,
          plan,
          expectedPlanSha256,
          backupRead.value,
          applyReportRead.value.applyReceipt,
          new Date().toISOString(),
        );
      } else {
        reconciliation = await reconcileTenantMigrationOutcome(collection, plan, expectedPlanSha256, backupRead.value);
      }
      await assertFenceAndWriters();
      if (writeCommandCount !== 0) fail("Reconciliation mode attempted a Mongo write command");
      const result = {
        formatVersion: 1, mode: mode.toUpperCase(), outcome: reconciliation.outcome, mutationAttempted: false,
        planSha256: expectedPlanSha256, sourceFlowSha256: expectedSourceFlowSha256,
        operationId: plan.scope.operationId, backupPath: values.get("--backup"), backupSha256,
        mongoTargetIdentitySha256: mongoTarget.targetIdentitySha256, writeCommandCount,
        applyReceipt: reconciliation.applyReceipt,
        restoreReceipt: reconciliation.restoreReceipt,
        counts: { preimage: reconciliation.preimageCount, postimage: reconciliation.postimageCount, drift: reconciliation.driftCount },
      };
      journal.finalize(result);
      return result;
    }

    const session = client.startSession();
    try {
      if (mode === "apply") {
        const backupDir = ensurePrivateDirectory(values.get("--backup-dir"), "Backup directory");
        const capturedAt = new Date().toISOString();
        const backup = await captureTenantMigrationPreimages(collection, plan, expectedPlanSha256, capturedAt);
        backupPath = path.join(backupDir, `viva-tenant-migration-${expectedPlanSha256}-${Date.now()}.ejson`);
        backupSha256 = writePrivateEjson(backupPath, backup, (readback) => validateMigrationBackup(readback, plan, expectedPlanSha256)).sha256;
        journal.append("BACKUP_DURABLE", { backupPath, backupSha256, recordCount: backup.recordCount });
        await assertFenceAndWriters();
        phase = "TRANSACTION_OUTCOME_UNKNOWN";
        journal.append(phase, { backupPath, backupSha256, mutationAttempted: true });
        mutationAttempted = true;
        let applyReceipt;
        startFenceWatchdog();
        try {
          await session.withTransaction(async () => {
            await assertTransactionLease();
            const transactionCollection = db.collection("lk_games");
            const currentBackup = await captureTenantMigrationPreimages(
              { findOne: (filter) => transactionCollection.findOne(filter, { session }) }, plan, expectedPlanSha256, capturedAt,
            );
            validateMigrationBackup(currentBackup, plan, expectedPlanSha256);
            if (BSON.EJSON.stringify(currentBackup.records, null, 0, { relaxed: false })
              !== BSON.EJSON.stringify(backup.records, null, 0, { relaxed: false })) fail("Migration preimage drifted after durable backup capture");
            applyReceipt = await applyTenantMigrationPlan({
              updateOne: (filter, update, options) => transactionCollection.updateOne(filter, update, {
                ...options, session, bypassDocumentValidation: true, maxTimeMS: 15_000,
              }),
              findOne: (filter) => transactionCollection.findOne(filter, { session }),
            }, plan, expectedPlanSha256, plan.operations[0].update.$set.updatedAt, assertTransactionLease);
          }, { readConcern: { level: "snapshot" }, writeConcern: { w: "majority" }, maxCommitTimeMS: 15_000 });
          if (watchdogError) throw watchdogError;
        } finally {
          stopFenceWatchdog();
        }
        await assertFenceAndWriters();
        phase = "TRANSACTION_COMMITTED";
        journal.append(phase, { backupPath, backupSha256, applyReceiptSha256: sha256(canonicalJson(applyReceipt)) });
        const result = {
          formatVersion: 1, mode: "APPLY", outcome: "SUCCEEDED", mutationAttempted,
          planSha256: expectedPlanSha256, sourceFlowSha256: expectedSourceFlowSha256,
          operationId: plan.scope.operationId, backupPath, backupSha256,
          mongoTargetIdentitySha256: mongoTarget.targetIdentitySha256, applyReceipt,
        };
        journal.finalize(result);
        return result;
      }

      const backupRead = readPrivateEjson(values.get("--backup"), "Migration backup", MAX_BACKUP_BYTES);
      const applyReportRead = readPrivateJson(values.get("--apply-receipt"), "Apply report", MAX_PACKET_BYTES);
      const backup = backupRead.value;
      const applyReport = applyReportRead.value;
      backupPath = values.get("--backup");
      backupSha256 = sha256(backupRead.bytes);
      const actualApplyReportSha256 = sha256(applyReportRead.bytes);
      if (backupSha256 !== values.get("--expected-backup-sha256")
        || actualApplyReportSha256 !== values.get("--expected-apply-report-sha256")
        || applyReport?.backupSha256 !== backupSha256) fail("Restore backup/apply report digest confirmation mismatch");
      const applyReceipt = applyReport?.applyReceipt;
      validateMigrationBackup(backup, plan, expectedPlanSha256);
      validateApplyReceipt(applyReceipt, plan, expectedPlanSha256);
      await assertFenceAndWriters();
      phase = "RESTORE_TRANSACTION_OUTCOME_UNKNOWN";
      journal.append(phase, { backupPath, backupSha256, mutationAttempted: true });
      mutationAttempted = true;
      let restoreReceipt;
      startFenceWatchdog();
      try {
        await session.withTransaction(async () => {
          await assertTransactionLease();
          const transactionCollection = db.collection("lk_games");
          restoreReceipt = await restoreTenantMigrationBackup({
              replaceOne: (filter, replacement, options) => transactionCollection.replaceOne(filter, replacement, {
                ...options, session, bypassDocumentValidation: true, maxTimeMS: 15_000,
              }),
            findOne: (filter) => transactionCollection.findOne(filter, { session }),
          }, plan, expectedPlanSha256, backup, applyReceipt, assertTransactionLease);
        }, { readConcern: { level: "snapshot" }, writeConcern: { w: "majority" }, maxCommitTimeMS: 15_000 });
        if (watchdogError) throw watchdogError;
      } finally {
        stopFenceWatchdog();
      }
      await assertFenceAndWriters();
      phase = "RESTORE_TRANSACTION_COMMITTED";
      journal.append(phase, { restoredCount: restoreReceipt.restoredCount });
      const result = {
        formatVersion: 1, mode: "RESTORE", outcome: "SUCCEEDED", mutationAttempted,
        planSha256: expectedPlanSha256, sourceFlowSha256: expectedSourceFlowSha256,
        operationId: plan.scope.operationId, backupPath, backupSha256,
        mongoTargetIdentitySha256: mongoTarget.targetIdentitySha256, restoreReceipt,
      };
      journal.finalize(result);
      return result;
    } finally {
      await session.endSession();
    }
  } catch (error) {
    const result = {
      formatVersion: 1, mode: mode.toUpperCase(),
      outcome: mutationAttempted ? "UNKNOWN_RECONCILIATION_REQUIRED" : "FAILED_NO_MUTATION",
      mutationAttempted, phase, planSha256: expectedPlanSha256,
      sourceFlowSha256: expectedSourceFlowSha256, backupPath, backupSha256, error: safeError(error),
    };
    try { journal.append("EXECUTION_FAILED", result); journal.finalize(result); } catch { /* prior durable entries remain */ }
    throw Object.assign(new Error(result.error), { migrationResult: result });
  } finally {
    await client.close().catch(() => {});
  }
}

export async function main(argv = process.argv.slice(2), dependencies = {}) {
  const result = await run(parseArgs(argv), dependencies);
  process.stdout.write(`${JSON.stringify({
    mode: result.mode,
    outcome: result.outcome,
    planSha256: result.planSha256,
    operationId: result.operationId,
    liveMutationPerformed: ["APPLY", "RESTORE"].includes(result.mode) && result.outcome === "SUCCEEDED",
  })}\n`);
  return result;
}

if (process.argv[1] && fs.realpathSync(process.argv[1]) === SCRIPT_PATH) {
  if (process.argv.slice(2).includes("--help")) {
    process.stdout.write(`Usage:\n  scripts/run_viva_game_projection_fenced_migration.sh --mode verify|apply|restore|reconcile|reconcile-restore --plan /private/packet/migration-plans/NN-plan.json --cutover-plan /private/packet/cutover-plan.json --packet-manifest /private/packet/packet.manifest.json --expected-plan-sha256 <sha256> --expected-cutover-plan-sha256 <sha256> --expected-packet-manifest-sha256 <sha256> --expected-source-flow-sha256 <sha256> --expected-runtime-flow-sha256 <sha256> --flow-path /root/.node-red/flows.json --fence-receipt /private/fence.json --report /private/new-report.json [--backup-dir /private/backups] [--backup /private/backup.ejson --expected-backup-sha256 <sha256>] [--apply-receipt /private/apply-report.json --expected-apply-report-sha256 <sha256>]\n\nverify, reconcile, and reconcile-restore are read-only. apply and restore are live MongoDB mutations and require separate authorization plus their exact environment confirmation phrase. All modes require the host-side flock wrapper and a stopped Node-RED process.\n`);
  } else {
    main().catch((error) => {
      process.stderr.write(`${safeError(error)}\n`);
      process.exitCode = 1;
    });
  }
}
