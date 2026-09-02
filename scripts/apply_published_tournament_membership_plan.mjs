#!/usr/bin/env node
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { BSON, MongoClient } from "mongodb";
import {
  buildCommunityRestoreReplacement,
  buildTimeForAtomicMembershipMutation,
  PUBLISHED_TOURNAMENT_JOIN_SOURCE,
} from "./lib/publishedTournamentMembershipPlan.mjs";

const DEFAULT_MAX_PLAN_AGE_MINUTES = 15;
const WRITE_COMMANDS = new Set(["insert", "update", "delete", "findAndModify", "createIndexes", "drop", "dropDatabase", "renameCollection"]);
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

const asArray = (value) => (Array.isArray(value) ? value : []);
const isObject = (value) => Boolean(value) && typeof value === "object" && !Array.isArray(value);
const toStringOrNull = (value) => {
  if (value === null || value === undefined) return null;
  const normalized = String(value).trim();
  return normalized || null;
};
const normalizePhone = (value) => {
  const digits = String(value || "").replace(/\D/g, "");
  if (!digits) return null;
  if (digits.length === 10) return `7${digits}`;
  if (digits.length === 11 && digits.startsWith("8")) return `7${digits.slice(1)}`;
  return digits;
};
const canonicalize = (value) => {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (!isObject(value)) return value;
  return Object.fromEntries(Object.keys(value).sort().map((key) => [key, canonicalize(value[key])]));
};
const sha256 = (value) => crypto.createHash("sha256")
  .update(typeof value === "string" ? value : JSON.stringify(canonicalize(value)))
  .digest("hex");

export function hashFrozenPlan(fullPlan) {
  if (!isObject(fullPlan)) throw new Error("Plan must be an object");
  const planCore = { ...fullPlan };
  delete planCore.observedAt;
  delete planCore.planSha256;
  return sha256(planCore);
}

function memberIdentity(member) {
  return {
    ids: [member?.id, member?.clientId, member?.playerId, member?.userId].map(toStringOrNull).filter(Boolean),
    phones: [member?.phoneNorm, member?.phone, member?.phoneNumber, member?.mobile].map(normalizePhone).filter(Boolean),
  };
}

function memberMatchesOperation(member, operation) {
  const identity = memberIdentity(member);
  return identity.ids.includes(operation.playerId)
    || Boolean(operation.phoneNorm && identity.phones.includes(operation.phoneNorm));
}

function hasPhoneOnlyIdentity(member) {
  const identity = memberIdentity(member);
  return identity.ids.length === 0 && identity.phones.length > 0;
}

export function hashCommunityPreimage(communities) {
  return sha256(asArray(communities).map((row) => ({
    id: row.id,
    archived: row.archived,
    updatedAt: row.updatedAt,
    members: asArray(row.members).map((member) => [
      toStringOrNull(member?.id ?? member?.clientId ?? member?.playerId ?? member?.userId),
      normalizePhone(member?.phoneNorm ?? member?.phone ?? member?.phoneNumber ?? member?.mobile),
    ]),
    banned: asArray(row.bannedMembers).map((member) => [
      toStringOrNull(member?.id ?? member?.clientId ?? member?.playerId ?? member?.userId),
      normalizePhone(member?.phoneNorm ?? member?.phone ?? member?.phoneNumber ?? member?.mobile),
    ]),
  })));
}

