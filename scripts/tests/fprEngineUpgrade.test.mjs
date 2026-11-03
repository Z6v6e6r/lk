import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { buildFprEngineUpgrade, fprEnginePath } from '../build_fpr_engine_upgrade.mjs';
import { sha256 } from '../build_fpr_rating_worker_overlay.mjs';
function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'fpr-engine-upgrade-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const baselineRoot = path.join(root, 'base'), sourceRoot = path.join(root, 'source'), outputRoot = path.join(root, 'new');
  for (const folder of [baselineRoot, sourceRoot]) fs.mkdirSync(path.join(folder, path.dirname(fprEnginePath)), { recursive: true });
  fs.writeFileSync(path.join(baselineRoot, fprEnginePath), 'old engine');
  fs.writeFileSync(path.join(sourceRoot, fprEnginePath), 'new engine');
  fs.writeFileSync(path.join(baselineRoot, 'run.sh'), 'retained lock and runtime'); fs.chmodSync(path.join(baselineRoot, 'run.sh'), 0o755);
  const manifest = JSON.stringify({ gitSha: 'a'.repeat(40), dirtyWorktree: false, files: [{ path: fprEnginePath, sha256: sha256('old engine') }, { path: 'run.sh', sha256: sha256('retained lock and runtime') }] });
  fs.writeFileSync(path.join(baselineRoot, 'release-manifest.json'), manifest);
  return { baselineRoot, sourceRoot, outputRoot, contract: { sourceCommit: 'b'.repeat(40), baselineManifestSha256: sha256(manifest), baselineEngineSha256: sha256('old engine'), sourceEngineSha256: sha256('new engine') } };
}
test('one engine upgrade preserves all retained worker/reporter bytes, modes and manifest checksums', t => {
  const f = fixture(t), previous = process.umask(0o077);
  try {
    const result = buildFprEngineUpgrade(f);
    assert.deepEqual(result.changedFiles, [fprEnginePath]);
    assert.equal(fs.readFileSync(path.join(f.outputRoot, 'run.sh'), 'utf8'), 'retained lock and runtime');
    assert.equal(fs.statSync(path.join(f.outputRoot, 'run.sh')).mode & 0o777, 0o755);
    const manifest = JSON.parse(fs.readFileSync(path.join(f.outputRoot, 'release-manifest.json')));
    for (const entry of manifest.files) assert.equal(sha256(fs.readFileSync(path.join(f.outputRoot, entry.path))), entry.sha256);
  } finally { process.umask(previous); }
});
test('baseline drift, wrong engine, source drift and symlinks fail before producing output', t => {
  for (const change of [f => fs.appendFileSync(path.join(f.baselineRoot, 'run.sh'), 'drift'), f => { f.contract.baselineEngineSha256 = '0'.repeat(64); }, f => fs.appendFileSync(path.join(f.sourceRoot, fprEnginePath), 'drift'), f => {
    const p = path.join(f.baselineRoot, 'run.sh'); fs.renameSync(p, p + '.old'); fs.symlinkSync(p + '.old', p);
  }]) {
    const f = fixture(t); change(f);
    assert.throws(() => buildFprEngineUpgrade(f));
    assert.equal(fs.existsSync(f.outputRoot), false);
  }
});
