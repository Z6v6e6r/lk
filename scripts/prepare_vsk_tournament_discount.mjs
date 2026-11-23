// Local candidate only. Preserve the current graph, including all residency and club patches.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { patchVskTournamentEvaluator } from './lib/vskTournamentDiscount.mjs';
export const VSK_EVALUATORS = ['lk_subscription_managed_policy_20260820',
  'lk_subscription_price_preview_20260908_evaluate', '34e66e06d53503bb'];
export function prepareVskTournamentDiscount(raw, expectedSha256) {
  assert.match(expectedSha256, /^[a-f0-9]{64}$/);
  assert.equal(createHash('sha256').update(raw).digest('hex'), expectedSha256, 'Live source drift');
  const flow = JSON.parse(raw);
  assert.equal(new Set(flow.map(n => n.id)).size, flow.length, 'Duplicate node ID');
  for (const id of VSK_EVALUATORS) {
    const node = flow.find(n => n.id === id);
    assert.equal(node?.type, 'function', `Missing evaluator ${id}`);
    node.func = patchVskTournamentEvaluator(node.func);
  }
  return Buffer.from(JSON.stringify(flow, null, 2) + '\n');
}
