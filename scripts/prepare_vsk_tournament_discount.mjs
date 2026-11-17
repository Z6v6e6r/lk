// Local candidate only. Preserve the current graph, including all residency and club patches.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
export const VSK_EVALUATORS = ['lk_subscription_managed_policy_20260820',
  'lk_subscription_price_preview_20260908_evaluate', '34e66e06d53503bb'];
const anchor = '  } else if (["GROUP_TRAINING", "TOURNAMENT"].includes(category)) {';
export function prepareVskTournamentDiscount(raw, expectedSha256) {
  assert.match(expectedSha256, /^[a-f0-9]{64}$/);
  assert.equal(createHash('sha256').update(raw).digest('hex'), expectedSha256, 'Live source drift');
  const flow = JSON.parse(raw);
  assert.equal(new Set(flow.map(n => n.id)).size, flow.length, 'Duplicate node ID');
  const reviewed = fs.readFileSync(new URL('./nodered_lk1_hub_nodes/evaluator.js', import.meta.url), 'utf8');
  const start = reviewed.indexOf('  } else if (category === "TOURNAMENT"\n    && target?.eventId');
  const end = reviewed.indexOf(anchor, start);
  assert(start >= 0 && end > start, 'Reviewed VSK branch missing');
  const branch = reviewed.slice(start, end);
  for (const id of VSK_EVALUATORS) {
    const node = flow.find(n => n.id === id);
    assert.equal(node?.type, 'function', `Missing evaluator ${id}`);
    assert.equal(node.func.split(anchor).length, 2, `Evaluator drift ${id}`);
    assert(!node.func.includes('lk1-vsk-tournament'), 'Already patched');
    node.func = node.func.replace(anchor, branch + anchor);
    new Function('msg', 'node', 'global', 'env', node.func);
  }
  return Buffer.from(JSON.stringify(flow, null, 2) + '\n');
}
