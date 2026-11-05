import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { buildFprLevelModuleUpgrade, fprLevelModulePath, fprLevelResultsPath } from '../build_fpr_level_worker_upgrade.mjs';
import { sha256 } from '../build_fpr_level_worker_upgrade.mjs';
function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'fpr-module-upgrade-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const baselineRoot = path.join(root, 'base'), sourceRoot = path.join(root, 'source'), outputRoot = path.join(root, 'new');
  for (const folder of [baselineRoot, sourceRoot]) fs.mkdirSync(path.join(folder, path.dirname(fprLevelModulePath)), { recursive: true });
  fs.writeFileSync(path.join(baselineRoot, fprLevelModulePath), 'old module');
  fs.writeFileSync(path.join(sourceRoot, fprLevelModulePath), 'new module');
  fs.writeFileSync(path.join(baselineRoot, 'run.sh'), 'retained lock and runtime'); fs.chmodSync(path.join(baselineRoot, 'run.sh'), 0o755);
  const manifest = JSON.stringify({ gitSha: 'a'.repeat(40), dirtyWorktree: false, composition: { kind: 'fpr-personal-level-overlay-v1' }, recoveryPolicy: 'forward-compatible-only-after-fpr-ledger-activation', files: [{ path: fprLevelModulePath, sha256: sha256('old module') }, { path: 'run.sh', sha256: sha256('retained lock and runtime') }] });
  fs.writeFileSync(path.join(baselineRoot, 'release-manifest.json'), manifest);
  return { baselineRoot, sourceRoot, outputRoot, contract: { sourceCommit: 'b'.repeat(40), baselineManifestSha256: sha256(manifest), baselineModuleSha256: sha256('old module'), sourceModuleSha256: sha256('new module') } };
}
test('one module upgrade preserves all retained worker/reporter bytes, modes and manifest checksums', t => {
  const f = fixture(t), previous = process.umask(0o077);
  try {
    const result = buildFprLevelModuleUpgrade(f);
    assert.deepEqual(result.changedFiles, [fprLevelModulePath]);
    assert.equal(fs.readFileSync(path.join(f.outputRoot, 'run.sh'), 'utf8'), 'retained lock and runtime');
    assert.equal(fs.statSync(path.join(f.outputRoot, 'run.sh')).mode & 0o777, 0o755);
    const manifest = JSON.parse(fs.readFileSync(path.join(f.outputRoot, 'release-manifest.json')));
    for (const entry of manifest.files) assert.equal(sha256(fs.readFileSync(path.join(f.outputRoot, entry.path))), entry.sha256);
  } finally { process.umask(previous); }
});
test('baseline drift, wrong module, source drift and symlinks fail before producing output', t => {
  for (const change of [f => fs.appendFileSync(path.join(f.baselineRoot, 'run.sh'), 'drift'), f => { f.contract.baselineModuleSha256 = '0'.repeat(64); }, f => fs.appendFileSync(path.join(f.sourceRoot, fprLevelModulePath), 'drift'), f => {
    const p = path.join(f.baselineRoot, 'run.sh'); fs.renameSync(p, p + '.old'); fs.symlinkSync(p + '.old', p);
  }]) {
    const f = fixture(t); change(f);
    assert.throws(() => buildFprLevelModuleUpgrade(f));
    assert.equal(fs.existsSync(f.outputRoot), false);
  }
});


test('fixed results dependency is hash-bound and missing imports fail before publication', t => {
  const f = fixture(t);
  const module = "import { readFprLevelResults } from '../../src/services/player-rating/fprLevelResults.ts';";
  fs.writeFileSync(path.join(f.sourceRoot, fprLevelModulePath), module); f.contract.sourceModuleSha256 = sha256(module);
  assert.throws(() => buildFprLevelModuleUpgrade(f), /Missing runtime dependency/);
  assert.equal(fs.existsSync(f.outputRoot), false);
  fs.mkdirSync(path.dirname(path.join(f.sourceRoot, fprLevelResultsPath)), { recursive: true });
  const dependency = 'export const readFprLevelResults = () => null;';
  fs.writeFileSync(path.join(f.sourceRoot, fprLevelResultsPath), dependency); f.contract.sourceResultsSha256 = sha256(dependency);
  assert.deepEqual(buildFprLevelModuleUpgrade(f).changedFiles, [fprLevelModulePath, fprLevelResultsPath]);
  assert.equal(sha256(fs.readFileSync(path.join(f.outputRoot, fprLevelResultsPath))), f.contract.sourceResultsSha256);
  assert.equal(fs.statSync(path.join(f.outputRoot, fprLevelResultsPath)).mode & 0o777, 0o644);
});
