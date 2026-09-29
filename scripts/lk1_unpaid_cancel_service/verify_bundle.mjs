import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const BUNDLE_FILES = [
  'launch_lk1_unpaid_booking_cancellation.mjs',
  'run_lk1_unpaid_booking_cancellation.mjs',
  'lib/lk1UnpaidBookingCancellation.mjs',
  'lib/lk1VivaServiceToken.mjs',
  'lib/lk1LiveGatewayGuard.mjs',
  'lib/lk1UnpaidScanCursor.mjs',
  'package.json',
  'package-lock.json',
  'lk1-unpaid-cancel.service',
  'verify_bundle.mjs',
];

export function verifyBundle(folder, { installed = false, expectedManifestSha = null } = {}) {
  if (!path.isAbsolute(folder)) throw new Error('BUNDLE_PATH_INVALID');
  const root = fs.realpathSync(folder);
  const rootStat = fs.lstatSync(root);
  if (root !== folder || !rootStat.isDirectory() || (rootStat.mode & 0o077) !== 0) {
    throw new Error('BUNDLE_PATH_INVALID');
  }
  const manifestPath = path.join(root, 'manifest.json');
  const manifestStat = fs.lstatSync(manifestPath);
  if (!manifestStat.isFile() || manifestStat.nlink !== 1) throw new Error('BUNDLE_MANIFEST_INVALID');
  const manifestSha256 = crypto.createHash('sha256').update(fs.readFileSync(manifestPath)).digest('hex');
  if (expectedManifestSha && manifestSha256 !== expectedManifestSha) throw new Error('BUNDLE_MANIFEST_DRIFT');
  const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
  if (manifest.schema !== 1 || !/^[a-f0-9]{40}$/.test(manifest.sourceCommit)
    || JSON.stringify(Object.keys(manifest.files).sort()) !== JSON.stringify([...BUNDLE_FILES].sort())) {
    throw new Error('BUNDLE_MANIFEST_INVALID');
  }
  const expectedRoot = new Set(['manifest.json', 'lib', ...BUNDLE_FILES.filter(file => !file.startsWith('lib/'))]);
  if (installed) expectedRoot.add('node_modules');
  const rootEntries = fs.readdirSync(root);
  if (rootEntries.length !== expectedRoot.size
    || rootEntries.some(name => !expectedRoot.has(name))) throw new Error('BUNDLE_EXTRA_FILE');
  const expectedLib = BUNDLE_FILES.filter(file => file.startsWith('lib/')).map(file => path.basename(file));
  const libDir = path.join(root, 'lib');
  if (!fs.lstatSync(libDir).isDirectory()
    || fs.readdirSync(libDir).sort().join('\n') !== expectedLib.sort().join('\n')) {
    throw new Error('BUNDLE_EXTRA_FILE');
  }
  if (installed && (!fs.lstatSync(path.join(root, 'node_modules')).isDirectory()
    || fs.lstatSync(path.join(root, 'node_modules')).isSymbolicLink())) {
    throw new Error('BUNDLE_DEPENDENCIES_INVALID');
  }
  for (const file of BUNDLE_FILES) {
    const full = path.join(root, file);
    const stat = fs.lstatSync(full);
    if (!stat.isFile() || stat.nlink !== 1 || stat.isSymbolicLink()) throw new Error('BUNDLE_FILE_INVALID');
    const digest = crypto.createHash('sha256').update(fs.readFileSync(full)).digest('hex');
    if (digest !== manifest.files[file]) throw new Error('BUNDLE_DIGEST_MISMATCH');
  }
  return { sourceCommit: manifest.sourceCommit, manifestSha256, fileCount: BUNDLE_FILES.length };
}

if (process.argv[1] && fs.realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const installed = process.argv.includes('--installed');
    const expectedAt = process.argv.indexOf('--expect-manifest-sha256');
    const expectedManifestSha = expectedAt < 0 ? null : process.argv[expectedAt + 1];
    const rest = process.argv.slice(2).filter((arg, index, all) => arg !== '--installed'
      && arg !== '--expect-manifest-sha256' && all[index - 1] !== '--expect-manifest-sha256');
    if (rest.length !== 1 || (expectedAt >= 0 && !/^[a-f0-9]{64}$/.test(expectedManifestSha || ''))) {
      throw new Error('Usage: verify_bundle.mjs [--installed] [--expect-manifest-sha256 SHA] ABSOLUTE_BUNDLE_DIR');
    }
    process.stdout.write(`${JSON.stringify(verifyBundle(rest[0], { installed, expectedManifestSha }))}\n`);
  } catch (error) { console.error(error.message); process.exitCode = 1; }
}
