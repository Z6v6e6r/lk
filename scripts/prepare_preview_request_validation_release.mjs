#!/usr/bin/env node
// Exact November 12 live activation of merged PR389; never regenerate business helpers.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { buildSync } from 'esbuild';
import { verifyWorkspace } from './verify_nodered_source_origin.mjs';
import { buildExactGraphContract, validateReviewedFlowContract } from './nodered_reviewed_flow_deploy/runtime_contract.mjs';

const root = path.dirname(fileURLToPath(import.meta.url));
const sha = value => crypto.createHash('sha256').update(value).digest('hex');
const read = name => fs.readFileSync(path.join(root, name), 'utf8');
export const PREVIEW_VALIDATION_SOURCE = '279f63c7dd6223d9695e041b75a051bb29102b970e8cfd81c6c5616f90ad6e9f';
export const PREVIEW_VALIDATION_ENTRY = '9e8b52eb081c55160c457e702174dda9fa35ca5e30c03fa27347f5e99e546cb2';
export const PREVIEW_VALIDATION_FINAL = '144bd78464f873da2d76fbfe941664faa8cf9642456a425f5d57cc9ea354edcf';
const reviewedEntry = '35d4eb647f5c9ba11192d9daa7438f0bfa4b937ff1af229716318e7cf3b20219';
const prefix = 'lk_subscription_price_preview_20260908_';
const owner = 'preview-request-validation-v1';
const slot = '__lkPreview389Observer';

export function previewValidationLifecycle(release, sourceHash, entryHash) {
  if (!/^[a-f0-9]{40}$/.test(release || '') || ![sourceHash, entryHash].every(h => /^[a-f0-9]{64}$/.test(h || ''))) throw Error('PREVIEW_VALIDATION_IDENTITY_REQUIRED');
  const bundle = buildSync({ entryPoints: [path.join(root, 'diagnostics/preview-request-validation-observer.mjs')], bundle: true,
    platform: 'node', format: 'cjs', target: 'node22', write: false, legalComments: 'none',
    external: ['node:crypto', 'node:perf_hooks'] }).outputFiles[0].text;
  const schemaSha256 = sha(fs.readFileSync(path.join(root, '../docs/diagnostics/schema.v1.json')));
  const bundleSha256 = sha(bundle);
  const marker = { event: 'preview_request_validation_observer_ready', schemaVersion: 1, fieldCount: 2,
    schemaSha256, bundleSha256, sourceHash, entryHash, release };
  const initialize = `try {
  const prior = globalThis.${slot};
  if (prior !== undefined && prior?.owner !== '${owner}') throw Error('PREVIEW_VALIDATION_SLOT_CONFLICT');
  if (prior) { delete globalThis.${slot}; prior.dispose(); }
  const module = { exports: {} };
  const require = name => {
    if (name === 'node:crypto') return preview389Crypto;
    if (name === 'node:perf_hooks') return preview389Performance;
    throw Error('PREVIEW_VALIDATION_MODULE_REFUSED');
  };
${bundle}
  if (typeof preview389Crypto.randomUUID !== 'function' || typeof preview389Performance.performance?.now !== 'function') throw Error('PREVIEW_VALIDATION_NATIVE_MODULE_INVALID');
  const observer = module.exports.createPreviewRequestValidationObserver({ release: '${release}', sourceHash: '${sourceHash}',
    sink: event => node.warn(new Date().toISOString() + ' ' + JSON.stringify({ event: 'preview_request_validation_guard_diagnostic', ...event })) });
  globalThis.${slot} = observer;
  node.warn(new Date().toISOString() + ' ' + JSON.stringify(${JSON.stringify(marker)}));
} catch {
  try { node.warn(new Date().toISOString() + ' ' + JSON.stringify({ event: 'preview_request_validation_observer_unavailable' })); } catch { /* no-throw */ }
}
`;
  const finalize = `try { const own = globalThis.${slot}; if (own?.owner === '${owner}') { delete globalThis.${slot}; own.dispose(); } } catch { /* no-throw */ }\n`;
  const libs = [{ var: 'preview389Crypto', module: 'crypto' }, { var: 'preview389Performance', module: 'perf_hooks' }];
  return { initialize, finalize, libs, marker, schemaSha256, bundleSha256 };
}

