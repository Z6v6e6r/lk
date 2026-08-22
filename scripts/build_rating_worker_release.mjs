#!/usr/bin/env node
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";

const getArg = (name) => {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : null;
};
const outArg = getArg("--out");
if (!outArg) {
  throw new Error("Usage: node scripts/build_rating_worker_release.mjs --out /absolute/release-dir");
}

const rootDir = process.cwd();
const outDir = path.resolve(outArg);
if (fs.existsSync(outDir)) throw new Error(`Release directory already exists: ${outDir}`);

const files = [
  ["deploy/rating-worker/README.md", "deploy/rating-worker/README.md"],
  ["deploy/rating-worker/configure-runtime-env.mjs", "deploy/rating-worker/configure-runtime-env.mjs"],
  ["deploy/rating-worker/run-full.sh", "deploy/rating-worker/run-full.sh"],
  ["deploy/rating-worker/run-incremental.sh", "deploy/rating-worker/run-incremental.sh"],
  ["deploy/rating-worker/run-game-results.sh", "deploy/rating-worker/run-game-results.sh"],
  ["deploy/rating-worker/run-with-watchdog.sh", "deploy/rating-worker/run-with-watchdog.sh"],
  ["deploy/rating-worker/package.json", "package.json"],
  ["scripts/rating_worker.mjs", "scripts/rating_worker.mjs"],
  ["scripts/game_result_rating_worker.mjs", "scripts/game_result_rating_worker.mjs"],
  ["scripts/lib/vivaUserAgent.mjs", "scripts/lib/vivaUserAgent.mjs"],
  ["scripts/lib/communityRatingPostcheck.mjs", "scripts/lib/communityRatingPostcheck.mjs"],
  ["scripts/lib/gameResultRating.mjs", "scripts/lib/gameResultRating.mjs"],
  ["scripts/lib/ratingWorkerChildProcess.mjs", "scripts/lib/ratingWorkerChildProcess.mjs"],
  ["scripts/lib/tournamentCommunityContext.mjs", "scripts/lib/tournamentCommunityContext.mjs"],
  ["scripts/lib/timeForFriendsCommunityBackfill.mjs", "scripts/lib/timeForFriendsCommunityBackfill.mjs"],
  ["scripts/lib/tournamentFinalization.mjs", "scripts/lib/tournamentFinalization.mjs"],
  ["scripts/run_rating_worker_147.mjs", "scripts/run_rating_worker_147.mjs"],
  ["scripts/sync_training_visits_from_viva.mjs", "scripts/sync_training_visits_from_viva.mjs"],
  ["scripts/recalculate_community_rating.mjs", "scripts/recalculate_community_rating.mjs"],
  ["scripts/recalculate_community_rating_all.mjs", "scripts/recalculate_community_rating_all.mjs"],
  ["scripts/run_community_rating_recalc_147.mjs", "scripts/run_community_rating_recalc_147.mjs"],
  ["scripts/postcheck_community_rating_147.mjs", "scripts/postcheck_community_rating_147.mjs"],
  ["src/services/community-rating/aggregates.ts", "src/services/community-rating/aggregates.ts"],
  ["src/services/community-rating/calculations.ts", "src/services/community-rating/calculations.ts"],
  ["src/services/community-rating/contract.ts", "src/services/community-rating/contract.ts"],
  ["src/services/community-rating/facts.ts", "src/services/community-rating/facts.ts"],
  ["src/services/community-rating/index.ts", "src/services/community-rating/index.ts"],
  ["src/services/community-rating/persistence.ts", "src/services/community-rating/persistence.ts"],
  ["src/services/community-rating/recalculation.ts", "src/services/community-rating/recalculation.ts"],
  ["src/services/player-rating/ledger.ts", "src/services/player-rating/ledger.ts"],
];

const readVersion = (relativePath, pattern, label) => {
  const source = fs.readFileSync(path.join(rootDir, relativePath), "utf8");
  const match = source.match(pattern);
  if (!match?.[1]) throw new Error(`${label} not found in ${relativePath}`);
  return match[1];
};
const workerVersion = readVersion(
  "src/services/player-rating/ledger.ts",
  /PLAYER_RATING_WORKER_VERSION\s*=\s*["']([^"']+)/,
  "Worker version",
);
const gameResultWorkerVersion = readVersion(
  "scripts/game_result_rating_worker.mjs",
  /GAME_RESULT_RATING_WORKER_VERSION\s*=\s*["']([^"']+)/,
  "Game result worker version",
);
const communityCalculationVersion = readVersion(
  "src/services/community-rating/contract.ts",
  /COMMUNITY_RATING_CALCULATION_VERSION\s*=\s*["']([^"']+)/,
  "Community calculation version",
);

fs.mkdirSync(outDir, { recursive: false });
files.forEach(([sourcePath, targetPath]) => {
  const source = path.join(rootDir, sourcePath);
  const target = path.join(outDir, targetPath);
  if (!fs.existsSync(source)) throw new Error(`Release source missing: ${sourcePath}`);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.copyFileSync(source, target);
});

[
  "deploy/rating-worker/run-full.sh",
  "deploy/rating-worker/run-incremental.sh",
  "deploy/rating-worker/run-game-results.sh",
  "deploy/rating-worker/run-with-watchdog.sh",
  "scripts/run_community_rating_recalc_147.mjs",
  "scripts/postcheck_community_rating_147.mjs",
].forEach((relativePath) => fs.chmodSync(path.join(outDir, relativePath), 0o755));

const sha256 = (buffer) => crypto.createHash("sha256").update(buffer).digest("hex");
const manifestFiles = files.map(([, targetPath]) => ({
  path: targetPath,
  sha256: sha256(fs.readFileSync(path.join(outDir, targetPath))),
}));
const gitShaResult = spawnSync("git", ["rev-parse", "HEAD"], {
  cwd: rootDir,
  encoding: "utf8",
});
const gitStatusResult = spawnSync("git", ["status", "--porcelain"], {
  cwd: rootDir,
  encoding: "utf8",
});
const manifest = {
  releaseId: path.basename(outDir).replace(/^padlhub-rating-worker-/, ""),
  workerVersion,
  gameResultWorkerVersion,
  communityCalculationVersion,
  generatedAt: new Date().toISOString(),
  gitSha: gitShaResult.status === 0 ? gitShaResult.stdout.trim() : null,
  dirtyWorktree: gitStatusResult.status !== 0 || Boolean(gitStatusResult.stdout.trim()),
  files: manifestFiles,
};
fs.writeFileSync(
  path.join(outDir, "release-manifest.json"),
  `${JSON.stringify(manifest, null, 2)}\n`,
  { mode: 0o644 },
);
console.log(JSON.stringify({
  ok: true,
  outDir,
  ...manifest,
}, null, 2));
