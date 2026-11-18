// Focused offline release of paginated history plus the date-exclusion reason.
import fs from 'node:fs';
import crypto from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';
import { verifyWorkspace } from './verify_nodered_source_origin.mjs';
import { composeSubscriptionBookingPagination, assertPrivatePaginationOutput } from './prepare_subscription_booking_pagination.mjs';
import { buildExactGraphContract, validateReviewedFlowContract } from './nodered_reviewed_flow_deploy/runtime_contract.mjs';

const sha = value => crypto.createHash('sha256').update(value).digest('hex');
const bookingId = 'lk_subscription_booking_router_20260804';
const previewId = 'lk_subscription_price_preview_20260908_router';
const source = fs.readFileSync(new URL('./nodered_subscription_price_preview_nodes/router.js', import.meta.url), 'utf8');
const anchor = "  if (!eventRoute && (canonical.preflightAvailability.resolveSplitSubscriptionLifecycle";
const start = '  // A proven date mismatch';
export const subscriptionDateExclusionBlock = source.slice(source.indexOf(start), source.indexOf(anchor, source.indexOf(start)));
if (!subscriptionDateExclusionBlock.startsWith(start) || !subscriptionDateExclusionBlock.includes("quote(id, 'UNAVAILABLE'")) throw Error('SUBSCRIPTION_DATE_SOURCE_DRIFT');

export function composeSubscriptionHistoryRelease(liveBytes, options) {
  const { release, expectedSourceSha256, expectedBookingSha256, expectedPreviewSha256 } = options || {};
  if (!/^[a-f0-9]{40}$/.test(release || '')
    || [expectedSourceSha256, expectedBookingSha256, expectedPreviewSha256].some(s => !/^[a-f0-9]{64}$/.test(s || ''))
    || sha(liveBytes) !== expectedSourceSha256) throw Error('SUBSCRIPTION_HISTORY_EXACT_PREIMAGE_REQUIRED');
  const live = JSON.parse(liveBytes);
  if (!Array.isArray(live) || live.some(n => !n || typeof n.id !== 'string') || new Set(live.map(n => n.id)).size !== live.length) throw Error('SUBSCRIPTION_HISTORY_GRAPH_DRIFT');
  const targets = [bookingId, previewId].map((id, i) => {
    const n = live.find(n => n.id === id);
    if (!n || n.type !== 'function' || n.d === true || n.disabled === true
      || live.find(tab => tab.id === n.z)?.disabled === true
      || sha(n.func || '') !== [expectedBookingSha256, expectedPreviewSha256][i]) throw Error('SUBSCRIPTION_HISTORY_ROUTER_DRIFT');
    return n;
  });
  const paged = targets.map(n => n.func.includes('collectVivaBookingPage'));
  if (paged[0] !== paged[1]) throw Error('SUBSCRIPTION_HISTORY_PARTIAL_PAGINATION');
  // The existing pagination composer proves every inverse and preserves all live-only
  // owner, pricing and diagnostic code. This wrapper adds the date reason in memory;
  // only one combined exact-graph candidate is ever eligible for publication.
  const intermediate = paged[0] ? Buffer.from(liveBytes)
    : composeSubscriptionBookingPagination(liveBytes, options).candidateBytes;
  const candidate = JSON.parse(intermediate);
  const preview = candidate.find(n => n.id === previewId);
  const original = preview.func;
  if (original.includes('SUBSCRIPTION_DATE_NOT_COVERED') || original.split(anchor).length !== 2) throw Error('SUBSCRIPTION_DATE_ANCHOR_DRIFT');
  preview.func = original.replace(anchor, subscriptionDateExclusionBlock + anchor);
  if (preview.func.replace(subscriptionDateExclusionBlock + anchor, anchor) !== original) throw Error('SUBSCRIPTION_DATE_PREIMAGE_NOT_RECOVERED');
  new Function(preview.func);
  const candidateBytes = Buffer.from(JSON.stringify(candidate, null, 2) + '\n');
  const contract = buildExactGraphContract({ liveBytes, candidateBytes, deploymentId: 'subscription-history-date-397',
    allowedChanges: (paged[0] ? [previewId] : [bookingId, previewId]).map(id => ({ id, fields: ['func'] })), allowedAdditionIds: [] });
  validateReviewedFlowContract({ liveBytes, candidateBytes, contract });
  const changed = candidate.filter((n, i) => n.func !== live[i].func).map(n => n.id);
  return { candidateBytes, contract, report: { sourceCommit: release, sourceSha256: sha(liveBytes),
    candidateSha256: sha(candidateBytes), changedNodeIds: changed, changedFields: ['func'],
    paginationAlreadyInstalled: paged[0], datePreimageRecoversExactly: true,
    topologyPreserved: true, liveMutationPerformed: false } };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const [workspace, directory, release, expectedSourceSha256, expectedBookingSha256, expectedPreviewSha256] = process.argv.slice(2);
  const verified = verifyWorkspace(workspace, { quiet: true });
  const repository = path.resolve(fileURLToPath(new URL('..', import.meta.url)));
  const git = args => execFileSync('git', args, { cwd: repository, encoding: 'utf8' }).trim();
  if (git(['rev-parse', 'HEAD']) !== release || git(['status', '--porcelain'])) throw Error('SUBSCRIPTION_HISTORY_CLEAN_HEAD_REQUIRED');
  assertPrivatePaginationOutput(repository, verified.workspace, directory);
  const result = composeSubscriptionHistoryRelease(fs.readFileSync(verified.sourcePath), {
    release, expectedSourceSha256, expectedBookingSha256, expectedPreviewSha256 });
  for (const [name, data] of [['candidate.flow.json', result.candidateBytes], ['contract.json', JSON.stringify(result.contract, null, 2)],
    ['report.json', JSON.stringify(result.report, null, 2)]]) fs.writeFileSync(path.join(directory, name), data, { flag: 'wx', mode: 0o600 });
  console.log(JSON.stringify(result.report));
}
