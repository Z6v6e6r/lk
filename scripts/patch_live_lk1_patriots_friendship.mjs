#!/usr/bin/env node

// Focused, read-only candidate for «Дружба.Патриоты». The installed Topokraty
// graph remains the preimage; the money-validity guard, guarded plan rule,
// and policy evaluators change. The preview router is recomposed and proved unchanged.
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildExactGraphContract, validateReviewedFlowContract } from './nodered_reviewed_flow_deploy/runtime_contract.mjs';
import { previewSources } from './patch_nodered_subscription_price_preview.mjs';
import { patchTopokratyCopayPreviewBody } from './patch_live_lk1_topokraty_copay_hotfix.mjs';
import { LK1_PLAN_RULES_WITH_TOPOKRATY, buildPatriotsPlanRulesTransition } from './lib/lk1PlanRulesTransition.mjs';

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const sha256 = value => crypto.createHash('sha256').update(value).digest('hex');
export const PATRIOTS_DEPLOYMENT_ID = 'lk1-patriots-friendship';
export const PATRIOTS_SOURCE_SHA256 = '845e03694c10a14b966a47179ee01afd20d42e85bef61239b43550afaa550acd';
export const PATRIOTS_SOURCE_NODE_COUNT = 4804;
export const PATRIOTS_NODES = Object.freeze({
  gateway: 'lk_subscription_booking_router_20260804',
  evaluator: 'lk_subscription_managed_policy_20260820',
  preview: 'lk_subscription_price_preview_20260908_router',
  previewEvaluator: 'lk_subscription_price_preview_20260908_evaluate',
  pricing: '8f7bd5b482fe9763',
  join: 'e92e68bf3f08a70c',
});
export const PATRIOTS_PREIMAGE = Object.freeze({
  gatewayFunc: 'e3b46e691517118cabbe259bb3831b99896b3f8a32202b437fa452d8349f17ee',
  gatewayInitialize: '08f6b84d73e1fc0c74f9c27b285e050ff65f2513e4aec938bc9ccb2a1dfd5602',
  evaluatorFunc: '443f2633e92f1aa4ce2f2df85b6e100a216a9cebcbc136a30c4c7a2ec8284a63',
  evaluatorEmbedded: '2a7878abff5bb5f3618b439191616c4a01a7a592f4322aeb3aaadad3f3d7046a',
  previewFunc: '7605df8c0f89c68cbf865b490e5437260c5b2cc8495cd2a5127ad04e09d30dab',
  previewEvaluatorFunc: 'c20f0e6d792c02bdd0f945b84aaba2ac6405386add6228823cbb30fd2ca38945',
  previewEvaluatorEmbedded: 'f1f65a2050523e6104ee0586e1ad62bb0f6945b0ff1dc1583fd52dcf3a9a0433',
  pricingFunc: 'd93de261c85ba62e3ba782acad1a364bc63e97433bcbebba81b20f5c3eb7206b',
  joinFunc: '8b312b97a75112d8e10d13642be649cd795f77a506c4925152338b6854c2b074',
  usageBlock: '3436bdd2fa8d47f1d8952ada7e5a996137cc078169053009a6cc1447d7eb26f9',
  reviewedGatewaySource: 'd14dca132b57398b4ab1c1476f28e2d20fd94d70fdc0eb0ea5a664e891dc8ebb',
  reviewedEvaluatorSource: 'fe6ce3f622eb9c4b72e62374c128b3b73c092b6c1d0f7409f59710651020beb2',
  reviewedBookingRouterSource: '17f9684f55f02a2ededbaef0171144e6a3ec7861c7ba7804c8ab2b7bf41315a3',
});
export const PATRIOTS_POSTIMAGE = Object.freeze({
  gatewayFunc: '8edc5c73c8c329c2c2a3f0e7e82e1c6972b58561e4873f2a110af2411e841bb7',
  gatewayInitialize: '21ec4149ae17b2e514f705c40f3d4f0d8878c12005043047e0baeded4b2c6561',
  evaluatorFunc: 'a955350ed397bc2f173782f80e3eaa173f22f4835325b1476394db6b523d829a',
  previewFunc: '78f31a157cf6b77356bd7f6af77db01d38ddfd58407f32daf3426a0cffa2b2e9',
  previewEvaluatorFunc: 'a955350ed397bc2f173782f80e3eaa173f22f4835325b1476394db6b523d829a',
});

