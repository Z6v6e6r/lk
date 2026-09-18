#!/usr/bin/env node

// Focused Node-RED generation: the free-first-event rule of the rollout contract, plus the
// sale-date fix the discounted checkout needs.
//
// Owner decision 2026-09-16: for РА and Академия the first event of the subscription's local
// service day in the covered categories is carried by the plan itself — one visit is consumed
// and nothing is charged; every later event that day, and any event once the visits are used
// up, keeps the configured discount and consumes no visit. Covered categories: РА — group
// training (which includes «Игра+Тренер») and tournaments; Академия — group training only.
//
// The live incident that motivated it: a РА subscription bought 2026-09-16 was booked on a
// 2026-09-29 group training, the operation was created and the booking written in Viva, but
// no checkout appeared (`checkout: null`, 2750 ₽ unpaid) because the payment step re-resolved
// the stored rule without its sale date — a plan rule cannot select its cohort from a date
// that is not there, so the resolver answered with a code instead of the rule and the intent
// validation refused with `LK1_PRODUCT_RULE_CHANGED` after the write. The first event of the
// day must not be charged at all, so the rule itself is corrected here as well.
//
// Three nodes, one field each (`func`):
//   1. `lk_subscription_booking_router_20260804` — the free-first-event cohort table, the
//      day-bucket accounting over the same reserved operations and provider bookings the
//      allowance already trusts, the proved visit balance, and the sale date in the stored
//      rule re-resolution of the checkout;
//   2. `lk_subscription_managed_policy_20260820` — the evaluator turns a proved first event
//      into FREE_ENTITLEMENT with one visit and everything else into the unchanged discount;
//   3. `lk_subscription_price_preview_20260908_evaluate` — the same evaluator body, so the
//      checkout and the preview cannot drift apart.
//
// Preparation only: nothing is deployed, imported or restarted here, and the patcher fails
// closed unless the preimage is exactly the reviewed installed flow.

import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { buildExactGraphContract, validateReviewedFlowContract } from "./nodered_reviewed_flow_deploy/runtime_contract.mjs";
import { verifyWorkspace } from "./verify_nodered_source_origin.mjs";

export const FREE_FIRST_EVENT_DEPLOYMENT_ID = "lk1-free-first-event";
export const FREE_FIRST_EVENT_KIND = "FOCUSED_LK1_FREE_FIRST_EVENT_V1";

// Reviewed live flow: the installed flow after `lk1-plan-money-first-use` (4804 nodes,
// sha256 a20697fb…), reconstructed from the 2026-09-16 pull whose whole-flow sha is
// dbf43797… through the two reviewed generations in between. A live change must never be
// absorbed silently: it requires a conscious re-review of every pin below.
export const FREE_FIRST_EVENT_SOURCE_SHA256 =
  "a20697fbd9a268d431a7954ca19c173af45d4408502c22e36fcb4496ea9f6985";
export const FREE_FIRST_EVENT_SOURCE_NODE_COUNT = 4804;
export const FREE_FIRST_EVENT_BOOKING_ID = "lk_subscription_booking_router_20260804";
export const FREE_FIRST_EVENT_EVALUATOR_IDS = Object.freeze([
  "lk_subscription_managed_policy_20260820",
  "lk_subscription_price_preview_20260908_evaluate",
]);
export const FREE_FIRST_EVENT_TARGET = Object.freeze({
  bookingId: FREE_FIRST_EVENT_BOOKING_ID,
  liveBookingFuncSha256: "17ec2cac9ad30bb01aab67363349c498f6439fa9d7f4766a5acfdcd5964a429f",
  patchedBookingFuncSha256: "7bdcde3b5990282f577ac2656275c4fb727e3fa534d79a859f1f1ef7fdbdfa60",
  liveEvaluatorFuncSha256: "d410acdba09996926869373c4836cc9ff3676f1cbb5bf074449a47ed3bc3b1ed",
  patchedEvaluatorFuncSha256: "c20f0e6d792c02bdd0f945b84aaba2ac6405386add6228823cbb30fd2ca38945",
});

