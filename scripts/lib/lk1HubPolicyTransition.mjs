// A source-bound transition for one existing Node-RED global, not an admin API.
export const HUB_POLICY_KEY = 'subscriptions_lk1_product_policy';
export const HUB_POLICY_PRODUCT = 'db7a5250-7369-4f43-8ac5-9111be24bc74';
const fields = ['maxActiveBookings', 'freeGameMinutesPerDay', 'gameOverageDiscountPercent',
  'groupTrainingDiscountPercent', 'tournamentDiscountPercent'];

function normalizePolicy(value, product, keys) {
  if (value === undefined || value === null || value === '') return null;
  if (typeof value === 'string') value = JSON.parse(value);
  if (!value || typeof value !== 'object' || Array.isArray(value)
    || value.productId !== product
    || Object.keys(value).sort().join() !== ['productId', ...keys].sort().join()
    || keys.some(key => !Number.isSafeInteger(value[key]) || value[key] < 0)
    || value.maxActiveBookings < 1 || keys.slice(2).some(key => value[key] > 100)) {
    throw new Error('HUB product policy shape mismatch');
  }
  return Object.fromEntries([['productId', product], ...keys.map(key => [key, value[key]])]);
}

export function buildHubPolicyTransition({ expectedPrior, desired } = {}) {
  // Explicit null means OFF. Missing options cannot silently become a transition.
  if (expectedPrior === undefined || desired === undefined) throw new Error('Explicit HUB prior and desired policy required');
  const prior = normalizePolicy(expectedPrior, HUB_POLICY_PRODUCT, fields);
  const next = normalizePolicy(desired, HUB_POLICY_PRODUCT, fields);
  const declarations = `const lk1PolicyKey = ${JSON.stringify(HUB_POLICY_KEY)};
const lk1DesiredPolicy = ${JSON.stringify(next)};
const lk1NormalizePolicy = value => (${normalizePolicy.toString()})(value, ${JSON.stringify(HUB_POLICY_PRODUCT)}, ${JSON.stringify(fields)});
`;
  const initialize = declarations + `const expectedPrior = ${JSON.stringify(prior)};
const current = lk1NormalizePolicy(global.get(lk1PolicyKey));
if (JSON.stringify(current) !== JSON.stringify(lk1DesiredPolicy)) {
  if (JSON.stringify(current) !== JSON.stringify(expectedPrior)) throw new Error("HUB policy prior mismatch; no overwrite");
  global.set(lk1PolicyKey, lk1DesiredPolicy);
}
if (JSON.stringify(lk1NormalizePolicy(global.get(lk1PolicyKey))) !== JSON.stringify(lk1DesiredPolicy)) {
  throw new Error("HUB policy readback mismatch");
}
`;
  const reader = declarations + `const lk1ReadBoundPolicy = () => {
  const current = lk1NormalizePolicy(global.get(lk1PolicyKey));
  if (JSON.stringify(current) !== JSON.stringify(lk1DesiredPolicy)) throw new Error("HUB source policy mismatch");
  return lk1DesiredPolicy;
};
`;
  return { expectedPrior: prior, desired: next, initialize, reader };
}
