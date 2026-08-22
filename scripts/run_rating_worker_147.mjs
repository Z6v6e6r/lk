#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  resolveRatingWorkerChildTimeoutMs,
  spawnRatingWorkerChild,
} from "./lib/ratingWorkerChildProcess.mjs";

const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const flowPath = process.env.NODERED_FLOW_PATH || "/root/.node-red/flows.json";
const runtimeDir = process.env.RATING_WORKER_RUNTIME_DIR || "/var/lib/padlhub-rating-worker";
const envFile = process.env.RATING_WORKER_ENV_FILE || "/etc/padlhub-rating-worker.env";
const modeIndex = process.argv.indexOf("--mode");
const mode = modeIndex >= 0 ? process.argv[modeIndex + 1] : "incremental";
const gameResultsOnly = process.argv.includes("--game-results-only");

function isRecord(value) {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

function readEnvFile() {
  if (!fs.existsSync(envFile)) return {};
  return Object.fromEntries(fs.readFileSync(envFile, "utf8").split("\n").flatMap((line) => {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) return [];
    const index = trimmed.indexOf("=");
    if (index < 1) return [];
    return [[trimmed.slice(0, index), trimmed.slice(index + 1)]];
  }));
}

function readMongoUriFromFlow() {
  const flow = JSON.parse(fs.readFileSync(flowPath, "utf8"));
  const mongoNode = flow.find((item) => (
    item?.type === "mongodb4-client"
    && typeof item.uri === "string"
    && item.uri.includes("/games")
  ));
  if (mongoNode?.uri) return mongoNode.uri;
  const candidates = [];
  const visit = (value) => {
    if (typeof value === "string" && /mongodb(?:\+srv)?:\/\//i.test(value)) {
      candidates.push(value);
      return;
    }
    if (Array.isArray(value)) value.forEach(visit);
    else if (isRecord(value)) Object.values(value).forEach(visit);
  };
  visit(flow);
  return candidates.find((item) => item.includes("/games")) || candidates[0] || "";
}

function runNode(args, env, outPath) {
  const timeoutMs = resolveRatingWorkerChildTimeoutMs(env);
  const result = spawnRatingWorkerChild(args, {
    cwd: rootDir,
    env,
    maxBuffer: 200 * 1024 * 1024,
    timeoutMs,
  });
  fs.writeFileSync(outPath, result.stdout || "", { mode: 0o600 });
  if (result.stderr) fs.writeFileSync(`${outPath}.stderr`, result.stderr, { mode: 0o600 });
  if (result.error?.code === "ETIMEDOUT") {
    throw new Error(`Child timed out after ${timeoutMs}ms; stdout=${outPath}; stderr=${outPath}.stderr`);
  }
  if (result.error) {
    throw new Error(`Child spawn failed: ${result.error.message}; stdout=${outPath}; stderr=${outPath}.stderr`);
  }
  if (result.status !== 0) {
    throw new Error(`Child exited ${result.status} signal=${result.signal || "none"}; stdout=${outPath}; stderr=${outPath}.stderr`);
  }
  const reportPath = outPath.endsWith(".stdout") ? outPath.slice(0, -".stdout".length) : null;
  [outPath, `${outPath}.stderr`, reportPath]
    .filter((target) => target && fs.existsSync(target))
    .forEach((target) => fs.chmodSync(target, 0o600));
  return result.stdout ? JSON.parse(result.stdout) : null;
}

function compactVisitReport(report) {
  if (!report || typeof report !== "object") return report;
  return {
    ok: report.ok === true,
    mode: report.mode || null,
    dates: Array.isArray(report.dates) ? report.dates : [],
    syncedAt: report.syncedAt || null,
    stats: report.stats || null,
    scannedExerciseIds: Number(report.scannedExerciseIds || 0),
    records: Number(report.records || 0),
    archiveCandidates: Number(report.archiveCandidates || 0),
    writes: report.writes || null,
  };
}

