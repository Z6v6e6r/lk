// Derive every live/preimage pin the train's patchers need, from the 147 snapshot bytes.
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { fileURLToPath } from "node:url";
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
const sha = (v) => crypto.createHash("sha256").update(v).digest("hex");
const livePath = process.argv[2];
const raw = fs.readFileSync(livePath);
const flow = JSON.parse(raw.toString("utf8"));
const byId = new Map(flow.map((n) => [n.id, n]));
const f = (id) => byId.get(id).func;
const init = (id) => byId.get(id).initialize;
const EVAL_OPEN = 'if (Object.prototype.hasOwnProperty.call(msg._managedSubscriptionPolicyInput || {}, "lk1Policy")) {\n  return (() => {\n';
const EVAL_CLOSE = "\n})();\n}";
const embedded = (body) => {
  const s = body.indexOf(EVAL_OPEN) + EVAL_OPEN.length;
  return sha(body.slice(s, body.indexOf(EVAL_CLOSE, s)));
};
const usage = (body) => body.slice(body.indexOf('if (ctx.step === "lk1_usage_operations") {'), body.indexOf('if (ctx.step === "lk1_policy_decision") {'));
const readFile = (rel) => fs.readFileSync(path.join(ROOT, rel), "utf8");

const out = {};
out.provenance = {
  host: "lk-primary-147",
  remotePath: "/root/.node-red/flows.json",
  transport: "ssh -o BatchMode=yes root@lk-primary-147 'cat /root/.node-red/flows.json'",
  localPath: livePath,
  sourceSha256: sha(raw),
  nodeCount: flow.length,
  bytes: raw.length,
};
out.live = {
  flowSha256: sha(raw),
  nodeCount: flow.length,
  gatewayFunc: sha(f("lk_subscription_booking_router_20260804")),
  gatewayInitialize: sha(init("lk_subscription_booking_router_20260804")),
  evaluatorFunc: sha(f("lk_subscription_managed_policy_20260820")),
  evaluatorEmbedded: embedded(f("lk_subscription_managed_policy_20260820")),
  previewRouterFunc: sha(f("lk_subscription_price_preview_20260908_router")),
  previewEvaluateFunc: sha(f("lk_subscription_price_preview_20260908_evaluate")),
  previewEvaluateEmbedded: embedded(f("lk_subscription_price_preview_20260908_evaluate")),
  previewFinalFunc: sha(f("lk_subscription_price_preview_20260908_final")),
  previewErrorFunc: sha(f("lk_subscription_price_preview_20260908_error")),
  splitFunc: sha(f("8f7bd5b482fe9763")),
  joinFunc: sha(f("e92e68bf3f08a70c")),
  finalizeFunc: sha(f("lk_subscription_booking_finalize_20260804")),
  usageBlock: sha(usage(f("lk_subscription_booking_router_20260804"))),
};
out.reviewedSource = {};
for (const rel of ["scripts/nodered_lk1_hub_nodes/gateway.js", "scripts/nodered_lk1_hub_nodes/gateway_hooks.js",
  "scripts/nodered_lk1_hub_nodes/evaluator.js", "scripts/nodered_lk1_hub_nodes/event_payments.js",
  "scripts/nodered_subscription_booking_nodes/fn_subscription_booking_router.js",
  "scripts/nodered_subscription_price_preview_nodes/router.js",
  "scripts/nodered_subscription_price_preview_nodes/final.js",
  "scripts/nodered_subscription_price_preview_nodes/error.js"]) {
  out.reviewedSource[rel] = sha(readFile(rel));
}
const extract = (text, start, end, label) => {
  if (text.split(start).length !== 2) throw new Error(`${label}: start anchor count ${text.split(start).length - 1}`);
  const s = text.indexOf(start);
  const e = text.indexOf(end, s + start.length);
  if (e < 0) throw new Error(`${label}: end anchor missing`);
  return text.slice(s, e + end.length);
};
const gw = readFile("scripts/nodered_lk1_hub_nodes/gateway.js");
const hooks = readFile("scripts/nodered_lk1_hub_nodes/gateway_hooks.js");
out.reviewedFragments = {
  directionHelper: sha(extract(gw, "// The Viva direction of the resolved exercise, read through the same aliases", "  return Number.isInteger(numeric) ? numeric : null;\n};\n", "directionHelper")),
  percentHelper: sha(extract(gw, "    // The percent the advisory preview quotes for a charged event. It is the percent the", "        : ctx.lk1.rule[route.discountField]);\n", "percentHelper")),
  configFragment: sha(extract(gw, "const lk1Config = (owned, stationId) => {", "\nconst lk1Stop", "configFragment")),
  courtHelpers: sha(extract(hooks, "const lk1CourtMasterServices = Object.freeze({", "  return total;\n};\n", "courtHelpers")),
  courtDispatch: sha(extract(hooks, "// The club co-pay needs one more server-owned number", "  return startLk1CourtWindowFetch(ctx);\n}\n", "courtDispatch")),
  courtSteps: sha(extract(hooks, "const lk1CourtWindowEndTime = (exercise) => {", "  return false;\n}\n", "courtSteps")),
};
const { planRulesSource, eventPaymentRoutesSource, topokratyExclusionSource } = await import(path.join(ROOT, "scripts/lib/eventPaymentSources.mjs"));
out.reviewedFragments.planRulesModule = sha(planRulesSource());
const eps = eventPaymentRoutesSource();
const cs = eps.indexOf("// The club training («Дружба Топократы», direction 6233) spends the free hour");
const ce = eps.indexOf("  lk1ClubEventPaymentBinding(ctx, quote) || lk1EventPaymentBinding(ctx, quote);\n", cs);
out.reviewedFragments.clubMoneyFragment = sha(eps.slice(cs, ce + "  lk1ClubEventPaymentBinding(ctx, quote) || lk1EventPaymentBinding(ctx, quote);\n".length));
out.clubExclusionModule = sha(topokratyExclusionSource());

