#!/usr/bin/env node

// Offline only: build an exact-graph candidate from a fresh private pull of 147.
// This command never connects to Node-RED or writes the live flow.
import fs from 'node:fs';
import path from 'node:path';
import { assertExternalWorkspace, verifyWorkspace } from './verify_nodered_source_origin.mjs';
import { composePatriotsArtifacts } from './patch_live_lk1_patriots_friendship.mjs';

const values = new Map();
for (let index = 2; index < process.argv.length; index += 2) {
  const key = process.argv[index];
  const value = process.argv[index + 1];
  if (!['--workspace', '--output-dir'].includes(key) || !value || values.has(key)) {
    throw new Error('Usage: --workspace <fresh private pull> --output-dir <empty private directory>');
  }
  values.set(key, value);
}
if (values.size !== 2) {
  throw new Error('Usage: --workspace <fresh private pull> --output-dir <empty private directory>');
}
const verified = verifyWorkspace(values.get('--workspace'));
const outputDir = assertExternalWorkspace(values.get('--output-dir'));
if (fs.readdirSync(outputDir).length !== 0) throw new Error('Output directory must be empty');
const artifacts = composePatriotsArtifacts(fs.readFileSync(verified.sourcePath));
const report = {
  deploymentPerformed: false,
  liveMutationPerformed: false,
  sourceSha256: artifacts.sourceSha256,
  candidateSha256: artifacts.candidateSha256,
  changedNodeCount: artifacts.changes.length,
  addedNodeCount: 0,
  changes: artifacts.changes,
  postimages: artifacts.postimages,
};
for (const [name, bytes] of [
  ['candidate.flow.json', artifacts.candidateBytes],
  ['contract.json', Buffer.from(`${JSON.stringify(artifacts.contract, null, 2)}\n`)],
  ['report.json', Buffer.from(`${JSON.stringify(report, null, 2)}\n`)],
]) {
  fs.writeFileSync(path.join(outputDir, name), bytes, { flag: 'wx', mode: 0o600 });
}
process.stdout.write(`${JSON.stringify({ sourceSha256: report.sourceSha256,
  candidateSha256: report.candidateSha256, changedNodeCount: report.changedNodeCount })}\n`);
