import fs from 'node:fs';
export function eventPaymentRoutesSource() {
  return fs.readFileSync(new URL('../nodered_lk1_hub_nodes/event_payments.js', import.meta.url), 'utf8');
}
// Embedded library sources keep their module shape but drop the `export` keyword:
// the composed Node-RED function body has a single scope, so the reviewed module
// stays the only source of truth and declares the resolver exactly once.
export function planRulesSource() {
  const source = fs.readFileSync(new URL('./lk1PlanRules.mjs', import.meta.url), 'utf8');
  for (const symbol of ['const LK1_PLAN_RULES_GLOBAL =', 'const LK1_HUB_PRODUCT_ID =',
    'const LK1_STATION_EXCLUSIONS_GLOBAL =', 'function normalizePlanRules(',
    'function normalizeStationExclusions(', 'function resolveLk1Rule(',
    'function lk1ReadPlanRules(', 'function lk1ReadStationExclusions(']) {
    if (!source.includes(symbol)) throw new Error('Plan rules source drift: ' + symbol);
  }
  return source.replace(/^export /gm, '');
}
// The PRO-training exclusion is embedded the same way as the plan rules: the booking
// body declares it once, and the preview gets its own copy of the same module through
// `proTrainingEmbedding` in patch_nodered_subscription_price_preview.mjs.
export function proTrainingExclusionSource() {
  const source = fs.readFileSync(new URL('./proTrainingExclusion.mjs', import.meta.url), 'utf8');
  for (const symbol of ['const PRO_TRAINING_DIRECTION_IDS =', 'function isProTrainingName(',
    'function isProTrainingExercise(']) {
    if (!source.includes(symbol)) throw new Error('PRO training exclusion source drift: ' + symbol);
  }
  return source.replace(/^export /gm, '');
}
export function hubGatewaySource() {
  const source = fs.readFileSync(new URL('../nodered_lk1_hub_nodes/gateway.js', import.meta.url), 'utf8');
  const marker = '// EVENT_PAYMENT_ROUTES';
  if (source.split(marker).length !== 2) throw new Error('Event payment source marker drift');
  if (/(?:const|let|var|function)\s+(?:LK1_PLAN_RULES_GLOBAL|LK1_PLAN_RULES_FROM|LK1_STATION_EXCLUSIONS_GLOBAL|resolveLk1Rule|normalizePlanRules|normalizeStationExclusions|lk1ReadPlanRules|lk1ReadStationExclusions)\b/
    .test(source)) {
    throw new Error('Gateway must not redeclare the embedded plan-rules symbols');
  }
  if (/(?:const|let|var|function)\s+(?:PRO_TRAINING_DIRECTION_IDS|PRO_TRAINING_NAME_TOKEN|proTrainingIsRecord|proTrainingStr|proTrainingNum|isProTrainingName|isProTrainingExercise|isProTrainingEnergyPack)\b/
    .test(source)) {
    throw new Error('Gateway must not redeclare the embedded PRO-training exclusion symbols');
  }
  return planRulesSource() + proTrainingExclusionSource() + source.replace(marker, () => eventPaymentRoutesSource());
}

export const bookingReadbackSource = () => fs.readFileSync(new URL("../nodered_lk1_hub_nodes/booking_readback.js", import.meta.url), "utf8");