// HUB preimages + node/dependency pins
out.hubPreimages = {
  split: sha(f("8f7bd5b482fe9763")),
  gateway: sha(f("lk_subscription_booking_router_20260804")),
  finalize: sha(f("lk_subscription_booking_finalize_20260804")),
  evaluator: sha(f("lk_subscription_managed_policy_20260820")),
};
const hubPinsPath = path.join(ROOT, "scripts/nodered_lk1_hub_nodes/preimages.json");
const hubPins = JSON.parse(fs.readFileSync(hubPinsPath, "utf8"));
out.hubPreimagesNodes = {};
for (const id of Object.keys(hubPins.nodes)) out.hubPreimagesNodes[id] = sha(JSON.stringify(byId.get(id)));
const targets = new Set(Object.values({ split: "8f7bd5b482fe9763", gateway: "lk_subscription_booking_router_20260804", finalize: "lk_subscription_booking_finalize_20260804", evaluator: "lk_subscription_managed_policy_20260820" }));
out.hubIncoming = flow.flatMap((n) => (n.wires || []).flatMap((group, output) => group.filter((id) => targets.has(id)).map((id) => [n.id, output, id]))).sort();

// plan-rules targets
out.planRulesTargets = {
  gateway: { liveFuncSha256: sha(f("lk_subscription_booking_router_20260804")), liveInitializeSha256: sha(init("lk_subscription_booking_router_20260804")) },
  evaluator: { liveFuncSha256: sha(f("lk_subscription_managed_policy_20260820")), liveEmbeddedSha256: embedded(f("lk_subscription_managed_policy_20260820")) },
  preview: { liveFuncSha256: sha(f("lk_subscription_price_preview_20260908_router")) },
};
out.previewCanonicalSources = {
  booking: sha(f("lk_subscription_booking_router_20260804")),
  evaluator: sha(f("lk_subscription_managed_policy_20260820")),
  pricing: sha(f("8f7bd5b482fe9763")),
  join: sha(f("e92e68bf3f08a70c")),
};
out.eventQuotesTargets = {
  previewRouter: { liveFuncSha256: sha(f("lk_subscription_price_preview_20260908_router")), reviewedFuncSha256: sha(readFile("scripts/nodered_subscription_price_preview_nodes/router.js")) },
  previewFinal: { liveFuncSha256: sha(f("lk_subscription_price_preview_20260908_final")), reviewedFuncSha256: sha(readFile("scripts/nodered_subscription_price_preview_nodes/final.js")) },
  booking: { liveFuncSha256: sha(f("lk_subscription_booking_router_20260804")) },
};
out.calculationRepair = {
  sourceSha256: sha(raw),
  nodeCount: flow.length,
  router: sha(f("lk_subscription_price_preview_20260908_router")),
  evaluate: sha(f("lk_subscription_price_preview_20260908_evaluate")),
  final: sha(f("lk_subscription_price_preview_20260908_final")),
  error: sha(f("lk_subscription_price_preview_20260908_error")),
  pins: out.previewCanonicalSources,
  usageSha256: sha(usage(f("lk_subscription_booking_router_20260804"))),
};
out.patriots = {
  sourceSha256: sha(raw),
  nodeCount: flow.length,
  gatewayFunc: sha(f("lk_subscription_booking_router_20260804")),
  gatewayInitialize: sha(init("lk_subscription_booking_router_20260804")),
  evaluatorFunc: sha(f("lk_subscription_managed_policy_20260820")),
  evaluatorEmbedded: embedded(f("lk_subscription_managed_policy_20260820")),
  previewFunc: sha(f("lk_subscription_price_preview_20260908_router")),
  previewEvaluatorFunc: sha(f("lk_subscription_price_preview_20260908_evaluate")),
  previewEvaluatorEmbedded: embedded(f("lk_subscription_price_preview_20260908_evaluate")),
  pricingFunc: sha(f("8f7bd5b482fe9763")),
  joinFunc: sha(f("e92e68bf3f08a70c")),
  usageBlock: sha(usage(f("lk_subscription_booking_router_20260804"))),
  reviewedGatewaySource: out.reviewedSource["scripts/nodered_lk1_hub_nodes/gateway.js"],
  reviewedGatewayHooksSource: out.reviewedSource["scripts/nodered_lk1_hub_nodes/gateway_hooks.js"],
  reviewedEvaluatorSource: out.reviewedSource["scripts/nodered_lk1_hub_nodes/evaluator.js"],
  reviewedBookingRouterSource: out.reviewedSource["scripts/nodered_subscription_booking_nodes/fn_subscription_booking_router.js"],
  reviewedPreviewSource: out.reviewedSource["scripts/nodered_subscription_price_preview_nodes/router.js"],
};
// installed-markers audit
const markers = {
  gateway: f("lk_subscription_booking_router_20260804"),
  initialize: init("lk_subscription_booking_router_20260804"),
  evaluator: f("lk_subscription_managed_policy_20260820"),
  preview: f("lk_subscription_price_preview_20260908_router"),
};
const count = (b, m) => b.split(m).length - 1;
out.installedMarkers = {
  clubMoneyMandate: count(markers.gateway, "lk1ClubEventPaymentBinding"),
  quoteBindingCallSites: count(markers.gateway, "lk1EventPaymentQuoteBinding("),
  reclaim: count(markers.gateway, "lk1ReclaimableAttempt"),
  topokratyGuardGroupTrainingOnly: count(markers.gateway, "resolveCategory(exercise) === \"group_training\""),
  topokratyGuardOpenGame: count(markers.gateway, "[group_training, open_game]"),
  clubGateUsesExplicitCategory: count(markers.gateway, '`На занятия Топократов'),
  planRulesTopokraty: count(markers.initialize, '"planKey":"topocraty"'),
  planRulesPatriots: count(markers.initialize, '"planKey":"patriots"'),
  proTrainingDiscount: count(markers.gateway, "isProTrainingDiscountRule"),
  patriotsMoneyValidity: count(markers.gateway, "patriotsMoneyOnlyIdentity"),
  courtWindowHelpers: count(markers.gateway, "lk1CourtMasterServices"),
  hourlyCourtPriceMinor: count(markers.gateway, "hourlyCourtPriceMinor"),
  windowTotalMinor: count(markers.gateway, "windowTotalMinor"),
  evaluatorCourtBranch: count(markers.evaluator, "COURT_HOURLY_COPAY"),
  previewCourtQuote: count(markers.preview, "COURT_HOURLY_COPAY"),
  previewCourtWindowStep: count(markers.preview, "ctx.step === 'courtWindow'"),
  hubStepsMarker: count(markers.gateway, "// HUB_STEPS"),
  profileContinueAssignment: count(markers.gateway, 'ctx.step = "lk1_profile_continue";'),
  profileContinueHandler: count(markers.gateway, 'if (ctx.step === "lk1_profile_continue") {'),
  courtDispatchAnchorUnique: count(markers.gateway, 'ctx.step = "lk1_profile_continue";') === 1,
  courtStepsAnchorUnique: count(markers.gateway, 'if (ctx.step === "lk1_operation_find") {') === 1,
};
const outPath = process.argv[3];
fs.writeFileSync(outPath, JSON.stringify(out, null, 2) + "\n", { mode: 0o600 });
console.log(JSON.stringify(out, null, 2));