export function composePreviewRequestValidationRelease(liveBytes, release) {
  if (!/^[a-f0-9]{40}$/.test(release || '')) throw Error('PREVIEW_VALIDATION_COMMIT_REQUIRED');
  if (sha(liveBytes) !== PREVIEW_VALIDATION_SOURCE) throw Error('PREVIEW_VALIDATION_FLOW_DRIFT');
  const flow = JSON.parse(liveBytes);
  if (flow.length !== 4985 || new Set(flow.map(n => n.id)).size !== flow.length) throw Error('PREVIEW_VALIDATION_GRAPH_DRIFT');
  const get = (role, expected) => {
    const matches = flow.filter(n => n.id === prefix + role);
    const n = matches[0];
    if (matches.length !== 1 || n.type !== 'function' || n.d === true || n.disabled === true
      || flow.find(t => t.id === n.z)?.disabled === true || sha(n.func) !== expected
      || n.initialize || n.finalize || n.libs?.length) throw Error('PREVIEW_VALIDATION_NODE_DRIFT');
    return n;
  };
  const entry = get('entry', PREVIEW_VALIDATION_ENTRY), final = get('final', PREVIEW_VALIDATION_FINAL);
  const tracked = read('nodered_subscription_price_preview_nodes/entry.js');
  if (sha(tracked) !== reviewedEntry || tracked.split('const body = msg.payload;').length !== 2) throw Error('PREVIEW_VALIDATION_REVIEWED_ENTRY_DRIFT');
  entry.func = tracked.slice(tracked.indexOf('const body = msg.payload;'));
  const originalFinal = final.func;
  const anchor = 'if (ctx.done && ctx.error) {\n';
  if (originalFinal.split(anchor).length !== 2) throw Error('PREVIEW_VALIDATION_FINAL_ANCHOR_DRIFT');
  const observation = `  try {
    const observer = globalThis.${slot};
    if (observer?.owner === '${owner}') observer.observe(msg, 'preview_final');
  } catch { /* Optional diagnostics cannot change the response or legacy warning. */ }
`;
  final.func = originalFinal.replace(anchor, anchor + observation);
  if (final.func.replace(anchor + observation, anchor) !== originalFinal) throw Error('PREVIEW_VALIDATION_FINAL_BUSINESS_DRIFT');
  const lifecycle = previewValidationLifecycle(release, sha(final.func), sha(entry.func));
  Object.assign(final, { initialize: lifecycle.initialize, finalize: lifecycle.finalize, libs: lifecycle.libs });
  for (const n of [entry, final]) for (const f of ['func', 'initialize', 'finalize']) if (n[f]) new Function(n[f]);
  const candidateBytes = Buffer.from(JSON.stringify(flow, null, 2) + '\n');
  const allowedChanges = [{ id: entry.id, fields: ['func'] }, { id: final.id, fields: ['func', 'initialize', 'finalize', 'libs'] }];
  const contract = buildExactGraphContract({ liveBytes, candidateBytes, deploymentId: 'preview-request-validation-389', allowedChanges, allowedAdditionIds: [] });
  validateReviewedFlowContract({ liveBytes, candidateBytes, contract });
  return { candidateBytes, contract, marker: lifecycle.marker, report: { sourceSha256: sha(liveBytes), candidateSha256: sha(candidateBytes),
    sourceCommit: release, mergedBusinessCommit: 'ce96d47b60d4e2cd16e942614edf8dcc4eff13c9', changedNodeCount: 2,
    entrySha256: sha(entry.func), finalSha256: sha(final.func), initializeSha256: sha(final.initialize), finalizeSha256: sha(final.finalize),
    schemaSha256: lifecycle.schemaSha256, bundleSha256: lifecycle.bundleSha256,
    settingsChanged: false, topologyChanged: false, globalContextChanged: false, packageInstallRequired: false, liveMutationPerformed: false } };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const [workspace, directory, release] = process.argv.slice(2);
  const verified = verifyWorkspace(workspace, { quiet: true });
  const repository = path.dirname(root);
  const git = args => execFileSync('git', args, { cwd: repository, encoding: 'utf8' }).trim();
  if (git(['rev-parse', 'HEAD']) !== release || git(['status', '--porcelain'])) throw Error('PREVIEW_VALIDATION_CLEAN_HEAD_REQUIRED');
  if (!path.isAbsolute(directory) || fs.realpathSync(directory) !== directory
    || directory === repository || directory.startsWith(repository + '/')
    || directory === verified.workspace || directory.startsWith(verified.workspace + '/')
    || (fs.statSync(directory).mode & 0o077)) throw Error('PREVIEW_VALIDATION_PRIVATE_OUTPUT_REQUIRED');
  const packet = composePreviewRequestValidationRelease(fs.readFileSync(verified.sourcePath), release);
  for (const [name, data] of [['candidate.flow.json', packet.candidateBytes], ['contract.json', JSON.stringify(packet.contract, null, 2)],
    ['report.json', JSON.stringify(packet.report, null, 2)], ['startup-marker.json', JSON.stringify(packet.marker, null, 2)]]) {
    fs.writeFileSync(path.join(directory, name), data, { flag: 'wx', mode: 0o600 });
  }
  console.log(JSON.stringify(packet.report));
}
