#!/usr/bin/env node

// Owner decision 2026-11-10: Vsk uses the installed ordinary Friendship
// policy. Preserve the live graph instead of composing the older bespoke plan.
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildPlanRulesTransition } from './lib/lk1PlanRulesTransition.mjs';
import { buildExactGraphContract, validateReviewedFlowContract } from './nodered_reviewed_flow_deploy/runtime_contract.mjs';

export const VSK_FRIENDSHIP_PRODUCT_ID = '94e32355-1c69-462b-9f2a-77f2817cb24c';
export const ORDINARY_FRIENDSHIP_PRODUCT_ID = 'b2e6a9d4-53b5-4f79-87ec-3fb076381e9b';
export const VSK_FRIENDSHIP_SOURCE_SHA256 = '6d723c8c13aceabce73537b0a46b25d2992501526bbfea776cdc16656c51aae4';
export const VSK_FRIENDSHIP_NODE_IDS = Object.freeze({
  gateway: 'lk_subscription_booking_router_20260804',
  preview: 'lk_subscription_price_preview_20260908_router',
});
const PREIMAGES = Object.freeze({
  gatewayFunc: 'ec799ff07835e4defc19ff8236a60b42b5abc4645969681d2ac2ea2d62cb4918',
  gatewayInitialize: '72c5a62f0bd5f732a47c9299a757c4933a2bfb6e11484ae6b4b13342be100410',
  previewFunc: '8a3cdaace3d5214434bdd54b47c85ca4e777b101475da0228dd039dfbf4b8c8b',
});
const sha256 = value => crypto.createHash('sha256').update(value).digest('hex');
const PLAN_START = 'const lk1PlanRulesKey = "subscriptions_lk1_plan_rules";';
const PLAN_END = 'const lk1StationExclusionsKey';
const PLAN_LITERAL = 'const lk1DesiredPlanRules = ';

export function buildVskFriendshipTransition(expectedPrior) {
  const ordinary = expectedPrior?.rules?.filter(rule => rule.productId === ORDINARY_FRIENDSHIP_PRODUCT_ID) || [];
  if (ordinary.length !== 1 || ordinary[0].planKey !== 'friendship') {
    throw new Error('Exactly one ordinary Friendship rule required');
  }
  if (expectedPrior.rules.some(rule => rule.productId === VSK_FRIENDSHIP_PRODUCT_ID)) {
    throw new Error('Vsk rule already present');
  }
  // Clone the installed rule, including all five numbers and its purchase cohort.
  // In particular, do not bring back the historical four-booking generation.
  const desired = { ...expectedPrior, rules: [...expectedPrior.rules,
    { ...ordinary[0], productId: VSK_FRIENDSHIP_PRODUCT_ID }] };
  return buildPlanRulesTransition({ expectedPrior, desired, acceptEmptyPrior: true });
}

function replaceOnce(source, before, after, label) {
  if (source.split(before).length !== 2) throw new Error(`${label} anchor drift`);
  return source.replace(before, after);
}

export function patchVskFriendshipRouterBody(source, { preview = false } = {}) {
  const normalized = '  const normalized = markers.map(normalizeMarker).filter(Boolean);\n';
  let result = replaceOnce(source, normalized,
    `  if (markers.some((marker) => normalizeId(marker) === "${VSK_FRIENDSHIP_PRODUCT_ID}")\n`
    + `    || collectExactProductIds(value).includes("${VSK_FRIENDSHIP_PRODUCT_ID}")) return "friendship";\n`
    + normalized, 'Plan identity');
  const category = '  if (typeId === 2349 && directionId === 6181) return "open_game";\n';
  result = replaceOnce(result, category,
    '  if (typeId === 2349 && directionId === 6975) return "open_game";\n'
    + category, 'VSK category');
  if (preview) {
    // Scope comes from the authenticated, server-resolved exercise and fixed product.
    // Preserve the installed Patriots branch and every unrelated product.
    const anchor = "  const patriotsClubGame = patriotsGameType === 'viva:direction:6181:type:2349';\n";
    result = replaceOnce(result, anchor, anchor
      + "  const vskGameType = !eventRoute && productId.toLowerCase() === '94e32355-1c69-462b-9f2a-77f2817cb24c'\n"
      + "    ? canonical.managedExternalEventTypeId(exercise) : null;\n"
      + "  if (vskGameType && !['viva:direction:4588:type:1613', 'viva:direction:6975:type:1613', 'viva:direction:6975:type:2349'].includes(vskGameType)) {\n"
      + "    quote(id, 'UNAVAILABLE', null, 0, 0, 'EVENT_NOT_INCLUDED'); continue;\n"
      + "  }\n"
      + "  const vskClubGame = vskGameType && vskGameType.startsWith('viva:direction:6975:');\n", 'VSK game preview scope');
    result = replaceOnce(result,
      "new Set([patriotsClubGame ? '2349' : '1613']), new Set([patriotsClubGame ? '6181' : '4588']),",
      "new Set([vskClubGame ? vskGameType.split(':').at(-1) : patriotsClubGame ? '2349' : '1613']), new Set([vskClubGame ? '6975' : patriotsClubGame ? '6181' : '4588']),",
      'VSK game eligibility');
  }
  new Function('msg', 'node', 'env', 'global', result);
  return result;
}

