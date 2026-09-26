// The LK1 «Дружба Топократы» co-pay generation: the reviewed delivery vehicle that finally
// installs the club money mandate the 2026-09-26 contour assumed was already live.
//
// The hermetic half drives the reviewed club pricing on synthetic decisions and proves the
// reviewed money fragment is byte-identical to the reviewed payment source; the snapshot half
// proves the candidate against the exact installed flow (skipped when that private flow is
// absent) and proves that the two earlier generations still compose to their frozen candidates.
import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import test from "node:test";
import {
  TOPOKRATY_COPAY_APPLIED_SHA256,
  TOPOKRATY_COPAY_CLUB_FRAGMENT_SHA256,
  TOPOKRATY_COPAY_TARGET,
  TOPOKRATY_COPAY_UPSTREAM_SHA256,
  buildTopokratyCopayReport,
  clubMoneyFragment,
  composeTopokratyCopayArtifacts,
  composeTopokratyCopayRevertArtifacts,
  sha256,
} from "../patch_live_lk1_topokraty_copay_hotfix.mjs";
import { composeTopokratyArtifacts, TOPOKRATY_UPSTREAM_SHA256 } from "../patch_live_lk1_topokraty_friendship_hotfix.mjs";
import { composeTopokratyReclaimArtifacts, TOPOKRATY_RECLAIM_UPSTREAM_SHA256 } from "../patch_live_lk1_topokraty_rejection_reclaim_hotfix.mjs";

const PREIMAGE = process.env.LK1_TOPOKRATY_COPAY_PREIMAGE
  ?? "/private/tmp/padlhub-topokraty-apply-20260925/input/source.flow.json";
const skip = fs.existsSync(PREIMAGE) ? false : `private live flow is absent: ${PREIMAGE}`;
const installedFlow = () => composeTopokratyReclaimArtifacts(fs.readFileSync(PREIMAGE)).candidateBytes;

// ---------------------------------------------------------------------------------------------
// The reviewed club pricing, driven on synthetic decisions straight from the reviewed source.
const paymentSource = fs.readFileSync("scripts/nodered_lk1_hub_nodes/event_payments.js", "utf8");
const CLUB_FRAGMENT_END_TEXT = "  lk1ClubEventPaymentBinding(ctx, quote) || lk1EventPaymentBinding(ctx, quote);";
const paymentScopeSource = paymentSource.slice(paymentSource.indexOf("// Routes are selected"),
  paymentSource.indexOf(CLUB_FRAGMENT_END_TEXT) + CLUB_FRAGMENT_END_TEXT.length);
const paymentScope = new Function(`${paymentScopeSource}\nreturn { lk1ClubEventPaymentBinding, lk1EventPaymentQuoteBinding };`)();

const EXERCISE_ID = "ea5b5b95-ccfa-44c0-8532-615f2e6dc5fb";
const STUDIO_ID = "6b2d7e60-caff-4b22-89f6-6f19d7d311ab";
const PRODUCT_ID = "14692232-12be-4218-9fa1-2d5b79b62035";
const BASE = 400000;

function clubCtx(overrides = {}) {
  return { caller: "http", managedAction: "BOOK_GROUP_TRAINING", category: "group_training",
    exerciseId: EXERCISE_ID, studioId: STUDIO_ID, ...overrides };
}
function clubQuote(overrides = {}) {
  const quote = { rule: { groupTrainingDiscountPercent: 50 },
    target: { category: "GROUP_TRAINING", eventId: EXERCISE_ID, stationId: STUDIO_ID,
      basePriceMinor: BASE, priceProductId: PRODUCT_ID },
    decision: { eligible: true, subscriptionVisitCount: 1, eventDiscountPercent: 50,
      benefit: { kind: "PARTIAL_PRICE_PERCENT_DISCOUNT", finalPriceMinor: 66667 },
      gameMinutes: { freeMinutes: 60, paidOverageMinutes: 30 } } };
  return { ...quote, ...overrides };
}

