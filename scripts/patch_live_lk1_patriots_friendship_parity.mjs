#!/usr/bin/env node

// Owner decision 2026-10-21: Patriots uses the installed ordinary Friendship
// policy. Preserve the live graph instead of composing the older bespoke plan.
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildPlanRulesTransition } from './lib/lk1PlanRulesTransition.mjs';
import { buildExactGraphContract, validateReviewedFlowContract } from './nodered_reviewed_flow_deploy/runtime_contract.mjs';

export const PATRIOTS_FRIENDSHIP_PRODUCT_ID = '37ab3713-4431-4815-96ba-d7ece76a9241';
export const ORDINARY_FRIENDSHIP_PRODUCT_ID = 'b2e6a9d4-53b5-4f79-87ec-3fb076381e9b';
export const PATRIOTS_FRIENDSHIP_SOURCE_SHA256 = '53b4dfc545896e702544427ff8752c020b0de5f1fd35027ec7d8f8dabcda1655';
export const PATRIOTS_FRIENDSHIP_NODE_IDS = Object.freeze({
  gateway: 'lk_subscription_booking_router_20260804',
  preview: 'lk_subscription_price_preview_20260908_router',
});
const PREIMAGES = Object.freeze({
  gatewayFunc: '40f4d4fa92a40b28eb2abf8eb07fe71a56e91213d2d20f58013bf1d956a55ec1',
  gatewayInitialize: '14195e5237b8e14c45ab5f9a67af08bc72fea5d424a2e85e792dcd620c9e8267',
  previewFunc: '4795a7ef15e3f7c1c590faba387119088684fd64f9a42fe94a326b50efb2aea8',
});
const sha256 = value => crypto.createHash('sha256').update(value).digest('hex');
const PLAN_START = 'const lk1PlanRulesKey = "subscriptions_lk1_plan_rules";';
const PLAN_END = 'const lk1StationExclusionsKey';
const PLAN_LITERAL = 'const lk1DesiredPlanRules = ';

export function buildPatriotsFriendshipTransition(expectedPrior) {
  const ordinary = expectedPrior?.rules?.filter(rule => rule.productId === ORDINARY_FRIENDSHIP_PRODUCT_ID) || [];
  if (ordinary.length !== 1 || ordinary[0].planKey !== 'friendship') {
    throw new Error('Exactly one ordinary Friendship rule required');
  }
  if (expectedPrior.rules.some(rule => rule.productId === PATRIOTS_FRIENDSHIP_PRODUCT_ID)) {
    throw new Error('Patriots rule already present');
  }
  // Clone the installed rule, including all five numbers and its purchase cohort.
  // In particular, do not bring back the historical four-booking generation.
  const desired = { ...expectedPrior, rules: [...expectedPrior.rules,
    { ...ordinary[0], productId: PATRIOTS_FRIENDSHIP_PRODUCT_ID }] };
  return buildPlanRulesTransition({ expectedPrior, desired, acceptEmptyPrior: true });
}

function replaceOnce(source, before, after, label) {
  if (source.split(before).length !== 2) throw new Error(`${label} anchor drift`);
  return source.replace(before, after);
}

export function patchPatriotsFriendshipRouterBody(source, { preview = false } = {}) {
  const normalized = '  const normalized = markers.map(normalizeMarker).filter(Boolean);\n';
  let result = replaceOnce(source, normalized,
    `  if (markers.some((marker) => normalizeId(marker) === "${PATRIOTS_FRIENDSHIP_PRODUCT_ID}")\n`
    + `    || collectExactProductIds(value).includes("${PATRIOTS_FRIENDSHIP_PRODUCT_ID}")) return "friendship";\n`
    + normalized, 'Plan identity');
  const category = '  if ([1613].includes(typeId) || [4588].includes(directionId)) return "open_game";\n';
  result = replaceOnce(result, category,
    '  if (typeId === 2349 && directionId === 6181) return "open_game";\n'
    + '  if (typeId === 2349 && directionId === 6306) return "tournament";\n'
    + '  if (typeId === 2349 && directionId === 6307) return "group_training";\n'
    + category, 'Patriots category');
  if (preview) {
    // This product-bound branch already derives both IDs from the actual exercise.
    // Leaving it disabled would still filter a corporate game as 4588/1613.
    result = replaceOnce(result, 'const supportsPatriotsGameScope = false;',
      'const supportsPatriotsGameScope = true;', 'Patriots game preview scope');
  }
  new Function('msg', 'node', 'env', 'global', result);
  return result;
}

