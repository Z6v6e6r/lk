#!/usr/bin/env node

import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { buildLegacyTenantMigrationPlan, validateTenantMigrationScope } from "./lib/vivaGameProjectionTenantMigration.mjs";

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = fs.realpathSync(path.resolve(SCRIPT_DIR, ".."));
const fail = (message) => { throw new Error(message); };
const sha256 = (value) => crypto.createHash("sha256").update(value).digest("hex");
const GAME_FIELDS = new Set(["_id", "id", "tenantKey", "revision", "status", "archived", "dedupeKey", "updatedAt", "booking", "metadata"]);
const BOOKING_FIELDS = new Set(["vivaExerciseId", "exerciseId", "studioId", "date", "timeFrom", "timeTo"]);
const METADATA_FIELDS = new Set(["vivaExerciseId", "exerciseId"]);
const PROVIDER_FIELDS = new Set(["id", "uuid", "exerciseId", "studio", "station", "studioId", "date", "timeFrom", "timeTo", "startTime", "endTime", "active", "isCancelled", "cancelled", "canceled", "status", "state", "lifecycleStatus"]);
const PROVIDER_ID_FIELDS = new Set(["id", "uuid"]);
const GAMES_PAYLOAD_FIELDS = new Set(["formatVersion", "sourceKind", "sourceHost", "sourceFlowSha256", "database", "collection", "capturedAt", "games"]);
const PROVIDER_PAYLOAD_FIELDS = new Set(["formatVersion", "sourceKind", "capturedAt", "tenantKey", "captureReceiptSha256", "rowsByDate"]);
const RECEIPT_FIELDS = new Set(["formatVersion", "sourceKind", "tenantKey", "capturedAt", "endpointOrigin", "captures"]);
const RECEIPT_CAPTURE_FIELDS = new Set(["date", "requestPath", "statusCode", "complete", "responseShape", "rowCount", "rowsSha256"]);

const requireObject = (value, label) => {
  if (!value || typeof value !== "object" || Array.isArray(value)) fail(`${label} must be an object`);
};
const requireOnlyFields = (value, allowed, label) => {
  requireObject(value, label);
  const unexpected = Object.keys(value).filter((key) => !allowed.has(key));
  if (unexpected.length) fail(`${label} contains unexpected field: ${unexpected.sort()[0]}`);
};
const requireString = (owner, key, label, { optional = false, nullable = false } = {}) => {
  if (!Object.hasOwn(owner, key)) {
    if (optional) return;
    fail(`${label} is required`);
  }
  if (nullable && owner[key] === null) return;
  if (typeof owner[key] !== "string" || !owner[key].trim()) fail(`${label} must be a non-empty string`);
};
const requireOptionalBoolean = (owner, key, label) => {
  if (Object.hasOwn(owner, key) && typeof owner[key] !== "boolean") fail(`${label} must be boolean`);
};
const listDates = (from, to) => {
  const dates = [];
  for (let cursor = Date.parse(`${from}T00:00:00.000Z`); cursor <= Date.parse(`${to}T00:00:00.000Z`); cursor += 86_400_000) {
    dates.push(new Date(cursor).toISOString().slice(0, 10));
  }
  return dates;
};
export const validateProjectedInputs = (gamesPayload, providerPayload, scope) => {
  requireOnlyFields(gamesPayload, GAMES_PAYLOAD_FIELDS, "Games projection");
  requireOnlyFields(providerPayload, PROVIDER_PAYLOAD_FIELDS, "Provider projection");
  if (!Array.isArray(gamesPayload.games)) fail("Games file must contain { games: [] }");
  if (gamesPayload.games.length > 1000) fail("Games file exceeds the 1000-record migration bound");
  gamesPayload.games.forEach((game, index) => {
    requireOnlyFields(game, GAME_FIELDS, `Game ${index}`);
    requireOnlyFields(game._id, new Set(["$oid"]), `Game ${index} _id`);
    requireString(game._id, "$oid", `Game ${index} _id.$oid`);
    for (const key of ["id", "dedupeKey", "updatedAt"]) requireString(game, key, `Game ${index} ${key}`, { optional: true, nullable: true });
    requireString(game, "status", `Game ${index} status`);
    requireOptionalBoolean(game, "archived", `Game ${index} archived`);
    if (Object.hasOwn(game, "tenantKey") && game.tenantKey !== null) fail(`Game ${index} tenantKey must be null or missing`);
    if (Object.hasOwn(game, "revision") && game.revision !== null) fail(`Game ${index} revision must be null or missing`);
    requireOnlyFields(game.booking, BOOKING_FIELDS, `Game ${index} booking`);
    for (const key of ["vivaExerciseId", "exerciseId"]) requireString(game.booking, key, `Game ${index} booking.${key}`, { optional: true, nullable: true });
    for (const key of ["studioId", "date", "timeFrom", "timeTo"]) requireString(game.booking, key, `Game ${index} booking.${key}`);
    if (game.metadata !== undefined) {
      requireOnlyFields(game.metadata, METADATA_FIELDS, `Game ${index} metadata`);
      for (const key of METADATA_FIELDS) requireString(game.metadata, key, `Game ${index} metadata.${key}`, { optional: true, nullable: true });
    }
  });
  requireObject(providerPayload.rowsByDate, "Provider rowsByDate");
  let providerCount = 0;
  for (const [date, rows] of Object.entries(providerPayload.rowsByDate)) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || date < scope.dateFrom || date > scope.dateTo || !Array.isArray(rows)) {
      fail(`Provider rowsByDate entry is outside the requested scope: ${date}`);
    }
    if (rows.length > 1000) fail(`Provider date exceeds the 1000-record bound: ${date}`);
    providerCount += rows.length;
    rows.forEach((row, index) => {
      requireOnlyFields(row, PROVIDER_FIELDS, `Provider ${date} row ${index}`);
      for (const key of ["id", "uuid", "exerciseId", "studioId", "date", "timeFrom", "timeTo", "startTime", "endTime", "status", "state", "lifecycleStatus"]) {
        requireString(row, key, `Provider ${date} row ${index} ${key}`, { optional: true, nullable: true });
      }
      for (const key of ["active", "isCancelled", "cancelled", "canceled"]) requireOptionalBoolean(row, key, `Provider ${date} row ${index} ${key}`);
      if (row.studio !== undefined) {
        requireOnlyFields(row.studio, PROVIDER_ID_FIELDS, `Provider ${date} row ${index} studio`);
        for (const key of PROVIDER_ID_FIELDS) requireString(row.studio, key, `Provider ${date} row ${index} studio.${key}`, { optional: true, nullable: true });
      }
      if (row.station !== undefined) {
        requireOnlyFields(row.station, PROVIDER_ID_FIELDS, `Provider ${date} row ${index} station`);
        for (const key of PROVIDER_ID_FIELDS) requireString(row.station, key, `Provider ${date} row ${index} station.${key}`, { optional: true, nullable: true });
      }
      if (![row.id, row.uuid, row.exerciseId].some((value) => typeof value === "string" && value.trim())) fail(`Provider ${date} row ${index} identity is required`);
      if (row.active !== true) fail(`Provider ${date} row ${index} must have normalized active=true`);
    });
  }
  if (providerCount > 15_000) fail("Provider file exceeds the 15000-record migration bound");
};