test("the club mandate prices the paid minutes above the free hour with the decision percent", () => {
  const ctx = clubCtx();
  const quote = clubQuote();
  const binding = paymentScope.lk1EventPaymentQuoteBinding(ctx, quote);
  // floor(400000 * 30 / 90) = 133333, minus 50 % = 66667
  assert.deepEqual(binding, { productId: PRODUCT_ID, productType: "SERVICE", baseMinor: BASE,
    chargeMinor: 66667, discountMinor: BASE - 66667 });
  // A whole event without a free hour is billed by the decision percent.
  const whole = clubQuote({ decision: { eligible: true, subscriptionVisitCount: 0, eventDiscountPercent: 50,
    benefit: { kind: "PERCENT_DISCOUNT", finalPriceMinor: 200000 } } });
  assert.equal(paymentScope.lk1ClubEventPaymentBinding(ctx, whole).chargeMinor, 200000);
  // A free-hour event with nothing above it is a full discount, as in the legacy shape.
  const free = clubQuote({ decision: { eligible: true, subscriptionVisitCount: 1, eventDiscountPercent: 100,
    benefit: { kind: "FREE_ENTITLEMENT", finalPriceMinor: 0 }, gameMinutes: { freeMinutes: 60, paidOverageMinutes: 0 } } });
  assert.equal(paymentScope.lk1ClubEventPaymentBinding(ctx, free), null,
    "the club branch must not price a shape it cannot prove");
  assert.equal(paymentScope.lk1EventPaymentQuoteBinding(ctx, free).chargeMinor, 0,
    "the resolver falls back to the reviewed binding for the free-hour shape");
});

test("the club mandate refuses every shape it cannot prove", () => {
  const cases = [
    ["a split caller", { ctx: clubCtx({ caller: "split" }) }],
    ["another category", { ctx: clubCtx({ category: "open_game" }) }],
    ["another exercise", { quote: clubQuote({ target: { category: "GROUP_TRAINING", eventId: "other",
      stationId: STUDIO_ID, basePriceMinor: BASE, priceProductId: PRODUCT_ID } }) }],
    ["another station", { quote: clubQuote({ target: { category: "GROUP_TRAINING", eventId: EXERCISE_ID,
      stationId: "other", basePriceMinor: BASE, priceProductId: PRODUCT_ID } }) }],
    ["no price product", { quote: clubQuote({ target: { category: "GROUP_TRAINING", eventId: EXERCISE_ID,
      stationId: STUDIO_ID, basePriceMinor: BASE, priceProductId: "" } }) }],
    ["a zero base price", { quote: clubQuote({ target: { category: "GROUP_TRAINING", eventId: EXERCISE_ID,
      stationId: STUDIO_ID, basePriceMinor: 0, priceProductId: PRODUCT_ID } }) }],
    ["a percent above 100", { quote: clubQuote({ decision: { eligible: true, subscriptionVisitCount: 1,
      eventDiscountPercent: 150, benefit: { kind: "PERCENT_DISCOUNT", finalPriceMinor: 0 } } }) }],
    ["an ineligible decision", { quote: clubQuote({ decision: { eligible: false, subscriptionVisitCount: 1,
      eventDiscountPercent: 50, benefit: { kind: "PERCENT_DISCOUNT", finalPriceMinor: 200000 } } }) }],
    ["a price the decision does not match", { quote: clubQuote({ decision: { eligible: true,
      subscriptionVisitCount: 1, eventDiscountPercent: 50,
      benefit: { kind: "PARTIAL_PRICE_PERCENT_DISCOUNT", finalPriceMinor: 1 },
      gameMinutes: { freeMinutes: 60, paidOverageMinutes: 30 } } }) }],
  ];
  for (const [label, overrides] of cases) {
    const binding = paymentScope.lk1ClubEventPaymentBinding(overrides.ctx ?? clubCtx(), overrides.quote ?? clubQuote());
    assert.equal(binding, null, `${label} must not be priced by the club branch`);
  }
});