function dateAtOffset(days) {
  const date = new Date();
  date.setUTCDate(date.getUTCDate() + days);
  return date.toISOString().slice(0, 10);
}

const runtimeEnv = { ...process.env, ...readEnvFile() };
runtimeEnv.MONGODB_URI = runtimeEnv.MONGODB_URI || readMongoUriFromFlow();
if (!runtimeEnv.MONGODB_URI) throw new Error("Mongo URI not found in active Node-RED flow");
const runDate = new Date().toISOString().slice(0, 10);
const runStamp = new Date().toISOString().replace(/[:.]/g, "-");
const outDir = path.join(runtimeDir, "runs", runDate);
fs.mkdirSync(outDir, { recursive: true, mode: 0o700 });
fs.chmodSync(runtimeDir, 0o700);
fs.chmodSync(path.join(runtimeDir, "runs"), 0o700);
fs.chmodSync(outDir, 0o700);

const gameResultWorkerEnabled = String(runtimeEnv.GAME_RESULT_RATING_WORKER_ENABLED || "")
  .trim()
  .toLowerCase() === "true";
let gameResults = {
  skipped: true,
  reason: gameResultWorkerEnabled ? "NOT_RUN" : "GAME_RESULT_RATING_WORKER_DISABLED",
};
if (gameResultWorkerEnabled) {
  const gameResultOut = path.join(outDir, `game-result-rating-worker-${runStamp}.json`);
  try {
    gameResults = runNode([
      "--experimental-strip-types",
      path.join(rootDir, "scripts/game_result_rating_worker.mjs"),
      "--apply",
      "--limit", runtimeEnv.GAME_RESULT_RATING_WORKER_LIMIT || "20",
      "--out", gameResultOut,
    ], runtimeEnv, `${gameResultOut}.stdout`);
  } catch (error) {
    gameResults = {
      ok: false,
      skipped: false,
      reason: "GAME_RESULT_RATING_WORKER_FAILED",
      error: String(error?.message || error).slice(0, 500),
    };
    if (!gameResultsOnly) {
      console.error("[rating-worker] Game-result rating run failed; continuing scheduled canonical rating run");
    }
  }
}

if (gameResultsOnly) {
  console.log(JSON.stringify({ ok: gameResults?.ok !== false, mode: "game-results", gameResults }, null, 2));
  process.exit(gameResults?.ok === false ? 1 : 0);
}

const hasVivaCredentials = Boolean(
  runtimeEnv.VIVA_CLIENT_ID
  && runtimeEnv.VIVA_USERNAME
  && runtimeEnv.VIVA_PASSWORD,
);
let visits = { skipped: true, reason: "VIVA_CREDENTIALS_NOT_CONFIGURED" };
if (hasVivaCredentials) {
  const dateFrom = mode === "full" ? dateAtOffset(-7) : dateAtOffset(-1);
  const visitOut = path.join(outDir, `training-visits-${mode}-${runStamp}.json`);
  try {
    visits = compactVisitReport(runNode([
      path.join(rootDir, "scripts/sync_training_visits_from_viva.mjs"),
      "--date-from", dateFrom,
      "--date-to", dateAtOffset(0),
      "--apply",
      "--out", visitOut,
    ], runtimeEnv, `${visitOut}.stdout`));
  } catch (error) {
    visits = {
      ok: false,
      skipped: false,
      reason: "VIVA_ATTENDANCE_SYNC_FAILED",
      error: String(error?.message || error).slice(0, 500),
    };
    console.error("[rating-worker] Viva attendance sync failed; continuing canonical rating run");
  }
}

const workerOut = path.join(outDir, `rating-worker-${mode}-${runStamp}.json`);
const worker = runNode([
  "--experimental-strip-types",
  path.join(rootDir, "scripts/rating_worker.mjs"),
  "--mode", mode,
  "--out", workerOut,
], runtimeEnv, `${workerOut}.stdout`);

console.log(JSON.stringify({ ok: true, mode, gameResults, visits, worker }, null, 2));
