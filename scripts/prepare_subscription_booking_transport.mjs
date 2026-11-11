import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';
import { prepareBookingTransportRecovery } from './lib/subscriptionBookingTransportRecovery.mjs';
import { verifyWorkspace } from './verify_nodered_source_origin.mjs';

// Local preparation only. No SSH, HTTP, import, restart, worker installation or DB.
export function prepareArtifacts(workspace, outputDirectory, routerSha256) {
  const verified = verifyWorkspace(workspace, { quiet: true });
  const { sourcePath, meta } = verified;
  if (typeof process.getuid === 'function' && [verified.workspace, verified.inputDirectory, sourcePath, verified.metaPath]
    .some(location => fs.lstatSync(location).uid !== process.getuid())) throw new Error('SOURCE_OWNER_MISMATCH');
  const output = path.resolve(outputDirectory);
  // Resolve the existing parent so a symlink cannot put private flow bytes in Git.
  const parent = fs.realpathSync(path.dirname(output));
  if (fs.existsSync(output)) throw new Error('OUTPUT_MUST_NOT_EXIST');
  const actualOutput = path.join(parent, path.basename(output));
  for (const location of [sourcePath, parent]) {
    let insideGit = false;
    try { execFileSync('git', ['-C', fs.statSync(location).isDirectory() ? location : path.dirname(location),
      'rev-parse', '--show-toplevel'], { stdio: 'ignore' }); insideGit = true; } catch { /* external path */ }
    if (insideGit) throw new Error('FLOW_ARTIFACTS_MUST_BE_OUTSIDE_GIT');
  }
  const result = prepareBookingTransportRecovery(fs.readFileSync(sourcePath), {
    sourceSha256: meta.sourceSha256, routerSha256,
  });
  fs.mkdirSync(actualOutput, { mode: 0o700 });
  try {
    fs.writeFileSync(path.join(actualOutput, 'candidate.flow.json'), result.candidate, { flag: 'wx', mode: 0o600 });
    const report = { ...result }; delete report.candidate;
    fs.writeFileSync(path.join(actualOutput, 'preparation.json'), JSON.stringify(report, null, 2) + '\n', { flag: 'wx', mode: 0o600 });
    return report;
  } catch (error) {
    fs.rmSync(actualOutput, { recursive: true, force: true });
    throw error;
  }
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  if (process.argv.length !== 5) {
    console.error('Usage: node scripts/prepare_subscription_booking_transport.mjs <authorized-fresh-workspace> <new-external-output-directory> <reviewed-router-sha256>');
    process.exitCode = 1;
  } else {
    try { console.log(JSON.stringify(prepareArtifacts(...process.argv.slice(2)))); }
    catch { console.error('BOOKING_TRANSPORT_PREPARATION_FAILED'); process.exitCode = 1; }
  }
}
