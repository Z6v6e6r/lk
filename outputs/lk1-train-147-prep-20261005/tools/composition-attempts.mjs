// Record the exact outcome of composing each train generation against the live 147 snapshot,
// with the live/preimage pins re-derived to that snapshot (postimage assertions relaxed so the
// first structural blocker is visible).
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { fileURLToPath } from "node:url";
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
const sha = (v) => crypto.createHash("sha256").update(v).digest("hex");
const livePath = process.argv[2];
const outPath = process.argv[3];
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
const usageBlock = (body) => sha(body.slice(body.indexOf('if (ctx.step === "lk1_usage_operations") {'), body.indexOf('if (ctx.step === "lk1_policy_decision") {')));
const rf = (rel) => fs.readFileSync(path.join(ROOT, rel), "utf8");

const live = {
  flow: sha(raw), nodeCount: flow.length,
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
  usageBlock: usageBlock(f("lk_subscription_booking_router_20260804")),
};
const reviewed = {
  gateway: sha(rf("scripts/nodered_lk1_hub_nodes/gateway.js")),
  gatewayHooks: sha(rf("scripts/nodered_lk1_hub_nodes/gateway_hooks.js")),
  evaluator: sha(rf("scripts/nodered_lk1_hub_nodes/evaluator.js")),
  bookingRouter: sha(rf("scripts/nodered_subscription_booking_nodes/fn_subscription_booking_router.js")),
  previewRouter: sha(rf("scripts/nodered_subscription_price_preview_nodes/router.js")),
  previewFinal: sha(rf("scripts/nodered_subscription_price_preview_nodes/final.js")),
  previewError: sha(rf("scripts/nodered_subscription_price_preview_nodes/error.js")),
};

const makeTemp = (name, source) => {
  const tmp = path.join(ROOT, "scripts", `.probe-${name}`);
  fs.writeFileSync(tmp, source);
  return tmp;
};
const load = async (name, transform) => {
  const original = fs.readFileSync(path.join(ROOT, "scripts", name), "utf8");
  const { source, log } = transform(original);
  const tmp = makeTemp(name, source);
  const mod = await import(tmp);
  return { mod, log, cleanup: () => fs.unlinkSync(tmp) };
};
const simple = (source, name, value, quote = '"') => {
  const re = new RegExp(`(export const ${name}\\s*=\\s*)(['"\`])([^'"\`]*)\\2(;)`);
  if (!re.test(source)) throw new Error("cannot locate " + name);
  return source.replace(re, `$1${quote}${value}${quote}$4`);
};
const num = (source, name, value) => {
  const re = new RegExp(`(export const ${name}\\s*=\\s*)(\\d+)(;)`);
  if (!re.test(source)) throw new Error("cannot locate " + name);
  return source.replace(re, `$1${value}$3`);
};
const objKey = (source, obj, key, value, quote = '"') => {
  const objRe = new RegExp(`export const ${obj} = Object\\.freeze\\(\\{([\\s\\S]*?)\\n\\}\\);`);
  const m = source.match(objRe);
  if (!m) throw new Error("cannot locate object " + obj);
  const keyRe = new RegExp(`(\\b${key}:\\s*)(['"\`])([^'"\`]*)\\2`);
  if (!keyRe.test(m[1])) throw new Error(`cannot locate ${obj}.${key}`);
  const body = m[1].replace(keyRe, `$1${quote}${value}${quote}`);
  return source.replace(objRe, `export const ${obj} = Object.freeze({${body}\n});`);
};

const results = [];
const attempt = async (label, fn) => {
  try { const value = await fn(); results.push({ generation: label, ok: true, ...value }); }
  catch (error) { results.push({ generation: label, ok: false, error: String(error.message || error) }); }
};

// 1. friendship
await attempt("lk1-topokraty-friendship", async () => {
  const { mod, cleanup } = await load("patch_live_lk1_topokraty_friendship_hotfix.mjs", (s) => {
    s = simple(s, "TOPOKRATY_UPSTREAM_SHA256", live.flow);
    s = num(s, "TOPOKRATY_SOURCE_NODE_COUNT", live.nodeCount);
    for (const [k, v] of Object.entries({ liveFuncSha256: live.gatewayFunc, liveInitializeSha256: live.gatewayInitialize, liveEvaluatorFuncSha256: live.evaluatorFunc, liveEmbeddedSha256: live.evaluatorEmbedded, livePreviewFuncSha256: live.previewRouterFunc })) s = objKey(s, "TOPOKRATY_TARGET", k, v);
    for (const [k, v] of Object.entries({ splitFuncSha256: live.splitFunc, joinFuncSha256: live.joinFunc, allowanceBlockSha256: live.usageBlock })) s = objKey(s, "TOPOKRATY_PREVIEW_INSTALLED", k, v);
    return { source: s, log: null };
  });
  try { const b = mod.composeTopokratyArtifacts(raw, { assertPostimages: false, sourceSha256: live.flow }); return { candidateSha256: b.candidateSha256, changedNodes: b.changes.map((c) => c.id) }; }
  finally { cleanup(); }
});

