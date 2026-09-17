// Focused generation: the price preview and the booking gateway agree on the free first
// covered event of the day (day snapshot + client expectation).
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import {
  PREVIEW_FREE_FIRST_EVENT_BOOKING_DELTAS,
  PREVIEW_FREE_FIRST_EVENT_BOOKING_ID,
  PREVIEW_FREE_FIRST_EVENT_CANONICAL_PINS,
  PREVIEW_FREE_FIRST_EVENT_PREVIEW_ID,
  PREVIEW_FREE_FIRST_EVENT_SOURCE_NODE_COUNT,
  PREVIEW_FREE_FIRST_EVENT_SOURCE_SHA256,
  PREVIEW_FREE_FIRST_EVENT_TARGETS,
  PREVIEW_FREE_FIRST_EVENT_USAGE_BLOCK_SHA256,
  composePreviewFreeFirstEventArtifacts,
  patchPreviewFreeFirstEventBookingBody,
  sha256,
} from "../patch_live_lk1_preview_free_first_event_hotfix.mjs";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const LIVE_FLOW = process.env.LK1_LIVE_FLOW ?? "/private/tmp/lk1-pffe-live/input/source.flow.json";
const liveSkip = fs.existsSync(LIVE_FLOW) ? false : `live 147 flow is absent: ${LIVE_FLOW} (set LK1_LIVE_FLOW)`;

const liveBytes = () => fs.readFileSync(LIVE_FLOW);
const liveFlow = () => JSON.parse(liveBytes().toString("utf8"));
const nodeOf = (flow, id) => flow.find((node) => node.id === id);

/** The patched booking body with this generation applied. */
function patchedBooking() {
  return patchPreviewFreeFirstEventBookingBody(nodeOf(liveFlow(), PREVIEW_FREE_FIRST_EVENT_BOOKING_ID).func);
}

/** The composed preview body of this generation. */
function composedPreview() {
  return composePreviewFreeFirstEventArtifacts(liveBytes(), "lk1-preview-free-first-event");
}

/** `canonicalUsage` as it will run inside the composed preview node. */
function composedUsage(previewBody) {
  const canonical = new Function("global",
    `${previewBody.slice(0, previewBody.indexOf("\nconst pricing"))}\nreturn canonical;`)({ get: () => null });
  const usageStart = previewBody.indexOf("const canonicalUsage = msg => {");
  const routerHead = previewBody.indexOf("const ctx = msg._subscriptionPricePreview;", usageStart);
  assert.notEqual(usageStart, -1);
  assert.notEqual(routerHead, -1);
  return new Function("canonical",
    `${previewBody.slice(usageStart, routerHead)}\nreturn canonicalUsage;`)(canonical);
}

const RA = "b91e14d1-fe6e-4d0b-be39-3e45ad86b759";
const HUB = "db7a5250-7369-4f43-8ac5-9111be24bc74";
const rule = (productId) => ({ productId, maxActiveBookings: 4, freeGameMinutesPerDay: 60,
  gameOverageDiscountPercent: 30, groupTrainingDiscountPercent: 50, tournamentDiscountPercent: 50 });
const usageContext = (productId, visitsLeft) => ({
  tenantKey: "iSkq6G", actorClientId: "actor-1", clientSubscriptionId: "sub-1",
  serviceDate: "2026-09-28", managedAction: "BOOK_GROUP_TRAINING", category: "group_training",
  step: "lk1_usage_operations", lk1ProductIdentity: { subscription: { visitsLeft } },
  lk1: { rule: rule(productId), bookings: [], activeBookings: [],
    target: { category: "GROUP_TRAINING", eventId: "evt-1", stationId: "st-1", basePriceMinor: 550000,
      startsAt: "2026-09-28T06:00:00.000Z", durationMinutes: 60 } } });
const coveredOperation = (state = "CONFIRMED") => ({ tenantKey: "iSkq6G", actorClientId: "actor-1",
  clientSubscriptionId: "sub-1", operationId: "op-1", exerciseId: "evt-0", serviceDate: "2026-09-28",
  category: "group_training", state, bookingId: "booking-1", upstreamBookingId: "booking-1",
  lk1: { rule: rule(RA), decision: { eligible: true, benefit: { kind: "FREE_ENTITLEMENT", finalPriceMinor: 0,
    basePriceMinor: 550000, discountMinor: 550000, surchargeMinor: 0 }, subscriptionVisitCount: 1 },
    target: { category: "GROUP_TRAINING", eventId: "evt-0" } } });

