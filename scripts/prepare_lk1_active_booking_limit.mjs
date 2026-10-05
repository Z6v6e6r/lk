#!/usr/bin/env node
// Builds private local candidates only. No deploy, global write, or provider I/O.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import { verifyWorkspace, assertExternalWorkspace, assertFlowArray } from './verify_nodered_source_origin.mjs';
import { buildExactGraphContract, validateReviewedFlowContract } from './nodered_reviewed_flow_deploy/runtime_contract.mjs';
import { buildHubPolicyTransition } from './lib/lk1HubPolicyTransition.mjs';
import { buildFriendshipTwoHoursPlanRulesTransition, buildPlanRulesTransition,
  LK1_PLAN_RULES_WITH_FRIENDSHIP_TWO_HOURS } from './lib/lk1PlanRulesTransition.mjs';
import { HUB_POLICY_PRIOR, HUB_POLICY_LIMIT_8, PLAN_RULES_LIMIT_8,
  buildActiveBookingLimitTransitions } from './lib/lk1ActiveBookingLimit.mjs';
import { buildHubRuntimeEvidence, normalizeFrozenHubSale } from './lib/hubLk1SaleContract.mjs';

export const SOURCE_SHA256 = '7e8a9570dbc8b7cfabe3340c81a9274e407f9fbc1de2d9e963f92db67ae32ff1';
export const LIMIT_NODES = Object.freeze({ gateway: 'lk_subscription_booking_router_20260804',
  preview: 'lk_subscription_price_preview_20260908_router', receipt: 'piter_atomic_router_20260903' });
const changes = [{ id: LIMIT_NODES.gateway, fields: ['func', 'initialize'] },
  { id: LIMIT_NODES.preview, fields: ['func'] }, { id: LIMIT_NODES.receipt, fields: ['initialize'] }];
const hash = bytes => createHash('sha256').update(bytes).digest('hex');

function replaceOnce(source, prior, desired, label) {
  if (!prior || source.split(prior).length !== 2) throw Error(`${label} preimage drift`);
  return source.replace(prior, () => desired);
}

function replacePolicyReader(source, before, after, label) {
  const pattern = /^const lk1DesiredPolicy = (\{[^\n]+\});$/gm;
  const matches = [...source.matchAll(pattern)];
  if (matches.length !== 1 || !isDeepStrictEqual(JSON.parse(matches[0][1]), before.desired)) {
    throw Error(`${label} policy preimage drift`);
  }
  // The installed reader uses spaced JSON. Verify every other reader byte as well.
  const normalized = source.replace(pattern, () => `const lk1DesiredPolicy = ${JSON.stringify(before.desired)};`)
    .replace('["maxActiveBookings", "freeGameMinutesPerDay", "gameOverageDiscountPercent", "groupTrainingDiscountPercent", "tournamentDiscountPercent"]',
      '["maxActiveBookings","freeGameMinutesPerDay","gameOverageDiscountPercent","groupTrainingDiscountPercent","tournamentDiscountPercent"]')
    .replace(/\n\n(?=const lk1DesiredPolicy|const lk1NormalizePolicy|const lk1ReadBoundPolicy)/g, '\n');
  return replaceOnce(normalized, before.reader, after.reader, label);
}

// Body-level helper used by synthetic tests. The public artifact builder additionally
// requires the exact reviewed full-flow hash and the fresh 147 origin below.
export function patchLimitFlow(source, { beforeHub, beforePlans, afterHub, afterPlans }) {
  assertFlowArray(source);
  const flow = structuredClone(source);
  const node = id => {
    const result = flow.find(n => n.id === id);
    if (!result || result.type !== 'function' || typeof result.func !== 'string'
      || typeof result.initialize !== 'string' || result.d === true || result.disabled === true
      || flow.find(n => n.id === result.z)?.disabled === true) throw Error(`Limit function unavailable: ${id}`);
    return result;
  };
  const gateway = node(LIMIT_NODES.gateway), preview = node(LIMIT_NODES.preview), receipt = node(LIMIT_NODES.receipt);
  gateway.func = replacePolicyReader(gateway.func, beforeHub, afterHub, 'Gateway policy reader');
  preview.func = replacePolicyReader(preview.func, beforeHub, afterHub, 'Preview policy reader');
  gateway.initialize = replaceOnce(gateway.initialize, beforeHub.initialize, afterHub.initialize, 'HUB initializer');
  gateway.initialize = replaceOnce(gateway.initialize, beforePlans.initialize, afterPlans.initialize, 'Plan initializer');
  new Function('global', gateway.initialize);
  for (const body of [gateway.func, preview.func]) new Function('msg', 'node', 'global', 'env', body);
  const initializerSuffix = gateway.initialize.slice(afterHub.initialize.length);
  const evidence = buildHubRuntimeEvidence(flow, { policyTransition: {
    expectedPrior: afterHub.expectedPrior, desired: afterHub.desired, acceptEmptyPrior: true,
  }, initializerSuffix });
  const pattern = /^const hubSaleRuntimeReceipt = (\{[^\n]+\});$/gm;
  const matches = [...receipt.initialize.matchAll(pattern)];
  const priorReceipt = matches.length === 1 && normalizeFrozenHubSale(JSON.parse(matches[0][1]));
  if (!priorReceipt || !isDeepStrictEqual(priorReceipt.policy, beforeHub.desired)
    || priorReceipt.bookingUsageScope !== evidence.receipt.bookingUsageScope) throw Error('HUB receipt preimage drift');
  receipt.initialize = receipt.initialize.replace(pattern, () => `const hubSaleRuntimeReceipt = ${JSON.stringify(evidence.receipt)};`);
  new Function('global', 'env', receipt.initialize);
  return { flow, evidence, changes };
}