export function validateFrozenPlan(plan, nowMs = Date.now(), maxAgeMinutes = DEFAULT_MAX_PLAN_AGE_MINUTES) {
  if (!isObject(plan)) throw new Error("Plan must be an object");
  if (plan.version !== "published-tournament-community-membership-plan-v4") {
    throw new Error("Unsupported plan version");
  }
  const actualSha = hashFrozenPlan(plan);
  if (!/^[0-9a-f]{64}$/.test(String(plan.planSha256 || "")) || plan.planSha256 !== actualSha) {
    throw new Error("Plan SHA does not match canonical plan content");
  }
  if (!Number.isFinite(maxAgeMinutes) || maxAgeMinutes <= 0) throw new Error("Plan freshness window is invalid");
  const observedAtMs = Date.parse(String(plan.observedAt || ""));
  if (!Number.isFinite(observedAtMs)) throw new Error("Plan observedAt is invalid");
  const ageMs = nowMs - observedAtMs;
  if (ageMs < -60_000 || ageMs > maxAgeMinutes * 60_000) {
    throw new Error(`Plan is outside the ${maxAgeMinutes}-minute freshness window`);
  }
  if (!isObject(plan.sourceFingerprint) || !/^[0-9a-f]{64}$/.test(String(plan.sourceFingerprint.community || ""))) {
    throw new Error("Plan community preimage fingerprint is missing");
  }
  if (asArray(plan.quarantined).length !== 0) throw new Error("Plan contains quarantined rows");
  if (asArray(plan.operations).length === 0) throw new Error("Plan contains no membership operations");
  const allowedCommunities = new Set(asArray(plan.communities).map((row) => toStringOrNull(row?.communityId)).filter(Boolean));
  if (allowedCommunities.size !== asArray(plan.communities).length) throw new Error("Plan communities are invalid or duplicated");
  const operationIds = new Set();
  const membershipKeys = new Set();
  for (const operation of plan.operations) {
    const communityId = toStringOrNull(operation?.communityId);
    const playerId = toStringOrNull(operation?.playerId);
    const stationId = toStringOrNull(operation?.stationId);
    const operationId = toStringOrNull(operation?.operationId);
    if (!communityId || !allowedCommunities.has(communityId)) throw new Error("Operation references an unapproved community");
    if (!playerId || !UUID_RE.test(playerId) || !stationId || stationId !== plan.stationId) {
      throw new Error("Operation identity or station is invalid");
    }
    if (operation.phoneNorm && normalizePhone(operation.phoneNorm) !== operation.phoneNorm) {
      throw new Error("Operation phone identity is not normalized");
    }
    if (!operationId) throw new Error("Operation id is missing");
    const expectedOperationId = `published-tournament:${sha256(`${communityId}|${playerId}`).slice(0, 32)}`;
    if (operationId !== expectedOperationId) throw new Error("Operation id is not deterministic for community/player");
    const membershipKey = `${communityId}|${playerId}`;
    if (operationIds.has(operationId) || membershipKeys.has(membershipKey)) throw new Error("Plan contains duplicate operations");
    operationIds.add(operationId);
    membershipKeys.add(membershipKey);
    if (asArray(operation.tournamentIds).length === 0 || asArray(operation.publicationIds).length === 0) {
      throw new Error("Operation lacks tournament/publication evidence");
    }
  }
  return { actualSha, observedAtMs, ageMs, operationCount: plan.operations.length, allowedCommunities };
}

export function validateCurrentMembershipPreconditions(plan, communities) {
  const byId = new Map(asArray(communities).map((row) => [row.id, row]));
  if (byId.size !== asArray(plan.communities).length) throw new Error("Current target community set is incomplete");
  if (hashCommunityPreimage(communities) !== plan.sourceFingerprint.community) {
    throw new Error("Community membership preimage drifted after plan generation");
  }
  for (const operation of plan.operations) {
    const community = byId.get(operation.communityId);
    if (!community || community.archived === true) throw new Error("Target community is missing or archived");
    if (Number(community.memberCount) !== asArray(community.members).length) {
      throw new Error("Target community memberCount is inconsistent");
    }
    if (asArray(community.bannedMembers).some((member) => memberMatchesOperation(member, operation))) {
      throw new Error("Planned player is banned from target community");
    }
    if (asArray(community.members).some((member) => memberMatchesOperation(member, operation))) {
      throw new Error("Planned player already belongs to target community");
    }
    if (!operation.phoneNorm
      && [...asArray(community.members), ...asArray(community.bannedMembers)].some(hasPhoneOnlyIdentity)) {
      throw new Error("Target community contains unresolved phone-only identities");
    }
  }
  return { communityCount: byId.size, operationCount: plan.operations.length };
}

