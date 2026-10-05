#!/usr/bin/env node

// Focused, read-only candidate for «Дружба.Патриоты». The installed two-hour
// friendship graph is the preimage; the money-validity guard, guarded plan rule,
// event classifier, and policy evaluators change. The installed preview keeps
// its two-hour generation and receives only the same scoped classifier delta.
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildExactGraphContract, validateReviewedFlowContract } from './nodered_reviewed_flow_deploy/runtime_contract.mjs';
import { LK1_PLAN_RULES_WITH_FRIENDSHIP_TWO_HOURS,
  buildPatriotsPlanRulesTransition } from './lib/lk1PlanRulesTransition.mjs';

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const sha256 = value => crypto.createHash('sha256').update(value).digest('hex');
export const PATRIOTS_DEPLOYMENT_ID = 'lk1-patriots-friendship';
export const PATRIOTS_SOURCE_SHA256 = 'cc2d76f4ad9b7462cb5534434a52d9e8a58633a9c2134b179cb7b921b871c80f';
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
  gatewayFunc: 'cfce248c5573aa5d9d85d4ff291fd25e9f7bd4896e04c9d99d2200a220a7790b',
  gatewayInitialize: 'd7aec140d29a33411e416f05652aa09f23f2f436a491d76827afb3b17282f7a5',
  evaluatorFunc: '2d3f5b5080152c07ace9e4aaf31e7b0280878576c027ca7f5c30dd15d9b45602',
  evaluatorEmbedded: 'ecc81fb6ee14e5948a61c54157c124408928935d9b9008c6e939238f43be89f3',
  previewFunc: '0681948096431961e141b98e35f4c3c26c834bafbb4054b52fe7dd5d963eb1f3',
  previewEvaluatorFunc: 'c20f0e6d792c02bdd0f945b84aaba2ac6405386add6228823cbb30fd2ca38945',
  previewEvaluatorEmbedded: 'f1f65a2050523e6104ee0586e1ad62bb0f6945b0ff1dc1583fd52dcf3a9a0433',
  pricingFunc: 'd93de261c85ba62e3ba782acad1a364bc63e97433bcbebba81b20f5c3eb7206b',
  joinFunc: '8b312b97a75112d8e10d13642be649cd795f77a506c4925152338b6854c2b074',
  usageBlock: '5fce82de1d012254f863a90388c75f581f9dcf843e520b10d17a968bc6b3f1ef',
  // Reviewed-source pins (working tree, not the live flow). Re-pinned 2026-10-02 after merging
  // origin/main, and again 2026-10-05 with the club court-hourly co-pay owner decision (the
  // reviewed gateway, hooks and evaluator now carry the court-window proof, the #174 open_game
  // club gate and the club game/training branches). The live-node preimages above stay untouched
  // until a fresh 147 pull is reviewed: the Patriots generation itself composes only on its own
  // 2026-10-02 live preimage, which the 2026-10-05 focused body has replaced.
  reviewedGatewaySource: '430dbb09b3df1379c1100a0af784720abfdb9687b89662999d982db4aedeef8a',
  reviewedGatewayHooksSource: '2225ca5234313613e1e5ede2d767dcbfacddc03bb0976a45ae4a970c7bf9dfef',
  reviewedEvaluatorSource: 'ac05d7cd876523d19ec380cd3f7d68c78ea48320cf5586160b19e6cb3e613d9d',
  reviewedBookingRouterSource: '86b63d2f5e61c9046f31189c8f384ee6e6abfe5cf94c309cc51f7458d9aa1991',
  // Re-pinned again 2026-10-05 for the club court-hourly co-pay (owner decision of the same day):
  // the event preview now quotes a `COURT_HOURLY_COPAY` decision under its own kind
  // (`GROUP_TRAINING_COURT_COPAY_V1`) with the proved court numbers. This generation copies the
  // reviewed router bytes verbatim, so its reviewed-source pin moves with the file; the installed
  // preview preimages and the postimages above stay untouched until a fresh 147 pull is reviewed.
  reviewedPreviewSource: '523edd57298808df05aafee33f2fe1177d34c5df947e8f8c4f8b6878452f0af4',
});
export const PATRIOTS_POSTIMAGE = Object.freeze({
  gatewayFunc: '660b48b3774149bfc28809206d44a4dfb74fefd1ced37bbf6824d7be3d89d120',
  gatewayInitialize: '283f9e8a3468e8e4ebad56e479aacd13084a60006783b55e578c3c36fe8847d3',
  evaluatorFunc: '131de088b7b1cf97947cc5f86cbc75287a81b77d424e1e2947f7fa6760984ab9',
  previewFunc: 'f2851f3d459f258c3a63782822d0a93bd1c3e99df182f45b721be6d34ff46d25',
  previewEvaluatorFunc: '131de088b7b1cf97947cc5f86cbc75287a81b77d424e1e2947f7fa6760984ab9',
});

