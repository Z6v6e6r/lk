#!/usr/bin/env node
// Local preparation only: one exact graph, no policy activation or partial G1/G2 rollout.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import { patchLk1TrainG1GatewayBody, usageBlockSha } from './patch_live_lk1_train_g1_20261005.mjs';
import { patchTopokratyEvaluatorBody } from './patch_live_lk1_topokraty_friendship_hotfix.mjs';
import { previewSources } from './patch_nodered_subscription_price_preview.mjs';
import { buildActiveBookingLimitTransitions, HUB_POLICY_LIMIT_8, PLAN_RULES_LIMIT_8 } from './lib/lk1ActiveBookingLimit.mjs';
import { buildHubRuntimeEvidence, normalizeFrozenHubSale } from './lib/hubLk1SaleContract.mjs';
import { buildExactGraphContract, validateReviewedFlowContract } from './nodered_reviewed_flow_deploy/runtime_contract.mjs';
import { verifyWorkspace, assertFlowArray, assertExternalWorkspace } from './verify_nodered_source_origin.mjs';
import { assertPrivateCandidateOutput } from './prepare_lk1_active_booking_limit.mjs';

export const SOURCE_SHA256 = '8806b4e5ece9afd1449db73dd4e51964adb5566c845665feed4ff834784483e3';
export const NODES = Object.freeze({ gateway: 'lk_subscription_booking_router_20260804',
  evaluator: 'lk_subscription_managed_policy_20260820', previewEvaluate: 'lk_subscription_price_preview_20260908_evaluate',
  preview: 'lk_subscription_price_preview_20260908_router', receipt: 'piter_atomic_router_20260903',
  pricing: '8f7bd5b482fe9763', join: 'e92e68bf3f08a70c' });
const PREIMAGES = Object.freeze({
  gateway: '35b2bcb66c27deb6681150babf363209e5a40ff9dd197cfc0900ba3a90e49732',
  gatewayInitialize: 'ed830399d27b5a2a0d32a8af13fcc948c079b581c2ee966d8f15809bc5758db9',
  evaluator: '2d3f5b5080152c07ace9e4aaf31e7b0280878576c027ca7f5c30dd15d9b45602',
  preview: '66ceb106f3460684de83e85bbd00870db5a9086403571cb9d8566468c106b4b4',
  receiptInitialize: '2d71afffc624a3d314d4daa834b7a7ee65a55f728b0330b0ccc65280ad2db9a5',
  pricing: 'd93de261c85ba62e3ba782acad1a364bc63e97433bcbebba81b20f5c3eb7206b',
  join: '8b312b97a75112d8e10d13642be649cd795f77a506c4925152338b6854c2b074',
});
export const REVIEWED_EVALUATOR_SHA256 = '404fc3c087820bc28f794702ead9ddfba4eba62ca72c834729356441fc552243';
const REVIEWED_PREVIEW_SHA256 = 'd24b4bf6821e8557f965973578b66bb1e69796d077998f8d1cbed2e0feb5b1f4';
export const POSTIMAGES = Object.freeze({ gateway: 'c0fba4673eecf3550f479b4db2dd5b1baaade248f3acb405bfd2e0be57402292', evaluator: '4efcd7a248fbd7810d7adf80fa4ece869b0eeb8f11ceec021dbed0a7adf01eba', preview: 'f110fc9a6f54894cb37b91a4312da4961905f5ab72f8b8106f58bdc3bdd5f1dd', receiptInitialize: '13b7992e3a7ad047e58154097b8682c310853623f239f00e2ddabf0b28f6c12d', flow: '0105bc3d24ae293cf69f52ebf84a846b7c7d5ac1a326649a6eeb5b07006a1b7c' });
export const CHANGES = Object.freeze([
  { id: NODES.gateway, fields: ['func'] }, { id: NODES.evaluator, fields: ['func'] },
  { id: NODES.previewEvaluate, fields: ['func'] }, { id: NODES.preview, fields: ['func'] },
  { id: NODES.receipt, fields: ['initialize'] },
]);
export const sha256 = bytes => createHash('sha256').update(bytes).digest('hex');
const here = path.dirname(fileURLToPath(import.meta.url));
function pin(bytes, expected, label) {
  if (!/^[a-f0-9]{64}$/.test(expected) || sha256(bytes) !== expected) throw Error(`${label} drift`);
}
function replaceOnce(body, before, after, label) {
  if (body.split(before).length !== 2) throw Error(`${label} anchor drift`);
  return body.replace(before, () => after);
}
export function patchCourtDecisionRefusal(body) {
  const before = 'if (ctx.step === "lk1_policy_decision") {\n  const decision = msg._managedSubscriptionPolicyDecision;\n';
  return replaceOnce(body, before, before + '  if (isObj(decision) && decision.eligible === false\n'
    + '    && decision.blockers?.length === 1\n'
    + '    && decision.blockers[0].code === "LK1_COURT_COPAY_UNREPRESENTABLE") {\n'
    + '    return lk1Stop(ctx, "LK1_COURT_COPAY_UNREPRESENTABLE");\n  }\n', 'Court refusal');
}
function receiptFromInitialize(body) {
  const rows = [...body.matchAll(/^const hubSaleRuntimeReceipt = (\{[^\n]+\});$/gm)];
  if (rows.length !== 1) throw Error('HUB receipt identity drift');
  const receipt = normalizeFrozenHubSale(JSON.parse(rows[0][1]));
  if (!receipt) throw Error('HUB receipt shape drift');
  return { receipt, literal: rows[0][0] };
}
function evidenceFor(flow) {
  const hub = buildActiveBookingLimitTransitions().hub;
  const gateway = flow.find(n => n.id === NODES.gateway);
  if (!gateway.initialize.startsWith(hub.initialize)) throw Error('Limit8 initializer drift');
  const plans = /const lk1DesiredPlanRules = (\{[^\n]+\});/.exec(gateway.initialize);
  if (!plans || !isDeepStrictEqual(JSON.parse(plans[1]), PLAN_RULES_LIMIT_8)) throw Error('Dormant plan rules drift');
  return buildHubRuntimeEvidence(flow, { policyTransition: { expectedPrior: hub.expectedPrior,
    desired: HUB_POLICY_LIMIT_8, acceptEmptyPrior: true }, initializerSuffix: gateway.initialize.slice(hub.initialize.length) });
}

