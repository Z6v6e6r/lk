#!/usr/bin/env node

// Focused Node-RED generation: the LK1 subscription plan rules
// (`subscriptions_lk1_plan_rules`) become the single product resolver for the
// booking gateway and the managed-policy evaluator.
//
// The installed 2026-09-15 flow on 147 is a chained composition whose hub bodies
// carry a production layer that the generation-agnostic HUB builder cannot
// reproduce (its preimages are a superseded generation). This patcher therefore
// applies reviewed string deltas to the exact live bodies and pins the live
// preimage and the resulting postimage of both nodes.
//
// Generation shape (changedNodeCount === 2 nodes, four changed fields):
//   1. `lk_subscription_booking_router_20260804` (gateway):
//      * `func`: the embedded plan-rules module + the resolver-based `lk1Config`,
//        the `lk1Quote` legacy short-circuit, the money gate and the two
//        `gateway_hooks` gates;
//      * `initialize`: the reviewed `subscriptions_lk1_plan_rules` activation block
//        (shape guard, single guarded write, readback) appended after the untouched
//        HUB policy writer.
//   2. `lk_subscription_managed_policy_20260820` (evaluator):
//      * `func`: the reviewed `nodered_lk1_hub_nodes/evaluator.js` body, which
//        validates the rule product instead of the hardcoded HUB id and replaces the
//        active-bookings blocker with the additive `aboveActiveLimit` verdict.
//
// The `initialize` delta is what makes rule 3 real: without the global the resolver
// falls back to legacy for every plan product.
//
// PENDING DELTA (deliberately NOT applied here): the price-preview node
// `lk_subscription_price_preview_20260908_router` is amended by the reviewed
// composition `scripts/patch_nodered_subscription_price_preview.mjs` (line C).
// `PLAN_RULES_PENDING_DELTAS` is the documented slot for it; when that composition
// lands this patcher must apply it too and the allow-list of
// `scripts/deploy_nodered_lk1_plan_rules_147.sh` must grow by exactly that node.
//
// This is preparation only. It never deploys, imports, restarts or activates
// anything, and it fails closed unless the supplied preimage is exactly the
// reviewed live flow (whole-flow sha256 plus both node bodies).

import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { planRulesSource } from "./lib/eventPaymentSources.mjs";
import { LK1_PLAN_RULES_DESIRED, buildPlanRulesTransition } from "./lib/lk1PlanRulesTransition.mjs";
import { verifyWorkspace } from "./verify_nodered_source_origin.mjs";

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.join(SCRIPT_DIR, "..");

export const PLAN_RULES_DEPLOYMENT_ID = "lk1-plan-rules";
export const PLAN_RULES_KIND = "FOCUSED_LK1_PLAN_RULES_GENERATION_V1";

// Reviewed live flow pulled from lk-primary-147 on 2026-09-15
// (`/root/.node-red/flows.json`, 4804 nodes, sha256 30bd2873…). A live change must
// never be absorbed silently: it requires a conscious re-review of every pin below.
export const PLAN_RULES_SOURCE_SHA256 =
  "30bd28732cc87ed77fd802f1530a8c172dd16694528644baafc623088521fcb5";
export const PLAN_RULES_SOURCE_NODE_COUNT = 4804;

export const PLAN_RULES_GATEWAY_NODE_ID = "lk_subscription_booking_router_20260804";
export const PLAN_RULES_EVALUATOR_NODE_ID = "lk_subscription_managed_policy_20260820";
export const PLAN_RULES_PREVIEW_NODE_ID = "lk_subscription_price_preview_20260908_router";

// The reviewed marker of an already patched gateway body: the resolver call the
// released `lk1Config` uses. It is absent from the live preimage, so a second run
// of this patcher is refused instead of produced.
const GATEWAY_PATCH_MARKER = "resolveLk1Rule({ owned, planRules: lk1ReadPlanRules() })";
const EVALUATOR_PATCH_MARKER = "decision.aboveActiveLimit = activeCount >= rule.maxActiveBookings;";
// The plan-rules writer the released gateway `initialize` must carry: without it the
// rollout global is never written and rule 3 (plan products sold from 2026-09-01)
// stays inert while rules 1/2/4/5 already hold.
const GATEWAY_INITIALIZE_MARKER = 'const lk1PlanRulesKey = "subscriptions_lk1_plan_rules";';
// The pre-existing HUB policy writer of the live gateway `initialize`. It must stay
// untouched: `hubLk1SaleContract` reads that global in six nodes and a shape change
// breaks `HUB_LK1_SALE_BINDING_DRIFT`.
const HUB_INITIALIZE_MARKERS = Object.freeze([
  'const lk1PolicyKey = "subscriptions_lk1_product_policy";',
  "global.set(lk1PolicyKey, lk1DesiredPolicy);",
  '"HUB policy prior mismatch; no overwrite"',
  '"HUB policy readback mismatch"',
]);

