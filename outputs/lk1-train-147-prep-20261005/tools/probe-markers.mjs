import fs from "node:fs";
import crypto from "node:crypto";
const sha = (v) => crypto.createHash("sha256").update(v).digest("hex");
const flow = JSON.parse(fs.readFileSync(process.argv[2], "utf8"));
const byId = new Map(flow.map((n) => [n.id, n]));
const g = byId.get("lk_subscription_booking_router_20260804");
const counts = (s, m) => s.split(m).length - 1;
const names = [
  "lk1ClubEventPaymentBinding",
  "lk1EventPaymentQuoteBinding",
  "lk1EventPaymentBinding",
  "const exerciseDirectionId = (exercise) => {",
  "directionId: exerciseDirectionId(exercise),",
  "lk1ExpectedEventDiscountPercent",
  "lk1ReclaimableAttempt",
  "const lk1CourtMasterServices = Object.freeze({",
  "const lk1CourtWindowNeeded = (ctx) => {",
  'if (ctx.step === "lk1_court_window") {',
  "startLk1CourtWindowFetch",
  "lk1CourtWindowEndTime",
  "const continueSplitAfterVerifiedPrice = (ctx) => {",
  "retainLk1TariffProof",
  "lk1TariffProof",
  "windowTotalMinor",
  "hourlyCourtPriceMinor",
  "patriotsMoneyOnlyIdentity",
  "patriots_activation_required",
  "isProTrainingDiscountRule",
  "isProTrainingExercise",
  "PRO_TRAINING_SUBSCRIPTION_UNAVAILABLE",
  "paidShare",
  "isTopokratyExercise",
  "isTopokratyClubPack",
  "TOPOKRATY_SUBSCRIPTION_UNAVAILABLE",
  "COURT_HOURLY_COPAY",
  "courtCoPay",
  "LK1_COURT_PRICE_UNRESOLVED",
  "const supportsPatriotsGameScope",
  "PATRIOTS_DISCOUNT_EVENTS",
  "PATRIOTS_FRIENDSHIP_PRODUCT_ID",
  "GROUP_TRAINING_COURT_COPAY_V1",
];
for (const label of ["gateway.func", "gateway.init", "evaluator.func", "preview.func", "previewEval.func", "previewFinal.func"]) {
  const node = label.startsWith("gateway") ? g
    : label === "evaluator.func" ? byId.get("lk_subscription_managed_policy_20260820")
      : label === "preview.func" ? byId.get("lk_subscription_price_preview_20260908_router")
        : label === "previewEval.func" ? byId.get("lk_subscription_price_preview_20260908_evaluate")
          : byId.get("lk_subscription_price_preview_20260908_final");
  const body = label === "gateway.init" ? node.initialize : node.func;
  console.log(`\n== ${label} (${body.length} bytes, sha ${sha(body).slice(0, 12)}) ==`);
  for (const n of names) {
    const c = counts(body, n);
    if (c) console.log(`  ${String(c).padStart(2)} ${n}`);
  }
}