const PLAN_START = 'const lk1PlanRulesKey = "subscriptions_lk1_plan_rules";';
const PLAN_END = 'const lk1StationExclusionsKey';
const EVALUATOR_OPEN = 'if (Object.prototype.hasOwnProperty.call(msg._managedSubscriptionPolicyInput || {}, "lk1Policy")) {\n  return (() => {\n';
const EVALUATOR_CLOSE = '\n})();\n}';
const FIRST_USE_ANCHOR = '    const firstUse = preflightAvailability.resolveSplitSubscriptionLifecycle(subscription, eventDate(exercise)) === "NEW_FIRST_USE_CANDIDATE";\n';
const OWNER_GUARD_ANCHOR = '    if (owners.some((id) => normalizeId(id) !== normalizeId(ctx.actorClientId))) violations.push("owner_mismatch");\n';
const PATRIOTS_MONEY_ONLY_GUARD = '    const patriotsMoneyOnlyEvent = configured.rule?.productId === "37ab3713-4431-4815-96ba-d7ece76a9241"\n      && ["group_training", "tournament"].includes(resolveCategory(exercise));\n';
const PATRIOTS_FIRST_USE_REFUSAL = '    if (firstUse && patriotsMoneyOnlyEvent) violations.push("patriots_activation_required");\n';
const CATEGORY_ANCHOR = '  if ([1613].includes(typeId) || [4588].includes(directionId)) return "open_game";\n';
const PATRIOTS_CATEGORY_MAPPING = '  if (typeId === 2349 && directionId === 6181) return "open_game";\n'
  + '  if (typeId === 2349 && directionId === 6306) return "tournament";\n'
  + '  if (typeId === 2349 && directionId === 6307) return "group_training";\n';

function assertHash(value, expected, label) {
  const actual = sha256(value);
  if (actual !== expected) throw new Error(`${label} drift: ${actual} != ${expected}`);
}

function assertNode(flow, id) {
  const matches = flow.filter(node => node.id === id);
  if (matches.length !== 1 || matches[0].type !== 'function' || typeof matches[0].func !== 'string'
    || typeof matches[0].initialize !== 'string' || matches[0].d === true || matches[0].disabled === true) {
    throw new Error(`Function node contract drift: ${id}`);
  }
  return matches[0];
}

function assertBody(body, label) {
  try { new Function('msg', 'node', 'env', 'global', body); }
  catch (error) { throw new Error(`${label} does not parse: ${error.message}`); }
}

function replacementRange(source, startMarker, endMarker, label) {
  if (source.split(startMarker).length !== 2 || source.split(endMarker).length !== 2) {
    throw new Error(`${label} anchors are not unique`);
  }
  const start = source.indexOf(startMarker);
  const end = source.indexOf(endMarker, start + startMarker.length);
  if (end < 0) throw new Error(`${label} boundary drift`);
  return { start, end };
}

export function patchPatriotsGatewayInitialize(source) {
  assertHash(source, PATRIOTS_PREIMAGE.gatewayInitialize, 'Gateway initialize preimage');
  const { start, end } = replacementRange(source, PLAN_START, PLAN_END, 'Plan rule');
  const block = source.slice(start, end);
  const literal = 'const lk1DesiredPlanRules = ';
  if (block.split(literal).length !== 2) throw new Error('Installed plan payload anchor drift');
  const installed = JSON.parse(block.slice(block.indexOf(literal) + literal.length).split(';\n')[0]);
  if (JSON.stringify(installed) !== JSON.stringify(LK1_PLAN_RULES_WITH_TOPOKRATY)) {
    throw new Error('Installed plan rules are not the reviewed eight-rule prior');
  }
  const patched = source.slice(0, start) + buildPatriotsPlanRulesTransition().initialize + source.slice(end);
  if (patched.split('"planKey":"patriots"').length !== 2) throw new Error('Patriots plan rule is not unique');
  assertBody(patched, 'Patriots gateway initialize');
  return patched;
}

