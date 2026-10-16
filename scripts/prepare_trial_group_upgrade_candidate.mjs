import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';
import { trialGroupCheckoutSource } from './lib/trialGroupSources.mjs';
import { verifyWorkspace, assertFlowArray } from './verify_nodered_source_origin.mjs';
import { buildExactGraphContract, validateReviewedFlowContract } from './nodered_reviewed_flow_deploy/runtime_contract.mjs';
import { normalizeTrialGroupPolicy, TRIAL_GROUP_POLICY_GLOBAL } from './lib/trialGroupEligibility.mjs';

export const TRIAL_BOOKING_ID = 'lk_subscription_booking_router_20260804';
export const TRIAL_ROUTER_ID = 'lk_trial_group_20261002_router';
export const TRIAL_POLICY_INITIALIZER_ID = 'lk_trial_group_20261016_policy_initializer';
// Immutable source of the v1 policy/gate already installed on 147. Never infer
// the deployed generation from the checkout's mutable HEAD.
export const LEGACY_TRIAL_SOURCE_COMMIT = '33a33ac10d8c56d7ad4813572655c0aa2776ac94';
export const trialUpgradeSha256 = value => crypto.createHash('sha256').update(value).digest('hex');

function legacyFile(relative) {
  return execFileSync('git', ['show', `${LEGACY_TRIAL_SOURCE_COMMIT}:${relative}`], { cwd: path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..'), encoding: 'utf8' });
}
function oldBookingPrefix() {
  return legacyFile('scripts/lib/trialGroupEligibility.mjs').replace(/^export /gm, '') + '\n'
    + legacyFile('scripts/nodered_trial_group_nodes/visit_gate.js') + '\n';
}
function validatePolicy(policy) {
  const normalized = normalizeTrialGroupPolicy(policy);
  if (normalized.code || !normalized.tenantKey || (normalized.checkoutMode === 'enabled' && normalized.mode !== 'enforce')) {
    throw new Error('Trial policy is not an explicit safe server policy');
  }
  return normalized;
}
export function trialPolicyInitializer(policy) {
  const safe = validatePolicy(policy);
  return `global.set(${JSON.stringify(TRIAL_GROUP_POLICY_GLOBAL)}, ${JSON.stringify(safe)});`;
}
function initializerNode(tabId, policy) {
  return { id: TRIAL_POLICY_INITIALIZER_ID, type: 'function', z: tabId, name: 'Trial group policy initializer',
    func: 'return null;', outputs: 0, timeout: '', noerr: 0, initialize: trialPolicyInitializer(policy), finalize: '', libs: [],
    x: 1250, y: 5700, wires: [] };
}
function checkedFlow(raw, expectedSourceSha, expectedBookingSha, expectedRouterSha) {
  if (trialUpgradeSha256(raw) !== expectedSourceSha) throw new Error('Trial upgrade source SHA drift');
  const flow = JSON.parse(raw); assertFlowArray(flow, 'Trial upgrade source');
  const booking = flow.find(row => row.id === TRIAL_BOOKING_ID);
  const router = flow.find(row => row.id === TRIAL_ROUTER_ID);
  if (booking?.type !== 'function' || router?.type !== 'function' || booking.z !== router.z
    || booking.d === true || router.d === true || booking.disabled === true || router.disabled === true
    || trialUpgradeSha256(booking.func || '') !== expectedBookingSha
    || trialUpgradeSha256(router.func || '') !== expectedRouterSha
    || flow.filter(row => typeof row.id === 'string' && row.id.startsWith('lk_trial_group_20261002_')).length !== 11
    || flow.some(row => row.id === TRIAL_POLICY_INITIALIZER_ID)) throw new Error('Installed trial graph topology/source drift');
  return { flow, booking, router };
}
export function composeTrialGroupUpgradeCandidate(raw, expectedSourceSha, expectedBookingSha, expectedRouterSha, policy) {
  const { flow, booking } = checkedFlow(raw, expectedSourceSha, expectedBookingSha, expectedRouterSha);
  const previousPrefix = oldBookingPrefix();
  if (!booking.func.startsWith(previousPrefix)) throw new Error('Installed trial booking prefix drift');
  const candidate = structuredClone(flow);
  const nextBooking = candidate.find(row => row.id === TRIAL_BOOKING_ID);
  // The checkout source includes its own policy/gate.  Booking only receives the upgraded policy/gate prefix.
  const currentPolicy = fs.readFileSync(new URL('./lib/trialGroupEligibility.mjs', import.meta.url), 'utf8').replace(/^export /gm, '');
  const currentGate = fs.readFileSync(new URL('./nodered_trial_group_nodes/visit_gate.js', import.meta.url), 'utf8');
  nextBooking.func = currentPolicy + '\n' + currentGate + '\n' + booking.func.slice(previousPrefix.length);
  const nextRouter = candidate.find(row => row.id === TRIAL_ROUTER_ID);
  nextRouter.func = trialGroupCheckoutSource();
  const added = initializerNode(booking.z, policy); candidate.push(added);
  new Function('msg', 'global', 'node', 'env', nextBooking.func);
  new Function('msg', 'global', 'node', 'env', nextRouter.func);
  const bytes = Buffer.from(JSON.stringify(candidate, null, 2) + '\n');
  const deploymentId = 'trial-group-eligibility-v2-upgrade';
  const contract = buildExactGraphContract({ liveBytes: raw, candidateBytes: bytes, deploymentId,
    allowedChanges: [{ id: TRIAL_BOOKING_ID, fields: ['func'] }, { id: TRIAL_ROUTER_ID, fields: ['func'] }],
    allowedAdditionIds: [TRIAL_POLICY_INITIALIZER_ID] });
  validateReviewedFlowContract({ liveBytes: raw, candidateBytes: bytes, contract, deploymentId });
  return { candidate, bytes, contract };
}
export function composeTrialGroupPolicyTransition(raw, expectedCandidateSha, expectedInitializerSha, policy) {
  if (trialUpgradeSha256(raw) !== expectedCandidateSha) throw new Error('Trial policy transition flow SHA drift');
  const flow = JSON.parse(raw); assertFlowArray(flow, 'Trial policy transition');
  const initializer = flow.find(row => row.id === TRIAL_POLICY_INITIALIZER_ID);
  if (initializer?.type !== 'function' || trialUpgradeSha256(initializer.initialize || '') !== expectedInitializerSha
    || initializer.d === true || initializer.disabled === true
    || initializer.func !== 'return null;' || initializer.outputs !== 0 || JSON.stringify(initializer.wires) !== '[]') {
    throw new Error('Trial policy initializer drift');
  }
  const candidate = structuredClone(flow);
  candidate.find(row => row.id === TRIAL_POLICY_INITIALIZER_ID).initialize = trialPolicyInitializer(policy);
  const bytes = Buffer.from(JSON.stringify(candidate, null, 2) + '\n');
  const contract = buildExactGraphContract({ liveBytes: raw, candidateBytes: bytes,
    deploymentId: 'trial-group-policy-v2-transition', allowedChanges: [{ id: TRIAL_POLICY_INITIALIZER_ID, fields: ['initialize'] }], allowedAdditionIds: [] });
  validateReviewedFlowContract({ liveBytes: raw, candidateBytes: bytes, contract, deploymentId: 'trial-group-policy-v2-transition' });
  return { candidate, bytes, contract };
}
export function writeTrialGroupUpgradeCandidate(workspace, output, expectedSourceSha, expectedBookingSha, expectedRouterSha, policy) {
  const verified = verifyWorkspace(workspace, { quiet: true });
  if (!path.isAbsolute(output || '') || path.resolve(output) !== output || fs.existsSync(output)
    || fs.realpathSync(path.dirname(output)) !== path.dirname(output)) throw new Error('Use a new canonical external directory');
  try {
    execFileSync('git', ['rev-parse', '--git-dir'], { cwd: path.dirname(output), stdio: 'pipe' });
    throw new Error('Trial raw artifacts must stay outside Git');
  } catch (error) {
    if (error.status !== 128 || !String(error.stderr).includes('not a git repository')) throw error;
  }
  const result = composeTrialGroupUpgradeCandidate(fs.readFileSync(verified.sourcePath), expectedSourceSha, expectedBookingSha, expectedRouterSha, policy);
  fs.mkdirSync(output, { mode: 0o700 });
  fs.writeFileSync(path.join(output, 'candidate.flow.json'), result.bytes, { flag: 'wx', mode: 0o600 });
  fs.writeFileSync(path.join(output, 'exact-graph-contract.json'), JSON.stringify(result.contract, null, 2) + '\n', { flag: 'wx', mode: 0o600 });
  return { sourceSha256: expectedSourceSha, candidateSha256: trialUpgradeSha256(result.bytes), changedNodes: 2, addedNodes: 1, liveMutation: false };
}
if (process.argv[1] === fileURLToPath(import.meta.url)) throw new Error('Use writeTrialGroupUpgradeCandidate from a reviewed operation script');