// The live evaluator node keeps the LK1 path as an embedded copy of the base
// `nodered_lk1_hub_nodes/evaluator.js` inside its own branch, followed by the
// untouched managed-policy path. The reviewed generation replaces exactly that
// embedded copy, so both the branch envelope and the embedded preimage are pinned.
const EVALUATOR_LK1_BRANCH_OPEN =
  'if (Object.prototype.hasOwnProperty.call(msg._managedSubscriptionPolicyInput || {}, "lk1Policy")) {\n'
  + "  return (() => {\n";
const EVALUATOR_LK1_BRANCH_CLOSE = "\n})();\n}";

export const PLAN_RULES_TARGETS = Object.freeze({
  gateway: {
    id: PLAN_RULES_GATEWAY_NODE_ID,
    // sha256 of the exact live gateway function body pulled from 147 on 2026-09-15.
    liveFuncSha256: "abf46e8b1a05ca4d013ed0c3d9e168a2ae00a1d8eb5e866c3290acc5f47672d9",
    patchedFuncSha256: "ed59d29ecb8af6d917e941b2a5d302c8124024a4ce12b450232206088247a88d",
    // sha256 of the live gateway `initialize` (setup) body: the HUB policy writer.
    liveInitializeSha256: "db38f71e2840bf7d959a582df02ddf62810fd3c5b694c9a784a482e787b45a8a",
    patchedInitializeSha256: "40ead051782bf8409fe9423ad783ec4cb7a1c6ba78fe4aff6231d5d3e5690395",
  },
  evaluator: {
    id: PLAN_RULES_EVALUATOR_NODE_ID,
    liveFuncSha256: "6f4e7aa5506d7da4123fc0f8c86c5a310f6fc2dc86c9cc23b56ef1deaa001a72",
    // The embedded LK1-path copy: byte-identical to the base-generation
    // `nodered_lk1_hub_nodes/evaluator.js` of commit e2e5e1e5.
    liveEmbeddedSha256: "cfd614a48e93ad5963974b4e750f273906b5f43a3d49aeb684562ce76b821347",
    patchedFuncSha256: "d410acdba09996926869373c4836cc9ff3676f1cbb5bf074449a47ed3bc3b1ed",
  },
});

// Reviewed sources this generation copies from. They are read from the working
// tree, not from the live flow, so the generation is always built from the
// reviewed sources of this checkout. Each reviewed fragment is pinned by sha so a
// change to a reviewed source can never enter a candidate unnoticed.
const REVIEWED_GATEWAY_SOURCE = "scripts/nodered_lk1_hub_nodes/gateway.js";
const REVIEWED_EVALUATOR_SOURCE = "scripts/nodered_lk1_hub_nodes/evaluator.js";
export const PLAN_RULES_MODULE_SHA256 =
  "abdbe70a81e285fe0f1fa84a69d8339c266a9715be26262a278e26c5e743b455";
export const PLAN_RULES_REVIEWED_EVALUATOR_SHA256 =
  "c248b8bb6b5bb8a2ec4b7ebe30adf6883f31151ae588deddf9197ab9a26430e1";
export const PLAN_RULES_CONFIG_FRAGMENT_SHA256 =
  "1c6f22d25037666d1265b0be6370de2d5214c8580652214df5f3d524692d17b1";

export const sha256 = (value) => crypto.createHash("sha256").update(value).digest("hex");

function reviewedFile(relativePath) {
  return fs.readFileSync(path.join(REPO_ROOT, relativePath), "utf8");
}

export function extractBetween(text, startMarker, endMarker) {
  if (typeof text !== "string" || text.split(startMarker).length !== 2) {
    throw new Error(`Reviewed source anchor drift: ${startMarker}`);
  }
  const start = text.indexOf(startMarker);
  const end = text.indexOf(endMarker, start + startMarker.length);
  if (end < 0) throw new Error(`Reviewed source end anchor drift: ${endMarker}`);
  return text.slice(start, end);
}

