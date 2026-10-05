import fs from "node:fs";
const flow = JSON.parse(fs.readFileSync(process.argv[2], "utf8"));
const byId = new Map(flow.map((n) => [n.id, n]));
const gateway = byId.get("lk_subscription_booking_router_20260804").func;
const initialize = byId.get("lk_subscription_booking_router_20260804").initialize;
const preview = byId.get("lk_subscription_price_preview_20260908_router").func;
const anchors = {
  FIRST_USE_ANCHOR: '    const firstUse = preflightAvailability.resolveSplitSubscriptionLifecycle(subscription, eventDate(exercise)) === "NEW_FIRST_USE_CANDIDATE";\n',
  OWNER_GUARD_ANCHOR: '    if (owners.some((id) => normalizeId(id) !== normalizeId(ctx.actorClientId))) violations.push("owner_mismatch");\n',
  PATRIOTS_MONEY_SCOPE_OLD: '  const selected = findOwnedSubscriptions({ ...exercise, availableClientSubscriptions: rows }, ctx.clientSubscriptionId);\n',
  PATRIOTS_MONEY_SCOPE_END: '  // The resolver alone decides the enforced cohort:',
  PATRIOTS_EARLY_GUARD_ANCHOR: '  const enforcedRule = selectedRule.matched && !selectedRule.legacy;\n',
  PATRIOTS_DETOUR_OLD: '    && ruleConfigured && ctx.lk1MoneyReadbackPhase !== "exercise"\n    && (selectedOwned.length === 0 || enforcedRule)) {',
  CATEGORY_ANCHOR: '  if ([1613].includes(typeId) || [4588].includes(directionId)) return "open_game";\n',
  REVIEWED_CATEGORY_ANCHOR: '  if ([1613].includes(typeId) || [4588, 6180].includes(directionId)) return "open_game";\n',
  PLAN_START: 'const lk1PlanRulesKey = "subscriptions_lk1_plan_rules";',
  PLAN_END: 'const lk1StationExclusionsKey',
  PREVIEW_GAME_SCOPE_START: '  const visitCount = ctx.previewResolved ? 1 : ctx.target.durationMinutes >= 90 ? 2 : 1;\n',
  PREVIEW_GAME_SCOPE_END: '  if (!ctx.previewResolved) {',
  PREVIEW_GAME_TARGET_OLD: 'priceProductId: ctx.priceProductId } : {}) } } };',
  PATRIOTS_MONEY_ONLY_GUARD: '    const patriotsMoneyOnlyEvent = configured.rule?.productId === "37ab3713-4431-4815-96ba-d7ece76a9241"\n      && ["group_training", "tournament"].includes(resolveCategory(exercise));\n',
  PATRIOTS_FIRST_USE_REFUSAL: '    if (firstUse && patriotsMoneyOnlyEvent) violations.push("patriots_activation_required");\n',
};
const counts = (body, m) => body.split(m).length - 1;
console.log("== gateway.func ==");
for (const [k, v] of Object.entries(anchors)) console.log(String(counts(gateway, v)).padStart(2), k);
console.log("== preview.func ==");
for (const [k, v] of Object.entries(anchors)) {
  const c = counts(preview, v);
  if (c) console.log(String(c).padStart(2), k);
}
console.log("== initialize ==");
for (const k of ["PLAN_START", "PLAN_END"]) console.log(String(counts(initialize, anchors[k])).padStart(2), k);
// installed plan payload
const s = initialize.indexOf(anchors.PLAN_START);
const e = initialize.indexOf(anchors.PLAN_END);
const block = initialize.slice(s, e);
const lit = "const lk1DesiredPlanRules = ";
const d = block.indexOf(lit);
if (d >= 0) {
  const payload = JSON.parse(block.slice(d + lit.length).split(";\n")[0]);
  console.log("installedDesiredRules=", payload.rules.length, "planKeys=", JSON.stringify(payload.rules.map((r) => r.planKey)));
} else console.log("desired literal absent");
