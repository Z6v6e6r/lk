import fs from "node:fs";
const flow = JSON.parse(fs.readFileSync(process.argv[2], "utf8"));
const byId = new Map(flow.map((n) => [n.id, n]));
const g = byId.get("lk_subscription_booking_router_20260804").func;
const e = byId.get("lk_subscription_managed_policy_20260820").func;
const p = byId.get("lk_subscription_price_preview_20260908_router").func;
const anchors = [
  "// HUB_STEPS",
  'ctx.step = "lk1_profile_continue";',
  'if (ctx.step === "lk1_operation_find") {',
  "const lk1CourtMasterServices = Object.freeze({",
  "const exerciseDirectionId = (exercise) => {",
  "const lk1ExpectedEventDiscountPercent = (decision, route) => (",
  "const lk1EventPaymentQuoteBinding = (ctx, quote = ctx.lk1) =>",
  "const lk1ClubEventPaymentBinding = (ctx, quote = ctx.lk1) => {",
  "// The club training («Дружба Топократы», direction 6233) spends the free hour",
  "// The club co-pay needs one more server-owned number",
  "const lk1Quote = (ctx, exercise, owned) => {",
  "const key = (kind, ...parts) => JSON.stringify([kind, ctx.tenantKey, ...parts]);",
  "TOPOKRATY_SUBSCRIPTION_UNAVAILABLE",
  "function isTopokratyExercise(value) {",
  "const continueSplitAfterVerifiedPrice = (ctx) => {",
  "const lk1EventPaymentBinding = (ctx, quote = ctx.lk1) => {",
  "const courtCoPay = decision.benefit?.kind === 'COURT_HOURLY_COPAY'",
  "LK1_COURT_PRICE_UNRESOLVED",
  "isTopokratyTrainingBenefit",
  "eventDiscountPercent",
  "isProTrainingDiscountRule",
  "canonical.isProTrainingExercise",
];
console.log("== gateway.func ==");
for (const a of anchors) {
  const c = g.split(a).length - 1;
  if (c) console.log(String(c).padStart(2), JSON.stringify(a.length > 70 ? a.slice(0, 70) : a));
}
console.log("== evaluator.func ==");
for (const a of anchors) {
  const c = e.split(a).length - 1;
  if (c) console.log(String(c).padStart(2), JSON.stringify(a.length > 70 ? a.slice(0, 70) : a));
}
console.log("== preview.func ==");
for (const a of anchors) {
  const c = p.split(a).length - 1;
  if (c) console.log(String(c).padStart(2), JSON.stringify(a.length > 70 ? a.slice(0, 70) : a));
}