const PLAN_START = 'const lk1PlanRulesKey = "subscriptions_lk1_plan_rules";';
const PLAN_END = 'const lk1StationExclusionsKey';
const EVALUATOR_OPEN = 'if (Object.prototype.hasOwnProperty.call(msg._managedSubscriptionPolicyInput || {}, "lk1Policy")) {\n  return (() => {\n';
const EVALUATOR_CLOSE = '\n})();\n}';
const FIRST_USE_ANCHOR = '    const firstUse = preflightAvailability.resolveSplitSubscriptionLifecycle(subscription, eventDate(exercise)) === "NEW_FIRST_USE_CANDIDATE";\n';
const OWNER_GUARD_ANCHOR = '    if (owners.some((id) => normalizeId(id) !== normalizeId(ctx.actorClientId))) violations.push("owner_mismatch");\n';
const PATRIOTS_MONEY_SCOPE_OLD = '  const selected = findOwnedSubscriptions({ ...exercise, availableClientSubscriptions: rows }, ctx.clientSubscriptionId);\n';
const PATRIOTS_MONEY_SCOPE_NEW = '  const selectedRows = findOwnedSubscriptions({ ...exercise, availableClientSubscriptions: rows }, ctx.clientSubscriptionId);\n';
const PATRIOTS_MONEY_SCOPE_END = '  // The resolver alone decides the enforced cohort:';
const PATRIOTS_EARLY_GUARD_ANCHOR = '  const enforcedRule = selectedRule.matched && !selectedRule.legacy;\n';
const PATRIOTS_EARLY_GUARD_START = '// The product identity was confirmed by the server before this exercise read.\n';
const PATRIOTS_EARLY_GUARD_END = 'let ruleConfigured = false;';
const PATRIOTS_DETOUR_OLD = '    && ruleConfigured && ctx.lk1MoneyReadbackPhase !== "exercise"\n'
  + '    && (selectedOwned.length === 0 || enforcedRule)) {';
const PATRIOTS_DETOUR_NEW = '    && (patriotsMoneyOnlyIdentity || ruleConfigured) && ctx.lk1MoneyReadbackPhase !== "exercise"\n'
  + '    && (patriotsMoneyOnlyIdentity || selectedOwned.length === 0 || enforcedRule)) {';
const PATRIOTS_MONEY_ONLY_GUARD = '    const patriotsMoneyOnlyEvent = configured.rule?.productId === "37ab3713-4431-4815-96ba-d7ece76a9241"\n      && ["group_training", "tournament"].includes(resolveCategory(exercise));\n';
const PATRIOTS_FIRST_USE_REFUSAL = '    if (firstUse && patriotsMoneyOnlyEvent) violations.push("patriots_activation_required");\n';
const CATEGORY_ANCHOR = '  if ([1613].includes(typeId) || [4588].includes(directionId)) return "open_game";\n';
const PATRIOTS_CATEGORY_MAPPING = '  if (typeId === 2349 && directionId === 6181) return "open_game";\n'
  + '  if (typeId === 2349 && directionId === 6306) return "tournament";\n'
  + '  if (typeId === 2349 && directionId === 6307) return "group_training";\n';