export const FREE_FIRST_EVENT_BOOKING_DELTAS = Object.freeze([
  { id: "checkout-rule-cohort-date",
    before: `  const configured = lk1Config([{ productId: ctx.lk1.rule.productId }]);
  if (JSON.stringify(configured.rule) !== JSON.stringify(ctx.lk1.rule)) return lk1Stop(ctx, "LK1_PRODUCT_RULE_CHANGED");`,
    after: `  // The rule is re-resolved to prove it did not change, so the sale date of the stored quote
  // has to travel with it: a plan rule selects its cohort from that date, and without it the
  // resolver answers with a code instead of the rule and every plan-product checkout is
  // refused after the booking was already written. The station travels with it for the same
  // reason: it is part of the contour decision the stored quote was priced with.
  const configured = lk1Config([{ productId: ctx.lk1.rule.productId, purchaseDate: ctx.lk1.purchaseDate }],
    ctx.lk1.target?.stationId || ctx.studioId || null);
  if (!isObj(configured.rule) || JSON.stringify(configured.rule) !== JSON.stringify(ctx.lk1.rule)) {
    return lk1Stop(ctx, "LK1_PRODUCT_RULE_CHANGED");
  }` },
  { id: "free-first-event-cohort",
    before: `const LK1_PRODUCT_POLICY_GLOBAL = "subscriptions_lk1_product_policy";`,
    after: `const LK1_PRODUCT_POLICY_GLOBAL = "subscriptions_lk1_product_policy";
// The free-first-event cohort of the rollout contract: for these plan products the first
// event of the subscription's local service day in the listed categories is carried by the
// subscription itself (one visit is consumed and nothing is charged); every later event that
// day, and any event once the visits are used up, keeps the configured discount and consumes
// no visit. The day bucket is proved here and travels to the evaluator in the policy input.
const LK1_FREE_FIRST_EVENT_PRODUCTS = Object.freeze({
  "b91e14d1-fe6e-4d0b-be39-3e45ad86b759": Object.freeze(["group_training", "tournament"]),
  "9eb8a7a4-c195-492a-95e4-3fb82899ac10": Object.freeze(["group_training"]),
});` },
  { id: "free-first-event-operation-category",
    before: `if (ctx.step === "lk1_usage_operations") {`,
    after: `// The category of a stored operation, for the day bucket of the free-first-event rule.
const lk1OperationCategory = (operation) => {
  const direct = normalizeId(operation?.category);
  if (direct) return direct;
  const managed = normalizeId(operation?.lk1?.target?.category);
  return managed === "group_training" || managed === "tournament" ? managed
    : managed === "game" ? "open_game" : null;
};

if (ctx.step === "lk1_usage_operations") {` },
  { id: "free-first-event-counters",
    before: `  let used = 0;
  const coveredBookings = new Set();
  const benefitBookings = new Set();`,
    after: `  let used = 0;
  const coveredBookings = new Set();
  const benefitBookings = new Set();
  // Free-first-event accounting: the covered cohort counts this subscription's events on the
  // target day from the same two sources the allowance already trusts (reserved operations
  // and provider bookings), deduplicated by booking identity. The cohort table lives at the
  // top of this node body; a harness that runs this step on its own simply has no cohort.
  const freeFirstProducts = typeof LK1_FREE_FIRST_EVENT_PRODUCTS === "object" && LK1_FREE_FIRST_EVENT_PRODUCTS
    ? LK1_FREE_FIRST_EVENT_PRODUCTS : null;
  const freeFirstCategories = freeFirstProducts
    ? freeFirstProducts[normalizeId(ctx.lk1.rule.productId)] || null : null;
  const freeFirstCovered = Boolean(freeFirstCategories && freeFirstCategories.includes(ctx.category));
  let freeFirstEventsToday = 0;` },
  { id: "free-first-event-reserved-operation",
    before: `    if (operation.serviceDate !== ctx.serviceDate) continue;
    const minutes = operation.lk1.decision.gameMinutes;`,
    after: `    if (operation.serviceDate !== ctx.serviceDate) continue;
    if (freeFirstCovered && freeFirstCategories.includes(lk1OperationCategory(operation))) {
      freeFirstEventsToday += 1;
    }
    const minutes = operation.lk1.decision.gameMinutes;` },
  { id: "free-first-event-provider-booking",
    before: `    const category = resolveCategory(booking);
    if (!category) return lk1Stop(ctx, "LK1_BOOKING_CATEGORY_UNRESOLVED");
    if (category !== "open_game") continue;`,
    after: `    const category = resolveCategory(booking);
    if (!category) return lk1Stop(ctx, "LK1_BOOKING_CATEGORY_UNRESOLVED");
    if (freeFirstCovered && freeFirstCategories.includes(category)) freeFirstEventsToday += 1;
    if (category !== "open_game") continue;` },
  { id: "free-first-event-visit-balance",
    before: `  if (!Number.isSafeInteger(used)) return lk1Stop(ctx, "LK1_ALLOWANCE_RECORD_INVALID");
  const policy = {};`,
    after: `  if (!Number.isSafeInteger(used)) return lk1Stop(ctx, "LK1_ALLOWANCE_RECORD_INVALID");
  if (!Number.isSafeInteger(freeFirstEventsToday)) return lk1Stop(ctx, "LK1_ALLOWANCE_RECORD_INVALID");
  // The visit balance of the selected instance: without a proved balance the evaluator keeps
  // the discount instead of granting a free event (the rollout contract keeps the booking
  // available either way).
  const identityVisitsLeft = ctx.lk1ProductIdentity?.subscription?.visitsLeft;
  const ownershipVisitsLeft = ctx.lk1MoneyOwnership?.subscription?.visitsLeft;
  const freeFirstVisitsLeft = Number.isSafeInteger(identityVisitsLeft) ? identityVisitsLeft
    : Number.isSafeInteger(ownershipVisitsLeft) ? ownershipVisitsLeft : null;
  const policy = {};` },
  { id: "free-first-event-policy-input",
    before: `      usedOrReservedFreeMinutesToday: used
    }
  };`,
    after: `      usedOrReservedFreeMinutesToday: used,
      freeFirstEvent: freeFirstCovered
        ? { covered: true, usedEventsToday: freeFirstEventsToday, visitsLeft: freeFirstVisitsLeft }
        : { covered: false }
    }
  };` },
]);

