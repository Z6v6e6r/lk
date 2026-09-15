// Synthetic product catalog for the LK1 plan-rules acceptance matrix (line T).
// Values are identifiers published in the frozen coordination contract
// (docs/LK1_ENFORCEMENT_ROLLOUT_COORDINATION.md §1, §2.1); no customer data,
// phones, tokens or live payloads are stored here.
export const HUB_PRODUCT_ID = 'db7a5250-7369-4f43-8ac5-9111be24bc74';

// Products covered by a plan rule (contract §1: РА, Дружба 30д, Академия,
// Спорт, акционные). `rule: true` means the product must be matched by
// `subscriptions_lk1_plan_rules` after integration.
export const PLAN_PRODUCTS = Object.freeze([
  { key: 'ra', planKey: 'ra', productId: 'b91e14d1-fe6e-4d0b-be39-3e45ad86b759', label: 'РА' },
  { key: 'friendship', planKey: 'friendship', productId: 'b2e6a9d4-53b5-4f79-87ec-3fb076381e9b', label: 'Дружба 30 дней' },
  { key: 'academy', planKey: 'academy', productId: '9eb8a7a4-c195-492a-95e4-3fb82899ac10', label: 'Академия' },
  { key: 'sport', planKey: 'sport', productId: '82caad6f-4d19-4d01-852b-932bdbb0f405', label: 'Спорт' },
  { key: 'promo_academy', planKey: 'promo_academy', productId: '6bda152b-0a9c-4308-82d0-3cd4e6aa680d', label: 'Акционный (академия)' },
  { key: 'promo_friendship', planKey: 'promo_friendship', productId: 'c079dc82-c716-4f0e-b9ad-6aab62fb789e', label: 'Акционный (дружба)' },
  { key: 'promo_ra', planKey: 'promo_ra', productId: '3b4806f1-6f9a-46df-a7d7-45075b4e7274', label: 'Акционный (РА)' },
]);

// Contract §0.7 / §7.6: Энергия-5 and every product without a rule stay legacy.
export const UNKNOWN_PRODUCTS = Object.freeze([
  { key: 'energy5', productId: 'dfa72adf-233b-4285-8d69-e5eab4234fbe', label: 'Энергия-5' },
  { key: 'piter', productId: '11111111-2222-4333-8444-555555555555', label: 'Питер (fixture)' },
]);

export const HUB_PRODUCT = Object.freeze({
  key: 'hub', productId: HUB_PRODUCT_ID, label: 'Падел.Дружба.ХАБ (годовая)',
});

export const productById = id => [HUB_PRODUCT, ...PLAN_PRODUCTS, ...UNKNOWN_PRODUCTS]
  .find(product => product.productId === id) || null;