export function patchPatriotsGatewayBody(source) {
  assertHash(source, PATRIOTS_PREIMAGE.gatewayFunc, 'Gateway body preimage');
  const reviewed = fs.readFileSync(path.join(ROOT, 'nodered_lk1_hub_nodes/gateway.js'), 'utf8');
  const reviewedRouter = fs.readFileSync(path.join(ROOT,
    'nodered_subscription_booking_nodes/fn_subscription_booking_router.js'), 'utf8');
  assertHash(reviewed, PATRIOTS_PREIMAGE.reviewedGatewaySource, 'Reviewed Patriots gateway');
  assertHash(reviewedRouter, PATRIOTS_PREIMAGE.reviewedBookingRouterSource, 'Reviewed booking router');
  if (!reviewed.includes(PATRIOTS_MONEY_ONLY_GUARD)
    || !reviewed.includes(PATRIOTS_FIRST_USE_REFUSAL)
    || !reviewedRouter.includes(PATRIOTS_CATEGORY_MAPPING + CATEGORY_ANCHOR)) {
    throw new Error('Reviewed Patriots money-validity guard is missing');
  }
  if (source.split(FIRST_USE_ANCHOR).length !== 2 || source.split(OWNER_GUARD_ANCHOR).length !== 2) {
    throw new Error('Gateway money-validity anchors drifted');
  }
  if (source.split(CATEGORY_ANCHOR).length !== 2) throw new Error('Gateway category anchor drifted');
  const patched = source.replace(FIRST_USE_ANCHOR, FIRST_USE_ANCHOR + PATRIOTS_MONEY_ONLY_GUARD)
    .replace(OWNER_GUARD_ANCHOR, OWNER_GUARD_ANCHOR + PATRIOTS_FIRST_USE_REFUSAL)
    .replace(CATEGORY_ANCHOR, PATRIOTS_CATEGORY_MAPPING + CATEGORY_ANCHOR);
  assertBody(patched, 'Patriots gateway body');
  return patched;
}

function reviewedEvaluator() {
  const source = fs.readFileSync(path.join(ROOT, 'nodered_lk1_hub_nodes/evaluator.js'), 'utf8');
  assertHash(source, PATRIOTS_PREIMAGE.reviewedEvaluatorSource, 'Reviewed Patriots evaluator');
  return source;
}

export function patchPatriotsEvaluator(source, preimageSha256, embeddedSha256) {
  assertHash(source, preimageSha256, 'Evaluator preimage');
  const { start: open, end } = replacementRange(source, EVALUATOR_OPEN, EVALUATOR_CLOSE, 'Evaluator LK1');
  const start = open + EVALUATOR_OPEN.length;
  assertHash(source.slice(start, end), embeddedSha256, 'Evaluator embedded preimage');
  const patched = source.slice(0, start) + reviewedEvaluator() + source.slice(end);
  if (patched.split('PATRIOTS_FRIENDSHIP_PRODUCT_ID').length < 3) throw new Error('Patriots evaluator branch absent');
  assertBody(patched, 'Patriots evaluator');
  return patched;
}

function usageBlock(booking) {
  const { start, end } = replacementRange(booking,
    'if (ctx.step === "lk1_usage_operations") {', 'if (ctx.step === "lk1_policy_decision") {', 'Usage');
  return booking.slice(start, end);
}