// The frozen resolver module, embedded exactly as the reviewed composition does it
// (`hubGatewaySource()` in scripts/lib/eventPaymentSources.mjs): module shape kept,
// `export` keyword dropped.
export function reviewedPlanRulesModule() {
  const source = planRulesSource();
  if (!source.includes("const LK1_PLAN_RULES_GLOBAL =") || source.includes("export ")) {
    throw new Error("Reviewed plan-rules module drift");
  }
  if (sha256(source) !== PLAN_RULES_MODULE_SHA256) {
    throw new Error(`Reviewed plan-rules module drift: ${sha256(source)} != ${PLAN_RULES_MODULE_SHA256}`);
  }
  return source;
}

// The released `lk1Config` fragment, extracted from the reviewed gateway source.
export function reviewedConfigFragment() {
  const fragment = extractBetween(reviewedFile(REVIEWED_GATEWAY_SOURCE),
    "const lk1Config = (owned) => {", "\nconst lk1Stop");
  if (sha256(fragment) !== PLAN_RULES_CONFIG_FRAGMENT_SHA256) {
    throw new Error(`Reviewed config fragment drift: ${sha256(fragment)} != ${PLAN_RULES_CONFIG_FRAGMENT_SHA256}`);
  }
  return fragment;
}

export function reviewedEvaluatorBody() {
  const source = reviewedFile(REVIEWED_EVALUATOR_SOURCE);
  if (sha256(source) !== PLAN_RULES_REVIEWED_EVALUATOR_SHA256) {
    throw new Error(`Reviewed evaluator drift: ${sha256(source)} != ${PLAN_RULES_REVIEWED_EVALUATOR_SHA256}`);
  }
  return source;
}

