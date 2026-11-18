#!/usr/bin/env node
// Source-preserving PR374 activation. Never calls a provider or deploys a flow.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { verifyWorkspace } from './verify_nodered_source_origin.mjs';
import { buildExactGraphContract, validateReviewedFlowContract } from './nodered_reviewed_flow_deploy/runtime_contract.mjs';

const root = path.dirname(fileURLToPath(import.meta.url));
const routerId = 'lk_subscription_price_preview_20260908_router';
const sha = value => crypto.createHash('sha256').update(value).digest('hex');
const start = "if (ctx.step === 'activeBookings' || ctx.step === 'historyBookings') {";
const end = "  if (ctx.step === 'activeBookings') {";
export const ORIGINAL_BOOKINGS_GUARD = `${start}
  if (!ok() || !canonical.hasCompleteBookingList(msg.payload) || rows().some(row => !canonical.isObj(row)
    || !canonical.bookingId(row) || (canonical.bookingClientId(row) && canonical.normalizeId(canonical.bookingClientId(row)) !== canonical.normalizeId(ctx.actorClientId)))) return stop('PRICE_PREVIEW_BOOKINGS_INCOMPLETE');
`;

export function composePreviewBookingsRelease(liveBytes, { release, expectedSourceSha256, expectedRouterSha256 } = {}) {
  if (!/^[a-f0-9]{40}$/.test(release || '')
    || !/^[a-f0-9]{64}$/.test(expectedSourceSha256 || '')
    || !/^[a-f0-9]{64}$/.test(expectedRouterSha256 || '')) throw Error('PREVIEW_BOOKINGS_EXACT_IDENTITY_REQUIRED');
  if (sha(liveBytes) !== expectedSourceSha256) throw Error('PREVIEW_BOOKINGS_FLOW_DRIFT');
  const flow = JSON.parse(liveBytes);
  if (!Array.isArray(flow) || flow.some(n => !n || typeof n.id !== 'string')
    || new Set(flow.map(n => n.id)).size !== flow.length) throw Error('PREVIEW_BOOKINGS_GRAPH_DRIFT');
  const router = flow.find(n => n.id === routerId);
  if (!router || router.type !== 'function' || router.d === true || router.disabled === true
    || flow.find(n => n.id === router.z)?.disabled === true
    || sha(router.func || '') !== expectedRouterSha256) throw Error('PREVIEW_BOOKINGS_ROUTER_DRIFT');
  if (/\blkBookingsDiagnostic\b/.test(router.func)
    || router.func.split(ORIGINAL_BOOKINGS_GUARD).length !== 2) throw Error('PREVIEW_BOOKINGS_GUARD_DRIFT');

  const tracked = fs.readFileSync(path.join(root, 'nodered_subscription_price_preview_nodes/router.js'), 'utf8');
  const a = tracked.indexOf(start), b = tracked.indexOf(end, a);
  const emitterStart = "    if (fields.code === 'PRICE_PREVIEW_BOOKINGS_INCOMPLETE') {";
  const emitterEnd = '    const reasons = ';
  const c = tracked.indexOf(emitterStart), d = tracked.indexOf(emitterEnd, c);
  if (a < 0 || b < a || c < 0 || d < c || tracked.indexOf(start, a + 1) !== -1
    || tracked.indexOf(emitterStart, c + 1) !== -1) throw Error('PREVIEW_BOOKINGS_SOURCE_ANCHOR_DRIFT');
  const sourceGuard = tracked.slice(a, b);
  if (sourceGuard.split('lkDiagnostic(').length !== 2) throw Error('PREVIEW_BOOKINGS_EMITTER_CALL_DRIFT');
  // Use the reviewed enum-only info fallback directly. A live scoped cross-day
  // observer may silently ignore this code; its own adapter/lifecycle stays intact.
  const guard = sourceGuard.replace('lkDiagnostic(', 'lkBookingsDiagnostic(');
  const prefix = `// PR374 bookings diagnostics; source ${release}; business preimage ${expectedRouterSha256}.
const lkBookingsDiagnostic = (fields = {}) => {
  try {
${tracked.slice(c, d)}  } catch { /* Optional diagnostics never alter the guard. */ }
};
`;
  const original = router.func;
  router.func = prefix + original.replace(ORIGINAL_BOOKINGS_GUARD, guard);
  if (router.func.slice(prefix.length).replace(guard, ORIGINAL_BOOKINGS_GUARD) !== original) {
    throw Error('PREVIEW_BOOKINGS_BUSINESS_DRIFT');
  }
  new Function(router.func);
  const candidateBytes = Buffer.from(JSON.stringify(flow, null, 2) + '\n');
  const contract = buildExactGraphContract({ liveBytes, candidateBytes,
    deploymentId: 'preview-bookings-diagnostics-374', allowedChanges: [{ id: routerId, fields: ['func'] }], allowedAdditionIds: [] });
  validateReviewedFlowContract({ liveBytes, candidateBytes, contract });
  return { candidateBytes, contract, report: { sourceCommit: release,
    sourceSha256: sha(liveBytes), candidateSha256: sha(candidateBytes),
    sourceRouterSha256: expectedRouterSha256, routerSha256: sha(router.func),
    nodeCount: flow.length, changedNodeCount: 1, changedFields: ['func'],
    originalRecoveredExactly: true, lifecyclePreserved: true, topologyPreserved: true,
    emitter: 'enum-only-info-fallback', newProviderRequests: 0, liveMutationPerformed: false } };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const [workspace, directory, release, expectedSourceSha256, expectedRouterSha256] = process.argv.slice(2);
  const verified = verifyWorkspace(workspace, { quiet: true });
  const repository = path.dirname(root);
  const git = args => execFileSync('git', args, { cwd: repository, encoding: 'utf8' }).trim();
  if (git(['rev-parse', 'HEAD']) !== release || git(['status', '--porcelain'])) throw Error('PREVIEW_BOOKINGS_CLEAN_HEAD_REQUIRED');
  if (!path.isAbsolute(directory) || fs.realpathSync(directory) !== directory
    || directory === repository || directory.startsWith(repository + '/')
    || directory === verified.workspace || directory.startsWith(verified.workspace + '/')
    || (fs.statSync(directory).mode & 0o077)) throw Error('PREVIEW_BOOKINGS_PRIVATE_OUTPUT_REQUIRED');
  const packet = composePreviewBookingsRelease(fs.readFileSync(verified.sourcePath), { release, expectedSourceSha256, expectedRouterSha256 });
  for (const [name, data] of [['candidate.flow.json', packet.candidateBytes],
    ['contract.json', JSON.stringify(packet.contract, null, 2)], ['report.json', JSON.stringify(packet.report, null, 2)]]) {
    fs.writeFileSync(path.join(directory, name), data, { flag: 'wx', mode: 0o600 });
  }
  console.log(JSON.stringify(packet.report));
}