export const FREE_FIRST_EVENT_EVALUATOR_DELTAS = Object.freeze([
  { id: "free-first-event-benefit",
    before: `  } else if (["GROUP_TRAINING", "TOURNAMENT"].includes(category)) {
    decision.subscriptionVisitCount = 0;
    selectedRule = { ruleId: \`lk1-\${category.toLowerCase()}\`, kind: "PERCENT_DISCOUNT",
      percentage: category === "GROUP_TRAINING"
        ? rule.groupTrainingDiscountPercent : rule.tournamentDiscountPercent };
  }`,
    after: `  } else if (["GROUP_TRAINING", "TOURNAMENT"].includes(category)) {
    // The first covered event of the subscription's local service day is carried by the plan
    // itself: one visit is consumed and nothing is charged. Every later event that day, and
    // any event once the visits are used up, keeps the configured discount and consumes no
    // visit. The gateway proves the day bucket; a covered product whose snapshot is missing
    // fails closed instead of granting a free event on a guess.
    const freeFirst = usage?.freeFirstEvent;
    let freeFirstCovered = false;
    if (isObj(freeFirst) && freeFirst.covered === true) {
      if (!Number.isSafeInteger(freeFirst.usedEventsToday) || freeFirst.usedEventsToday < 0
        || !Number.isSafeInteger(freeFirst.visitsLeft) || freeFirst.visitsLeft < 0) {
        block("FREE_FIRST_EVENT_SNAPSHOT_INVALID", "Первое бесплатное событие дня не подтверждено");
      } else {
        freeFirstCovered = freeFirst.usedEventsToday === 0 && freeFirst.visitsLeft >= 1;
      }
    }
    decision.subscriptionVisitCount = freeFirstCovered ? 1 : 0;
    selectedRule = freeFirstCovered
      ? { ruleId: \`lk1-\${category.toLowerCase()}\`, kind: "FREE_ENTITLEMENT" }
      : { ruleId: \`lk1-\${category.toLowerCase()}\`, kind: "PERCENT_DISCOUNT",
        percentage: category === "GROUP_TRAINING"
          ? rule.groupTrainingDiscountPercent : rule.tournamentDiscountPercent };
  }` },
]);