// The merged reviewed booking router carries main's club-direction pin (#174, club game 6180
// and club training 6233) on the same line the Patriots mapping is inserted before, so the
// reviewed-source assertion needs that merged text. `CATEGORY_ANCHOR` above stays the pinned
// installed-preimage literal: the delta is still applied to the live flow pulled before #174.
const REVIEWED_CATEGORY_ANCHOR = '  if ([1613].includes(typeId) || [4588, 6180].includes(directionId)) return "open_game";\n';
const PREVIEW_GAME_SCOPE_START = '  const visitCount = ctx.previewResolved ? 1 : ctx.target.durationMinutes >= 90 ? 2 : 1;\n';
const PREVIEW_GAME_SCOPE_END = '  if (!ctx.previewResolved) {';
const PREVIEW_GAME_TARGET_OLD = 'priceProductId: ctx.priceProductId } : {}) } } };';
const PREVIEW_GAME_TARGET_NEW = 'priceProductId: ctx.priceProductId } : {\n'
  + '          externalEventTypeId: canonical.managedExternalEventTypeId(exercise) }) } } };';

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
  if (JSON.stringify(installed) !== JSON.stringify(LK1_PLAN_RULES_WITH_FRIENDSHIP_TWO_HOURS)) {
    throw new Error('Installed plan rules are not the reviewed nine-rule prior');
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
  const reviewedHooks = fs.readFileSync(path.join(ROOT,
    'nodered_lk1_hub_nodes/gateway_hooks.js'), 'utf8');
  assertHash(reviewed, PATRIOTS_PREIMAGE.reviewedGatewaySource, 'Reviewed Patriots gateway');
  assertHash(reviewedHooks, PATRIOTS_PREIMAGE.reviewedGatewayHooksSource, 'Reviewed Patriots gateway hooks');
  assertHash(reviewedRouter, PATRIOTS_PREIMAGE.reviewedBookingRouterSource, 'Reviewed booking router');
  if (!reviewed.includes(PATRIOTS_MONEY_ONLY_GUARD)
    || !reviewed.includes(PATRIOTS_FIRST_USE_REFUSAL)
    || !reviewedRouter.includes(PATRIOTS_CATEGORY_MAPPING)
    || !reviewedRouter.includes(REVIEWED_CATEGORY_ANCHOR)) {
    throw new Error('Reviewed Patriots money-validity guard is missing');
  }
  if (source.split(FIRST_USE_ANCHOR).length !== 2 || source.split(OWNER_GUARD_ANCHOR).length !== 2) {
    throw new Error('Gateway money-validity anchors drifted');
  }
  if (source.split(PATRIOTS_EARLY_GUARD_ANCHOR).length !== 2) {
    throw new Error('Gateway Patriots early guard anchor drifted');
  }
  if (source.split(PATRIOTS_DETOUR_OLD).length !== 2
    || !reviewedHooks.includes(PATRIOTS_DETOUR_NEW)) {
    throw new Error('Gateway Patriots readback detour drifted');
  }
  if (source.split(CATEGORY_ANCHOR).length !== 2) throw new Error('Gateway category anchor drifted');
  const installedMoneyRange = replacementRange(source,
    PATRIOTS_MONEY_SCOPE_OLD, PATRIOTS_MONEY_SCOPE_END, 'Installed Patriots money scope');
  const reviewedMoneyRange = replacementRange(reviewed,
    PATRIOTS_MONEY_SCOPE_NEW, PATRIOTS_MONEY_SCOPE_END, 'Reviewed Patriots money scope');
  const earlyGuardRange = replacementRange(reviewedHooks,
    PATRIOTS_EARLY_GUARD_START, PATRIOTS_EARLY_GUARD_END, 'Reviewed Patriots early guard');
  const earlyGuard = reviewedHooks.slice(earlyGuardRange.start, earlyGuardRange.end)
    .trimEnd().split('\n').map(line => `  ${line}`).join('\n') + '\n';
  const patchedMoneyScope = source.slice(0, installedMoneyRange.start)
    + reviewed.slice(reviewedMoneyRange.start, reviewedMoneyRange.end)
    + source.slice(installedMoneyRange.end);
  const patched = patchedMoneyScope.replace(FIRST_USE_ANCHOR, FIRST_USE_ANCHOR + PATRIOTS_MONEY_ONLY_GUARD)
    .replace(OWNER_GUARD_ANCHOR, OWNER_GUARD_ANCHOR + PATRIOTS_FIRST_USE_REFUSAL)
    .replace(PATRIOTS_EARLY_GUARD_ANCHOR, PATRIOTS_EARLY_GUARD_ANCHOR + earlyGuard)
    .replace(PATRIOTS_DETOUR_OLD, PATRIOTS_DETOUR_NEW)
    .replace(CATEGORY_ANCHOR, PATRIOTS_CATEGORY_MAPPING + CATEGORY_ANCHOR);
  assertBody(patched, 'Patriots gateway body');
  return patched;
}