test("the generation pins the installed flow and both node fields", () => {
  assert.equal(PREVIEW_FREE_FIRST_EVENT_SOURCE_NODE_COUNT, 4804);
  assert.equal(PREVIEW_FREE_FIRST_EVENT_SOURCE_SHA256,
    "1d3da756e70ff4e4ac04008380b05cacdf1af26e2649db34f29ab9d19d52e865");
  assert.equal(PREVIEW_FREE_FIRST_EVENT_BOOKING_ID, "lk_subscription_booking_router_20260804");
  assert.equal(PREVIEW_FREE_FIRST_EVENT_PREVIEW_ID, "lk_subscription_price_preview_20260908_router");
  assert.equal(PREVIEW_FREE_FIRST_EVENT_TARGETS.booking.liveFuncSha256,
    "1c4b177b7e652137252917c6de92f039a2f1717252d62f27994ed7f0a4811de1");
  assert.equal(PREVIEW_FREE_FIRST_EVENT_TARGETS.booking.patchedFuncSha256,
    "2c8bfbe7d1a5873dc85331bf42402c45c0a08de4227630a3450e8a3d770332cd");
  assert.equal(PREVIEW_FREE_FIRST_EVENT_TARGETS.preview.liveFuncSha256,
    "6bbae1f64480fa9b22c3ca434157af8ea9447b7b486f2699f445bfb776b97331");
  assert.equal(PREVIEW_FREE_FIRST_EVENT_TARGETS.preview.patchedFuncSha256,
    "1bd8d443e483512c4817f8c6c4850ebd50fb314482c072a5d18db7ae11d66de4");
  assert.equal(PREVIEW_FREE_FIRST_EVENT_BOOKING_DELTAS.length, 1);
  assert.equal(PREVIEW_FREE_FIRST_EVENT_USAGE_BLOCK_SHA256,
    "3436bdd2fa8d47f1d8952ada7e5a996137cc078169053009a6cc1447d7eb26f9");
  assert.equal(PREVIEW_FREE_FIRST_EVENT_CANONICAL_PINS.pricing,
    "d93de261c85ba62e3ba782acad1a364bc63e97433bcbebba81b20f5c3eb7206b");
});

test("the reviewed sources carry the reviewed change", () => {
  const hub = fs.readFileSync(path.join(repoRoot, "scripts/nodered_lk1_hub_nodes/gateway.js"), "utf8");
  const router = fs.readFileSync(path.join(repoRoot, "scripts/nodered_subscription_price_preview_nodes/router.js"), "utf8");
  const composition = fs.readFileSync(path.join(repoRoot, "scripts/patch_nodered_subscription_price_preview.mjs"), "utf8");
  assert.ok(hub.includes("if (isObj(quote) && quote.discountPercent === 100 && quote.amountMinor === 0) {"));
  assert.ok(hub.includes("ctx[key] = { ...quote, discountPercent: ctx.lk1.rule[discountField] };"));
  // The reviewed comparison the release packet pins stays byte-identical.
  assert.ok(hub.includes("|| expected.amountMinor !== decision.benefit.finalPriceMinor"));
  assert.ok(hub.includes("|| expected.discountPercent !== ctx.lk1.rule[route.discountField]"));
  assert.ok(router.includes("lk1ProductIdentity: { tenantKey: ctx.tenantKey, actorClientId: ctx.actorClientId, subscriptionId: id,"));
  assert.ok(router.includes("category: eventRoute ? eventRoute.category : 'open_game',"));
  assert.ok(router.includes("const freeCovered = decision.subscriptionVisitCount === 1"));
  assert.ok(router.includes("ctx.groupDiscountPercent = 100;"));
  // The cohort roots stay optional so an older booking body still composes.
  assert.ok(composition.includes("...freeFirstRoots(booking),"));
  assert.ok(composition.includes("const FREE_FIRST_ROOT_DECLARATIONS = Object.freeze(["));
  assert.ok(composition.includes("['LK1_FREE_FIRST_EVENT_PRODUCTS', /(?:^|\\n)\\s*const LK1_FREE_FIRST_EVENT_PRODUCTS\\s*=/]"));
  assert.ok(composition.includes("${(freeFirstRoots(booking) || []).map(name => `, ${name}`).join('')}"));
});

