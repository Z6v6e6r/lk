import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { buildFprRatingWorkerOverlay, fprWorkerFiles, fprWorkerReplacements, sha256 } from "../build_fpr_rating_worker_overlay.mjs";

function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "fpr-worker-overlay-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const baselineRoot = path.join(root, "base"), sourceRoot = path.join(root, "source"), outputRoot = path.join(root, "candidate");
  fs.mkdirSync(baselineRoot); fs.mkdirSync(sourceRoot);
  const write = (dir, file, value) => { const target = path.join(dir, file); fs.mkdirSync(path.dirname(target), { recursive: true }); fs.writeFileSync(target, value); };
  const baselineFiles = {}, sourceFiles = {};
  for (const [i, file] of fprWorkerFiles.entries()) {
    const patches = fprWorkerReplacements.filter(p => p.file === file);
    const before = patches.length ? patches.map(p => p.before).join("\n") : "old facts\n";
    const after = patches.length ? patches.map(p => p.after).join("\n") : `new FPR source ${i}\n`;
    if (i < 3) { write(baselineRoot, file, before); baselineFiles[file] = sha256(before); }
    write(sourceRoot, file, after); sourceFiles[file] = sha256(after);
  }
  write(baselineRoot, "deploy/run.sh", "old lock/annulment/entrypoint bytes\n");
  fs.chmodSync(path.join(baselineRoot, "deploy/run.sh"), 0o755);
  const manifest = { gitSha: "a".repeat(40), dirtyWorktree: false, files: [...Object.entries(baselineFiles).map(([file, hash]) => ({ path: file, sha256: hash })), { path: "deploy/run.sh", sha256: sha256("old lock/annulment/entrypoint bytes\n") }] };
  const manifestPath = path.join(baselineRoot, "release-manifest.json");
  fs.writeFileSync(manifestPath, JSON.stringify(manifest));
  const contract = { sourceCommit: "b".repeat(40), sourceFiles, baselineFiles, baselineManifestSha256: sha256(fs.readFileSync(manifestPath)) };
  return { baselineRoot, sourceRoot, outputRoot, contract, manifestPath };
}

test("FPR overlay changes exactly five files and preserves installed runtime bytes/modes", t => {
  const f = fixture(t), result = buildFprRatingWorkerOverlay(f);
  assert.deepEqual(result.changedFiles, [...fprWorkerFiles].sort());
  assert.equal(fs.readFileSync(path.join(f.outputRoot, "deploy/run.sh"), "utf8"), "old lock/annulment/entrypoint bytes\n");
  assert.equal(fs.statSync(path.join(f.outputRoot, "deploy/run.sh")).mode & 0o777, 0o755);
  assert.equal(fs.existsSync(path.join(f.outputRoot, "src/services/community-policy.ts")), false);
  const manifest = JSON.parse(fs.readFileSync(path.join(f.outputRoot, "release-manifest.json")));
  for (const entry of manifest.files) assert.equal(sha256(fs.readFileSync(path.join(f.outputRoot, entry.path))), entry.sha256);
  assert.equal(manifest.composition.baselineManifestSha256, f.contract.baselineManifestSha256);
});
test("baseline drift is rejected before output creation", t => {
  const f = fixture(t); fs.appendFileSync(path.join(f.baselineRoot, "deploy/run.sh"), "foreign change");
  assert.throws(() => buildFprRatingWorkerOverlay(f), /Hash mismatch/);
  assert.equal(fs.existsSync(f.outputRoot), false);
});
test("a restrictive deploy umask cannot remove runtime read/execute permissions", t => {
  const f = fixture(t), previous = process.umask(0o077);
  try {
    buildFprRatingWorkerOverlay(f);
    assert.equal(fs.statSync(path.join(f.outputRoot, "deploy/run.sh")).mode & 0o777, 0o755);
    assert.equal(fs.statSync(path.join(f.outputRoot, "src/services/community-rating/fpr.ts")).mode & 0o777, 0o644);
    assert.equal(fs.statSync(path.join(f.outputRoot, "src/services/community-rating")).mode & 0o777, 0o755);
  } finally { process.umask(previous); }
});
test("source hash and preimage contracts are required", t => {
  const f = fixture(t); f.contract.sourceFiles[fprWorkerFiles[2]] = "0".repeat(64);
  assert.throws(() => buildFprRatingWorkerOverlay(f), /Hash mismatch/);
  f.contract.sourceFiles[fprWorkerFiles[2]] = sha256(fs.readFileSync(path.join(f.sourceRoot, fprWorkerFiles[2])));
  f.contract.baselineFiles[fprWorkerFiles[0]] = "0".repeat(64);
  assert.throws(() => buildFprRatingWorkerOverlay(f), /Preimage mismatch/);
});
test("a changed or repeated patch anchor fails closed", t => {
  const f = fixture(t), file = fprWorkerFiles[0];
  const changed = fs.readFileSync(path.join(f.baselineRoot, file), "utf8") + fprWorkerReplacements[0].before;
  fs.writeFileSync(path.join(f.baselineRoot, file), changed);
  const manifest = JSON.parse(fs.readFileSync(f.manifestPath)); manifest.files.find(e => e.path === file).sha256 = sha256(changed);
  fs.writeFileSync(f.manifestPath, JSON.stringify(manifest)); f.contract.baselineManifestSha256 = sha256(fs.readFileSync(f.manifestPath)); f.contract.baselineFiles[file] = sha256(changed);
  assert.throws(() => buildFprRatingWorkerOverlay(f), /Non-unique FPR patch anchor/);
  assert.equal(fs.existsSync(f.outputRoot), false);
});
test("unreviewed source files, symlinks and existing outputs are rejected", t => {
  const f = fixture(t); f.contract.sourceFiles["extra.ts"] = "0".repeat(64);
  assert.throws(() => buildFprRatingWorkerOverlay(f), /allowlist/); delete f.contract.sourceFiles["extra.ts"];
  const file = path.join(f.baselineRoot, "deploy/run.sh"); fs.renameSync(file, file + ".old"); fs.symlinkSync(file + ".old", file);
  assert.throws(() => buildFprRatingWorkerOverlay(f), /Non-regular manifest file/);
  fs.mkdirSync(f.outputRoot);
  assert.throws(() => buildFprRatingWorkerOverlay(f), /Output already exists/);
});
