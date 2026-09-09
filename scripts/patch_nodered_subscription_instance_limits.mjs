import crypto from 'node:crypto';
import { scopeSubscriptionUsage, scopeSubscriptionEvaluator } from './lib/subscriptionInstanceLimitSources.mjs';
import { buildExactGraphContract, validateReviewedFlowContract } from './nodered_reviewed_flow_deploy/runtime_contract.mjs';

const targets = [
  ['lk_subscription_booking_router_20260804', '0d505c16e83f88b238d7a9d26a47d01fa6ab32be5b7a7f0d604474b2f3123f37', scopeSubscriptionUsage],
  ['lk_subscription_managed_policy_20260820', '2ae3a02b1dfc1129883a72dda404d13cfb9b43e67e634d654f81fb01a5ca620c', scopeSubscriptionEvaluator],
  ['lk_subscription_price_preview_20260908_router', '8b1b8c7accd27246acf59cf07bac96aec2a80545834ba63f78de8f975bdf886a', scopeSubscriptionUsage],
  ['lk_subscription_price_preview_20260908_evaluate', '2ae3a02b1dfc1129883a72dda404d13cfb9b43e67e634d654f81fb01a5ca620c', scopeSubscriptionEvaluator],
];
const sha = source => crypto.createHash('sha256').update(source).digest('hex');

// Produces a local candidate only. All four readers/evaluators must be updated
// together; no DB migration, counter rewrite or provider call is needed.
export function composeSubscriptionInstanceLimitsArtifacts(liveBytes, deploymentId) {
  const candidate = JSON.parse(Buffer.from(liveBytes).toString('utf8'));
  if (!Array.isArray(candidate) || candidate.some(row => !row || typeof row.id !== 'string')
    || new Set(candidate.map(row => row.id)).size !== candidate.length) throw new Error('Invalid subscription limits source flow');
  for (const [id, before, transform] of targets) {
    const node = candidate.find(row => row.id === id);
    if (node?.type !== 'function' || sha(node.func || '') !== before) throw new Error(`Subscription limits preimage drift: ${id}`);
    node.func = transform(node.func);
    new Function('msg', 'node', 'env', 'global', node.func);
  }
  const candidateBytes = Buffer.from(`${JSON.stringify(candidate, null, 2)}\n`);
  const contract = buildExactGraphContract({ liveBytes, candidateBytes, deploymentId,
    allowedChanges: targets.map(([id]) => ({ id, fields: ['func'] })) });
  validateReviewedFlowContract({ liveBytes, candidateBytes, contract });
  return { candidate, candidateBytes, contract };
}