export function validateRestoreBackup(plan, backup) {
  if (backup?.version !== "published-tournament-community-membership-backup-v1"
    || backup?.planSha256 !== plan.planSha256
    || !Array.isArray(backup?.communities)) {
    throw new Error("Backup does not match the frozen plan");
  }
  if (!Number.isFinite(Date.parse(String(backup.appliedAt || "")))) {
    throw new Error("Backup appliedAt is invalid");
  }
  const expectedProvenanceVersion = `${plan.version}:${plan.planSha256}`;
  if (backup.provenanceVersion !== expectedProvenanceVersion) {
    throw new Error("Backup provenance does not match the frozen plan");
  }
  const expectedCommunityIds = asArray(plan.communities)
    .map((row) => toStringOrNull(row?.communityId))
    .sort();
  const backupCommunityIds = backup.communities
    .map((row) => toStringOrNull(row?.id))
    .sort();
  if (backupCommunityIds.some((id) => !id)
    || new Set(backupCommunityIds).size !== backupCommunityIds.length
    || JSON.stringify(backupCommunityIds) !== JSON.stringify(expectedCommunityIds)) {
    throw new Error("Backup community set does not match the frozen plan");
  }
  const actualPreimageSha = hashCommunityPreimage(backup.communities);
  if (backup.communityPreimageSha256 !== actualPreimageSha
    || actualPreimageSha !== plan.sourceFingerprint.community) {
    throw new Error("Backup community preimage does not match the frozen plan");
  }
  return {
    appliedAt: backup.appliedAt,
    communityCount: backup.communities.length,
    communityPreimageSha256: actualPreimageSha,
    provenanceVersion: backup.provenanceVersion,
  };
}

function parseArgs(argv) {
  const flags = new Set();
  const values = new Map();
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (!arg.startsWith("--")) throw new Error(`Unexpected argument: ${arg}`);
    if (["--apply", "--restore"].includes(arg)) {
      flags.add(arg);
      continue;
    }
    const value = argv[index + 1];
    if (!value || value.startsWith("--")) throw new Error(`${arg} requires a value`);
    values.set(arg, value);
    index += 1;
  }
  return { flags, values };
}

function readMongoUri(values) {
  const direct = process.env.MONGO_URI || process.env.MONGODB_URI;
  if (direct) return direct;
  const flowFile = toStringOrNull(values.get("--flow-file"));
  if (!flowFile || !path.isAbsolute(flowFile)) throw new Error("MONGO_URI or an absolute --flow-file is required");
  const flow = JSON.parse(fs.readFileSync(flowFile, "utf8"));
  const exact = asArray(flow).find((row) => row?.type === "mongodb4-client"
    && typeof row.uri === "string" && row.uri.includes("/games"));
  if (!exact?.uri) throw new Error("Mongo URI was not found in the supplied flow file");
  return exact.uri;
}

function assertPrivateFile(filePath, label) {
  if (!path.isAbsolute(filePath)) throw new Error(`${label} path must be absolute`);
  const stats = fs.statSync(filePath);
  if (!stats.isFile()) throw new Error(`${label} must be a file`);
  if ((stats.mode & 0o077) !== 0) throw new Error(`${label} must not be readable or writable by group/others`);
  if (typeof process.getuid === "function" && stats.uid !== process.getuid()) {
    throw new Error(`${label} must be owned by the executing user`);
  }
}

function assertNarrowDirectory(directory, label) {
  if (!path.isAbsolute(directory) || directory === "/") throw new Error(`${label} must be a narrow absolute directory`);
  if (fs.existsSync(directory)) {
    const stats = fs.lstatSync(directory);
    if (stats.isSymbolicLink() || !stats.isDirectory()) throw new Error(`${label} must be a real directory`);
    if ((stats.mode & 0o077) !== 0) throw new Error(`${label} must be private (0700)`);
    if (typeof process.getuid === "function" && stats.uid !== process.getuid()) {
      throw new Error(`${label} must be owned by the executing user`);
    }
  } else {
    fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
  }
  return directory;
}

function assertOutputPathAvailable(filePath, label) {
  if (!path.isAbsolute(filePath)) throw new Error(`${label} must be an absolute path`);
  assertNarrowDirectory(path.dirname(filePath), `${label} directory`);
  if (fs.existsSync(filePath)) throw new Error(`${label} already exists`);
}

