import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { isDeepStrictEqual } from 'node:util';
import { UNPAID_SOURCE_FILES } from './lib/unpaidWorkerSourceFiles.mjs';
import { deriveWorkerGeneration, validateLiveProof, materializeFromProof } from './lib/bookingTransportRelease.mjs';
import { sha256 } from './lib/subscriptionBookingTransportRecovery.mjs';
import { verifyBundle } from './lk1_unpaid_cancel_service/verify_bundle.mjs';

const root = fs.realpathSync(path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..'));
const json = value => JSON.stringify(value, null, 2) + '\n';
const write = (file, bytes) => fs.writeFileSync(file, bytes, { flag: 'wx', mode: 0o600 });
const packetFiles = ['live-proof.json', 'flow-delta.json', 'flow-contract.json', 'worker-derivation.json',
  ...['worker', 'rollback-worker'].flatMap(dir => ['manifest.json', ...Object.keys(UNPAID_SOURCE_FILES)].map(file => `${dir}/${file}`))];
const readPrivate = file => {
  const stat = fs.lstatSync(file), parent = fs.lstatSync(path.dirname(file));
  if (!path.isAbsolute(file) || fs.realpathSync(file) !== file || !stat.isFile() || stat.isSymbolicLink()
    || stat.nlink !== 1 || stat.uid !== process.getuid() || (stat.mode & 0o077)
    || !parent.isDirectory() || (parent.mode & 0o077) || parent.uid !== process.getuid()) throw new Error('PRIVATE_ARTIFACT_REQUIRED');
  return fs.readFileSync(file);
};
const newExternal = directory => {
  if (!path.isAbsolute(directory) || fs.existsSync(directory)) throw new Error('NEW_EXTERNAL_OUTPUT_REQUIRED');
  const parent = path.dirname(directory), s = fs.lstatSync(parent);
  if (!s.isDirectory() || s.isSymbolicLink() || s.uid !== process.getuid() || (s.mode & 0o077) || fs.realpathSync(parent) !== parent) throw new Error('PRIVATE_OUTPUT_PARENT_REQUIRED');
  let inGit = false;
  try { execFileSync('git', ['-C', parent, 'rev-parse', '--show-toplevel'], { stdio: 'ignore' }); inGit = true; } catch { /* external */ }
  if (inGit) throw new Error('OUTPUT_INSIDE_GIT');
  fs.mkdirSync(directory, { mode: 0o700 });
};

export function prepareRelease(proofFile, expectedProofSha, outputDirectory) {
  const bytes = readPrivate(proofFile);
  if (sha256(bytes) !== expectedProofSha) throw new Error('LIVE_PROOF_DIGEST_MISMATCH');
  const proof = validateLiveProof(JSON.parse(bytes));
  if (execFileSync('git', ['status', '--porcelain', '--untracked-files=all'], { cwd: root, encoding: 'utf8' }).trim()) throw new Error('SOURCE_TREE_NOT_CLEAN');
  const builderCommit = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim();
  const files = Object.fromEntries(Object.entries(UNPAID_SOURCE_FILES).map(([name, relative]) => {
    const full = path.join(root, relative), s = fs.lstatSync(full);
    if (!s.isFile() || s.isSymbolicLink() || s.nlink !== 1) throw new Error('WORKER_SOURCE_INVALID');
    return [name, fs.readFileSync(full)];
  }));
  const generated = deriveWorkerGeneration(proof, files, builderCommit);
  newExternal(outputDirectory);
  try {
    for (const [name, content, manifest] of [['worker', generated.files, generated.manifest], ['rollback-worker', files, proof.worker.baseManifest]]) {
      const dir = path.join(outputDirectory, name); fs.mkdirSync(dir, { mode: 0o700 }); fs.mkdirSync(path.join(dir, 'lib'), { mode: 0o700 });
      for (const [file, body] of Object.entries(content)) write(path.join(dir, file), body);
      write(path.join(dir, 'manifest.json'), json(manifest));
      verifyBundle(dir, { expectedManifestSha: sha256(json(manifest)) });
    }
    write(path.join(outputDirectory, 'live-proof.json'), bytes);
    write(path.join(outputDirectory, 'flow-delta.json'), json(proof.additions));
    write(path.join(outputDirectory, 'flow-contract.json'), json(proof.exactGraphContract));
    write(path.join(outputDirectory, 'worker-derivation.json'), json(generated.derivation));
    const result = { schema: 1, builderCommit, readyForDeployment: true, liveProofSha256: expectedProofSha,
      readinessScope: 'EXACT_BOOKING_FLOW_AND_UNPAID_WORKER_PAIR',
      sourceFlowSha256: proof.sourceSha256, candidateFlowSha256: proof.candidateSha256,
      workerManifestSha256: generated.derivation.generatedManifestSha256,
      rollbackManifestSha256: proof.worker.baseManifestSha256,
      unchangedEnvironmentSha256: proof.worker.environmentSha256, unchangedUnitSha256: proof.worker.unitSha256,
      retainedAuthModuleRefs: proof.worker.retainedAuthModuleRefs,
      artifacts: Object.fromEntries(packetFiles.map(name => [name, sha256(readPrivate(path.join(outputDirectory, name)))])),
      requiresFreshPreflightAtApply: true, requiresSeparateProductionApproval: true,
      productionChanged: false, businessRequests: 0 };
    write(path.join(outputDirectory, 'release.json'), json(result));
    return { ...result, releaseSha256: sha256(json(result)) };
  } catch (error) { fs.rmSync(outputDirectory, { recursive: true, force: true }); throw error; }
}

// Optional LOCAL materialization only. Do not invoke on production before the
// separately approved cutover. Source backup is exact, not reverse-serialized.
export function verifyReleasePacket(packet, expectedReleaseSha) {
  const releaseBytes = readPrivate(path.join(packet, 'release.json'));
  if (!/^[a-f0-9]{64}$/.test(expectedReleaseSha || '') || sha256(releaseBytes) !== expectedReleaseSha) throw new Error('PACKET_INDEX_DRIFT');
  const release = JSON.parse(releaseBytes);
  if (release.schema !== 1 || release.readyForDeployment !== true
    || release.readinessScope !== 'EXACT_BOOKING_FLOW_AND_UNPAID_WORKER_PAIR'
    || release.requiresFreshPreflightAtApply !== true || release.requiresSeparateProductionApproval !== true
    || release.productionChanged !== false || release.businessRequests !== 0
    || !isDeepStrictEqual(Object.keys(release.artifacts || {}).sort(), [...packetFiles].sort())
    || !isDeepStrictEqual(fs.readdirSync(packet).sort(), ['release.json', 'worker', 'rollback-worker', ...packetFiles.filter(p => !p.includes('/'))].sort())
    || packetFiles.some(name => sha256(readPrivate(path.join(packet, name))) !== release.artifacts[name])) throw new Error('PACKET_ARTIFACT_DRIFT');
  const proofBytes = readPrivate(path.join(packet, 'live-proof.json'));
  if (sha256(proofBytes) !== release.liveProofSha256) throw new Error('PACKET_PROOF_DRIFT');
  const proof = validateLiveProof(JSON.parse(proofBytes));
  const baseFiles = Object.fromEntries(Object.keys(UNPAID_SOURCE_FILES).map(name => [name, readPrivate(path.join(packet, 'rollback-worker', name))]));
  const generated = deriveWorkerGeneration(proof, baseFiles, release.builderCommit);
  verifyBundle(path.join(packet, 'worker'), { expectedManifestSha: release.workerManifestSha256 });
  verifyBundle(path.join(packet, 'rollback-worker'), { expectedManifestSha: release.rollbackManifestSha256 });
  if (release.sourceFlowSha256 !== proof.sourceSha256 || release.candidateFlowSha256 !== proof.candidateSha256
    || release.rollbackManifestSha256 !== proof.worker.baseManifestSha256
    || release.unchangedEnvironmentSha256 !== proof.worker.environmentSha256 || release.unchangedUnitSha256 !== proof.worker.unitSha256
    || !isDeepStrictEqual(release.retainedAuthModuleRefs, proof.worker.retainedAuthModuleRefs)
    || generated.derivation.generatedManifestSha256 !== release.workerManifestSha256
    || !isDeepStrictEqual(JSON.parse(readPrivate(path.join(packet, 'worker-derivation.json'))), generated.derivation)
    || !isDeepStrictEqual(JSON.parse(readPrivate(path.join(packet, 'flow-delta.json'))), proof.additions)
    || !isDeepStrictEqual(JSON.parse(readPrivate(path.join(packet, 'flow-contract.json'))), proof.exactGraphContract)) throw new Error('PACKET_DERIVATION_DRIFT');
  return { release, proof };
}
export function materializePacket(packet, expectedReleaseSha, sourceFile, outputDirectory) {
  const { proof, release } = verifyReleasePacket(packet, expectedReleaseSha);
  const source = readPrivate(sourceFile), candidate = materializeFromProof(source, proof);
  if (sha256(candidate) !== release.candidateFlowSha256) throw new Error('PACKET_CANDIDATE_DRIFT');
  newExternal(outputDirectory);
  try {
    write(path.join(outputDirectory, 'source.flow.json'), source);
    write(path.join(outputDirectory, 'candidate.flow.json'), candidate);
    write(path.join(outputDirectory, 'contract.json'), json(proof.exactGraphContract));
  } catch (error) { fs.rmSync(outputDirectory, { recursive: true, force: true }); throw error; }
  return { sourceSha256: sha256(source), candidateSha256: sha256(candidate) };
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const args = process.argv.slice(2);
    if (args.length === 5 && args[0] === '--materialize') console.log(JSON.stringify(materializePacket(...args.slice(1))));
    else if (args.length === 3 && args[0] === '--verify') console.log(JSON.stringify(verifyReleasePacket(...args.slice(1)).release));
    else if (args.length === 3) console.log(JSON.stringify(prepareRelease(...args)));
    else throw new Error('ARGUMENTS_REQUIRED');
  } catch { console.error('BOOKING_TRANSPORT_RELEASE_PREPARATION_FAILED'); process.exitCode = 1; }
}
