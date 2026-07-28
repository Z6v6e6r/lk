#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const flowPath = process.env.NODERED_FLOW_PATH || "/root/.node-red/flows.json";
const runtimeDir = process.env.RATING_WORKER_RUNTIME_DIR || "/var/lib/padlhub-rating-worker";
const apply = process.argv.includes("--apply");

function isRecord(value) {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
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

function getExpectedCalculationVersion() {
  const manifestPath = path.join(rootDir, "release-manifest.json");
  if (fs.existsSync(manifestPath)) {
    const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
    if (manifest.communityCalculationVersion) return String(manifest.communityCalculationVersion);
  }
  const contract = fs.readFileSync(
    path.join(rootDir, "src/services/community-rating/contract.ts"),
    "utf8",
  );
  const match = contract.match(/COMMUNITY_RATING_CALCULATION_VERSION\s*=\s*["']([^"']+)/);
  return match?.[1] || "";
}

const mongoUri = process.env.MONGODB_URI || readMongoUriFromFlow();
if (!mongoUri) throw new Error("Mongo URI not found in active Node-RED flow");

const expectedVersion = getExpectedCalculationVersion();
if (!expectedVersion) throw new Error("Community calculation version not found in release");

const runDate = new Date().toISOString().slice(0, 10);
const runStamp = new Date().toISOString().replace(/[:.]/g, "-");
const mode = apply ? "apply" : "dry-run";
const outDir = path.join(runtimeDir, "runs", runDate);
const requestedOutIndex = process.argv.indexOf("--out");
const requestedOut = requestedOutIndex >= 0 ? process.argv[requestedOutIndex + 1] : null;
const outPath = requestedOut
  ? path.resolve(requestedOut)
  : path.join(outDir, `community-rating-${expectedVersion}-${mode}-${runStamp}.json`);

fs.mkdirSync(path.dirname(outPath), { recursive: true, mode: 0o700 });
const childArgs = [
  "--experimental-strip-types",
  path.join(rootDir, "scripts/recalculate_community_rating_all.mjs"),
];
if (!apply) childArgs.push("--dry-run");

const result = spawnSync(process.execPath, childArgs, {
  cwd: rootDir,
  env: { ...process.env, MONGODB_URI: mongoUri },
  encoding: "utf8",
  maxBuffer: 200 * 1024 * 1024,
});

fs.writeFileSync(outPath, result.stdout || "", { mode: 0o600 });
if (result.stderr) fs.writeFileSync(`${outPath}.stderr`, result.stderr, { mode: 0o600 });
if (result.status !== 0) {
  throw new Error(`Community rating recalculation exited ${result.status}; report=${outPath}`);
}

const report = JSON.parse(result.stdout || "{}");
const rows = Array.isArray(report.results) ? report.results : [];
const versions = Array.from(new Set(rows.map((row) => row?.calculationVersion).filter(Boolean)));
if (versions.length !== 1 || versions[0] !== expectedVersion) {
  throw new Error(`Unexpected calculation versions: ${versions.join(",") || "none"}`);
}
if (rows.some((row) => row?.applied !== apply)) {
  throw new Error(`Unexpected applied flag in ${mode} report`);
}

console.log(JSON.stringify({
  ok: true,
  mode,
  calculationVersion: expectedVersion,
  communities: rows.length,
  reportPath: outPath,
}, null, 2));