function reviewedEvaluator() {
  const source = fs.readFileSync(path.join(ROOT, 'nodered_lk1_hub_nodes/evaluator.js'), 'utf8');
  assertHash(source, PATRIOTS_PREIMAGE.reviewedEvaluatorSource, 'Reviewed Patriots evaluator');
  return source;
}

function reviewedPreview() {
  const source = fs.readFileSync(path.join(ROOT,
    'nodered_subscription_price_preview_nodes/router.js'), 'utf8');
  assertHash(source, PATRIOTS_PREIMAGE.reviewedPreviewSource, 'Reviewed Patriots preview');
  if (!source.includes(PREVIEW_GAME_TARGET_NEW)) {
    throw new Error('Reviewed Patriots preview game target is missing');
  }
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
  if (preview.func.split(CATEGORY_ANCHOR).length !== 2) {
    throw new Error('Preview category anchor drifted');
  }

  gateway.func = patchPatriotsGatewayBody(gateway.func);
  gateway.initialize = patchPatriotsGatewayInitialize(gateway.initialize);
  evaluator.func = patchPatriotsEvaluator(evaluator.func,
    PATRIOTS_PREIMAGE.evaluatorFunc, PATRIOTS_PREIMAGE.evaluatorEmbedded);
  previewEvaluator.func = patchPatriotsEvaluator(previewEvaluator.func,
    PATRIOTS_PREIMAGE.previewEvaluatorFunc, PATRIOTS_PREIMAGE.previewEvaluatorEmbedded);
  const previewSource = reviewedPreview();
  const installedScope = replacementRange(preview.func,
    PREVIEW_GAME_SCOPE_START, PREVIEW_GAME_SCOPE_END, 'Installed preview game scope');
  const reviewedScope = replacementRange(previewSource,
    PREVIEW_GAME_SCOPE_START, PREVIEW_GAME_SCOPE_END, 'Reviewed preview game scope');
  if (preview.func.split(PREVIEW_GAME_TARGET_OLD).length !== 2) {
    throw new Error('Installed preview game target drifted');
  }
  preview.func = preview.func.slice(0, installedScope.start)
    + previewSource.slice(reviewedScope.start, reviewedScope.end)
    + preview.func.slice(installedScope.end);
  preview.func = preview.func.replace(PREVIEW_GAME_TARGET_OLD, PREVIEW_GAME_TARGET_NEW);
  preview.func = preview.func.replace(CATEGORY_ANCHOR,
    PATRIOTS_CATEGORY_MAPPING + CATEGORY_ANCHOR);
  // Both routes receive the same exact three-case delta. Preserve every other
  // installed preview helper, including the two-hour plan's day bucket.
  if (gateway.func.split(PATRIOTS_CATEGORY_MAPPING).length !== 2
    || preview.func.split(PATRIOTS_CATEGORY_MAPPING).length !== 2) {
    throw new Error('Booking and preview category deltas differ');
  }
  assertBody(preview.func, 'Patriots preview router');
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