export function composeVskFriendshipArtifacts(rawSource) {
  const liveBytes = Buffer.from(rawSource);
  assert.equal(sha256(liveBytes), VSK_FRIENDSHIP_SOURCE_SHA256, 'Live flow preimage drift');
  const flow = JSON.parse(liveBytes);
  assert.equal(flow.length, 4974, 'Live graph node count drift');
  assert.equal(new Set(flow.map(node => node.id)).size, flow.length, 'Duplicate node id');
  const gateway = flow.find(node => node.id === VSK_FRIENDSHIP_NODE_IDS.gateway);
  const preview = flow.find(node => node.id === VSK_FRIENDSHIP_NODE_IDS.preview);
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
  const transition = buildVskFriendshipTransition(expectedPrior);
  gateway.initialize = initialize.slice(0, start) + transition.initialize + initialize.slice(end);
  new Function('global', gateway.initialize);
  gateway.func = patchVskFriendshipRouterBody(gateway.func);
  preview.func = patchVskFriendshipRouterBody(preview.func, { preview: true });
  const candidateBytes = Buffer.from(`${JSON.stringify(flow, null, 2)}\n`);
  const changes = [{ id: gateway.id, fields: ['func', 'initialize'] },
    { id: preview.id, fields: ['func'] }];
  const contract = buildExactGraphContract({ liveBytes, candidateBytes,
    deploymentId: 'lk1-vsk-friendship-parity', allowedChanges: changes, allowedAdditionIds: [] });
  validateReviewedFlowContract({ liveBytes, candidateBytes, contract });
  return { candidateBytes, contract, transition, changes,
    sourceSha256: sha256(liveBytes), candidateSha256: sha256(candidateBytes) };
}

// Only an exact candidate permits restoring its exact source backup. This does
// not undo any bookings, payments or visits performed after a future activation.
export function revertVskFriendshipArtifacts(rawSource, rawCandidate) {
  const { candidateBytes } = composeVskFriendshipArtifacts(rawSource);
  assert.deepEqual(Buffer.from(rawCandidate), candidateBytes, 'Rollback candidate drift');
  return Buffer.from(rawSource);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const [source, outputDir, ...extra] = process.argv.slice(2);
  if (!source || !outputDir || extra.length || !path.isAbsolute(source) || !path.isAbsolute(outputDir)) {
    throw new Error('Usage: node scripts/patch_live_lk1_vsk_friendship_parity.mjs /absolute/source.flow.json /absolute/new-output-dir');
  }
  const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
  const parent = fs.realpathSync(path.dirname(outputDir));
  const output = path.join(parent, path.basename(outputDir));
  if (output === repo || output.startsWith(`${repo}${path.sep}`)) throw new Error('Output must be outside repository');
  if (fs.existsSync(output)) throw new Error('Output already exists');
  const artifacts = composeVskFriendshipArtifacts(fs.readFileSync(source));
  fs.mkdirSync(output, { mode: 0o700 });
  for (const [name, content] of Object.entries({ 'candidate.flow.json': artifacts.candidateBytes,
    'contract.json': `${JSON.stringify(artifacts.contract, null, 2)}\n`,
    'plan-rules.json': `${JSON.stringify(artifacts.transition.desired, null, 2)}\n` })) {
    fs.writeFileSync(path.join(output, name), content, { mode: 0o600, flag: 'wx' });
  }
  console.log(JSON.stringify({ sourceSha256: artifacts.sourceSha256, candidateSha256: artifacts.candidateSha256,
    changes: artifacts.changes, productId: VSK_FRIENDSHIP_PRODUCT_ID,
    rule: artifacts.transition.desired.rules.at(-1), liveMutationAuthorized: false, outputDir: output }));
}