function writePrivateJson(filePath, value) {
  const directory = assertNarrowDirectory(path.dirname(filePath), "Output directory");
  const canonicalPath = path.join(directory, path.basename(filePath));
  fs.writeFileSync(canonicalPath, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600, flag: "wx" });
  return canonicalPath;
}

function appliedMemberMatches(member, operation, provenanceVersion) {
  return memberMatchesOperation(member, operation)
    && member?.joinSource?.type === PUBLISHED_TOURNAMENT_JOIN_SOURCE
    && member?.joinSource?.version === provenanceVersion;
}

function assertAppliedReadback(plan, communities, provenanceVersion) {
  const byId = new Map(asArray(communities).map((row) => [row.id, row]));
  for (const community of communities) {
    if (Number(community.memberCount) !== asArray(community.members).length) {
      throw new Error("Applied memberCount readback is inconsistent");
    }
  }
  for (const operation of plan.operations) {
    const matches = asArray(byId.get(operation.communityId)?.members)
      .filter((member) => appliedMemberMatches(member, operation, provenanceVersion));
    if (matches.length !== 1) throw new Error("Applied membership provenance readback failed");
  }
}

function assertRestorePreconditions(plan, currentCommunities, backup) {
  assertAppliedReadback(plan, currentCommunities, backup.provenanceVersion);
  const currentById = new Map(currentCommunities.map((row) => [row.id, row]));
  for (const preimage of backup.communities) {
    const current = currentById.get(preimage.id);
    const planned = plan.operations.filter((operation) => operation.communityId === preimage.id);
    if (!current || asArray(current.members).length !== asArray(preimage.members).length + planned.length) {
      throw new Error("Restore expected postimage member count does not match");
    }
    for (const member of asArray(preimage.members)) {
      const identity = memberIdentity(member);
      const stillPresent = asArray(current.members).some((candidate) => {
        const currentIdentity = memberIdentity(candidate);
        return identity.ids.some((id) => currentIdentity.ids.includes(id))
          || identity.phones.some((phone) => currentIdentity.phones.includes(phone));
      });
      if (!stillPresent) throw new Error("Restore preimage member is missing from current postimage");
    }
  }
}

async function readTargetCommunities(db, plan, session = undefined) {
  const ids = asArray(plan.communities).map((row) => row.communityId);
  return db.collection("lk_communities").find({ id: { $in: ids } }, { session }).toArray();
}

async function executeApply({ client, db, plan, backupDir, reportPath }) {
  const applyAt = new Date().toISOString();
  const provenanceVersion = `${plan.version}:${plan.planSha256}`;
  const communities = await readTargetCommunities(db, plan);
  validateCurrentMembershipPreconditions(plan, communities);
  const existingLedger = await db.collection("lk_tournament_community_enrollments").find({
    $or: plan.operations.flatMap((operation) => [
      { _id: operation.operationId },
      { communityId: operation.communityId, playerId: operation.playerId },
    ]),
  }).limit(1).toArray();
  if (existingLedger.length !== 0) throw new Error("An enrollment ledger row already exists for this plan");

  const backupPayload = {
    version: "published-tournament-community-membership-backup-v1",
    generatedAt: applyAt,
    appliedAt: applyAt,
    planSha256: plan.planSha256,
    provenanceVersion,
    communityPreimageSha256: hashCommunityPreimage(communities),
    communities,
  };
  const canonicalBackupDir = assertNarrowDirectory(backupDir, "Backup directory");
  const backupPath = path.join(canonicalBackupDir, `membership-${plan.planSha256}-${Date.now()}.ejson`);
  const backupText = `${BSON.EJSON.stringify(backupPayload, null, 2, { relaxed: false })}\n`;
  fs.writeFileSync(backupPath, backupText, { mode: 0o600, flag: "wx" });
  const backupSha256 = sha256(backupText);
  const executionId = `published-tournament-membership:${plan.planSha256}`;

  try {
    const session = client.startSession();
    try {
      await session.withTransaction(async () => {
        const ledger = db.collection("lk_tournament_community_enrollments");
        for (const operation of plan.operations) {
          await ledger.insertOne({
            _id: operation.operationId,
            version: plan.version,
            planSha256: plan.planSha256,
            communityId: operation.communityId,
            stationId: operation.stationId,
            playerId: operation.playerId,
            tournamentIds: operation.tournamentIds,
            publicationIds: operation.publicationIds,
            status: "APPLIED",
            createdAt: applyAt,
            appliedAt: applyAt,
            updatedAt: applyAt,
          }, { session });
          const mutation = buildTimeForAtomicMembershipMutation(operation, applyAt, provenanceVersion);
          const result = await db.collection("lk_communities").updateOne(mutation.filter, mutation.update, { session });
          if (result.matchedCount !== 1 || result.modifiedCount !== 1) {
            throw new Error("Atomic membership precondition failed during transaction");
          }
        }
        const withinTransaction = await readTargetCommunities(db, plan, session);
        assertAppliedReadback(plan, withinTransaction, provenanceVersion);
        await db.collection("lk_tournament_community_backfill_executions").insertOne({
          _id: executionId,
          version: plan.version,
          planSha256: plan.planSha256,
          status: "APPLIED",
          operationCount: plan.operations.length,
          communityIds: plan.communities.map((row) => row.communityId),
          backupPath,
          backupSha256,
          appliedAt: applyAt,
          createdAt: applyAt,
          updatedAt: applyAt,
        }, { session });
      }, { readConcern: { level: "snapshot" }, writeConcern: { w: "majority" } });
    } finally {
      await session.endSession();
    }
    const postCommit = await readTargetCommunities(db, plan);
    assertAppliedReadback(plan, postCommit, provenanceVersion);
    const report = {
      mode: "apply",
      ok: true,
      planSha256: plan.planSha256,
      operationCount: plan.operations.length,
      appliedAt: applyAt,
      backupPath,
      backupSha256,
      provenanceVersion,
      postCommitReadback: "PASS",
    };
    writePrivateJson(reportPath, report);
    return report;
  } catch (error) {
    throw new Error(`${error instanceof Error ? error.message : String(error)}; recovery backup: ${backupPath}; backup SHA-256: ${backupSha256}`);
  }
}