const BOOKING_MARKERS = Object.freeze([
  "const configured = lk1Config([{ productId: ctx.lk1.rule.productId, purchaseDate: ctx.lk1.purchaseDate }],",
  "const LK1_FREE_FIRST_EVENT_PRODUCTS = Object.freeze({",
  '"b91e14d1-fe6e-4d0b-be39-3e45ad86b759": Object.freeze(["group_training", "tournament"]),',
  '"9eb8a7a4-c195-492a-95e4-3fb82899ac10": Object.freeze(["group_training"]),',
  "const lk1OperationCategory = (operation) => {",
  "let freeFirstEventsToday = 0;",
  "const freeFirstProducts = typeof LK1_FREE_FIRST_EVENT_PRODUCTS === \"object\" && LK1_FREE_FIRST_EVENT_PRODUCTS",
  "if (freeFirstCovered && freeFirstCategories.includes(lk1OperationCategory(operation))) {",
  "if (freeFirstCovered && freeFirstCategories.includes(category)) freeFirstEventsToday += 1;",
  "const freeFirstVisitsLeft = Number.isSafeInteger(identityVisitsLeft) ? identityVisitsLeft",
  "freeFirstEvent: freeFirstCovered",
  "? { covered: true, usedEventsToday: freeFirstEventsToday, visitsLeft: freeFirstVisitsLeft }",
]);
const BOOKING_ABSENT_MARKERS = Object.freeze([
  "const configured = lk1Config([{ productId: ctx.lk1.rule.productId }]);",
]);
const EVALUATOR_MARKERS = Object.freeze([
  "const freeFirst = usage?.freeFirstEvent;",
  "freeFirstCovered = freeFirst.usedEventsToday === 0 && freeFirst.visitsLeft >= 1;",
  '? { ruleId: `lk1-${category.toLowerCase()}`, kind: "FREE_ENTITLEMENT" }',
  'block("FREE_FIRST_EVENT_SNAPSHOT_INVALID", "Первое бесплатное событие дня не подтверждено");',
]);
const EVALUATOR_ABSENT_MARKERS = Object.freeze([
  `  } else if (["GROUP_TRAINING", "TOURNAMENT"].includes(category)) {
    decision.subscriptionVisitCount = 0;`,
]);

export const sha256 = (value) => crypto.createHash("sha256").update(value).digest("hex");

function assertFunctionNode(node, id) {
  if (!node) throw new Error(`Node contract mismatch: ${id} is absent`);
  if (node.type !== "function" || node.d === true || node.disabled === true
    || !Number.isInteger(node.outputs) || node.outputs < 1
    || node.wires?.length !== node.outputs || typeof node.func !== "string"
    || typeof node.initialize !== "string") {
    throw new Error(`Node contract mismatch: ${id}`);
  }
  return node;
}

function assertFunctionBody(body, label) {
  try {
    new Function("msg", "node", "env", "global", body);
  } catch (error) {
    throw new Error(`${label} is not a parseable Node-RED function body: ${error.message}`);
  }
}

function applyDeltas(source, deltas, label) {
  let patched = source;
  for (const delta of deltas) {
    const occurrences = patched.split(delta.before).length - 1;
    if (occurrences !== 1) throw new Error(`${label} anchor drift for ${delta.id}: ${occurrences}`);
    patched = patched.replace(delta.before, () => delta.after);
  }
  return patched;
}

export function patchFreeFirstEventBookingBody(source, target = FREE_FIRST_EVENT_TARGET) {
  if (sha256(source) !== target.liveBookingFuncSha256) {
    throw new Error(`Booking gateway installed preimage drift: ${sha256(source)} != ${target.liveBookingFuncSha256}`);
  }
  const patched = applyDeltas(source, FREE_FIRST_EVENT_BOOKING_DELTAS, "Booking gateway");
  for (const marker of BOOKING_MARKERS) {
    if ((patched.split(marker).length - 1) !== 1) {
      throw new Error(`Patched booking gateway is missing the reviewed marker: ${marker}`);
    }
  }
  for (const marker of BOOKING_ABSENT_MARKERS) {
    if (patched.includes(marker)) throw new Error(`Patched booking gateway still carries: ${marker}`);
  }
  assertFunctionBody(patched, "Patched booking gateway body");
  if (sha256(patched) !== target.patchedBookingFuncSha256) {
    throw new Error(`Booking gateway postimage drift: ${sha256(patched)} != ${target.patchedBookingFuncSha256}`);
  }
  return patched;
}

export function patchFreeFirstEventEvaluatorBody(source, target = FREE_FIRST_EVENT_TARGET) {
  if (sha256(source) !== target.liveEvaluatorFuncSha256) {
    throw new Error(`Evaluator installed preimage drift: ${sha256(source)} != ${target.liveEvaluatorFuncSha256}`);
  }
  const patched = applyDeltas(source, FREE_FIRST_EVENT_EVALUATOR_DELTAS, "Evaluator");
  for (const marker of EVALUATOR_MARKERS) {
    if ((patched.split(marker).length - 1) !== 1) {
      throw new Error(`Patched evaluator is missing the reviewed marker: ${marker}`);
    }
  }
  for (const marker of EVALUATOR_ABSENT_MARKERS) {
    if (patched.includes(marker)) throw new Error(`Patched evaluator still carries: ${marker}`);
  }
  assertFunctionBody(patched, "Patched evaluator body");
  if (sha256(patched) !== target.patchedEvaluatorFuncSha256) {
    throw new Error(`Evaluator postimage drift: ${sha256(patched)} != ${target.patchedEvaluatorFuncSha256}`);
  }
  return patched;
}

