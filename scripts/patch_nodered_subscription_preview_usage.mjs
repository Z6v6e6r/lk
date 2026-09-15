import crypto from 'node:crypto';
import { patchPaidBenefitUsage } from './patch_nodered_subscription_paid_join.mjs';
import { buildExactGraphContract, validateReviewedFlowContract } from './nodered_reviewed_flow_deploy/runtime_contract.mjs';

export const PREVIEW_ROUTER_ID = 'lk_subscription_price_preview_20260908_router';
export const PREVIEW_USAGE_PREIMAGE = '62ed17c93f6bef08877e3a8b02f93f2dc17ad293ae81768bffdb1e97fc1bd5df';
const sha = value => crypto.createHash('sha256').update(value).digest('hex');
const replaceOnce = (source, before, after) => {
  if (source.split(before).length !== 2) throw new Error('Preview usage source anchor drift');
  return source.replace(before, after);
};

// The installed query already reads all dates. Keep that query and the historical
// paid-join composer unchanged; reuse its allowance and benefit-counting rules.
export function patchSubscriptionPreviewUsage(source) {
  let result = patchPaidBenefitUsage(source);
  result = replaceOnce(result, 'return {isObj,unwrapRecord,', 'return {isObj,isValidDateKey,unwrapRecord,');
  return replaceOnce(result, 'const { isObj, normalizeId, isInactiveBooking,',
    'const { isObj, isValidDateKey, normalizeId, isInactiveBooking,');
}

// Local candidate construction only: no transport, deployment or data mutation.
export function composeSubscriptionPreviewUsageArtifacts(liveBytes, deploymentId) {
  const candidate = JSON.parse(Buffer.from(liveBytes).toString('utf8'));
  if (!Array.isArray(candidate) || candidate.some(row => !row || typeof row.id !== 'string')
    || new Set(candidate.map(row => row.id)).size !== candidate.length) {
    throw new Error('Invalid preview usage source flow');
  }
  const router = candidate.find(row => row.id === PREVIEW_ROUTER_ID);
  if (router?.type !== 'function' || typeof router.func !== 'string'
    || sha(router.func) !== PREVIEW_USAGE_PREIMAGE) throw new Error('Preview usage preimage drift');
  router.func = patchSubscriptionPreviewUsage(router.func);
  new Function('msg', 'node', 'env', 'global', router.func);
  const candidateBytes = Buffer.from(`${JSON.stringify(candidate, null, 2)}\n`);
  const contract = buildExactGraphContract({ liveBytes, candidateBytes, deploymentId,
    allowedChanges: [{ id: PREVIEW_ROUTER_ID, fields: ['func'] }] });
  validateReviewedFlowContract({ liveBytes, candidateBytes, contract });
  return { candidate, candidateBytes, contract };
}