async function executeRestore({ client, db, plan, backupPath, confirmBackupSha, reportPath }) {
  assertPrivateFile(backupPath, "Backup");
  const backupText = fs.readFileSync(backupPath, "utf8");
  const actualBackupSha = sha256(backupText);
  if (actualBackupSha !== confirmBackupSha) throw new Error("Backup SHA confirmation does not match");
  const backup = BSON.EJSON.parse(backupText, { relaxed: false });
  validateRestoreBackup(plan, backup);
  const current = await readTargetCommunities(db, plan);
  const currentById = new Map(current.map((row) => [row.id, row]));
  assertRestorePreconditions(plan, current, backup);
  for (const preimage of backup.communities) {
    const currentCommunity = currentById.get(preimage.id);
    if (!currentCommunity || String(currentCommunity.updatedAt) !== String(backup.appliedAt)) {
      throw new Error("Restore CAS rejected post-apply community drift");
    }
  }
  const session = client.startSession();
  try {
    await session.withTransaction(async () => {
      for (const preimage of backup.communities) {
        const restore = buildCommunityRestoreReplacement(preimage, backup.appliedAt);
        const result = await db.collection("lk_communities").replaceOne(restore.filter, restore.replacement, { session });
        if (result.matchedCount !== 1) throw new Error("Restore CAS failed inside transaction");
      }
      await db.collection("lk_tournament_community_enrollments").deleteMany({ planSha256: plan.planSha256 }, { session });
      await db.collection("lk_tournament_community_backfill_executions").deleteOne({
        _id: `published-tournament-membership:${plan.planSha256}`,
      }, { session });
    }, { readConcern: { level: "snapshot" }, writeConcern: { w: "majority" } });
  } finally {
    await session.endSession();
  }
  const restored = await readTargetCommunities(db, plan);
  if (hashCommunityPreimage(restored) !== backup.communityPreimageSha256) {
    throw new Error("Restore postcheck fingerprint mismatch");
  }
  const remainingLedger = await db.collection("lk_tournament_community_enrollments")
    .countDocuments({ planSha256: plan.planSha256 }, { limit: 1 });
  const remainingExecution = await db.collection("lk_tournament_community_backfill_executions")
    .countDocuments({ _id: `published-tournament-membership:${plan.planSha256}` }, { limit: 1 });
  if (remainingLedger !== 0 || remainingExecution !== 0) throw new Error("Restore audit cleanup readback failed");
  const report = {
    mode: "restore",
    ok: true,
    planSha256: plan.planSha256,
    backupPath,
    backupSha256: actualBackupSha,
    restoredAt: new Date().toISOString(),
    postRestoreReadback: "PASS",
  };
  writePrivateJson(reportPath, report);
  return report;
}

