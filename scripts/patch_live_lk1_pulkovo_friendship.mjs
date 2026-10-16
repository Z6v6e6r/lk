#!/usr/bin/env node

// A focused migration of the installed 147 graph, not a regeneration from older
// source generations. Pulkovo aliases the existing Friendship policy and daily seat.
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildPlanRulesTransition } from './lib/lk1PlanRulesTransition.mjs';
import { buildExactGraphContract, validateReviewedFlowContract } from './nodered_reviewed_flow_deploy/runtime_contract.mjs';

export const PULKOVO_PRODUCT_ID = 'd84534c8-aad1-46e1-ac6a-70296f319a3f';
export const FRIENDSHIP_PRODUCT_ID = 'b2e6a9d4-53b5-4f79-87ec-3fb076381e9b';
export const PULKOVO_SOURCE_SHA256 = 'b51554ba16bbbc527615badfc437e8962e3d963bf4fe25f3d53879a3176c0f05';
export const PULKOVO_NODE_IDS = Object.freeze({
  gateway: 'lk_subscription_booking_router_20260804',
  preview: 'lk_subscription_price_preview_20260908_router',
});
const PREIMAGES = Object.freeze({
  gatewayFunc: '0b60c7156d420a66ce288007a7406106768e425ce52613eb621e14d36c9b62f0',
  gatewayInitialize: 'ed830399d27b5a2a0d32a8af13fcc948c079b581c2ee966d8f15809bc5758db9',
  previewFunc: '66ceb106f3460684de83e85bbd00870db5a9086403571cb9d8566468c106b4b4',
});
const sha256 = value => crypto.createHash('sha256').update(value).digest('hex');
const PLAN_START = 'const lk1PlanRulesKey = "subscriptions_lk1_plan_rules";';
const PLAN_END = 'const lk1StationExclusionsKey';
const PLAN_LITERAL = 'const lk1DesiredPlanRules = ';

export function buildPulkovoTransition(expectedPrior) {
  const ordinary = expectedPrior?.rules?.filter(rule => rule.productId === FRIENDSHIP_PRODUCT_ID) || [];
  if (ordinary.length !== 1 || ordinary[0].planKey !== 'friendship') {
    throw new Error('Exactly one ordinary Friendship rule required');
  }
  if (expectedPrior.rules.some(rule => rule.productId === PULKOVO_PRODUCT_ID)) {
    throw new Error('Pulkovo rule already present');
  }
  // Copy all five numbers AND the purchase-date cohort from the actual installed rule.
  // The source's historical four-booking payload is deliberately not a live prior.
  const desired = { ...expectedPrior, rules: [...expectedPrior.rules,
    { ...ordinary[0], productId: PULKOVO_PRODUCT_ID }] };
  return buildPlanRulesTransition({ expectedPrior, desired, acceptEmptyPrior: true });
}

function replaceOnce(source, before, after, label) {
  if (source.split(before).length !== 2) throw new Error(`${label} anchor drift`);
  return source.replace(before, after);
}

export function patchPulkovoRouterBody(source) {
  // UUID-only records must get the same daily bucket even without a product label.
  const markers = '  const markers = collectPlanMarkers(value);\n';
  let result = replaceOnce(source, markers, markers
    + `  if (markers.some((marker) => normalizeId(marker) === "${PULKOVO_PRODUCT_ID}")\n`
    + `    || collectExactProductIds(value).includes("${PULKOVO_PRODUCT_ID}")) return "friendship";\n`, 'Plan identity');
  const category = '  if ([1613].includes(typeId) || [4588].includes(directionId)) return "open_game";\n';
  // Provider scope: 6182/2349 = Pulkovo game, 6246/2349 = Pulkovo tournament.
  // Do not classify every corporate event (2349) or grant a free tournament visit.
  result = replaceOnce(result, category,
    '  if (typeId === 2349 && directionId === 6182) return "open_game";\n'
    + '  if (typeId === 2349 && directionId === 6246) return "tournament";\n' + category, 'Pulkovo category');
  new Function('msg', 'node', 'env', 'global', result);
  return result;
}