test("the booking delta applies and reverts on the installed body only", { skip: liveSkip }, () => {
  const live = nodeOf(liveFlow(), PREVIEW_FREE_FIRST_EVENT_BOOKING_ID).func;
  assert.equal(sha256(live), PREVIEW_FREE_FIRST_EVENT_TARGETS.booking.liveFuncSha256);
  const patched = patchPreviewFreeFirstEventBookingBody(live);
  assert.equal(sha256(patched), PREVIEW_FREE_FIRST_EVENT_TARGETS.booking.patchedFuncSha256);
  let reverted = patched;
  for (const delta of PREVIEW_FREE_FIRST_EVENT_BOOKING_DELTAS) {
    assert.equal(reverted.split(delta.before).length - 1, 0, delta.id);
    reverted = reverted.replace(delta.after, () => delta.before);
  }
  assert.equal(reverted, live);
  assert.throws(() => patchPreviewFreeFirstEventBookingBody("const x = 1;\n"), /preimage drift/);
});

test("the generation composes exactly the two reviewed postimages", { skip: liveSkip }, () => {
  const built = composedPreview();
  assert.equal(built.changes.length, 2);
  assert.equal(built.addedNodeCount, 0);
  assert.equal(built.candidateSha256, sha256(built.candidateBytes));
  assert.deepEqual(built.changes.map((change) => change.id).sort(),
    [PREVIEW_FREE_FIRST_EVENT_BOOKING_ID, PREVIEW_FREE_FIRST_EVENT_PREVIEW_ID].sort());
  assert.equal(built.booking.otherFieldsUnchanged, true);
  assert.equal(built.booking.freeFirstExpectationNormalized, true);
  assert.equal(built.booking.reviewedExpectationUntouched, true);
  assert.equal(built.preview.otherFieldsUnchanged, true);
  assert.equal(built.preview.daySnapshotClaimed, true);
  assert.equal(built.preview.freeQuoteEmitted, true);
  const candidate = JSON.parse(built.candidateBytes.toString("utf8"));
  assert.equal(sha256(nodeOf(candidate, PREVIEW_FREE_FIRST_EVENT_BOOKING_ID).func),
    PREVIEW_FREE_FIRST_EVENT_TARGETS.booking.patchedFuncSha256);
  assert.equal(sha256(nodeOf(candidate, PREVIEW_FREE_FIRST_EVENT_PREVIEW_ID).func),
    PREVIEW_FREE_FIRST_EVENT_TARGETS.preview.patchedFuncSha256);
  // Every other node stays byte-identical.
  const live = liveFlow();
  for (const node of candidate) {
    if (node.id === PREVIEW_FREE_FIRST_EVENT_BOOKING_ID || node.id === PREVIEW_FREE_FIRST_EVENT_PREVIEW_ID) continue;
    assert.deepEqual(node, nodeOf(live, node.id));
  }
});

test("a foreign flow is refused", { skip: liveSkip }, () => {
  const flow = liveFlow();
  flow.push({ id: "lk1-foreign-node", type: "function", func: "return msg;" });
  assert.throws(() => composePreviewFreeFirstEventArtifacts(Buffer.from(`${JSON.stringify(flow, null, 2)}\n`),
    "lk1-preview-free-first-event"), /preimage drift/);
});

test("the composed preview claims the gateway's day snapshot", { skip: liveSkip }, () => {
  const candidate = JSON.parse(composedPreview().candidateBytes.toString("utf8"));
  const usage = composedUsage(nodeOf(candidate, PREVIEW_FREE_FIRST_EVENT_PREVIEW_ID).func);
  const snapshot = (productId, visitsLeft, operations) => {
    const msg = { payload: operations, _subscriptionBooking: usageContext(productId, visitsLeft) };
    usage(msg);
    assert.equal(msg.previewError, undefined, `preview stop: ${msg.previewError}`);
    return msg._managedSubscriptionPolicyInput.usage.freeFirstEvent;
  };
  // The live defect: the preview never claimed the covered day, so the first event of the day
  // kept the configured discount while the booking gateway grants it for free.
  assert.deepEqual(snapshot(RA, 27, []), { covered: true, usedEventsToday: 0, visitsLeft: 27 });
  assert.deepEqual(snapshot(RA, 27, [coveredOperation()]), { covered: true, usedEventsToday: 1, visitsLeft: 27 });
  assert.deepEqual(snapshot(RA, 27, [coveredOperation("RELEASED")]), { covered: true, usedEventsToday: 0, visitsLeft: 27 });
  assert.deepEqual(snapshot(RA, 0, []), { covered: true, usedEventsToday: 0, visitsLeft: 0 });
  assert.deepEqual(snapshot(HUB, 362, []), { covered: false });
});