export async function main(argv = process.argv.slice(2)) {
  const { flags, values } = parseArgs(argv);
  const apply = flags.has("--apply");
  const restore = flags.has("--restore");
  if (apply && restore) throw new Error("--apply and --restore are mutually exclusive");
  const planPath = toStringOrNull(values.get("--plan"));
  if (!planPath) throw new Error("--plan is required");
  assertPrivateFile(planPath, "Plan");
  const plan = JSON.parse(fs.readFileSync(planPath, "utf8"));
  const maxAgeMinutes = Number(values.get("--max-plan-age-minutes") || DEFAULT_MAX_PLAN_AGE_MINUTES);
  validateFrozenPlan(plan, restore ? Date.parse(plan.observedAt) : Date.now(), restore ? 1 : maxAgeMinutes);
  const confirmPlanSha = toStringOrNull(values.get("--confirm-plan-sha"));
  if ((apply || restore) && confirmPlanSha !== plan.planSha256) {
    throw new Error("Live mode requires --confirm-plan-sha matching the frozen plan");
  }
  const mongoUri = readMongoUri(values);
  const client = new MongoClient(mongoUri, {
    monitorCommands: true,
    maxPoolSize: 2,
    serverSelectionTimeoutMS: 20_000,
    connectTimeoutMS: 20_000,
  });
  let writeCommandCount = 0;
  client.on("commandStarted", (event) => {
    if (WRITE_COMMANDS.has(event.commandName)) writeCommandCount += 1;
  });
  try {
    await client.connect();
    const db = client.db(toStringOrNull(values.get("--db")) || "games");
    if (apply) {
      const backupDir = toStringOrNull(values.get("--backup-dir"));
      const reportPath = toStringOrNull(values.get("--report"));
      if (!backupDir || !reportPath) throw new Error("--apply requires --backup-dir and --report");
      assertOutputPathAvailable(reportPath, "Apply report");
      const report = await executeApply({ client, db, plan, backupDir, reportPath });
      console.log(JSON.stringify({ ...report, backupPath: undefined, provenanceVersion: undefined }, null, 2));
      return report;
    }
    if (restore) {
      const backupPath = toStringOrNull(values.get("--backup"));
      const confirmBackupSha = toStringOrNull(values.get("--confirm-backup-sha"));
      const reportPath = toStringOrNull(values.get("--report"));
      if (!backupPath || !confirmBackupSha || !reportPath) {
        throw new Error("--restore requires --backup, --confirm-backup-sha and --report");
      }
      assertOutputPathAvailable(reportPath, "Restore report");
      const report = await executeRestore({ client, db, plan, backupPath, confirmBackupSha, reportPath });
      console.log(JSON.stringify({ ...report, backupPath: undefined }, null, 2));
      return report;
    }
    const communities = await readTargetCommunities(db, plan);
    validateCurrentMembershipPreconditions(plan, communities);
    if (writeCommandCount !== 0) throw new Error(`Dry-run attempted ${writeCommandCount} Mongo write commands`);
    const report = {
      mode: "dry-run",
      ok: true,
      planSha256: plan.planSha256,
      operationCount: plan.operations.length,
      communityCount: plan.communities.length,
      communityPreimage: "MATCH",
      writeCommandCount,
    };
    const reportPath = toStringOrNull(values.get("--report"));
    if (reportPath) {
      assertOutputPathAvailable(reportPath, "Dry-run report");
      writePrivateJson(reportPath, report);
    }
    console.log(JSON.stringify(report, null, 2));
    return report;
  } finally {
    await client.close().catch(() => {});
  }
}

const invokedUrl = process.argv[1] ? pathToFileURL(path.resolve(process.argv[1])).href : "";
if (invokedUrl === import.meta.url) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