// 2. reclaim
await attempt("lk1-topokraty-rejection-reclaim", async () => {
  const { mod, cleanup } = await load("patch_live_lk1_topokraty_rejection_reclaim_hotfix.mjs", (s) => {
    s = simple(s, "TOPOKRATY_RECLAIM_UPSTREAM_SHA256", live.flow);
    s = num(s, "TOPOKRATY_RECLAIM_SOURCE_NODE_COUNT", live.nodeCount);
    for (const [k, v] of Object.entries({ liveFuncSha256: live.gatewayFunc, liveEvaluatorFuncSha256: live.evaluatorFunc, livePreviewFuncSha256: live.previewRouterFunc })) s = objKey(s, "TOPOKRATY_RECLAIM_TARGET", k, v);
    for (const [k, v] of Object.entries({ splitFuncSha256: live.splitFunc, joinFuncSha256: live.joinFunc, allowanceBlockSha256: live.usageBlock })) s = objKey(s, "TOPOKRATY_RECLAIM_PREVIEW_INSTALLED", k, v);
    return { source: s, log: null };
  });
  try { const b = mod.composeTopokratyReclaimArtifacts(raw, { sourceSha256: live.flow, assertPostimages: false }); return { candidateSha256: b.candidateSha256, changedNodes: b.changes.map((c) => c.id) }; }
  finally { cleanup(); }
});

// 3. copay
await attempt("lk1-topokraty-copay", async () => {
  const { mod, cleanup } = await load("patch_live_lk1_topokraty_copay_hotfix.mjs", (s) => {
    s = simple(s, "TOPOKRATY_COPAY_UPSTREAM_SHA256", live.flow);
    s = num(s, "TOPOKRATY_COPAY_SOURCE_NODE_COUNT", live.nodeCount);
    for (const [k, v] of Object.entries({ liveFuncSha256: live.gatewayFunc, liveInitializeSha256: live.gatewayInitialize, liveEvaluatorFuncSha256: live.evaluatorFunc, livePreviewFuncSha256: live.previewRouterFunc })) s = objKey(s, "TOPOKRATY_COPAY_TARGET", k, v);
    for (const [k, v] of Object.entries({ splitFuncSha256: live.splitFunc, joinFuncSha256: live.joinFunc, allowanceBlockSha256: live.usageBlock })) s = objKey(s, "TOPOKRATY_COPAY_PREVIEW_INSTALLED", k, v);
    return { source: s, log: null };
  });
  try { const b = mod.composeTopokratyCopayArtifacts(raw, { assertPostimages: false, sourceSha256: live.flow }); return { candidateSha256: b.candidateSha256, changedNodes: b.changes.map((c) => c.id) }; }
  finally { cleanup(); }
});

// 4. plan rules
await attempt("lk1-plan-rules", async () => {
  const { mod, cleanup } = await load("patch_live_lk1_plan_rules.mjs", (s) => {
    s = simple(s, "PLAN_RULES_SOURCE_SHA256", live.flow);
    s = num(s, "PLAN_RULES_SOURCE_NODE_COUNT", live.nodeCount);
    for (const [k, v] of Object.entries({ liveFuncSha256: live.gatewayFunc, liveInitializeSha256: live.gatewayInitialize })) s = objKey(s, "PLAN_RULES_TARGETS", k, v);
    return { source: s, log: null };
  });
  try { const b = mod.composeLk1PlanRulesArtifacts(raw, { expectedSourceSha256: live.flow, assertPostimages: false }); return { candidateSha256: b.candidateSha256 }; }
  finally { cleanup(); }
});

