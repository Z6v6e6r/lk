// Compose the reviewable content portion of the LK1 train against the live 147 snapshot:
//  - evaluator.func / preview evaluate.func: replace the embedded LK1 body with the reviewed evaluator;
//  - preview router.func: recompose from the reviewed router source over the live split/join/usage;
// The booking gateway is NOT touched here (its court-window proof needs a re-anchored generation).
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { fileURLToPath } from "node:url";
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
const sha = (v) => crypto.createHash("sha256").update(v).digest("hex");

const { patchTopokratyEvaluatorBody } = await import(path.join(ROOT, "scripts/patch_live_lk1_topokraty_friendship_hotfix.mjs"));
const { previewSources } = await import(path.join(ROOT, "scripts/patch_nodered_subscription_price_preview.mjs"));
const { topokratyExclusionSource } = await import(path.join(ROOT, "scripts/lib/eventPaymentSources.mjs"));
const { buildExactGraphContract, validateReviewedFlowContract } = await import(path.join(ROOT, "scripts/nodered_reviewed_flow_deploy/runtime_contract.mjs"));

const livePath = process.argv[2];
const liveBytes = fs.readFileSync(livePath);
const flow = JSON.parse(liveBytes.toString("utf8"));
const byId = new Map(flow.map((n) => [n.id, n]));
const EVAL_ID = "lk_subscription_managed_policy_20260820";
const PREVIEW_EVAL_ID = "lk_subscription_price_preview_20260908_evaluate";
const PREVIEW_ROUTER_ID = "lk_subscription_price_preview_20260908_router";
const GATEWAY_ID = "lk_subscription_booking_router_20260804";

const reviewedEvaluator = fs.readFileSync(path.join(ROOT, "scripts/nodered_lk1_hub_nodes/evaluator.js"), "utf8");
const before = {
  evaluator: sha(byId.get(EVAL_ID).func),
  previewEvaluate: sha(byId.get(PREVIEW_EVAL_ID).func),
  previewRouter: sha(byId.get(PREVIEW_ROUTER_ID).func),
  gateway: sha(byId.get(GATEWAY_ID).func),
  usageBlock: (() => {
    const b = byId.get(GATEWAY_ID).func;
    return sha(b.slice(b.indexOf('if (ctx.step === "lk1_usage_operations") {'), b.indexOf('if (ctx.step === "lk1_policy_decision") {')));
  })(),
};

const EVAL_OPEN = 'if (Object.prototype.hasOwnProperty.call(msg._managedSubscriptionPolicyInput || {}, "lk1Policy")) {\n  return (() => {\n';
const EVAL_CLOSE = "\n})();\n}";
const embeddedSha = (body) => {
  const s = body.indexOf(EVAL_OPEN) + EVAL_OPEN.length;
  return sha(body.slice(s, body.indexOf(EVAL_CLOSE, s)));
};
const target = {
  liveEvaluatorFuncSha256: before.evaluator,
  liveEmbeddedSha256: embeddedSha(byId.get(EVAL_ID).func),
  reviewedEvaluatorSha256: sha(reviewedEvaluator),
};
byId.get(EVAL_ID).func = patchTopokratyEvaluatorBody(byId.get(EVAL_ID).func, target);
byId.get(PREVIEW_EVAL_ID).func = patchTopokratyEvaluatorBody(byId.get(PREVIEW_EVAL_ID).func, {
  ...target, liveEvaluatorFuncSha256: before.previewEvaluate,
  liveEmbeddedSha256: embeddedSha(byId.get(PREVIEW_EVAL_ID).func),
});
const evaluatorAfter = sha(byId.get(EVAL_ID).func);

const composed = previewSources(flow, {
  pins: {
    booking: before.gateway,
    evaluator: evaluatorAfter,
    pricing: sha(byId.get("8f7bd5b482fe9763").func),
    join: sha(byId.get("e92e68bf3f08a70c").func),
  },
  installedUsageSha256: before.usageBlock,
});
byId.get(PREVIEW_ROUTER_ID).func = topokratyExclusionSource() + "\n" + composed.router;

const after = {
  evaluator: sha(byId.get(EVAL_ID).func),
  previewEvaluate: sha(byId.get(PREVIEW_EVAL_ID).func),
  previewRouter: sha(byId.get(PREVIEW_ROUTER_ID).func),
};
const changes = [
  { id: EVAL_ID, fields: ["func"], func: { beforeSha256: before.evaluator, afterSha256: after.evaluator } },
  { id: PREVIEW_EVAL_ID, fields: ["func"], func: { beforeSha256: before.previewEvaluate, afterSha256: after.previewEvaluate } },
  { id: PREVIEW_ROUTER_ID, fields: ["func"], func: { beforeSha256: before.previewRouter, afterSha256: after.previewRouter } },
];
const candidateBytes = Buffer.from(`${JSON.stringify(flow, null, 2)}\n`);
const contract = buildExactGraphContract({
  liveBytes, candidateBytes, deploymentId: "lk1-train-147-prep-20261005-content",
  allowedChanges: changes.map((c) => ({ id: c.id, fields: [...c.fields] })), allowedAdditionIds: [],
});
validateReviewedFlowContract({ liveBytes, candidateBytes, contract });

const outDir = process.argv[3];
fs.mkdirSync(outDir, { recursive: true, mode: 0o700 });
fs.writeFileSync(path.join(outDir, "content-candidate.flow.json"), candidateBytes, { mode: 0o600 });
fs.writeFileSync(path.join(outDir, "content-contract.json"), JSON.stringify(contract, null, 2) + "\n", { mode: 0o600 });
const markers = {
  evaluatorCourtBranch: byId.get(EVAL_ID).func.includes("COURT_HOURLY_COPAY"),
  evaluatorCourtRefusal: byId.get(EVAL_ID).func.includes("LK1_COURT_PRICE_UNRESOLVED"),
  previewCourtWindowStep: byId.get(PREVIEW_ROUTER_ID).func.includes('if (ctx.step === "lk1_court_window") {'),
  previewCourtQuote: byId.get(PREVIEW_ROUTER_ID).func.includes("COURT_HOURLY_COPAY"),
  previewTopokratyExclusion: byId.get(PREVIEW_ROUTER_ID).func.includes("function isTopokratyExercise(value) {"),
  previewProTraining: byId.get(PREVIEW_ROUTER_ID).func.includes("canonical.isProTrainingExercise"),
  previewResolverReachable: byId.get(PREVIEW_ROUTER_ID).func.includes("canonical.resolveLk1Rule"),
  previewHelperCount: composed.helperNames.length,
  gatewayStillLacksCourtProof: !byId.get(GATEWAY_ID).func.includes("lk1CourtMasterServices"),
};
console.log(JSON.stringify({ sourceSha256: sha(liveBytes), sourceNodeCount: flow.length, before, after, changes, candidateSha256: sha(candidateBytes), markers }, null, 2));