// Every delta pins its exact live preimage as a literal and asserts that the
// literal occurs exactly once before it is applied. The node-level preimage sha
// above proves the body those literals were derived from; the uniqueness assertion
// proves the anchor itself is unambiguous.
export const PLAN_RULES_GATEWAY_DELTAS = Object.freeze([
  {
    id: "plan-rules-module-and-resolver-config",
    before: `const lk1Config = (owned) => {
  const ids = [...new Set(owned.flatMap(collectExactProductIds))];
  if (!ids.includes(LK1_OVERLAY_HUB_PRODUCT_ID)) return { matched: false };
  const dates = collectSubscriptionPurchaseDateEvidence(owned);
  if (ids.length === 1 && !dates.invalid && dates.dates.length === 1
    && dates.dates[0] < MANAGED_ENFORCEMENT_PURCHASE_FROM) return { matched: false };
  let raw;
  try { raw = lk1ReadBoundPolicy(); } catch (_) { return { matched: true, code: "LK1_PRODUCT_RULE_SOURCE_MISMATCH" }; }
  if (raw === null) return { matched: true, code: "LK1_PRODUCT_RULE_OFF" };
  try { if (typeof raw === "string") raw = JSON.parse(raw); } catch (_) { raw = null; }
  if (!isObj(raw) || ids.length !== 1 || raw.productId !== LK1_OVERLAY_HUB_PRODUCT_ID
    || Object.keys(raw).sort().join() !== ["productId", ...lk1Fields].sort().join()
    || lk1Fields.some((key) => !Number.isSafeInteger(raw[key]) || raw[key] < 0)
    || raw.maxActiveBookings < 1 || lk1Fields.slice(2).some((key) => raw[key] > 100)) {
    return { matched: true, code: "LK1_PRODUCT_RULE_INVALID" };
  }
  const rule = { productId: raw.productId };
  for (const key of lk1Fields) rule[key] = raw[key];
  return { matched: true, rule };
};`,
    after: () => `${reviewedPlanRulesModule()}${reviewedConfigFragment()}`,
  },
  {
    id: "lk1-quote-legacy-short-circuit",
    before: `  if (!configured.matched || configured.code) return { code: configured.code || "LK1_PRODUCT_RULE_CHANGED" };
  const dates = collectSubscriptionPurchaseDateEvidence(owned);
  if (dates.invalid || dates.dates.length !== 1) return { code: "SUBSCRIPTION_PURCHASE_DATE_UNRESOLVED" };
  if (dates.dates[0] < MANAGED_ENFORCEMENT_PURCHASE_FROM) return { legacy: true };
`,
    after: `  if (!configured.matched || configured.code) return { code: configured.code || "LK1_PRODUCT_RULE_CHANGED" };
  if (configured.legacy) return { legacy: true };
  // The sale-date cohort is decided by the rule: the selected instance for a plan
  // product, never a date gate for HUB. The date still travels in the quote.
  const dates = collectSubscriptionPurchaseDateEvidence(owned);
  if (dates.invalid || dates.dates.length !== 1) return { code: "SUBSCRIPTION_PURCHASE_DATE_UNRESOLVED" };
`,
  },
  {
    id: "money-gate-enforced-cohort",
    before: `  const dates = collectSubscriptionPurchaseDateEvidence(selected);
  if (configured.matched && (dates.invalid || dates.dates.length !== 1)) {
    return lk1Stop(ctx, "SUBSCRIPTION_PURCHASE_DATE_UNRESOLVED");
  }
  delete ctx.lk1MoneyOwnership;
  if (configured.matched && dates.dates[0] >= MANAGED_ENFORCEMENT_PURCHASE_FROM) {
`,
    after: `  // The resolver decides the enforced cohort; the date gate below stays only for
  // the HUB money mandate that existed before the plan rules.
  const enforced = configured.matched && !configured.legacy;
  const dates = enforced ? collectSubscriptionPurchaseDateEvidence(selected) : { invalid: true, dates: [] };
  if (enforced && (dates.invalid || dates.dates.length !== 1)) {
    return lk1Stop(ctx, "SUBSCRIPTION_PURCHASE_DATE_UNRESOLVED");
  }
  delete ctx.lk1MoneyOwnership;
  if (enforced && dates.dates[0] >= MANAGED_ENFORCEMENT_PURCHASE_FROM) {
`,
  },
  {
    id: "hooks-selected-instance-and-rule-gate",
    before: `  const visitOwned = findOwnedSubscriptions(exercise, ctx.clientSubscriptionId);
  let ruleConfigured = false;
  try { ruleConfigured = Boolean(global.get(LK1_PRODUCT_POLICY_GLOBAL)); } catch (_) { /* absent */ }
  if (ctx.caller === "http" && ["group_training", "tournament"].includes(resolveCategory(exercise))
    && ruleConfigured && ctx.lk1MoneyReadbackPhase !== "exercise"
    && (visitOwned.length === 0 || lk1Config(visitOwned).matched)) {
`,
    after: `  // The selected instance is resolved first: it carries the product identity and the
  // sale date of the concrete subscription, not of a sibling the client also owns.
  const selectedOwned = findOwnedSubscriptions(exercise, ctx.clientSubscriptionId);
  const selectedRule = lk1Config(selectedOwned);
  const enforcedRule = selectedRule.matched && !selectedRule.legacy;
  let ruleConfigured = false;
  try { ruleConfigured = Boolean(lk1ReadPlanRules() || global.get(LK1_PRODUCT_POLICY_GLOBAL)); } catch (_) { /* absent */ }
  if (ctx.caller === "http" && ["group_training", "tournament"].includes(resolveCategory(exercise))
    && ruleConfigured && ctx.lk1MoneyReadbackPhase !== "exercise"
    && (selectedOwned.length === 0 || enforcedRule)) {
`,
  },
  {
    id: "hooks-legacy-cohort-out-of-contour",
    before: `  if ((ctx.lk1BeforeCreate === true || ctx.lk1CreateBinding) && !productRule.matched) {
    return lk1Stop(ctx, "LK1_PRODUCT_RULE_CHANGED");
  }
  if (productRule.matched) {
`,
    after: `  // A legacy cohort is not a rule change: it stays out of the managed contour.
  if ((ctx.lk1BeforeCreate === true || ctx.lk1CreateBinding) && !productRule.matched
    && !productRule.legacy) {
    return lk1Stop(ctx, "LK1_PRODUCT_RULE_CHANGED");
  }
  if (productRule.matched && !productRule.legacy) {
`,
  },
]);

