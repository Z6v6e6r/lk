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
    'function normalizePlanRules(', 'function resolveLk1Rule(', 'function lk1ReadPlanRules(']) {
    if (!source.includes(symbol)) throw new Error('Plan rules source drift: ' + symbol);
  }
  return source.replace(/^export /gm, '');
}
export function hubGatewaySource() {
  const source = fs.readFileSync(new URL('../nodered_lk1_hub_nodes/gateway.js', import.meta.url), 'utf8');
  const marker = '// EVENT_PAYMENT_ROUTES';
  if (source.split(marker).length !== 2) throw new Error('Event payment source marker drift');
  if (/(?:const|let|var|function)\s+(?:LK1_PLAN_RULES_GLOBAL|LK1_PLAN_RULES_FROM|resolveLk1Rule|normalizePlanRules|lk1ReadPlanRules)\b/
    .test(source)) {
    throw new Error('Gateway must not redeclare the embedded plan-rules symbols');
  }
  return planRulesSource() + source.replace(marker, () => eventPaymentRoutesSource());
}

export const bookingReadbackSource = () => fs.readFileSync(new URL("../nodered_lk1_hub_nodes/booking_readback.js", import.meta.url), "utf8");