test("the reviewed money fragment is the reviewed payment source", () => {
  assert.equal(sha256(clubMoneyFragment()), TOPOKRATY_COPAY_CLUB_FRAGMENT_SHA256);
  assert.match(clubMoneyFragment(), /const lk1ClubEventPaymentBinding = \(ctx, quote = ctx\.lk1\) => \{/);
  assert.match(clubMoneyFragment(), /const lk1EventPaymentQuoteBinding = \(ctx, quote = ctx\.lk1\) =>/);
});

// ---------------------------------------------------------------------------------------------
test("the installed generation is the reviewed upstream of this candidate", { skip }, () => {
  assert.equal(sha256(installedFlow()), TOPOKRATY_COPAY_UPSTREAM_SHA256);
});

test("the candidate installs the club money mandate and the contour in two nodes", { skip }, () => {
  const built = composeTopokratyCopayArtifacts(installedFlow());
  assert.equal(built.candidateSha256, TOPOKRATY_COPAY_APPLIED_SHA256);
  assert.equal(built.addedNodeCount, 0);
  assert.deepEqual(built.changes.map((change) => ({ id: change.id, fields: change.fields })), [
    { id: "lk_subscription_booking_router_20260804", fields: ["func", "initialize"] },
    { id: "lk_subscription_managed_policy_20260820", fields: ["func"] },
  ]);
  assert.equal(built.booking.moneyMandateBound, true);
  assert.equal(built.booking.clubContourBound, true);
  assert.equal(built.booking.planRulesPayloadReplaced, true);
  assert.equal(built.booking.excludedSubscriptionsStillRefused, true);
  assert.equal(built.booking.reclaimStillBound, true);
  assert.equal(built.evaluator.clubBranchBound, true);
  const booking = built.flow.find((node) => node.id === "lk_subscription_booking_router_20260804");
  assert.equal(sha256(booking.func), TOPOKRATY_COPAY_TARGET.patchedFuncSha256);
  assert.equal(sha256(booking.initialize), TOPOKRATY_COPAY_TARGET.patchedInitializeSha256);
  assert.equal(sha256(built.flow.find((node) => node.id === "lk_subscription_managed_policy_20260820").func),
    TOPOKRATY_COPAY_TARGET.patchedEvaluatorFuncSha256);
  // The plan-rules writer and the evaluator are the reviewed club bodies of 2026-09-26.
  assert.equal(TOPOKRATY_COPAY_TARGET.patchedInitializeSha256,
    "08f6b84d73e1fc0c74f9c27b285e050ff65f2513e4aec938bc9ccb2a1dfd5602");
  assert.equal(TOPOKRATY_COPAY_TARGET.patchedEvaluatorFuncSha256,
    "443f2633e92f1aa4ce2f2df85b6e100a216a9cebcbc136a30c4c7a2ec8284a63");
});

test("the installed preview already is the club recomposition plus the exclusion", { skip }, () => {
  const built = composeTopokratyCopayArtifacts(installedFlow());
  assert.equal(built.preview.unchanged, true);
  assert.equal(built.preview.matchesClubRecomposition, true);
  assert.equal(built.preview.topokratyExclusionKept, true);
  assert.equal(built.preview.proTrainingKept, true);
  assert.equal(sha256(built.flow.find((node) => node.id === "lk_subscription_price_preview_20260908_router").func),
    TOPOKRATY_COPAY_TARGET.livePreviewFuncSha256);
});

test("every unrelated node stays byte-identical and the report is honest", { skip }, () => {
  const live = installedFlow();
  const built = composeTopokratyCopayArtifacts(live);
  const changed = new Set(["lk_subscription_booking_router_20260804", "lk_subscription_managed_policy_20260820"]);
  for (const node of JSON.parse(live.toString("utf8"))) {
    if (changed.has(node.id)) continue;
    assert.deepEqual(built.flow.find((candidate) => candidate.id === node.id), node, `node ${node.id}`);
  }
  const report = buildTopokratyCopayReport({ sourceSha256: built.sourceSha256, sourceNodeCount: 4804, built });
  assert.equal(report.changedNodeCount, 2);
  assert.equal(report.expectedChangedNodeCount, 2);
  assert.equal(report.addedNodeCount, 0);
  assert.equal(report.planRulesActivation.desiredRuleCount, 8);
  assert.equal(report.planRulesActivation.clubProductId, PRODUCT_ID);
  assert.equal(report.deploymentPerformed, false);
  assert.equal(report.liveMutationPerformed, false);
});

test("a second run and a drifted preimage are refused", { skip }, () => {
  const built = composeTopokratyCopayArtifacts(installedFlow());
  assert.throws(() => composeTopokratyCopayArtifacts(built.candidateBytes), /preimage drift/);
  const flow = JSON.parse(installedFlow().toString("utf8"));
  flow.find((node) => node.id === "lk_subscription_booking_router_20260804").func += "\n// drift";
  assert.throws(() => composeTopokratyCopayArtifacts(Buffer.from(JSON.stringify(flow))), /preimage drift|node count drift/);
});

test("the ordered rollback restores the reviewed 7-rule writer first", { skip }, () => {
  const built = composeTopokratyCopayArtifacts(installedFlow());
  const revert = composeTopokratyCopayRevertArtifacts(built.candidateBytes);
  assert.equal(revert.changes.length, 1);
  assert.deepEqual(revert.changes[0].fields, ["initialize"]);
  // The reviewed 2026-09-26 revert postimage: the club payload stays an accepted prior.
  assert.equal(revert.initialize.afterSha256,
    "5d93ae8a62ad8c2e4a9892b77730c8cbbd3858e92e4172e0d3e6bdc949133da5");
  assert.throws(() => composeTopokratyCopayRevertArtifacts(installedFlow()), /Applied co-pay flow preimage drift/);
});

test("the earlier generations still compose to their frozen candidates", { skip }, () => {
  const preimage = fs.readFileSync(PREIMAGE);
  assert.equal(sha256(preimage), "d6df38f3148c576a1602f9d6e9509345d668a725044f0e536411c5b5bcb73dbe");
  assert.equal(TOPOKRATY_UPSTREAM_SHA256, "d6df38f3148c576a1602f9d6e9509345d668a725044f0e536411c5b5bcb73dbe");
  assert.equal(composeTopokratyArtifacts(preimage).candidateSha256,
    "68debf146be1fcad65a6fd17fc38113d7f97158b0607c16cdd6887bb356043b5");
  assert.equal(TOPOKRATY_RECLAIM_UPSTREAM_SHA256, "d6df38f3148c576a1602f9d6e9509345d668a725044f0e536411c5b5bcb73dbe");
  assert.equal(sha256(installedFlow()), "9d2487a470a86bd0f8d3104aa029b81a6292a738209338740fe3f2d37dc0ed8d");
});

test("the deploy package has an explicit confirmation and an ordered rollback", () => {
  const deploy = fs.readFileSync(new URL("../deploy_nodered_lk1_topokraty_copay_147.sh", import.meta.url), "utf8");
  assert.match(deploy, /NODE_RED_LK1_TOPOKRATY_COPAY_DEPLOY:-\}" != "CONFIRM_147/);
  assert.match(deploy, /allow_nodes=\(lk_subscription_booking_router_20260804 lk_subscription_managed_policy_20260820\)/);
  assert.match(deploy, /patch_live_lk1_topokraty_copay_hotfix\.mjs/);
  assert.match(deploy, /lk1EventPaymentQuoteBinding/);
  assert.match(deploy, /isTopokratyTrainingBenefit/);
  assert.match(deploy, /rollbackHint=NODE_RED_LK1_TOPOKRATY_COPAY_ROLLBACK=CONFIRM_147/);
  assert.match(deploy, /rollbackOrder=1-plan-rules-global 2-preimage-generation/);
  const rollback = fs.readFileSync(new URL("../rollback_nodered_lk1_topokraty_copay_147.sh", import.meta.url), "utf8");
  assert.match(rollback, /NODE_RED_LK1_TOPOKRATY_COPAY_ROLLBACK:-\}" != "CONFIRM_147/);
  assert.match(rollback, new RegExp(TOPOKRATY_COPAY_APPLIED_SHA256));
  assert.match(rollback, new RegExp(TOPOKRATY_COPAY_UPSTREAM_SHA256));
  const pkg = JSON.parse(fs.readFileSync(new URL("../../package.json", import.meta.url), "utf8"));
  assert.equal(pkg.scripts["nodered:lk1-topokraty-copay:deploy-147"],
    "bash scripts/deploy_nodered_lk1_topokraty_copay_147.sh");
  assert.equal(pkg.scripts["nodered:lk1-topokraty-copay:rollback-147"],
    "bash scripts/rollback_nodered_lk1_topokraty_copay_147.sh");
  assert.equal(pkg.scripts["test:lk1-topokraty-copay"],
    "node --experimental-strip-types --test scripts/tests/lk1TopokratyCopayHotfix.test.mjs");
  assert.equal(crypto.createHash("sha256").update(TOPOKRATY_COPAY_APPLIED_SHA256).digest("hex").length, 64);
});