// The price-preview amendment is owned by the reviewed composition of line C
// (`scripts/patch_nodered_subscription_price_preview.mjs`). It is intentionally
// empty here so the candidate cannot silently ship a half-applied preview.
//
// BLOCKED on two reviewed-generation preconditions that are outside this patcher's
// authority; both were measured on the live 147 snapshot (2026-09-15, 30bd2873…):
//   1. `PREVIEW_CANONICAL_SOURCE_SHA256.pricing`/`.join` in C's module are the
//      pre-`split-nominal-share` preimages (`53c4f6ab…`/`70ec2bdf…`), while the
//      installed bodies are its documented postimages (`d93de261…`/`8b312b97…`,
//      docs/NODERED_SPLIT_NOMINAL_SHARE_PACKET_20260912.md:45-46).
//   2. `patchPaidBenefitUsage` re-applies the paid-join transform, but the installed
//      `lk1_usage_operations … lk1_policy_decision` block already carries both the
//      paid-visit recompute and the AUDIT_BINDING guard, so its reviewed anchors are
//      absent (`Paid join source anchor drift`). This is NOT caused by the gateway
//      deltas above: the allowance block is byte-identical in the live and the
//      patched body (sha256 98229c72…), and every gateway delta sits outside it.
// Fixing it needs C's module to reuse the installed block under an exact installed-sha
// pin (an additive, backward-compatible option) plus the two re-pins above.
export const PLAN_RULES_PREVIEW_PREREQUISITES = Object.freeze({
  installedSplitFuncSha256: "d93de261c85ba62e3ba782acad1a364bc63e97433bcbebba81b20f5c3eb7206b",
  installedJoinFuncSha256: "8b312b97a75112d8e10d13642be649cd795f77a506c4925152338b6854c2b074",
  installedAllowanceBlockSha256: "98229c7224fe81c3856071523307514b8df914440c8bf03a159a2e9a5c72fd8b",
  reviewedSplitPinSha256: "53c4f6ab309b4287eaded6c6d16a9c0e34f47c8eac625c58bdf423acfb083d42",
  reviewedJoinPinSha256: "70ec2bdfad08c71a1a1ef2d851c07918906573a3802ce9f41765837494c6f462",
});

export const PLAN_RULES_PENDING_DELTAS = Object.freeze([
  Object.freeze({
    id: "price-preview-plan-rules-resolver",
    nodeId: PLAN_RULES_PREVIEW_NODE_ID,
    fields: Object.freeze(["func"]),
    status: "PENDING_COMPOSITION",
    owner: "scripts/patch_nodered_subscription_price_preview.mjs",
    reason: "The preview node must resolve the same plan rule as the booking gateway, "
      + "otherwise preview and booking disagree. The reviewed composition exists but is "
      + "generation-mismatched with the installed 147 flow: its pricing/join pins are the "
      + "pre-split-nominal-share preimages and its paid-join allowance step targets a "
      + "pre-AUDIT_BINDING block. Both must be re-pinned/reused before this delta and the "
      + "third allow-change entry are added.",
    requiresDecision: "Review the installed generation preconditions described by "
      + "PLAN_RULES_PREVIEW_PREREQUISITES and let the preview composition reuse the installed "
      + "allowance block under an exact installed-sha pin.",
  }),
]);

function deltaText(delta) {
  return typeof delta.after === "function" ? delta.after() : delta.after;
}

export function applyDeltas(body, deltas, label) {
  let patched = body;
  for (const delta of deltas) {
    const occurrences = patched.split(delta.before).length - 1;
    if (occurrences !== 1) {
      throw new Error(`${label} anchor drift for ${delta.id}: ${occurrences} occurrences`);
    }
    patched = patched.replace(delta.before, () => deltaText(delta));
  }
  return patched;
}

// An embedded module declares its symbols in the same function scope as the live
// gateway body, so a collision is a runtime SyntaxError rather than a silent
// shadow. Refuse it at composition time, before any byte is written.
export function assertNoRedeclaration(body, moduleSource = reviewedPlanRulesModule()) {
  const declared = [...moduleSource.matchAll(
    /^(?:const|let|var|function)\s+([A-Za-z_$][\w$]*)/gm)].map((match) => match[1]);
  for (const name of declared) {
    const pattern = new RegExp(`(?:const|let|var|function)\\s+${name.replace(/\$/g, "\\$")}\\b`);
    if (pattern.test(body)) {
      throw new Error(`Gateway body already declares the embedded plan-rules symbol: ${name}`);
    }
  }
}

export function buildGatewayBody(source) {
  assertNotPatched(source, GATEWAY_PATCH_MARKER, "LK1 plan-rules gateway");
  assertNoRedeclaration(source);
  return applyDeltas(source, PLAN_RULES_GATEWAY_DELTAS, "Gateway");
}