export function composeFreeFirstEventArtifacts(liveBytes, deploymentId, options = {}) {
  const bytes = Buffer.isBuffer(liveBytes) ? liveBytes : Buffer.from(`${JSON.stringify(liveBytes, null, 2)}\n`);
  const expected = options.expectedSourceSha256 ?? FREE_FIRST_EVENT_SOURCE_SHA256;
  const sourceSha256 = sha256(bytes);
  if (sourceSha256 !== expected) throw new Error(`Live flow preimage drift: ${sourceSha256} != ${expected}`);
  const flow = JSON.parse(bytes.toString("utf8"));
  if (!Array.isArray(flow) || flow.some((node) => !node || typeof node.id !== "string" || !node.id)
    || new Set(flow.map((node) => node.id)).size !== flow.length) throw new Error("Invalid flow identity");
  if (flow.length !== FREE_FIRST_EVENT_SOURCE_NODE_COUNT) {
    throw new Error(`Live flow node count drift: ${flow.length} != ${FREE_FIRST_EVENT_SOURCE_NODE_COUNT}`);
  }
  const shapes = new Map();
  const change = (id, patch) => {
    const node = assertFunctionNode(flow.find((row) => row.id === id), id);
    shapes.set(id, JSON.parse(JSON.stringify({ ...node, func: null })));
    const beforeFunc = sha256(node.func);
    node.func = patch(node.func);
    if (JSON.stringify({ ...node, func: null }) !== JSON.stringify(shapes.get(id))) {
      throw new Error(`${id} changed a field other than func`);
    }
    return { id, fields: ["func"], func: { beforeSha256: beforeFunc, afterSha256: sha256(node.func) } };
  };
  const evaluatorBodies = new Set(FREE_FIRST_EVENT_EVALUATOR_IDS
    .map((id) => sha256(flow.find((node) => node.id === id)?.func || "")));
  if (evaluatorBodies.size !== 1) throw new Error("Evaluator nodes must share one body before patching");
  const changes = [change(FREE_FIRST_EVENT_BOOKING_ID, patchFreeFirstEventBookingBody),
    ...FREE_FIRST_EVENT_EVALUATOR_IDS.map((id) => change(id, patchFreeFirstEventEvaluatorBody))];
  const evaluatorChanges = changes.filter((row) => row.id !== FREE_FIRST_EVENT_BOOKING_ID);
  if (evaluatorChanges.some((row) => row.func.afterSha256 !== evaluatorChanges[0].func.afterSha256)) {
    throw new Error("Evaluator nodes must stay byte-identical after patching");
  }
  const candidateBytes = Buffer.from(`${JSON.stringify(flow, null, 2)}\n`);
  const allowedChanges = changes.map((row) => ({ id: row.id, fields: ["func"] }));
  const contract = buildExactGraphContract({ liveBytes: bytes, candidateBytes, deploymentId,
    allowedChanges, allowedAdditionIds: [] });
  validateReviewedFlowContract({ liveBytes: bytes, candidateBytes, contract });
  const booking = flow.find((node) => node.id === FREE_FIRST_EVENT_BOOKING_ID);
  const evaluator = flow.find((node) => node.id === FREE_FIRST_EVENT_EVALUATOR_IDS[0]);
  return { flow, candidateBytes, contract, changes, addedNodeCount: 0, sourceSha256,
    candidateSha256: sha256(candidateBytes),
    booking: { id: FREE_FIRST_EVENT_BOOKING_ID, otherFieldsUnchanged: true,
      freeFirstCohortBound: booking.func.includes("const LK1_FREE_FIRST_EVENT_PRODUCTS = Object.freeze({")
        && booking.func.includes("freeFirstEvent: freeFirstCovered"),
      dayBucketProved: booking.func.includes("let freeFirstEventsToday = 0;")
        && booking.func.includes("const freeFirstVisitsLeft = Number.isSafeInteger(identityVisitsLeft) ? identityVisitsLeft"),
      checkoutCohortBound: booking.func.includes("lk1Config([{ productId: ctx.lk1.rule.productId, purchaseDate: ctx.lk1.purchaseDate }])")
        && !booking.func.includes("lk1Config([{ productId: ctx.lk1.rule.productId }]);") },
    evaluator: { ids: [...FREE_FIRST_EVENT_EVALUATOR_IDS], otherFieldsUnchanged: true,
      freeFirstBenefitBound: evaluator.func.includes('kind: "FREE_ENTITLEMENT"')
        && evaluator.func.includes("freeFirstCovered = freeFirst.usedEventsToday === 0 && freeFirst.visitsLeft >= 1;"),
      discountUnchanged: evaluator.func.includes("percentage: category === \"GROUP_TRAINING\"") } };
}

