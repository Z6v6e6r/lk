// Prepare a one-file, hash-bound upgrade for an already installed FPR worker or
// monthly reporter. No current-link, timer, Node-RED or database operations.
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { sha256 } from './build_fpr_rating_worker_overlay.mjs';
export const fprEnginePath = 'src/components/tournaments/fpr6x25.ts';
const checked = (root, relative, expected) => {
  if (!relative || path.isAbsolute(relative) || relative.split(/[\\/]/).some(p => !p || p === '.' || p === '..')) throw Error('Unsafe path');
  const target = path.join(root, relative);
  if (!fs.lstatSync(target).isFile() || fs.realpathSync(target) !== path.join(fs.realpathSync(root), relative)) throw Error('Non-regular file');
  const bytes = fs.readFileSync(target);
  if (!/^[a-f0-9]{64}$/.test(expected || '') || sha256(bytes) !== expected) throw Error('Hash mismatch: ' + relative);
  return bytes;
};
export function buildFprEngineUpgrade({ baselineRoot, sourceRoot, outputRoot, contract }) {
  if (fs.existsSync(outputRoot)) throw Error('Output already exists');
  if (!/^[a-f0-9]{40}$/.test(contract.sourceCommit || '')) throw Error('Source commit required');
  const manifest = JSON.parse(checked(baselineRoot, 'release-manifest.json', contract.baselineManifestSha256));
  if (manifest.dirtyWorktree !== false || !Array.isArray(manifest.files) || !manifest.files.length) throw Error('Clean baseline required');
  const files = new Map();
  for (const entry of manifest.files) {
    if (entry.path === 'release-manifest.json' || files.has(entry.path)) throw Error('Duplicate/reserved file');
    files.set(entry.path, checked(baselineRoot, entry.path, entry.sha256));
  }
  if (!files.has(fprEnginePath) || sha256(files.get(fprEnginePath)) !== contract.baselineEngineSha256) throw Error('Existing engine preimage required');
  files.set(fprEnginePath, checked(sourceRoot, fprEnginePath, contract.sourceEngineSha256));
  if (contract.baselineEngineSha256 === contract.sourceEngineSha256) throw Error('Engine unchanged');
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
    composition: { kind: 'fpr-engine-upgrade-v1', baselineManifestSha256: contract.baselineManifestSha256, baselineEngineSha256: contract.baselineEngineSha256, sourceEngineSha256: contract.sourceEngineSha256, changedFiles: [fprEnginePath] },
    files: [...files].map(([file, bytes]) => ({ path: file, sha256: sha256(bytes) })) };
  fs.writeFileSync(path.join(outputRoot, 'release-manifest.json'), JSON.stringify(next, null, 2) + '\n', { mode: 0o644 });
  fs.chmodSync(path.join(outputRoot, 'release-manifest.json'), 0o644);
  return { ok: true, changedFiles: [fprEnginePath], manifestSha256: sha256(fs.readFileSync(path.join(outputRoot, 'release-manifest.json'))) };
}
if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  const [baselineRoot, sourceRoot, outputRoot, contractPath] = process.argv.slice(2);
  if (!contractPath) throw Error('Usage: BASE SOURCE NEW_OUTPUT CONTRACT_JSON');
  console.log(JSON.stringify(buildFprEngineUpgrade({ baselineRoot, sourceRoot, outputRoot, contract: JSON.parse(fs.readFileSync(contractPath)) })));
}
