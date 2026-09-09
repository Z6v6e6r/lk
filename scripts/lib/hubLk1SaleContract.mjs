import { createHash } from "node:crypto";
import { buildHubPolicyTransition } from "./lk1HubPolicyTransition.mjs";
// Server-owned capability receipt: the release builder must bind sourceDigest to
// the exact installed LK1 booking graph. Shape alone is not publication evidence.
export function normalizeHubSalePolicy(value) {
  try { if (typeof value === 'string') value = JSON.parse(value); } catch { return null; }
  const keys = ['productId', 'maxActiveBookings', 'freeGameMinutesPerDay', 'gameOverageDiscountPercent', 'groupTrainingDiscountPercent', 'tournamentDiscountPercent'];
  if (!value || Array.isArray(value) || typeof value !== 'object'
    || Object.keys(value).sort().join() !== [...keys].sort().join()
    || value.productId !== 'db7a5250-7369-4f43-8ac5-9111be24bc74'
    || keys.slice(1).some(k => !Number.isSafeInteger(value[k]) || value[k] < 0)
    || value.maxActiveBookings < 1 || keys.slice(3).some(k => value[k] > 100)) return null;
  return Object.fromEntries(keys.map(k => [k, value[k]]));
}
export function normalizeFrozenHubSale(value) {
  const policy = normalizeHubSalePolicy(value?.policy);
  if (!value || value.mode !== 'LK1_VIVA_PRODUCT_NEXT_DAY_V1' || value.bookingUsageScope !== 'ALL_BOOKINGS' || !policy
    || !/^sha256:[a-f0-9]{64}$/.test(value.sourceDigest || '')
    || Object.keys(value).sort().join() !== ['mode', 'policy', 'sourceDigest', 'bookingUsageScope'].sort().join()) return null;
  return { mode: value.mode, policy, sourceDigest: value.sourceDigest, bookingUsageScope: value.bookingUsageScope };
}
export function readHubLk1Sale(globalContext) {
  if (globalContext.get('summer_subscription_hub_lk1_sales_enabled') !== true
    || globalContext.get('summer_subscription_sales_20260909_enabled') !== true) return null;
  const policy = normalizeHubSalePolicy(globalContext.get('subscriptions_lk1_product_policy'));
  const receipt = normalizeFrozenHubSale(globalContext.get('subscriptions_lk1_hub_sale_runtime'));
  if (!policy || !receipt || JSON.stringify(policy) !== JSON.stringify(receipt.policy)) return null;
  return receipt;
}
export const HUB_LK1_SALE_HELPERS = [normalizeHubSalePolicy, normalizeFrozenHubSale, readHubLk1Sale]
  .map(fn => fn.toString()).join('\n') + '\nconst hubLk1Sale = readHubLk1Sale(global);\nconst piterNextDaySale = global.get("summer_subscription_piter_next_day_sales_20260909_enabled") === true && global.get("summer_subscription_sales_20260909_enabled") === true;\n';
export const HUB_LK1_SALE_SOURCE_FILES = [
  'fn_tournament_subscription_purchase_prepare.js', 'fn_tournament_subscription_purchase_limit.js',
  'fn_tournament_subscription_purchase_router.js', 'fn_tournament_subscription_piter_atomic_router.js',
  'fn_tournament_subscription_status_response.js', 'fn_tournament_subscription_confirm_resolve.js',
];

// Attests the installed conservative implementation, not the newer selected-benefit scope.
export function buildHubRuntimeEvidence(flow) {
  const ids = ['8f7bd5b482fe9763','lk_subscription_booking_router_20260804',
    'lk_subscription_booking_finalize_20260804','lk_subscription_managed_policy_20260820','lk_subscription_product_router_20260907'];
  const hash = value => createHash('sha256').update(value).digest('hex');
  const nodes = ids.map(id => {
    const matches = flow.filter(n => n.id === id);
    if (matches.length !== 1) throw Error('HUB runtime dependency identity');
    return {id,nodeSha256:hash(JSON.stringify(matches[0]))};
  });
  const policy = {productId:'db7a5250-7369-4f43-8ac5-9111be24bc74',maxActiveBookings:4,
    freeGameMinutesPerDay:60,gameOverageDiscountPercent:30,groupTrainingDiscountPercent:50,tournamentDiscountPercent:50};
  const transition = buildHubPolicyTransition({expectedPrior:null,desired:policy});
  const gateway = flow.find(n => n.id === ids[1]);
  if (!gateway.func.includes(transition.reader) || gateway.initialize !== transition.initialize) throw Error('HUB runtime policy mismatch');
  const incoming = flow.flatMap(n => (n.wires || []).flatMap((group,output) => group.filter(id => ids.includes(id)).map(id => [n.id,output,id])));
  const sourceDigest = 'sha256:' + hash(JSON.stringify({policy,bookingUsageScope:'ALL_BOOKINGS',nodes,incoming}));
  return {nodes,receipt:normalizeFrozenHubSale({mode:'LK1_VIVA_PRODUCT_NEXT_DAY_V1',policy,sourceDigest,bookingUsageScope:'ALL_BOOKINGS'})};
}