export function composeRulesParityArtifacts(liveBytes) {
  pin(liveBytes, SOURCE_SHA256, 'Reviewed full-flow preimage');
  const flow = JSON.parse(liveBytes.toString());
  assertFlowArray(flow);
  if (flow.length !== 4815) throw Error('Node count drift');
  const node = key => {
    const matches = flow.filter(n => n.id === NODES[key]);
    const n = matches[0];
    if (matches.length !== 1 || n.type !== 'function' || typeof n.func !== 'string'
      || typeof n.initialize !== 'string' || n.d === true || n.disabled === true
      || flow.find(tab => tab.id === n.z)?.disabled === true) throw Error(`${key} unavailable`);
    return n;
  };
  const gateway = node('gateway'), evaluator = node('evaluator'), previewEvaluate = node('previewEvaluate');
  const preview = node('preview'), receipt = node('receipt');
  for (const key of ['gateway', 'evaluator', 'preview', 'pricing', 'join']) pin(node(key).func, PREIMAGES[key], key);
  pin(previewEvaluate.func, PREIMAGES.evaluator, 'Preview evaluator');
  pin(gateway.initialize, PREIMAGES.gatewayInitialize, 'Gateway initialize');
  pin(receipt.initialize, PREIMAGES.receiptInitialize, 'Receipt initialize');
  const priorReceipt = receiptFromInitialize(receipt.initialize);
  if (!isDeepStrictEqual(priorReceipt.receipt, evidenceFor(flow).receipt)) throw Error('Stale preimage receipt');
  pin(fs.readFileSync(path.join(here, 'nodered_lk1_hub_nodes/evaluator.js')), REVIEWED_EVALUATOR_SHA256, 'Reviewed evaluator');
  pin(fs.readFileSync(path.join(here, 'nodered_subscription_price_preview_nodes/router.js')), REVIEWED_PREVIEW_SHA256, 'Reviewed preview');
  gateway.func = patchCourtDecisionRefusal(patchLk1TrainG1GatewayBody(gateway.func,
    { liveFuncSha256: PREIMAGES.gateway, patchedFuncSha256: 'PENDING_COMPOSITION' }, { includePatriots: false }));
  for (const n of [evaluator, previewEvaluate]) n.func = patchTopokratyEvaluatorBody(n.func, {
    liveEvaluatorFuncSha256: PREIMAGES.evaluator,
    liveEmbeddedSha256: 'ecc81fb6ee14e5948a61c54157c124408928935d9b9008c6e939238f43be89f3',
    reviewedEvaluatorSha256: REVIEWED_EVALUATOR_SHA256,
  });
  preview.func = previewSources(flow, { pins: { booking: sha256(gateway.func), evaluator: sha256(evaluator.func),
    pricing: PREIMAGES.pricing, join: PREIMAGES.join }, installedUsageSha256: usageBlockSha(gateway.func) }).router;
  const evidence = evidenceFor(flow);
  receipt.initialize = replaceOnce(receipt.initialize, priorReceipt.literal,
    `const hubSaleRuntimeReceipt = ${JSON.stringify(evidence.receipt)};`, 'Receipt refresh');
  for (const key of ['gateway', 'evaluator', 'preview']) {
    new Function('msg', 'node', 'env', 'global', node(key).func);
    pin(node(key).func, POSTIMAGES[key], `${key} postimage`);
  }
  if (previewEvaluate.func !== evaluator.func) throw Error('Evaluator parity drift');
  new Function('global', 'env', receipt.initialize);
  pin(receipt.initialize, POSTIMAGES.receiptInitialize, 'Receipt postimage');
  const candidateBytes = Buffer.from(JSON.stringify(flow, null, 2) + '\n');
  pin(candidateBytes, POSTIMAGES.flow, 'Candidate postimage');
  const contract = buildExactGraphContract({ liveBytes, candidateBytes, deploymentId: 'lk1-rules-parity-20261006',
    allowedChanges: CHANGES, allowedAdditionIds: [] });
  validateReviewedFlowContract({ liveBytes, candidateBytes, contract });
  // Source bytes restore cap8/dormant policies unchanged, and their original matching receipt.
  const rollbackContract = buildExactGraphContract({ liveBytes: candidateBytes, candidateBytes: liveBytes,
    deploymentId: 'lk1-rules-parity-20261006-rollback', allowedChanges: CHANGES, allowedAdditionIds: [] });
  validateReviewedFlowContract({ liveBytes: candidateBytes, candidateBytes: liveBytes, contract: rollbackContract });
  return { flow, candidateBytes, contract, rollbackBytes: Buffer.from(liveBytes), rollbackContract,
    sourceSha256: SOURCE_SHA256, candidateSha256: sha256(candidateBytes), receipt: evidence.receipt, changes: CHANGES };
}

export function prepareRulesParity(workspace, output) {
  assertPrivateCandidateOutput(output);
  verifyWorkspace(workspace);
  const built = composeRulesParityArtifacts(fs.readFileSync(path.join(workspace, 'input/source.flow.json')));
  fs.mkdirSync(output, { mode: 0o700 });
  assertExternalWorkspace(output);
  for (const [name, bytes] of Object.entries({ 'candidate.json': built.candidateBytes,
    'contract.json': JSON.stringify(built.contract, null, 2) + '\n', 'rollback.json': built.rollbackBytes,
    'rollback-contract.json': JSON.stringify(built.rollbackContract, null, 2) + '\n' })) {
    fs.writeFileSync(path.join(output, name), bytes, { mode: 0o600, flag: 'wx' });
  }
  return { sourceSha256: built.sourceSha256, candidateSha256: built.candidateSha256,
    changes: built.changes, policyActivation: false, deploymentPerformed: false, liveMutationPerformed: false };
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  if (process.argv.length !== 4) throw Error('Usage: <fresh-private-147-workspace> <new-private-output-directory>');
  console.log(JSON.stringify(prepareRulesParity(process.argv[2], process.argv[3])));
}