export function composePatriotsFriendshipArtifacts(rawSource) {
  const liveBytes = Buffer.from(rawSource);
  assert.equal(sha256(liveBytes), PATRIOTS_FRIENDSHIP_SOURCE_SHA256, 'Live flow preimage drift');
  const flow = JSON.parse(liveBytes);
  assert.equal(flow.length, 4839, 'Live graph node count drift');
  assert.equal(new Set(flow.map(node => node.id)).size, flow.length, 'Duplicate node id');
  const gateway = flow.find(node => node.id === PATRIOTS_FRIENDSHIP_NODE_IDS.gateway);
  const preview = flow.find(node => node.id === PATRIOTS_FRIENDSHIP_NODE_IDS.preview);
  for (const node of [gateway, preview]) {
    assert.equal(node?.type, 'function', 'Expected function node');
    assert.ok(node.d !== true && node.disabled !== true, 'Function must be enabled');
    const tab = flow.find(candidate => candidate.id === node.z);
    assert.ok(tab?.type === 'tab' && tab.disabled !== true, 'Function tab must be enabled');
  }
  for (const [key, value] of Object.entries({ gatewayFunc: gateway.func,
    gatewayInitialize: gateway.initialize, previewFunc: preview.func })) {
    assert.equal(typeof value, 'string', `${key} missing`);
    assert.equal(sha256(value), PREIMAGES[key], `${key} preimage drift`);
  }
  const initialize = gateway.initialize;
  assert.equal(initialize.split(PLAN_START).length, 2, 'Plan start drift');
  assert.equal(initialize.split(PLAN_END).length, 2, 'Plan end drift');
  const start = initialize.indexOf(PLAN_START);
  const end = initialize.indexOf(PLAN_END, start);
  assert.ok(end > start, 'Plan region drift');
  const block = initialize.slice(start, end);
  assert.equal(block.split(PLAN_LITERAL).length, 2, 'Plan payload drift');
  const expectedPrior = JSON.parse(block.slice(block.indexOf(PLAN_LITERAL) + PLAN_LITERAL.length).split(';\n')[0]);
  const transition = buildPatriotsFriendshipTransition(expectedPrior);
  gateway.initialize = initialize.slice(0, start) + transition.initialize + initialize.slice(end);
  new Function('global', gateway.initialize);
  gateway.func = patchPatriotsFriendshipRouterBody(gateway.func);
  preview.func = patchPatriotsFriendshipRouterBody(preview.func, { preview: true });
  const candidateBytes = Buffer.from(`${JSON.stringify(flow, null, 2)}\n`);
  const changes = [{ id: gateway.id, fields: ['func', 'initialize'] },
    { id: preview.id, fields: ['func'] }];
  const contract = buildExactGraphContract({ liveBytes, candidateBytes,
    deploymentId: 'lk1-patriots-friendship-parity', allowedChanges: changes, allowedAdditionIds: [] });
  validateReviewedFlowContract({ liveBytes, candidateBytes, contract });
  return { candidateBytes, contract, transition, changes,
    sourceSha256: sha256(liveBytes), candidateSha256: sha256(candidateBytes) };
}

// Only an exact candidate permits restoring its exact source backup. This does
// not undo any bookings, payments or visits performed after a future activation.
export function revertPatriotsFriendshipArtifacts(rawSource, rawCandidate) {
  const { candidateBytes } = composePatriotsFriendshipArtifacts(rawSource);
  assert.deepEqual(Buffer.from(rawCandidate), candidateBytes, 'Rollback candidate drift');
  return Buffer.from(rawSource);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const [source, outputDir, ...extra] = process.argv.slice(2);
  if (!source || !outputDir || extra.length || !path.isAbsolute(source) || !path.isAbsolute(outputDir)) {
    throw new Error('Usage: node scripts/patch_live_lk1_patriots_friendship_parity.mjs /absolute/source.flow.json /absolute/new-output-dir');
  }
  const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
  const parent = fs.realpathSync(path.dirname(outputDir));
  const output = path.join(parent, path.basename(outputDir));
  if (output === repo || output.startsWith(`${repo}${path.sep}`)) throw new Error('Output must be outside repository');
  if (fs.existsSync(output)) throw new Error('Output already exists');
  const artifacts = composePatriotsFriendshipArtifacts(fs.readFileSync(source));
  fs.mkdirSync(output, { mode: 0o700 });
  for (const [name, content] of Object.entries({ 'candidate.flow.json': artifacts.candidateBytes,
    'contract.json': `${JSON.stringify(artifacts.contract, null, 2)}\n`,
    'plan-rules.json': `${JSON.stringify(artifacts.transition.desired, null, 2)}\n` })) {
    fs.writeFileSync(path.join(output, name), content, { mode: 0o600, flag: 'wx' });
  }
  console.log(JSON.stringify({ sourceSha256: artifacts.sourceSha256, candidateSha256: artifacts.candidateSha256,
    changes: artifacts.changes, productId: PATRIOTS_FRIENDSHIP_PRODUCT_ID,
    rule: artifacts.transition.desired.rules.at(-1), liveMutationAuthorized: false, outputDir: output }));
}