function fail(message) { console.error(message); process.exitCode = 1; }

function prepareTargets(workspace, requested) {
  const canonical = (value) => {
    if (!path.isAbsolute(value)) throw new Error("Output paths must be absolute");
    if (path.resolve(value) !== value) throw new Error("Output paths must be canonical");
    if (fs.existsSync(value)) throw new Error(`Refusing to overwrite output: ${value}`);
    if (value === workspace || value.startsWith(`${workspace}${path.sep}`)) {
      throw new Error("Outputs must stay outside the live workspace");
    }
    return value;
  };
  return requested.map(canonical);
}

function main(args) {
  const values = {};
  for (let index = 0; index < args.length; index += 2) {
    const key = args[index]; const value = args[index + 1];
    if (!["--workspace", "--output", "--report"].includes(key) || !value || value.startsWith("--")) {
      fail("Usage: --workspace <fresh-live-workspace> --output <candidate.json> --report <report.json>"); return;
    }
    if (values[key] !== undefined) { fail(`Duplicate argument: ${key}`); return; }
    values[key] = value;
  }
  if (Object.keys(values).length !== 3) {
    fail("Usage: --workspace <fresh-live-workspace> --output <candidate.json> --report <report.json>"); return;
  }
  const verified = verifyWorkspace(values["--workspace"], { quiet: true });
  const liveBytes = fs.readFileSync(verified.sourcePath);
  const built = composeFreeFirstEventArtifacts(liveBytes, FREE_FIRST_EVENT_DEPLOYMENT_ID, {
    expectedSourceSha256: FREE_FIRST_EVENT_SOURCE_SHA256 });
  if (sha256(liveBytes) !== verified.sourceSha256) { fail("Live source changed between verification and composition"); return; }
  const [outputPath, reportPath] = prepareTargets(verified.workspace, [values["--output"], values["--report"]]);
  const report = {
    kind: FREE_FIRST_EVENT_KIND, deploymentId: FREE_FIRST_EVENT_DEPLOYMENT_ID,
    targets: { booking: { id: FREE_FIRST_EVENT_BOOKING_ID,
      func: { beforeSha256: FREE_FIRST_EVENT_TARGET.liveBookingFuncSha256,
        afterSha256: FREE_FIRST_EVENT_TARGET.patchedBookingFuncSha256 } },
    evaluator: { ids: [...FREE_FIRST_EVENT_EVALUATOR_IDS],
      func: { beforeSha256: FREE_FIRST_EVENT_TARGET.liveEvaluatorFuncSha256,
        afterSha256: FREE_FIRST_EVENT_TARGET.patchedEvaluatorFuncSha256 } } },
    sourceSha256: verified.sourceSha256, candidateSha256: built.candidateSha256,
    sourceNodeCount: verified.nodeCount, candidateNodeCount: built.flow.length,
    changedNodeCount: built.changes.length, expectedChangedNodeCount: 3, addedNodeCount: built.addedNodeCount,
    changes: built.changes, booking: built.booking, evaluator: built.evaluator,
    topologyChanged: false, routesChanged: false, policyChanged: false,
    deploymentPerformed: false, liveMutationPerformed: false,
  };
  fs.writeFileSync(outputPath, built.candidateBytes.toString("utf8"), { encoding: "utf8", mode: 0o600, flag: "wx" });
  fs.writeFileSync(reportPath, `${JSON.stringify(report, null, 2)}\n`, { encoding: "utf8", mode: 0o600, flag: "wx" });
  console.log(JSON.stringify(report));
}

const invokedPath = process.argv[1] ? fs.realpathSync(process.argv[1]) : "";
if (invokedPath === fileURLToPath(import.meta.url)) {
  try { main(process.argv.slice(2)); } catch (error) { fail(error.message); }
}