export const validateCaptureReceipt = (receipt, receiptSha256, providerPayload, scope) => {
  requireOnlyFields(receipt, RECEIPT_FIELDS, "Provider capture receipt");
  if (receipt.formatVersion !== 1 || receipt.sourceKind !== "viva-end-user-tenant-capture-receipt") fail("Provider capture receipt contract mismatch");
  if (receipt.tenantKey !== scope.tenantKey || receipt.capturedAt !== providerPayload.capturedAt) fail("Provider capture receipt tenant/time mismatch");
  if (receipt.endpointOrigin !== "https://api.vivacrm.ru") fail("Provider capture receipt origin mismatch");
  if (providerPayload.captureReceiptSha256 !== receiptSha256) fail("Provider projection receipt hash mismatch");
  if (!Array.isArray(receipt.captures)) fail("Provider capture receipt captures must be an array");
  const dates = listDates(scope.dateFrom, scope.dateTo);
  if (receipt.captures.length !== dates.length || Object.keys(providerPayload.rowsByDate).length !== dates.length) fail("Provider capture receipt does not cover the full date range");
  dates.forEach((date, index) => {
    const capture = receipt.captures[index];
    requireOnlyFields(capture, RECEIPT_CAPTURE_FIELDS, `Provider capture ${date}`);
    const rows = providerPayload.rowsByDate[date];
    const expectedPath = `/end-user/api/v1/${encodeURIComponent(scope.tenantKey)}/exercises?date=${date}`;
    if (!Array.isArray(rows) || capture.date !== date || capture.requestPath !== expectedPath
      || capture.statusCode !== 200 || capture.complete !== true || capture.responseShape !== "array"
      || capture.rowCount !== rows.length || capture.rowsSha256 !== sha256(Buffer.from(JSON.stringify(rows)))) {
      fail(`Provider capture receipt is incomplete or mismatched for ${date}`);
    }
  });
};

