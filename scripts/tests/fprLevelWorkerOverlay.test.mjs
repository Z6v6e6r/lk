import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { buildFprRatingWorkerOverlay, fprWorkerFiles, fprWorkerReplacements, sha256 } from '../build_fpr_level_worker_overlay.mjs';
const repositoryRoot = process.cwd();
function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'fpr-level-overlay-'));
  const base = path.join(root, 'base'); fs.mkdirSync(base);
  // Historical exact-anchor overlay contracts use their reviewed owning source,
  // rather than requiring a future worker to retain historical implementation text.
  const sourceRoot = path.join(root, 'source'); fs.mkdirSync(sourceRoot);
  for (const file of fprWorkerFiles) {
    const replacements = fprWorkerReplacements.filter(p => p.file === file);
    const bytes = replacements.length ? Buffer.from(replacements.map(p => p.after).join('\n// independent anchor\n'))
      : fs.readFileSync(path.join(repositoryRoot, file));
    fs.mkdirSync(path.dirname(path.join(sourceRoot, file)), { recursive: true });
    fs.writeFileSync(path.join(sourceRoot, file), bytes);
  }
  const files = fprWorkerFiles.slice(0, 2).map(file => {
    const bytes = Buffer.from(fprWorkerReplacements.filter(p => p.file === file).map(p => p.before).join('\n// independent anchor\n'));
    fs.mkdirSync(path.dirname(path.join(base, file)), { recursive: true }); fs.writeFileSync(path.join(base, file), bytes);
    return { path: file, sha256: sha256(bytes) };
  });
  for (const file of ['src/services/player-rating/ledger.ts', 'src/components/tournaments/fpr6x25.ts', 'scripts/lib/tournamentFinalization.mjs']) {
    const bytes = fs.readFileSync(path.join(repositoryRoot, file));
    fs.mkdirSync(path.dirname(path.join(base, file)), { recursive: true }); fs.writeFileSync(path.join(base, file), bytes);
    files.push({ path: file, sha256: sha256(bytes) });
  }
  fs.writeFileSync(path.join(base, 'unchanged'), 'preserved'); files.push({ path: 'unchanged', sha256: sha256('preserved') });
  const manifest = JSON.stringify({ dirtyWorktree: false, gitSha: 'a'.repeat(40), files });
  fs.writeFileSync(path.join(base, 'release-manifest.json'), manifest);
  const contract = { sourceCommit: 'b'.repeat(40), baselineManifestSha256: sha256(manifest),
    baselineFiles: Object.fromEntries(files.map(f => [f.path, f.sha256])),
    sourceFiles: Object.fromEntries(fprWorkerFiles.map(file => [file, sha256(fs.readFileSync(path.join(sourceRoot, file)))])) };
  return { root, base, contract, sourceRoot };
}
test('immutable overlay preserves every unrelated installed file and exact new dependency closure', () => {
  const { root, base, contract, sourceRoot } = fixture();
  try {
    const out = path.join(root, 'candidate');
    const result = buildFprRatingWorkerOverlay({ baselineRoot: base, sourceRoot, outputRoot: out, contract });
    assert.deepEqual(result.changedFiles, [...fprWorkerFiles].sort());
    assert.equal(fs.readFileSync(path.join(out, 'unchanged'), 'utf8'), 'preserved');
    for (const file of fprWorkerFiles.slice(2)) assert.equal(sha256(fs.readFileSync(path.join(out, file))), contract.sourceFiles[file]);
    assert.equal(JSON.parse(fs.readFileSync(path.join(out, 'release-manifest.json'))).recoveryPolicy, 'forward-compatible-only-after-fpr-ledger-activation');
    assert.throws(() => buildFprRatingWorkerOverlay({ baselineRoot: base, sourceRoot, outputRoot: out, contract }), /Output already exists/);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});
test('source tampering, installed drift and extra allowlist paths fail before candidate publication', () => {
  for (const mutation of ['source', 'baseline', 'allowlist']) {
    const { root, base, contract, sourceRoot } = fixture(); const out = path.join(root, 'candidate');
    try {
      if (mutation === 'source') contract.sourceFiles[fprWorkerFiles[2]] = '0'.repeat(64);
      if (mutation === 'baseline') fs.appendFileSync(path.join(base, fprWorkerFiles[0]), 'drift');
      if (mutation === 'allowlist') contract.sourceFiles['extra'] = '0'.repeat(64);
      assert.throws(() => buildFprRatingWorkerOverlay({ baselineRoot: base, sourceRoot, outputRoot: out, contract }));
      assert.equal(fs.existsSync(out), false);
    } finally { fs.rmSync(root, { recursive: true, force: true }); }
  }
});

test('missing installed dependency is rejected before writing the candidate', () => {
  const { root, base, contract, sourceRoot } = fixture(); const out = path.join(root, 'candidate');
  try {
    const file = path.join(base, 'release-manifest.json');
    const manifest = JSON.parse(fs.readFileSync(file));
    manifest.files = manifest.files.filter(f => f.path !== 'scripts/lib/tournamentFinalization.mjs');
    fs.writeFileSync(file, JSON.stringify(manifest)); contract.baselineManifestSha256 = sha256(fs.readFileSync(file));
    assert.throws(() => buildFprRatingWorkerOverlay({ baselineRoot: base, sourceRoot, outputRoot: out, contract }), /Missing runtime dependency/);
    assert.equal(fs.existsSync(out), false);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});
