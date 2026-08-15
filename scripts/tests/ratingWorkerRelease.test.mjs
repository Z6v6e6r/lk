import assert from "node:assert/strict";
import crypto from "node:crypto";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";

const repoRoot = fileURLToPath(new URL("../../", import.meta.url));
const builderPath = path.join(repoRoot, "scripts/build_rating_worker_release.mjs");

function sha256File(filePath) {
  return crypto.createHash("sha256").update(fs.readFileSync(filePath)).digest("hex");
}

test("rating-worker release packages the Viva User-Agent helper used by attendance sync", (t) => {
  const tempRoot = fs.realpathSync(
    fs.mkdtempSync(path.join(os.tmpdir(), "padlhub-rating-worker-release-test-")),
  );
  t.after(() => fs.rmSync(tempRoot, { recursive: true, force: true }));

  const releaseDir = path.join(tempRoot, "padlhub-rating-worker-test");
  const buildResult = spawnSync(
    process.execPath,
    [builderPath, "--out", releaseDir],
    {
      cwd: repoRoot,
      encoding: "utf8",
      maxBuffer: 5 * 1024 * 1024,
    },
  );
  assert.equal(
    buildResult.status,
    0,
    [buildResult.stderr, buildResult.stdout].filter(Boolean).join("\n"),
  );

  const manifestPath = path.join(releaseDir, "release-manifest.json");
  const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
  const helperRelativePath = "scripts/lib/vivaUserAgent.mjs";
  const helperPath = path.join(releaseDir, helperRelativePath);
  const helperEntries = manifest.files.filter(({ path: filePath }) => filePath === helperRelativePath);

  assert.equal(helperEntries.length, 1);
  assert.equal(fs.existsSync(helperPath), true);
  assert.equal(helperEntries[0].sha256, sha256File(helperPath));

  const mongodbStubDir = path.join(releaseDir, "node_modules/mongodb");
  fs.mkdirSync(mongodbStubDir, { recursive: true });
  fs.writeFileSync(
    path.join(mongodbStubDir, "package.json"),
    `${JSON.stringify({ name: "mongodb", private: true, type: "module", exports: "./index.mjs" })}\n`,
  );
  fs.writeFileSync(path.join(mongodbStubDir, "index.mjs"), "export class MongoClient {}\n");

  const attendanceSyncPath = path.join(releaseDir, "scripts/sync_training_visits_from_viva.mjs");
  const importResult = spawnSync(
    process.execPath,
    [
      "--input-type=module",
      "--eval",
      `await import(${JSON.stringify(pathToFileURL(attendanceSyncPath).href)});`,
    ],
    {
      cwd: releaseDir,
      encoding: "utf8",
    },
  );
  assert.equal(
    importResult.status,
    0,
    [importResult.stderr, importResult.stdout].filter(Boolean).join("\n"),
  );
});