// The released gateway `initialize` (setup): the untouched live HUB policy writer
// plus the plan-rules activation block. The HUB writer is verified before and after
// so the annual-HUB sale contract (`hubLk1SaleContract`, 6 nodes) cannot drift.
// `expectedPrior: null` means "no plan-rules global yet"; a later rule change is a
// new generation that must name the exact prior it replaces.
export function buildGatewayInitialize(source) {
  assertNotPatched(source, GATEWAY_INITIALIZE_MARKER, "LK1 plan-rules gateway initialize");
  for (const marker of HUB_INITIALIZE_MARKERS) {
    if (!source.includes(marker)) {
      throw new Error(`Live gateway initialize is missing the HUB writer anchor: ${marker}`);
    }
  }
  const transition = buildPlanRulesTransition({
    expectedPrior: null,
    desired: LK1_PLAN_RULES_DESIRED,
  });
  const patched = `${source}${source.endsWith("\n") ? "" : "\n"}${transition.initialize}`;
  for (const marker of HUB_INITIALIZE_MARKERS) {
    if (!patched.includes(marker)) {
      throw new Error(`Patched gateway initialize dropped the HUB writer anchor: ${marker}`);
    }
  }
  for (const marker of [
    'const lk1PlanRulesKey = "subscriptions_lk1_plan_rules";',
    "global.set(lk1PlanRulesKey, lk1DesiredPlanRules);",
    "plan rules prior mismatch; no overwrite",
    "plan rules readback mismatch",
  ]) {
    if (!patched.includes(marker)) {
      throw new Error(`Patched gateway initialize is missing the plan-rules writer: ${marker}`);
    }
  }
  assertInitializeBody(patched, "Patched gateway initialize");
  return patched;
}

// The embedded preimage of the live evaluator LK1 branch. The node-level sha pin
// above already fixes the whole body, so this extraction is deterministic; the
// embedded sha is pinned again so a review of this delta sees the exact fragment.
export function extractEmbeddedEvaluatorBody(source, target = PLAN_RULES_TARGETS.evaluator) {
  if (source.split(EVALUATOR_LK1_BRANCH_OPEN).length !== 2) {
    throw new Error("Evaluator LK1 branch preimage drift");
  }
  const start = source.indexOf(EVALUATOR_LK1_BRANCH_OPEN) + EVALUATOR_LK1_BRANCH_OPEN.length;
  const end = source.indexOf(EVALUATOR_LK1_BRANCH_CLOSE, start);
  if (end < 0) throw new Error("Evaluator LK1 branch end drift");
  const embedded = source.slice(start, end);
  if (sha256(embedded) !== target.liveEmbeddedSha256) {
    throw new Error(`Evaluator embedded body drift: ${sha256(embedded)} != ${target.liveEmbeddedSha256}`);
  }
  return { embedded, start, end };
}

export function buildEvaluatorBody(source, reviewedBody = reviewedEvaluatorBody()) {
  assertNotPatched(source, EVALUATOR_PATCH_MARKER, "LK1 plan-rules evaluator");
  if (source.includes(reviewedBody)) {
    throw new Error("Reviewed evaluator body is already embedded in the live body");
  }
  const { start, end } = extractEmbeddedEvaluatorBody(source);
  return source.slice(0, start) + reviewedBody + source.slice(end);
}

function assertNotPatched(source, marker, label) {
  if (source.includes(marker)) throw new Error(`${label} body is already patched`);
}

function assertPreimage(source, target, label, field = "func") {
  const pin = field === "initialize" ? target.liveInitializeSha256 : target.liveFuncSha256;
  if (sha256(source) !== pin) {
    throw new Error(`${label} live preimage drift (${field}): ${sha256(source)} != ${pin}`);
  }
}

function assertPostimage(source, target, label, field = "func") {
  const pin = field === "initialize" ? target.patchedInitializeSha256 : target.patchedFuncSha256;
  if (pin.startsWith("__")) {
    throw new Error(`${label} ${field} postimage pin is not set`);
  }
  if (sha256(source) !== pin) {
    throw new Error(`${label} postimage drift (${field}): ${sha256(source)} != ${pin}`);
  }
}

function assertFunctionBody(body, label) {
  try {
    // A Node-RED function body must stay parseable with the host arguments.
    new Function("msg", "node", "env", "global", body);
  } catch (error) {
    throw new Error(`${label} is not a parseable Node-RED function body: ${error.message}`);
  }
}