test("the gateway normalizes only the full-benefit quote of a free covered event", { skip: liveSkip }, () => {
  const patched = patchedBooking();
  const start = patched.indexOf("  // A visit-covered first event of the day is carried by the plan itself, and the widget quotes it");
  const end = patched.indexOf("  if (!isObj(decision) || decision.eligible !== true", start);
  assert.notEqual(start, -1);
  assert.notEqual(end, -1);
  const normalize = new Function("isObj", "ctx", "decision",
    `${patched.slice(start, end)}`);
  const isObj = (value) => Boolean(value) && typeof value === "object" && !Array.isArray(value);
  const rule = { groupTrainingDiscountPercent: 50, tournamentDiscountPercent: 50 };
  const free = { subscriptionVisitCount: 1, benefit: { kind: "FREE_ENTITLEMENT", finalPriceMinor: 0 } };
  const charged = { subscriptionVisitCount: 0, benefit: { kind: "PERCENT_DISCOUNT", finalPriceMinor: 275000 } };
  // The pinned reviewed comparison, unchanged in the body.
  const accepted = (ctx, decision) => {
    const expected = ctx.expectedGroupDiscount;
    const target = { basePriceMinor: 550000 };
    return expected.amountMinor === decision.benefit.finalPriceMinor
      && expected.discountPercent === rule.groupTrainingDiscountPercent
      && expected.basePriceMinor === target.basePriceMinor;
  };
  const freeQuote = { basePriceMinor: 550000, amountMinor: 0, productId: "p", startsAt: "s", durationMinutes: 60, discountPercent: 100 };
  const staleQuote = { ...freeQuote, amountMinor: 275000, discountPercent: 50 };

  const fullBenefit = { expectedGroupDiscount: { ...freeQuote }, lk1: { rule } };
  normalize(isObj, fullBenefit, free);
  assert.deepEqual(fullBenefit.expectedGroupDiscount, { ...freeQuote, discountPercent: 50 });
  assert.equal(accepted(fullBenefit, free), true);

  // A quote the preview no longer produces is left to the reviewed comparison, which refuses it.
  const stale = { expectedGroupDiscount: { ...staleQuote }, lk1: { rule } };
  normalize(isObj, stale, free);
  assert.deepEqual(stale.expectedGroupDiscount, staleQuote);
  assert.equal(accepted(stale, free), false);

  // A charged decision is never touched.
  const chargedCtx = { expectedGroupDiscount: { ...staleQuote }, lk1: { rule } };
  normalize(isObj, chargedCtx, charged);
  assert.deepEqual(chargedCtx.expectedGroupDiscount, staleQuote);
  assert.equal(accepted(chargedCtx, charged), true);
});

test("the deploy wrapper keeps the confirmation gate, the exact allowance and rollback", () => {
  const wrapper = fs.readFileSync(path.join(repoRoot,
    "scripts/deploy_nodered_lk1_preview_free_first_event_hotfix_147.sh"), "utf8");
  assert.ok(wrapper.includes("NODE_RED_LK1_PREVIEW_FREE_FIRST_EVENT_DEPLOY"));
  assert.ok(wrapper.includes('deployment_id="lk1-preview-free-first-event"'));
  assert.ok(wrapper.includes("lk_subscription_booking_router_20260804:func"));
  assert.ok(wrapper.includes("lk_subscription_price_preview_20260908_router:func"));
  assert.ok(wrapper.includes("scripts/patch_live_lk1_preview_free_first_event_hotfix.mjs"));
  assert.ok(wrapper.includes("rollback"));
  assert.ok(wrapper.includes("expected_changed_nodes=2"));
  assert.ok(wrapper.includes("value.booking?.freeFirstExpectationNormalized !== true"));
  assert.ok(wrapper.includes("value.preview?.daySnapshotClaimed !== true"));
  assert.ok(wrapper.includes("value.preview?.freeQuoteEmitted !== true"));
});