const parseArgs = (argv) => {
  const values = {};
  for (let index = 0; index < argv.length; index += 2) {
    const key = argv[index];
    const value = argv[index + 1];
    if (!key?.startsWith("--") || !value || value.startsWith("--") || Object.hasOwn(values, key)) fail(`Invalid argument: ${key || ""}`);
    values[key] = value;
  }
  const required = ["--games-file", "--provider-file", "--provider-capture-receipt-file", "--output-directory", "--tenant-key", "--date-from", "--date-to", "--operation-id", "--expected-flow-sha256", "--expected-provider-receipt-sha256"];
  for (const key of required) if (!values[key]) fail(`Missing ${key}`);
  return {
    gamesFile: values["--games-file"],
    providerFile: values["--provider-file"],
    providerCaptureReceiptFile: values["--provider-capture-receipt-file"],
    outputDirectory: values["--output-directory"],
    expectedSourceFlowSha256: values["--expected-flow-sha256"],
    expectedProviderReceiptSha256: values["--expected-provider-receipt-sha256"],
    scope: { tenantKey: values["--tenant-key"], dateFrom: values["--date-from"], dateTo: values["--date-to"], operationId: values["--operation-id"] },
  };
};

const readPrivateFile = (filePath, label, maxBytes) => {
  if (!path.isAbsolute(filePath)) fail(`${label} must be absolute`);
  const requested = path.resolve(filePath);
  if (fs.realpathSync(requested) !== requested) fail(`${label} path must be canonical`);
  const descriptor = fs.openSync(requested, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
  try {
    const stat = fs.fstatSync(descriptor);
    if (!stat.isFile() || stat.nlink !== 1) fail(`${label} must be a single-link regular file`);
    if ((stat.mode & 0o777) !== 0o600) fail(`${label} must have mode 0600`);
    if (typeof process.getuid === "function" && stat.uid !== process.getuid()) fail(`${label} must be owned by the current user`);
    if (stat.size > maxBytes) fail(`${label} exceeds the private projection size bound`);
    return { bytes: fs.readFileSync(descriptor) };
  } finally {
    fs.closeSync(descriptor);
  }
};

const prepareOutputDirectory = (outputDirectory) => {
  if (!path.isAbsolute(outputDirectory)) fail("Output directory must be absolute");
  const requested = path.resolve(outputDirectory);
  const relative = path.relative(REPO_ROOT, requested);
  if (!relative.startsWith("..") && !path.isAbsolute(relative)) fail("Output directory must be outside the repository");
  if (fs.existsSync(requested)) fail("Output directory must not already exist");
  const parent = path.dirname(requested);
  const parentStat = fs.lstatSync(parent);
  if (!parentStat.isDirectory() || parentStat.isSymbolicLink() || fs.realpathSync(parent) !== parent) fail("Output parent must be a canonical directory");
  if ((parentStat.mode & 0o077) !== 0 || (typeof process.getuid === "function" && parentStat.uid !== process.getuid())) fail("Output parent must be private and owned by the current user");
  return { requested, parent };
};

const writePrivate = (filePath, bytes) => {
  const descriptor = fs.openSync(filePath, fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_WRONLY, 0o600);
  try { fs.writeFileSync(descriptor, bytes); fs.fsyncSync(descriptor); } finally { fs.closeSync(descriptor); }
};

export const requireFreshProjection = (payload, contract, label, nowIso) => {
  if (!payload || typeof payload !== "object" || payload.formatVersion !== 1) fail(`${label} provenance format mismatch`);
  for (const [key, expected] of Object.entries(contract)) if (payload[key] !== expected) fail(`${label} provenance mismatch for ${key}`);
  const capturedAt = Date.parse(payload.capturedAt);
  const now = Date.parse(nowIso);
  const ageMs = now - capturedAt;
  if (!Number.isFinite(capturedAt) || !Number.isFinite(now) || ageMs < -300_000 || ageMs > 1_800_000) fail(`${label} projection is stale`);
};

export function prepareVivaGameProjectionTenantMigration(options) {
  validateTenantMigrationScope(options.scope);
  const configuredTenantKey = String(options.configuredTenantKey ?? process.env.PADLHUB_PLATFORM_TENANT_KEY ?? "").trim();
  if (configuredTenantKey !== options.scope.tenantKey) fail("Requested tenant does not match PADLHUB_PLATFORM_TENANT_KEY");
  if (!/^[a-f0-9]{64}$/.test(options.expectedSourceFlowSha256 || "")) fail("Expected source-flow SHA-256 is invalid");
  if (!/^[a-f0-9]{64}$/.test(options.expectedProviderReceiptSha256 || "")) fail("Expected provider-receipt SHA-256 is invalid");
  const gamesFile = readPrivateFile(options.gamesFile, "Games file", 32 * 1024 * 1024);
  const providerFile = readPrivateFile(options.providerFile, "Provider file", 64 * 1024 * 1024);
  const receiptFile = readPrivateFile(options.providerCaptureReceiptFile, "Provider capture receipt file", 1024 * 1024);
  const gamesPayload = JSON.parse(gamesFile.bytes.toString("utf8"));
  const providerPayload = JSON.parse(providerFile.bytes.toString("utf8"));
  const providerCaptureReceipt = JSON.parse(receiptFile.bytes.toString("utf8"));
  validateProjectedInputs(gamesPayload, providerPayload, options.scope);
  const receiptSha256 = sha256(receiptFile.bytes);
  if (receiptSha256 !== options.expectedProviderReceiptSha256) fail("Provider capture receipt proof mismatch");
  validateCaptureReceipt(providerCaptureReceipt, receiptSha256, providerPayload, options.scope);
  const nowIso = options.nowIso || new Date().toISOString();
  requireFreshProjection(gamesPayload, { sourceKind: "live-147-mongo-projection", sourceHost: "lk-primary-147", database: "games", collection: "lk_games" }, "Games", nowIso);
  if (gamesPayload.sourceFlowSha256 !== options.expectedSourceFlowSha256) fail("Games projection source-flow proof mismatch");
  requireFreshProjection(providerPayload, { sourceKind: "viva-end-user-tenant-projection" }, "Provider", nowIso);
  if (providerPayload.tenantKey !== options.scope.tenantKey) fail("Provider tenant proof mismatch");
  const plan = buildLegacyTenantMigrationPlan(gamesPayload.games, providerPayload.rowsByDate, options.scope, nowIso);
  const { requested: directory, parent } = prepareOutputDirectory(options.outputDirectory);
  fs.mkdirSync(directory, { mode: 0o700 });
  fs.chmodSync(directory, 0o700);
  const ownedDirectory = fs.lstatSync(directory);
  const ownedIdentity = { dev: ownedDirectory.dev, ino: ownedDirectory.ino };
  try {
    const planBytes = Buffer.from(`${JSON.stringify({
      formatVersion: 1,
      mongoIdEncoding: "canonical-ejson",
      generatedAt: nowIso,
      dryRunOnly: true,
      source: {
        gamesSha256: sha256(gamesFile.bytes),
        providerSha256: sha256(providerFile.bytes),
        providerCaptureReceiptSha256: receiptSha256,
        sourceFlowSha256: gamesPayload.sourceFlowSha256,
        expectedSourceFlowSha256: options.expectedSourceFlowSha256,
        gamesCapturedAt: gamesPayload.capturedAt,
        providerCapturedAt: providerPayload.capturedAt,
        providerTenantKey: providerPayload.tenantKey,
      },
      ...plan,
    }, null, 2)}\n`);
    const planSha256 = sha256(planBytes);
    const summary = {
      ok: true,
      dryRunOnly: true,
      operationId: options.scope.operationId,
      tenantKey: options.scope.tenantKey,
      dateFrom: options.scope.dateFrom,
      dateTo: options.scope.dateTo,
      scannedCount: plan.scannedCount,
      eligibleCount: plan.eligibleCount,
      skipped: plan.skipped,
      planSha256,
      writesPerformed: 0,
    };
    writePrivate(path.join(directory, "plan.json"), planBytes);
    writePrivate(path.join(directory, "summary.json"), Buffer.from(`${JSON.stringify(summary, null, 2)}\n`));
    writePrivate(path.join(directory, "READY"), Buffer.from(`${planSha256}\n`));
    const directoryDescriptor = fs.openSync(directory, fs.constants.O_RDONLY);
    try { fs.fsyncSync(directoryDescriptor); } finally { fs.closeSync(directoryDescriptor); }
    const parentDescriptor = fs.openSync(parent, fs.constants.O_RDONLY);
    try { fs.fsyncSync(parentDescriptor); } finally { fs.closeSync(parentDescriptor); }
    return summary;
  } catch (error) {
    if (fs.existsSync(directory)) {
      const current = fs.lstatSync(directory);
      const entries = current.isDirectory() ? fs.readdirSync(directory) : [];
      const owned = current.dev === ownedIdentity.dev && current.ino === ownedIdentity.ino;
      const containsOnlyOwnedFiles = entries.every((entry) => ["plan.json", "summary.json", "READY"].includes(entry));
      if (owned && containsOnlyOwnedFiles) fs.rmSync(directory, { recursive: true, force: true });
    }
    throw error;
  }
}

const invokedPath = process.argv[1] ? fs.realpathSync(process.argv[1]) : "";
if (invokedPath === fileURLToPath(import.meta.url)) {
  try {
    const summary = prepareVivaGameProjectionTenantMigration(parseArgs(process.argv.slice(2)));
    console.log(JSON.stringify(summary));
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