export function composePatriotsArtifacts(rawSource, { assertPostimages = true } = {}) {
  const liveBytes = Buffer.isBuffer(rawSource) ? rawSource : Buffer.from(rawSource);
  assertHash(liveBytes, PATRIOTS_SOURCE_SHA256, 'Live flow preimage');
  const flow = JSON.parse(liveBytes.toString('utf8'));
  if (!Array.isArray(flow) || flow.length !== PATRIOTS_SOURCE_NODE_COUNT
    || new Set(flow.map(node => node.id)).size !== flow.length) throw new Error('Live flow graph drift');
  const gateway = assertNode(flow, PATRIOTS_NODES.gateway);
  const evaluator = assertNode(flow, PATRIOTS_NODES.evaluator);
  const preview = assertNode(flow, PATRIOTS_NODES.preview);
  const previewEvaluator = assertNode(flow, PATRIOTS_NODES.previewEvaluator);
  assertHash(gateway.func, PATRIOTS_PREIMAGE.gatewayFunc, 'Gateway body preimage');
  assertHash(evaluator.func, PATRIOTS_PREIMAGE.evaluatorFunc, 'Evaluator body preimage');
  assertHash(preview.func, PATRIOTS_PREIMAGE.previewFunc, 'Preview router preimage');
  assertHash(previewEvaluator.func, PATRIOTS_PREIMAGE.previewEvaluatorFunc, 'Preview evaluator preimage');
  assertHash(assertNode(flow, PATRIOTS_NODES.pricing).func, PATRIOTS_PREIMAGE.pricingFunc, 'Pricing preimage');
  assertHash(assertNode(flow, PATRIOTS_NODES.join).func, PATRIOTS_PREIMAGE.joinFunc, 'Join preimage');
  assertHash(usageBlock(gateway.func), PATRIOTS_PREIMAGE.usageBlock, 'Usage preimage');
  const pins = { booking: PATRIOTS_PREIMAGE.gatewayFunc, evaluator: PATRIOTS_PREIMAGE.evaluatorFunc,
    pricing: PATRIOTS_PREIMAGE.pricingFunc, join: PATRIOTS_PREIMAGE.joinFunc };
  const installedPreview = patchTopokratyCopayPreviewBody(previewSources(flow,
    { pins, installedUsageSha256: PATRIOTS_PREIMAGE.usageBlock }).router);
  if (installedPreview !== preview.func) throw new Error('Installed preview provenance drift');

  gateway.func = patchPatriotsGatewayBody(gateway.func);
  gateway.initialize = patchPatriotsGatewayInitialize(gateway.initialize);
  evaluator.func = patchPatriotsEvaluator(evaluator.func,
    PATRIOTS_PREIMAGE.evaluatorFunc, PATRIOTS_PREIMAGE.evaluatorEmbedded);
  previewEvaluator.func = patchPatriotsEvaluator(previewEvaluator.func,
    PATRIOTS_PREIMAGE.previewEvaluatorFunc, PATRIOTS_PREIMAGE.previewEvaluatorEmbedded);
  const recomposedPreview = patchTopokratyCopayPreviewBody(previewSources(flow, {
    pins: { ...pins, booking: sha256(gateway.func), evaluator: sha256(evaluator.func) },
    installedUsageSha256: PATRIOTS_PREIMAGE.usageBlock,
  }).router);
  if (!recomposedPreview.includes(PATRIOTS_CATEGORY_MAPPING + CATEGORY_ANCHOR)) {
    throw new Error('Patriots preview category mapping is absent');
  }
  preview.func = recomposedPreview;
  if (assertPostimages) {
    assertHash(gateway.func, PATRIOTS_POSTIMAGE.gatewayFunc, 'Gateway body postimage');
    assertHash(gateway.initialize, PATRIOTS_POSTIMAGE.gatewayInitialize, 'Gateway initialize postimage');
    assertHash(evaluator.func, PATRIOTS_POSTIMAGE.evaluatorFunc, 'Evaluator postimage');
    assertHash(preview.func, PATRIOTS_POSTIMAGE.previewFunc, 'Preview router postimage');
    assertHash(previewEvaluator.func, PATRIOTS_POSTIMAGE.previewEvaluatorFunc, 'Preview evaluator postimage');
  }
  const changes = [
    { id: PATRIOTS_NODES.gateway, fields: ['func', 'initialize'] },
    { id: PATRIOTS_NODES.evaluator, fields: ['func'] },
    { id: PATRIOTS_NODES.preview, fields: ['func'] },
    { id: PATRIOTS_NODES.previewEvaluator, fields: ['func'] },
  ];
  const candidateBytes = Buffer.from(`${JSON.stringify(flow, null, 2)}\n`);
  const contract = buildExactGraphContract({ liveBytes, candidateBytes,
    deploymentId: PATRIOTS_DEPLOYMENT_ID, allowedChanges: changes, allowedAdditionIds: [] });
  validateReviewedFlowContract({ liveBytes, candidateBytes, contract });
  return { candidateBytes, contract, changes,
    sourceSha256: sha256(liveBytes), candidateSha256: sha256(candidateBytes),
    postimages: { gatewayFunc: sha256(gateway.func), gatewayInitialize: sha256(gateway.initialize),
      evaluatorFunc: sha256(evaluator.func), previewFunc: sha256(preview.func),
      previewEvaluatorFunc: sha256(previewEvaluator.func) } };
}
