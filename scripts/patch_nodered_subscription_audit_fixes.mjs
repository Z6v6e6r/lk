import crypto from 'node:crypto';
import { patchPaidBenefitUsage } from './patch_nodered_subscription_paid_join.mjs';
import { patchSubscriptionPreviewUsage } from './patch_nodered_subscription_preview_usage.mjs';
import { patchLeaveRead, patchServiceDate, patchUsageBindings, replaceOnce } from './lib/subscriptionAuditFixes.mjs';
import { buildExactGraphContract, validateReviewedFlowContract } from './nodered_reviewed_flow_deploy/runtime_contract.mjs';

const sha = value => crypto.createHash('sha256').update(value).digest('hex');
export const AUDIT_TARGETS = [
  ['lk_subscription_booking_router_20260804', '510daf6733c2d68fdb6a5e45bf84a81f0b658c394f1bff0da424a40f1a839461'],
  ['lk_subscription_price_preview_20260908_router', '62ed17c93f6bef08877e3a8b02f93f2dc17ad293ae81768bffdb1e97fc1bd5df'],
  ['lk_split_leave_daily_limit_route_20260811', 'ad8a0f1c49a9085ddb64ee042d13c879a75e189a2003c71024b2d0a1d422065a'],
];
export function patchAuditGateway(source) {
  return patchServiceDate(patchUsageBindings(replaceOnce(patchPaidBenefitUsage(source),
    'actorClientId: ctx.actorClientId, serviceDate: ctx.serviceDate,\n      "lk1.rule.productId"',
    'actorClientId: ctx.actorClientId,\n      "lk1.rule.productId"')));
}
export function patchAuditPreview(source) {
  return patchServiceDate(patchUsageBindings(patchSubscriptionPreviewUsage(source)));
}
// Local-only exact graph construction. No import/restart or database writes.
export function composeSubscriptionAuditFixes(liveBytes, deploymentId) {
  const candidate = JSON.parse(Buffer.from(liveBytes).toString('utf8'));
  if (!Array.isArray(candidate) || candidate.some(row => !row || typeof row.id !== 'string')
    || new Set(candidate.map(row => row.id)).size !== candidate.length) throw new Error('Invalid audit source flow');
  const transforms = [patchAuditGateway, patchAuditPreview, patchLeaveRead];
  AUDIT_TARGETS.forEach(([id, hash], index) => {
    const node = candidate.find(row => row.id === id);
    if (node?.type !== 'function' || sha(node.func || '') !== hash) throw new Error(`Audit preimage drift: ${id}`);
    node.func = transforms[index](node.func);
    new Function('msg', 'node', 'env', 'global', node.func);
  });
  const candidateBytes = Buffer.from(`${JSON.stringify(candidate, null, 2)}\n`);
  const contract = buildExactGraphContract({ liveBytes, candidateBytes, deploymentId,
    allowedChanges: AUDIT_TARGETS.map(([id]) => ({ id, fields: ['func'] })) });
  validateReviewedFlowContract({ liveBytes, candidateBytes, contract });
  return { candidate, candidateBytes, contract };
}