function assertInitializeBody(body, label) {
  try {
    // A Node-RED setup (initialize) body must stay parseable with the host arguments.
    new Function("global", "env", "node", "flow", body);
  } catch (error) {
    throw new Error(`${label} is not a parseable Node-RED initialize body: ${error.message}`);
  }
}

export function patchLk1PlanRulesGatewayInitialize(source, target = PLAN_RULES_TARGETS.gateway) {
  assertNotPatched(source, GATEWAY_INITIALIZE_MARKER, "LK1 plan-rules gateway initialize");
  assertPreimage(source, target, "Gateway initialize", "initialize");
  const patched = buildGatewayInitialize(source);
  assertPostimage(patched, target, "Gateway initialize", "initialize");
  return patched;
}

export function patchLk1PlanRulesGatewayBody(source, target = PLAN_RULES_TARGETS.gateway) {
  assertNotPatched(source, GATEWAY_PATCH_MARKER, "LK1 plan-rules gateway");
  assertPreimage(source, target, "Gateway");
  const patched = buildGatewayBody(source);
  assertFunctionBody(patched, "Patched gateway body");
  assertPostimage(patched, target, "Gateway");
  return patched;
}

export function patchLk1PlanRulesEvaluatorBody(source, target = PLAN_RULES_TARGETS.evaluator) {
  assertNotPatched(source, EVALUATOR_PATCH_MARKER, "LK1 plan-rules evaluator");
  assertPreimage(source, target, "Evaluator");
  const patched = buildEvaluatorBody(source);
  assertFunctionBody(patched, "Patched evaluator body");
  assertPostimage(patched, target, "Evaluator");
  return patched;
}

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

export function composeLk1PlanRulesArtifacts(liveBytes, options = {}) {
  const bytes = Buffer.isBuffer(liveBytes)
    ? liveBytes
    : Buffer.from(`${JSON.stringify(liveBytes, null, 2)}\n`);
  const expectedSourceSha256 = options.expectedSourceSha256 ?? PLAN_RULES_SOURCE_SHA256;
  const sourceSha256 = sha256(bytes);
  if (sourceSha256 !== expectedSourceSha256) {
    throw new Error(`Live flow preimage drift: ${sourceSha256} != ${expectedSourceSha256}`);
  }
  const flow = JSON.parse(bytes.toString("utf8"));
  if (!Array.isArray(flow) || flow.some((node) => !node || typeof node.id !== "string" || !node.id)
    || new Set(flow.map((node) => node.id)).size !== flow.length) {
    throw new Error("Invalid flow identity");
  }
  if (options.expectedNodeCount !== undefined && flow.length !== options.expectedNodeCount) {
    throw new Error(`Live flow node count drift: ${flow.length} != ${options.expectedNodeCount}`);
  }
  if (flow.length !== PLAN_RULES_SOURCE_NODE_COUNT) {
    throw new Error(`Live flow node count drift: ${flow.length} != ${PLAN_RULES_SOURCE_NODE_COUNT}`);
  }
  const gateway = assertFunctionNode(
    flow.find((node) => node.id === PLAN_RULES_GATEWAY_NODE_ID), PLAN_RULES_GATEWAY_NODE_ID);
  const evaluator = assertFunctionNode(
    flow.find((node) => node.id === PLAN_RULES_EVALUATOR_NODE_ID), PLAN_RULES_EVALUATOR_NODE_ID);
  const preview = assertFunctionNode(
    flow.find((node) => node.id === PLAN_RULES_PREVIEW_NODE_ID), PLAN_RULES_PREVIEW_NODE_ID);
  const previewFuncBefore = preview.func;
  const previewInitializeBefore = preview.initialize;

  const beforeGatewaySha256 = sha256(gateway.func);
  const beforeGatewayInitializeSha256 = sha256(gateway.initialize);
  const beforeEvaluatorSha256 = sha256(evaluator.func);
  gateway.func = patchLk1PlanRulesGatewayBody(gateway.func);
  gateway.initialize = patchLk1PlanRulesGatewayInitialize(gateway.initialize);
  evaluator.func = patchLk1PlanRulesEvaluatorBody(evaluator.func);

  const changes = [
    { id: PLAN_RULES_GATEWAY_NODE_ID, fields: ["func", "initialize"],
      func: { beforeSha256: beforeGatewaySha256, afterSha256: sha256(gateway.func) },
      initialize: { beforeSha256: beforeGatewayInitializeSha256,
        afterSha256: sha256(gateway.initialize) } },
    { id: PLAN_RULES_EVALUATOR_NODE_ID, fields: ["func"],
      func: { beforeSha256: beforeEvaluatorSha256, afterSha256: sha256(evaluator.func) } },
  ];

  return {
    flow,
    candidateBytes: Buffer.from(`${JSON.stringify(flow, null, 2)}\n`),
    changes,
    pendingDeltas: PLAN_RULES_PENDING_DELTAS.map((delta) => ({ ...delta })),
    // The preview node is byte-identical to the live snapshot by construction: only
    // the two allow-listed nodes above were rewritten.
    previewNodeUnchanged: preview.func === previewFuncBefore
      && preview.initialize === previewInitializeBefore,
  };
}

