import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
const sha = (v) => crypto.createHash("sha256").update(v).digest("hex");
const ROOT = process.argv[3];
const flow = JSON.parse(fs.readFileSync(process.argv[2], "utf8"));
const byId = new Map(flow.map((n) => [n.id, n]));
const node = (id) => {
  const n = byId.get(id);
  if (!n) throw new Error("missing node " + id);
  return n;
};
const f = (id) => node(id).func;
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), "utf8");
const extract = (text, startMarker, endMarker, label) => {
  if (text.split(startMarker).length !== 2) throw new Error(`${label}: start anchor count ${text.split(startMarker).length - 1}`);
  const s = text.indexOf(startMarker);
  const e = text.indexOf(endMarker, s + startMarker.length);
  if (e < 0) throw new Error(`${label}: end anchor missing`);
  return text.slice(s, e + endMarker.length);
};
const out = {};
out.live = {
  sha256: sha(fs.readFileSync(process.argv[2])),
  nodeCount: flow.length,
  bytes: fs.statSync(process.argv[2]).size,
};
out.nodes = {
  gatewayFunc: sha(f("lk_subscription_booking_router_20260804")),
  gatewayInitialize: sha(node("lk_subscription_booking_router_20260804").initialize),
  evaluatorFunc: sha(f("lk_subscription_managed_policy_20260820")),
  previewRouterFunc: sha(f("lk_subscription_price_preview_20260908_router")),
  previewEvaluateFunc: sha(f("lk_subscription_price_preview_20260908_evaluate")),
  previewFinalFunc: sha(f("lk_subscription_price_preview_20260908_final")),
  previewErrorFunc: sha(f("lk_subscription_price_preview_20260908_error")),
  splitFunc: sha(f("8f7bd5b482fe9763")),
  joinFunc: sha(f("e92e68bf3f08a70c")),
  finalizeFunc: sha(f("lk_subscription_booking_finalize_20260804")),
};

// --- embedded LK1 evaluator body (preview evaluate + booking evaluator) ---
const EVAL_OPEN = 'if (Object.prototype.hasOwnProperty.call(msg._managedSubscriptionPolicyInput || {}, "lk1Policy")) {\n  return (() => {\n';
const EVAL_CLOSE = "\n})();\n}";
for (const [label, id] of [["evaluatorEmbedded", "lk_subscription_managed_policy_20260820"],
  ["previewEvaluatorEmbedded", "lk_subscription_price_preview_20260908_evaluate"]]) {
  const body = f(id);
  const c = body.split(EVAL_OPEN).length - 1;
  if (c !== 1) { out[label] = `occurrences=${c}`; continue; }
  const s = body.indexOf(EVAL_OPEN) + EVAL_OPEN.length;
  const e = body.indexOf(EVAL_CLOSE, s);
  out[label] = sha(body.slice(s, e));
}

// --- usage block of gateway / preview router ---
const USAGE_START = 'if (ctx.step === "lk1_usage_operations") {';
const USAGE_END = 'if (ctx.step === "lk1_policy_decision") {';
for (const [label, id] of [["gatewayUsageBlock", "lk_subscription_booking_router_20260804"],
  ["previewRouterUsageBlock", "lk_subscription_price_preview_20260908_router"]]) {
  const body = f(id);
  const a = body.split(USAGE_START).length - 1;
  const b = body.split(USAGE_END).length - 1;
  if (a !== 1 || b !== 1) { out[label] = `anchors=${a}/${b}`; continue; }
  out[label] = sha(body.slice(body.indexOf(USAGE_START), body.indexOf(USAGE_END)));
}

// --- reviewed-source pins ---
const REV = {
  gateway: "scripts/nodered_lk1_hub_nodes/gateway.js",
  gatewayHooks: "scripts/nodered_lk1_hub_nodes/gateway_hooks.js",
  evaluator: "scripts/nodered_lk1_hub_nodes/evaluator.js",
  eventPayments: "scripts/nodered_lk1_hub_nodes/event_payments.js",
  bookingRouter: "scripts/nodered_subscription_booking_nodes/fn_subscription_booking_router.js",
  previewRouter: "scripts/nodered_subscription_price_preview_nodes/router.js",
  previewFinal: "scripts/nodered_subscription_price_preview_nodes/final.js",
  previewError: "scripts/nodered_subscription_price_preview_nodes/error.js",
  previewEvaluate: "scripts/nodered_subscription_price_preview_nodes/evaluate.js",
};
out.reviewed = {};
for (const [k, rel] of Object.entries(REV)) {
  try { out.reviewed[k] = sha(read(rel)); } catch (e) { out.reviewed[k] = "ERR " + e.message; }
}
// friendship / plan-rules reviewed fragments
try {
  const gw = read(REV.gateway);
  out.reviewedFragment = {
    directionHelper: sha(extract(gw, "// The Viva direction of the resolved exercise, read through the same aliases",
      "  return Number.isInteger(numeric) ? numeric : null;\n};\n", "directionHelper")),
    percentHelper: sha(extract(gw, "    // The percent the advisory preview quotes for a charged event. It is the percent the",
      "        : ctx.lk1.rule[route.discountField]);\n", "percentHelper")),
    configFragment: sha(extract(gw, "const lk1Config = (owned, stationId) => {", "\nconst lk1Stop", "configFragment")),
  };
} catch (e) { out.reviewedFragment = "ERR " + e.message; }
try {
  const hooks = read(REV.gatewayHooks);
  out.reviewedCourt = {
    helpers: sha(extract(hooks, "const lk1CourtMasterServices = Object.freeze({", "  return total;\n};\n", "courtHelpers")),
    dispatch: sha(extract(hooks, "// The club co-pay needs one more server-owned number", "  return startLk1CourtWindowFetch(ctx);\n}\n", "courtDispatch")),
    steps: sha(extract(hooks, "const lk1CourtWindowEndTime = (exercise) => {", "  return false;\n}\n", "courtSteps")),
  };
} catch (e) { out.reviewedCourt = "ERR " + e.message; }
try {
  const { planRulesSource } = await import(path.join(ROOT, "scripts/lib/eventPaymentSources.mjs"));
  out.reviewedPlanRulesModule = sha(planRulesSource());
} catch (e) { out.reviewedPlanRulesModule = "ERR " + e.message; }

// --- plan-rules fragment for the embedded module (raw lib file, export stripped) ---
try {
  out.reviewedPlanRulesModuleFallback = sha(read("scripts/lib/lk1PlanRules.mjs").replace(/^export /gm, ""));
} catch (e) { out.reviewedPlanRulesModuleFallback = "ERR " + e.message; }

// --- event payment source ---
try {
  const { eventPaymentRoutesSource } = await import(path.join(ROOT, "scripts/lib/eventPaymentSources.mjs"));
  const src = eventPaymentRoutesSource();
  const START = "// The club training («Дружба Топократы», direction 6233) spends the free hour";
  const END = "  lk1ClubEventPaymentBinding(ctx, quote) || lk1EventPaymentBinding(ctx, quote);\n";
  const s = src.indexOf(START); const e = src.indexOf(END, s);
  out.clubMoneyFragmentSha256 = s < 0 || e < 0 ? "anchors missing" : sha(src.slice(s, e + END.length));
} catch (e) { out.clubMoneyFragmentSha256 = "ERR " + e.message; }

console.log(JSON.stringify(out, null, 2));
