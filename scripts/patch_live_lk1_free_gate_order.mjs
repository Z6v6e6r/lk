#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { pathToFileURL } from 'node:url';
import { moveFreeCancellationStepsAfterDailyHelpers } from './patch_live_lk1_free_cancellation.mjs';
import { buildExactGraphContract, validateReviewedFlowContract } from './nodered_reviewed_flow_deploy/runtime_contract.mjs';
import { verifyWorkspace } from './verify_nodered_source_origin.mjs';
export const FREE_GATE_SOURCE_SHA256 = '120065b362f1b5dd4c9a69e9e50d4c3aacc2ce8939a27320a43de48c0ff3d399';
export const FREE_GATE_ROUTER_SHA256 = '3dfbf374f318891e19bb1302482a8053fd6423eb0acf2a8d455601771529753a';
export const FREE_GATE_ROUTER_ID = 'lk_subscription_booking_router_20260804';
const hash = bytes => crypto.createHash('sha256').update(bytes).digest('hex');
export function composeFreeGateOrder(liveBytes) {
  if (hash(liveBytes) !== FREE_GATE_SOURCE_SHA256) throw Error('Free gate live preimage drift');
  const flow = JSON.parse(liveBytes);
  const matches = flow.filter(n => n.id === FREE_GATE_ROUTER_ID);
  const n = matches[0];
  if (matches.length !== 1 || n.type !== 'function' || n.outputs !== 8 || n.d || n.disabled
    || hash(n.func) !== FREE_GATE_ROUTER_SHA256) throw Error('Free gate router preimage drift');
  n.func = moveFreeCancellationStepsAfterDailyHelpers(n.func);
  new Function('msg', 'node', 'global', 'env', 'flow', n.func);
  const candidateBytes = Buffer.from(JSON.stringify(flow, null, 2) + '\n');
  const contract = buildExactGraphContract({ liveBytes, candidateBytes, deploymentId: 'lk1-free-gate-order-20261112',
    allowedChanges: [{ id: FREE_GATE_ROUTER_ID, fields: ['func'] }], allowedAdditionIds: [] });
  validateReviewedFlowContract({ liveBytes, candidateBytes, contract });
  return { candidateBytes, contract, candidateSha256: hash(candidateBytes), gatewaySha256: hash(n.func) };
}
if (import.meta.url === pathToFileURL(process.argv[1] || '').href) {
  const verified = verifyWorkspace(process.argv[2], { quiet: true });
  const built = composeFreeGateOrder(fs.readFileSync(verified.sourcePath));
  for (const [name, bytes] of [['free-gate-candidate.json', built.candidateBytes],
    ['free-gate-contract.json', JSON.stringify(built.contract, null, 2) + '\n']]) {
    fs.writeFileSync(path.join(verified.workspace, name), bytes, { mode: 0o600, flag: 'wx' });
  }
  console.log(JSON.stringify({ candidateSha256: built.candidateSha256, gatewaySha256: built.gatewaySha256,
    changedNodes: [FREE_GATE_ROUTER_ID], deploymentPerformed: false }));
}