function fail(message) {
  console.error(message);
  process.exitCode = 1;
}

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
    const key = args[index];
    const value = args[index + 1];
    if (!["--workspace", "--output", "--report"].includes(key) || !value || value.startsWith("--")) {
      fail("Usage: --workspace <fresh-live-workspace> --output <candidate.json> --report <report.json>");
      return;
    }
    if (values[key] !== undefined) {
      fail(`Duplicate argument: ${key}`);
      return;
    }
    values[key] = value;
  }
  if (Object.keys(values).length !== 3) {
    fail("Usage: --workspace <fresh-live-workspace> --output <candidate.json> --report <report.json>");
    return;
  }

  const verified = verifyWorkspace(values["--workspace"], { quiet: true });
  const liveBytes = fs.readFileSync(verified.sourcePath);
  const built = composeLk1PlanRulesArtifacts(liveBytes, {
    expectedSourceSha256: PLAN_RULES_SOURCE_SHA256,
    expectedNodeCount: PLAN_RULES_SOURCE_NODE_COUNT,
  });
  if (sha256(liveBytes) !== verified.sourceSha256) {
    fail("Live source changed between verification and composition");
    return;
  }
  const [outputPath, reportPath] = prepareTargets(verified.workspace,
    [values["--output"], values["--report"]]);
  const outputText = built.candidateBytes.toString("utf8");
  const report = {
    kind: PLAN_RULES_KIND,
    deploymentId: PLAN_RULES_DEPLOYMENT_ID,
    targets: {
      gateway: {
        id: PLAN_RULES_TARGETS.gateway.id,
        func: { beforeSha256: PLAN_RULES_TARGETS.gateway.liveFuncSha256,
          afterSha256: PLAN_RULES_TARGETS.gateway.patchedFuncSha256 },
        initialize: { beforeSha256: PLAN_RULES_TARGETS.gateway.liveInitializeSha256,
          afterSha256: PLAN_RULES_TARGETS.gateway.patchedInitializeSha256 },
      },
      evaluator: { id: PLAN_RULES_TARGETS.evaluator.id,
        func: { beforeSha256: PLAN_RULES_TARGETS.evaluator.liveFuncSha256,
          afterSha256: PLAN_RULES_TARGETS.evaluator.patchedFuncSha256 } },
    },
    planRulesActivation: {
      key: "subscriptions_lk1_plan_rules",
      expectedPrior: null,
      ruleCount: LK1_PLAN_RULES_DESIRED.rules.length,
      enforceFrom: "2026-09-01",
      hubPolicyWriterPreserved: true,
      appendedToGatewayInitialize: true,
    },
    sourceSha256: verified.sourceSha256,
    candidateSha256: sha256(outputText),
    sourceNodeCount: verified.nodeCount,
    candidateNodeCount: built.flow.length,
    changedNodeCount: built.changes.length,
    expectedChangedNodeCount: 2,
    changes: built.changes,
    pendingDeltas: built.pendingDeltas,
    previewNodeId: PLAN_RULES_PREVIEW_NODE_ID,
    topologyChanged: false,
    routesChanged: false,
    policyChanged: false,
    deploymentPerformed: false,
    liveMutationPerformed: false,
  };
  fs.writeFileSync(outputPath, outputText, { encoding: "utf8", mode: 0o600, flag: "wx" });
  fs.writeFileSync(reportPath, `${JSON.stringify(report, null, 2)}\n`,
    { encoding: "utf8", mode: 0o600, flag: "wx" });
  console.log(JSON.stringify(report));
}

const invokedPath = process.argv[1] ? fs.realpathSync(process.argv[1]) : "";
if (invokedPath === fileURLToPath(import.meta.url)) {
  try {
    main(process.argv.slice(2));
  } catch (error) {
    fail(error.message);
  }
}
