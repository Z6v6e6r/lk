#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { verifyWorkspace } from './verify_nodered_source_origin.mjs';
import { patchResultAuthTransport, sha256 } from './lib/resultAuthTransport.mjs';

export function buildCandidate(workspace, outDir) {
  const root = fs.realpathSync(path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..'));
  if (!path.isAbsolute(outDir)) throw new Error('Output must be an absolute external path');
  const dest = path.join(fs.realpathSync(path.dirname(outDir)), path.basename(outDir));
  if (dest !== outDir || dest === root || dest.startsWith(`${root}/`)) throw new Error('Output must be canonical and outside repository');
  if (fs.existsSync(dest) || fs.lstatSync(path.dirname(dest)).isSymbolicLink()) throw new Error('Output must be new');
  const verified = verifyWorkspace(workspace, { quiet: true });
  const read = (file) => fs.readFileSync(path.join(root, 'scripts/nodered_result_nodes', file), 'utf8');
  const candidate = patchResultAuthTransport(verified.source, {
    budgetSource: read('fn_result_auth_request_budget.js'),
    failureSource: read('fn_result_auth_transport_error.js'),
  });
  const serialized = `${JSON.stringify(candidate, null, 2)}\n`;
  const report = {
    sourceSha256: verified.sourceSha256, candidateSha256: sha256(serialized),
    sourceNodeCount: verified.source.length, candidateNodeCount: candidate.length,
    changedExistingNodes: 1, addedNodes: 3, changedAuthFunctions: 0,
    profileRequestTimeoutMs: 10000, liveApply: false,
  };
  fs.mkdirSync(dest, { mode: 0o700 });
  fs.writeFileSync(path.join(dest, 'candidate.flow.json'), serialized, { flag: 'wx', mode: 0o600 });
  fs.writeFileSync(path.join(dest, 'report.json'), `${JSON.stringify(report, null, 2)}\n`, { flag: 'wx', mode: 0o600 });
  return report;
}
if (process.argv[1] && fs.realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2);
  if (args.length !== 4 || args[0] !== '--workspace' || args[2] !== '--out-dir') {
    throw new Error('Usage: --workspace <verified-private-live-workspace> --out-dir <new-external-directory>');
  }
  process.stdout.write(`${JSON.stringify(buildCandidate(args[1], args[3]))}\n`);
}
