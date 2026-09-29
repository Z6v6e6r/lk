#!/usr/bin/env node
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { BUNDLE_FILES, verifyBundle } from './verify_bundle.mjs';

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const root = fs.realpathSync(path.resolve(scriptDir, '../..'));
const sources = new Map([
  ['launch_lk1_unpaid_booking_cancellation.mjs', 'scripts/launch_lk1_unpaid_booking_cancellation.mjs'],
  ['run_lk1_unpaid_booking_cancellation.mjs', 'scripts/run_lk1_unpaid_booking_cancellation.mjs'],
  ['lib/lk1UnpaidBookingCancellation.mjs', 'scripts/lib/lk1UnpaidBookingCancellation.mjs'],
  ['lib/lk1VivaServiceToken.mjs', 'scripts/lib/lk1VivaServiceToken.mjs'],
  ['lib/lk1LiveGatewayGuard.mjs', 'scripts/lib/lk1LiveGatewayGuard.mjs'],
  ['lib/lk1UnpaidScanCursor.mjs', 'scripts/lib/lk1UnpaidScanCursor.mjs'],
  ['package.json', 'scripts/lk1_unpaid_cancel_service/package.json'],
  ['package-lock.json', 'scripts/lk1_unpaid_cancel_service/package-lock.json'],
  ['lk1-unpaid-cancel.service', 'scripts/lk1_unpaid_cancel_service/lk1-unpaid-cancel.service'],
  ['verify_bundle.mjs', 'scripts/lk1_unpaid_cancel_service/verify_bundle.mjs'],
]);

function main(folder) {
  const relative = path.relative(root, folder);
  if (!folder || !path.isAbsolute(folder) || fs.existsSync(folder)
    || !(relative === '..' || relative.startsWith(`..${path.sep}`))) {
    throw new Error('OUTPUT_MUST_BE_NEW_EXTERNAL_ABSOLUTE_DIR');
  }
  const parent = path.dirname(folder), parentStat = fs.lstatSync(parent);
  if (!parentStat.isDirectory() || parentStat.isSymbolicLink()
    || (parentStat.mode & 0o777) !== 0o700 || fs.realpathSync(parent) !== parent) {
    throw new Error('OUTPUT_PARENT_NOT_PRIVATE');
  }
  const status = execFileSync('git', ['status', '--porcelain', '--untracked-files=all'], {
    cwd: root, encoding: 'utf8', timeout: 10000,
  });
  if (status.trim()) throw new Error('SOURCE_TREE_NOT_CLEAN');
  const sourceCommit = execFileSync('git', ['rev-parse', 'HEAD'], {
    cwd: root, encoding: 'utf8', timeout: 10000,
  }).trim();
  fs.mkdirSync(folder, { mode: 0o700 });
  fs.mkdirSync(path.join(folder, 'lib'), { mode: 0o700 });
  const files = {};
  for (const file of BUNDLE_FILES) {
    const bytes = fs.readFileSync(path.join(root, sources.get(file)));
    fs.writeFileSync(path.join(folder, file), bytes, { mode: 0o600, flag: 'wx' });
    files[file] = crypto.createHash('sha256').update(bytes).digest('hex');
  }
  fs.writeFileSync(path.join(folder, 'manifest.json'),
    `${JSON.stringify({ schema: 1, sourceCommit, files }, null, 2)}\n`, { mode: 0o600, flag: 'wx' });
  process.stdout.write(`${JSON.stringify(verifyBundle(folder))}\n`);
}

try {
  if (process.argv.length !== 3) throw new Error('Usage: build_bundle.mjs ABSOLUTE_NEW_OUTPUT_DIR');
  main(process.argv[2]);
} catch (error) { console.error(error.message); process.exitCode = 1; }