export function composeActiveBookingLimitArtifacts(liveBytes) {
  if (hash(liveBytes) !== SOURCE_SHA256) throw Error('Reviewed live flow preimage drift; pull and review again');
  const prior = { hub: buildHubPolicyTransition({ expectedPrior: null, desired: HUB_POLICY_PRIOR }),
    plans: buildFriendshipTwoHoursPlanRulesTransition() };
  const next = buildActiveBookingLimitTransitions();
  const built = patchLimitFlow(JSON.parse(liveBytes), { beforeHub: prior.hub, beforePlans: prior.plans,
    afterHub: next.hub, afterPlans: next.plans });
  const candidateBytes = Buffer.from(JSON.stringify(built.flow, null, 2) + '\n');
  const contract = buildExactGraphContract({ liveBytes, candidateBytes, deploymentId: 'lk1-active-booking-limit-8',
    allowedChanges: changes, allowedAdditionIds: [] });
  validateReviewedFlowContract({ liveBytes, candidateBytes, contract });
  const reverse = { hub: buildHubPolicyTransition({ expectedPrior: HUB_POLICY_LIMIT_8,
    desired: HUB_POLICY_PRIOR, acceptEmptyPrior: true }),
  plans: buildPlanRulesTransition({ expectedPrior: PLAN_RULES_LIMIT_8,
    desired: LK1_PLAN_RULES_WITH_FRIENDSHIP_TWO_HOURS, acceptEmptyPrior: true }) };
  const reverted = patchLimitFlow(built.flow, { beforeHub: next.hub, beforePlans: next.plans,
    afterHub: reverse.hub, afterPlans: reverse.plans });
  const rollbackBytes = Buffer.from(JSON.stringify(reverted.flow, null, 2) + '\n');
  const rollbackContract = buildExactGraphContract({ liveBytes: candidateBytes, candidateBytes: rollbackBytes,
    deploymentId: 'lk1-active-booking-limit-8-rollback', allowedChanges: changes, allowedAdditionIds: [] });
  validateReviewedFlowContract({ liveBytes: candidateBytes, candidateBytes: rollbackBytes, contract: rollbackContract });
  return { candidateBytes, contract, rollbackBytes, rollbackContract, changes,
    sourceSha256: SOURCE_SHA256, candidateSha256: hash(candidateBytes), receipt: built.evidence.receipt };
}

export function assertPrivateCandidateOutput(output) {
  if (!path.isAbsolute(output) || fs.existsSync(output)) throw Error('New absolute private output directory required');
  const parent = fs.realpathSync(path.dirname(output));
  if (path.join(parent, path.basename(output)) !== output) throw Error('Canonical private output directory required');
  // Managed worktrees have a .git file; primary and embedded repositories have a
  // .git directory. Raw flows must stay outside every Git checkout, including siblings.
  for (let ancestor = parent; ; ancestor = path.dirname(ancestor)) {
    if (fs.existsSync(path.join(ancestor, '.git'))) throw Error('Raw flow output must be outside every Git checkout');
    if (path.dirname(ancestor) === ancestor) break;
  }
}

export function prepareActiveBookingLimit(workspace, output) {
  assertPrivateCandidateOutput(output);
  verifyWorkspace(workspace);
  const built = composeActiveBookingLimitArtifacts(fs.readFileSync(path.join(workspace, 'input/source.flow.json')));
  // Reuse canonical/outside-repository checks without ever emitting raw flows into Git.
  fs.mkdirSync(output, { mode: 0o700 });
  assertExternalWorkspace(output);
  for (const [name, value] of Object.entries({ 'candidate.json': built.candidateBytes,
    'contract.json': JSON.stringify(built.contract, null, 2) + '\n', 'rollback.json': built.rollbackBytes,
    'rollback-contract.json': JSON.stringify(built.rollbackContract, null, 2) + '\n' })) {
    fs.writeFileSync(path.join(output, name), value, { mode: 0o600, flag: 'wx' });
  }
  return { sourceSha256: built.sourceSha256, candidateSha256: built.candidateSha256,
    changes: built.changes, planCount: PLAN_RULES_LIMIT_8.rules.length, limit: 8 };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  if (process.argv.length !== 4) throw Error('Usage: <fresh-private-147-workspace> <new-private-output-directory>');
  console.log(JSON.stringify(prepareActiveBookingLimit(process.argv[2], process.argv[3])));
}
