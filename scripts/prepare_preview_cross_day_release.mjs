#!/usr/bin/env node
// Exact live backport: one function node, complete flow-contained observer lifecycle.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { buildSync } from 'esbuild';
import { verifyWorkspace } from './verify_nodered_source_origin.mjs';
import { buildExactGraphContract, validateReviewedFlowContract } from './nodered_reviewed_flow_deploy/runtime_contract.mjs';
const root = path.dirname(fileURLToPath(import.meta.url));
export const PREVIEW_RELEASE_SOURCE = '35eade1be234c192df58780a415dfdb9b1d060784ba35ea1b7be301dc4544b5e';
export const PREVIEW_RELEASE_ROUTER = '1139b85ce9bfe126a87cb2b705e92bd64d57a7f81d5af5708ebcd504446f42a3';
const id = 'lk_subscription_price_preview_20260908_router';
const owner = 'preview-cross-day-v1';
const slot = '__lkPreview350Observer';
const sha = value => crypto.createHash('sha256').update(value).digest('hex');
const read = name => fs.readFileSync(path.join(root, name), 'utf8');
export function previewCrossDayLifecycle(release) {
  if (!/^[a-f0-9]{40}$/.test(release || '')) throw Error('PREVIEW_RELEASE_COMMIT_REQUIRED');
  const bundle = buildSync({ entryPoints: [path.join(root, 'diagnostics/preview-cross-day-observer.mjs')], bundle: true,
    platform: 'node', format: 'cjs', target: 'node22', write: false, legalComments: 'none',
    external: ['node:crypto', 'node:perf_hooks'] }).outputFiles[0].text;
  const schemaSha256 = sha(fs.readFileSync(path.join(root, '../docs/diagnostics/schema.v1.json')));
  const bundleSha256 = sha(bundle);
  const marker = { event: 'preview_cross_day_observer_ready', schemaVersion: 1, fieldCount: 11,
    schemaSha256, bundleSha256, sourceHash: PREVIEW_RELEASE_ROUTER, release };
  const initialize = `try {\n  const prior = globalThis.${slot};\n  if (prior !== undefined && prior?.owner !== '${owner}') throw Error('PREVIEW_DIAGNOSTIC_SLOT_CONFLICT');\n  if (prior) { delete globalThis.${slot}; prior.dispose(); }\n  const module = { exports: {} };\n  const require = name => {\n    if (name === 'node:crypto') return preview350Crypto;\n    if (name === 'node:perf_hooks') return preview350Performance;\n    throw Error('PREVIEW_DIAGNOSTIC_MODULE_REFUSED');\n  };\n${bundle}\n  if (typeof preview350Crypto.randomUUID !== 'function' || typeof preview350Performance.performance?.now !== 'function') throw Error('PREVIEW_DIAGNOSTIC_NATIVE_MODULE_INVALID');\n  const observer = module.exports.createPreviewCrossDayObserver({ release: '${release}', sourceHash: '${PREVIEW_RELEASE_ROUTER}',\n    sink: event => node.warn(new Date().toISOString() + ' ' + JSON.stringify({ event: 'preview_cross_day_guard_diagnostic', ...event })) });\n  globalThis.${slot} = observer;\n  node.warn(new Date().toISOString() + ' ' + JSON.stringify(${JSON.stringify(marker)}));\n} catch {\n  try { node.warn(new Date().toISOString() + ' ' + JSON.stringify({ event: 'preview_cross_day_observer_unavailable' })); } catch { /* no-throw */ }\n}\n`;
  const finalize = `try { const own = globalThis.${slot}; if (own?.owner === '${owner}') { delete globalThis.${slot}; own.dispose(); } } catch { /* no-throw */ }\n`;
  const libs = [{ var: 'preview350Crypto', module: 'crypto' }, { var: 'preview350Performance', module: 'perf_hooks' }];
  return { initialize, finalize, libs, marker, schemaSha256, bundleSha256 };
}
export function composePreviewCrossDayRelease(liveBytes, release) {
  if (!/^[a-f0-9]{40}$/.test(release || '')) throw Error('PREVIEW_RELEASE_COMMIT_REQUIRED');
  if (sha(liveBytes) !== PREVIEW_RELEASE_SOURCE) throw Error('PREVIEW_RELEASE_FLOW_DRIFT');
  const flow = JSON.parse(liveBytes);
  if (flow.length !== 4985 || new Set(flow.map(n => n.id)).size !== flow.length) throw Error('PREVIEW_RELEASE_GRAPH_DRIFT');
  const router = flow.find(n => n.id === id);
  if (!router || router.type !== 'function' || router.d === true || router.disabled === true
    || flow.find(n => n.id === router.z)?.disabled === true || sha(router.func) !== PREVIEW_RELEASE_ROUTER
    || router.initialize || router.finalize || router.libs?.length) throw Error('PREVIEW_RELEASE_ROUTER_DRIFT');
  const tracked = read('nodered_subscription_price_preview_nodes/router.js');
  const anchor = "  if (localEnd.slice(0, 10) !== ctx.target.startsAt.slice(0, 10))";
  const old = anchor + " return stop('PRICE_PREVIEW_CROSS_DAY_UNRESOLVED');";
  const end = '  // Function nodes do not expose Node.js URLSearchParams';
  const a = tracked.indexOf(anchor), b = tracked.indexOf(end, a);
  if (a < 0 || b < 0 || tracked.indexOf(anchor, a + 1) !== -1 || router.func.split(old).length !== 2) throw Error('PREVIEW_RELEASE_ANCHOR_DRIFT');
  const branch = tracked.slice(a, b).trimEnd();
  const prefix = `// Scoped PR350 diagnostic adapter; business preimage ${PREVIEW_RELEASE_ROUTER}.\nconst lkDiagnostic = (fields = {}) => {\n  try {\n    const observer = globalThis.${slot};\n    if (observer?.owner === '${owner}') observer.observe(msg, 'preview_router', fields);\n  } catch { /* Optional diagnostics never alter the guard. */ }\n};\n`;
  const original = router.func;
  router.func = prefix + original.replace(old, branch);
  if (router.func.slice(prefix.length).replace(branch, old) !== original) throw Error('PREVIEW_RELEASE_BUSINESS_DRIFT');
  const lifecycle = previewCrossDayLifecycle(release);
  const { marker, schemaSha256, bundleSha256 } = lifecycle;
  Object.assign(router, { initialize: lifecycle.initialize, finalize: lifecycle.finalize, libs: lifecycle.libs });
  for (const field of ['func', 'initialize', 'finalize']) new Function(router[field]);
  const candidateBytes = Buffer.from(JSON.stringify(flow, null, 2) + '\n');
  const allowedChanges = [{ id, fields: ['func', 'initialize', 'finalize', 'libs'] }];
  const contract = buildExactGraphContract({ liveBytes, candidateBytes, deploymentId: 'preview-cross-day-diagnostics-350', allowedChanges, allowedAdditionIds: [] });
  validateReviewedFlowContract({ liveBytes, candidateBytes, contract });
  return { candidateBytes, contract, marker, report: { sourceSha256: sha(liveBytes), candidateSha256: sha(candidateBytes),
    sourceCommit: release, changedNodeCount: 1, changedFields: allowedChanges[0].fields,
    routerSha256: sha(router.func), initializeSha256: sha(router.initialize), finalizeSha256: sha(router.finalize),
    schemaSha256, bundleSha256, settingsChanged: false, topologyChanged: false,
    globalContextChanged: false, packageInstallRequired: false, liveMutationPerformed: false } };
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const [workspace, directory, release] = process.argv.slice(2);
  const verified = verifyWorkspace(workspace, { quiet: true });
  const repository = path.dirname(root);
  const git = args => execFileSync('git', args, { cwd: repository, encoding: 'utf8' }).trim();
  if (git(['rev-parse', 'HEAD']) !== release || git(['status', '--porcelain'])) throw Error('PREVIEW_RELEASE_CLEAN_HEAD_REQUIRED');
  if (!path.isAbsolute(directory) || fs.realpathSync(directory) !== directory
    || directory === repository || directory.startsWith(repository + '/')
    || directory === verified.workspace || directory.startsWith(verified.workspace + '/')
    || (fs.statSync(directory).mode & 0o077)) throw Error('PREVIEW_RELEASE_PRIVATE_OUTPUT_REQUIRED');
  const packet = composePreviewCrossDayRelease(fs.readFileSync(verified.sourcePath), release);
  for (const [name, data] of [['candidate.flow.json', packet.candidateBytes], ['contract.json', JSON.stringify(packet.contract, null, 2)],
    ['report.json', JSON.stringify(packet.report, null, 2)], ['startup-marker.json', JSON.stringify(packet.marker, null, 2)]]) {
    fs.writeFileSync(path.join(directory, name), data, { flag: 'wx', mode: 0o600 });
  }
  console.log(JSON.stringify(packet.report));
}