// 5. hub overlay
await attempt("lk1-hub", async () => {
  const { mod, cleanup } = await load("patch_live_lk1_hub.mjs", (s) => {
    for (const [k, v] of Object.entries({ split: live.splitFunc, gateway: live.gatewayFunc, finalize: live.finalizeFunc, evaluator: live.evaluatorFunc })) s = objKey(s, "HUB_PREIMAGES", k, v);
    // node/dependency pins come from preimages.json on disk; point the module at a patched copy
    return { source: s, log: null };
  });
  try {
    const pinsPath = path.join(ROOT, "scripts/nodered_lk1_hub_nodes/preimages.json");
    const backup = fs.readFileSync(pinsPath);
    const pins = JSON.parse(backup.toString("utf8"));
    for (const id of Object.keys(pins.nodes)) pins.nodes[id] = sha(JSON.stringify(byId.get(id)));
    const targets = new Set(["8f7bd5b482fe9763", "lk_subscription_booking_router_20260804", "lk_subscription_booking_finalize_20260804", "lk_subscription_managed_policy_20260820"]);
    pins.incoming = flow.flatMap((n) => (n.wires || []).flatMap((group, output) => group.filter((id) => targets.has(id)).map((id) => [n.id, output, id]))).sort();
    fs.writeFileSync(pinsPath, JSON.stringify(pins, null, 2) + "\n");
    try {
      const candidate = mod.composeHubFlow(flow, { expectedPrior: null, desired: null });
      return { candidateSha256: sha(Buffer.from(JSON.stringify(candidate, null, 2) + "\n")), changedNodes: ["8f7bd5b482fe9763", "lk_subscription_booking_router_20260804", "lk_subscription_booking_finalize_20260804", "lk_subscription_managed_policy_20260820"] };
    } finally { fs.writeFileSync(pinsPath, backup); }
  } finally { cleanup(); }
});

// 6. patriots
await attempt("lk1-patriots-friendship", async () => {
  const { mod, cleanup } = await load("patch_live_lk1_patriots_friendship.mjs", (s) => {
    s = simple(s, "PATRIOTS_SOURCE_SHA256", live.flow, "'");
    s = num(s, "PATRIOTS_SOURCE_NODE_COUNT", live.nodeCount);
    for (const [k, v] of Object.entries({
      gatewayFunc: live.gatewayFunc, gatewayInitialize: live.gatewayInitialize, evaluatorFunc: live.evaluatorFunc,
      evaluatorEmbedded: live.evaluatorEmbedded, previewFunc: live.previewRouterFunc,
      previewEvaluatorFunc: live.previewEvaluateFunc, previewEvaluatorEmbedded: live.previewEvaluateEmbedded,
      pricingFunc: live.splitFunc, joinFunc: live.joinFunc, usageBlock: live.usageBlock,
      reviewedGatewaySource: reviewed.gateway, reviewedGatewayHooksSource: reviewed.gatewayHooks,
      reviewedEvaluatorSource: reviewed.evaluator, reviewedBookingRouterSource: reviewed.bookingRouter,
      reviewedPreviewSource: reviewed.previewRouter,
    })) s = objKey(s, "PATRIOTS_PREIMAGE", k, v, "'");
    return { source: s, log: null };
  });
  try { const b = mod.composePatriotsArtifacts(raw, { assertPostimages: false }); return { candidateSha256: b.candidateSha256, changedNodes: b.changes.map((c) => c.id), postimages: b.postimages }; }
  finally { cleanup(); }
});

// 7. subscription calculation repair
await attempt("subscription-calculation-repair", async () => {
  const { mod, cleanup } = await load("patch_live_subscription_calculation_repair.mjs", (s) => {
    s = simple(s, "SOURCE_SHA256", live.flow, "'");
    return { source: s, log: null };
  });
  try { const b = mod.composeSubscriptionCalculationRepair(raw); return { candidateSha256: b.report.candidateSha256 }; }
  finally { cleanup(); }
});

// 8. event quotes
await attempt("lk1-event-quotes", async () => {
  const { mod, cleanup } = await load("patch_live_lk1_event_quotes_hotfix.mjs", (s) => {
    s = simple(s, "EVENT_QUOTES_SOURCE_SHA256", live.flow);
    s = num(s, "EVENT_QUOTES_SOURCE_NODE_COUNT", live.nodeCount);
    for (const [k, v] of Object.entries({ liveFuncSha256: live.previewRouterFunc })) s = objKey(s, "EVENT_QUOTES_TARGETS", k, v);
    return { source: s, log: null };
  });
  try { const b = mod.composeLk1EventQuotesArtifacts(raw, "probe", { assertPostimages: false }); return { candidateSha256: b.candidateSha256 }; }
  finally { cleanup(); }
});

fs.writeFileSync(outPath, JSON.stringify({ live, reviewed, results }, null, 2) + "\n", { mode: 0o600 });
console.log(JSON.stringify(results, null, 2));
