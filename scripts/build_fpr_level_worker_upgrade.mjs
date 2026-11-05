// Prepare a one-file, hash-bound upgrade for an already installed FPR worker or
// monthly reporter. No current-link, timer, Node-RED or database operations.
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import crypto from 'node:crypto';
export const sha256 = bytes => crypto.createHash('sha256').update(bytes).digest('hex');
export const fprLevelModulePath = 'scripts/lib/fprLevelLedger.mjs';
const checked = (root, relative, expected) => {
  if (!relative || path.isAbsolute(relative) || relative.split(/[\\/]/).some(p => !p || p === '.' || p === '..')) throw Error('Unsafe path');
  const target = path.join(root, relative);
  if (!fs.lstatSync(target).isFile() || fs.realpathSync(target) !== path.join(fs.realpathSync(root), relative)) throw Error('Non-regular file');
  const bytes = fs.readFileSync(target);
  if (!/^[a-f0-9]{64}$/.test(expected || '') || sha256(bytes) !== expected) throw Error('Hash mismatch: ' + relative);
  return bytes;
};
export function buildFprLevelModuleUpgrade({ baselineRoot, sourceRoot, outputRoot, contract }) {
  if (fs.existsSync(outputRoot)) throw Error('Output already exists');
  if (!/^[a-f0-9]{40}$/.test(contract.sourceCommit || '')) throw Error('Source commit required');
  const manifest = JSON.parse(checked(baselineRoot, 'release-manifest.json', contract.baselineManifestSha256));
  if (!['fpr-personal-level-overlay-v1', 'fpr-personal-level-upgrade-v1'].includes(manifest.composition?.kind)
    || manifest.recoveryPolicy !== 'forward-compatible-only-after-fpr-ledger-activation') throw Error('Compatible FPR level baseline required');
  if (manifest.dirtyWorktree !== false || !Array.isArray(manifest.files) || !manifest.files.length) throw Error('Clean baseline required');
  const files = new Map();
  for (const entry of manifest.files) {
    if (entry.path === 'release-manifest.json' || files.has(entry.path)) throw Error('Duplicate/reserved file');
    files.set(entry.path, checked(baselineRoot, entry.path, entry.sha256));
  }
  if (!files.has(fprLevelModulePath) || sha256(files.get(fprLevelModulePath)) !== contract.baselineModuleSha256) throw Error('Existing module preimage required');
  files.set(fprLevelModulePath, checked(sourceRoot, fprLevelModulePath, contract.sourceModuleSha256));
  if (contract.baselineModuleSha256 === contract.sourceModuleSha256) throw Error('Module unchanged');
  fs.mkdirSync(outputRoot, { mode: 0o755 }); fs.chmodSync(outputRoot, 0o755);
  for (const [relative, bytes] of files) {
    const target = path.join(outputRoot, relative);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    let directory = outputRoot;
    for (const segment of relative.split('/').slice(0, -1)) { directory = path.join(directory, segment); fs.chmodSync(directory, 0o755); }
    const mode = fs.statSync(path.join(baselineRoot, relative)).mode & 0o777;
    fs.writeFileSync(target, bytes, { mode }); fs.chmodSync(target, mode);
  }
  const next = { ...manifest, gitSha: contract.sourceCommit, releaseId: path.basename(outputRoot), generatedAt: new Date().toISOString(), dirtyWorktree: false,
    composition: { kind: 'fpr-personal-level-upgrade-v1', baselineManifestSha256: contract.baselineManifestSha256, baselineModuleSha256: contract.baselineModuleSha256, sourceModuleSha256: contract.sourceModuleSha256, changedFiles: [fprLevelModulePath] },
    files: [...files].map(([file, bytes]) => ({ path: file, sha256: sha256(bytes) })) };
  fs.writeFileSync(path.join(outputRoot, 'release-manifest.json'), JSON.stringify(next, null, 2) + '\n', { mode: 0o644 });
  fs.chmodSync(path.join(outputRoot, 'release-manifest.json'), 0o644);
  return { ok: true, changedFiles: [fprLevelModulePath], manifestSha256: sha256(fs.readFileSync(path.join(outputRoot, 'release-manifest.json'))) };
}
if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  const [baselineRoot, sourceRoot, outputRoot, contractPath] = process.argv.slice(2);
  if (!contractPath) throw Error('Usage: BASE SOURCE NEW_OUTPUT CONTRACT_JSON');
  console.log(JSON.stringify(buildFprLevelModuleUpgrade({ baselineRoot, sourceRoot, outputRoot, contract: JSON.parse(fs.readFileSync(contractPath)) })));
}