export function composePulkovoArtifacts(rawSource) {
  const liveBytes = Buffer.from(rawSource);
  assert.equal(sha256(liveBytes), PULKOVO_SOURCE_SHA256, 'Live flow preimage drift');
  const flow = JSON.parse(liveBytes);
  assert.equal(flow.length, 4822, 'Live graph node count drift');
  assert.equal(new Set(flow.map(node => node.id)).size, flow.length, 'Duplicate node id');
  const gateway = flow.find(node => node.id === PULKOVO_NODE_IDS.gateway);
  const preview = flow.find(node => node.id === PULKOVO_NODE_IDS.preview);
  for (const [key, value] of Object.entries({ gatewayFunc: gateway?.func,
    gatewayInitialize: gateway?.initialize, previewFunc: preview?.func })) {
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
  const transition = buildPulkovoTransition(expectedPrior);
  gateway.initialize = initialize.slice(0, start) + transition.initialize + initialize.slice(end);
  new Function('global', gateway.initialize);
  gateway.func = patchPulkovoRouterBody(gateway.func);
  preview.func = patchPulkovoRouterBody(preview.func);
  const candidateBytes = Buffer.from(`${JSON.stringify(flow, null, 2)}\n`);
  const changes = [{ id: gateway.id, fields: ['func', 'initialize'] },
    { id: preview.id, fields: ['func'] }];
  const contract = buildExactGraphContract({ liveBytes, candidateBytes,
    deploymentId: 'lk1-pulkovo-friendship', allowedChanges: changes, allowedAdditionIds: [] });
  validateReviewedFlowContract({ liveBytes, candidateBytes, contract });
  return { candidateBytes, contract, transition, changes,
    sourceSha256: sha256(liveBytes), candidateSha256: sha256(candidateBytes) };
}

// Rollback is the exact protected source backup, accepted only against this migration's
// exact candidate. Never rebuild an older generic graph over newer production changes.
export function revertPulkovoArtifacts(rawSource, rawCandidate) {
  const { candidateBytes } = composePulkovoArtifacts(rawSource);
  assert.deepEqual(Buffer.from(rawCandidate), candidateBytes, 'Rollback candidate drift');
  return Buffer.from(rawSource);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const [source, outputDir, ...extra] = process.argv.slice(2);
  if (!source || !outputDir || extra.length || !path.isAbsolute(source) || !path.isAbsolute(outputDir)) {
    throw new Error('Usage: node scripts/patch_live_lk1_pulkovo_friendship.mjs /absolute/source.flow.json /absolute/new-output-dir');
  }
  const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
  const parent = fs.realpathSync(path.dirname(outputDir));
  const output = path.join(parent, path.basename(outputDir));
  if (output === repo || output.startsWith(`${repo}${path.sep}`)) throw new Error('Output must be outside repository');
  if (fs.existsSync(output)) throw new Error('Output already exists');
  const artifacts = composePulkovoArtifacts(fs.readFileSync(source));
  fs.mkdirSync(output, { mode: 0o700 });
  for (const [name, content] of Object.entries({ 'candidate.flow.json': artifacts.candidateBytes,
    'contract.json': `${JSON.stringify(artifacts.contract, null, 2)}\n`,
    'plan-rules.json': `${JSON.stringify(artifacts.transition.desired, null, 2)}\n` })) {
    fs.writeFileSync(path.join(output, name), content, { mode: 0o600, flag: 'wx' });
  }
  console.log(JSON.stringify({ sourceSha256: artifacts.sourceSha256, candidateSha256: artifacts.candidateSha256,
    changes: artifacts.changes, productId: PULKOVO_PRODUCT_ID, rule: artifacts.transition.desired.rules.at(-1),
    liveMutationAuthorized: false, outputDir: output }));
}
